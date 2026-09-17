// POST /studio-drive-delete
// Headers: Authorization: Bearer <supabase access token>
// Body: { shotId, driveFileId, url }
//
// Removing an attachment in Kairil previously only dropped the metadata
// row - the actual file stayed in the studio's Drive forever, so "deleting"
// a file in the UI quietly did nothing to the file itself, accumulating
// orphans indefinitely. This removes both: the Drive file (to trash, so
// it's still recoverable there) and the shot's attachment entry.

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

    const { shotId, driveFileId, url } = await req.json();
    if (!shotId || !url) {
      return new Response(JSON.stringify({ error: "Missing shotId or url" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Confirm the shot belongs to this user before touching anything -
    // same ordering lesson as studio-drive-upload: verify first, act after.
    const { data: shotRow, error: shotError } = await supabase
      .from("shots")
      .select("id")
      .eq("id", shotId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (shotError || !shotRow) {
      return new Response(JSON.stringify({ error: "Shot not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Best-effort on the Drive side: older attachments (from before the
    // Drive-only migration) have no driveFileId at all, and a file already
    // removed in Drive shouldn't prevent cleaning up the record here.
    if (driveFileId) {
      const { data: connection } = await supabase
        .from("google_drive_connections")
        .select("refresh_token_encrypted")
        .eq("user_id", user.id)
        .maybeSingle();
      if (connection) {
        try {
          const encryptionKey = Deno.env.get("DRIVE_TOKEN_ENCRYPTION_KEY")!;
          const refreshToken = await decryptText(connection.refresh_token_encrypted, encryptionKey);
          const accessToken = await getAccessToken(refreshToken);
          await trashDriveFile(accessToken, driveFileId);
        } catch (err) {
          console.error("Trashing Drive file failed, continuing with record removal:", err);
        }
      }
    }

    const { error: removeError } = await supabase.rpc("remove_shot_file", {
      p_shot_id: shotId,
      p_column: "attachments",
      p_url: url,
    });
    if (removeError) {
      return new Response(JSON.stringify({ error: "Couldn't remove the attachment record." }), {
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
