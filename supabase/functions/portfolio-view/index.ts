// Public portfolio viewer data (no login).
//
//   POST {token} -> {studioName, items: [{id, kind, title, caption, mimeType, url}]}
//
// Deploy with --no-verify-jwt: the recipient has no account. Authorization is the share token,
// checked in the database (portfolio_public_get: not revoked, not expired). Media is served from a
// PRIVATE bucket through short-lived signed URLs, so a leaked URL stops working in an hour and a
// revoked link stops handing out new ones. Bad/expired/revoked tokens all return the same 404.
//
// Note: add rate limiting at the edge/WAF; the token space is large but this endpoint is anonymous.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";

const SIGNED_URL_TTL_SECONDS = 3600;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } });

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "POST") return json({ error: "Not available" }, 404);

  const body = await req.json().catch(() => ({}));
  const token = body?.token;
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return json({ error: "Not available" }, 404);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data, error } = await supabase.rpc("portfolio_public_get", { p_token: token });
  if (error || !data) return json({ error: "Not available" }, 404);

  const items: Array<Record<string, string>> = data.items ?? [];
  const paths = items.map((i) => i.storage_path);
  const urls = new Map<string, string>();
  if (paths.length) {
    const { data: signed, error: signErr } = await supabase.storage.from("portfolio").createSignedUrls(paths, SIGNED_URL_TTL_SECONDS);
    if (signErr) { console.error("portfolio signing failed:", signErr.message); return json({ error: "Not available" }, 503); }
    for (const s of signed ?? []) if (s.path && s.signedUrl) urls.set(s.path, s.signedUrl);
  }
  return json({
    studioName: data.studio_name ?? "",
    items: items
      .filter((i) => urls.has(i.storage_path))
      .map((i) => ({ id: i.id, kind: i.kind, title: i.title, caption: i.caption, mimeType: i.mime_type, url: urls.get(i.storage_path) })),
  });
});
