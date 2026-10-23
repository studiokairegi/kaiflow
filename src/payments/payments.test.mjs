import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import * as core from "../../supabase/functions/_shared/paystack_core.ts";
import * as L from "./logic.js";

const env = (o) => ({ get: (k) => o[k] });
const KEY = "sk_test_abcdefghijklmnop1234";

// ---------------------------------------------------------------- configuration (test / live)
const LIVE = "sk_live_ABCDEFGHIJKLMNOP1234";
test("config: test mode + test key is accepted", () => {
  const c = core.resolvePaystackConfig(env({ PAYSTACK_MODE: "test", PAYSTACK_TEST_SECRET_KEY: KEY, APP_URL: "https://app.example.com/" }));
  assert.equal(c.ok, true); assert.equal(c.environment, "test"); assert.equal(c.secretKey, KEY); assert.equal(c.appUrl, "https://app.example.com");
});
test("config: live mode + live key is accepted, but needs an https APP_URL", () => {
  const c = core.resolvePaystackConfig(env({ PAYSTACK_MODE: "live", PAYSTACK_LIVE_SECRET_KEY: LIVE, APP_URL: "https://app.example.com" }));
  assert.equal(c.ok, true); assert.equal(c.environment, "live"); assert.equal(c.secretKey, LIVE);
  assert.equal(core.resolvePaystackConfig(env({ PAYSTACK_MODE: "live", PAYSTACK_LIVE_SECRET_KEY: LIVE })).code, "app_url_required");
  assert.equal(core.resolvePaystackConfig(env({ PAYSTACK_MODE: "live", PAYSTACK_LIVE_SECRET_KEY: LIVE, APP_URL: "http://app.example.com" })).code, "app_url_required");
});
test("config: the key must match the mode; there is never a fallback to the other environment", () => {
  const both = { PAYSTACK_TEST_SECRET_KEY: KEY, PAYSTACK_LIVE_SECRET_KEY: LIVE, APP_URL: "https://a.example.com" };
  assert.equal(core.resolvePaystackConfig(env({ ...both, PAYSTACK_MODE: "test" })).secretKey, KEY);
  assert.equal(core.resolvePaystackConfig(env({ ...both, PAYSTACK_MODE: "live" })).secretKey, LIVE);
  const onlyTest = core.resolvePaystackConfig(env({ PAYSTACK_MODE: "live", PAYSTACK_TEST_SECRET_KEY: KEY, APP_URL: "https://a.example.com" }));
  assert.equal(onlyTest.ok, false); assert.equal(onlyTest.code, "key_mode_mismatch");
  const onlyLive = core.resolvePaystackConfig(env({ PAYSTACK_MODE: "test", PAYSTACK_LIVE_SECRET_KEY: LIVE }));
  assert.equal(onlyLive.ok, false); assert.equal(onlyLive.code, "key_mode_mismatch");
});
test("config: a single PAYSTACK_SECRET_KEY is filed by its prefix; legacy sandbox switch maps to test", () => {
  assert.equal(core.resolvePaystackConfig(env({ PAYMENTS_MODE: "sandbox", PAYSTACK_SECRET_KEY: KEY })).environment, "test");
  assert.equal(core.resolvePaystackConfig(env({ PAYSTACK_MODE: "live", PAYSTACK_SECRET_KEY: LIVE, APP_URL: "https://a.example.com" })).environment, "live");
});
test("config: missing mode, missing key and bad format disable payments and never echo a key", () => {
  assert.equal(core.resolvePaystackConfig(env({ PAYSTACK_TEST_SECRET_KEY: KEY })).code, "mode_not_set");
  assert.equal(core.resolvePaystackConfig(env({ PAYSTACK_MODE: "production", PAYSTACK_LIVE_SECRET_KEY: LIVE })).code, "mode_not_set");
  assert.equal(core.resolvePaystackConfig(env({ PAYSTACK_MODE: "test" })).code, "missing_secret_key");
  const bad = core.resolvePaystackConfig(env({ PAYSTACK_MODE: "test", PAYSTACK_SECRET_KEY: "pk_test_SUPERSECRETXXXX" }));
  assert.equal(bad.code, "invalid_key_format");
  for (const c of [bad, core.resolvePaystackConfig(env({ PAYSTACK_MODE: "live", PAYSTACK_TEST_SECRET_KEY: KEY, APP_URL: "https://a.example.com" }))]) {
    const txt = JSON.stringify(c); assert.ok(!txt.includes("SUPERSECRET")); assert.ok(!txt.includes(KEY));
  }
});
test("only the two supported channels map to Paystack channels; PayPal/Payoneer map to nothing", () => {
  assert.deepEqual(core.channelsFor("card"), ["card"]);
  assert.deepEqual(core.channelsFor("bank_transfer"), ["bank_transfer"]);
  for (const c of ["paypal", "payoneer", "ussd", "", undefined]) assert.equal(core.channelsFor(c), null);
});

