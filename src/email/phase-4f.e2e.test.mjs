// Phase 4F controlled end-to-end validation. Real send/webhook handlers, fake provider transports
// and an in-memory store; no live accounts, recipients, or production database are contacted.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { handleSend, processInbound, processDeliveryEvent } from "../../supabase/functions/_shared/email_resend_logic.ts";
import { resendAdapter } from "../../supabase/functions/_shared/email_adapter_resend.ts";

const ORG = "20000000-0000-0000-0000-00000000000a";
const ACC_RESEND = "30000000-0000-0000-0000-00000000000b";
const ACC_FAKE = "30000000-0000-0000-0000-00000000000c";
const LEAD = "40000000-0000-0000-0000-0000000000a1";
const CONV = "aaaaaaaa-1111-2222-3333-444444444444";
const RESEND_ROW = { provider_key: "resend", adapter_key: "resend", display_name: "Resend", enabled: true, capabilities: { send: true } };
const FAKE_ROW = { provider_key: "fakemail", adapter_key: "fakemail", display_name: "FakeMail", enabled: true, capabilities: { send: true } };
const json = (v, status = 200) => new Response(JSON.stringify(v), { status });

function fakeAdapter({ outcome = { ok: true, providerMessageId: "fake-accepted-1", attempts: 1 } } = {}) {
  const calls = [];
  return {
    calls,
    adapter: {
      providerKey: "fakemail", adapterKey: "fakemail", displayName: "FakeMail", operations: ["send", "reply", "forward"],
      legacyFlagKey: null, defaultDailyLimit: 50, configurationProblem: () => null,
      async send(_ctx, account, input) { calls.push({ account, input }); return outcome; },
    },
  };
}

