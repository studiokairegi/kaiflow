// /chat-attachments
// Authenticated internal chat gateway. Chat file bytes never pass through Supabase Storage.
// Uploads go to the studio's configured Google Drive account under:
//   KairFlow / Chat Attachments
//
// POST multipart: action=send, conversation_id, body, reply_to_id(optional), idempotency_key, files[]
// POST JSON:     action=download, attachment_id
//
// Drive credentials stay server-side in the encrypted google_drive_connections record.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { decryptText } from "../_shared/crypto.ts";
import { createDriveFolder, findChildFolder, findRootFolder, getAccessToken, uploadFileToDrive, trashDriveFile } from "../_shared/google.ts";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";

const MAX_FILES = 10;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  "image/png","image/jpeg","image/gif","image/webp","application/pdf","text/plain",
  "application/zip","video/mp4","video/webm","audio/mpeg","audio/mp4","audio/wav",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

class HttpError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

function safeName(name: string): string {
  const leaf = String(name || "file").split(/[\\/]/).pop() || "file";
  const clean = leaf.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
  return !clean || /^\.+$/.test(clean) ? "file" : clean;
}

function sniffMatches(type: string, head: Uint8Array): boolean {
  const starts = (...sig: number[]) => sig.every((b, i) => head[i] === b);
  switch (type) {
    case "image/png": return starts(0x89,0x50,0x4e,0x47);
    case "image/jpeg": return starts(0xff,0xd8,0xff);
    case "image/gif": return starts(0x47,0x49,0x46,0x38);
    case "image/webp": return starts(0x52,0x49,0x46,0x46) && head[8] === 0x57 && head[9] === 0x45;
    case "application/pdf": return starts(0x25,0x50,0x44,0x46);
    case "text/plain": return !head.includes(0);
    case "application/zip": return starts(0x50,0x4b,0x03,0x04);
    case "video/mp4": return head.length >= 12 && String.fromCharCode(...head.slice(4,8)) === "ftyp";
    case "video/webm": return starts(0x1a,0x45,0xdf,0xa3);
    case "audio/mpeg": return starts(0x49,0x44,0x33) || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0);
    case "audio/mp4": return head.length >= 12 && String.fromCharCode(...head.slice(4,8)) === "ftyp";
    case "audio/wav": return starts(0x52,0x49,0x46,0x46) && head[8] === 0x57 && head[9] === 0x41 && head[10] === 0x56 && head[11] === 0x45;
    default: return false;
  }
}