// ---------------------------------------------------------------- amounts / currency / email
test("amounts convert to and from minor units without float drift", () => {
  assert.equal(core.toMinor(19.99), 1999); assert.equal(core.toMinor("0.1") + core.toMinor("0.2"), 30);
  assert.equal(core.toMinor(0.57), 57); assert.equal(core.toMinor(1000), 100000); // 2-dp money from the database
  assert.equal(core.fromMinor(1999), 19.99); assert.equal(core.fromMinor(null), 0);
  assert.throws(() => core.toMinor("abc"));
});
test("only Paystack currencies are supported; emails validated", () => {
  for (const c of ["NGN", "GHS", "ZAR", "KES", "USD"]) assert.ok(core.isSupportedCurrency(c));
  for (const c of ["EUR", "GBP", "JPY", ""]) assert.ok(!core.isSupportedCurrency(c));
  assert.ok(core.isValidEmail("a@b.co")); assert.ok(!core.isValidEmail("a@b")); assert.ok(!core.isValidEmail("a b@c.com"));
});

// ---------------------------------------------------------------- webhook signature
test("webhook signature: valid, tampered, wrong key, missing", async () => {
  const body = JSON.stringify({ event: "charge.success", data: { id: 1, reference: "R1" } });
  const sig = createHmac("sha512", KEY).update(body).digest("hex");
  assert.equal(await core.verifyWebhookSignature(KEY, body, sig), true);
  assert.equal(await core.verifyWebhookSignature(KEY, body, sig.toUpperCase()), true);
  assert.equal(await core.verifyWebhookSignature(KEY, body + " ", sig), false);
  assert.equal(await core.verifyWebhookSignature("sk_test_otherkey1234567", body, sig), false);
  assert.equal(await core.verifyWebhookSignature(KEY, body, ""), false);
  assert.equal(await core.verifyWebhookSignature(KEY, body, null), false);
  assert.equal(await core.verifyWebhookSignature("", body, sig), false);
});
test("webhook environment is decided by which key reproduces the signature", async () => {
  const ring = core.loadKeyRing(env({ PAYSTACK_TEST_SECRET_KEY: KEY, PAYSTACK_LIVE_SECRET_KEY: LIVE }));
  const body = JSON.stringify({ event: "charge.success", data: { id: 9, reference: "R9" } });
  const sign = (k) => createHmac("sha512", k).update(body).digest("hex");
  assert.equal((await core.identifyWebhookEnvironment(ring, body, sign(LIVE))).environment, "live");
  assert.equal((await core.identifyWebhookEnvironment(ring, body, sign(KEY))).environment, "test");
  assert.equal(await core.identifyWebhookEnvironment(ring, body, sign("sk_live_someOtherKey123456")), null);
  assert.equal(await core.identifyWebhookEnvironment(ring, body, ""), null);
  assert.equal(await core.identifyWebhookEnvironment(ring, body + " ", sign(LIVE)), null);
  // only a test key configured: a live-signed request cannot be authenticated
  const testOnly = core.loadKeyRing(env({ PAYSTACK_TEST_SECRET_KEY: KEY }));
  assert.equal(await core.identifyWebhookEnvironment(testOnly, body, sign(LIVE)), null);
});
test("webhook event key is stable across retries and distinct per event", async () => {
  const a = { event: "charge.success", data: { id: 42, reference: "R" } };
  assert.equal(await core.webhookEventKey("x", a), await core.webhookEventKey("y", a));
  assert.notEqual(await core.webhookEventKey("x", a), await core.webhookEventKey("x", { event: "refund.processed", data: { id: 42 } }));
  assert.match(await core.webhookEventKey("body", { event: "weird", data: {} }), /^weird:sha256:/);
});
test("only checkout and refund events are handled", () => {
  assert.ok(core.isHandledEvent("charge.success")); assert.ok(core.isHandledEvent("refund.processed"));
  assert.ok(!core.isHandledEvent("transfer.success")); assert.ok(!core.isHandledEvent("subscription.create"));
});

