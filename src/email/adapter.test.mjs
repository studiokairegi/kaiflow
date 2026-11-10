// Multi-provider plan, phase 3: adapter contract, server-side adapter selection, capability errors, and the preserved Resend path.
// Everything runs against fakes (no network, no database). Nothing here talks to Resend.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  ADAPTER_OPERATIONS, REQUIRED_OPERATIONS, AdapterError, CapabilityError, adapterSupports, requireOperation, adapterProblems,
} from "../../supabase/functions/_shared/email_adapter.ts";
import { resolveAdapter, effectiveOperations, requireResolvedOperation, normalizeRegistryRow, publicCapabilities, BUILTIN_ADAPTERS } from "../../supabase/functions/_shared/email_adapter_registry.ts";
import { resendAdapter, buildResendPayload, resendGet } from "../../supabase/functions/_shared/email_adapter_resend.ts";
import { handleSend, handleWebhook, webhookProviderAllowed, providerEventId, validateSendRequest } from "../../supabase/functions/_shared/email_resend_logic.ts";

const ORG = "20000000-0000-0000-0000-00000000000a";
const ACC = "30000000-0000-0000-0000-00000000000b";
const ACC2 = "30000000-0000-0000-0000-00000000000c";
const CONV = "aaaaaaaa-1111-2222-3333-444444444444";
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const noSleep = async () => {};
const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers });

const RESEND_ROW = { provider_key: "resend", adapter_key: "resend", display_name: "Resend", enabled: true,
  capabilities: { send: true, inbound_webhook: true, delivery_events: true, attachments_send: true, attachments_receive: true, threading_headers: true, drafts_local: true, remote_sync: false, remote_search: false, remote_folders: false, remote_drafts: false, oauth: false } };

/** A second provider that exists only in this test file: proves a provider can be added without touching shared logic. */
function makeFakeAdapter(over = {}) {
  const calls = [];
  const adapter = {
    providerKey: "fakemail", adapterKey: "fakemail", displayName: "FakeMail", operations: ["send", "reply", "forward", "list_folders"],
    legacyFlagKey: null, defaultDailyLimit: 5, dailyLimitEnv: "FAKEMAIL_DAILY_LIMIT",
    configurationProblem: (env) => (env("FAKEMAIL_TOKEN") ? null : "FakeMail is not configured"),
    async send(ctx, account, input) { calls.push({ ctx, account, input }); if (over.throws) throw new Error("boom secret=abc"); return over.outcome || { ok: true, providerMessageId: "fm_1", attempts: 1 }; },
    async listFolders() { return [{ id: "INBOX" }]; },
    ...over.members,
  };
  return { adapter, calls };
}
const FAKE_ROW = { provider_key: "fakemail", adapter_key: "fakemail", display_name: "FakeMail", enabled: true, capabilities: { send: true, remote_folders: true, remote_sync: false } };

// ------------------------------------------------------------------------------------------------ contract
test("contract: send is the only required operation; every operation name is unique and known", () => {
  assert.deepEqual([...REQUIRED_OPERATIONS], ["send"]);
  assert.equal(new Set(ADAPTER_OPERATIONS).size, ADAPTER_OPERATIONS.length);
  for (const op of ["connect", "disconnect", "validate_connection", "list_folders", "sync", "fetch_message", "search", "save_draft", "reply", "forward", "fetch_attachment", "upload_attachment", "mark_read", "archive", "move", "delivery_status"]) assert.ok(ADAPTER_OPERATIONS.includes(op), op);
});

test("contract: the Resend adapter satisfies it and declares only what it really does", () => {
  assert.deepEqual(adapterProblems(resendAdapter), []);
  assert.equal(resendAdapter.providerKey, "resend");
  assert.deepEqual([...resendAdapter.operations].sort(), ["forward", "reply", "send"]);
  for (const op of ["list_folders", "sync", "search", "save_draft", "mark_read", "archive", "move", "fetch_attachment", "connect"]) {
    assert.equal(adapterSupports(resendAdapter, op), false, op);
    assert.throws(() => requireOperation(resendAdapter, op), (e) => e instanceof CapabilityError && e.code === "unsupported_operation" && e.status === 501 && e.provider === "resend" && e.operation === op);
  }
});

