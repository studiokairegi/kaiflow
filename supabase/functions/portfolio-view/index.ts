// Public portfolio viewer data (no login).
//
//   POST {token} -> {studioName, items: [{id, kind, title, caption, mimeType, url}]}
//
// Deploy with --no-verify-jwt: the recipient has no account. Authorization is the share token, checked in
// the database (portfolio_public_get: not revoked, not expired). Every item is returned (nothing is silently
// dropped); `url` points at portfolio-media, which streams from the studio's Google Drive (or, for items not yet
// moved, the private legacy bucket; no Storage signed URL is ever issued) and re-checks the link on EVERY
// request, so a revoked link is refused on the next request. Bad/expired/revoked tokens all return
// the same 404. Required secret: DOWNLOAD_SIGNING_KEY.
//
// Application-level IP/token rate limits are enforced before share-token lookup; add WAF limits as defense in depth.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { signMediaTicket } from "../_shared/portfolio/ticket.ts";
import { rateLimitIpHash } from "../_shared/rate_limit_identity.ts";

const TICKET_TTL_SECONDS = 2 * 3600;
const MAX_BODY_BYTES = 4096;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function readBoundedBody(req: Request): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "POST") return json({ error: "Not available" }, 404);

  const declaredLength = Number(req.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY_BYTES) return json({ error: "Not available" }, 404);
  const raw = await readBoundedBody(req);
  if (raw === null) return json({ error: "Not available" }, 404);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  // Bound anonymous token-guessing before looking up the share token. Only trust the
  // Cloudflare-injected client IP and require a strong deployment pepper.
  const ipHash = await rateLimitIpHash(req, Deno.env.get("PORTAL_HASH_PEPPER"));
  if (!ipHash) { console.error("portfolio-view rate-limit identity is not configured"); return json({ error: "Not available" }, 503); }
  const { data: rateAllowed, error: rateError } = await supabase.rpc("portal_rate_limit", {
    p_scope: "portfolio_view_ip", p_subject_hash: ipHash, p_limit: 120, p_window_seconds: 60,
  });
  if (rateError) { console.error("portfolio-view rate limit unavailable"); return json({ error: "Not available" }, 503); }
  if (rateAllowed !== true) return json({ error: "Not available" }, 429);

  let body: any;
  try { body = JSON.parse(raw); } catch { return json({ error: "Not available" }, 404); }
  const token = body?.token;
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return json({ error: "Not available" }, 404);
  const tokenHash = await sha256Hex(`portfolio-view|${token}`);
  const { data: tokenRateAllowed, error: tokenRateError } = await supabase.rpc("portal_rate_limit", {
    p_scope: "portfolio_view_token", p_subject_hash: tokenHash, p_limit: 120, p_window_seconds: 60,
  });
  if (tokenRateError) { console.error("portfolio-view token rate limit unavailable"); return json({ error: "Not available" }, 503); }
  if (tokenRateAllowed !== true) return json({ error: "Not available" }, 429);

  const key = Deno.env.get("DOWNLOAD_SIGNING_KEY");
  if (!key) { console.error("DOWNLOAD_SIGNING_KEY is not set"); return json({ error: "The portfolio isn't configured yet.", code: "not_configured" }, 503); }

  const { data, error } = await supabase.rpc("portfolio_public_get", { p_token: token });
  if (error || !data) return json({ error: "Not available" }, 404);

  const exp = Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS;
  const base = `${Deno.env.get("SUPABASE_URL")}/functions/v1/portfolio-media?t=`;
  const items = [];
  for (const i of (data.items ?? []) as Array<Record<string, string>>) {
    items.push({ id: i.id, kind: i.kind, title: i.title, caption: i.caption, mimeType: i.mime_type,
                 url: base + encodeURIComponent(await signMediaTicket({ i: i.id, l: data.link_id, u: null, exp }, key)) });
  }
  return json({ studioName: data.studio_name ?? "", items });
});