// ---------------------------------------------------------------- verification interpretation
const exp = { reference: "KRL-1", amountMinor: 100000, currency: "USD", environment: "test" };
const expLive = { ...exp, environment: "live" };
const ok = (o = {}) => ({ status: true, data: { status: "success", reference: "KRL-1", amount: 100000, currency: "USD", fees: 1500, channel: "card", id: 77, paid_at: "2026-10-18T10:00:00Z", gateway_response: "Successful", domain: "test", ...o } });
test("verification: success carries actual fee, channel and id", () => {
  const r = core.interpretVerification(ok(), exp);
  assert.equal(r.kind, "success"); assert.equal(r.feeMinor, 1500); assert.equal(r.channel, "card"); assert.equal(r.paystackId, "77");
});
test("verification: missing fee stays null (never invented)", () => {
  assert.equal(core.interpretVerification(ok({ fees: undefined }), exp).feeMinor, null);
});
test("verification: amount, currency, reference and live domain mismatches are rejected", () => {
  assert.equal(core.interpretVerification(ok({ amount: 99999 }), exp).kind, "rejected");
  assert.equal(core.interpretVerification(ok({ currency: "GHS" }), exp).kind, "rejected");
  assert.equal(core.interpretVerification(ok({ reference: "OTHER" }), exp).kind, "rejected");
  assert.equal(core.interpretVerification(ok({ domain: "live" }), exp).kind, "rejected");
  assert.equal(core.interpretVerification({ status: false, data: null }, exp).kind, "rejected");
  assert.equal(core.interpretVerification(null, exp).kind, "rejected");
});
test("verification: a live key only confirms live transactions, a test key only test ones", () => {
  assert.equal(core.interpretVerification(ok({ domain: "live" }), expLive).kind, "success");
  assert.equal(core.interpretVerification(ok({ domain: "test" }), expLive).kind, "rejected");
  assert.equal(core.interpretVerification(ok({ domain: "live" }), exp).kind, "rejected");
  // live money is never accepted without Paystack stating the domain
  assert.equal(core.interpretVerification(ok({ domain: undefined }), expLive).kind, "rejected");
  // live: amount / currency / reference are still checked against OUR row
  assert.equal(core.interpretVerification(ok({ domain: "live", amount: 100001 }), expLive).kind, "rejected");
  assert.equal(core.interpretVerification(ok({ domain: "live", currency: "KES" }), expLive).kind, "rejected");
});
test("verification: failed, abandoned, pending, reversed are not success", () => {
  assert.equal(core.interpretVerification(ok({ status: "failed" }), exp).kind, "failed");
  assert.equal(core.interpretVerification(ok({ status: "abandoned" }), exp).kind, "abandoned");
  assert.equal(core.interpretVerification(ok({ status: "reversed" }), exp).kind, "reversed");
  for (const s of ["ongoing", "pending", "processing", "queued"]) assert.equal(core.interpretVerification(ok({ status: s }), exp).kind, "pending");
});

