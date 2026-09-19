// POST /studio-drive-delete-project
// Headers: Authorization: Bearer <supabase access token>
// Body: { projectId }
//
// Deleting a project in Kairil previously only removed the database row -
// its Google Drive folder (and everything nested under it: References,
// Cuts, Deliverables) was never touched, so every deleted project left an
// orphaned folder behind in the studio's Drive forever. This trashes that
// folder (recoverable from Drive's own Trash, same as studio-drive-delete
// does for individual attachments) so the two stay in sync. This function
// only trashes the Drive folder - the caller is still responsible for
// deleting the project row itself afterward.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { decryptText } from "../_shared/crypto.ts";
import { getAccessToken, trashDriveFile } from "../_shared/google.ts";
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

    const { projectId } = await req.json();
    if (!projectId) {
      return new Response(JSON.stringify({ error: "Missing projectId" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Verify the project belongs to this user before touching Drive - same
    // ownership-before-action ordering as google-drive-create-folders and
    // studio-drive-delete.
    const { data: projectRow, error: projectError } = await supabase
      .from("projects")
      .select("id, drive_folder_id")
      .eq("id", projectId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (projectError || !projectRow) {
      return new Response(JSON.stringify({ error: "Project not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Nothing to trash - the project never had Drive folders created.
    if (!projectRow.drive_folder_id) {
      return new Response(JSON.stringify({ success: true, skipped: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: connection } = await supabase
      .from("google_drive_connections")
      .select("refresh_token_encrypted")
      .eq("user_id", user.id)
      .maybeSingle();

    // No active Drive connection (disconnected since the folder was
    // created) - nothing we can do on the Drive side, but that shouldn't
    // block the caller from deleting the project record.
    if (!connection) {
      return new Response(JSON.stringify({ success: true, skipped: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    try {
      const encryptionKey = Deno.env.get("DRIVE_TOKEN_ENCRYPTION_KEY")!;
      const refreshToken = await decryptText(connection.refresh_token_encrypted, encryptionKey);
      const accessToken = await getAccessToken(refreshToken);
      // Trashing the project folder trashes everything nested under it
      // (References/Cuts/Deliverables) along with it - no need to trash
      // each subfolder individually.
      await trashDriveFile(accessToken, projectRow.drive_folder_id);
    } catch (err) {
      console.error("Trashing project Drive folder failed:", err);
      return new Response(JSON.stringify({ error: "Couldn't trash the Drive folder" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
