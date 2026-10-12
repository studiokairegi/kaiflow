// Secure client download of a RELEASED final file.
//
//   POST {token, shotId, versionId}  -> {url, expiresAt}   (60s signed ticket)
//   GET  ?ticket=...                 -> streams the file
//
// Deploy with --no-verify-jwt (a browser navigation can't send an auth header;
// authorization is the project share token at POST time + the signed ticket,
// and the database is re-checked on every GET).
//
// Required secret: DOWNLOAD_SIGNING_KEY (any long random string).
//
// What a client can NEVER get here: raw freelancer submissions, unreleased or
// withdrawn/superseded finals, or any file belonging to another project. The
// Drive file id is never sent to the browser.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { decryptText } from "../_shared/crypto.ts";
import { getAccessToken, fetchDriveFileStream } from "../_shared/google.ts";
import { signTicket, verifyTicket } from "../_shared/download_ticket.ts";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";

const TICKET_TTL_SECONDS = 60;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeFileName(name: string): string {
  return (name || "download").replace(/[\r\n"\\/]+/g, "_").slice(0, 180);
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;

  const signingKey = Deno.env.get("DOWNLOAD_SIGNING_KEY");
  if (!signingKey) {
    console.error("DOWNLOAD_SIGNING_KEY is not set");
    return json({ error: "Downloads aren't configured yet." }, 503);
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    // ---- Issue a ticket -------------------------------------------------
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const { token, shotId, versionId } = body ?? {};
      if (typeof token !== "string" || !UUID.test(shotId || "") || !UUID.test(versionId || "")) {
        return json({ error: "Not available" }, 404);
      }
      const { data, error } = await supabase.rpc("authorize_client_download", {
        p_token: token,
        p_shot_id: shotId,
        p_version_id: versionId,
      });
      // Same response for bad token, wrong cut, unreleased, withdrawn: no probing.
      if (error || !data) return json({ error: "Not available" }, 404);

      const exp = Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS;
      const ticket = await signTicket({ v: versionId, s: shotId, exp }, signingKey);
      const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/client-final-download?ticket=${encodeURIComponent(ticket)}`;
      return json({ url, expiresAt: new Date(exp * 1000).toISOString() });
    }

    // ---- Stream the file ------------------------------------------------
    if (req.method === "GET") {
      const ticket = new URL(req.url).searchParams.get("ticket") || "";
      const payload = await verifyTicket(ticket, signingKey);
      if (!payload) return json({ error: "This download link is invalid or has expired." }, 403);

      // Live re-check: withdrawal / supersession / sharing-off apply immediately.
      const { data: file, error } = await supabase.rpc("authorize_released_file", {
        p_version_id: payload.v,
        p_shot_id: payload.s,
      });
      if (error || !file) return json({ error: "This file is no longer available." }, 403);

      const { data: connection } = await supabase
        .from("google_drive_connections")
        .select("refresh_token_encrypted")
        .eq("user_id", file.userId)
        .maybeSingle();
      if (!connection) return json({ error: "This file is temporarily unavailable." }, 503);

      const refreshToken = await decryptText(connection.refresh_token_encrypted, Deno.env.get("DRIVE_TOKEN_ENCRYPTION_KEY")!);
      const accessToken = await getAccessToken(refreshToken);
      const driveRes = await fetchDriveFileStream(accessToken, file.driveFileId);
      if (!driveRes.ok || !driveRes.body) {
        return json({ error: "This file is temporarily unavailable." }, 502);
      }

      // We only know the download STARTED (we began streaming); we cannot see
      // whether the browser finished it, so the event says exactly that.
      await supabase.from("activity_log").insert({
        user_id: file.userId,
        project_id: file.projectId,
        shot_id: file.shotId,
        event_type: "client_download_started",
        description: `Client started downloading v${file.version} (${file.fileName})`,
        audience: "internal",
        meta: { versionId: file.versionId },
      });

      const headers: Record<string, string> = {
        ...corsHeaders,
        "Content-Type": file.mimeType || driveRes.headers.get("Content-Type") || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${safeFileName(file.fileName)}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      };
      const len = driveRes.headers.get("Content-Length");
      if (len) headers["Content-Length"] = len;
      return new Response(driveRes.body, { status: 200, headers });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    console.error("client-final-download error:", err instanceof Error ? err.message : String(err));
    return json({ error: "Something went wrong." }, 500);
  }
});
