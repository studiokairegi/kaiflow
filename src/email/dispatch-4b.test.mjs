// Multi-provider plan, revised phase 4B: provider-aware sending dispatch.
// Server-side dispatch from the DATABASE account row, ownership and usability checks, optional CRM lead verification,
// one normalised answer shape, provider text sanitising, and isolation of the Intelligence / transactional Resend files.
// Everything runs against fakes (no network, no database). Nothing here talks to Resend.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { handleSend, validateSendRequest, sanitizeProviderMessage } from "../../supabase/functions/_shared/email_resend_logic.ts";
import { makeSendStore } from "../../supabase/functions/_shared/email_resend_store.ts";
import { resendAdapter } from "../../supabase/functions/_shared/email_adapter_resend.ts";

const ORG = "20000000-0000-0000-0000-00000000000a";
const ORG_B = "20000000-0000-0000-0000-00000000000b";
const ACC = "30000000-0000-0000-0000-00000000000b";
const ACC2 = "30000000-0000-0000-0000-00000000000c";
const ACC_PAUSED = "30000000-0000-0000-0000-00000000000d";
const LEAD = "40000000-0000-0000-0000-0000000000a1";
const LEAD_OTHER = "40000000-0000-0000-0000-0000000000a2";
const CONV = "aaaaaaaa-1111-2222-3333-444444444444";
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const noSleep = async () => {};
const json = (o, status = 200) => new Response(JSON.stringify(o), { status });

const RESEND_ROW = { provider_key: "resend", adapter_key: "resend", display_name: "Resend", enabled: true,
  capabilities: { send: true, inbound_webhook: true, delivery_events: true, attachments_send: true, attachments_receive: true, threading_headers: true, drafts_local: true, remote_sync: false, remote_search: false, remote_folders: false, remote_drafts: false, oauth: false } };
const FAKE_ROW = { provider_key: "fakemail", adapter_key: "fakemail", display_name: "FakeMail", enabled: true, capabilities: { send: true } };

/** A second provider that exists only in this file. */
function makeFakeAdapter(over = {}) {
  const calls = [];
  const adapter = {
    providerKey: "fakemail", adapterKey: "fakemail", displayName: "FakeMail", operations: ["send", "reply", "forward"],
    legacyFlagKey: null, defaultDailyLimit: 5,
    configurationProblem: () => null,
    async send(ctx, account, input) { calls.push({ account, input }); if (over.throws) throw new Error("boom secret=abc"); return over.outcome || { ok: true, providerMessageId: "fm_1", attempts: 1 }; },
  };
  return { adapter, calls };
}