function makeSystem({ resendResponse = () => json({ id: "resend-accepted-1" }), crmFails = 0, fakeOutcome } = {}) {
  const rows = new Map();
  const activities = new Set();
  const calls = { resend: [], crm: [], inbound: [], delivery: [] };
  let crmFailures = crmFails;
  const fake = fakeAdapter({ ...(fakeOutcome ? { outcome: fakeOutcome } : {}) });
  const accounts = {
    [ACC_RESEND]: { id: ACC_RESEND, organization_id: ORG, provider: "resend", address: "studio@example.test", display_name: "Studio", status: "active" },
    [ACC_FAKE]: { id: ACC_FAKE, organization_id: ORG, provider: "fakemail", address: "second@example.test", display_name: "Second", status: "active" },
  };
  const store = {
    providerEnabled: async () => true,
    getProviderRegistryRow: async (key) => key === "resend" ? RESEND_ROW : key === "fakemail" ? FAKE_ROW : null,
    getAccount: async (org, id) => org === ORG ? accounts[id] ?? null : null,
    getLeadForUser: async (user, id) => user === "user-1" && id === LEAD ? { id } : null,
    getConversationLead: async () => ({ lead_id: LEAD }),
    getThreadParent: async () => ({ rfc_message_id: "<previous@example.test>", references_ids: "<first@example.test>" }),
    countOutboundSince: async () => 0,
    createOutbound: async (p) => {
      const prior = rows.get(p.idempotency_key);
      if (prior) return { duplicate: true, message_id: prior.message_id, conversation_id: prior.conversation_id, status: prior.status, provider_message_id: prior.provider_message_id };
      const row = { ...p, provider: p.account_id === ACC_RESEND ? "resend" : "fakemail", message_id: `50000000-0000-4000-8000-${String(rows.size + 1).padStart(12, "0")}`, conversation_id: p.conversation_id || CONV, status: "queued", provider_message_id: null };
      rows.set(p.idempotency_key, row);
      return { duplicate: false, message_id: row.message_id, conversation_id: row.conversation_id, status: row.status };
    },
    markResult: async (id, patch) => {
      const row = [...rows.values()].find((r) => r.message_id === id);
      if (row) Object.assign(row, patch);
    },
    recordCrmActivity: async (id) => {
      calls.crm.push(id);
      if (crmFailures > 0) { crmFailures--; throw new Error("controlled CRM outage"); }
      const duplicate = activities.has(id);
      activities.add(id);
      return { recorded: true, duplicate };
    },
    saveAttachments: async () => {},
    reconcileTaggedDeliveryEvent: async (a) => {
      calls.delivery.push(a);
      const row = [...rows.values()].find((r) => r.message_id === a.message_id);
      if (!row) return { found: false };
      const expected = ["to_emails", "cc_emails", "bcc_emails"].flatMap((k) => row[k] || []).map((x) => x.toLowerCase());
      if (row.provider !== "resend" || a.sender_email !== "studio@example.test" || a.subject !== row.subject || !a.recipients.some((x) => expected.includes(x))) return { found: false, conflict: true };
      if (row.provider_message_id && row.provider_message_id !== a.provider_message_id) return { found: false, conflict: true };
      row.provider_message_id = a.provider_message_id;
      row.status = ({ "email.sent": "sent", "email.delivered": "delivered", "email.delivery_delayed": "delivery_delayed", "email.bounced": "bounced", "email.complained": "complained" })[a.event_type] || row.status;
      if (row.crm_lead_id) await store.recordCrmActivity(row.message_id);
      return { found: true, status: row.status };
    },
    applyDeliveryEvent: async (a) => {
      calls.delivery.push(a);
      const row = [...rows.values()].find((r) => r.provider_message_id === a.provider_message_id);
      if (!row) return { found: false };
      row.status = a.status;
      return { found: true, applied: true };
    },
    applyIntelDeliveryEvent: async () => ({ found: false }),
  };
  const deps = {
    env: (k) => ({ RESEND_API_KEY: "re_test_controlled", EMAIL_THREAD_TOKENS: "off" })[k],
    fetch: async (url, init) => { calls.resend.push({ url, init }); return resendResponse(url, init); },
    now: () => Date.UTC(2026, 10, 10, 12), sleep: async () => {}, store,
    adapters: { resend: resendAdapter, fakemail: fake.adapter },
    authenticate: async (req) => req.headers.get("authorization") === "Bearer controlled"
      ? { ok: true, userId: "user-1", organizationId: ORG }
      : { ok: false, status: 401, error: "Not authenticated" },
  };
  return { deps, store, rows, activities, calls, fake };
}

function sendRequest({ account = ACC_RESEND, key = "phase4f-key-0001", lead = LEAD, conversation = null, auth = "controlled" } = {}) {
  return new Request("https://controlled.invalid/functions/v1/email-send", {
    method: "POST", headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
    body: JSON.stringify({ account_id: account, to: ["recipient@example.test"], cc: [], bcc: [], subject: "Controlled Phase 4F", text: "Test body", html: "", reply_to: "", conversation_id: conversation, draft_id: null, idempotency_key: key, attachments: [], crm: lead ? { lead_id: lead } : null }),
  });
}

test("4F E2E: accepted CRM send records one activity; replay is lookup-only and does not submit twice", async () => {
  const s = makeSystem();
  const first = await handleSend(sendRequest(), s.deps);
  const firstBody = await first.json();
  assert.equal(first.status, 200);
  assert.equal(firstBody.outcome, "accepted");
  assert.deepEqual(firstBody.crm, { lead_id: LEAD, activity: "recorded" });
  assert.equal(s.calls.resend.length, 1);
  assert.equal(s.activities.size, 1);

  const replay = await handleSend(sendRequest(), s.deps);
  const replayBody = await replay.json();
  assert.equal(replay.status, 200);
  assert.equal(replayBody.outcome, "duplicate");
  assert.equal(s.calls.resend.length, 1, "accepted replay must not dispatch to provider again");
  assert.equal(s.activities.size, 1, "CRM activity is idempotent");
});