test("contract: a declaration cannot lie. Declared but not implemented is unsupported; unknown or missing required operations are problems", () => {
  const { adapter } = makeFakeAdapter({ members: { listFolders: undefined } });
  assert.equal(adapterSupports(adapter, "list_folders"), false);                        // declared, no function
  assert.equal(adapterSupports(makeFakeAdapter().adapter, "list_folders"), true);
  assert.ok(adapterProblems({ ...makeFakeAdapter().adapter, operations: ["list_folders"] }).some((p) => /required operation "send"/.test(p)));
  assert.ok(adapterProblems({ ...makeFakeAdapter().adapter, operations: ["send", "teleport"] }).some((p) => /unknown operation/.test(p)));
  assert.ok(adapterProblems({ ...makeFakeAdapter().adapter, providerKey: "Bad Key" }).some((p) => /providerKey/.test(p)));
  assert.ok(adapterProblems({ ...makeFakeAdapter().adapter, send: undefined }).some((p) => /required operation "send"/.test(p)));
});

test("contract: connect/move/fetch_message have no optional method yet, so even a declared operation is refused until a later phase adds it", () => {
  const { adapter } = makeFakeAdapter({ members: { operations: ["send", "connect", "move", "fetch_message"] } });
  for (const op of ["connect", "move", "fetch_message"]) assert.equal(adapterSupports(adapter, op), false, op);
});

test("errors: normalised codes map to stable HTTP statuses and never carry secrets", () => {
  const expected = { unsupported_operation: 501, provider_not_registered: 409, provider_disabled: 503, adapter_unavailable: 503, not_configured: 503, account_not_usable: 409, rate_limited: 429, provider_rejected: 422, provider_unavailable: 502, outcome_unknown: 202 };
  for (const [code, status] of Object.entries(expected)) assert.equal(new AdapterError(code, "m").status, status, code);
  assert.equal(new AdapterError("provider_rejected", "m", { status: 400 }).status, 400);
  assert.ok(new CapabilityError("x", "sync") instanceof AdapterError);
});

// ------------------------------------------------------------------------------------------------ registry / selection
test("selection: the adapter comes from the database registry row for the account's provider", () => {
  const r = resolveAdapter("resend", RESEND_ROW);
  assert.equal(r.adapter, resendAdapter);
  assert.deepEqual([...r.operations].sort(), ["forward", "reply", "send"]);
  assert.deepEqual(publicCapabilities(r), { provider: "resend", display_name: "Resend", operations: r.operations });
  assert.deepEqual(Object.keys(BUILTIN_ADAPTERS), ["resend"]);                           // Gmail/Zoho are not built in
});

test("selection: unknown, mismatched, disabled and uninstalled providers are refused with normalised codes", () => {
  const code = (fn) => { try { fn(); } catch (e) { return e.code; } return "none"; };
  assert.equal(code(() => resolveAdapter("", RESEND_ROW)), "provider_not_registered");
  assert.equal(code(() => resolveAdapter(undefined, RESEND_ROW)), "provider_not_registered");
  assert.equal(code(() => resolveAdapter("resend", null)), "provider_not_registered");
  assert.equal(code(() => resolveAdapter("gmail", RESEND_ROW)), "provider_not_registered");            // row is for another provider
  assert.equal(code(() => resolveAdapter("resend", { ...RESEND_ROW, enabled: false })), "provider_disabled");
  assert.equal(code(() => resolveAdapter("fakemail", FAKE_ROW)), "adapter_unavailable");                 // registry row but no adapter installed
  assert.equal(code(() => resolveAdapter("resend", { ...RESEND_ROW, adapter_key: "__proto__" })), "adapter_unavailable");
  assert.equal(code(() => resolveAdapter("resend", { ...RESEND_ROW, adapter_key: "constructor" })), "adapter_unavailable");
  assert.equal(code(() => resolveAdapter("resend", { ...RESEND_ROW, capabilities: [] })), "provider_not_registered");   // malformed row
  assert.equal(code(() => resolveAdapter("resend", { ...RESEND_ROW, enabled: "yes" })), "provider_not_registered");
  // an adapter that serves a different provider than the row names is refused, never "close enough"
  assert.equal(code(() => resolveAdapter("resend", { ...RESEND_ROW, adapter_key: "fakemail" }, { fakemail: makeFakeAdapter().adapter })), "adapter_unavailable");
  assert.equal(normalizeRegistryRow({ provider_key: "x" }), null);
});

