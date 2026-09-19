// POST /google-drive-create-folders
// Headers: Authorization: Bearer <supabase access token>
// Body: { projectId: string, projectName: string }
//
// Creates References / Cuts / Deliverables subfolders under a per-project
// folder, itself under a shared "Kairil Projects" folder in the studio's
// Drive. Returns the folder ids/urls so the app can save them on the
// project row and link to them.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { decryptText } from "../_shared/crypto.ts";
import { getAccessToken, createDriveFolder } from "../_shared/google.ts";
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

    const { projectId, projectName } = await req.json();
    if (!projectId || !projectName) {
      return new Response(JSON.stringify({ error: "Missing projectId or projectName" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Verify the project actually belongs to this user BEFORE creating
    // anything in Drive. The previous version only checked ownership via
    // the final .update(...).eq("user_id", user.id) - which just quietly
    // updates zero rows on a bad projectId rather than erroring - so a
    // bad request still burned Drive API calls and left orphaned,
    // never-linked folders sitting in the user's Drive.
    const { data: existingProject, error: existingProjectError } = await supabase
      .from("projects")
      .select("id, drive_folder_id, drive_folder_url, drive_references_folder_id, drive_deliverables_folder_id")
      .eq("id", projectId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (existingProjectError || !existingProject) {
      return new Response(JSON.stringify({ error: "Project not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Idempotency guard: the client already avoids calling this when it
    // has a driveFolderId in local state, but that alone doesn't stop two
    // browser tabs (or a retried request) from racing here before either
    // has that state - both would see "no folder" and each create a full
    // duplicate set of Drive folders. Re-checking the authoritative row
    // here, immediately before doing any Drive work, closes that race:
    // whichever request's project update lands first wins, and any later
    // one just returns those already-created folders instead of making a
    // second set.
    if (existingProject.drive_folder_id) {
      return new Response(
        JSON.stringify({
          folderId: existingProject.drive_folder_id,
          folderUrl: existingProject.drive_folder_url,
          referencesFolderId: existingProject.drive_references_folder_id,
          deliverablesFolderId: existingProject.drive_deliverables_folder_id,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: connection, error: connError } = await supabase
      .from("google_drive_connections")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    if (connError || !connection) {
      return new Response(JSON.stringify({ error: "Google Drive isn't connected yet" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const encryptionKey = Deno.env.get("DRIVE_TOKEN_ENCRYPTION_KEY")!;
    const refreshToken = await decryptText(connection.refresh_token_encrypted, encryptionKey);
    const accessToken = await getAccessToken(refreshToken);

    let rootFolderId = connection.root_folder_id;
    if (!rootFolderId) {
      const root = await createDriveFolder(accessToken, "Kairil Projects");
      rootFolderId = root.id;
      const { error: rootUpdateError } = await supabase
        .from("google_drive_connections")
        .update({ root_folder_id: rootFolderId })
        .eq("user_id", user.id);
      if (rootUpdateError) {
        // Not fatal for this run since we already have the id in memory,
        // but log it since a repeat failure here would create a new
        // "Kairil Projects" folder every time instead of reusing this one.
        console.error("Failed to save root_folder_id:", rootUpdateError.message);
      }
    }

    const projectFolder = await createDriveFolder(accessToken, projectName, rootFolderId);
    const [referencesFolder, cutsFolder, deliverablesFolder] = await Promise.all([
      createDriveFolder(accessToken, "References", projectFolder.id),
      createDriveFolder(accessToken, "Cuts", projectFolder.id),
      createDriveFolder(accessToken, "Deliverables", projectFolder.id),
    ]);

    const { error: projectUpdateError } = await supabase
      .from("projects")
      .update({
        drive_folder_id: projectFolder.id,
        drive_folder_url: projectFolder.url,
        drive_deliverables_folder_id: deliverablesFolder.id,
        drive_references_folder_id: referencesFolder.id,
      })
      .eq("id", projectId)
      .eq("user_id", user.id);

    if (projectUpdateError) {
      // The folders exist in Drive at this point, but weren't saved against
      // the project, so don't report success, the app would show a folder
      // link that disappears on next reload.
      return new Response(
        JSON.stringify({
          error: "Folders were created in Drive but couldn't be saved to this project, please try again.",
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        folderId: projectFolder.id,
        folderUrl: projectFolder.url,
        referencesFolderId: referencesFolder.id,
        cutsFolderId: cutsFolder.id,
        deliverablesFolderId: deliverablesFolder.id,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
