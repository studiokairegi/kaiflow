import test from "node:test";
import assert from "node:assert/strict";
import { handleFinanceV3PaystackEvent, initializeCheckout, isV3Reference } from "../../../supabase/functions/_shared/finance_v3_paystack.ts";

const REF = "KRL3-T-ABCDEFGHJKLM-ABCD";
const verifyOk = (over = {}, status = "success") => async () => ({ ok: true, httpStatus: 200, body: { status: true, data: { id: 99, reference: REF, status, amount: 15439, currency: "KES", fees: 250, channel: "card", domain: "test", paid_at: "2026-11-23T10:00:00Z", ...over } } });

function harness({ duplicate = false, intent = { intent_id: "i1", environment: "test", status: "initialized" }, settle = { outcome: "recorded" }, verify = verifyOk(), refund = { outcome: "recorded" } } = {}) {
  const calls = [];
  const rpc = async (name, args) => {
    calls.push([name, args]);
    switch (name) {
      case "fin3svc_record_provider_event": return { data: { id: "e1", duplicate }, error: null };
      case "fin3svc_finish_provider_event": return { data: null, error: null };
      case "fin3svc_get_intent": return { data: intent, error: null };
      case "fin3svc_settle_payment": return { data: settle, error: null };
      case "fin3svc_apply_payment_status": return { data: { outcome: "updated" }, error: null };
      case "fin3svc_apply_refund_event": return { data: refund, error: null };
      default: throw new Error("unexpected " + name);
    }
  };
  const run = (event = "charge.success", parsed = { event, data: { reference: REF } }, over = {}) => handleFinanceV3PaystackEvent({ rpc, verify, environment: "test", eventKey: "test:charge.success:99", event, reference: REF, parsed, handled: true, ...over });
  const finished = () => calls.filter((c) => c[0] === "fin3svc_finish_provider_event").map((c) => c[1].p_status);
  return { run, calls, finished, names: () => calls.map((c) => c[0]) };
}

test("reference namespace: only KRL3 references are routed to Finance V3", () => {
  assert.ok(isV3Reference(REF));
  for (const bad of ["KRL-ABC", "krl3-t-abcdefghjklm-abcd", "KRL3-X-ABCDEFGHJKLM-ABCD", "KRL3-T-ABC-ABCD", "KRL3-T-ABCDEFGHJKLM-ABCD1", "", null, undefined, 5]) assert.ok(!isV3Reference(bad), String(bad));
});

test("charge.success: verified with Paystack, then settled using ONLY verified facts", async () => {
  const h = harness();
  const r = await h.run();
  assert.equal(r.status, 200);
  assert.deepEqual(h.names(), ["fin3svc_record_provider_event", "fin3svc_get_intent", "fin3svc_settle_payment", "fin3svc_finish_provider_event"]);
  const s = h.calls.find((c) => c[0] === "fin3svc_settle_payment")[1];
  assert.deepEqual({ ...s }, { p_provider: "paystack", p_reference: REF, p_provider_txn: "99", p_amount_minor: 15439, p_currency: "KES", p_environment: "test", p_paid_at: "2026-11-23T10:00:00Z", p_fee_minor: 250, p_channel: "card" });
  assert.deepEqual(h.finished(), ["processed"]);
});

test("the webhook body can never supply the amount: a forged amount in the event is ignored in favour of the verified one", async () => {
  const h = harness();
  await h.run("charge.success", { event: "charge.success", data: { reference: REF, amount: 1, currency: "USD", status: "success" } });
  const s = h.calls.find((c) => c[0] === "fin3svc_settle_payment")[1];
  assert.equal(s.p_amount_minor, 15439); assert.equal(s.p_currency, "KES");
});

test("a duplicate delivery is acknowledged and does nothing", async () => {
  const h = harness({ duplicate: true });
  const r = await h.run();
  assert.deepEqual([r.status, r.body.duplicate], [200, true]);
  assert.deepEqual(h.names(), ["fin3svc_record_provider_event"]);
});

test("verification problems are retryable (500) and recorded failed; they never settle", async () => {
  for (const verify of [async () => ({ ok: false, httpStatus: 503, body: null }), async () => ({ ok: true, httpStatus: 200, body: { status: true, data: { reference: "OTHER", status: "success" } } }),
    async () => ({ ok: false, httpStatus: 0, body: null, networkError: "timeout" })]) {
    const h = harness({ verify });
    const r = await h.run();
    assert.equal(r.status, 500); assert.ok(!h.names().includes("fin3svc_settle_payment")); assert.deepEqual(h.finished(), ["failed"]);
  }
});

test("needs_review is acknowledged (no pointless retries) and kept visible", async () => {
  const h = harness({ settle: { outcome: "needs_review", reason: "overpayment" } });
  const r = await h.run();
  assert.equal(r.status, 200); assert.deepEqual(h.finished(), ["needs_review"]);
  assert.equal(h.calls.find((c) => c[0] === "fin3svc_finish_provider_event")[1].p_error, "overpayment");
});

