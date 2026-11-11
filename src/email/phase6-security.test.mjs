// Manual Lead Email Composition - Phase 6: security, testing and regression validation.
// Everything here runs against fakes and static source analysis: no network, no database, no provider, no real email.
// Static checks read the committed migrations in timestamp order and approximate the FINAL database state. They do not replace
// the SQL test files under supabase/tests, which need a real PostgreSQL chain (see docs/PHASE_6_COMPOSER_SECURITY_REPORT.md).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { handleSend } from "../../supabase/functions/_shared/email_resend_logic.ts";
import { resendAdapter } from "../../supabase/functions/_shared/email_adapter_resend.ts";
import { leadComposeTarget, accountCanSend, accountConnectionLabel, composeProblem } from "./lib/logic.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const MIG_DIR = path.join(ROOT, "supabase/migrations");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const migrations = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort().map((f) => ({ file: f, sql: fs.readFileSync(path.join(MIG_DIR, f), "utf8").replace(/\r\n/g, "\n") }));
const emailMigrations = migrations.filter((m) => /email/i.test(m.file));
const allEmailSql = emailMigrations.map((m) => m.sql).join("\n;\n");
const stripComments = (s) => s.replace(/--[^\n]*/g, "");
const allEmailCode = stripComments(allEmailSql);

const EMAIL_TABLES = ["email_accounts", "email_conversations", "email_messages", "email_attachments", "email_participants", "email_events",
  "email_sync_state", "email_webhook_events", "email_provider_flags", "email_provider_registry", "email_crm_activities",
  "email_provider_credentials", "email_oauth_states", "email_sync_runs"];
const SERVER_ONLY_TABLES = ["email_provider_credentials", "email_oauth_states", "email_sync_runs", "email_webhook_events"];

// ------------------------------------------------------------------------------------------------ database: RLS and grants
test("P6 RLS: every email table has row level security enabled by a migration", () => {
  for (const t of EMAIL_TABLES) {
    const direct = new RegExp(`alter\\s+table\\s+(if\\s+exists\\s+)?public\\.${t}\\s+enable\\s+row\\s+level\\s+security`, "i").test(allEmailCode);
    // The core migration enables RLS for several tables through one format() loop; accept a table named in that loop's array.
    const loop = /foreach\s+t\s+in\s+array\s+array\s*\[([^\]]*)\][\s\S]{0,200}enable\s+row\s+level\s+security/i.exec(allEmailCode);
    const inLoop = !!loop && loop[1].includes(`'${t}'`);
    assert.ok(direct || inLoop, `${t}: RLS is not enabled by any email migration`);
  }
});

test("P6 grants: no migration gives anon, authenticated or public any write privilege on an email table", () => {
  const stmts = allEmailCode.split(";").map((s) => s.replace(/\s+/g, " ").trim().toLowerCase());
  for (const s of stmts) {
    if (!/^grant\b/.test(s)) continue;
    const touchesEmail = EMAIL_TABLES.some((t) => new RegExp(`\\bon (table )?public\\.${t}\\b`).test(s));
    if (!touchesEmail) continue;
    const toClient = /\bto\b[^;]*\b(anon|authenticated|public)\b/.test(s);
    const writes = /\b(insert|update|delete|truncate|all)\b/.test(s.split(" on ")[0]);
    assert.ok(!(toClient && writes), `client write grant on an email table: "${s.slice(0, 140)}"`);
  }
});

test("P6 grants: credential, OAuth-state, sync-run and webhook tables are service-role only, with no client policy", () => {
  for (const t of SERVER_ONLY_TABLES) {
    assert.match(allEmailCode, new RegExp(`revoke\\s+all\\s+on\\s+public\\.${t}\\s+from\\s+public,\\s*anon,\\s*authenticated`, "i"), `${t}: clients are not revoked`);
    assert.doesNotMatch(allEmailCode, new RegExp(`create\\s+policy\\s+\\w+\\s+on\\s+public\\.${t}\\b`, "i"), `${t}: has a client-facing policy`);
    assert.doesNotMatch(allEmailCode, new RegExp(`grant\\s+[^;]*on\\s+(table\\s+)?public\\.${t}\\s+to\\s+[^;]*(anon|authenticated)`, "i"), `${t}: granted to a client role`);
  }
});

