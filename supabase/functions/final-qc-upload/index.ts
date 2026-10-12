// POST /final-qc-upload   (studio session required: Authorization: Bearer <user JWT>)
// multipart/form-data: shotId, uploadKey, file
//
// Uploads a QC-adjusted FINAL file into  <Project>/Final QC/<Cut>/  and records it
// as a candidate final version. Upload != release: nothing here makes the file
// visible to a client; that is a separate, explicit release_final_version call.
//
// - uploadKey is a client-generated id per upload attempt. Re-sending the same
//   key (double click, network retry) returns the existing record, never a
//   second file or version.
// - The file is validated against Drive after upload (exists, not trashed, right
//   folder, size matches). A failed validation is recorded and can never be released.
// - The Drive file is NOT shared with "anyone with the link".

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { decryptText } from "../_shared/crypto.ts";
import { getAccessToken, uploadFileToDrive, getDriveFileMeta, trashDriveFile } from "../_shared/google.ts";
import { ensureFinalQcFolders, cleanFolderName } from "../_shared/final_qc.ts";
import { validateFinalUploadInput, validateDriveFile } from "../_shared/final_validation.ts";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const UNLOCKED_STATES = ["qc_adjustments", "ready_for_client", "released"];

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace("Bearer ", "");
    if (!jwt) return json({ error: "Missing Authorization header" }, 401);

    const supabaseAuth = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(jwt);
    if (authError || !user) return json({ error: "Invalid session" }, 401);

    const form = await req.formData();
    const shotId = form.get("shotId");
    const uploadKey = form.get("uploadKey");
    const file = form.get("file");
    if (typeof shotId !== "string" || typeof uploadKey !== "string" || !(file instanceof File)) {
      return json({ error: "Missing shotId, uploadKey or file" }, 400);
    }
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(uploadKey)) {
      return json({ error: "Invalid uploadKey" }, 400);
    }

    const input = validateFinalUploadInput({ name: file.name, size: file.size });
    if (!input.ok) return json({ error: input.error }, input.status);

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // 1. Authoritative shot + ownership. The shot id alone is never trusted.
    const { data: shot, error: shotErr } = await supabase
      .from("shots")
      .select("id, project_id, user_id, title, workflow_state, drive_final_qc_folder_id")
      .eq("id", shotId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (shotErr || !shot) return json({ error: "That cut doesn't belong to your studio." }, 403);
    if (!UNLOCKED_STATES.includes(shot.workflow_state)) {
      return json({ error: "Final upload unlocks after the freelancer's submission passes internal QC." }, 409);
    }

    // 2. Retry safety: same key -> same record, no second Drive file.
    const { data: prior } = await supabase
      .from("cut_final_versions")
      .select("id, version, validation_status")
      .eq("shot_id", shot.id)
      .eq("upload_key", uploadKey)
      .maybeSingle();
    if (prior) {
      return json({
        success: prior.validation_status === "valid",
        versionId: prior.id,
        version: prior.version,
        validationStatus: prior.validation_status,
        duplicate: true,
      });
    }

    const { data: project } = await supabase
      .from("projects")
      .select("id, drive_folder_id, drive_final_qc_folder_id")
      .eq("id", shot.project_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!project) return json({ error: "Project not found." }, 404);

    // 3. Drive connection.
    const { data: connection } = await supabase
      .from("google_drive_connections")
      .select("refresh_token_encrypted")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!connection) {
      return json({ error: "not_connected", message: "Connect Google Drive in Settings first." }, 400);
    }
    const refreshToken = await decryptText(connection.refresh_token_encrypted, Deno.env.get("DRIVE_TOKEN_ENCRYPTION_KEY")!);
    const accessToken = await getAccessToken(refreshToken);

    // 4. Final QC folders (reuse or create).
    let folders;
    try {
      folders = await ensureFinalQcFolders(supabase, accessToken, project, shot);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "not_connected") {
        return json({ error: "not_connected", message: "This project has no Drive folders yet. Create them from the project's Drive settings first." }, 400);
      }
      return json({ error: `Couldn't prepare the Final QC folder: ${msg}` }, 502);
    }

    // 5. Upload privately (no public link).
    const driveName = `${cleanFolderName(shot.title, "Cut")} - FINAL - ${uploadKey.slice(0, 8)} - ${file.name}`;
    let uploaded: { id: string; url: string } | null = null;
    let failure: string | null = null;
    try {
      uploaded = await uploadFileToDrive(accessToken, folders.cutFolderId, driveName, file, file.type, false);
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    }

    // 6. Backend validation against Drive.
    if (uploaded && !failure) {
      try {
        const meta = await getDriveFileMeta(accessToken, uploaded.id);
        failure = validateDriveFile(meta, { fileId: uploaded.id, folderId: folders.cutFolderId, sizeBytes: file.size });
      } catch (e) {
        failure = `Couldn't verify the file in Drive: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    const valid = !failure && !!uploaded;

    // 7. Record (valid or invalid). A recording failure must not leave an orphan.
    const { data: rec, error: recErr } = await supabase.rpc("register_final_version", {
      p_user_id: user.id,
      p_shot_id: shot.id,
      p_upload_key: uploadKey,
      p_drive_file_id: uploaded?.id ?? null,
      p_drive_folder_id: folders.cutFolderId,
      p_file_name: file.name,
      p_mime: file.type || null,
      p_size: file.size,
      p_valid: valid,
      p_error: failure,
    });
    if (recErr) {
      if (uploaded) await trashDriveFile(accessToken, uploaded.id);
      const m = recErr.message || "";
      const status = m.includes("final_upload_not_unlocked") || m.includes("no_qc_approval") ? 409 : 500;
      return json({ error: m.includes("no_qc_approval") ? "No approved internal QC submission exists for this cut." : `Couldn't record the final file: ${m}` }, status);
    }

    if (!valid) {
      return json({ success: false, error: failure, versionId: rec?.versionId, validationStatus: "invalid" }, 422);
    }
    return json({
      success: true,
      versionId: rec.versionId,
      version: rec.version,
      validationStatus: "valid",
      duplicate: !!rec.duplicate,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("final-qc-upload error:", message);
    return json({ error: message }, 500);
  }
});
