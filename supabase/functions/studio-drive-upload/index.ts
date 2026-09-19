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

    if (
      !projectId ||
      typeof projectId !== "string" ||
      !(file instanceof File)
    ) {
      return new Response(
        JSON.stringify({ error: "Missing projectId or file" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Keep the existing 50MB safety limit.
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
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // -----------------------------------------------------------------------
    // 1. Validate the shot first when a shotId was supplied.
    //
    // Shot ID is authoritative. This prevents uploading to Drive when the
    // supplied shot does not belong to the authenticated user's project.
    // -----------------------------------------------------------------------

    let shotDriveAttachmentsFolderId: string | null = null;

    if (shotId && typeof shotId === "string") {
      const { data: shotRow, error: shotLookupError } = await supabase
        .from("shots")
        .select("id, drive_attachments_folder_id")
        .eq("id", shotId)
        .eq("project_id", projectId)
        .eq("user_id", user.id)
        .maybeSingle();

      if (shotLookupError || !shotRow) {
        return new Response(
          JSON.stringify({
            error: "That shot doesn't belong to this project.",
          }),
          {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      shotDriveAttachmentsFolderId =
        shotRow.drive_attachments_folder_id || null;
    }

    // -----------------------------------------------------------------------
    // 2. Load project-level Drive folders.
    //
    // Shot attachments prefer:
    //   Project / Attachments / Cut XX
    //
    // Legacy/project-level fallback:
    //   Project / References
    //   Project root
    //
    // The project-level attachment folder is used only as a fallback when
    // the shot-specific attachment folder is unavailable.
    // -----------------------------------------------------------------------

    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select(
        [
          "drive_references_folder_id",
          "drive_folder_id",
          "drive_attachments_folder_id",
        ].join(", ")
      )
      .eq("id", projectId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (projectError || !project) {
      return new Response(JSON.stringify({ error: "Project not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let targetFolderId: string | null = null;

    if (shotId && typeof shotId === "string") {
      // Shot attachment destination is authoritative for shot attachments.
      targetFolderId =
        shotDriveAttachmentsFolderId ||
        project.drive_attachments_folder_id ||
        project.drive_references_folder_id ||
        project.drive_folder_id;
    } else {
      // Preserve existing behavior for uploads without a shotId.
      targetFolderId =
        project.drive_references_folder_id || project.drive_folder_id;
    }

    if (!targetFolderId) {
      return new Response(
        JSON.stringify({
          error: "not_connected",
          message:
            "This project doesn't have Drive folders yet - create them from the project card first.",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // -----------------------------------------------------------------------
    // 3. Google Drive connection.
    // -----------------------------------------------------------------------

    const { data: connection } = await supabase
      .from("google_drive_connections")
      .select("refresh_token_encrypted")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!connection) {
      return new Response(
        JSON.stringify({
          error: "not_connected",
          message: "Connect Google Drive first.",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const encryptionKey = Deno.env.get("DRIVE_TOKEN_ENCRYPTION_KEY")!;

    const refreshToken = await decryptText(
      connection.refresh_token_encrypted,
      encryptionKey
    );

    const accessToken = await getAccessToken(refreshToken);

    // -----------------------------------------------------------------------
    // 4. Upload to the resolved destination.
    // -----------------------------------------------------------------------

    const uploaded = await uploadFileToDrive(
      accessToken,
      targetFolderId,
      file.name,
      file,
      file.type
    );

    // -----------------------------------------------------------------------
    // 5. Record the attachment against the shot.
    // -----------------------------------------------------------------------

    if (shotId && typeof shotId === "string") {
      const { error: appendError } = await supabase.rpc(
        "append_shot_file",
        {
          p_shot_id: shotId,
          p_column: "attachments",
          p_entry: [
            {
              name: file.name,
              url: uploaded.url,
              driveFileId: uploaded.id,
            },
          ],
        }
      );

      if (appendError) {
        return new Response(
          JSON.stringify({
            error:
              "The file uploaded to Drive but couldn't be recorded on the shot, please try again.",
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
    }

    return new Response(
      JSON.stringify({
        success: true,
        name: file.name,
        url: uploaded.url,
        driveFileId: uploaded.id,
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

    return new Response(
      JSON.stringify({ error: message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});