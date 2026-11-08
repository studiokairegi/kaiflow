// Provider-neutral OAuth orchestration. Provider-specific protocol details live in the
// adapter registry below; database manifests are descriptive and never execute code.
import { corsHeaders } from "./cors.ts";
import { requireIntelligenceAdmin } from "./intel_auth.ts";
import { GMAIL_SCOPE_LIST, GMAIL_SCOPES, GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL, GMAIL_API_BASE, hasAllScopes } from "./intel_gmail_logic.ts";
import { ZOHO_DATA_CENTERS, ZOHO_SCOPES, accountsHost as zohoAccountsHost, apiBase as zohoApiBase, isDataCenter } from "./intel_zoho_logic.ts";

const STATE_TTL_MS = 10 * 60 * 1000;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

export interface ProviderOAuthDeps {
  env: (key: string) => string | undefined;
  createClient: (url: string, key: string, options?: Record<string, unknown>) => any;
  service: any;
  fetch: (url: string, init?: Record<string, unknown>) => Promise<any>;
  encrypt: (value: string) => Promise<string>;
  decrypt: (value: string) => Promise<string>;
  now: () => number;
}

interface OAuthAdapter {
  authorizationUrl(state: string, deps: ProviderOAuthDeps, metadata?: Record<string, unknown>): string;
  exchange(code: string, deps: ProviderOAuthDeps, metadata?: Record<string, unknown>): Promise<any>;
  identify(accessToken: string, deps: ProviderOAuthDeps, metadata?: Record<string, unknown>): Promise<{ mailbox: string; externalAccountId: string }>;
  refresh(refreshToken: string, deps: ProviderOAuthDeps, metadata?: Record<string, unknown>): Promise<any>;
  apiBase: string;
}

const gmailAdapter: OAuthAdapter = {
  apiBase: GMAIL_API_BASE,
  authorizationUrl(state, deps) {
    const clientId = deps.env("GOOGLE_CLIENT_ID"), redirectUri = deps.env("GOOGLE_REDIRECT_URI");
    if (!clientId || !redirectUri) throw new Error("Gmail OAuth is not configured");
    const u = new URL(GOOGLE_AUTH_URL);
    u.searchParams.set("client_id", clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", GMAIL_SCOPES);
    u.searchParams.set("access_type", "offline");
    u.searchParams.set("prompt", "consent");
    u.searchParams.set("include_granted_scopes", "false");
    u.searchParams.set("state", state);
    return u.toString();
  },
  async exchange(code, deps) {
    const form = new URLSearchParams({ grant_type: "authorization_code", code,
      client_id: deps.env("GOOGLE_CLIENT_ID")!, client_secret: deps.env("GOOGLE_CLIENT_SECRET")!,
      redirect_uri: deps.env("GOOGLE_REDIRECT_URI")! });
    const response = await deps.fetch(GOOGLE_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token || !data.refresh_token || !hasAllScopes(data.scope)) throw new Error("Gmail authorization did not grant the required offline send/read scopes");
    return data;
  },
  async identify(accessToken, deps) {
    const response = await deps.fetch(`${GMAIL_API_BASE}/users/me/profile`, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
    const profile = await response.json().catch(() => ({}));
    if (!response.ok || !profile.emailAddress) throw new Error("Could not verify the Gmail mailbox identity");
    return { mailbox: String(profile.emailAddress).trim().toLowerCase(), externalAccountId: "me" };
  },
  async refresh(refreshToken, deps) {
    const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken,
      client_id: deps.env("GOOGLE_CLIENT_ID")!, client_secret: deps.env("GOOGLE_CLIENT_SECRET")! });
    const response = await deps.fetch(GOOGLE_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok && !!data.access_token, status: response.status, data };
  },
};