test("P6 secrets: email_accounts (readable by clients) has no secret-like column; ciphertext lives only in the credentials table", () => {
  const cols = new Set();
  const create = /create table if not exists public\.email_accounts\s*\(([\s\S]*?)\n\);/i.exec(allEmailCode);
  assert.ok(create, "email_accounts definition not found");
  for (const line of create[1].split("\n")) { const m = /^\s*([a-z_]+)\s+[a-z]/i.exec(line); if (m) cols.add(m[1].toLowerCase()); }
  for (const m of allEmailCode.matchAll(/alter table public\.email_accounts([\s\S]*?);/gi)) for (const c of m[1].matchAll(/add column if not exists\s+([a-z_]+)/gi)) cols.add(c[1].toLowerCase());
  assert.ok(cols.size > 5 && cols.has("address") && cols.has("connection_status"), `unexpected column parse: ${[...cols]}`);
  for (const c of cols) assert.doesNotMatch(c, /token|secret|password|api_?key|ciphertext|refresh|credential|nonce/, `email_accounts.${c} looks like a secret`);
  assert.match(allEmailCode, /create table if not exists public\.email_provider_credentials[\s\S]*?ciphertext text not null/i);
});

// ------------------------------------------------------------------------------------------------ database: functions
const lastDefinition = (name) => {
  let found = null;
  for (const m of emailMigrations) {
    const re = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${name}\\s*\\(([\\s\\S]*?)\\$(\\w*)\\$\\s*;`, "gi");
    for (const x of m.sql.matchAll(re)) found = { file: m.file, text: x[0] };
  }
  return found;
};

test("P6 functions: every SECURITY DEFINER function in the email migrations pins search_path", () => {
  let checked = 0;
  for (const m of emailMigrations) {
    for (const x of m.sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(public\.\w+)\s*\(([\s\S]*?)\bas\s+\$/gi)) {
      if (!/security\s+definer/i.test(x[0])) continue;
      checked++;
      assert.match(x[0], /set\s+search_path\s*=\s*pg_catalog\s*,\s*public/i, `${x[1]} in ${m.file} does not pin search_path`);
    }
  }
  assert.ok(checked >= 40, `expected at least 40 definer functions, parsed ${checked}`);
});

// Functions only the Edge Functions (service role) may execute. Parsed grant loops are checked as well as explicit grants.
const SERVICE_ONLY = ["email_create_outbound", "email_ingest_inbound", "email_ingest_synced_outbound", "email_record_crm_activity", "email_recover_crm_activities",
  "email_mark_provider_accepted", "email_reconcile_tagged_delivery_event_with_rfc", "email_claim_sync", "email_commit_sync_checkpoint", "email_finish_sync", "email_fail_sync", "email_renew_sync",
  "email_consume_oauth_state", "email_get_or_create_synced_conversation", "email_get_thread_parent", "email_reconcile_synced_message_state",
  "email_apply_delivery_event", "email_webhook_claim", "email_webhook_finish", "email_find_conversation_by_token", "email_reconcile_tagged_delivery_event", "email_reconcile_tagged_delivery_event_with_rfc"];

const loopRoles = (() => {
  const roles = new Map();
  for (const b of allEmailCode.matchAll(/do\s+\$\$[\s\S]*?end\s+\$\$/gi)) {
    const block = b[0];
    const arr = /array\s*\[([^\]]*)\]/i.exec(block);
    if (!arr || !/grant\s+execute/i.test(block)) continue;
    const toAuth = /to\s+authenticated/i.test(block), toSvc = /to\s+service_role/i.test(block);
    for (const n of arr[1].matchAll(/'(\w+)\s*\(/g)) {
      const s = roles.get(n[1]) || new Set();
      if (toAuth) s.add("authenticated"); if (toSvc) s.add("service_role"); roles.set(n[1], s);
    }
  }
  return roles;
})();

test("P6 functions: server-only functions are never executable by anon or authenticated, and each has a service_role grant", () => {
  for (const fn of SERVICE_ONLY) {
    const explicit = allEmailCode.split(";").map((s) => s.replace(/\s+/g, " ").trim().toLowerCase())
      .filter((s) => s.startsWith("grant execute on function public." + fn + "(") || s.startsWith("grant all on function public." + fn + "("));
    for (const g of explicit) assert.doesNotMatch(g, /\bto\b[^;]*\b(anon|authenticated|public)\b/, `${fn} is granted to a client role: ${g.slice(0, 120)}`);
    const loop = loopRoles.get(fn);
    if (loop) assert.ok(!loop.has("authenticated"), `${fn} appears in a loop that grants it to authenticated`);
    const hasServiceGrant = explicit.some((g) => /\bto\b[^;]*service_role/.test(g)) || (loop && loop.has("service_role"));
    assert.ok(hasServiceGrant, `${fn} has no service_role grant in any email migration`);
  }
});

test("P6 functions: every browser-callable email RPC begins by requiring access and scopes by the caller's organization", () => {
  const browserLoop = [...loopRoles.entries()].filter(([, r]) => r.has("authenticated")).map(([n]) => n).filter((n) => /^email_/.test(n));
  assert.ok(browserLoop.length >= 8, `parsed only ${browserLoop.length} browser RPCs: ${browserLoop}`);
  for (const fn of [...new Set([...browserLoop, "email_save_draft", "email_upsert_account", "email_message_conversation"])]) {
    const def = lastDefinition(fn);
    assert.ok(def, `${fn}: definition not found`);
    assert.match(def.text, /email_require_access\s*\(\s*\)/, `${fn} (${def.file}) does not call email_require_access()`);
    assert.match(def.text, /organization_id\s*=\s*v_org|c\.organization_id\s*=\s*v_org|m\.organization_id\s*=\s*v_org|a\.organization_id\s*=\s*v_org|organization_id\s*=\s*v_org/i, `${fn} (${def.file}) never filters by the caller's organization`);
  }
});

