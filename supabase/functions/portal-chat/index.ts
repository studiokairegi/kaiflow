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
//   mode "staff"   send (with attachments) | download   with Authorization: Bearer <user JWT>
//
// JSON for everything; `send` may be multipart/form-data (fields + up to 5 `files`).
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY (defaults), PORTAL_HASH_PEPPER (optional).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";

const BUCKET = "portal-attachments";
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

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const uploaded: string[] = [];

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
    if (!["guest", "client", "staff"].includes(mode)) throw new HttpError(400, "invalid_request");

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

    // ---- list ----
    if (action === "list") {
      if (await limited(`portal_list_${mode}`, rateSubject, 240, 60)) throw new HttpError(429, "rate_limited");
      if (mode === "staff") throw new HttpError(400, "invalid_request");
      const after = fields.after ? new Date(String(fields.after)) : null;
      const { data, error } = await admin.rpc("portal_thread_messages", {
        p_thread_id: threadId, p_after: after && !isNaN(+after) ? after.toISOString() : null, p_limit: 100,
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
      if (files.length > MAX_FILES) throw new HttpError(400, "too_many_attachments");
      if (files.length && await limited(`portal_upload_${mode}`, rateSubject, 10, 600)) throw new HttpError(429, "rate_limited");
      const attachments: Array<Record<string, unknown>> = [];
      for (const file of files) {
        const type = (file.type || "").toLowerCase();
        if (!ALLOWED_TYPES.has(type)) throw new HttpError(415, "unsupported_file_type");
        if (file.size < 1 || file.size > MAX_FILE_BYTES) throw new HttpError(413, "file_too_large");
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (!sniffMatches(type, bytes.slice(0, 16))) throw new HttpError(415, "file_content_mismatch");
        const path = `${threadId}/${crypto.randomUUID()}/${safeName(file.name)}`;
        const { error } = await admin.storage.from(BUCKET).upload(path, bytes, { contentType: type, upsert: false });
        if (error) throw new HttpError(500, "upload_failed");
        uploaded.push(path);
        attachments.push({ object_path: path, file_name: safeName(file.name), content_type: type, size_bytes: file.size });
      }
      let result;
      if (mode === "staff") {
        result = await staffClient!.rpc("portal_staff_send", {
          p_thread_id: threadId, p_body: body, p_idempotency_key: key, p_attachments: attachments,
        });
      } else {
        result = await admin.rpc("portal_post_message", {
          p_thread_id: threadId, p_sender_kind: mode === "client" ? "client" : "guest", p_guest_session_id: sessionId,
          p_label: label, p_body: body, p_idempotency_key: key, p_attachments: attachments,
        });
      }
      if (result.error) {
        const msg = String(result.error.message || "");
        const map: Array<[RegExp, number, string]> = [
          [/message_too_long/, 400, "message_too_long"], [/empty_message/, 400, "empty_message"],
          [/rate_limited/, 429, "rate_limited"], [/too_many_attachments/, 400, "too_many_attachments"],
          [/not_authorized|thread_not_found|thread_kind_mismatch/, 403, "not_authorized"],
        ];
        const hit = map.find(([re]) => re.test(msg));
        throw new HttpError(hit ? hit[1] : 500, hit ? hit[2] : "unexpected_error");
      }
      uploaded.length = 0; // persisted: keep the files
      return json({ ok: true, message_id: result.data });
    }

    // ---- download: authorize, then a 60-second signed URL ----
    if (action === "download") {
      if (await limited(`portal_download_${mode}`, rateSubject, 60, 60)) throw new HttpError(429, "rate_limited");
      const attachmentId = String(fields.attachment_id || "");
      if (!UUID.test(attachmentId)) throw new HttpError(400, "invalid_request");
      let row: { object_path: string; file_name: string } | undefined;
      if (mode === "staff") {
        const { data, error } = await staffClient!.rpc("portal_staff_attachment", { p_attachment_id: attachmentId });
        if (error) throw new HttpError(403, "not_authorized");
        row = Array.isArray(data) ? data[0] : data;
      } else {
        const { data } = await admin.rpc("portal_get_attachment", { p_thread_id: threadId, p_attachment_id: attachmentId });
        row = Array.isArray(data) ? data[0] : data;
      }
      if (!row) throw new HttpError(404, "not_found");
      const { data: signed, error } = await admin.storage.from(BUCKET).createSignedUrl(row.object_path, 60, { download: row.file_name });
      if (error || !signed?.signedUrl) throw new HttpError(404, "not_found");
      return json({ ok: true, url: signed.signedUrl });
    }

    throw new HttpError(400, "invalid_request");
  } catch (error) {
    if (uploaded.length) await admin.storage.from(BUCKET).remove(uploaded).catch(() => {});
    if (error instanceof HttpError) return json({ error: error.code }, error.status, error.status === 429 ? { "Retry-After": "60" } : {});
    return json({ error: "unexpected_error" }, 500);
  }
});
