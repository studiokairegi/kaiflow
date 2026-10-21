// Streams portfolio media from Google Drive (or, for not-yet-migrated items, redirects to the old bucket).
//
//   GET ?t=<ticket>   (Range supported)
//
// Deploy with --no-verify-jwt: <img>/<video> can't send an Authorization header and public viewers have no
// account. Authorization = a signed, short-lived ticket PLUS a live database check on every request, so a
// revoked/expired link or deleted item stops working immediately. Required secrets: DOWNLOAD_SIGNING_KEY,
// DRIVE_TOKEN_ENCRYPTION_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { decryptText } from "../_shared/crypto.ts";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { fetchDriveFileStream, getAccessToken } from "../_shared/google.ts";
import { verifyMediaTicket } from "../_shared/portfolio/ticket.ts";
import { parseRange } from "../_shared/portfolio/range.ts";

const RANGE_CAP_BYTES = 16 * 1024 * 1024;     // one response never streams more than this; the player asks for the next range
const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } });

// Drive access tokens last ~1h; refreshing one per Range request would add a round trip to every seek.
const tokenCache = new Map<string, { token: string; at: number }>();
async function accessTokenFor(db: ReturnType<typeof createClient>, userId: string, force = false): Promise<string | null> {
  const hit = tokenCache.get(userId);
  if (!force && hit && Date.now() - hit.at < 45 * 60_000) return hit.token;
  const { data: conn } = await db.from("google_drive_connections").select("refresh_token_encrypted").eq("user_id", userId).maybeSingle();
  if (!conn) return null;
  const token = await getAccessToken(await decryptText(conn.refresh_token_encrypted, Deno.env.get("DRIVE_TOKEN_ENCRYPTION_KEY")!));
  tokenCache.set(userId, { token, at: Date.now() });
  return token;
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const key = Deno.env.get("DOWNLOAD_SIGNING_KEY");
  if (!key) { console.error("DOWNLOAD_SIGNING_KEY is not set"); return json({ error: "not_configured" }, 503); }
  try {
    const ticket = await verifyMediaTicket(new URL(req.url).searchParams.get("t") || "", key);
    if (!ticket) return json({ error: "link_expired" }, 403);

    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: item, error } = await db.rpc("portfolio_authorize_media", { p_item: ticket.i, p_link: ticket.l, p_user: ticket.u });
    if (error || !item) return json({ error: "not_available" }, 404);

    // Items uploaded before the Drive migration: hand off to a short-lived signed URL (browsers follow it, Range included).
    if (!item.drive_file_id) {
      if (!item.storage_path) return json({ error: "file_missing" }, 404);
      const { data: signed } = await db.storage.from("portfolio").createSignedUrl(item.storage_path, 600);
      return signed?.signedUrl ? new Response(null, { status: 302, headers: { ...corsHeaders, Location: signed.signedUrl, "Cache-Control": "no-store" } }) : json({ error: "file_missing" }, 404);
    }

    const size = Number(item.size_bytes);
    const range = parseRange(req.headers.get("Range"), size, RANGE_CAP_BYTES);
    if (range.status === 416) return new Response(null, { status: 416, headers: { ...corsHeaders, "Content-Range": `bytes */${size}` } });
    const driveRange = range.status === 206 ? `bytes=${range.start}-${range.end}` : undefined;

    let token = await accessTokenFor(db, item.user_id);
    if (!token) return json({ error: "drive_not_connected" }, 503);
    let res = await fetchDriveFileStream(token, item.drive_file_id, driveRange);
    if (res.status === 401) { token = await accessTokenFor(db, item.user_id, true); if (token) res = await fetchDriveFileStream(token, item.drive_file_id, driveRange); }
    if (res.status === 404) return json({ error: "file_missing" }, 404);
    if (!res.ok && res.status !== 206) { console.error(`Drive media fetch failed: ${res.status}`); return json({ error: "drive_unavailable" }, 502); }
    if (!res.body) return json({ error: "drive_unavailable" }, 502);

    const headers: Record<string, string> = {
      ...corsHeaders,
      "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length",
      "Content-Type": item.mime_type || res.headers.get("Content-Type") || "application/octet-stream",
      "Content-Disposition": "inline",
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    };
    if (range.status === 206) {
      headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
      headers["Content-Length"] = String(range.end - range.start + 1);
      return new Response(res.body, { status: 206, headers });
    }
    const len = res.headers.get("Content-Length");
    if (len) headers["Content-Length"] = len;
    return new Response(res.body, { status: 200, headers });
  } catch (err) {
    console.error("portfolio-media error:", err instanceof Error ? err.message : String(err));
    return json({ error: "server_error" }, 500);
  }
});
