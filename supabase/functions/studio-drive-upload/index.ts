// POST /studio-drive-upload
// Headers: Authorization: Bearer <supabase access token>
// multipart/form-data with fields: projectId, file
//
// Studio-side counterpart to freelancer-drive-upload: uploads a shot
// reference file to the project's Drive "References" folder (falling
// back to the project's root Drive folder for older projects created
// before that subfolder existed) instead of Supabase Storage, so studio
// attachments and freelancer deliverables both end up in the same place -
// the project's own Drive folder - with only the file's Drive id/url
// ever stored in Supabase.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { decryptText } from "../_shared/crypto.ts";
import { getAccessToken, uploadFileToDrive } from "../_shared/google.ts";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "");
    if (!token) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseAuth = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!
    );
    const {
      data: { user },
      error: authError,
    } = await supabaseAuth.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Invalid session" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const formData = await req.formData();
    const projectId = formData.get("projectId");
    const shotId = formData.get("shotId");
    const file = formData.get("file");
    if (!projectId || typeof projectId !== "string" || !(file instanceof File)) {
      return new Response(JSON.stringify({ error: "Missing projectId or file" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Same reasoning as freelancer-drive-upload's cap - keeps a single
    // browser tab from being able to push something absurd into Drive.
    // 200MB was never actually achievable: an Edge Function's memory
    // ceiling is well under that, and the multipart body has to exist as a
    // Blob alongside the incoming file, so the old cap advertised a size
    // that would reliably OOM mid-upload rather than return a clean error.
    // 50MB comfortably covers real frames/PSDs/short clips within the
    // memory actually available. Raising this further needs Drive's
    // resumable (chunked) upload API, not a bigger number here.
    const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
    if (file.size > MAX_UPLOAD_BYTES) {
      return new Response(
        JSON.stringify({ error: `File is too large. The limit is ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB.` }),
        { status: 413, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("drive_references_folder_id, drive_folder_id")
      .eq("id", projectId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (projectError || !project) {
      return new Response(JSON.stringify({ error: "Project not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const targetFolderId = project.drive_references_folder_id || project.drive_folder_id;
    if (!targetFolderId) {
      return new Response(
        JSON.stringify({ error: "not_connected", message: "This project doesn't have Drive folders yet - create them from the project card first." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: connection } = await supabase
      .from("google_drive_connections")
      .select("refresh_token_encrypted")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!connection) {
      return new Response(
        JSON.stringify({ error: "not_connected", message: "Connect Google Drive first." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const encryptionKey = Deno.env.get("DRIVE_TOKEN_ENCRYPTION_KEY")!;
    const refreshToken = await decryptText(connection.refresh_token_encrypted, encryptionKey);
    const accessToken = await getAccessToken(refreshToken);

    // Validate the shot BEFORE touching Drive, not after - the previous
    // version uploaded first and only checked shotId ownership afterward,
    // so a bad shotId still produced a real orphaned Drive file with no
    // way to record it. Checking here means a rejected shotId never
    // costs a Drive API call or leaves anything behind.
    if (shotId && typeof shotId === "string") {
      const { data: shotRow, error: shotLookupError } = await supabase
        .from("shots")
        .select("id")
        .eq("id", shotId)
        .eq("project_id", projectId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (shotLookupError || !shotRow) {
        return new Response(
          JSON.stringify({ error: "That shot doesn't belong to this project." }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    const uploaded = await uploadFileToDrive(accessToken, targetFolderId, file.name, file, file.type);

    // Record the attachment against the shot if one was given (attachments
    // are edited from within a shot's editor). Uses the same atomic
    // append as the freelancer path rather than a client-side
    // read-modify-write, for the same reason.
    if (shotId && typeof shotId === "string") {
      const { error: appendError } = await supabase.rpc("append_shot_file", {
        p_shot_id: shotId,
        p_column: "attachments",
        p_entry: [{ name: file.name, url: uploaded.url, driveFileId: uploaded.id }],
      });
      if (appendError) {
        return new Response(
          JSON.stringify({ error: "The file uploaded to Drive but couldn't be recorded on the shot, please try again." }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    return new Response(
      JSON.stringify({ success: true, name: file.name, url: uploaded.url, driveFileId: uploaded.id }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