// ---------------------------------------------------------------- summary, fees, refunds
const NOW = new Date("2026-10-18T12:00:00Z");
const tx = (o) => ({ id: Math.random().toString(36), reference: "R" + Math.random(), status: "success", apply_status: "applied", reconciliation_status: "matched", amount: 1000, currency: "USD", fee_actual: 15, refunded_amount: 0, created_at: "2026-10-10T00:00:00Z", paid_at: "2026-10-10T00:00:00Z", ...o });

test("summary: gross, actual fees and net; pending is not received; per currency", () => {
  const s = L.summarizePayments({ now: NOW, transactions: [
    tx({ amount: 1000, fee_actual: 15 }), tx({ amount: 500, fee_actual: 8.5 }),
    tx({ currency: "KES", amount: 20000, fee_actual: 300 }),
    tx({ status: "pending", apply_status: "none", fee_actual: null, amount: 700, paid_at: null }),
    tx({ status: "failed", apply_status: "none", fee_actual: null, amount: 50, paid_at: null }),
  ] });
  assert.deepEqual(s.receivedGross, { USD: 1500, KES: 20000 });
  assert.deepEqual(s.fees, { USD: 23.5, KES: 300 });
  assert.deepEqual(s.net, { USD: 1476.5, KES: 19700 });
  assert.deepEqual(s.pendingIncoming, { USD: 700 });
  assert.equal(s.counts.pending, 1); assert.equal(s.counts.failed, 1); assert.equal(s.counts.successful, 3);
});
test("summary: full refund leaves gross out but keeps the fee; partial keeps gross", () => {
  const s = L.summarizePayments({ now: NOW, transactions: [
    tx({ status: "refunded", refunded_amount: 1000, amount: 1000, fee_actual: 15 }),
    tx({ status: "partially_refunded", refunded_amount: 100, amount: 400, fee_actual: 6, reconciliation_status: "needs_review" }),
  ] });
  assert.deepEqual(s.receivedGross, { USD: 400 }); assert.deepEqual(s.refunds, { USD: 1100 });
  assert.deepEqual(s.fees, { USD: 21 }); assert.equal(s.unreconciledCount, 1); assert.equal(s.counts.refunded, 2);
});
test("summary: period filter and received-today", () => {
  const old = tx({ amount: 300, paid_at: "2026-01-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z" });
  const today = tx({ amount: 200, paid_at: "2026-10-18T08:00:00Z", created_at: "2026-10-18T08:00:00Z" });
  assert.deepEqual(L.summarizePayments({ now: NOW, period: "30d", transactions: [old, today] }).receivedGross, { USD: 200 });
  assert.deepEqual(L.summarizePayments({ now: NOW, period: "all", transactions: [old, today] }).receivedGross, { USD: 500 });
  assert.deepEqual(L.summarizePayments({ now: NOW, transactions: [old, today] }).receivedToday, { USD: 200 });
});
test("summary: outstanding invoices ignore receipts, paid and superseded documents", () => {
  const inv = [
    { id: "a", docType: "invoice", amount: 1000, amountPaid: 400, currency: "$", status: "unpaid" },
    { id: "b", docType: "proforma", amount: 300, amountPaid: 0, currency: "$", status: "unpaid" },
    { id: "c", docType: "invoice", amount: 200, amountPaid: 200, currency: "$", status: "paid" },
    { id: "d", docType: "receipt", amount: 300, amountPaid: 300, currency: "$", status: "paid", convertedFromId: "b" },
    { id: "e", docType: "invoice", amount: 80, amountPaid: 0, currency: "KSh", status: "unpaid" },
  ];
  const s = L.summarizePayments({ now: NOW, invoices: inv });
  assert.deepEqual(s.outstandingInvoices, { USD: 600, KES: 80 }); assert.equal(s.outstandingInvoiceCount, 3 - 1);
});
test("dashboard metrics are exactly the Payments summary (no second definition)", () => {
  const s = L.summarizePayments({ now: NOW, transactions: [tx({})] });
  const d = L.dashboardMetrics(s);
  assert.deepEqual(d.receipts, s.receivedGross); assert.deepEqual(d.fees, s.fees); assert.deepEqual(d.net, s.net);
  assert.equal(d.unreconciled, s.unreconciledCount + s.unreconciledPayoutCount);
});