function harness(over = {}) {
  const log = { created: [], marks: [], fetches: [], audit: [], leadAsks: [], counts: [], crmActivities: [] };
  const accounts = {
    [ACC]: { id: ACC, organization_id: ORG, provider: "resend", address: "john@studiokairegi.com", display_name: "Studio Kairegi", status: "active" },
    [ACC2]: { id: ACC2, organization_id: ORG, provider: "fakemail", address: "ann@fake.test", display_name: "Ann", status: "active" },
    [ACC_PAUSED]: { id: ACC_PAUSED, organization_id: ORG, provider: "resend", address: "old@studiokairegi.com", display_name: "Old", status: "paused" },
    ...(over.accounts || {}),
  };
  const rows = [];
  const store = {
    providerEnabled: async () => over.flag ?? true,
    getProviderRegistryRow: async (k) => (over.rows ? over.rows[k] ?? null : k === "resend" ? RESEND_ROW : null),
    getAccount: async (org, id) => (over.ignoreOrg ? accounts[id] ?? null : org === ORG ? accounts[id] ?? null : null),
    getLeadForUser: async (userId, leadId) => { log.leadAsks.push([userId, leadId]); return over.lead === undefined ? (userId === "U1" && leadId === LEAD ? { id: LEAD, email: "ada@client.com" } : null) : over.lead; },
    getConversationLead: async () => null,
    recordCrmActivity: async (messageId) => { log.crmActivities.push(messageId); if (over.crmFail) throw new Error("CRM database unavailable"); return { recorded: true, duplicate: !!over.crmDuplicate }; },
    getThreadParent: async () => null,
    countOutboundSince: async (_o, since) => { log.counts.push(since); return Date.parse(since) > NOW - 120_000 ? (over.perMinute ?? 0) : (over.perDay ?? 0); },
    createOutbound: async (p) => { const d = rows.find((r) => r.idempotency_key === p.idempotency_key); if (d || over.duplicateStatus) { const prior = d || {}; return { duplicate: true, message_id: prior.message_id || "M1", conversation_id: prior.conversation_id || CONV, status: over.duplicateStatus || prior.status || "queued", provider_message_id: prior.provider_message_id || null }; } if ((over.perMinute ?? 0) >= p.rate_limit_minute) return { duplicate: false, rate_limited: "minute" }; if ((over.perDay ?? 0) >= p.rate_limit_daily) return { duplicate: false, rate_limited: "day" }; rows.push({ ...p, message_id: "M1", status: "queued" }); log.created.push(p); return { duplicate: false, message_id: "M1", conversation_id: p.conversation_id || CONV, status: "queued" }; },
    markResult: async (_id, patch) => { const row = rows.find((r) => r.message_id === _id); if (row) Object.assign(row, patch); if (patch.status === "sent") { log.sentWrites = (log.sentWrites || 0) + 1; if (over.markFailCount > (log.sentFailures || 0) || (over.markFails && !over.markFailCount)) { log.sentFailures = (log.sentFailures || 0) + 1; throw new Error("db down"); } } log.marks.push(patch); },
    saveAttachments: async () => {},
  };
  const deps = {
    env: (k) => ({ RESEND_API_KEY: "re_secret_key", ...(over.env || {}) })[k],
    fetch: over.fetch || (async (url, init) => { if (init.method === "POST") log.fetches.push({ url, init }); return json({ id: "re_sent_1" }); }),
    now: () => NOW, sleep: noSleep, store, audit: (e) => log.audit.push(e), adapters: over.adapters,
    authenticate: async (req) => {
      const t = req.headers.get("authorization");
      if (t === "Bearer good") return { ok: true, userId: "U1", organizationId: ORG };
      if (t === "Bearer forbidden") return { ok: false, status: 403, error: "Email is restricted." };
      return { ok: false, status: 401, error: "Not authenticated" };
    },
  };
  return { deps, log };
}
const goodReq = (o = {}) => ({ account_id: ACC, to: ["ada@client.com"], cc: [], bcc: [], subject: "Hello", text: "Body", html: "", reply_to: "", conversation_id: null, draft_id: null, idempotency_key: "idem-12345678", attachments: [], ...o });
const post = (body, token = "good") => new Request("https://x/functions/v1/email-send", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const two = (over = {}) => { const fm = makeFakeAdapter(over.fake); return { fm, ...harness({ adapters: { resend: resendAdapter, fakemail: fm.adapter }, rows: { resend: RESEND_ROW, fakemail: FAKE_ROW }, ...over }) }; };
const SEND_CODES = new Set(["unsupported_operation", "provider_not_registered", "provider_disabled", "adapter_unavailable", "not_configured", "account_not_usable", "rate_limited", "provider_rejected", "provider_unavailable", "outcome_unknown",
  "unauthenticated", "forbidden", "method_not_allowed", "request_too_large", "invalid_request", "account_not_found", "lead_not_found", "internal_error"]);

// ------------------------------------------------------------------------------------------------ dispatch identity
test("4B dispatch: validation carries through ONLY the documented fields. No provider, adapter, organization, user or sender identity from the browser", () => {
  const hostile = { ...goodReq({ crm: { lead_id: LEAD } }), provider: "gmail", adapter: "gmail", adapter_key: "gmail", provider_key: "gmail", account_provider: "gmail",
    organization_id: ORG_B, user_id: "U9", created_by: "U9", from: "ceo@evil.test", from_email: "ceo@evil.test", from_name: "CEO", sender: "ceo@evil.test", status: "sent", provider_message_id: "x" };
  const v = validateSendRequest(hostile);
  assert.equal(v.ok, true);
  assert.deepEqual(Object.keys(v.value).sort(),
    ["account_id", "attachments", "bcc", "cc", "conversation_id", "crm", "draft_id", "html", "idempotency_key", "reply_to", "subject", "text", "to"]);
});

test("4B dispatch: the DATABASE account row picks the adapter, whatever identity the request claims, and the organization comes from authentication", async () => {
  const hostile = { provider: "resend", adapter: "resend", adapter_key: "resend", provider_key: "resend", organization_id: ORG_B, user_id: "U9", from: "ceo@evil.test", from_email: "ceo@evil.test" };
  const a = two();
  const r1 = await handleSend(post({ ...goodReq({ account_id: ACC2 }), ...hostile }), a.deps);
  assert.equal(r1.status, 200);
  assert.equal(a.fm.calls.length, 1); assert.equal(a.log.fetches.length, 0, "the account is fakemail: Resend must not be called");
  assert.equal(a.fm.calls[0].input.fromEmail, "ann@fake.test", "the sender comes from the account row, not the request");
  assert.equal(a.log.created[0].organization_id, ORG); assert.equal(a.log.created[0].user_id, "U1");
  const b = two();
  const r2 = await handleSend(post({ ...goodReq({ account_id: ACC }), provider: "fakemail", adapter: "fakemail", adapter_key: "fakemail", provider_key: "fakemail" }), b.deps);
  assert.equal(r2.status, 200);
  assert.equal(b.fm.calls.length, 0); assert.equal(b.log.fetches.length, 1, "the account is resend: only Resend is called");
  assert.equal(JSON.parse(b.log.fetches[0].init.body).from, "Studio Kairegi <john@studiokairegi.com>");
});

test("4B dispatch: two accounts of two providers route independently in the same organization", async () => {
  const h = two();
  await handleSend(post(goodReq({ account_id: ACC, idempotency_key: "idem-aaaaaaaa" })), h.deps);
  await handleSend(post(goodReq({ account_id: ACC2, idempotency_key: "idem-bbbbbbbb" })), h.deps);
  assert.equal(h.log.fetches.length, 1); assert.equal(h.fm.calls.length, 1);
  assert.deepEqual(h.log.created.map((c) => c.account_id), [ACC, ACC2]);
  assert.deepEqual(h.log.audit.filter((e) => e.event === "send_attempt").map((e) => e.provider), ["resend", "fakemail"]);
});

// ------------------------------------------------------------------------------------------------ ownership and usability
test("4B ownership: a sender account that is not the caller's organization's is refused, even if the store wrongly returns it", async () => {
  const stolen = { id: ACC, organization_id: ORG_B, provider: "resend", address: "sales@other-org.test", display_name: "Other", status: "active" };
  const wrong = harness({ ignoreOrg: true, accounts: { [ACC]: stolen } });
  const res = await handleSend(post(goodReq()), wrong.deps);
  assert.equal(res.status, 404); assert.equal((await res.json()).code, "account_not_found");
  assert.equal(wrong.log.fetches.length, 0); assert.equal(wrong.log.created.length, 0);
  const noOrg = harness({ accounts: { [ACC]: { id: ACC, provider: "resend", address: "x@y.test", display_name: "", status: "active" } } });   // a row with no organization fails closed
  assert.equal((await handleSend(post(goodReq()), noOrg.deps)).status, 404);
  assert.equal(noOrg.log.fetches.length, 0);
  const missing = harness();
  const m = await handleSend(post(goodReq({ account_id: "30000000-0000-0000-0000-0000000000ff" })), missing.deps);
  assert.equal(m.status, 404); assert.equal((await m.json()).code, "account_not_found");
  assert.equal(missing.log.audit[0].code, "account_not_found");
});

test("4B usability: a paused sender is refused with its own normalised code before anything is created or sent", async () => {
  const h = harness();
  const res = await handleSend(post(goodReq({ account_id: ACC_PAUSED })), h.deps);
  const body = await res.json();
  assert.equal(res.status, 409); assert.equal(body.code, "account_not_usable"); assert.match(body.error, /paused/);
  assert.equal(h.log.fetches.length, 0); assert.equal(h.log.created.length, 0); assert.equal(h.log.leadAsks.length, 0);
  assert.equal(h.log.audit[0].event, "send_refused"); assert.equal(h.log.audit[0].code, "account_not_usable");
});

test("4B provider state: disabled, unregistered, uninstalled, and unconfigured providers are refused with codes and nothing is created", async () => {
  const cases = [
    ["disabled", { rows: { resend: { ...RESEND_ROW, enabled: false } } }, 503, "provider_disabled"],
    ["unregistered", { rows: {} }, 409, "provider_not_registered"],
    ["uninstalled", { rows: { resend: RESEND_ROW, fakemail: FAKE_ROW }, accountsOnly: true }, null, null],
    ["unconfigured", { env: { RESEND_API_KEY: "" } }, 503, "not_configured"],
  ];
  for (const [name, over, status, code] of cases) {
    if (!status) continue;
    const h = harness(over);
    const res = await handleSend(post(goodReq()), h.deps);
    assert.equal(res.status, status, name); assert.equal((await res.json()).code, code, name);
    assert.equal(h.log.created.length, 0, name); assert.equal(h.log.fetches.length, 0, name);
  }
  const noAdapter = harness({ rows: { resend: RESEND_ROW, fakemail: FAKE_ROW } });                         // fakemail registered but its adapter is not in this deployment
  const r = await handleSend(post(goodReq({ account_id: ACC2 })), noAdapter.deps);
  assert.equal(r.status, 503); assert.equal((await r.json()).code, "adapter_unavailable");
});

// ------------------------------------------------------------------------------------------------ CRM lead attribution (Phase 4D)
test("CRM lead: a lead the caller owns is verified, persisted with the outbound row, and never reaches the adapter", async () => {
  const h = two();
  const res = await handleSend(post(goodReq({ account_id: ACC2, crm: { lead_id: LEAD.toUpperCase() } })), h.deps);
  const body = await res.json();
  assert.equal(res.status, 200); assert.equal(body.outcome, "accepted");
  assert.deepEqual(body.crm, { lead_id: LEAD, activity: "recorded" });
  assert.deepEqual(h.log.leadAsks, [["U1", LEAD]], "asked as the authenticated user, with the id lower-cased");
  assert.equal(JSON.stringify(h.fm.calls).includes(LEAD), false, "adapters never see CRM context");
  assert.equal(JSON.stringify(h.log.created).includes(LEAD), true, "Phase 4D persists the lead association before provider submission");
  const none = harness();
  await handleSend(post(goodReq()), none.deps);
  assert.equal(none.log.leadAsks.length, 0, "no crm, no lookup");
});

test("4B CRM lead: an unknown or someone else's lead is refused identically, before anything is created, limited or sent", async () => {
  for (const lead of [null, { id: LEAD_OTHER }]) {
    const h = harness({ lead });
    const res = await handleSend(post(goodReq({ crm: { lead_id: LEAD } })), h.deps);
    const body = await res.json();
    assert.equal(res.status, 404, JSON.stringify(lead)); assert.equal(body.code, "lead_not_found"); assert.equal(body.error, "Lead not found");
    assert.equal(h.log.created.length, 0); assert.equal(h.log.fetches.length, 0); assert.equal(h.log.counts.length, 0);
    assert.equal(h.log.audit[0].event, "send_refused"); assert.equal(h.log.audit[0].code, "lead_not_found");
    assert.equal(JSON.stringify(h.log.audit).includes(LEAD), false, "audit carries codes, not the claimed lead");
  }
  const other = harness();                                                                                      // a different signed-in user: the fake only knows U1's lead
  other.deps.authenticate = async () => ({ ok: true, userId: "U2", organizationId: ORG });
  const o = await handleSend(post(goodReq({ crm: { lead_id: LEAD } })), other.deps);
  assert.equal(o.status, 404); assert.equal(other.log.fetches.length, 0);
});

test("4B CRM lead: a malformed crm value is a 400 invalid_request; a lead lookup failure is a safe 500 and sends nothing", async () => {
  for (const crm of [{ lead_id: "not-a-uuid" }, { lead_id: "" }, {}, "x", 5, [LEAD], [], { lead: LEAD }]) {
    const h = harness();
    const res = await handleSend(post(goodReq({ crm })), h.deps);
    assert.equal(res.status, 400, JSON.stringify(crm)); assert.equal((await res.json()).code, "invalid_request");
    assert.equal(h.log.leadAsks.length, 0);
  }
  assert.equal(validateSendRequest(goodReq({ crm: null })).value.crm, null);
  assert.equal(validateSendRequest(goodReq()).value.crm, null);
  const down = harness();
  down.deps.store.getLeadForUser = async () => { throw new Error("leads table unavailable"); };
  const res = await handleSend(post(goodReq({ crm: { lead_id: LEAD } })), down.deps);
  assert.equal(res.status, 500); assert.equal((await res.json()).code, "internal_error");
  assert.equal(down.log.fetches.length, 0); assert.equal(down.log.created.length, 0);
});

// ------------------------------------------------------------------------------------------------ normalised answers
test("4B envelope: every result has ok, outcome and the documented retry guidance", async () => {
  const accepted = await (await handleSend(post(goodReq()), harness().deps)).json();
  assert.deepEqual([accepted.ok, accepted.outcome, accepted.status], [true, "accepted", "sent"]);

  const h = harness(); await handleSend(post(goodReq()), h.deps);
  const dup = await (await handleSend(post(goodReq()), h.deps)).json();
  assert.deepEqual([dup.ok, dup.duplicate, dup.outcome], [true, true, "duplicate"]);          // unchanged idempotent behaviour, now labelled

  const rej = two({ fake: { outcome: { ok: false, unknown: false, retryable: false, status: 403, message: "domain not verified", attempts: 1 } } });
  const rr = await handleSend(post(goodReq({ account_id: ACC2 })), rej.deps); const rb = await rr.json();
  assert.equal(rr.status, 422); assert.deepEqual([rb.ok, rb.outcome, rb.code, rb.retry_with_same_key, rb.error], [false, "rejected", "provider_rejected", false, "domain not verified"]);
  assert.equal(rej.log.marks.at(-1).status, "rejected");

  const bad = two({ fake: { outcome: { ok: false, unknown: false, retryable: true, status: 503, message: "upstream 10.0.0.5 exploded", attempts: 3 } } });
  const br = await handleSend(post(goodReq({ account_id: ACC2 })), bad.deps); const bb = await br.json();
  assert.equal(br.status, 502); assert.deepEqual([bb.ok, bb.outcome, bb.code, bb.retry_with_same_key], [false, "failed", "provider_unavailable", false]);
  assert.equal(JSON.stringify(bb).includes("10.0.0.5"), false, "a server-side failure shows a fixed message, never provider text");
  assert.equal(bad.log.marks.at(-1).status, "failed");

  const lim = two({ fake: { outcome: { ok: false, unknown: false, retryable: true, status: 429, message: "slow", attempts: 3 } } });
  const lr = await handleSend(post(goodReq({ account_id: ACC2 })), lim.deps);
  assert.equal(lr.status, 502); assert.equal((await lr.json()).code, "rate_limited");

  for (const fake of [{ outcome: { ok: false, unknown: true, retryable: true, status: 0, message: "net", attempts: 3 } }, { throws: true }]) {
    const u = two({ fake }); const ur = await handleSend(post(goodReq({ account_id: ACC2 })), u.deps); const ub = await ur.json();
    assert.equal(ur.status, 202);
    assert.deepEqual([ub.ok, ub.outcome, ub.code, ub.retry_with_same_key, ub.status], [false, "unknown", "outcome_unknown", true, "unknown"]);
    assert.equal(u.fm.calls.length, 1, "no automatic resend");
    assert.equal(u.log.marks.at(-1).status, "sending");
  }

  const warn = await (await handleSend(post(goodReq()), harness({ markFails: true }).deps)).json();
  assert.deepEqual([warn.ok, warn.outcome, warn.warning], [true, "accepted", "sent_status_not_saved"]);
});

test("4B envelope: every refusal or failure after the preflight carries a documented `code` and a safe `error`", async () => {
  const seen = new Set();
  const check = async (name, res, status) => {
    const b = await res.json();
    assert.equal(res.status, status, name); assert.ok(SEND_CODES.has(b.code), `${name}: unexpected code ${b.code}`); assert.equal(typeof b.error, "string", name); assert.ok(b.error.length > 0, name);
    assert.equal(b.ok === true, false, name);
    seen.add(b.code);
  };
  await check("no token", await handleSend(post(goodReq(), "none"), harness().deps), 401);
  await check("forbidden", await handleSend(post(goodReq(), "forbidden"), harness().deps), 403);
  await check("GET", await handleSend(new Request("https://x", { method: "GET" }), harness().deps), 405);
  await check("bad json", await handleSend(post("{not json"), harness().deps), 400);
  await check("invalid", await handleSend(post({ nonsense: true }), harness().deps), 400);
  await check("too large", await handleSend(post("x".repeat(16 * 1024 * 1024 + 1)), harness().deps), 413);
  await check("unknown sender", await handleSend(post(goodReq({ account_id: "30000000-0000-0000-0000-0000000000ff" })), harness().deps), 404);
  await check("paused", await handleSend(post(goodReq({ account_id: ACC_PAUSED })), harness().deps), 409);
  await check("no registry row", await handleSend(post(goodReq()), harness({ rows: {} }).deps), 409);
  await check("disabled", await handleSend(post(goodReq()), harness({ rows: { resend: { ...RESEND_ROW, enabled: false } } }).deps), 503);
  await check("not configured", await handleSend(post(goodReq()), harness({ env: { RESEND_API_KEY: "" } }).deps), 503);
  await check("lead", await handleSend(post(goodReq({ crm: { lead_id: LEAD_OTHER } })), harness().deps), 404);
  await check("per minute", await handleSend(post(goodReq()), harness({ perMinute: 20 }).deps), 429);
  await check("per day", await handleSend(post(goodReq()), harness({ perDay: 100 }).deps), 429);
  const boom = harness(); boom.deps.store.createOutbound = async () => { throw new Error("db exploded password=hunter2"); };
  const br = await handleSend(post(goodReq()), boom.deps);
  await check("database failure", br, 500);
  assert.equal(JSON.stringify(await handleSend(post(goodReq()), boom.deps).then((r) => r.text())).includes("hunter2"), false);
  assert.deepEqual([...seen].sort(), ["account_not_found", "account_not_usable", "forbidden", "internal_error", "invalid_request", "lead_not_found", "method_not_allowed", "not_configured", "provider_disabled", "provider_not_registered", "rate_limited", "request_too_large", "unauthenticated"]);
});

// ------------------------------------------------------------------------------------------------ provider text
test("4B sanitising: provider text is short, single-line and free of credentials before it is stored or shown", () => {
  const dirty = "Bad request\r\nAuthorization: Bearer re_live_AbCdEf123456 api_key=sk_live_abcdefgh12345 token: tok_abcdefghijkl re_abcdefghij1234 " + "A".repeat(40) + " ok";
  const clean = sanitizeProviderMessage(dirty);
  for (const leak of ["re_live_AbCdEf123456", "sk_live_abcdefgh12345", "tok_abcdefghijkl", "re_abcdefghij1234", "A".repeat(32), "\r", "\n"]) assert.equal(clean.includes(leak), false, leak);
  assert.match(clean, /Bad request/); assert.match(clean, /\[redacted\]/);
  assert.equal(sanitizeProviderMessage("x".repeat(500)).length <= 200, true);
  assert.equal(sanitizeProviderMessage(null), ""); assert.equal(sanitizeProviderMessage(undefined), "");
  assert.equal(sanitizeProviderMessage("The `to` field must be a valid email."), "The `to` field must be a valid email.");     // useful text survives
});

test("4B sanitising: a credential echoed by a provider reaches neither the browser, the stored message, nor the audit log", async () => {
  const echo = "Invalid key. Bearer re_live_AbCdEf123456 api_key=sk_live_abcdefgh12345";
  const h = two({ fake: { outcome: { ok: false, unknown: false, retryable: false, status: 401, message: echo, attempts: 1 } } });
  const res = await handleSend(post(goodReq({ account_id: ACC2 })), h.deps);
  const dump = JSON.stringify([await res.json(), h.log.marks, h.log.audit]);
  for (const leak of ["re_live_AbCdEf123456", "sk_live_abcdefgh12345"]) assert.equal(dump.includes(leak), false, leak);
  assert.equal(res.status, 422);
});

// ------------------------------------------------------------------------------------------------ real store
function fakeService(tables, errors = {}) {
  const calls = [];
  const from = (name) => {
    const filters = []; let cols = null;
    const api = {
      select: (c) => { calls.push([name, "select", c]); cols = String(c).split(",").map((x) => x.trim()); return api; },
      eq: (c, v) => { calls.push([name, "eq", c, v]); filters.push((r) => r[c] === v); return api; },
      maybeSingle: async () => { if (errors[name]) return { data: null, error: { message: errors[name] } }; const row = (tables[name] || []).filter((r) => filters.every((f) => f(r)))[0] ?? null; return { data: row && cols ? Object.fromEntries(cols.map((c) => [c, row[c]])) : row, error: null }; },
    };
    return api;
  };
  return { from, calls };
}

test("4B store: the sender row carries its organization, and leads are looked up for the user only", async () => {
  const svc = fakeService({
    email_accounts: [{ id: ACC, organization_id: ORG, provider: "resend", address: "john@studiokairegi.com", display_name: "S", status: "active" }, { id: ACC2, organization_id: ORG_B, provider: "resend", address: "x@y.test", display_name: "", status: "active" }],
    email_conversations: [{ id: CONV, organization_id: ORG, account_id: ACC, lead_id: LEAD }],
    leads: [{ id: LEAD, user_id: "U1" }, { id: LEAD_OTHER, user_id: "U2" }],
  });
  const store = makeSendStore(svc);
  const acc = await store.getAccount(ORG, ACC);
  assert.equal(acc.organization_id, ORG);
  assert.equal(await store.getAccount(ORG, ACC2), null, "another organization's account is invisible");
  assert.ok(svc.calls.some((c) => c[0] === "email_accounts" && c[1] === "select" && /organization_id/.test(c[2])));
  assert.deepEqual(await store.getLeadForUser("U1", LEAD), { id: LEAD, email: undefined });
  assert.equal(await store.getLeadForUser("U1", LEAD_OTHER), null, "someone else's lead is invisible");
  assert.equal(await store.getLeadForUser("U9", LEAD), null);
  assert.deepEqual(await store.getConversationLead(ORG, CONV, ACC), { lead_id: LEAD });
  assert.equal(await store.getConversationLead(ORG_B, CONV, ACC), null, "conversation association is scoped to organization and sender account");
  const conversationFilters = svc.calls.filter((c) => c[0] === "email_conversations" && c[1] === "eq").map((c) => c[2]);
  assert.ok(conversationFilters.includes("id") && conversationFilters.includes("organization_id") && conversationFilters.includes("account_id"));
  await assert.rejects(() => makeSendStore(fakeService({}, { email_conversations: "db down" })).getConversationLead(ORG, CONV, ACC), /conversation CRM lookup/);
  const leadFilters = svc.calls.filter((c) => c[0] === "leads" && c[1] === "eq").map((c) => c[2]);
  assert.ok(leadFilters.includes("id") && leadFilters.includes("user_id"), "the user filter is the authorization and must stay on the query");
  await assert.rejects(() => makeSendStore(fakeService({}, { leads: "permission denied" })).getLeadForUser("U1", LEAD), /lead lookup/);   // a database failure never reads as "not found"
});

// ------------------------------------------------------------------------------------------------ structure and isolation
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const sendInnerSource = () => { const s = read("../../supabase/functions/_shared/email_resend_logic.ts"); const a = s.indexOf("async function sendInner"); return s.slice(a, s.indexOf("// Webhook", a)).replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, ""); };