test("P6 functions: linking a conversation to a lead requires the caller to own the lead", () => {
  const def = lastDefinition("email_link_lead");
  assert.ok(def);
  assert.match(def.text, /l\.user_id\s*=\s*auth\.uid\(\)/i);
  assert.match(def.text, /raise exception 'Lead not found'/i);
  const outbound = lastDefinition("email_create_outbound");
  assert.ok(outbound);
  // The browser-independent check: the database re-reads the lead's owner (locked) and compares it with the authenticated sender.
  assert.match(outbound.file, /20261222100000/, "the latest definition must retain Phase 4D attribution and apply the corrective migration");
  assert.match(outbound.text, /select\s+user_id\s+into\s+v_lead_owner\s+from\s+public\.leads\s+where\s+id\s*=\s*v_lead\s+for\s+share/i);
  assert.match(outbound.text, /v_lead_owner\s+is\s+distinct\s+from\s+v_crm_user/i);
  assert.match(outbound.text, /crm_lead_conflict/);
});

// ------------------------------------------------------------------------------------------------ server-side tokens
test("P6 tokens: the browser bundle never touches credential tables, vault modules, service-role keys or provider secrets", () => {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(jsx?|tsx?|mjs)$/.test(e.name) && !/\.test\./.test(e.name)) files.push(p); } };
  walk(path.join(ROOT, "src"));
  const banned = /email_provider_credentials|email_oauth_states|email_sync_runs|email_token_vault|email_mailbox_store|SERVICE_ROLE|service_role|RESEND_API_KEY|EMAIL_CREDENTIAL|ENCRYPTION_KEY|ciphertext|refresh_token/i;
  for (const f of files) assert.doesNotMatch(fs.readFileSync(f, "utf8"), banned, `${path.relative(ROOT, f)} references a server-side secret or credential store`);
  assert.ok(files.length > 20);
  // The only `access_token` in the email module path would be the user's own Supabase session; the module must not use any.
  for (const f of files.filter((x) => x.includes(`${path.sep}email${path.sep}`))) assert.doesNotMatch(fs.readFileSync(f, "utf8"), /access_token/, `${path.relative(ROOT, f)} handles an access token`);
});

