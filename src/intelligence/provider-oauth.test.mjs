import test from "node:test";
import assert from "node:assert/strict";
import { handleProviderCallback, handleProviderToken } from "../../supabase/functions/_shared/intel_provider_oauth.ts";
import { GMAIL_SCOPES, GMAIL_API_BASE } from "../../supabase/functions/_shared/intel_gmail_logic.ts";

const STATE = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-11-08T12:00:00Z");

function callbackService() {
  const saved = { account: null, stateUsed: false };
  const service = {
    from(table) {
      if (table === "intel_provider_oauth_states") return {
        select() { return this; }, eq() { return this; }, is() { return this; },
        async maybeSingle() { return { data: { organization_id: "org-1", user_id: "user-1", provider_key: "gmail",
          created_at: new Date(NOW - 1000).toISOString(), expires_at: new Date(NOW + 500000).toISOString(), used_at: null } }; },
        update(value) { saved.stateUsed = !!value.used_at; return this; },
      };
      if (table === "intel_email_provider_registry") return {
        select() { return this; }, eq() { return this; }, async maybeSingle() { return { data: { enabled: true } }; },
      };
      if (table === "intel_provider_accounts") return {
        upsert(value, opts) { saved.account = { value, opts }; return this; },
        select() { return this; }, async single() { return { data: { id: ACCOUNT }, error: null }; },
      };
      throw new Error(`unexpected table ${table}`);
    },
    async rpc(name) { assert.equal(name, "intel_is_authorized_user"); return { data: true }; },
  };
  return { service, saved };
}

test("OAuth callback consumes one-time state, rechecks authorization and stores an inactive account record", async () => {
  const { service, saved } = callbackService();
  const calls = [];
  const deps = {
    env: (k) => ({ APP_URL: "https://app.test/", GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "secret",
      GOOGLE_REDIRECT_URI: "https://project.test/functions/v1/intel-provider-callback" })[k],
    createClient: () => ({}), service,
    fetch: async (url) => {
      calls.push(url);
      if (url === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "short", refresh_token: "long",
        scope: GMAIL_SCOPES, expires_in: 3600 }), { status: 200 });
      return new Response(JSON.stringify({ emailAddress: "Studio+One@gmail.com" }), { status: 200 });
    },
    encrypt: async (value) => `enc:${value}`, decrypt: async (value) => value,
    now: () => NOW,
  };
  const req = new Request(`https://project.test/functions/v1/intel-provider-callback?code=auth-code&state=${STATE}`);
  const response = await handleProviderCallback(req, deps);
  assert.equal(response.status, 302);
  assert.match(response.headers.get("location"), /provider_connected/);
  assert.equal(saved.stateUsed, true);
  assert.equal(saved.account.value.provider_key, "gmail");
  assert.equal(saved.account.value.mailbox, "studio+one@gmail.com");
  assert.equal(saved.account.value.is_enabled, false);
  assert.equal(saved.account.value.send_enabled, false);
  assert.equal(saved.account.value.credentials_ciphertext, 'enc:{"refresh_token":"long"}');
  assert.deepEqual(calls, ["https://oauth2.googleapis.com/token", `${GMAIL_API_BASE}/users/me/profile`]);
});

function tokenService(accountOverrides = {}, providerOverrides = {}) {
  const account = { id: ACCOUNT, provider_key: "gmail", external_account_id: "me", mailbox: "studio@gmail.com",
    credentials_ciphertext: "ciphertext", status: "connected", is_enabled: true, send_enabled: true, ...accountOverrides };
  return {
    async rpc(name, args) { assert.equal(name, "email_provider_enabled"); assert.equal(args.p_provider, "gmail"); return { data: true, error: null }; },
    from(table) {
      if (table === "intel_settings") return { select() { return this; }, eq() { return this; }, async maybeSingle() { return { data: { organization_id: "org-1", agent_user_id: "agent-1" } }; } };
      if (table === "intel_provider_accounts") return {
        select() { return this; }, eq() { return this; },
        async maybeSingle() { return { data: account }; },
        update() { return this; },
      };
      if (table === "intel_email_provider_registry") return {
        select() { return this; }, eq() { return this; },
        async maybeSingle() { return { data: { enabled: true, sending_enabled: true, ...providerOverrides } }; },
      };
      throw new Error(`unexpected table ${table}`);
    },
  };
}

