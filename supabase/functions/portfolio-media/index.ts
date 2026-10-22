// Streams portfolio media from Google Drive, or, for items not yet moved to Drive, from the private legacy
// 'portfolio' Storage bucket. BOTH are streamed through this function; no Storage signed URL is ever issued.
//
//   GET ?t=<ticket>   (Range supported)
//
// Deploy with --no-verify-jwt: <img>/<video> can't send an Authorization header and public viewers have no
// account. Authorization = a signed, short-lived ticket PLUS a live database check on every request, so a
// revoked/expired link or deleted item is refused on the next request. (A response that is already streaming
// finishes; ranged responses are capped at 16 MB, so players re-authorize at least that often.)
// Required secrets: DOWNLOAD_SIGNING_KEY, DRIVE_TOKEN_ENCRYPTION_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
// (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are provided by the platform).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { decryptText } from "../_shared/crypto.ts";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { fetchDriveFileStream, getAccessToken } from "../_shared/google.ts";
import { verifyMediaTicket } from "../_shared/portfolio/ticket.ts";
import { effectiveRange } from "../_shared/portfolio/range.ts";
import { legacyStorageUrl, serveMedia } from "../_shared/portfolio/stream.ts";

const FULL_RESPONSE_MAX_BYTES = 64 * 1024 * 1024; // an un-ranged request for a video larger than this is answered as its first RANGE_CAP_BYTES (206)
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
  if (tokenCache.size >= 500) for (const [k, v] of tokenCache) if (Date.now() - v.at > 45 * 60_000) tokenCache.delete(k);   // keep the per-isolate cache bounded
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

    const size = Number(item.size_bytes);
    const range = effectiveRange(req.headers.get("Range"), size, RANGE_CAP_BYTES, FULL_RESPONSE_MAX_BYTES, item.kind === "video");
    const common = { size, mimeType: item.mime_type as string | null, range, baseHeaders: corsHeaders };

    // Items uploaded before the Drive migration: stream the private Storage object through this function
    // (service role, Range forwarded) instead of redirecting to a signed URL that would outlive a revoked link.
    if (!item.drive_file_id) {
      const url = legacyStorageUrl(Deno.env.get("SUPABASE_URL")!, item.user_id, item.storage_path);
      if (!url) return json({ error: "file_missing" }, 404);
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      return await serveMedia({ ...common, fetchUpstream: (r, signal) => fetch(url, { signal, headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey, "Accept-Encoding": "identity", ...(r ? { Range: r } : {}) } }) });
    }

    let token = await accessTokenFor(db, item.user_id);
    if (!token) return json({ error: "drive_not_connected" }, 503);
    return await serveMedia({
      ...common,
      fetchUpstream: async (r, signal) => {
        let res = await fetchDriveFileStream(token!, item.drive_file_id, r, signal);
        if (res.status === 401) {
          void res.body?.cancel();
          token = await accessTokenFor(db, item.user_id, true);
          if (token) res = await fetchDriveFileStream(token, item.drive_file_id, r, signal);
        }
        return res;
      },
    });
  } catch (err) {
    console.error("portfolio-media error:", err instanceof Error ? err.message : String(err));
    return json({ error: "server_error" }, 500);
  }
});
