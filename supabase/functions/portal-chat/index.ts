// POST /portal-chat   (deploy with --no-verify-jwt: clients and freelancer guests have no login)
//
// One gateway for the two token-based chat audiences. Browsers never touch the portal tables;
// this function validates a credential, resolves the conversation ITSELF, and only then calls the
// service-role-only database functions. A thread id sent by a browser is never trusted for
// client/guest requests.
//
//   mode "guest"   guest_claim {invite_token, display_name}  -> {session, thread, ...}
//                  list | send | download   with {session}
//   mode "client"  list | send | download   with {share_token}   (the project's portal link)
//   mode "freelancer" list | send | download with {share_token}  (the freelancer's existing per-shot link)
//   mode "staff"   send (with attachments) | download   with Authorization: Bearer <user JWT>
//   client / guest / freelancer also support: react {message_id, reaction, active}; send accepts reply_to_id.
//   Replies and reactions are validated against the thread the credential resolved to, never a thread id from the browser.
//
// JSON for everything; `send` may be multipart/form-data (fields + up to 5 `files`).
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY (defaults), PORTAL_HASH_PEPPER (optional),
//      DRIVE_TOKEN_ENCRYPTION_KEY, DOWNLOAD_SIGNING_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.
//
// Attachment bytes never touch Supabase Storage. They live in the studio's own Google Drive under
//   KairFlow / Chat Attachments
// and stay private (no "anyone with the link" sharing). portal_attachments.object_path stores
// `drive://<driveFileId>`. Downloads: `download` authorizes the caller and returns a 60-second signed
// ticket URL back to this function; GET ?ticket= re-checks the attachment and streams it from Drive.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { decryptText } from "../_shared/crypto.ts";
import { createDriveFolder, fetchDriveFileStream, findChildFolder, findRootFolder, getAccessToken, trashDriveFile, uploadFileToDrive } from "../_shared/google.ts";
import { signTicket, verifyTicket } from "../_shared/download_ticket.ts";

const TICKET_TTL_SECONDS = 60;
const TICKET_SCOPE = "portal:"; // keeps these tickets unusable by client-final-download, which shares the signing key
const DRIVE_PATH = /^drive:\/\/([A-Za-z0-9_-]{10,200})$/;
const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"]);
const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function safeName(name: string): string {
  const leaf = String(name || "file").split(/[\\/]/).pop() || "file";
  const clean = leaf.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
  return !clean || /^\.+$/.test(clean) ? "file" : clean;
}

// The declared type must match the file's real first bytes, so a renamed executable is refused.
function sniffMatches(type: string, head: Uint8Array): boolean {
  const starts = (...sig: number[]) => sig.every((b, i) => head[i] === b);
  switch (type) {
    case "image/png": return starts(0x89, 0x50, 0x4e, 0x47);
    case "image/jpeg": return starts(0xff, 0xd8, 0xff);
    case "image/gif": return starts(0x47, 0x49, 0x46, 0x38);
    case "image/webp": return starts(0x52, 0x49, 0x46, 0x46) && head[8] === 0x57 && head[9] === 0x45;
    case "application/pdf": return starts(0x25, 0x50, 0x44, 0x46);
    case "text/plain": return !head.includes(0);
    default: return false;
  }
}

class HttpError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