test("selection: the registry can only narrow what code offers, never widen it", () => {
  const narrow = resolveAdapter("resend", { ...RESEND_ROW, capabilities: { ...RESEND_ROW.capabilities, send: false } });
  assert.deepEqual(narrow.operations, []);                                                              // send switched off in the registry
  assert.throws(() => requireResolvedOperation(narrow, "send"), (e) => e instanceof CapabilityError);
  const widened = { ...RESEND_ROW, capabilities: { ...RESEND_ROW.capabilities, remote_sync: true, remote_folders: true, remote_search: true } };
  assert.deepEqual([...effectiveOperations(resendAdapter, normalizeRegistryRow(widened))].sort(), ["forward", "reply", "send"]);   // registry claims sync, code has none
  const r = resolveAdapter("fakemail", FAKE_ROW, { fakemail: makeFakeAdapter().adapter });
  assert.deepEqual([...r.operations].sort(), ["forward", "list_folders", "reply", "send"]);
  requireResolvedOperation(r, "list_folders");
  assert.throws(() => requireResolvedOperation(r, "sync"), (e) => e.code === "unsupported_operation");
});

// ------------------------------------------------------------------------------------------------ shared send service
function harness(over = {}) {
  const log = { created: [], marks: [], fetches: [], audit: [], counts: [], parents: [], attachments: [] };
  const accounts = { [ACC]: { id: ACC, organization_id: ORG, provider: over.accountProvider ?? "resend", address: "john@studiokairegi.com", display_name: "Studio Kairegi", status: "active" }, [ACC2]: { id: ACC2, organization_id: ORG, provider: "fakemail", address: "ann@fake.test", display_name: "Ann", status: "active" } };
  const rows = [];
  const store = {
    providerEnabled: async (k) => { log.flagAsked = k; return over.flag ?? true; },
    getProviderRegistryRow: async (k) => (over.rows ? over.rows[k] ?? null : k === "resend" ? RESEND_ROW : null),
    getAccount: async (org, id) => (org === ORG ? accounts[id] ?? null : null),
    getThreadParent: async (org, conv, acc) => { log.parents.push([org, conv, acc]); return null; },
    getConversationLead: async () => null,
    recordCrmActivity: async () => ({ recorded: true, duplicate: false }),
    countOutboundSince: async (org, since, provider) => { log.counts.push({ minute: Date.parse(since) > NOW - 120_000, provider }); return Date.parse(since) > NOW - 120_000 ? (over.perMinute ?? 0) : (over.perDay ?? 0); },
    createOutbound: async (p) => { const d = rows.find((r) => r.idempotency_key === p.idempotency_key); if (d) return { duplicate: true, message_id: "M1", conversation_id: CONV, status: "sent" }; rows.push(p); log.created.push(p); return { duplicate: false, message_id: "M1", conversation_id: p.conversation_id || CONV, status: "queued" }; },
    markResult: async (_id, patch) => { log.marks.push(patch); },
    saveAttachments: async (...a) => { log.attachments.push(a); },
  };
  const deps = {
    env: (k) => ({ RESEND_API_KEY: "re_secret_key", FAKEMAIL_TOKEN: "fm_secret_token", ...(over.env || {}) })[k],
    fetch: over.fetch || (async (url, init) => { log.fetches.push({ url, init }); return json({ id: "re_sent_1" }); }),
    now: () => NOW, sleep: noSleep, store, audit: (e) => log.audit.push(e), adapters: over.adapters,
    authenticate: async (req) => (req.headers.get("authorization") === "Bearer good" ? { ok: true, userId: "U1", organizationId: ORG } : { ok: false, status: 401, error: "Not authenticated" }),
  };
  return { deps, log };
}
const goodReq = (o = {}) => ({ account_id: ACC, to: ["ada@client.com"], cc: [], bcc: [], subject: "Hello", text: "Body", html: "", reply_to: "", conversation_id: null, draft_id: null, idempotency_key: "idem-12345678", attachments: [], ...o });
const post = (body) => new Request("https://x/functions/v1/email-send", { method: "POST", headers: { authorization: "Bearer good", "content-type": "application/json" }, body: JSON.stringify(body) });

