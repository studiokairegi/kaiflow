// POST /freelancer-drive-upload
// multipart/form-data with fields: token (the shot's share token), file
//
// Uploads freelancer deliverables directly into the shot's:
// Project / Deliverables / Cut XX /
//
// Legacy shots without a per-shot Drive folder fall back to the
// project-level Deliverables folder.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { decryptText } from "../_shared/crypto.ts";
import { getAccessToken, uploadFileToDrive } from "../_shared/google.ts";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;

  try {
    const formData = await req.formData();
    const token = formData.get("token");
    const file = formData.get("file");

    if (!token || typeof token !== "string" || !(file instanceof File)) {
      return new Response(
        JSON.stringify({ error: "Missing token or file" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // 50MB limit for the current non-resumable Edge Function upload path.
    const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

    if (file.size > MAX_UPLOAD_BYTES) {
      return new Response(
        JSON.stringify({
          error: `File is too large. The limit is ${
            MAX_UPLOAD_BYTES / (1024 * 1024)
          }MB.`,
        }),
        {
          status: 413,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // -----------------------------------------------------------------------
    // 1. Resolve the share token to the authoritative shot.
    // -----------------------------------------------------------------------

    const { data: shot, error: shotError } = await supabase
      .from("shots")
      .select(
        [
          "id",
          "project_id",
          "user_id",
          "title",
          "stage",
          "assigned_to",
          "deliverables",
          "drive_deliverables_folder_id",
        ].join(", ")
      )
      .eq("share_token", token)
      .maybeSingle();

    if (shotError || !shot) {
      return new Response(
        JSON.stringify({ error: "This link isn't valid." }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // -----------------------------------------------------------------------
    // 2. Resolve the upload destination.
    //
    // Preferred:
    //   shots.drive_deliverables_folder_id
    //
    // Legacy fallback:
    //   projects.drive_deliverables_folder_id
    //
    // The shot ID is authoritative, so repeated "Cut 01" titles in different
    // projects cannot accidentally route an upload to another shot.
    // -----------------------------------------------------------------------

    let deliverablesFolderId =
      shot.drive_deliverables_folder_id || null;

    if (!deliverablesFolderId) {
      const { data: project, error: projectError } = await supabase
        .from("projects")
        .select("drive_deliverables_folder_id")
        .eq("id", shot.project_id)
        .maybeSingle();

      if (projectError) {
        return new Response(
          JSON.stringify({
            error: "Unable to determine the project's Drive folder.",
          }),
          {
            status: 500,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json",
            },
          }
        );
      }

      deliverablesFolderId =
        project?.drive_deliverables_folder_id || null;
    }

    if (!deliverablesFolderId) {
      return new Response(
        JSON.stringify({
          error: "not_connected",
          message:
            "This project isn't set up with a Deliverables Drive folder yet.",
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

    // -----------------------------------------------------------------------
    // 3. Get the studio's Google Drive connection.
    // -----------------------------------------------------------------------

    const { data: connection, error: connectionError } =
      await supabase
        .from("google_drive_connections")
        .select("refresh_token_encrypted")
        .eq("user_id", shot.user_id)
        .maybeSingle();

    if (connectionError || !connection) {
      return new Response(
        JSON.stringify({
          error: "not_connected",
          message: "The studio's Drive connection is missing.",
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

    const encryptionKey =
      Deno.env.get("DRIVE_TOKEN_ENCRYPTION_KEY")!;

    const refreshToken = await decryptText(
      connection.refresh_token_encrypted,
      encryptionKey
    );

    const accessToken = await getAccessToken(refreshToken);

    // -----------------------------------------------------------------------
    // 4. Upload directly into the resolved Deliverables/Cut XX folder.
    // -----------------------------------------------------------------------

    const cleanTitle = (shot.title || "shot")
      .replace(/[^\w\- ]+/g, "")
      .trim();

    const driveFileName = `${cleanTitle} - ${file.name}`;

    const uploaded = await uploadFileToDrive(
      accessToken,
      deliverablesFolderId,
      driveFileName,
      file,
      file.type
    );

    // -----------------------------------------------------------------------
    // 5. Record the deliverable against the authoritative shot.
    // -----------------------------------------------------------------------

    const nextDeliverable = {
      name: file.name,
      url: uploaded.url,
      driveFileId: uploaded.id,
      uploadedAt: new Date().toISOString(),
    };

    const { error: updateError } = await supabase.rpc(
      "append_shot_file",
      {
        p_shot_id: shot.id,
        p_column: "deliverables",
        p_entry: [nextDeliverable],
      }
    );

    if (updateError) {
      // The file exists in Drive but isn't linked to the shot.
      return new Response(
        JSON.stringify({
          error:
            "The file uploaded to Drive but couldn't be recorded, please tell the studio directly.",
        }),
        {
          status: 500,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

    // -----------------------------------------------------------------------
    // 6. Activity log.
    // -----------------------------------------------------------------------

    const { error: logError } = await supabase
      .from("activity_log")
      .insert({
        user_id: shot.user_id,
        project_id: shot.project_id,
        shot_id: shot.id,
        event_type: "freelancer_upload",
        description: `${
          shot.assigned_to || "A freelancer"
        } uploaded "${file.name}" to Drive for ${shot.title}`,
      });

    if (logError) {
      // Non-fatal: the deliverable itself is already safely recorded.
      console.error(
        "Activity log insert failed:",
        logError.message
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        url: uploaded.url,
      }),
      {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err);

    console.error(
      "freelancer-drive-upload error:",
      message
    );

    return new Response(
      JSON.stringify({ error: message }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }
});