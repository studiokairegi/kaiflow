// Studio shot-attachment upload. Bytes go from the browser straight to a Google Drive resumable
// session (same pattern as final-qc-upload / freelancer-drive-upload); this Edge Function only
// authorizes, opens the session, verifies the Drive file and records it on the shot. It never
// parses or relays the file body, so the size cap is bounded by Drive, not by Edge Function memory.
// POST JSON actions: init-upload, recover-upload, finalize.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { decryptText } from "../_shared/crypto.ts";
import {
  createResumableUploadSession,
  getCachedAccessToken,
  getDriveFileMeta,
  listFilesByAppProperty,
  shareFileWithAnyone,
} from "../_shared/google.ts";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import {
  CLIENT_OUTDATED_MESSAGE,
  FINGERPRINT_PROP,
  MD5_MISMATCH_MESSAGE,
  fingerprintMatches,
  isJsonRequest,
  md5Verdict,
  pickRecoveredFile,
  safeMime,
  validFingerprint,
} from "../_shared/upload_recovery.ts";

// Per-attachment cap: 3 GB (decimal-free binary GiB, matching the "3 GB" shown to users).
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024 * 1024;
const MAX_UPLOAD_LABEL = "3 GB";
const APP_PROP = "studioUpload";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const validKey = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(v);

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  // Old cached clients send multipart/form-data; they cannot speak the resumable protocol.
  if (!isJsonRequest(req)) return json({ error: CLIENT_OUTDATED_MESSAGE, code: "client_outdated" }, 426);

  try {
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/, "");
    if (!jwt) return json({ error: "Missing Authorization header" }, 401);

    const auth = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
    const { data: { user }, error: authError } = await auth.auth.getUser(jwt);
    if (authError || !user) return json({ error: "Invalid session" }, 401);

    const body = await req.json().catch(() => ({}));
    const action = body.action;
    const projectId = body.projectId;
    const shotId = typeof body.shotId === "string" && body.shotId ? body.shotId : null;
    const uploadKey = body.uploadKey;

    if (!projectId || typeof projectId !== "string") return json({ error: "Missing projectId or file" }, 400);
    if (!validKey(uploadKey)) return json({ error: "Missing or invalid uploadKey." }, 400);
    if (action !== "init-upload" && action !== "recover-upload" && action !== "finalize") {
      return json({ error: "Unknown action." }, 400);
    }

    // Cheap input validation before any database or Google call.
    if (action === "init-upload") {
      const name = body.name;
      const size = Number(body.size);
      if (typeof name !== "string" || !name.trim()) return json({ error: "Missing file name." }, 400);
      if (!Number.isSafeInteger(size) || size <= 0) return json({ error: "The file is empty." }, 400);
      if (size > MAX_UPLOAD_BYTES) {
        return json({ error: `File is too large. The limit is ${MAX_UPLOAD_LABEL}.`, code: "file_too_large" }, 413);
      }
      if (!validFingerprint(body.fingerprint)) return json({ error: "Missing file fingerprint." }, 400);
    }

    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // 1. Validate the shot first when a shotId was supplied. Shot ID is authoritative: this prevents
    //    uploading to Drive when the shot does not belong to the authenticated user's project.
    let shotDriveAttachmentsFolderId: string | null = null;
    let existingAttachments: Array<{ driveFileId?: string }> = [];
    if (shotId) {
      const { data: shotRow, error: shotLookupError } = await db
        .from("shots")
        .select("id, drive_attachments_folder_id, attachments")
        .eq("id", shotId)
        .eq("project_id", projectId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (shotLookupError || !shotRow) return json({ error: "That shot doesn't belong to this project." }, 403);
      shotDriveAttachmentsFolderId = shotRow.drive_attachments_folder_id || null;
      existingAttachments = Array.isArray(shotRow.attachments) ? shotRow.attachments : [];
    }

    // 2. Resolve the destination folder (unchanged behaviour).
    //    Shot attachments: Project / Attachments / Cut XX, falling back to project-level folders.
    //    Uploads without a shotId: Project / References, then the project root.
    const { data: project, error: projectError } = await db
      .from("projects")
      .select(["drive_references_folder_id", "drive_folder_id", "drive_attachments_folder_id"].join(", "))
      .eq("id", projectId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (projectError || !project) return json({ error: "Project not found" }, 404);

    const targetFolderId: string | null = shotId
      ? shotDriveAttachmentsFolderId ||
        project.drive_attachments_folder_id ||
        project.drive_references_folder_id ||
        project.drive_folder_id
      : project.drive_references_folder_id || project.drive_folder_id;

    if (!targetFolderId) {
      return json({
        error: "This project doesn't have Drive folders yet - create them from the project card first.",
        code: "not_connected",
      }, 400);
    }

    // 3. Google Drive connection (lazy + cached access token per isolate).
    const { data: connection } = await db
      .from("google_drive_connections")
      .select("refresh_token_encrypted")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!connection) return json({ error: "Connect Google Drive first.", code: "not_connected" }, 400);

    let accessPromise: Promise<string> | null = null;
    const getAccess = () =>
      (accessPromise ??= (async () =>
        getCachedAccessToken(await decryptText(connection.refresh_token_encrypted, Deno.env.get("DRIVE_TOKEN_ENCRYPTION_KEY")!)))());

    // 4a. init-upload: open the resumable session. The browser PUTs the bytes straight to Drive.
    if (action === "init-upload") {
      const uploadUrl = await createResumableUploadSession(
        await getAccess(),
        targetFolderId,
        String(body.name),
        safeMime(body.mimeType),
        Number(body.size),
        req.headers.get("Origin") || undefined,
        { [APP_PROP]: uploadKey, [FINGERPRINT_PROP]: body.fingerprint },
      );
      return json({ uploadUrl, uploadKey });
    }

    // 4b. recover-upload / finalize: locate the Drive file and verify it before recording it.
    const access = await getAccess();
    let fileId = typeof body.fileId === "string" ? body.fileId : "";

    if (action === "recover-upload") {
      const matches = await listFilesByAppProperty(access, targetFolderId, APP_PROP, uploadKey);
      const picked = pickRecoveredFile(matches, body.fingerprint, Number(body.size));
      if (!picked) {
        if (matches.some((m) => !m.trashed && !fingerprintMatches(m, body.fingerprint))) {
          return json({ error: "A different file was already uploaded under this upload key.", code: "file_mismatch" }, 409);
        }
        return json({ error: "The upload has not completed in Google Drive.", code: "upload_not_found" }, 404);
      }
      fileId = picked.id;
    }

    if (!/^[A-Za-z0-9_-]{10,100}$/.test(fileId)) return json({ error: "Missing Drive file id.", code: "invalid_file" }, 400);

    const meta = await getDriveFileMeta(access, fileId);
    if (!meta || meta.trashed || meta.appProperties?.[APP_PROP] !== uploadKey) {
      return json({ error: "This Drive file does not belong to the requested upload session." }, 403);
    }
    if (!meta.parents?.includes(targetFolderId)) {
      return json({ error: "This Drive file is not in the expected folder.", code: "file_mismatch" }, 409);
    }
    if (!fingerprintMatches(meta, body.fingerprint)) {
      return json({ error: "This Drive file is not the file that was selected for this upload.", code: "file_mismatch" }, 409);
    }
    const expectedSize = Number(body.size);
    if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 || Number(meta.size) !== expectedSize) {
      return json({ error: "The file in Google Drive is not the expected size.", code: "file_mismatch" }, 409);
    }
    // Full-content check: the fingerprint samples part of the file; Drive's md5Checksum covers every byte.
    const verdict = md5Verdict(meta, body.md5);
    if (verdict === "required") return json({ error: "A full-file checksum is required.", code: "md5_required", fileId }, 428);
    if (verdict === "pending") {
      return new Response(
        JSON.stringify({ error: "Google Drive is still processing the file. Retrying shortly.", code: "checksum_pending" }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json", "Retry-After": "3" } },
      );
    }
    if (verdict === "mismatch") return json({ error: MD5_MISMATCH_MESSAGE, code: "file_mismatch" }, 409);

    // Attachments stay link-viewable exactly as before (best effort; the file is safe in Drive either way).
    await shareFileWithAnyone(access, fileId);
    const url = `https://drive.google.com/file/d/${fileId}/view`;
    const name = typeof body.name === "string" && body.name ? body.name : meta.name || "attachment";

    // 5. Record the attachment against the shot, once. append_shot_file is atomic but not idempotent, so a
    //    retry after a lost response must not append the same Drive file twice.
    if (shotId) {
      const alreadyRecorded = existingAttachments.some((a) => a?.driveFileId === fileId);
      if (!alreadyRecorded) {
        const { error: appendError } = await db.rpc("append_shot_file", {
          p_shot_id: shotId,
          p_column: "attachments",
          p_entry: [{ name, url, driveFileId: fileId }],
        });
        if (appendError) {
          return json({
            error: "The file uploaded to Drive but couldn't be recorded on the shot, please try again.",
            code: "finalize_failed",
          }, 500);
        }
      }
    }

    return json({ success: true, name, url, driveFileId: fileId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("studio-drive-upload error:", message);
    return json({ error: message }, 500);
  }
});