test("send: the Resend adapter is used through the contract and the wire behaviour is unchanged", async () => {
  const { deps, log } = harness();
  const res = await handleSend(post(goodReq({ conversation_id: CONV })), deps);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "sent");
  assert.equal(log.fetches.length, 1);
  assert.equal(log.fetches[0].url, "https://api.resend.com/emails");
  assert.equal(log.fetches[0].init.headers.Authorization, "Bearer re_secret_key");
  assert.equal(log.fetches[0].init.headers["Idempotency-Key"], "kf-idem-12345678");
  const sent = JSON.parse(log.fetches[0].init.body);
  assert.equal(sent.from, "Studio Kairegi <john@studiokairegi.com>");
  assert.deepEqual(sent, buildResendPayload({ fromEmail: "john@studiokairegi.com", fromName: "Studio Kairegi", req: validateSendRequest(goodReq({ conversation_id: CONV })).value, thread: null, replyTo: sent.reply_to || "" }));
  assert.equal(log.marks.at(-1).provider_message_id, "re_sent_1");
  assert.equal(log.flagAsked, undefined, "general Email never consults the shared email_provider_flags (Intelligence owns it)");
});

test("send: a provider name in the request body is never read. The account row decides", async () => {
  const a = harness();
  const r1 = await handleSend(post({ ...goodReq(), provider: "gmail", adapter: "gmail", adapter_key: "gmail" }), a.deps);
  assert.equal(r1.status, 200);
  assert.equal(a.log.fetches.length, 1);                                                                // still Resend
  const fm = makeFakeAdapter();
  const b = harness({ adapters: { fakemail: fm.adapter }, rows: { resend: RESEND_ROW, fakemail: FAKE_ROW } });
  const r2 = await handleSend(post({ ...goodReq({ account_id: ACC2 }), provider: "resend" }), b.deps);
  assert.equal(r2.status, 200);
  assert.equal(b.log.fetches.length, 0, "the request said resend; the account is fakemail, so Resend must not be called");
  assert.equal(fm.calls.length, 1);
  assert.equal(validateSendRequest({ ...goodReq(), provider: "gmail" }).value.provider, undefined);     // not even carried through validation
});