// ---------------------------------------------------------------- freelancer obligations
const member = { id: "m1", name: "Fay" };
const bill = (o) => ({ id: "b1", team_member_id: "m1", status: "approved", amount: 300, amount_paid: 0, currency: "USD", project_id: "p1", ...o });
const pr = (o) => ({ id: Math.random().toString(36), bill_id: "b1", team_member_id: "m1", amount: 100, currency: "USD", status: "pending_approval", reconciled: false, ...o });

test("obligations: owed = outstanding approved bills only (drafts and void excluded)", () => {
  const [row] = L.freelancerObligations({ teamMembers: [member], bills: [bill({}), bill({ id: "b2", status: "draft", amount: 999 }), bill({ id: "b3", status: "partially_paid", amount: 200, amount_paid: 50 }), bill({ id: "b4", status: "paid", amount: 70, amount_paid: 70 })] });
  assert.deepEqual(row.owed, { USD: 450 }); assert.deepEqual(row.billed, { USD: 570 });
});
test("obligations: payout requests never change what is owed; failed attempts keep the amount", () => {
  const payouts = [pr({ status: "failed" }), pr({ status: "completed_simulated", amount: 100 }), pr({ status: "approved", amount: 50 }), pr({ status: "pending_approval", amount: 25 })];
  const [row] = L.freelancerObligations({ teamMembers: [member], bills: [bill({})], payouts });
  assert.deepEqual(row.owed, { USD: 300 }); assert.deepEqual(row.pendingRequests, { USD: 25 }); assert.deepEqual(row.approvedAwaiting, { USD: 50 });
  assert.deepEqual(row.simulatedUnreconciled, { USD: 100 });
});
test("obligations: open requests reserve the bill balance", () => {
  const b = bill({});
  const payouts = [pr({ status: "approved", amount: 120 }), pr({ status: "pending_approval", amount: 30 }), pr({ status: "cancelled", amount: 999 }), pr({ status: "failed", amount: 999 })];
  assert.equal(L.billReserved("b1", payouts), 150); assert.equal(L.billAvailableForRequest(b, payouts), 150);
});
test("obligations: shots already on a bill are not double counted as unbilled work", () => {
  const cards = [
    { id: "s1", assignedMemberId: "m1", assignedPay: "100", assignedPaid: false, projectId: "p1" },
    { id: "s2", assignedMemberId: "m1", assignedPay: "60", assignedPaid: false, projectId: "p1" },
    { id: "s3", assignedMemberId: "m1", assignedPay: "40", assignedPaid: true, projectId: "p1" },
  ];
  const [row] = L.freelancerObligations({ teamMembers: [member], bills: [bill({ amount: 100 })], billShots: [{ bill_id: "b1", shot_id: "s1" }], cards, projects: [{ id: "p1", currency: "$" }] });
  assert.deepEqual(row.unbilledWork, { USD: 60 }); assert.deepEqual(row.unbilledShotIds, ["s2"]); assert.deepEqual(row.owed, { USD: 100 });
});
test("summary: freelancer owed and awaiting-approval figures", () => {
  const s = L.summarizePayments({ now: NOW, bills: [bill({}), bill({ id: "b9", team_member_id: "m2", amount: 100, amount_paid: 40, status: "partially_paid" })],
    payouts: [pr({ status: "approved", amount: 75 }), pr({ status: "completed_simulated", amount: 20, completed_at: "2026-10-17T00:00:00Z" })] });
  assert.deepEqual(s.freelancerOwed, { USD: 360 }); assert.deepEqual(s.approvedPayoutsAwaiting, { USD: 75 });
  assert.deepEqual(s.simulatedPaid, { USD: 20 }); assert.equal(s.unreconciledPayoutCount, 1);
});

