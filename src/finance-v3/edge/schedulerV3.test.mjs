import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reconcileUnsettled, hourBucket } from "../../../supabase/functions/_shared/finance_v3_scheduler.ts";

const REF = "KRL3-T-ABCDEFGHJKLM-ABCD", REF2 = "KRL3-L-ABCDEFGHJKLM-WXYZ";
const verifyBody = (over = {}, status = "success", ref = REF) => ({ ok: true, httpStatus: 200, body: { status: true, data: { id: 7, reference: ref, status, amount: 15439, currency: "KES", fees: 100, channel: "card", domain: "test", paid_at: "2026-11-23T10:00:00Z", ...over } } });

function harness({ items = [{ organization_id: "o", intent_id: "i1", reference: REF, environment: "test" }], settle = { outcome: "recorded" }, verify = async () => verifyBody(), duplicateEvent = false, listError = null } = {}) {
  const calls = [];
  const rpc = async (name, args) => {
    calls.push([name, args]);
    switch (name) {
      case "fin3svc_list_unsettled_intents": return listError ? { data: null, error: { message: listError } } : { data: items, error: null };
      case "fin3svc_record_provider_event": return { data: { id: "e1", duplicate: duplicateEvent }, error: null };
      case "fin3svc_finish_provider_event": return { data: null, error: null };
      case "fin3svc_get_intent": return { data: { intent_id: "i1", environment: args.p_provider ? "test" : "test", status: "pending" }, error: null };
      case "fin3svc_settle_payment": return { data: settle, error: null };
      case "fin3svc_apply_payment_status": return { data: { outcome: "updated" }, error: null };
      default: throw new Error("unexpected " + name);
    }
  };
  return { calls, names: () => calls.map((c) => c[0]), run: (over = {}) => reconcileUnsettled({ rpc, verifyFor: (env) => (env === "test" ? verify : null), now: () => Date.UTC(2026, 10, 24, 10, 30), ...over }) };
}

test("a pending attempt that Paystack says succeeded is verified and settled through the webhook's own handler", async () => {
  const h = harness(); const s = await h.run();
  assert.deepEqual(s, { examined: 1, settled: 1, duplicate: 0, needs_review: 0, still_pending: 0, skipped: 0, failed: 0 });
  assert.deepEqual(h.names(), ["fin3svc_list_unsettled_intents", "fin3svc_record_provider_event", "fin3svc_get_intent", "fin3svc_settle_payment", "fin3svc_finish_provider_event"]);
  const settle = h.calls.find((c) => c[0] === "fin3svc_settle_payment")[1];
  assert.equal(settle.p_amount_minor, 15439); assert.equal(settle.p_currency, "KES"); assert.equal(settle.p_reference, REF);      // VERIFIED facts, never the list's
});
test("the event key holds the environment, reference and hour: a rerun in the same hour is a duplicate, the next hour is a new look", async () => {
  const h = harness(); await h.run();
  const key = h.calls.find((c) => c[0] === "fin3svc_record_provider_event")[1].p_event_key;
  assert.equal(key, `test:reconcile:${REF}:${hourBucket(Date.UTC(2026, 10, 24, 10, 30))}`);
  const dup = harness({ duplicateEvent: true }); const s = await dup.run(); assert.equal(s.settled, 0);
  assert.ok(!dup.names().includes("fin3svc_settle_payment"), "a duplicate event settles nothing");
  assert.notEqual(hourBucket(Date.UTC(2026, 10, 24, 10, 30)), hourBucket(Date.UTC(2026, 10, 24, 11, 30)));
});
test("a payment that was already recorded comes back as duplicate and is not recorded twice", async () => {
  const s = await harness({ settle: { outcome: "duplicate" } }).run(); assert.equal(s.duplicate, 1); assert.equal(s.settled, 0);
});
test("a mismatch is held for review, never recorded", async () => {
  const h = harness({ settle: { outcome: "needs_review", reason: "amount or currency differs" } }); const s = await h.run();
  assert.equal(s.needs_review, 1); assert.equal(s.settled, 0);
  assert.equal(h.calls.find((c) => c[0] === "fin3svc_finish_provider_event")[1].p_status, "needs_review");
});
test("Paystack saying pending or failed updates the attempt status only", async () => {
  for (const st of ["pending", "failed", "abandoned"]) {
    const h = harness({ verify: async () => verifyBody({}, st) }); const s = await h.run();
    assert.equal(s.still_pending, 1, st); assert.ok(!h.names().includes("fin3svc_settle_payment")); assert.deepEqual(h.calls.find((c) => c[0] === "fin3svc_apply_payment_status")[1].p_outcome, st === "pending" ? "pending" : st);
  }
});
test("an environment with no key configured is skipped, not guessed", async () => {
  const h = harness({ items: [{ reference: REF2, environment: "live" }] }); const s = await h.run();
  assert.equal(s.skipped, 1); assert.deepEqual(h.names(), ["fin3svc_list_unsettled_intents"]);
});
test("a Paystack outage counts as failed and does not stop the other attempts", async () => {
  let n = 0; const h = harness({ items: [{ reference: REF, environment: "test" }, { reference: "KRL3-T-ZZZZZZZZZZZZ-ABCD", environment: "test" }],
    verify: async (ref) => (++n === 1 ? { ok: false, httpStatus: 503, body: null, networkError: "timeout" } : verifyBody({ reference: ref }, "success", ref)) });
  const s = await h.run(); assert.equal(s.failed, 1); assert.equal(s.settled, 1); assert.equal(s.examined, 2);
});
test("a database error while listing is raised, not hidden", async () => { await assert.rejects(harness({ listError: "boom" }).run(), /list unsettled: boom/); });
test("the limit is clamped to 1..100", async () => {
  const h = harness({ items: [] }); await h.run({ limit: 5000 }); assert.equal(h.calls[0][1].p_limit, 100);
  const g = harness({ items: [] }); await g.run({ limit: 0 }); assert.equal(g.calls[0][1].p_limit, 1);
});
test("the edge function is cron-secret only and has no write path other than the two services", () => {
  const src = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../supabase/functions/finance-scheduler/index.ts"), "utf8");
  assert.match(src, /x-cron-secret/); assert.match(src, /constantTimeEqual/); assert.doesNotMatch(src, /authorization/i);
  const rpcs = [...src.matchAll(/rpc\("([a-z0-9_]+)"/g)].map((m) => m[1]); assert.deepEqual(rpcs, ["fin3svc_run_scheduled"]);
  assert.doesNotMatch(src, /fin3_(pay|issue|send|approve|refund|post)/);
});