test("send: adding a provider needs no change to shared logic. A second adapter sends, threads, rate limits and reports through the same service", async () => {
  const fm = makeFakeAdapter();
  const h = harness({ adapters: { fakemail: fm.adapter }, rows: { resend: RESEND_ROW, fakemail: FAKE_ROW }, env: { EMAIL_THREAD_TOKENS: "off" } });
  const res = await handleSend(post(goodReq({ account_id: ACC2, cc: ["c@x.com"], conversation_id: CONV })), h.deps);
  const body = await res.json();
  assert.equal(res.status, 200); assert.equal(body.status, "sent");
  const c = fm.calls[0];
  assert.equal(c.account.provider, "fakemail");
  assert.equal(c.account.organization_id, ORG);
  assert.deepEqual(c.input.to, ["ada@client.com"]); assert.deepEqual(c.input.cc, ["c@x.com"]);
  assert.equal(c.input.idempotencyKey, "idem-12345678");
  assert.equal(h.log.marks.at(-1).provider_message_id, "fm_1");
  assert.deepEqual(h.log.parents[0], [ORG, CONV, ACC2]);                                                // thread parent is scoped to the sending account
  assert.equal(h.log.flagAsked, undefined, "an adapter with no legacy flag does not consult email_provider_flags");
  // its own daily quota (5) applies, not Resend's
  const limited = harness({ adapters: { fakemail: fm.adapter }, rows: { resend: RESEND_ROW, fakemail: FAKE_ROW }, perDay: 5 });
  const lr = await handleSend(post(goodReq({ account_id: ACC2 })), limited.deps);
  assert.equal(lr.status, 429); assert.match((await lr.json()).error, /Daily sending limit reached \(5\).*FakeMail plan/);
  const env = harness({ adapters: { fakemail: fm.adapter }, rows: { resend: RESEND_ROW, fakemail: FAKE_ROW }, perDay: 5, env: { FAKEMAIL_DAILY_LIMIT: "50" } });
  assert.equal((await handleSend(post(goodReq({ account_id: ACC2 })), env.deps)).status, 200);
});

test("send: the daily quota is per provider, the per-minute burst limit covers all of the organization's mail", async () => {
  const { deps, log } = harness();
  await handleSend(post(goodReq()), deps);
  const minute = log.counts.find((c) => c.minute), day = log.counts.find((c) => !c.minute);
  assert.equal(minute.provider, undefined);
  assert.equal(day.provider, "resend");
});

test("send: unusable providers are refused before anything is stored or sent, with normalised codes", async () => {
  const cases = [
    ["unregistered provider on the account", { accountProvider: "gmail" }, 409, "provider_not_registered"],
    ["registry row disabled", { rows: { resend: { ...RESEND_ROW, enabled: false } } }, 503, "provider_disabled"],
    ["no registry row at all", { rows: {} }, 409, "provider_not_registered"],
    ["registry names an adapter that is not installed", { accountProvider: "fakemail", rows: { fakemail: FAKE_ROW } }, 503, "adapter_unavailable"],
  ];
  for (const [name, over, status, code] of cases) {
    const h = harness(over);
    const res = await handleSend(post(goodReq()), h.deps);
    const body = await res.json();
    assert.equal(res.status, status, name); assert.equal(body.code, code, name);
    assert.equal(h.log.fetches.length, 0, name); assert.equal(h.log.created.length, 0, name);
    assert.equal(h.log.audit[0].event, "send_refused", name); assert.equal(h.log.audit[0].code, code, name);
  }
  const noKey = harness({ env: { RESEND_API_KEY: "" } });
  const nk = await handleSend(post(goodReq()), noKey.deps);
  assert.equal(nk.status, 503); assert.equal((await nk.json()).code, "not_configured"); assert.equal(noKey.log.created.length, 0);
  // KF-02: the shared flag (written by Intelligence's admin switch) must NOT switch general Email off; only the Email registry row does.
  const flagOff = harness({ flag: false });
  const fo = await handleSend(post(goodReq()), flagOff.deps);
  assert.equal(fo.status, 200); assert.equal(flagOff.log.flagAsked, undefined); assert.equal(flagOff.log.fetches.length, 1);
  const missingProvider = harness();
  missingProvider.deps.store.getAccount = async () => ({ id: ACC, organization_id: ORG, address: "j@x.com", display_name: "", status: "active" });   // a row with no provider must never default to Resend
  const mp = await handleSend(post(goodReq()), missingProvider.deps);
  assert.equal(mp.status, 409); assert.equal(missingProvider.log.fetches.length, 0);
});

