import test from "node:test";
import assert from "node:assert/strict";
import { makeFinanceEmailSink, financeTag } from "../../../supabase/functions/_shared/finance_email_sink.ts";
import { handleWebhook } from "../../../supabase/functions/_shared/email_resend_logic.ts";

const MID = "33333333-3333-4333-8333-333333333333";
const ev = (over = {}) => ({ provider_event_id: "msg_1", event_type: "email.delivered", provider_message_id: "re_1", tags: { kf_finance_message_id: MID }, occurred_at: null, bounce_type: "", ...over });

test("tag extraction accepts the object and array shapes and rejects anything that is not a UUID", () => {
  assert.equal(financeTag({ kf_finance_message_id: MID.toUpperCase() }), MID);
  assert.equal(financeTag([{ name: "kf_finance_message_id", value: MID }]), MID);
  assert.equal(financeTag({ kf_finance_message_id: "not-a-uuid" }), null);
  assert.equal(financeTag({ kf_message_id: MID }), null, "the Inbox tag is not a Finance tag");
  assert.equal(financeTag(undefined), null);
});

test("record then apply, in that order, for a Finance message", async () => {
  const calls = [];
  const svc = { rpc: async (n, a) => { calls.push([n, a]); return n.endsWith("record_email_event") ? { data: { id: 5, found: true, applied: false, duplicate: false }, error: null } : { data: { found: true, applied: true }, error: null }; } };
  const out = await makeFinanceEmailSink(svc)(ev());
  assert.deepEqual(calls.map((c) => c[0]), ["fin3svc_record_email_event", "fin3svc_apply_email_event"]);
  assert.equal(calls[0][1].p_message_id, MID); assert.equal(calls[1][1].p_event, 5);
  assert.deepEqual(out, { found: true, applied: true, duplicate: false });
});

test("a duplicate that was already applied does no second apply; a foreign untagged event does no work", async () => {
  let applies = 0;
  const dup = { rpc: async (n) => (n.endsWith("record_email_event") ? { data: { id: 5, found: true, applied: true, duplicate: true }, error: null } : (applies++, { data: {}, error: null })) };
  assert.equal((await makeFinanceEmailSink(dup)(ev())).duplicate, true); assert.equal(applies, 0);
  const foreign = { rpc: async (n) => (n.endsWith("record_email_event") ? { data: { id: null, found: false, ignored: true }, error: null } : (applies++, { data: {}, error: null })) };
  const out = await makeFinanceEmailSink(foreign)(ev({ tags: undefined }));
  assert.deepEqual(out, { found: false, applied: false, duplicate: false }); assert.equal(applies, 0);
});

test("a database error is thrown so the caller can log it (the webhook isolates it)", async () => {
  await assert.rejects(makeFinanceEmailSink({ rpc: async () => ({ data: null, error: { message: "db down" } }) })(ev()), /not recorded/);
});

// ---- the shared webhook calls the Finance sink FIRST and isolates its failures --------------------------------------------------------
const RESEND_ROW = { provider_key: "resend", adapter_key: "resend", display_name: "Resend", enabled: true,
  capabilities: { send: true, inbound_webhook: true, delivery_events: true, attachments_send: true, attachments_receive: true, threading_headers: true, drafts_local: true, remote_sync: false, remote_search: false, remote_folders: false, remote_drafts: false, oauth: false } };
async function signed(body, id = "msg_1") {
  const SECRET_BYTES = new Uint8Array(24).fill(7);
  const ts = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey("raw", SECRET_BYTES, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`))).toString("base64");
  return { secret: "whsec_" + Buffer.from(SECRET_BYTES).toString("base64"), req: new Request("https://x.test", { method: "POST", body, headers: { "svix-id": id, "svix-timestamp": String(ts), "svix-signature": `v1,${mac}` } }) };
}

test("shared Resend webhook: Finance events are applied even when the Inbox provider is switched off, and a Finance failure does not change the response", async () => {
  const body = JSON.stringify({ type: "email.delivered", created_at: "2026-11-23T10:00:00Z", data: { email_id: "re_1", tags: { kf_finance_message_id: MID }, to: ["a@b.test"] } });
  const { secret, req } = await signed(body);
  const seen = [];
  const deps = (financeImpl) => ({ env: (k) => ({ RESEND_WEBHOOK_SECRET: secret, RESEND_API_KEY: "k" }[k]), fetch, now: () => Date.now(),
    store: { providerEnabled: async () => false, getProviderRegistryRow: async () => ({ ...RESEND_ROW, enabled: false }), applyFinanceDeliveryEvent: financeImpl } });
  let r = await handleWebhook(req, deps(async (a) => { seen.push(a); return { found: true, applied: true, duplicate: false }; }));
  assert.equal(r.status, 200); assert.equal((await r.json()).ignored, "provider disabled");
  assert.equal(seen.length, 1); assert.equal(seen[0].provider_message_id, "re_1"); assert.equal(seen[0].provider_event_id, "msg_1");
  const again = await signed(body, "msg_2");
  r = await handleWebhook(again.req, deps(async () => { throw new Error("finance down"); }));
  assert.equal(r.status, 200, "a Finance failure never changes the acknowledgement of the shared webhook");
});

test("shared Resend webhook: inbound mail (email.received) never reaches the Finance sink", async () => {
  const body = JSON.stringify({ type: "email.received", data: { email_id: "re_9" } });
  const { secret, req } = await signed(body, "msg_9");
  let called = 0;
  await handleWebhook(req, { env: (k) => ({ RESEND_WEBHOOK_SECRET: secret, RESEND_API_KEY: "k" }[k]), fetch, now: () => Date.now(),
    store: { providerEnabled: async () => false, getProviderRegistryRow: async () => ({ ...RESEND_ROW, enabled: false }), applyFinanceDeliveryEvent: async () => { called++; return {}; } } });
  assert.equal(called, 0);
});