test("worker token endpoint is account-scoped and returns only short-lived access token material", async () => {
  const service = tokenService();
  const deps = {
    env: (k) => ({ GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "secret" })[k],
    createClient: () => ({ auth: { async getUser() { return { data: { user: { id: "agent-1" } }, error: null }; } } }),
    service, fetch: async () => new Response(JSON.stringify({ access_token: "short-lived", expires_in: 3600 }), { status: 200 }),
    encrypt: async (v) => v, decrypt: async () => JSON.stringify({ refresh_token: "refresh-only" }), now: () => NOW,
  };
  const req = new Request("https://project.test/functions/v1/intel-provider-token", {
    method: "POST", headers: { Authorization: "Bearer agent-jwt", "Content-Type": "application/json" },
    body: JSON.stringify({ account_id: ACCOUNT }),
  });
  const response = await handleProviderToken(req, deps);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.provider, "gmail");
  assert.equal(data.access_token, "short-lived");
  assert.equal(data.mailbox, "studio@gmail.com");
  assert.equal("refresh_token" in data, false);
});

test("worker token endpoint refuses accounts that have not been explicitly activated", async () => {
  const deps = {
    env: () => undefined,
    createClient: () => ({ auth: { async getUser() { return { data: { user: { id: "agent-1" } }, error: null }; } } }),
    service: tokenService({ send_enabled: false }), fetch: async () => assert.fail("must not refresh token"),
    encrypt: async (v) => v, decrypt: async (v) => v, now: () => NOW,
  };
  const req = new Request("https://project.test/functions/v1/intel-provider-token", {
    method: "POST", headers: { Authorization: "Bearer agent-jwt", "Content-Type": "application/json" },
    body: JSON.stringify({ account_id: ACCOUNT }),
  });
  const response = await handleProviderToken(req, deps);
  assert.equal(response.status, 409);
});


test("worker token endpoint also respects the provider-wide sending gate", async () => {
  const deps = {
    env: () => undefined,
    createClient: () => ({ auth: { async getUser() { return { data: { user: { id: "agent-1" } }, error: null }; } } }),
    service: tokenService({}, { sending_enabled: false }), fetch: async () => assert.fail("must not refresh token"),
    encrypt: async (v) => v, decrypt: async () => JSON.stringify({ refresh_token: "refresh-only" }), now: () => NOW,
  };
  const req = new Request("https://project.test/functions/v1/intel-provider-token", {
    method: "POST", headers: { Authorization: "Bearer agent-jwt", "Content-Type": "application/json" },
    body: JSON.stringify({ account_id: ACCOUNT }),
  });
  const response = await handleProviderToken(req, deps);
  assert.equal(response.status, 410);
});

test("Zoho OAuth callback stores a data-center-scoped inactive account", async () => {
  let saved;
  const service = {
    from(table) {
      if (table === "intel_provider_oauth_states") return {
        select() { return this; }, eq() { return this; }, is() { return this; },
        async maybeSingle() { return { data: { organization_id: "org-1", user_id: "user-1", provider_key: "zoho", metadata: { data_center: "eu" }, created_at: new Date(NOW - 1000).toISOString(), expires_at: new Date(NOW + 500000).toISOString(), used_at: null } }; },
        update() { return this; },
      };
      if (table === "intel_email_provider_registry") return { select() { return this; }, eq() { return this; }, async maybeSingle() { return { data: { enabled: true } }; } };
      if (table === "intel_provider_accounts") return { upsert(value) { saved = value; return this; }, select() { return this; }, async single() { return { data: { id: ACCOUNT }, error: null }; } };
      throw new Error(`unexpected table ${table}`);
    },
    async rpc() { return { data: true }; },
  };
  const calls = [];
  const deps = {
    env: (k) => ({ APP_URL: "https://app.test/", ZOHO_CLIENT_ID: "zid", ZOHO_CLIENT_SECRET: "zsecret", ZOHO_REDIRECT_URI: "https://project.test/functions/v1/intel-provider-callback" })[k],
    createClient: () => ({}), service,
    fetch: async (url) => {
      calls.push(url);
      if (url.endsWith("/oauth/v2/token")) return new Response(JSON.stringify({ access_token: "zshort", refresh_token: "zlong", expires_in: 3600 }), { status: 200 });
      return new Response(JSON.stringify({ data: [{ accountId: "98765", primaryEmailAddress: "Sales@Example.com" }] }), { status: 200 });
    },
    encrypt: async (v) => `enc:${v}`, decrypt: async (v) => v, now: () => NOW,
  };
  const response = await handleProviderCallback(new Request(`https://project.test/functions/v1/intel-provider-callback?code=auth-code&state=${STATE}`), deps);
  assert.equal(response.status, 302);
  assert.match(response.headers.get("location"), /provider_connected/);
  assert.equal(saved.provider_key, "zoho");
  assert.equal(saved.mailbox, "sales@example.com");
  assert.equal(saved.external_account_id, "98765");
  assert.equal(saved.data_center, "eu");
  assert.equal(saved.is_enabled, false);
  assert.equal(saved.send_enabled, false);
  assert.deepEqual(calls, ["https://accounts.zoho.eu/oauth/v2/token", "https://mail.zoho.eu/api/accounts"]);
});
