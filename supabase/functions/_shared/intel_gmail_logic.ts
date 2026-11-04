// Gmail connection for KairFlow Intelligence (free alternative to Zoho Mail). Same shape as intel_zoho_logic.ts: every decision is
// pure and injectable so it can be unit tested; the three index.ts files only wire real dependencies.
// NOT exercised against a live Google account. Google specifics (hosts, scopes, response fields) follow Google's public OAuth/Gmail docs.
import { corsHeaders } from "./cors.ts";
import { requireIntelligenceAdmin } from "./intel_auth.ts";
import type { Deps } from "./intel_zoho_logic.ts";

export type { Deps };
// Least privilege that still lets the agent send and read replies. gmail.readonly is a "restricted" scope: for ONE personal account an
// unverified app is allowed (publish the consent screen to "In production" so refresh tokens do not expire after 7 days).
export const GMAIL_SCOPE_LIST = ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.readonly"];
export const GMAIL_SCOPES = GMAIL_SCOPE_LIST.join(" ");
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";
const STATE_TTL_MS = 10 * 60 * 1000;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

export function buildAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const u = new URL(GOOGLE_AUTH_URL);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GMAIL_SCOPES);
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");               // makes Google return a refresh token every time
  u.searchParams.set("include_granted_scopes", "false"); // never widen to scopes granted to other apps
  u.searchParams.set("state", state);
  return u.toString();
}

/** True only when Google confirms BOTH scopes were granted (people can untick one on the consent screen). */
export const hasAllScopes = (granted: unknown): boolean => {
  const set = new Set(String(granted || "").split(/\s+/).filter(Boolean));
  return GMAIL_SCOPE_LIST.every((s) => set.has(s));
};