test("P6 tokens: .env.example and Vite expose no secret to the browser", () => {
  const env = read(".env.example");
  for (const line of env.split("\n")) {
    const m = /^\s*(VITE_[A-Z0-9_]+)\s*=/.exec(line);
    if (m) assert.doesNotMatch(m[1], /SECRET|SERVICE|PRIVATE|API_KEY|TOKEN|PASSWORD/, `${m[1]} would be bundled into the browser`);
  }
  assert.doesNotMatch(read("vite.config.js"), /define\s*:|loadEnv/i, "vite.config.js must not inline process env values");
});

test("P6 tokens: email-send authenticates as the caller (anon key + their JWT); the service role is used only by the store", () => {
  const src = read("supabase/functions/email-send/index.ts");
  const auth = /async authenticate\(r\)[\s\S]*?\n    \},\n/.exec(src);
  assert.ok(auth, "authenticate() not found");
  assert.match(auth[0], /SUPABASE_ANON_KEY/);
  assert.doesNotMatch(auth[0], /SERVICE_ROLE/);
  assert.match(auth[0], /email_has_access/);
  assert.match(auth[0], /email_require_access/);
  assert.equal((src.match(/SERVICE_ROLE_KEY/g) || []).length, 1, "service role key must be read exactly once, for the store");
});

// ------------------------------------------------------------------------------------------------ sending: isolation and failure matrix
const ORG = "20000000-0000-0000-0000-00000000000a";
const ORG_B = "20000000-0000-0000-0000-00000000000b";
const ACC = "30000000-0000-0000-0000-00000000000b";
const ACC_B = "30000000-0000-0000-0000-0000000000bb";
const ACC_PAUSED = "30000000-0000-0000-0000-00000000000d";
const ACC_OAUTH = "30000000-0000-0000-0000-00000000000e";
const LEAD = "40000000-0000-0000-0000-0000000000a1";
const LEAD_OTHER = "40000000-0000-0000-0000-0000000000a2";
const CONV = "aaaaaaaa-1111-2222-3333-444444444444";
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const jres = (o, status = 200) => new Response(JSON.stringify(o), { status });
const REGISTRY = {
  resend: { provider_key: "resend", adapter_key: "resend", display_name: "Resend", enabled: true, capabilities: { send: true, threading_headers: true, attachments_send: true } },
  gmail: { provider_key: "gmail", adapter_key: "gmail", display_name: "Gmail", enabled: true, capabilities: { send: true, oauth: true } },
};