test("an unknown reference or an environment mismatch is ignored with 200 and settles nothing", async () => {
  let h = harness({ intent: null });
  assert.equal((await h.run()).status, 200); assert.deepEqual(h.finished(), ["ignored"]); assert.ok(!h.names().includes("fin3svc_settle_payment"));
  h = harness({ intent: { intent_id: "i1", environment: "live" } });
  assert.equal((await h.run()).status, 200); assert.deepEqual(h.finished(), ["ignored"]);
});

test("a verified transaction whose domain differs from the event environment is sent to review, not settled", async () => {
  const h = harness({ verify: verifyOk({ domain: "live" }) });
  const r = await h.run();
  assert.equal(r.status, 200); assert.deepEqual(h.finished(), ["needs_review"]); assert.ok(!h.names().includes("fin3svc_settle_payment"));
});

test("failed / abandoned / pending verified statuses update the attempt but never settle", async () => {
  for (const [status, expected] of [["failed", "failed"], ["abandoned", "abandoned"], ["ongoing", "pending"], ["reversed", "reversed"]]) {
    const h = harness({ verify: verifyOk({}, status) });
    assert.equal((await h.run()).status, 200);
    assert.equal(h.calls.find((c) => c[0] === "fin3svc_apply_payment_status")[1].p_outcome, expected);
    assert.ok(!h.names().includes("fin3svc_settle_payment"));
  }
});

test("unhandled event types are recorded as ignored", async () => {
  const h = harness();
  const r = await h.run("subscription.create", { event: "subscription.create", data: {} }, { handled: false });
  assert.equal(r.status, 200); assert.deepEqual(h.finished(), ["ignored"]);
});

test("refund events are applied by provider reference; an unsettled charge asks Paystack to retry", async () => {
  const parsed = { event: "refund.processed", data: { transaction_reference: REF, refund_reference: "rf_1", amount: 1000, currency: "KES" } };
  let h = harness();
  assert.equal((await h.run("refund.processed", parsed)).status, 200);
  const a = h.calls.find((c) => c[0] === "fin3svc_apply_refund_event")[1];
  assert.deepEqual({ ...a }, { p_provider: "paystack", p_reference: REF, p_refund_ref: "rf_1", p_amount_minor: 1000, p_currency: "KES", p_status: "processed" });
  h = harness({ refund: { outcome: "retry" } });
  assert.equal((await h.run("refund.processed", parsed)).status, 500);
  h = harness();
  assert.equal((await h.run("refund.processed", { event: "refund.processed", data: { transaction_reference: REF, amount: -5 } })).status, 500, "an invalid refund payload is not silently accepted");
});

test("checkout initialisation takes amount, currency, reference and email from OUR row and records the provider URL", async () => {
  let sent, saved;
  const intent = { intent_id: "i1", reference: REF, charge_amount_minor: "15439", currency: "KES", customer_email: "pay@acme.test", authorization_url: null };
  const out = await initializeCheckout({ intent, callbackUrl: "https://x.test/pay?t=a",
    initialize: async (b) => { sent = b; return { ok: true, httpStatus: 200, body: { status: true, data: { authorization_url: "https://checkout.paystack.test/abc" } } }; },
    rpc: async (n, a) => { saved = [n, a]; return { data: null, error: null }; } });
  assert.deepEqual(out, { ok: true, url: "https://checkout.paystack.test/abc" });
  assert.equal(sent.amount, 15439); assert.equal(sent.currency, "KES"); assert.equal(sent.reference, REF); assert.equal(sent.email, "pay@acme.test");
  assert.deepEqual(saved, ["fin3svc_intent_initialized", { p_intent: "i1", p_authorization_url: "https://checkout.paystack.test/abc" }]);
});

test("checkout initialisation reuses an existing URL and refuses non-https or failed provider answers", async () => {
  const base = { intent_id: "i1", reference: REF, charge_amount_minor: "100", currency: "KES", customer_email: "a@b.test" };
  const reuse = await initializeCheckout({ intent: { ...base, authorization_url: "https://c.test/x" }, callbackUrl: "x", initialize: async () => { throw new Error("must not call"); }, rpc: async () => ({ data: null, error: null }) });
  assert.equal(reuse.ok, true);
  for (const body of [{ status: true, data: { authorization_url: "http://insecure.test" } }, { status: false }, { status: true, data: {} }]) {
    const r = await initializeCheckout({ intent: { ...base, authorization_url: null }, callbackUrl: "x", initialize: async () => ({ ok: true, httpStatus: 200, body }), rpc: async () => ({ data: null, error: null }) });
    assert.equal(r.ok, false);
  }
  const bad = await initializeCheckout({ intent: { ...base, charge_amount_minor: "1e9", authorization_url: null }, callbackUrl: "x", initialize: async () => { throw new Error("no"); }, rpc: async () => ({ data: null, error: null }) });
  assert.equal(bad.ok, false);
});
