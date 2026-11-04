// Zoho Mail connection for KairFlow Intelligence. All decisions live here (pure, injectable) so they can be unit tested;
// the three index.ts files only wire real dependencies. Zoho details (hosts, scopes, response fields) follow Zoho's public
// REST API documentation and have NOT been exercised against a live account: confirm them on first connect.
import { corsHeaders } from "./cors.ts";
import { requireIntelligenceAdmin } from "./intel_auth.ts";

export const ZOHO_DATA_CENTERS = ["com", "eu", "in", "com.au", "jp", "ca", "sa", "com.cn"];
// Minimum scopes: list folders/accounts, read mail, send mail. Nothing else (no delete, no settings, no contacts).
export const ZOHO_SCOPES = "ZohoMail.accounts.READ,ZohoMail.folders.READ,ZohoMail.messages.READ,ZohoMail.messages.CREATE";
const STATE_TTL_MS = 10 * 60 * 1000;

export const accountsHost = (dc: string) => `https://accounts.zoho.${dc}`;
export const apiBase = (dc: string) => `https://mail.zoho.${dc}/api`;
export const isDataCenter = (dc: unknown): dc is string => typeof dc === "string" && ZOHO_DATA_CENTERS.includes(dc);

export interface Deps {
  env: (k: string) => string | undefined;
  createClient: (url: string, key: string, options?: Record<string, unknown>) => any;
  service: any;                                   // service-role client: ONLY used after the caller has been authorized
  fetch: (url: string, init?: Record<string, unknown>) => Promise<any>;
  encrypt: (s: string) => Promise<string>;
  decrypt: (s: string) => Promise<string>;
  now: () => number;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

export function buildAuthUrl(dc: string, clientId: string, redirectUri: string, state: string): string {
  const u = new URL(`${accountsHost(dc)}/oauth/v2/auth`);
  u.searchParams.set("scope", ZOHO_SCOPES);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  return u.toString();
}

/** POST, signed-in administrator only (admin AND active Master User). Returns {url} for the browser to open. */
export async function handleConnect(req: Request, deps: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const auth = await requireIntelligenceAdmin(req, { createClient: deps.createClient, url: deps.env("SUPABASE_URL"), anonKey: deps.env("SUPABASE_ANON_KEY") });
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  let body: any = {};
  try { body = await req.json(); } catch { /* empty body: validated below */ }
  if (!isDataCenter(body?.data_center)) return json({ error: "Unknown Zoho data center" }, 400);
  const clientId = deps.env("ZOHO_CLIENT_ID"), redirectUri = deps.env("ZOHO_REDIRECT_URI");
  if (!clientId || !redirectUri) return json({ error: "Zoho is not configured on the server" }, 500);

  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const user = deps.createClient(deps.env("SUPABASE_URL")!, deps.env("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false } });
  const { data: org, error } = await user.rpc("intel_admin_org");
  if (error || !org) return json({ error: "KairFlow Intelligence is restricted." }, 403);
  const { data: row, error: insErr } = await deps.service.from("intel_oauth_states")
    .insert({ organization_id: org, user_id: auth.userId, data_center: body.data_center }).select("state").single();
  if (insErr || !row) return json({ error: "Could not start the connection" }, 500);
  return json({ url: buildAuthUrl(body.data_center, clientId, redirectUri, row.state) });
}

/** GET from Zoho's redirect. Trust comes ONLY from the single-use state row created by handleConnect. */
export async function handleCallback(req: Request, deps: Deps): Promise<Response> {
  const app = deps.env("APP_URL") || "/";
  const back = (flag: string) => Response.redirect(`${app}${app.includes("?") ? "&" : "?"}intelligence=${flag}`, 302);
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code"), state = url.searchParams.get("state") || "";
    if (!code || !/^[0-9a-f-]{36}$/i.test(state)) return new Response("Missing or invalid code or state", { status: 400 });

    const { data: st } = await deps.service.from("intel_oauth_states").select("organization_id,user_id,data_center,provider,created_at,used_at").eq("state", state).maybeSingle();
    if (!st || (st.provider ?? "zoho") !== "zoho" || st.used_at || deps.now() - new Date(st.created_at).getTime() > STATE_TTL_MS || !isDataCenter(st.data_center)) {
      return new Response("This connection attempt has expired or was already used. Go back to Intelligence settings and try again.", { status: 401 });
    }
    const { data: claimed } = await deps.service.from("intel_oauth_states").update({ used_at: new Date(deps.now()).toISOString() }).eq("state", state).is("used_at", null).select("state").maybeSingle();
    if (!claimed) return new Response("This connection attempt was already used.", { status: 401 });

    // The person who started it must STILL be authorized, or nothing is stored.
    const { data: ok } = await deps.service.rpc("intel_is_authorized_user", { p_user_id: st.user_id, p_organization_id: st.organization_id });
    if (ok !== true) return back("zoho_denied");

    const form = new URLSearchParams({ grant_type: "authorization_code", code, client_id: deps.env("ZOHO_CLIENT_ID")!, client_secret: deps.env("ZOHO_CLIENT_SECRET")!, redirect_uri: deps.env("ZOHO_REDIRECT_URI")! });
    const tr = await deps.fetch(`${accountsHost(st.data_center)}/oauth/v2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
    const tok = await tr.json().catch(() => ({}));
    if (!tr.ok || !tok.refresh_token) return back("zoho_error");

    const ar = await deps.fetch(`${apiBase(st.data_center)}/accounts`, { headers: { Authorization: `Zoho-oauthtoken ${tok.access_token}`, Accept: "application/json" } });
    const accounts = (await ar.json().catch(() => ({})))?.data;
    const acct = Array.isArray(accounts) ? accounts[0] : null;
    if (!ar.ok || !acct?.accountId) return back("zoho_error");

    await deps.service.from("intel_mail_account").upsert({
      organization_id: st.organization_id, provider: "zoho", data_center: st.data_center, account_id: String(acct.accountId),
      mailbox: String(acct.primaryEmailAddress || acct.mailboxAddress || acct.emailAddress || ""), scope: ZOHO_SCOPES,
      refresh_token_enc: await deps.encrypt(tok.refresh_token), status: "connected", last_error: "", connected_at: new Date(deps.now()).toISOString(),
    });
    return back("zoho_connected");
  } catch {
    return back("zoho_error");   // never echo internals (or tokens) to the browser
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
  const { data: acct } = await deps.service.from("intel_mail_account").select("provider,data_center,account_id,refresh_token_enc,status").eq("organization_id", s.organization_id).maybeSingle();
  if (acct && (acct.provider ?? "zoho") !== "zoho") return json({ error: "Zoho is not the connected mailbox" }, 409);
  if (!acct || acct.status === "disconnected" || !acct.refresh_token_enc || !isDataCenter(acct.data_center)) return json({ error: "Zoho is not connected" }, 409);

  let refresh: string;
  try { refresh = await deps.decrypt(acct.refresh_token_enc); } catch { return json({ error: "Stored connection is unreadable; reconnect Zoho" }, 409); }
  const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: deps.env("ZOHO_CLIENT_ID")!, client_secret: deps.env("ZOHO_CLIENT_SECRET")! });
  const tr = await deps.fetch(`${accountsHost(acct.data_center)}/oauth/v2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
  const tok = await tr.json().catch(() => ({}));
  if (!tr.ok || !tok.access_token) {
    const bad = tr.status >= 400 && tr.status < 500;
    await deps.service.from("intel_mail_account").update(bad ? { status: "error", last_error: "Zoho refused the stored connection; reconnect Zoho Mail." } : { last_error: "Zoho was temporarily unreachable." }).eq("organization_id", s.organization_id);
    return json({ error: "Zoho token refresh failed" }, bad ? 409 : 503);
  }
  return json({ access_token: tok.access_token, expires_in: Number(tok.expires_in || 3600), api_base: apiBase(acct.data_center), account_id: acct.account_id });
}