function rig(over = {}) {
  const log = { created: [], fetches: [], crm: [], marks: [], audit: [] };
  const accounts = {
    [ACC]: { id: ACC, organization_id: ORG, provider: "resend", address: "john@studiokairegi.com", display_name: "John", status: "active" },
    [ACC_B]: { id: ACC_B, organization_id: ORG_B, provider: "resend", address: "other@elsewhere.test", display_name: "Other studio", status: "active" },
    [ACC_PAUSED]: { id: ACC_PAUSED, organization_id: ORG, provider: "resend", address: "old@studiokairegi.com", display_name: "Old", status: "paused" },
    [ACC_OAUTH]: { id: ACC_OAUTH, organization_id: ORG, provider: "gmail", address: "g@studiokairegi.com", display_name: "G", status: "active" },
  };
  const byKey = new Map();
  const store = {
    providerEnabled: async () => true,
    getProviderRegistryRow: async (k) => REGISTRY[k] ?? null,
    getAccount: async (org, id) => (org === ORG ? accounts[id] ?? null : null),
    getLeadForUser: async (userId, leadId) => (userId === "U1" && leadId === LEAD ? { id: LEAD, email: "ada@client.test" } : null),
    getConversationLead: async () => (over.convLead === undefined ? null : { lead_id: over.convLead }),
    recordCrmActivity: async (id) => { log.crm.push(id); if (over.crmFail) throw new Error("CRM database unavailable"); return { recorded: true, duplicate: false }; },
    getThreadParent: async () => null,
    countOutboundSince: async () => 0,
    createOutbound: async (p) => {
      log.created.push(p);
      const prior = byKey.get(p.idempotency_key);
      if (prior) return { duplicate: true, message_id: prior.id, conversation_id: "C1", status: prior.status, provider_message_id: prior.pm ?? null };
      const row = { id: `M${byKey.size + 1}`, status: "queued", pm: null }; byKey.set(p.idempotency_key, row);
      return { duplicate: false, message_id: row.id, conversation_id: "C1", status: "queued" };
    },
    markResult: async (id, patch) => { log.marks.push([id, patch.status]); for (const r of byKey.values()) if (r.id === id) { r.status = patch.status; if (patch.provider_message_id) r.pm = patch.provider_message_id; } },
    saveAttachments: async () => {},
  };
  const deps = {
    env: (k) => ({ RESEND_API_KEY: "re_secret_key" })[k], now: () => NOW, sleep: async () => {}, store, audit: (e) => log.audit.push(e),
    fetch: over.fetch || (async (url, init) => { log.fetches.push({ url, init }); return jres({ id: "re_sent_1" }); }),
    authenticate: async (req) => {
      const t = req.headers.get("authorization");
      if (t === "Bearer good") return { ok: true, userId: "U1", organizationId: ORG };
      if (t === "Bearer restricted") return { ok: false, status: 403, error: "Email is restricted." };
      return { ok: false, status: 401, error: "Not authenticated" };
    },
  };
  return { deps, log };
}
const body = (o = {}) => ({ account_id: ACC, to: ["ada@client.test"], cc: [], bcc: [], subject: "Hello", text: "Body", html: "", reply_to: "", conversation_id: null, draft_id: null, idempotency_key: "p6-idem-0001", attachments: [], ...o });
const req = (b, token = "good") => new Request("https://x/functions/v1/email-send", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: typeof b === "string" ? b : JSON.stringify(b) });
const untouched = (h, why) => { assert.equal(h.log.fetches.length, 0, `${why}: provider was contacted`); assert.equal(h.log.created.length, 0, `${why}: a message row was created`); assert.equal(h.log.crm.length, 0, `${why}: CRM activity was recorded`); };

test("P6 isolation: every refused send creates no message, contacts no provider and records no CRM activity", async () => {
  const cases = [
    ["no token", () => req(body(), "none"), 401],
    ["restricted user", () => req(body(), "restricted"), 403],
    ["another organization's account", () => req(body({ account_id: ACC_B })), 404],
    ["unknown account", () => req(body({ account_id: "30000000-0000-0000-0000-00000000ffff" })), 404],
    ["paused account", () => req(body({ account_id: ACC_PAUSED })), 409],
    ["lead owned by someone else", () => req(body({ crm: { lead_id: LEAD_OTHER } })), 404],
    ["malformed lead id", () => req(body({ crm: { lead_id: "not-a-uuid" } })), 400],
    ["no recipient", () => req(body({ to: [] })), 400],
    ["invalid recipient", () => req(body({ to: ["no-at-sign"] })), 400],
    ["missing request key", () => req(body({ idempotency_key: "" })), 400],
    ["hostile body", () => req("{not json"), 400],
  ];
  for (const [why, make, status] of cases) {
    const h = rig();
    const res = await handleSend(make(), h.deps);
    assert.ok(res.status === status || (status === 409 && res.status >= 400 && res.status < 500), `${why}: expected ${status}, got ${res.status}`);
    assert.notEqual(res.status, 200, `${why}: must not succeed`);
    untouched(h, why);
  }
});

test("P6 isolation: a conversation already linked to a different lead refuses the send (409) and sends nothing", async () => {
  const h = rig({ convLead: LEAD_OTHER });
  const res = await handleSend(req(body({ conversation_id: CONV, crm: { lead_id: LEAD } })), h.deps);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "crm_lead_conflict");
  untouched(h, "lead conflict");
});