const zohoAdapter: OAuthAdapter = {
  get apiBase() { return ""; },
  authorizationUrl(state, deps, metadata = {}) {
    const dc = metadata.data_center;
    const clientId = deps.env("ZOHO_CLIENT_ID"), redirectUri = deps.env("ZOHO_REDIRECT_URI");
    if (!isDataCenter(dc) || !clientId || !redirectUri) throw new Error("Zoho OAuth is not configured for this data center");
    const u = new URL(`${zohoAccountsHost(dc)}/oauth/v2/auth`);
    u.searchParams.set("scope", ZOHO_SCOPES); u.searchParams.set("client_id", clientId);
    u.searchParams.set("response_type", "code"); u.searchParams.set("access_type", "offline");
    u.searchParams.set("prompt", "consent"); u.searchParams.set("redirect_uri", redirectUri); u.searchParams.set("state", state);
    return u.toString();
  },
  async exchange(code, deps, metadata = {}) {
    const dc = metadata.data_center;
    if (!isDataCenter(dc)) throw new Error("Invalid Zoho data center");
    const form = new URLSearchParams({ grant_type: "authorization_code", code, client_id: deps.env("ZOHO_CLIENT_ID")!, client_secret: deps.env("ZOHO_CLIENT_SECRET")!, redirect_uri: deps.env("ZOHO_REDIRECT_URI")! });
    const response = await deps.fetch(`${zohoAccountsHost(dc)}/oauth/v2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token || !data.refresh_token) throw new Error("Zoho authorization did not grant offline access");
    return data;
  },
  async identify(accessToken, deps, metadata = {}) {
    const dc = metadata.data_center;
    if (!isDataCenter(dc)) throw new Error("Invalid Zoho data center");
    const response = await deps.fetch(`${zohoApiBase(dc)}/accounts`, { headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, Accept: "application/json" } });
    const rows = (await response.json().catch(() => ({})))?.data;
    const account = Array.isArray(rows) ? rows[0] : null;
    const mailbox = String(account?.primaryEmailAddress || account?.mailboxAddress || account?.emailAddress || "").trim().toLowerCase();
    if (!response.ok || !account?.accountId || !mailbox) throw new Error("Could not verify the Zoho mailbox identity");
    return { mailbox, externalAccountId: String(account.accountId) };
  },
  async refresh(refreshToken, deps, metadata = {}) {
    const dc = metadata.data_center;
    if (!isDataCenter(dc)) throw new Error("Invalid Zoho data center");
    const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: deps.env("ZOHO_CLIENT_ID")!, client_secret: deps.env("ZOHO_CLIENT_SECRET")! });
    const response = await deps.fetch(`${zohoAccountsHost(dc)}/oauth/v2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok && !!data.access_token, status: response.status, data };
  },
};

// Register reviewed OAuth implementations here. The dispatcher and UI remain provider-neutral.
const OAUTH_ADAPTERS: Record<string, OAuthAdapter> = { gmail: gmailAdapter, zoho: zohoAdapter };

