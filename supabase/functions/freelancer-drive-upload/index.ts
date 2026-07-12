// POST /freelancer-drive-upload
// multipart/form-data with fields: token (the shot's share token), file
//
// No login involved. The share token is the only credential. This function
// looks up which studio/project/shot the token belongs to, uses that
// studio's stored Drive connection to upload the file, then records the
// deliverable and an activity log entry, all server-side so the studio's
// Drive credentials are never exposed to the freelancer's browser.

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
      return new Response(JSON.stringify({ error: "Missing token or file" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: shot, error: shotError } = await supabase
      .from("shots")
      .select("id, project_id, user_id, title, stage, assigned_to, deliverables")
      .eq("share_token", token)
      .maybeSingle();

    if (shotError || !shot) {
      return new Response(JSON.stringify({ error: "This link isn't valid." }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: project } = await supabase
      .from("projects")
      .select("drive_deliverables_folder_id")
      .eq("id", shot.project_id)
      .maybeSingle();

    if (!project?.drive_deliverables_folder_id) {
      return new Response(
        JSON.stringify({ error: "not_connected", message: "This project isn't set up with Drive yet." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: connection } = await supabase
      .from("google_drive_connections")
      .select("refresh_token_encrypted")
      .eq("user_id", shot.user_id)
      .maybeSingle();

    if (!connection) {
      return new Response(
        JSON.stringify({ error: "not_connected", message: "The studio's Drive connection is missing." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const encryptionKey = Deno.env.get("DRIVE_TOKEN_ENCRYPTION_KEY")!;
    const refreshToken = await decryptText(connection.refresh_token_encrypted, encryptionKey);
    const accessToken = await getAccessToken(refreshToken);

    const fileBytes = new Uint8Array(await file.arrayBuffer());
    const cleanTitle = (shot.title || "shot").replace(/[^\w\- ]+/g, "").trim();
    const driveFileName = `${cleanTitle} - ${file.name}`;

    const uploaded = await uploadFileToDrive(
      accessToken,
      project.drive_deliverables_folder_id,
      driveFileName,
      fileBytes,
      file.type
    );

    const nextDeliverables = [
      ...(Array.isArray(shot.deliverables) ? shot.deliverables : []),
      {
        name: file.name,
        url: uploaded.url,
        driveFileId: uploaded.id,
        uploadedAt: new Date().toISOString(),
      },
    ];

    await supabase.from("shots").update({ deliverables: nextDeliverables }).eq("id", shot.id);

    await supabase.from("activity_log").insert({
      user_id: shot.user_id,
      project_id: shot.project_id,
      shot_id: shot.id,
      event_type: "freelancer_upload",
      description: `${shot.assigned_to || "A freelancer"} uploaded "${file.name}" to Drive for ${shot.title}`,
    });

    return new Response(JSON.stringify({ success: true, url: uploaded.url }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