async function getDriveForOrganization(admin: ReturnType<typeof createClient>, organizationId: string) {
  const { data: org, error: orgError } = await admin
    .from("studio_organizations")
    .select("created_by")
    .eq("id", organizationId)
    .maybeSingle();
  if (orgError || !org?.created_by) throw new HttpError(400, "drive_not_configured");

  const { data: connection, error: connectionError } = await admin
    .from("google_drive_connections")
    .select("refresh_token_encrypted")
    .eq("user_id", org.created_by)
    .maybeSingle();
  if (connectionError || !connection?.refresh_token_encrypted) throw new HttpError(400, "drive_not_connected");

  const encryptionKey = Deno.env.get("DRIVE_TOKEN_ENCRYPTION_KEY");
  if (!encryptionKey) throw new HttpError(500, "drive_not_configured");
  const refreshToken = await decryptText(connection.refresh_token_encrypted, encryptionKey);
  const accessToken = await getAccessToken(refreshToken);

  // A single row is the server-side pointer for this studio's dedicated chat folder.
  // The Drive lookup itself also verifies the folder is still present before reuse.
  await admin.from("chat_drive_folders").upsert({ user_id: org.created_by }, { onConflict: "user_id", ignoreDuplicates: true });
  const { data: state } = await admin.from("chat_drive_folders").select("*").eq("user_id", org.created_by).maybeSingle();

  let rootId = state?.kairflow_root_folder_id || null;
  if (!rootId) {
    const root = await findRootFolder(accessToken, "KairFlow");
    if (root) rootId = root.id;
    else rootId = (await createDriveFolder(accessToken, "KairFlow")).id;
    await admin.from("chat_drive_folders").update({ kairflow_root_folder_id: rootId, updated_at: new Date().toISOString() }).eq("user_id", org.created_by);
  }

  let folderId = state?.chat_attachments_folder_id || null;
  if (!folderId) {
    const found = await findChildFolder(accessToken, rootId, "Chat Attachments");
    if (found) folderId = found.id;
    else folderId = (await createDriveFolder(accessToken, "Chat Attachments", rootId)).id;
    await admin.from("chat_drive_folders").update({ chat_attachments_folder_id: folderId, updated_at: new Date().toISOString() }).eq("user_id", org.created_by);
  }

  return { accessToken, folderId };
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const authHeader = req.headers.get("authorization") || "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) return json({ error: "invalid_credential" }, 401);
  const token = authHeader.slice(7).trim();

  const auth = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: authHeader } },
  });
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: userData, error: userError } = await admin.auth.getUser(token);
  if (userError || !userData?.user) return json({ error: "invalid_credential" }, 401);

  try {
    const contentType = req.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const action = String(form.get("action") || "");
      if (action !== "send") throw new HttpError(400, "invalid_request");
      const conversationId = String(form.get("conversation_id") || "");
      const body = String(form.get("body") || "");
      const idempotencyKey = String(form.get("idempotency_key") || "");
      const replyToId = String(form.get("reply_to_id") || "").trim() || null;
      if (!UUID.test(conversationId) || !UUID.test(idempotencyKey)) throw new HttpError(400, "invalid_request");
      if (replyToId && !UUID.test(replyToId)) throw new HttpError(400, "invalid_request");

      // Authorization is evaluated by the database under the caller's JWT.
      const { data: conversation, error: convError } = await auth
        .from("chat_conversations").select("id, organization_id").eq("id", conversationId).maybeSingle();
      if (convError || !conversation) throw new HttpError(convError ? 403 : 404, convError ? "not_authorized" : "not_found");

      const files = form.getAll("files").filter((v): v is File => v instanceof File);
      if (files.length > MAX_FILES) throw new HttpError(400, "too_many_attachments");
      if (files.length && !body && !replyToId) { /* attachment-only messages are valid */ }

      let accessToken = "";
      let folderId = "";
      const attachmentIds: string[] = [];
      const uploadedDriveIds: string[] = [];

      try {
        if (files.length) ({ accessToken, folderId } = await getDriveForOrganization(admin, conversation.organization_id));
        for (const file of files) {
          const type = String(file.type || "").toLowerCase();
          if (!ALLOWED_TYPES.has(type)) throw new HttpError(415, "unsupported_file_type");
          if (file.size < 1 || file.size > MAX_FILE_BYTES) throw new HttpError(413, "file_too_large");
          const bytes = new Uint8Array(await file.arrayBuffer());
          if (!sniffMatches(type, bytes.slice(0, 16))) throw new HttpError(415, "file_content_mismatch");

          const uploaded = await uploadFileToDrive(
            accessToken, folderId, safeName(file.name), bytes, type, false
          );
          uploadedDriveIds.push(uploaded.id);

          const { data: attachmentId, error: registerError } = await auth.rpc("chat_register_drive_attachment_upload", {
            p_conversation_id: conversationId,
            p_drive_file_id: uploaded.id,
            p_file_name: safeName(file.name),
            p_content_type: type,
            p_size_bytes: file.size,
          });
          if (registerError || !attachmentId) throw new HttpError(500, "attachment_register_failed");
          attachmentIds.push(attachmentId);
        }

        const { data: messageId, error: sendError } = await auth.rpc("chat_send_message", {
          p_conversation_id: conversationId,
          p_body: body,
          p_idempotency_key: idempotencyKey,
          p_reply_to_id: replyToId,
          p_attachment_ids: attachmentIds,
        });
        if (sendError || !messageId) throw new HttpError(sendError ? 400 : 500, String(sendError?.message || "send_failed").match(/too_many_attachments|empty_message|not_authorized|reply_target_not_in_conversation|idempotency_key_reused/)?.[0] || "send_failed");

        // Idempotent retries can return an already-persisted message. Only keep Drive files
        // that are actually linked to that message; retry-created duplicates are trashed.
        if (attachmentIds.length) {
          const { data: persisted } = await admin.from("chat_attachments")
            .select("id, message_id, object_path")
            .in("id", attachmentIds);
          const linked = new Set((persisted || []).filter((row) => row.message_id === messageId).map((row) => row.id));
          for (const row of (persisted || [])) {
            if (linked.has(row.id)) continue;
            const match = String(row.object_path || "").match(/^drive:\/\/([A-Za-z0-9_-]{10,200})$/);
            if (match) await trashDriveFile(accessToken, match[1]);
            await auth.rpc("chat_cancel_attachment_upload", { p_attachment_id: row.id }).catch(() => {});
          }
        }

        return json({ ok: true, message_id: messageId });
      } catch (error) {
        // Drive files are private; failed sends are safe to trash server-side.
        for (const id of uploadedDriveIds) {
          try {
            await trashDriveFile(accessToken, id);
          } catch { /* best effort */ }
        }
        for (const id of attachmentIds) {
          try { await auth.rpc("chat_cancel_attachment_upload", { p_attachment_id: id }); } catch { /* best effort */ }
        }
        throw error;
      }
    }

    const payload = await req.json().catch(() => ({}));
    const action = String(payload.action || "");

    if (action === "delete") {
      const messageId = String(payload.message_id || "");
      if (!UUID.test(messageId)) throw new HttpError(400, "invalid_request");
      const { data: paths, error: deleteError } = await auth.rpc("chat_delete_message", { p_message_id: messageId });
      if (deleteError) throw new HttpError(403, "not_authorized");
      const drivePaths = (paths || []).filter((path: unknown) => /^drive:\/\/[A-Za-z0-9_-]{10,200}$/.test(String(path)));
      const cleanupPaths: string[] = [];
      let cleanupWarning = (paths || []).some((path: unknown) => !String(path).startsWith("drive://"));
      if (drivePaths.length) {
        // Resolve the owning studio from the message's conversation after the RPC has
        // already enforced the caller's delete permission.
        const { data: message } = await admin.from("chat_messages").select("conversation_id").eq("id", messageId).maybeSingle();
        if (!message) throw new HttpError(404, "not_found");
        const { data: conversation } = await admin.from("chat_conversations").select("organization_id").eq("id", message.conversation_id).maybeSingle();
        if (!conversation) throw new HttpError(404, "not_found");
        const { accessToken } = await getDriveForOrganization(admin, conversation.organization_id);
        for (const path of drivePaths) {
          const driveId = String(path).slice("drive://".length);
          if (await trashDriveFile(accessToken, driveId)) cleanupPaths.push(path);
          else cleanupWarning = true;
        }
        if (cleanupPaths.length) {
          await auth.rpc("chat_finalize_deleted_attachments", { p_message_id: messageId, p_object_paths: cleanupPaths });
        }
      }
      return json({ ok: true, cleanupWarning });
    }

    if (action !== "download") throw new HttpError(400, "invalid_request");
    const attachmentId = String(payload.attachment_id || "");
    if (!UUID.test(attachmentId)) throw new HttpError(400, "invalid_request");

    const { data: attachment, error: attachmentError } = await auth
      .from("chat_attachments")
      .select("id, object_path, file_name, content_type, size_bytes, conversation_id")
      .eq("id", attachmentId)
      .maybeSingle();
    if (attachmentError || !attachment) throw new HttpError(404, "not_found");

    const driveMatch = String(attachment.object_path || "").match(/^drive:\/\/([A-Za-z0-9_-]{10,200})$/);
    if (!driveMatch) throw new HttpError(404, "not_found");

    const { data: conversation } = await admin
      .from("chat_conversations").select("organization_id").eq("id", attachment.conversation_id).maybeSingle();
    if (!conversation) throw new HttpError(404, "not_found");
    const { accessToken } = await getDriveForOrganization(admin, conversation.organization_id);

    const driveResponse = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveMatch[1])}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!driveResponse.ok) throw new HttpError(driveResponse.status === 404 ? 404 : 502, driveResponse.status === 404 ? "not_found" : "drive_download_failed");

    const headers = new Headers(corsHeaders);
    headers.set("Content-Type", attachment.content_type || "application/octet-stream");
    headers.set("Content-Disposition", `attachment; filename="${safeName(attachment.file_name).replace(/"/g, "")}"`);
    headers.set("Cache-Control", "private, no-store");
    return new Response(driveResponse.body, { status: 200, headers });
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.code }, error.status);
    console.error("chat-attachments error", error);
    return json({ error: "unexpected_error" }, 500);
  }
});