// The studio's Drive: the organization's creator holds the encrypted connection (same rule the internal
// chat-attachments gateway uses). Folder ids are cached in chat_drive_folders and re-created if missing.
async function getDriveForThread(admin: ReturnType<typeof createClient>, threadId: string) {
  const { data: thread } = await admin.from("portal_threads").select("organization_id").eq("id", threadId).maybeSingle();
  if (!thread?.organization_id) throw new HttpError(404, "not_found");
  const { data: org } = await admin.from("studio_organizations").select("created_by").eq("id", thread.organization_id).maybeSingle();
  if (!org?.created_by) throw new HttpError(400, "drive_not_configured");
  const { data: connection } = await admin.from("google_drive_connections").select("refresh_token_encrypted").eq("user_id", org.created_by).maybeSingle();
  if (!connection?.refresh_token_encrypted) throw new HttpError(400, "drive_not_connected");
  const encryptionKey = Deno.env.get("DRIVE_TOKEN_ENCRYPTION_KEY");
  if (!encryptionKey) throw new HttpError(500, "drive_not_configured");
  const accessToken = await getAccessToken(await decryptText(connection.refresh_token_encrypted, encryptionKey));

  await admin.from("chat_drive_folders").upsert({ user_id: org.created_by }, { onConflict: "user_id", ignoreDuplicates: true });
  const { data: state } = await admin.from("chat_drive_folders").select("*").eq("user_id", org.created_by).maybeSingle();
  let rootId = state?.kairflow_root_folder_id || null;
  if (!rootId) {
    const root = await findRootFolder(accessToken, "KairFlow");
    rootId = root ? root.id : (await createDriveFolder(accessToken, "KairFlow")).id;
    await admin.from("chat_drive_folders").update({ kairflow_root_folder_id: rootId, updated_at: new Date().toISOString() }).eq("user_id", org.created_by);
  }
  let folderId = state?.chat_attachments_folder_id || null;
  if (!folderId) {
    const found = await findChildFolder(accessToken, rootId, "Chat Attachments");
    folderId = found ? found.id : (await createDriveFolder(accessToken, "Chat Attachments", rootId)).id;
    await admin.from("chat_drive_folders").update({ chat_attachments_folder_id: folderId, updated_at: new Date().toISOString() }).eq("user_id", org.created_by);
  }
  return { accessToken, folderId };
}