// ---------------------------------------------------------------- reconciliation
test("reconcile: gateway and Finance totals match, and differences are surfaced", () => {
  const t1 = tx({ reference: "R1", amount: 400, fee_actual: 6 }), t2 = tx({ reference: "R2", amount: 600, fee_actual: 9 });
  const pays = [{ method: L.PAYSTACK_METHOD, status: "posted", currency: "USD", amount: 400 }, { method: L.PAYSTACK_METHOD, status: "posted", currency: "USD", amount: 600 }];
  const exps = [{ category: L.FEE_CATEGORY, reference: "R1", currency: "$", amount: 6 }, { category: L.FEE_CATEGORY, reference: "R2", currency: "$", amount: 9 }];
  assert.equal(L.reconcileTotals({ transactions: [t1, t2], invoicePayments: pays, expenses: exps }).ok, true);
  const bad = L.reconcileTotals({ transactions: [t1, t2], invoicePayments: pays.slice(0, 1), expenses: exps });
  assert.equal(bad.ok, false); assert.equal(bad.rows[0].grossDifference, 600);
});
test("reconcile: live payments are matched by their own Finance label and never mixed with test ones", () => {
  const t = tx({ reference: "L1", amount: 500, fee_actual: 7.5, environment: "live" });
  const pays = [{ method: L.PAYSTACK_LIVE_METHOD, status: "posted", currency: "USD", amount: 500 }, { method: L.PAYSTACK_METHOD, status: "posted", currency: "USD", amount: 900 }];
  const exps = [{ category: L.FEE_CATEGORY, reference: "L1", currency: "$", amount: 7.5 }];
  assert.equal(L.reconcileTotals({ transactions: [t], invoicePayments: pays, expenses: exps, environment: "live" }).ok, true);
  assert.equal(L.reconcileTotals({ transactions: [t], invoicePayments: pays, expenses: exps }).ok, false);   // test view would see 900 of "test" ledger money
  assert.equal(L.txEnvironment({ environment: "live" }), "live"); assert.equal(L.txEnvironment({}), "test");
  assert.match(L.envNotice("live"), /REAL/); assert.match(L.envNotice("test"), /NOT REAL MONEY/);
});
test("needsAttention lists unapplied or unreviewed verified payments only", () => {
  const rows = [tx({ reconciliation_status: "needs_review", apply_status: "failed" }), tx({}), tx({ status: "failed", apply_status: "none", reconciliation_status: "unreconciled" })];
  assert.equal(L.needsAttention(rows).length, 1);
});

// ---------------------------------------------------------------- checkout eligibility
test("checkout blocker: unsupported currency, nothing outstanding, ok case", () => {
  assert.match(L.checkoutBlocker({ id: "x", docType: "invoice", amount: 100, amountPaid: 0, currency: "€", status: "unpaid" }), /cannot collect EUR/);
  assert.match(L.checkoutBlocker({ id: "x", docType: "invoice", amount: 100, amountPaid: 100, currency: "$", status: "paid" }), /Nothing is outstanding/);
  assert.equal(L.checkoutBlocker({ id: "x", docType: "invoice", amount: 100, amountPaid: 20, currency: "$", status: "unpaid" }), "");
});
test("labels distinguish simulation and sandbox", () => {
  assert.match(L.SIMULATED_NOTICE, /NO MONEY TRANSFERRED/); assert.match(L.SANDBOX_NOTICE, /NOT REAL MONEY/);
});