test("4F E2E: CRM outage after provider acceptance is repaired by same-key replay without another provider call", async () => {
  const s = makeSystem({ crmFails: 1 });
  const first = await handleSend(sendRequest({ key: "phase4f-crm-repair-0001" }), s.deps);
  const firstBody = await first.json();
  assert.equal(first.status, 200);
  assert.equal(firstBody.outcome, "accepted");
  assert.equal(firstBody.warning, "crm_activity_pending");
  assert.equal(s.calls.resend.length, 1);
  assert.equal(s.activities.size, 0);

  const retry = await handleSend(sendRequest({ key: "phase4f-crm-repair-0001" }), s.deps);
  const retryBody = await retry.json();
  assert.equal(retry.status, 200);
  assert.equal(retryBody.outcome, "duplicate");
  assert.deepEqual(retryBody.crm, { lead_id: LEAD, activity: "recorded" });
  assert.equal(s.calls.resend.length, 1, "CRM repair must never call the provider");
  assert.equal(s.activities.size, 1);
});

test("4F E2E: two connected sender accounts dispatch only through their database-selected adapters", async () => {
  const s = makeSystem();
  const a = await handleSend(sendRequest({ account: ACC_RESEND, key: "phase4f-resend-account" }), s.deps);
  const b = await handleSend(sendRequest({ account: ACC_FAKE, key: "phase4f-fake-account", lead: null }), s.deps);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(s.calls.resend.length, 1);
  assert.equal(s.fake.calls.length, 1);
  assert.equal(s.fake.calls[0].account.address, "second@example.test");
});

test("4F recovery: signed Resend webhook tag repairs accepted send after every post-acceptance DB write fails", async () => {
  const s = makeSystem();
  const mark = s.store.markResult;
  s.store.markResult = async (id, patch) => {
    if (patch.status === "sent") throw new Error("controlled database outage after provider acceptance");
    return mark(id, patch);
  };
  const response = await handleSend(sendRequest({ key: "phase4f-accepted-db-outage" }), s.deps);
  const body = await response.json();
  const row = s.rows.get("phase4f-accepted-db-outage");
  assert.equal(response.status, 200);
  assert.equal(body.outcome, "accepted");
  assert.equal(body.warning, "sent_status_not_saved");
  assert.equal(row.status, "sending");
  assert.equal(row.provider_message_id, null);
  assert.equal(s.activities.size, 0);
  assert.equal(s.calls.resend.length, 1);
  const wire = JSON.parse(s.calls.resend[0].init.body);
  assert.deepEqual(wire.tags, [{ name: "kf_message_id", value: row.message_id }]);

  const recovered = await processDeliveryEvent({ store: s.store, now: s.deps.now }, "svix-accepted-recovery", {
    type: "email.sent", created_at: "2026-11-10T12:00:01.000Z",
    data: { email_id: "resend-accepted-1", from: "Studio <studio@example.test>", to: ["recipient@example.test"], subject: "Controlled Phase 4F", tags: { kf_message_id: row.message_id } },
  });
  assert.equal(recovered.result, "processed");
  assert.equal(row.status, "sent");
  assert.equal(row.provider_message_id, "resend-accepted-1");
  assert.equal(s.activities.size, 1, "CRM activity is recovered from the already-accepted email");
  assert.equal(s.calls.resend.length, 1, "webhook reconciliation never resubmits the email");
});

test("4F E2E: ambiguous provider outcome remains unknown and repeated request cannot create a duplicate", async () => {
  const s = makeSystem({ resendResponse: async () => { throw new Error("controlled connection reset"); } });
  const req = sendRequest({ key: "phase4f-unknown-outcome" });
  const first = await handleSend(req, s.deps);
  const firstBody = await first.json();
  assert.equal(first.status, 202);
  assert.equal(firstBody.outcome, "unknown");
  const callsAfterFirst = s.calls.resend.length;
  const second = await handleSend(sendRequest({ key: "phase4f-unknown-outcome" }), s.deps);
  const secondBody = await second.json();
  assert.equal(second.status, 202);
  assert.equal(secondBody.outcome, "unknown");
  assert.equal(s.calls.resend.length, callsAfterFirst, "unknown outcome replay must not resubmit");
});

