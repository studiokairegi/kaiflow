import test from "node:test";
import assert from "node:assert/strict";
import { handleCallback, handleConnect, handleToken, buildAuthUrl, hasAllScopes, GMAIL_SCOPES, GMAIL_SCOPE_LIST } from "../../supabase/functions/_shared/intel_gmail_logic.ts";
import { handleToken as zohoToken } from "../../supabase/functions/_shared/intel_zoho_logic.ts";

const ORG = "20000000-0000-0000-0000-00000000000a";
const STATE = "11111111-1111-1111-1111-111111111111";

function makeService(tables, rpcs = {}) {
  const from = (t) => {
    tables[t] ||= [];
    let filters = [], op = "select", patch = null;
    const match = (r) => filters.every((f) => f(r));
    const run = () => {
      if (op === "insert") { const row = { state: STATE, used_at: null, created_at: new Date().toISOString(), ...patch }; tables[t].push(row); return { data: row, error: null }; }
      if (op === "upsert") { const i = tables[t].findIndex((r) => r.organization_id === patch.organization_id); if (i >= 0) Object.assign(tables[t][i], patch); else tables[t].push({ ...patch }); return { data: patch, error: null }; }
      const row = tables[t].find(match);
      if (op === "update" && row) Object.assign(row, patch);
      return { data: row || null, error: null };
    };
    const api = {
      select() { return api; }, insert(v) { op = "insert"; patch = v; return api; }, update(v) { op = "update"; patch = v; return api; }, upsert(v) { op = "upsert"; patch = v; return api; },
      eq(k, v) { filters.push((r) => r[k] === v); return api; }, is(k, v) { filters.push((r) => (r[k] ?? null) === v); return api; },
      maybeSingle: async () => run(), single: async () => run(), then: (res, rej) => Promise.resolve(run()).then(res, rej),
    };
    return api;
  };
  return { from, rpc: async (name, args) => ({ data: rpcs[name] ? rpcs[name](args) : null, error: null }) };
}
const USERS = { admin: "u-admin", agent: "u-agent", master: "u-master" };
const createClient = (url, key, opts) => {
  const jwt = (opts?.global?.headers?.Authorization || "").replace(/^Bearer /, "");
  return {
    auth: { getUser: async (j) => (USERS[j || jwt] ? { data: { user: { id: USERS[j || jwt] } }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
    rpc: async (name) => (name === "intel_is_authorized" ? { data: jwt === "admin", error: null } : name === "intel_admin_org" ? { data: jwt === "admin" ? ORG : null, error: null } : { data: null, error: { message: "nope" } }),
  };
};
const GRANTED = GMAIL_SCOPE_LIST.join(" ");
const googleFetch = (over = {}) => async (url) => {
  if (String(url).includes("oauth2.googleapis.com/token")) return over.token || { ok: true, status: 200, json: async () => ({ access_token: "ACCESS", expires_in: 3599, refresh_token: "NEWREFRESH", scope: GRANTED }) };
  if (String(url).includes("/users/me/profile")) return over.profile || { ok: true, status: 200, json: async () => ({ emailAddress: "Studio.Outreach@Gmail.com" }) };
  return { ok: false, status: 404, json: async () => ({}) };
};
const mk = (over = {}) => {
  const fetchLog = [];
  const tables = {
    intel_settings: [{ organization_id: ORG, agent_user_id: USERS.agent, kill_switch: true }],
    intel_mail_account: over.account === undefined ? [{ organization_id: ORG, provider: "gmail", mailbox: "studio@gmail.com", refresh_token_enc: "enc:REFRESH", status: "connected" }] : over.account,
    intel_oauth_states: over.states ?? [],
  };
  const f = over.fetch || googleFetch();
  const deps = {
    env: (k) => ({ SUPABASE_URL: "https://p.supabase.co", SUPABASE_ANON_KEY: "anon", GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec", GOOGLE_REDIRECT_URI: "https://p.supabase.co/functions/v1/intel-gmail-callback", APP_URL: "https://app.test", ...(over.env || {}) })[k],
    createClient, service: makeService(tables, { intel_is_authorized_user: () => over.authorized ?? true }),
    fetch: async (url, init) => { fetchLog.push({ url: String(url), init }); return f(url, init); },
    encrypt: async (s) => "enc:" + s, decrypt: async (s) => s.replace(/^enc:/, ""), now: () => Date.now(),
  };
  return { deps, tables, fetchLog };
};
const req = (path, { jwt, body, method = "POST" } = {}) => new Request("https://x.test" + path, { method, headers: jwt ? { Authorization: `Bearer ${jwt}` } : {}, body: method === "GET" ? undefined : JSON.stringify(body || {}) });
const freshState = (over = {}) => ({ state: STATE, organization_id: ORG, user_id: USERS.admin, data_center: "google", provider: "gmail", created_at: new Date().toISOString(), used_at: null, ...over });

test("consent URL asks for send and read only, offline, and never widens scope", () => {
  const u = new URL(buildAuthUrl("cid", "https://r.test/cb", STATE));
  assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(u.searchParams.get("scope"), GMAIL_SCOPES); assert.equal(u.searchParams.get("access_type"), "offline"); assert.equal(u.searchParams.get("prompt"), "consent");
  assert.equal(u.searchParams.get("include_granted_scopes"), "false"); assert.equal(u.searchParams.get("state"), STATE);
  assert.deepEqual(GMAIL_SCOPE_LIST, ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.readonly"]);
  assert.ok(!GMAIL_SCOPES.includes("mail.google.com") && !/modify|compose|settings|full/.test(GMAIL_SCOPES), "no delete/modify/settings scopes");
});

test("scope check needs BOTH permissions", () => {
  assert.ok(hasAllScopes(GRANTED)); assert.ok(!hasAllScopes(GMAIL_SCOPE_LIST[0])); assert.ok(!hasAllScopes(GMAIL_SCOPE_LIST[1])); assert.ok(!hasAllScopes("")); assert.ok(!hasAllScopes(undefined));
});

test("connect: only an authorized administrator can start it, and it records a Gmail state", async () => {
  const { deps, tables } = mk();
  const ok = await handleConnect(req("/c", { jwt: "admin" }), deps);
  assert.equal(ok.status, 200); assert.match((await ok.json()).url, /^https:\/\/accounts\.google\.com\//);
  assert.deepEqual([tables.intel_oauth_states[0].provider, tables.intel_oauth_states[0].data_center, tables.intel_oauth_states[0].user_id], ["gmail", "google", USERS.admin]);
  for (const jwt of ["master", "agent", "nobody", undefined]) { const r = await handleConnect(req("/c", { jwt }), mk().deps); assert.ok([401, 403].includes(r.status), `${jwt} -> ${r.status}`); }
  assert.equal((await handleConnect(req("/c", { jwt: "admin" }), mk({ env: { GOOGLE_CLIENT_ID: "" } }).deps)).status, 500);
});

test("callback: stores an encrypted refresh token and the lower-cased mailbox, then the state is used up", async () => {
  const { deps, tables } = mk({ account: [], states: [freshState()] });
  const res = await handleCallback(req(`/cb?code=abc&state=${STATE}`, { method: "GET" }), deps);
  assert.equal(res.headers.get("location"), "https://app.test/?intelligence=gmail_connected");
  const a = tables.intel_mail_account[0];
  assert.deepEqual([a.provider, a.data_center, a.mailbox, a.status, a.refresh_token_enc], ["gmail", "google", "studio.outreach@gmail.com", "connected", "enc:NEWREFRESH"]);
  assert.ok(!JSON.stringify(res.headers).includes("REFRESH"));
  const again = await handleCallback(req(`/cb?code=abc&state=${STATE}`, { method: "GET" }), deps);
  assert.equal(again.status, 401);
});

test("callback: nothing is stored when the state is wrong, expired, a Zoho state, or the person lost access", async () => {
  const cases = [
    ["unknown state", mk({ account: [], states: [] })],
    ["zoho state", mk({ account: [], states: [freshState({ provider: "zoho", data_center: "com" })] })],
    ["expired", mk({ account: [], states: [freshState({ created_at: new Date(Date.now() - 3600_000).toISOString() })] })],
    ["already used", mk({ account: [], states: [freshState({ used_at: new Date().toISOString() })] })],
  ];
  for (const [name, { deps, tables }] of cases) {
    const r = await handleCallback(req(`/cb?code=abc&state=${STATE}`, { method: "GET" }), deps);
    assert.equal(r.status, 401, name); assert.equal(tables.intel_mail_account.length, 0, name);
  }
  const revoked = mk({ account: [], states: [freshState()], authorized: false });
  assert.equal((await handleCallback(req(`/cb?code=abc&state=${STATE}`, { method: "GET" }), revoked.deps)).headers.get("location"), "https://app.test/?intelligence=gmail_denied");
  assert.equal(revoked.tables.intel_mail_account.length, 0);
  const bad = await handleCallback(req("/cb?code=abc&state=not-a-uuid", { method: "GET" }), mk().deps); assert.equal(bad.status, 400);
});

test("callback: cancelled consent, missing scope, or a failed Google call store nothing", async () => {
  const cancel = mk({ account: [], states: [freshState()] });
  assert.equal((await handleCallback(req("/cb?error=access_denied&state=" + STATE, { method: "GET" }), cancel.deps)).headers.get("location"), "https://app.test/?intelligence=gmail_cancelled");
  const sendOnly = mk({ account: [], states: [freshState()], fetch: googleFetch({ token: { ok: true, status: 200, json: async () => ({ access_token: "A", refresh_token: "R", scope: GMAIL_SCOPE_LIST[0] }) } }) });
  assert.equal((await handleCallback(req(`/cb?code=abc&state=${STATE}`, { method: "GET" }), sendOnly.deps)).headers.get("location"), "https://app.test/?intelligence=gmail_scope");
  const noRefresh = mk({ account: [], states: [freshState()], fetch: googleFetch({ token: { ok: true, status: 200, json: async () => ({ access_token: "A", scope: GRANTED }) } }) });
  assert.equal((await handleCallback(req(`/cb?code=abc&state=${STATE}`, { method: "GET" }), noRefresh.deps)).headers.get("location"), "https://app.test/?intelligence=gmail_error");
  const noProfile = mk({ account: [], states: [freshState()], fetch: googleFetch({ profile: { ok: false, status: 403, json: async () => ({}) } }) });
  assert.equal((await handleCallback(req(`/cb?code=abc&state=${STATE}`, { method: "GET" }), noProfile.deps)).headers.get("location"), "https://app.test/?intelligence=gmail_error");
  for (const m of [cancel, sendOnly, noRefresh, noProfile]) assert.equal(m.tables.intel_mail_account.length, 0);
});

test("token: only the registered agent gets an access token, never the refresh token", async () => {
  const { deps, fetchLog } = mk();
  const res = await handleToken(req("/t", { jwt: "agent" }), deps);
  assert.equal(res.status, 200); const body = await res.json();
  assert.deepEqual([body.access_token, body.api_base, body.account_id, body.mailbox], ["ACCESS", "https://gmail.googleapis.com/gmail/v1", "me", "studio@gmail.com"]);
  assert.ok(!JSON.stringify(body).includes("REFRESH"));
  assert.match(fetchLog[0].url, /oauth2\.googleapis\.com\/token/); assert.match(fetchLog[0].init.body, /refresh_token=REFRESH/);
  for (const jwt of ["admin", "master", "stranger", undefined]) { const r = await handleToken(req("/t", { jwt }), mk().deps); assert.ok([401, 403].includes(r.status), `${jwt} -> ${r.status}`); }
});

test("token: a Zoho connection is never served by the Gmail function, and a Gmail one never by the Zoho function", async () => {
  const zohoAcct = [{ organization_id: ORG, provider: "zoho", data_center: "com", account_id: "1", refresh_token_enc: "enc:R", status: "connected" }];
  assert.equal((await handleToken(req("/t", { jwt: "agent" }), mk({ account: zohoAcct }).deps)).status, 409);
  assert.equal((await handleToken(req("/t", { jwt: "agent" }), mk({ account: [] }).deps)).status, 409);
  assert.equal((await zohoToken(req("/t", { jwt: "agent" }), mk().deps)).status, 409);
  const legacy = [{ organization_id: ORG, data_center: "com", account_id: "1", refresh_token_enc: "enc:R", status: "connected" }];   // row written before the provider column was used
  const zohoFetch = async () => ({ ok: true, status: 200, json: async () => ({ access_token: "ZA", expires_in: 3600 }) });
  assert.equal((await zohoToken(req("/t", { jwt: "agent" }), mk({ account: legacy, fetch: zohoFetch }).deps)).status, 200);
});

test("token: a revoked Google grant flags the account for reconnection without leaking anything", async () => {
  const revoked = mk({ fetch: googleFetch({ token: { ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) } }) });
  const r = await handleToken(req("/t", { jwt: "agent" }), revoked.deps);
  assert.equal(r.status, 409);
  assert.equal(revoked.tables.intel_mail_account[0].status, "error"); assert.match(revoked.tables.intel_mail_account[0].last_error, /Reconnect Gmail/);
  const down = mk({ fetch: googleFetch({ token: { ok: false, status: 503, json: async () => ({}) } }) });
  assert.equal((await handleToken(req("/t", { jwt: "agent" }), down.deps)).status, 503); assert.equal(down.tables.intel_mail_account[0].status, "connected");
  const broken = mk({ deps: {} }); broken.deps.decrypt = async () => { throw new Error("bad key"); };
  assert.equal((await handleToken(req("/t", { jwt: "agent" }), broken.deps)).status, 409);
});
