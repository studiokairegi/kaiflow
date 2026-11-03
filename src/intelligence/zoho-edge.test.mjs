import test from "node:test";
import assert from "node:assert/strict";
import { handleCallback, handleConnect, handleToken, buildAuthUrl, isDataCenter, ZOHO_SCOPES } from "../../supabase/functions/_shared/intel_zoho_logic.ts";

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

// JWT "admin" = authorized admin; "agent" = the registered agent; "master" = Master User without admin; anything else unknown.
const USERS = { admin: "u-admin", agent: "u-agent", master: "u-master" };
const createClient = (url, key, opts) => {
  const jwt = (opts?.global?.headers?.Authorization || "").replace(/^Bearer /, "");
  return {
    auth: { getUser: async (j) => (USERS[j || jwt] ? { data: { user: { id: USERS[j || jwt] } }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
    rpc: async (name) => (name === "intel_is_authorized" ? { data: jwt === "admin", error: null } : name === "intel_admin_org" ? { data: jwt === "admin" ? ORG : null, error: null } : { data: null, error: { message: "nope" } }),
  };
};
const mk = (over = {}) => {
  const fetchLog = [];
  const tables = { intel_settings: [{ organization_id: ORG, agent_user_id: USERS.agent, kill_switch: true }], intel_mail_account: [{ organization_id: ORG, data_center: "eu", account_id: "123", refresh_token_enc: "enc:REFRESH", status: "connected" }], intel_oauth_states: [] };
  const deps = {
    env: (k) => ({ SUPABASE_URL: "https://p.supabase.co", SUPABASE_ANON_KEY: "anon", ZOHO_CLIENT_ID: "cid", ZOHO_CLIENT_SECRET: "sec", ZOHO_REDIRECT_URI: "https://p.supabase.co/functions/v1/intel-zoho-callback", APP_URL: "https://app.test" })[k],
    createClient, service: makeService(tables, { intel_is_authorized_user: () => true }),
    fetch: async (url, init) => { fetchLog.push({ url, init }); return over.fetch ? over.fetch(url, init) : { ok: true, status: 200, json: async () => ({ access_token: "ACCESS", expires_in: 3600, refresh_token: "NEWREFRESH", data: [{ accountId: 777, primaryEmailAddress: "alex@studio.test" }] }) }; },
    encrypt: async (s) => "enc:" + s, decrypt: async (s) => s.replace(/^enc:/, ""), now: () => Date.now(), ...over.deps,
  };
  return { deps, tables, fetchLog };
};
const req = (path, { jwt, body, method = "POST" } = {}) => new Request("https://x.test" + path, { method, headers: jwt ? { Authorization: `Bearer ${jwt}` } : {}, body: method === "GET" ? undefined : JSON.stringify(body || {}) });

test("helpers: data-center allowlist and consent URL", () => {
  assert.ok(isDataCenter("eu") && !isDataCenter("evil.com") && !isDataCenter("com/../x") && !isDataCenter(undefined));
  const u = new URL(buildAuthUrl("eu", "cid", "https://r.test/cb", STATE));
  assert.equal(u.origin + u.pathname, "https://accounts.zoho.eu/oauth/v2/auth");
  assert.equal(u.searchParams.get("scope"), ZOHO_SCOPES); assert.equal(u.searchParams.get("access_type"), "offline"); assert.equal(u.searchParams.get("state"), STATE);
  assert.ok(!/DELETE|UPDATE|ALL/.test(ZOHO_SCOPES), "least-privilege scopes only");
});

test("token: only the registered agent gets a token, and never the refresh token", async () => {
  const { deps, fetchLog } = mk();
  const res = await handleToken(req("/t", { jwt: "agent" }), deps);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.access_token, "ACCESS"); assert.equal(body.api_base, "https://mail.zoho.eu/api"); assert.equal(body.account_id, "123");
  assert.ok(!JSON.stringify(body).includes("REFRESH"));
  assert.match(fetchLog[0].url, /accounts\.zoho\.eu\/oauth\/v2\/token/); assert.match(fetchLog[0].init.body, /refresh_token=REFRESH/);
});

test("token: administrators, other users and anonymous callers are refused", async () => {
  for (const [jwt, status] of [["admin", 403], ["master", 403], ["stranger", 401], [undefined, 401]]) {
    const { deps, fetchLog } = mk();
    const res = await handleToken(req("/t", { jwt }), deps);
    assert.equal(res.status, status, String(jwt)); assert.equal(fetchLog.length, 0);
  }
});

test("token: disconnected or refused connection is reported without leaking details", async () => {
  const a = mk(); a.tables.intel_mail_account[0].status = "disconnected";
  assert.equal((await handleToken(req("/t", { jwt: "agent" }), a.deps)).status, 409);
  const b = mk({ fetch: async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_code" }) }) });
  const res = await handleToken(req("/t", { jwt: "agent" }), b.deps);
  assert.equal(res.status, 409); assert.equal(b.tables.intel_mail_account[0].status, "error");
  assert.ok(!(await res.text()).includes("invalid_code"));
});

test("connect: only the authorized administrator can start; bad data center rejected", async () => {
  for (const jwt of ["master", "agent", "stranger", undefined]) {
    const { deps, tables } = mk();
    const res = await handleConnect(req("/c", { jwt, body: { data_center: "com" } }), deps);
    assert.ok([401, 403].includes(res.status), String(jwt)); assert.equal(tables.intel_oauth_states.length, 0);
  }
  const { deps, tables } = mk();
  assert.equal((await handleConnect(req("/c", { jwt: "admin", body: { data_center: "evil.com" } }), deps)).status, 400);
  const ok = await handleConnect(req("/c", { jwt: "admin", body: { data_center: "jp" } }), deps);
  const { url } = await ok.json();
  assert.equal(ok.status, 200); assert.match(url, /^https:\/\/accounts\.zoho\.jp\/oauth\/v2\/auth\?/); assert.equal(tables.intel_oauth_states[0].user_id, "u-admin");
});

test("callback: stores an ENCRYPTED token once; replay, expiry and a de-authorized starter are refused", async () => {
  const fresh = () => { const m = mk(); m.tables.intel_mail_account = []; m.tables.intel_oauth_states.push({ state: STATE, organization_id: ORG, user_id: "u-admin", data_center: "eu", created_at: new Date().toISOString(), used_at: null }); return m; };
  const url = `/cb?code=abc&state=${STATE}`;

  const a = fresh();
  const res = await handleCallback(req(url, { method: "GET" }), a.deps);
  assert.equal(res.status, 302); assert.match(res.headers.get("location"), /intelligence=zoho_connected/);
  assert.equal(a.tables.intel_mail_account[0].refresh_token_enc, "enc:NEWREFRESH"); assert.equal(a.tables.intel_mail_account[0].mailbox, "alex@studio.test");
  assert.equal((await handleCallback(req(url, { method: "GET" }), a.deps)).status, 401, "replay");

  const old = fresh(); old.tables.intel_oauth_states[0].created_at = new Date(Date.now() - 11 * 60_000).toISOString();
  assert.equal((await handleCallback(req(url, { method: "GET" }), old.deps)).status, 401);

  const revoked = fresh(); revoked.deps.service = makeService(revoked.tables, { intel_is_authorized_user: () => false });
  const r = await handleCallback(req(url, { method: "GET" }), revoked.deps);
  assert.match(r.headers.get("location"), /zoho_denied/); assert.equal(revoked.tables.intel_mail_account.length, 0);

  assert.equal((await handleCallback(req("/cb?code=abc&state=not-a-uuid", { method: "GET" }), fresh().deps)).status, 400);
  const failing = fresh(); failing.deps.fetch = async () => ({ ok: false, status: 400, json: async () => ({}) });
  assert.match((await handleCallback(req(url, { method: "GET" }), failing.deps)).headers.get("location"), /zoho_error/); assert.equal(failing.tables.intel_mail_account.length, 0);
});