test("send: an adapter that throws is reported as an unknown outcome, never a clean failure, never with its message", async () => {
  const fm = makeFakeAdapter({ throws: true });
  const h = harness({ adapters: { fakemail: fm.adapter }, rows: { resend: RESEND_ROW, fakemail: FAKE_ROW } });
  const res = await handleSend(post(goodReq({ account_id: ACC2 })), h.deps);
  assert.equal(res.status, 202);
  const text = JSON.stringify(await res.json());
  assert.equal(text.includes("secret=abc"), false);
  assert.equal(h.log.marks.at(-1).status, "sending");                                                   // stays visible for a person to check
  assert.equal(h.log.audit.at(-1).status, "unknown");
});

test("send: adapter-reported failures keep the existing status mapping (4xx rejected, 5xx failed, unknown never auto-retried)", async () => {
  const rej = makeFakeAdapter({ outcome: { ok: false, unknown: false, retryable: false, status: 403, message: "domain not verified", attempts: 1 } });
  const a = harness({ adapters: { fakemail: rej.adapter }, rows: { resend: RESEND_ROW, fakemail: FAKE_ROW } });
  assert.equal((await handleSend(post(goodReq({ account_id: ACC2 })), a.deps)).status, 422);
  assert.equal(a.log.marks.at(-1).status, "rejected");
  const bad = makeFakeAdapter({ outcome: { ok: false, unknown: false, retryable: true, status: 503, message: "down", attempts: 3 } });
  const b = harness({ adapters: { fakemail: bad.adapter }, rows: { resend: RESEND_ROW, fakemail: FAKE_ROW } });
  assert.equal((await handleSend(post(goodReq({ account_id: ACC2 })), b.deps)).status, 502);
  assert.equal(b.log.marks.at(-1).status, "failed");
  const unk = makeFakeAdapter({ outcome: { ok: false, unknown: true, retryable: true, status: 0, message: "net", attempts: 3 } });
  const c = harness({ adapters: { fakemail: unk.adapter }, rows: { resend: RESEND_ROW, fakemail: FAKE_ROW } });
  assert.equal((await handleSend(post(goodReq({ account_id: ACC2 })), c.deps)).status, 202);
  assert.equal(unk.calls.length, 1);                                                                    // exactly one call: no automatic resend
});

test("send: audit records carry ids and outcomes only. No addresses, subject, body, attachment names or credentials", async () => {
  const h = harness();
  await handleSend(post(goodReq({ subject: "Top secret subject", text: "confidential body", to: ["private@person.com"], attachments: [{ filename: "salary.pdf", content_base64: "aGk=" }] })), h.deps);
  assert.deepEqual(h.log.audit.map((e) => e.event), ["send_attempt", "send_result"]);
  const dump = JSON.stringify(h.log.audit);
  for (const secret of ["private@person.com", "Top secret subject", "confidential body", "salary.pdf", "re_secret_key", "john@studiokairegi.com"]) assert.equal(dump.includes(secret), false, secret);
  assert.equal(h.log.audit.at(-1).status, "sent"); assert.equal(h.log.audit.at(-1).provider, "resend");
});

test("send: an idempotent repeat does not call the adapter a second time", async () => {
  const fm = makeFakeAdapter();
  const h = harness({ adapters: { fakemail: fm.adapter }, rows: { resend: RESEND_ROW, fakemail: FAKE_ROW } });
  await handleSend(post(goodReq({ account_id: ACC2 })), h.deps);
  const again = await handleSend(post(goodReq({ account_id: ACC2 })), h.deps);
  assert.equal((await again.json()).duplicate, true);
  assert.equal(fm.calls.length, 1);
});