test("P6 OAuth server gate: a compiled OAuth adapter refuses disconnected and reauthorization-required accounts before persistence or send", async () => {
  const oauthAdapter = {
    providerKey: "gmail", adapterKey: "gmail", displayName: "Gmail", operations: ["send"], legacyFlagKey: null,
    configurationProblem: () => null,
    send: async () => { throw new Error("must not send while disconnected"); },
  };
  for (const connection_status of ["not_connected", "disconnected", "reauthorization_required", "error", undefined]) {
    const h = rig();
    const originalGetAccount = h.deps.store.getAccount;
    h.deps.store.getAccount = async (org, id) => {
      const row = await originalGetAccount(org, id);
      return id === ACC_OAUTH ? { ...row, connection_status } : row;
    };
    h.deps.adapters = { gmail: oauthAdapter };
    const res = await handleSend(req(body({ account_id: ACC_OAUTH })), h.deps);
    assert.equal(res.status, 409, `OAuth ${connection_status} must be refused`);
    assert.equal((await res.json()).code, "account_not_usable");
    untouched(h, `OAuth ${connection_status}`);
  }
});

test("P6 OAuth server gate: a connected account can use its registered compiled adapter", async () => {
  const sent = [];
  const oauthAdapter = {
    providerKey: "gmail", adapterKey: "gmail", displayName: "Gmail", operations: ["send"], legacyFlagKey: null,
    configurationProblem: () => null,
    send: async (_ctx, account, input) => { sent.push({ account, input }); return { ok: true, providerMessageId: "gmail-provider-message-1", attempts: 1 }; },
  };
  const h = rig();
  const originalGetAccount = h.deps.store.getAccount;
  h.deps.store.getAccount = async (org, id) => {
    const row = await originalGetAccount(org, id);
    return id === ACC_OAUTH ? { ...row, connection_status: "connected" } : row;
  };
  h.deps.adapters = { gmail: oauthAdapter };
  const res = await handleSend(req(body({ account_id: ACC_OAUTH })), h.deps);
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.equal(out.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].account.id, ACC_OAUTH);
});

test("P6 sending: a successful lead send reaches the provider once and records exactly one CRM activity", async () => {
  const h = rig();
  const res = await handleSend(req(body({ crm: { lead_id: LEAD } })), h.deps);
  const out = await res.json();
  assert.equal(res.status, 200); assert.equal(out.ok, true);
  assert.deepEqual(out.crm, { lead_id: LEAD, activity: "recorded" });
  assert.equal(h.log.fetches.filter((f) => f.init?.method === "POST").length, 1);
  assert.equal(h.log.crm.length, 1);
  assert.equal(JSON.stringify(h.log.fetches[0]).includes(LEAD), false, "CRM context must never reach the provider");
  assert.equal(JSON.stringify(h.log.audit).includes("re_secret_key"), false, "provider key must not reach the audit log");
});

test("P6 retries: repeating a successful request key never calls the provider again", async () => {
  const h = rig();
  await handleSend(req(body({ crm: { lead_id: LEAD } })), h.deps);
  const again = await handleSend(req(body({ crm: { lead_id: LEAD } })), h.deps);
  const out = await again.json();
  assert.equal(again.status, 200); assert.equal(out.duplicate, true);
  assert.equal(h.log.fetches.filter((f) => f.init?.method === "POST").length, 1, "second request must be a lookup, not a send");
  assert.ok(h.log.crm.length <= 2, "CRM recording is idempotent per message id");
  assert.ok(new Set(h.log.crm).size === 1, "both CRM calls are for the same message");
});

test("P6 failures: a provider rejection records no CRM activity and is not reported as sent", async () => {
  const h = rig({ fetch: async (url, init) => { h0.fetches.push({ url, init }); return jres({ message: "invalid recipient" }, 422); } });
  const h0 = h.log;
  const res = await handleSend(req(body({ crm: { lead_id: LEAD } })), h.deps);
  const out = await res.json();
  assert.notEqual(res.status, 200); assert.equal(out.ok, false);
  assert.equal(h.log.crm.length, 0, "a failed send must never create a lead activity");
  assert.equal(h.log.marks.some(([, s]) => s === "sent"), false);
});