/** POST, signed-in administrator only (admin AND active Master User). Returns {url} for the browser to open. */
export async function handleConnect(req: Request, deps: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const auth = await requireIntelligenceAdmin(req, { createClient: deps.createClient, url: deps.env("SUPABASE_URL"), anonKey: deps.env("SUPABASE_ANON_KEY") });
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  const clientId = deps.env("GOOGLE_CLIENT_ID"), redirectUri = deps.env("GOOGLE_REDIRECT_URI");
  if (!clientId || !redirectUri) return json({ error: "Gmail is not configured on the server" }, 500);
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const user = deps.createClient(deps.env("SUPABASE_URL")!, deps.env("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false } });
  const { data: org, error } = await user.rpc("intel_admin_org");
  if (error || !org) return json({ error: "KairFlow Intelligence is restricted." }, 403);
  const { data: row, error: insErr } = await deps.service.from("intel_oauth_states")
    .insert({ organization_id: org, user_id: auth.userId, data_center: "google", provider: "gmail" }).select("state").single();
  if (insErr || !row) return json({ error: "Could not start the connection" }, 500);
  return json({ url: buildAuthUrl(clientId, redirectUri, row.state) });
}

/** GET from Google's redirect. Trust comes ONLY from the single-use Gmail state row created by handleConnect. */
export async function handleCallback(req: Request, deps: Deps): Promise<Response> {
  const app = deps.env("APP_URL") || "/";
  const back = (flag: string) => Response.redirect(`${app}${app.includes("?") ? "&" : "?"}intelligence=${flag}`, 302);
  try {
    const url = new URL(req.url);
    if (url.searchParams.get("error")) return back("gmail_cancelled");
    const code = url.searchParams.get("code"), state = url.searchParams.get("state") || "";
    if (!code || !/^[0-9a-f-]{36}$/i.test(state)) return new Response("Missing or invalid code or state", { status: 400 });

    const { data: st } = await deps.service.from("intel_oauth_states").select("organization_id,user_id,data_center,provider,created_at,used_at").eq("state", state).maybeSingle();
    if (!st || st.provider !== "gmail" || st.used_at || deps.now() - new Date(st.created_at).getTime() > STATE_TTL_MS) {
      return new Response("This connection attempt has expired or was already used. Go back to Intelligence settings and try again.", { status: 401 });
    }
    const { data: claimed } = await deps.service.from("intel_oauth_states").update({ used_at: new Date(deps.now()).toISOString() }).eq("state", state).is("used_at", null).select("state").maybeSingle();
    if (!claimed) return new Response("This connection attempt was already used.", { status: 401 });

    // The person who started it must STILL be authorized, or nothing is stored.
    const { data: ok } = await deps.service.rpc("intel_is_authorized_user", { p_user_id: st.user_id, p_organization_id: st.organization_id });
    if (ok !== true) return back("gmail_denied");

    const form = new URLSearchParams({ grant_type: "authorization_code", code, client_id: deps.env("GOOGLE_CLIENT_ID")!, client_secret: deps.env("GOOGLE_CLIENT_SECRET")!, redirect_uri: deps.env("GOOGLE_REDIRECT_URI")! });
    const tr = await deps.fetch(GOOGLE_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
    const tok = await tr.json().catch(() => ({}));
    if (!tr.ok || !tok.refresh_token || !tok.access_token) return back("gmail_error");
    if (!hasAllScopes(tok.scope)) return back("gmail_scope");     // nothing is stored unless send AND read were both allowed

    const pr = await deps.fetch(`${GMAIL_API_BASE}/users/me/profile`, { headers: { Authorization: `Bearer ${tok.access_token}`, Accept: "application/json" } });
    const profile = await pr.json().catch(() => ({}));
    if (!pr.ok || !profile?.emailAddress) return back("gmail_error");

    await deps.service.from("intel_mail_account").upsert({
      organization_id: st.organization_id, provider: "gmail", data_center: "google", account_id: "me", mailbox: String(profile.emailAddress).toLowerCase(),
      scope: GMAIL_SCOPES, refresh_token_enc: await deps.encrypt(tok.refresh_token), status: "connected", last_error: "", connected_at: new Date(deps.now()).toISOString(),
    });
    return back("gmail_connected");
  } catch {
    return back("gmail_error");   // never echo internals (or tokens) to the browser
  }
}

/** POST. Callable ONLY by the registered agent identity. Returns a short-lived access token; the refresh token never leaves the server. */
export async function handleToken(req: Request, deps: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("Authorization") || "");
  if (!m) return json({ error: "Not authenticated" }, 401);
  const anon = deps.createClient(deps.env("SUPABASE_URL")!, deps.env("SUPABASE_ANON_KEY")!, { auth: { persistSession: false } });
  const { data: u, error } = await anon.auth.getUser(m[1]);
  const uid = u?.user?.id;
  if (error || !uid) return json({ error: "Not authenticated" }, 401);

  const { data: s } = await deps.service.from("intel_settings").select("organization_id,agent_user_id,kill_switch").eq("agent_user_id", uid).maybeSingle();
  if (!s || s.agent_user_id !== uid) return json({ error: "Not allowed" }, 403);     // admins and everyone else are refused here too
  const { data: acct } = await deps.service.from("intel_mail_account").select("provider,mailbox,refresh_token_enc,status").eq("organization_id", s.organization_id).maybeSingle();
  if (!acct || acct.provider !== "gmail") return json({ error: "Gmail is not the connected mailbox" }, 409);
  if (acct.status === "disconnected" || !acct.refresh_token_enc) return json({ error: "Gmail is not connected" }, 409);

  let refresh: string;
  try { refresh = await deps.decrypt(acct.refresh_token_enc); } catch { return json({ error: "Stored connection is unreadable; reconnect Gmail" }, 409); }
  const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: deps.env("GOOGLE_CLIENT_ID")!, client_secret: deps.env("GOOGLE_CLIENT_SECRET")! });
  const tr = await deps.fetch(GOOGLE_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
  const tok = await tr.json().catch(() => ({}));
  if (!tr.ok || !tok.access_token) {
    const revoked = tr.status === 400 && tok?.error === "invalid_grant";
    const bad = tr.status >= 400 && tr.status < 500;
    const why = revoked
      ? "Google revoked the Gmail connection (password changed, access removed, unused for 6 months, or the Google app is still in Testing mode where tokens last 7 days). Reconnect Gmail."
      : "Google refused the stored connection; reconnect Gmail.";
    await deps.service.from("intel_mail_account").update(bad ? { status: "error", last_error: why } : { last_error: "Google was temporarily unreachable." }).eq("organization_id", s.organization_id);
    return json({ error: "Gmail token refresh failed" }, bad ? 409 : 503);
  }
  return json({ access_token: tok.access_token, expires_in: Number(tok.expires_in || 3600), api_base: GMAIL_API_BASE, account_id: "me", mailbox: acct.mailbox });
}