// GET ?ticket=... : the ticket was minted by an authorized `download`. The attachment is re-read from the
// database (must still exist on that thread) before a single byte is streamed from Drive.
async function streamTicket(req: Request, admin: ReturnType<typeof createClient>): Promise<Response> {
  const signingKey = Deno.env.get("DOWNLOAD_SIGNING_KEY");
  if (!signingKey) return json({ error: "downloads_not_configured" }, 503);
  const payload = await verifyTicket(new URL(req.url).searchParams.get("ticket") || "", signingKey);
  if (!payload || !payload.s.startsWith(TICKET_SCOPE)) return json({ error: "invalid_ticket" }, 403);
  const threadId = payload.s.slice(TICKET_SCOPE.length);
  if (!UUID.test(threadId) || !UUID.test(payload.v)) return json({ error: "invalid_ticket" }, 403);
  const { data: row } = await admin.from("portal_attachments").select("object_path, file_name, content_type")
    .eq("id", payload.v).eq("thread_id", threadId).maybeSingle();
  const match = String(row?.object_path || "").match(DRIVE_PATH);
  if (!row || !match) return json({ error: "not_found" }, 404);
  const { accessToken } = await getDriveForThread(admin, threadId);
  const drive = await fetchDriveFileStream(accessToken, match[1]);
  if (!drive.ok || !drive.body) return json({ error: drive.status === 404 ? "not_found" : "drive_download_failed" }, drive.status === 404 ? 404 : 502);
  const name = safeName(row.file_name);
  const headers: Record<string, string> = {
    ...corsHeaders,
    "Content-Type": row.content_type || "application/octet-stream",
    "Content-Disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
  const len = drive.headers.get("Content-Length");
  if (len) headers["Content-Length"] = len;
  return new Response(drive.body, { status: 200, headers });
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  if (req.method === "GET") {
    try { return await streamTicket(req, admin); }
    catch (error) {
      if (error instanceof HttpError) return json({ error: error.code }, error.status);
      console.error("portal-chat download error", error);
      return json({ error: "unexpected_error" }, 500);
    }
  }
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const uploaded: string[] = []; // Drive file ids uploaded by this request and not yet persisted
  let driveToken = "";

  try {
    const contentType = req.headers.get("content-type") || "";
    let fields: Record<string, unknown> = {};
    let files: File[] = [];
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      for (const [key, value] of form.entries()) {
        if (value instanceof File) { if (key === "files") files.push(value); } else fields[key] = value;
      }
    } else {
      fields = await req.json().catch(() => ({}));
    }
    const action = String(fields.action || "");
    const mode = String(fields.mode || "");
    if (!["guest", "client", "freelancer", "staff"].includes(mode)) throw new HttpError(400, "invalid_request");

    const participantId = String(fields.participant_id || "").trim();
    if (
      (mode === "client" || mode === "freelancer") &&
      (action === "list" || action === "send" || action === "react") &&
      !UUID.test(participantId)
    ) {
      throw new HttpError(400, "invalid_request");
    }

    // Per-network ceiling, then a stop for anyone who keeps presenting bad credentials.
    const forwarded = req.headers.get("cf-connecting-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
    const ipHash = await sha256Hex(`${Deno.env.get("PORTAL_HASH_PEPPER") || ""}|${forwarded}`);
    const limited = async (scope: string, subject: string, limit: number, seconds: number) => {
      const { data } = await admin.rpc("portal_rate_limit", { p_scope: scope, p_subject_hash: subject, p_limit: limit, p_window_seconds: seconds });
      return data !== true;
    };
    if (await limited("portal_ip", ipHash, 240, 60)) throw new HttpError(429, "rate_limited");
    const { data: tooManyFailures } = await admin.rpc("portal_rate_exceeded", { p_scope: "portal_bad_credential", p_subject_hash: ipHash, p_limit: 20, p_window_seconds: 600 });
    if (tooManyFailures === true) throw new HttpError(429, "rate_limited");
    const fail = async (kind: string) => {
      await admin.rpc("portal_record_event", { p_scope: "portal_bad_credential", p_subject_hash: ipHash, p_ok: false, p_detail: { kind } });
      throw new HttpError(401, "invalid_credential");
    };

    // ---- guest claim: invite -> session ----
    if (mode === "guest" && action === "guest_claim") {
      const invite = String(fields.invite_token || "").trim().toLowerCase();
      if (!HEX64.test(invite)) return await fail("claim_malformed");
      if (await limited("portal_claim", ipHash, 10, 600)) throw new HttpError(429, "rate_limited");
      const session = randomHex(32);
      let userId: string | null = null;
      const auth = req.headers.get("authorization") || "";
      if (auth.toLowerCase().startsWith("bearer ")) {
        const { data } = await admin.auth.getUser(auth.slice(7).trim());
        userId = data?.user?.id ?? null; // links an existing KairFlow login; never creates an account
      }
      const { data: claim, error } = await admin.rpc("portal_guest_claim", {
        p_invite_hash: await sha256Hex(invite), p_session_hash: await sha256Hex(session),
        p_display_name: String(fields.display_name || ""), p_user_id: userId,
      });
      if (error || !claim) return await fail("claim_rejected");
      await admin.rpc("portal_record_event", { p_scope: "portal_guest_claim", p_subject_hash: ipHash, p_ok: true, p_detail: {} });
      return json({
        ok: true, session, display_name: claim.display_name, project_name: claim.project_name, expires_at: claim.expires_at,
      });
    }

    // ---- resolve who is calling and which thread they may touch ----
    let threadId = "";
    let sessionId: string | null = null;
    let label = "";
    let staffClient: ReturnType<typeof createClient> | null = null;
    let rateSubject = ipHash;

    if (mode === "guest") {
      const session = String(fields.session || "").trim().toLowerCase();
      if (!HEX64.test(session)) return await fail("session_malformed");
      const sessionHash = await sha256Hex(session);
      const { data } = await admin.rpc("portal_guest_resolve", { p_session_hash: sessionHash });
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) return await fail("session_invalid");
      threadId = row.thread_id; sessionId = row.session_id; label = row.display_name; rateSubject = sessionHash;
    } else if (mode === "freelancer") {
      // The freelancer's existing per-shot share link is the credential. One private thread per shot.
      const share = String(fields.share_token || "").trim();
      if (share.length < 16 || share.length > 200) return await fail("share_malformed");
      const { data } = await admin.rpc("portal_freelancer_resolve", { p_share_token: share });
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) return await fail("share_invalid");
      threadId = row.thread_id; rateSubject = await sha256Hex(`freelancer:${share}`);
      label = String(fields.display_name || "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 60) || "Freelancer";
    } else if (mode === "client") {
      const share = String(fields.share_token || "").trim();
      if (share.length < 16 || share.length > 200) return await fail("share_malformed");
      const { data } = await admin.rpc("portal_client_resolve", { p_share_token: share });
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) return await fail("share_invalid");
      threadId = row.thread_id; rateSubject = await sha256Hex(`client:${share}`);
      label = String(fields.display_name || "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 60) || String(row.client_name || "Client").slice(0, 60) || "Client";
    } else {
      const auth = req.headers.get("authorization") || "";
      if (!auth.toLowerCase().startsWith("bearer ")) throw new HttpError(401, "invalid_credential");
      staffClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: auth } },
      });
      if (action === "send" || action === "list") {
        const requested = String(fields.thread_id || "");
        if (!UUID.test(requested)) throw new HttpError(400, "invalid_request");
        const { error } = await staffClient.rpc("portal_staff_assert_thread", { p_thread_id: requested });
        if (error) throw new HttpError(403, "not_authorized");
        threadId = requested;
      }
      rateSubject = await sha256Hex(`staff:${auth.slice(-40)}`);
    }
    // Guests use their server-issued session; client and freelancer participants use a stable browser-local ID.
    const reactorKey = mode === "guest" && sessionId
      ? `guest:${sessionId}`
      : mode === "staff"
        ? ""
        : `${mode}:${participantId}`;

    // ---- list ----
    if (action === "list") {
      if (await limited(`portal_list_${mode}`, rateSubject, 240, 60)) throw new HttpError(429, "rate_limited");
      if (mode === "staff") throw new HttpError(400, "invalid_request");
      const after = fields.after ? new Date(String(fields.after)) : null;
      const afterIso = after && !isNaN(+after) ? after.toISOString() : null;
      // Guests also get an explicit `mine` flag (from their session) so same-named guests are never confused.
      const { data, error } = mode === "guest" && sessionId
        ? await admin.rpc("portal_guest_messages", { p_thread_id: threadId, p_session_id: sessionId, p_after: afterIso, p_limit: 100 })
        : await admin.rpc("portal_thread_messages", {
          p_thread_id: threadId, p_after: afterIso, p_limit: 100,
          p_viewer_key: reactorKey,
          p_viewer_participant_id: mode === "client" || mode === "freelancer" ? participantId : null,
        });
      if (error) throw new HttpError(500, "unexpected_error");
      return json({ ok: true, messages: data || [], display_name: label });
    }

    // ---- send ----
    if (action === "send") {
      if (await limited(`portal_send_${mode}`, rateSubject, 30, 60)) throw new HttpError(429, "rate_limited");
      const body = String(fields.body || "");
      const key = String(fields.idempotency_key || "");
      if (key.length < 8 || key.length > 64) throw new HttpError(400, "invalid_request");
      const replyToId = String(fields.reply_to_id || "").trim() || null;
      if (replyToId && !UUID.test(replyToId)) throw new HttpError(400, "invalid_request");
      if (files.length > MAX_FILES) throw new HttpError(400, "too_many_attachments");
      if (files.length && await limited(`portal_upload_${mode}`, rateSubject, 10, 600)) throw new HttpError(429, "rate_limited");
      const attachments: Array<Record<string, unknown>> = [];
      let driveFolderId = "";
      if (files.length) ({ accessToken: driveToken, folderId: driveFolderId } = await getDriveForThread(admin, threadId));
      for (const file of files) {
        const type = (file.type || "").toLowerCase();
        if (!ALLOWED_TYPES.has(type)) throw new HttpError(415, "unsupported_file_type");
        if (file.size < 1 || file.size > MAX_FILE_BYTES) throw new HttpError(413, "file_too_large");
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (!sniffMatches(type, bytes.slice(0, 16))) throw new HttpError(415, "file_content_mismatch");
        // Private upload (shareWithAnyoneLink = false): only this gateway can ever read the file.
        let driveFile: { id: string };
        try { driveFile = await uploadFileToDrive(driveToken, driveFolderId, safeName(file.name), bytes, type, false); }
        catch (driveError) { console.error("portal-chat Drive upload failed", driveError); throw new HttpError(502, "upload_failed"); }
        uploaded.push(driveFile.id);
        attachments.push({ object_path: `drive://${driveFile.id}`, file_name: safeName(file.name), content_type: type, size_bytes: file.size });
      }
      let result;
      if (mode === "staff") {
        result = await staffClient!.rpc("portal_staff_send", {
          p_thread_id: threadId, p_body: body, p_idempotency_key: key, p_attachments: attachments, p_reply_to_id: replyToId,
        });
      } else {
        result = await admin.rpc("portal_post_message", {
          p_thread_id: threadId, p_sender_kind: mode === "client" ? "client" : "guest", p_guest_session_id: sessionId,
          p_label: label, p_body: body, p_idempotency_key: key, p_attachments: attachments,
          p_reply_to_id: replyToId,
          p_sender_participant_id: mode === "client" || mode === "freelancer" ? participantId : null,
        });
      }
      if (result.error) {
        const msg = String(result.error.message || "");
        const map: Array<[RegExp, number, string]> = [
          [/message_too_long/, 400, "message_too_long"], [/empty_message/, 400, "empty_message"],
          [/rate_limited/, 429, "rate_limited"], [/too_many_attachments/, 400, "too_many_attachments"],
          [/reply_target_not_in_thread/, 400, "reply_target_not_in_thread"],
          [/not_authorized|thread_not_found|thread_kind_mismatch/, 403, "not_authorized"],
        ];
        const hit = map.find(([re]) => re.test(msg));
        throw new HttpError(hit ? hit[1] : 500, hit ? hit[2] : "unexpected_error");
      }
      uploaded.length = 0; // persisted: keep the files
      return json({ ok: true, message_id: result.data });
    }

    // ---- react: add or remove one reaction on a message in the caller's own thread ----
    if (action === "react") {
      if (mode === "staff") throw new HttpError(400, "invalid_request"); // staff react through their own authorized RPC
      if (await limited(`portal_react_${mode}`, rateSubject, 60, 60)) throw new HttpError(429, "rate_limited");
      const messageId = String(fields.message_id || "");
      const reaction = String(fields.reaction || "");
      if (!UUID.test(messageId) || !reaction || reaction.length > 32) throw new HttpError(400, "invalid_request");
      const { error } = await admin.rpc("portal_set_reaction", {
        p_thread_id: threadId, p_message_id: messageId, p_reactor_key: reactorKey, p_label: label,
        p_reaction: reaction, p_active: fields.active === true || fields.active === "true",
      });
      if (error) {
        const msg = String(error.message || "");
        if (/invalid_reaction|too_many_reactions/.test(msg)) throw new HttpError(400, /too_many/.test(msg) ? "too_many_reactions" : "invalid_reaction");
        if (/message_not_found|thread_not_found/.test(msg)) throw new HttpError(404, "not_found");
        throw new HttpError(500, "unexpected_error");
      }
      return json({ ok: true });
    }

    // ---- download: authorize, then a 60-second signed ticket URL back to this function ----
    if (action === "download") {
      if (await limited(`portal_download_${mode}`, rateSubject, 60, 60)) throw new HttpError(429, "rate_limited");
      const attachmentId = String(fields.attachment_id || "");
      if (!UUID.test(attachmentId)) throw new HttpError(400, "invalid_request");
      let row: { thread_id?: string; object_path: string; file_name: string } | undefined;
      if (mode === "staff") {
        const { data, error } = await staffClient!.rpc("portal_staff_attachment", { p_attachment_id: attachmentId });
        if (error) throw new HttpError(403, "not_authorized");
        row = Array.isArray(data) ? data[0] : data;
      } else {
        const { data } = await admin.rpc("portal_get_attachment", { p_thread_id: threadId, p_attachment_id: attachmentId });
        row = Array.isArray(data) ? data[0] : data;
      }
      if (!row || !DRIVE_PATH.test(String(row.object_path || ""))) throw new HttpError(404, "not_found");
      // The thread comes from the authorized lookup, never from the request, for every mode.
      const ticketThread = mode === "staff" ? String(row.thread_id || "") : threadId;
      if (!UUID.test(ticketThread)) throw new HttpError(404, "not_found");
      const signingKey = Deno.env.get("DOWNLOAD_SIGNING_KEY");
      if (!signingKey) throw new HttpError(503, "downloads_not_configured");
      const exp = Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS;
      const ticket = await signTicket({ v: attachmentId, s: `${TICKET_SCOPE}${ticketThread}`, exp }, signingKey);
      return json({ ok: true, url: `${url}/functions/v1/portal-chat?ticket=${encodeURIComponent(ticket)}` });
    }

    throw new HttpError(400, "invalid_request");
  } catch (error) {
    // Files uploaded for a send that never persisted go to the studio's Drive trash.
    if (uploaded.length && driveToken) await Promise.all(uploaded.map((id) => trashDriveFile(driveToken, id)));
    if (error instanceof HttpError) return json({ error: error.code }, error.status, error.status === 429 ? { "Retry-After": "60" } : {});
    return json({ error: "unexpected_error" }, 500);
  }
});