test("4B structure: sendInner chooses the adapter from the account row and never reads provider identity from the request", () => {
  const src = sendInnerSource();
  assert.match(src, /resolveAdapter\(account\.provider, await deps\.store\.getProviderRegistryRow\(String\(account\.provider/);
  assert.equal(/\braw\.|\bv\.value\.provider|\br\.provider|\br\.adapter|\bbody\.provider/.test(src.replace(/validateSendRequest\(raw\)/, "")), false);
  assert.equal(/resend|gmail|zoho|smtp/i.test(src.replace(/upgrade the \$\{adapter\.displayName\} plan/, "")), false, "no provider name in the shared dispatch");
  assert.match(src, /account\.organization_id !== auth\.organizationId/);
  assert.match(src, /getLeadForUser\(auth\.userId/);
  assert.equal(/input[^;]*lead|adapterAccount[^;]*lead|crm/.test(src.slice(src.indexOf("const input: AdapterSendInput"), src.indexOf("let outcome"))), false, "no CRM context in the adapter input");
});

test("4B isolation: the Intelligence and shared Resend entry points are byte-identical to the Phase 3 package (line endings ignored)", () => {
  // Roadmap rule 7: transactional / Intelligence Resend paths stay untouched through 4A-4F. Update a hash ONLY with explicit approval.
  const sha = (p) => crypto.createHash("sha256").update(read(p).replace(/\r\n/g, "\n")).digest("hex");
  const pinned = {
    "intel-resend-send/index.ts": "be3c655e60393b20b80836b412b32cd49fca56268653e36b0dce4ce319acb113",
    "intel-resend-webhook/index.ts": "ac28b6b41a340ff265c80b1cde7fe657f4a33055432dbd53accb19a3d59f6b81",
    "resend-webhook/index.ts": "1a1efa7f669ff0fd5027ba7a745e5eeb878d0fb37d89228004caa622b95b9be2",
    "_shared/provider_guard.ts": "478c8cf2a44def03d669741b8c2ba9031fbd7688f0f7c4c3b5758b9b9b6ae44b",
    "_shared/intel_resend_logic.ts": "e8f64bf8b8fd1ef37cc502e045df92275eec60ea9a0f4d89138a20325ee5bb12",
  };
  for (const [file, hash] of Object.entries(pinned)) assert.equal(sha(`../../supabase/functions/${file}`), hash, `${file} changed`);
  for (const f of ["intel-resend-send/index.ts", "intel-resend-webhook/index.ts", "_shared/intel_resend_logic.ts", "_shared/provider_guard.ts"]) {
    assert.equal(/getLeadForUser|sanitizeProviderMessage|SendResponseV2/.test(read(`../../supabase/functions/${f}`)), false, `${f} must not depend on the 4B send changes`);
  }
});

test("browser dispatch never supplies provider identity and the active composer only forwards an optional CRM lead claim", () => {
  for (const f of ["api.js", "lib/api.js"]) {
    const src = read(`./${f}`);
    const body = src.slice(src.indexOf('functions.invoke("email-send"'), src.indexOf("// functions.invoke hides"));
    assert.equal(/provider|adapter|organization/i.test(body), false, f);
    if (f === "lib/api.js") assert.match(body, /crm: m\.crmLeadId \? \{ lead_id: m\.crmLeadId \} : null/);
    else assert.equal(/crm|lead/i.test(body), false, f);
  }
});


// ------------------------------------------------------------------------------------------------ Phase 4C: idempotency and ambiguous outcomes

test("4C: repeating an unknown key returns unknown and never calls the provider again", async () => {
  const h = two({ fake: { outcome: { ok: false, unknown: true, retryable: true, status: 0, message: "socket timeout", attempts: 1 } } });
  const request = goodReq({ account_id: ACC2 });
  const first = await handleSend(post(request), h.deps);
  assert.equal(first.status, 202);
  const second = await handleSend(post(request), h.deps);
  const body = await second.json();
  assert.equal(second.status, 202);
  assert.deepEqual([body.outcome, body.retry_with_same_key, body.duplicate], ["unknown", true, true]);
  assert.equal(h.fm.calls.length, 1, "the repeated key is lookup-only");
});

test("4C: a repeated key for an accepted message returns a successful duplicate without resending", async () => {
  const h = two();
  const request = goodReq({ account_id: ACC2 });
  assert.equal((await handleSend(post(request), h.deps)).status, 200);
  const repeated = await handleSend(post(request), h.deps);
  const body = await repeated.json();
  assert.equal(repeated.status, 200);
  assert.deepEqual([body.ok, body.outcome, body.duplicate, body.status], [true, "duplicate", true, "sent"]);
  assert.equal(h.fm.calls.length, 1);
});

test("4C: a concurrent queued/sending row is unknown, not a successful duplicate and never triggers dispatch", async () => {
  for (const status of ["queued", "sending"]) {
    const h = two({ duplicateStatus: status });
    const response = await handleSend(post(goodReq({ account_id: ACC2 })), h.deps);
    const body = await response.json();
    assert.equal(response.status, 202, status);
    assert.deepEqual([body.outcome, body.retry_with_same_key, body.duplicate], ["unknown", true, true], status);
    assert.equal(h.fm.calls.length, 0, status);
    assert.equal(h.log.created.length, 0, status);
  }
});

test("4C: post-acceptance database writes are retried without repeating the provider call and audit retains provider id", async () => {
  const h = two({ markFailCount: 2 });
  const response = await handleSend(post(goodReq({ account_id: ACC2 })), h.deps);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual([body.outcome, body.warning], ["accepted", undefined]);
  assert.equal(h.fm.calls.length, 1);
  assert.equal(h.log.sentWrites, 3);
  assert.equal(h.log.audit.find((e) => e.event === "send_result").provider_message_id, "fm_1");
});

test("4C: if all post-acceptance writes fail, success is still returned and provider id remains in audit", async () => {
  const h = two({ markFailCount: 3 });
  const response = await handleSend(post(goodReq({ account_id: ACC2 })), h.deps);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual([body.outcome, body.warning], ["accepted", "sent_status_not_saved"]);
  assert.equal(h.fm.calls.length, 1);
  assert.equal(h.log.audit.find((e) => e.event === "send_result").provider_message_id, "fm_1");
});
