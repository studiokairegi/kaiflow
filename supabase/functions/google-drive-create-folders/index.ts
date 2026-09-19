// POST /google-drive-create-folders
// Headers: Authorization: Bearer <supabase access token>
//
// Body: { projectId: string, projectName: string }
//
// Creates:
//
// Kairil Projects/
//   Project Name/
//     References/
//     Cuts/
//       Cut 01/
//       Cut 02/
//     Deliverables/
//       Cut 01/
//       Cut 02/
//     Attachments/
//       Cut 01/
//       Cut 02/

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { decryptText } from "../_shared/crypto.ts";
import { getAccessToken, createDriveFolder } from "../_shared/google.ts";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";

const CUT_TITLE_REGEX = /^Cut [0-9]+$/;

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "");

    if (!token) {
      return new Response(
        JSON.stringify({ error: "Missing Authorization header" }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
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
      return new Response(
        JSON.stringify({ error: "Invalid session" }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const { projectId, projectName } = await req.json();

    if (!projectId || !projectName) {
      return new Response(
        JSON.stringify({ error: "Missing projectId or projectName" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // -----------------------------------------------------------------------
    // 1. Verify project ownership and load current Drive folder IDs.
    // -----------------------------------------------------------------------

    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select(
        [
          "id",
          "name",
          "drive_folder_id",
          "drive_folder_url",
          "drive_references_folder_id",
          "drive_cuts_folder_id",
          "drive_deliverables_folder_id",
          "drive_attachments_folder_id",
        ].join(", ")
      )
      .eq("id", projectId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (projectError || !project) {
      return new Response(
        JSON.stringify({ error: "Project not found" }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // -----------------------------------------------------------------------
    // 2. Load shots.
    // -----------------------------------------------------------------------

    const { data: shots, error: shotsError } = await supabase
      .from("shots")
      .select(
        [
          "id",
          "title",
          "created_at",
          "drive_cuts_folder_id",
          "drive_deliverables_folder_id",
          "drive_attachments_folder_id",
        ].join(", ")
      )
      .eq("project_id", projectId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });

    if (shotsError) {
      return new Response(
        JSON.stringify({
          error: `Unable to load project shots: ${shotsError.message}`,
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // -----------------------------------------------------------------------
    // 3. Google Drive connection.
    // -----------------------------------------------------------------------

    const { data: connection, error: connectionError } = await supabase
      .from("google_drive_connections")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    if (connectionError || !connection) {
      return new Response(
        JSON.stringify({ error: "Google Drive isn't connected yet" }),
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
    // 4. Reuse/create Kairil Projects root.
    // -----------------------------------------------------------------------

    let rootFolderId = connection.root_folder_id;

    if (!rootFolderId) {
      const root = await createDriveFolder(
        accessToken,
        "Kairil Projects"
      );

      rootFolderId = root.id;

      const { error } = await supabase
        .from("google_drive_connections")
        .update({ root_folder_id: rootFolderId })
        .eq("user_id", user.id);

      if (error) {
        console.error(
          "Failed to save root_folder_id:",
          error.message
        );
      }
    }

    // -----------------------------------------------------------------------
    // 5. Reuse/create project folder.
    // -----------------------------------------------------------------------

    let projectFolderId = project.drive_folder_id;
    let projectFolderUrl = project.drive_folder_url;

    if (!projectFolderId) {
      const projectFolder = await createDriveFolder(
        accessToken,
        projectName,
        rootFolderId
      );

      projectFolderId = projectFolder.id;
      projectFolderUrl = projectFolder.url;
    }

    // -----------------------------------------------------------------------
    // 6. Reuse/create project-level folders.
    // -----------------------------------------------------------------------

    let referencesFolderId =
      project.drive_references_folder_id || null;

    // IMPORTANT:
    // Store the Cuts parent on the project so subsequent provisioning
    // requests reuse the same Drive folder instead of creating duplicates.
    let cutsFolderId =
      project.drive_cuts_folder_id || null;

    let deliverablesFolderId =
      project.drive_deliverables_folder_id || null;

    let attachmentsFolderId =
      project.drive_attachments_folder_id || null;

    if (!referencesFolderId) {
      const folder = await createDriveFolder(
        accessToken,
        "References",
        projectFolderId
      );

      referencesFolderId = folder.id;
    }

    if (!cutsFolderId) {
      const folder = await createDriveFolder(
        accessToken,
        "Cuts",
        projectFolderId
      );

      cutsFolderId = folder.id;
    }

    if (!deliverablesFolderId) {
      const folder = await createDriveFolder(
        accessToken,
        "Deliverables",
        projectFolderId
      );

      deliverablesFolderId = folder.id;
    }

    if (!attachmentsFolderId) {
      const folder = await createDriveFolder(
        accessToken,
        "Attachments",
        projectFolderId
      );

      attachmentsFolderId = folder.id;
    }

    // -----------------------------------------------------------------------
    // 7. Persist all project-level folder IDs.
    // -----------------------------------------------------------------------

    const { error: projectUpdateError } = await supabase
      .from("projects")
      .update({
        drive_folder_id: projectFolderId,
        drive_folder_url: projectFolderUrl,
        drive_references_folder_id: referencesFolderId,
        drive_cuts_folder_id: cutsFolderId,
        drive_deliverables_folder_id: deliverablesFolderId,
        drive_attachments_folder_id: attachmentsFolderId,
      })
      .eq("id", projectId)
      .eq("user_id", user.id);

    if (projectUpdateError) {
      return new Response(
        JSON.stringify({
          error:
            "Drive folders were created but couldn't be saved to the project.",
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
    // 8. Provision per-cut folders.
    //
    // Shot ID is authoritative.
    // Title is only used to identify standard Cut XX shots.
    // Existing folder IDs are reused.
    // -----------------------------------------------------------------------

    let provisionedShotCount = 0;

    for (const shot of shots || []) {
      const title = String(shot.title || "").trim();

      if (!CUT_TITLE_REGEX.test(title)) {
        continue;
      }

      let cutsShotFolderId =
        shot.drive_cuts_folder_id || null;

      let deliverablesShotFolderId =
        shot.drive_deliverables_folder_id || null;

      let attachmentsShotFolderId =
        shot.drive_attachments_folder_id || null;

      if (!cutsShotFolderId) {
        const folder = await createDriveFolder(
          accessToken,
          title,
          cutsFolderId
        );

        cutsShotFolderId = folder.id;
      }

      if (!deliverablesShotFolderId) {
        const folder = await createDriveFolder(
          accessToken,
          title,
          deliverablesFolderId
        );

        deliverablesShotFolderId = folder.id;
      }

      if (!attachmentsShotFolderId) {
        const folder = await createDriveFolder(
          accessToken,
          title,
          attachmentsFolderId
        );

        attachmentsShotFolderId = folder.id;
      }

      const { error: shotUpdateError } = await supabase
        .from("shots")
        .update({
          drive_cuts_folder_id: cutsShotFolderId,
          drive_deliverables_folder_id:
            deliverablesShotFolderId,
          drive_attachments_folder_id:
            attachmentsShotFolderId,
        })
        .eq("id", shot.id)
        .eq("project_id", projectId);

      if (shotUpdateError) {
        return new Response(
          JSON.stringify({
            error:
              `Folders for ${title} were created, but the shot record could not be updated: ${shotUpdateError.message}`,
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

      provisionedShotCount += 1;
    }

    // -----------------------------------------------------------------------
    // 9. Return complete provisioning result.
    // -----------------------------------------------------------------------

    return new Response(
      JSON.stringify({
        folderId: projectFolderId,
        folderUrl: projectFolderUrl,
        referencesFolderId,
        cutsFolderId,
        deliverablesFolderId,
        attachmentsFolderId,
        provisionedShotCount,
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
      "google-drive-create-folders error:",
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