// ------------------------------------------------------------------------------------------------ Resend adapter, preserved safeguards
test("resend adapter: refuses without a key (nothing is sent), reports unknown outcomes, keeps the idempotency key and bounded retries", async () => {
  const ctx = (env, fetchFn) => ({ env: (k) => env[k], fetch: fetchFn, now: () => NOW, sleep: noSleep });
  const input = { fromEmail: "j@x.com", fromName: "J", to: ["a@x.com"], cc: [], bcc: [], subject: "S", text: "T", html: "", replyTo: "", thread: null, attachments: [], idempotencyKey: "key-12345678", correlationId: "50000000-0000-4000-8000-000000000001" };
  let called = 0;
  const none = await resendAdapter.send(ctx({}, async () => { called++; return json({}); }), {}, input);
  assert.equal(none.ok, false); assert.equal(called, 0);
  assert.equal(resendAdapter.configurationProblem((k) => ({})[k]), "Email sending is not configured yet");
  assert.equal(resendAdapter.configurationProblem((k) => ({ RESEND_API_KEY: "k" })[k]), null);
  const seq = [json({ message: "slow" }, 429), json({ message: "boom" }, 503), json({ id: "re_9" })];
  const seen = [];
  const ok = await resendAdapter.send(ctx({ RESEND_API_KEY: "k" }, async (u, i) => { seen.push(i.headers["Idempotency-Key"]); return seq.shift(); }), {}, input);
  assert.deepEqual(ok, { ok: true, providerMessageId: "re_9", attempts: 3 });
  assert.deepEqual(seen, ["kf-key-12345678", "kf-key-12345678", "kf-key-12345678"]);
  // Provider webhook metadata carries only the persisted internal message UUID, never browser input.
  const tagged = JSON.parse((await (async () => {
    let body;
    await resendAdapter.send(ctx({ RESEND_API_KEY: "k" }, async (_u, init) => { body = JSON.parse(init.body); return json({ id: "re_tagged" }); }), {}, input);
    return JSON.stringify(body);
  })()));
  assert.deepEqual(tagged.tags, [{ name: "kf_message_id", value: "50000000-0000-4000-8000-000000000001" }]);
  const net = await resendAdapter.send(ctx({ RESEND_API_KEY: "k" }, async () => { throw new Error("reset"); }), {}, input);
  assert.equal(net.ok, false); assert.equal(net.unknown, true);
  const four = await resendAdapter.send(ctx({ RESEND_API_KEY: "k" }, async () => json({ message: "nope" }, 422)), {}, input);
  assert.equal(four.attempts, 1); assert.equal(four.retryable, false);
});

test("resendGet: retries only 429/5xx, and its error text never contains ids or keys", async () => {
  let n = 0;
  await assert.rejects(() => resendGet({ fetch: async () => { n++; return json({}, 404); }, sleep: noSleep }, "re_key", "/emails/receiving/SECRET_ID"), (e) => !/SECRET_ID|re_key/.test(e.message) && /\(404\)/.test(e.message));
  assert.equal(n, 1);
});

// ------------------------------------------------------------------------------------------------ webhook ingress (the Resend adapter's inbound transport)
function hookStore(over = {}) {
  return {
    providerEnabled: async () => { if (over.flagError) throw new Error("flag read failed"); return over.flag ?? true; },
    getProviderRegistryRow: async () => { if (over.registryError) throw new Error("registry read failed"); return over.row === undefined ? RESEND_ROW : over.row; },
  };
}
test("webhook gate: enabled processes; switched off is acknowledged; a missing row, missing adapter or database error is NOT acknowledged", async () => {
  assert.equal(await webhookProviderAllowed(hookStore()), true);
  assert.equal(await webhookProviderAllowed(hookStore({ row: { ...RESEND_ROW, enabled: false } })), false);
  assert.equal(await webhookProviderAllowed(hookStore({ flag: false })), true);                          // the shared Intelligence flag no longer gates general Email
  await assert.rejects(() => webhookProviderAllowed(hookStore({ row: null })), /registry row is missing/);
  await assert.rejects(() => webhookProviderAllowed(hookStore({ row: { ...RESEND_ROW, adapter_key: "nope" } })), (e) => e.code === "adapter_unavailable");
  await assert.rejects(() => webhookProviderAllowed(hookStore({ registryError: true })), /registry read failed/);
  assert.equal(await webhookProviderAllowed(hookStore({ flagError: true })), true);                       // the shared flag is not even read, so its failure cannot affect Email
});