test("4F E2E: inbound provider message is routed to the exact account and RFC-matched conversation", async () => {
  const captured = [];
  const inboundStore = {
    async accountsForRecipient(address, _domain, provider) {
      return provider === "resend" && address.toLowerCase() === "studio@example.test"
        ? [{ id: ACC_RESEND, organization_id: ORG, address: "studio@example.test" }] : [];
    },
    async threadLookup(org, account, query) {
      assert.equal(org, ORG); assert.equal(account, ACC_RESEND);
      assert.deepEqual(query.rfcIds, ["<previous@example.test>", "<first@example.test>", "<previous@example.test>"]);
      return { tokenConversationId: null, rfcMap: { "<previous@example.test>": CONV }, candidates: [] };
    },
    async uploadAttachment() {},
    async ingestInbound(payload) { captured.push(payload); return { duplicate: false, message_id: "inbound-1", conversation_id: CONV }; },
  };
  const inboundDeps = {
    env: () => "", fetch: async () => json({ id: "inbound-provider-1", from: "Client <client@example.test>", to: ["studio@example.test"], subject: "Re: Controlled Phase 4F", text: "A reply", headers: { "Message-ID": "<reply@example.test>", "In-Reply-To": "<previous@example.test>", References: "<first@example.test> <previous@example.test>" }, created_at: "2026-11-10T12:10:00.000Z" }),
    now: () => Date.UTC(2026, 10, 10, 12, 10), store: inboundStore,
  };
  const result = await processInbound(inboundDeps, "re_test_controlled", { email_id: "inbound-provider-1" });
  assert.deepEqual(result, { result: "processed" });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].conversation_id, CONV);
  assert.equal(captured[0].account_id, ACC_RESEND);
  assert.equal(captured[0].rfc_message_id, "<reply@example.test>");
  assert.equal(captured[0].in_reply_to, "<previous@example.test>");
});

test("4F E2E: delivery event updates only exact provider identity and leaves Intelligence isolated", async () => {
  const calls = { email: [], intelligence: [] };
  const d = { store: {
    async applyDeliveryEvent(input) { calls.email.push(input); return { found: true, applied: true, duplicate: false }; },
    async applyIntelDeliveryEvent(input) { calls.intelligence.push(input); return { found: false }; },
  } };
  const result = await processDeliveryEvent(d, "svix-controlled-1", { type: "email.delivered", created_at: "2026-11-10T12:20:00.000Z", data: { email_id: "resend-accepted-1", to: ["recipient@example.test"] } });
  assert.deepEqual(result, { result: "processed" });
  assert.equal(calls.email.length, 1);
  assert.equal(calls.email[0].provider_message_id, "resend-accepted-1");
  assert.equal(calls.email[0].status, "delivered");
  assert.equal(calls.intelligence.length, 1);
});

test("4F isolation: transactional Intelligence and webhook entry points retain their approved source hashes", () => {
  const root = new URL("../../supabase/functions/", import.meta.url);
  const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(new URL(file, root)).toString("utf8").replace(/\r\n/g, "\n")).digest("hex");
  const pinned = {
    "intel-resend-send/index.ts": "be3c655e60393b20b80836b412b32cd49fca56268653e36b0dce4ce319acb113",
    "intel-resend-webhook/index.ts": "ac28b6b41a340ff265c80b1cde7fe657f4a33055432dbd53accb19a3d59f6b81",
    "resend-webhook/index.ts": "1a1efa7f669ff0fd5027ba7a745e5eeb878d0fb37d89228004caa622b95b9be2",
    "_shared/provider_guard.ts": "478c8cf2a44def03d669741b8c2ba9031fbd7688f0f7c4c3b5758b9b9b6ae44b",
    "_shared/intel_resend_logic.ts": "e8f64bf8b8fd1ef37cc502e045df92275eec60ea9a0f4d89138a20325ee5bb12",
  };
  for (const [file, hash] of Object.entries(pinned)) assert.equal(sha(file), hash, `${file} must remain isolated`);
});