export async function handleProviderConnect(req: Request, deps: ProviderOAuthDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const auth = await requireIntelligenceAdmin(req, { createClient: deps.createClient, url: deps.env("SUPABASE_URL"), anonKey: deps.env("SUPABASE_ANON_KEY") });
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }
  const providerKey = String(body?.provider_key || "").trim().toLowerCase();
  const adapter = OAUTH_ADAPTERS[providerKey];
  if (!adapter) return json({ error: "No reviewed OAuth adapter is installed for this provider" }, 400);

  const metadata: Record<string, unknown> = {};
  if (providerKey === "zoho") { const dc = body?.data_center; if (!isDataCenter(dc)) return json({ error: "Unknown Zoho data center" }, 400); metadata.data_center = dc; }

  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const user = deps.createClient(deps.env("SUPABASE_URL")!, deps.env("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false } });
  const { data: org, error: orgError } = await user.rpc("intel_admin_org");
  if (orgError || !org) return json({ error: "KairFlow Intelligence is restricted." }, 403);
  const { data: provider, error: providerError } = await deps.service.from("intel_email_provider_registry")
    .select("provider_key,enabled").eq("provider_key", providerKey).maybeSingle();
  if (providerError || !provider?.enabled) return json({ error: "Provider is not enabled in the server-side catalogue" }, 409);

  const { data: state, error } = await deps.service.from("intel_provider_oauth_states")
    .insert({ organization_id: org, user_id: auth.userId, provider_key: providerKey, metadata })
    .select("state").single();
  if (error || !state) return json({ error: "Could not start the provider connection" }, 500);
  try { return json({ url: adapter.authorizationUrl(state.state, deps, metadata) }); }
  catch { return json({ error: "Provider OAuth is not configured on the server" }, 500); }
}

export async function handleProviderCallback(req: Request, deps: ProviderOAuthDeps): Promise<Response> {
  const app = deps.env("APP_URL") || "/";
  const back = (flag: string) => Response.redirect(`${app}${app.includes("?") ? "&" : "?"}intelligence=${flag}`, 302);
  try {
    const url = new URL(req.url);
    if (url.searchParams.get("error")) return back("provider_cancelled");
    const code = url.searchParams.get("code"), state = url.searchParams.get("state") || "";
    if (!code || !/^[0-9a-f-]{36}$/i.test(state)) return new Response("Missing or invalid code or state", { status: 400 });
    const { data: st } = await deps.service.from("intel_provider_oauth_states")
      .select("organization_id,user_id,provider_key,metadata,created_at,expires_at,used_at")
      .eq("state", state).maybeSingle();
    if (!st || st.used_at || new Date(st.expires_at).getTime() < deps.now() || deps.now() - new Date(st.created_at).getTime() > STATE_TTL_MS) {
      return new Response("This connection attempt has expired or was already used. Return to settings and try again.", { status: 401 });
    }
    const adapter = OAUTH_ADAPTERS[st.provider_key];
    if (!adapter) return back("provider_adapter_missing");
    const { data: provider } = await deps.service.from("intel_email_provider_registry")
      .select("enabled").eq("provider_key", st.provider_key).maybeSingle();
    if (!provider?.enabled) return back("provider_disabled");
    const { data: claimed } = await deps.service.from("intel_provider_oauth_states")
      .update({ used_at: new Date(deps.now()).toISOString() }).eq("state", state).is("used_at", null).select("state").maybeSingle();
    if (!claimed) return new Response("This connection attempt was already used.", { status: 401 });
    const { data: authorized } = await deps.service.rpc("intel_is_authorized_user", { p_user_id: st.user_id, p_organization_id: st.organization_id });
    if (authorized !== true) return back("provider_denied");

    const token = await adapter.exchange(code, deps, st.metadata || {});
    const identity = await adapter.identify(token.access_token, deps, st.metadata || {});
    const credentials = await deps.encrypt(JSON.stringify({ refresh_token: token.refresh_token, ...(st.metadata || {}) }));
    const { data: account, error } = await deps.service.from("intel_provider_accounts").upsert({
      organization_id: st.organization_id, provider_key: st.provider_key,
      external_account_id: identity.externalAccountId, mailbox: identity.mailbox,
      display_name: identity.mailbox, auth_method: "oauth2", scopes: st.provider_key === "zoho" ? ZOHO_SCOPES : GMAIL_SCOPE_LIST.join(" "), data_center: String(st.metadata?.data_center || ""),
      credentials_ciphertext: credentials, credential_version: 1,
      status: "connected", health_status: "unknown", is_enabled: false, send_enabled: false,
      allowed_message_purposes: ["business_correspondence"], last_error: "",
      connected_by: st.user_id, connected_at: new Date(deps.now()).toISOString(), disconnected_at: null,
    }, { onConflict: "organization_id,provider_key,mailbox" }).select("id").single();
    if (error || !account) return back("provider_save_error");
    return back("provider_connected");
  } catch {
    return back("provider_error"); // never echo OAuth codes, credentials, or provider internals to the browser
  }
}

export async function handleProviderToken(req: Request, deps: ProviderOAuthDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get("Authorization") || "");
  if (!bearer) return json({ error: "Not authenticated" }, 401);
  const anon = deps.createClient(deps.env("SUPABASE_URL")!, deps.env("SUPABASE_ANON_KEY")!, { auth: { persistSession: false } });
  const { data: user, error: authError } = await anon.auth.getUser(bearer[1]);
  const userId = user?.user?.id;
  if (authError || !userId) return json({ error: "Not authenticated" }, 401);
  const { data: settings } = await deps.service.from("intel_settings").select("organization_id,agent_user_id")
    .eq("agent_user_id", userId).maybeSingle();
  if (!settings || settings.agent_user_id !== userId) return json({ error: "Not allowed" }, 403);
  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }
  const accountId = String(body?.account_id || "");
  if (!/^[0-9a-f-]{36}$/i.test(accountId)) return json({ error: "A valid provider account id is required" }, 400);
  const { data: account } = await deps.service.from("intel_provider_accounts")
    .select("id,provider_key,external_account_id,mailbox,credentials_ciphertext,status,is_enabled,send_enabled,auth_method,data_center")
    .eq("id", accountId).eq("organization_id", settings.organization_id).maybeSingle();
  if (!account) return json({ error: "Provider account was not found" }, 404);
  const { data: providerSendingEnabled, error: providerGateError } = await deps.service.rpc("email_provider_enabled", { p_provider: account.provider_key });
  const { data: providerConfig } = await deps.service.from("intel_email_provider_registry")
    .select("enabled,sending_enabled").eq("provider_key", account.provider_key).maybeSingle();
  if (providerGateError || providerSendingEnabled !== true || !providerConfig?.enabled || !providerConfig?.sending_enabled) {
    return json({ error: "Provider sending is paused by the organization policy" }, 410);
  }
  // Fail closed until the later dispatcher/activation stage explicitly enables the account for sending.
  if (!account || account.status !== "connected" || !account.is_enabled || !account.send_enabled || !account.credentials_ciphertext) {
    return json({ error: "Provider account is not enabled for sending" }, 409);
  }
  if (account.provider_key === "smtp" && account.auth_method === "smtp_password") {
    let credentials: any;
    try { credentials = JSON.parse(await deps.decrypt(account.credentials_ciphertext)); }
    catch { return json({ error: "Stored SMTP credentials are unreadable; reconnect this account" }, 409); }
    if (!credentials.host || !credentials.port || !credentials.username || !credentials.password || !["ssl", "starttls"].includes(credentials.tls_mode))
      return json({ error: "Stored SMTP configuration is incomplete" }, 409);
    await deps.service.from("intel_provider_accounts").update({ health_status: "unknown", updated_at: new Date(deps.now()).toISOString() })
      .eq("id", account.id).eq("organization_id", settings.organization_id);
    return json({ provider: "smtp", host: credentials.host, port: credentials.port, username: credentials.username,
      password: credentials.password, tls_mode: credentials.tls_mode, mailbox: account.mailbox, expires_in: 300 });
  }
  const adapter = OAUTH_ADAPTERS[account.provider_key];
  if (!adapter) return json({ error: "Provider token adapter is not installed" }, 409);
  let credentials: any;
  try {
    const decrypted = await deps.decrypt(account.credentials_ciphertext);
    try { credentials = JSON.parse(decrypted); }
    catch { credentials = { refresh_token: decrypted }; } // one-time compatibility with migrated legacy ciphertext
  } catch { return json({ error: "Stored provider credentials are unreadable; reconnect the account" }, 409); }
  let refreshed: { ok: boolean; status: number; data: any };
  try { refreshed = await adapter.refresh(String(credentials.refresh_token || ""), deps, credentials); }
  catch {
    await deps.service.from("intel_provider_accounts").update({ health_status: "degraded", last_error: "Provider token endpoint temporarily unavailable.", updated_at: new Date(deps.now()).toISOString() })
      .eq("id", account.id).eq("organization_id", settings.organization_id);
    return json({ error: "Provider token endpoint temporarily unavailable" }, 503);
  }
  if (!refreshed.ok) {
    const bad = refreshed.status >= 400 && refreshed.status < 500;
    const invalidGrant = refreshed.status === 400 && refreshed.data?.error === "invalid_grant";
    const message = invalidGrant ? "Provider authorization was revoked; reconnect this account." : "Provider refused the stored authorization; reconnect this account.";
    await deps.service.from("intel_provider_accounts").update(bad
      ? { status: "error", health_status: "unhealthy", last_error: message, updated_at: new Date(deps.now()).toISOString() }
      : { health_status: "degraded", last_error: "Provider token endpoint temporarily unavailable.", updated_at: new Date(deps.now()).toISOString() })
      .eq("id", account.id).eq("organization_id", settings.organization_id);
    return json({ error: "Provider token refresh failed" }, bad ? 409 : 503);
  }
  await deps.service.from("intel_provider_accounts").update({ health_status: "healthy", last_health_check_at: new Date(deps.now()).toISOString(), last_error: "", updated_at: new Date(deps.now()).toISOString() })
    .eq("id", account.id).eq("organization_id", settings.organization_id);
  return json({ provider: account.provider_key, access_token: refreshed.data.access_token,
    expires_in: Number(refreshed.data.expires_in || 3600), api_base: account.provider_key === "zoho" ? zohoApiBase(String(credentials.data_center || account.data_center || "com")) : adapter.apiBase,
    external_account_id: account.external_account_id, account_id: account.external_account_id, mailbox: account.mailbox });
}