test("webhook: a missing registry row answers 500 (so Resend retries) and claims nothing", async () => {
  const SECRET_BYTES = "test-secret-bytes-0123456789abcd";
  const SECRET = "whsec_" + Buffer.from(SECRET_BYTES).toString("base64");
  const body = JSON.stringify({ type: "email.delivered", data: { email_id: "re_1", to: ["a@b.com"] } });
  const key = await crypto.subtle.importKey("raw", Buffer.from(SECRET_BYTES), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const ts = Math.floor(NOW / 1000);
  const mac = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`msg_1.${ts}.${body}`))).toString("base64");
  let claimed = 0;
  const store = { ...hookStore({ row: null }), claimWebhook: async () => { claimed++; return { state: "done" }; } };
  const res = await handleWebhook(new Request("https://x", { method: "POST", body, headers: { "svix-id": "msg_1", "svix-timestamp": String(ts), "svix-signature": `v1,${mac}` } }),
    { env: (k) => ({ RESEND_API_KEY: "k", RESEND_WEBHOOK_SECRET: SECRET })[k], fetch: async () => json({}), now: () => NOW, sleep: noSleep, store });
  assert.equal(res.status, 500);
  assert.equal(claimed, 0);
});

test("event ids: Resend keeps its bare Svix id (already stored that way); every later provider is prefixed", () => {
  assert.equal(providerEventId("resend", "msg_abc"), "msg_abc");
  assert.equal(providerEventId("gmail", "abc"), "gmail:abc");
  assert.equal(providerEventId("fakemail", "1"), "fakemail:1");
  assert.notEqual(providerEventId("fakemail", "msg_abc"), providerEventId("resend", "msg_abc"));
});

// ------------------------------------------------------------------------------------------------ structure: provider calls stay inside adapters
const read = (p) => fs.readFileSync(new URL(`../../supabase/functions/${p}`, import.meta.url), "utf8");
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("structure: api.resend.com and the Resend key appear only in the Resend adapter (and the webhook secret check in the shared webhook handler)", () => {
  for (const f of ["_shared/email_adapter.ts", "_shared/email_adapter_registry.ts", "_shared/email_common.ts", "_shared/email_resend_logic.ts", "_shared/email_resend_store.ts", "email-send/index.ts", "resend-webhook/index.ts"]) {
    const src = noComments(read(f));
    assert.equal(/api\.resend\.com/.test(src), false, `${f} must not name the Resend API`);
    assert.equal(/RESEND_API_KEY/.test(src.replace(/d\.env\("RESEND_API_KEY"\)/g, "")), false, `${f} must not read the Resend key outside the webhook transport`);
  }
  assert.equal(/deps\.env\("RESEND_API_KEY"\)/.test(read("_shared/email_resend_logic.ts")), false, "the send path no longer reads the Resend key itself");
  assert.match(read("_shared/email_adapter_resend.ts"), /export const RESEND_API = "https:\/\/api\.resend\.com"/);
});

test("structure: sendInner contains no provider-specific branch, only the contract", () => {
  const src = noComments(read("_shared/email_resend_logic.ts"));
  const send = src.slice(src.indexOf("async function sendInner"), src.indexOf("// Webhook"));
  assert.equal(/sendViaResend|buildResendPayload|"resend"|'resend'|gmail|zoho|outlook/i.test(send), false);
  assert.match(send, /resolveAdapter\(/); assert.match(send, /adapter\.send\(/);
});

test("structure: the new general-Email adapter files do not touch Intelligence", () => {
  for (const f of ["_shared/email_adapter.ts", "_shared/email_adapter_registry.ts", "_shared/email_adapter_resend.ts", "_shared/email_common.ts"]) {
    assert.equal(/intel_|intelligence|provider_guard|email_provider_flags/i.test(noComments(read(f))), false, f);
  }
});

test("structure: the browser-facing email-send entry point passes no provider and still wires only dependencies", () => {
  const src = read("email-send/index.ts");
  assert.equal(/provider/i.test(noComments(src)), false);
  assert.match(src, /makeSendStore\(service\)/);
});
