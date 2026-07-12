// POST /google-drive-create-folders
// Headers: Authorization: Bearer <supabase access token>
// Body: { projectId: string, projectName: string }
//
// Creates References / Cuts / Deliverables subfolders under a per-project
// folder, itself under a shared "KaiFlow Projects" folder in the studio's
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
      const root = await createDriveFolder(accessToken, "KaiFlow Projects");
      rootFolderId = root.id;
      await supabase
        .from("google_drive_connections")
        .update({ root_folder_id: rootFolderId })
        .eq("user_id", user.id);
    }

    const projectFolder = await createDriveFolder(accessToken, projectName, rootFolderId);
    const [referencesFolder, cutsFolder, deliverablesFolder] = await Promise.all([
      createDriveFolder(accessToken, "References", projectFolder.id),
      createDriveFolder(accessToken, "Cuts", projectFolder.id),
      createDriveFolder(accessToken, "Deliverables", projectFolder.id),
    ]);

    await supabase
      .from("projects")
      .update({
        drive_folder_id: projectFolder.id,
        drive_folder_url: projectFolder.url,
        drive_deliverables_folder_id: deliverablesFolder.id,
      })
      .eq("id", projectId)
      .eq("user_id", user.id);

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
