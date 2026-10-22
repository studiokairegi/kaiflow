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
// Note: add rate limiting at the edge/WAF; the token space is large but this endpoint is anonymous.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { signMediaTicket } from "../_shared/portfolio/ticket.ts";

const TICKET_TTL_SECONDS = 2 * 3600;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } });

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "POST") return json({ error: "Not available" }, 404);

  const body = await req.json().catch(() => ({}));
  const token = body?.token;
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return json({ error: "Not available" }, 404);

  const key = Deno.env.get("DOWNLOAD_SIGNING_KEY");
  if (!key) { console.error("DOWNLOAD_SIGNING_KEY is not set"); return json({ error: "The portfolio isn't configured yet.", code: "not_configured" }, 503); }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
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