test("P6 failures: a network error leaves the outcome unknown, resendable only with the same key, and records no CRM activity", async () => {
  const h = rig({ fetch: async () => { throw new TypeError("fetch failed"); } });
  const res = await handleSend(req(body({ crm: { lead_id: LEAD } })), h.deps);
  const out = await res.json();
  assert.equal(out.ok, false);
  assert.ok(out.retry_with_same_key === true || out.outcome === "failed", "must give safe retry guidance");
  assert.equal(h.log.crm.length, 0);
});

test("P6 recovery: a CRM write failure after provider acceptance still reports the send as successful, with the activity pending", async () => {
  const h = rig({ crmFail: true });
  const res = await handleSend(req(body({ crm: { lead_id: LEAD } })), h.deps);
  const out = await res.json();
  assert.equal(res.status, 200); assert.equal(out.ok, true);
  assert.equal(out.crm.activity, "pending");
  assert.equal(h.log.fetches.filter((f) => f.init?.method === "POST").length, 1, "CRM failure must never trigger a second provider call");
});

// ------------------------------------------------------------------------------------------------ frontend gates
test("P6 leads without emails: Compose requires a saved, active lead with a valid address and excludes explicitly colleague-owned leads", () => {
  const ok = { id: LEAD, email: "ada@studio.test", companyName: "Studio Ada" };
  assert.equal(leadComposeTarget(ok, "U1")?.to, "ada@studio.test", "legacy/unowned lead rows retain existing eligibility");
  for (const [why, lead] of [
    ["no email", { ...ok, email: "" }], ["undefined email", { ...ok, email: undefined }], ["invalid email", { ...ok, email: "not-an-email" }],
    ["whitespace only", { ...ok, email: "   " }], ["archived", { ...ok, archivedAt: "2026-11-01" }], ["unsaved id", { ...ok, id: "tmp-123" }],
    ["no id", { ...ok, id: undefined }], ["colleague's lead", { ...ok, ownerUserId: "U2" }],
  ]) assert.equal(leadComposeTarget(lead, "U1"), null, why);
  assert.equal(leadComposeTarget(null, "U1"), null);
  assert.equal(leadComposeTarget({ ...ok, email: "bad, good@studio.test" }, "U1")?.to, "good@studio.test", "only valid addresses are used");
});

test("P6 sender selection: paused, disabled, unknown and unconnected OAuth accounts cannot be selected", () => {
  const providers = [REGISTRY.resend, REGISTRY.gmail, { provider_key: "off", enabled: false, capabilities: { send: true } }];
  const acct = (o) => ({ id: "a", provider: "resend", status: "active", connection_status: "not_connected", ...o });
  assert.equal(accountCanSend(acct({}), providers), true, "address-based provider needs no OAuth connection");
  assert.equal(accountCanSend(acct({ status: "paused" }), providers), false);
  assert.equal(accountCanSend(acct({ provider: "off" }), providers), false);
  assert.equal(accountCanSend(acct({ provider: "unknown" }), providers), false);
  assert.equal(accountCanSend(null, providers), false);
  assert.equal(accountCanSend(acct({ provider: "resend" }), []), false, "an empty or failed registry fails closed");
  for (const s of ["not_connected", "connecting", "reauthorization_required", "disconnected", "error", undefined]) assert.equal(accountCanSend(acct({ provider: "gmail", connection_status: s }), providers), false, `oauth ${s}`);
  assert.equal(accountCanSend(acct({ provider: "gmail", connection_status: "connected" }), providers), true);
  assert.equal(accountConnectionLabel(acct({ provider: "gmail", connection_status: "reauthorization_required" }), providers), "Reauthorization required");
});

test("P6 composer: a send cannot start without a sender, a valid recipient, a subject and a body", () => {
  const good = { accountId: "a", to: "ada@x.test", cc: "", bcc: "", subject: "Hi", body: "Text" };
  assert.equal(composeProblem(good), "");
  for (const o of [{ accountId: "" }, { to: "" }, { to: "bad" }, { cc: "bad" }, { subject: " " }, { body: "" }]) assert.notEqual(composeProblem({ ...good, ...o }), "");
});
