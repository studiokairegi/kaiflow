import test from "node:test";
import assert from "node:assert/strict";
import { createPhase4Api, FinanceV3Error, assertOverride } from "./phase4.js";
import { PHASE4_RPCS, PHASE3_SERVICE_RPCS } from "../contracts/index.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";
const fake = (reply = { data: { ok: true }, error: null }) => { const calls = []; return { calls, rpc: async (n, a) => { calls.push([n, a]); return reply; } }; };

test("service-only and unknown functions are refused client-side", async () => {
  const f = fake(); const api = createPhase4Api(f.rpc);
  for (const n of PHASE3_SERVICE_RPCS) await assert.rejects(api.call(n, {}), (e) => e.codeName === "NOT_AUTHORIZED");
  await assert.rejects(api.call("fin3_post_journal", {}), FinanceV3Error);   // Phase 2 accountant RPC is not part of this client
  await assert.rejects(api.call("anything_else", {}), FinanceV3Error);
  assert.equal(f.calls.length, 0);
});

test("money must be a decimal string everywhere, including inside JSON payloads", async () => {
  const f = fake(); const api = createPhase4Api(f.rpc);
  await assert.rejects(async () => api.payAnimator(ORG, "k", ID, 100, "2026-11-24", ID), FinanceV3Error);
  await assert.rejects(async () => api.recordOwnerPayment(ORG, "k", "draw", 5000, "KES", "2026-11-24", ID), FinanceV3Error);
  await assert.rejects(async () => api.allocateProjectFunds(ORG, "k", ID, "production", "1e3"), FinanceV3Error);
  await assert.rejects(async () => api.upsertAnimatorAssignment(ORG, { agreed_rate: 500 }), FinanceV3Error);
  await assert.rejects(async () => api.submitAnimatorWork(ORG, "k", ID, { quantity: 10 }), FinanceV3Error);
  await assert.rejects(async () => api.checkSpend(ORG, 12.5, "KES"), FinanceV3Error);
  await assert.rejects(async () => api.recordExpense(ORG, "k", { amount: 12.5 }), FinanceV3Error);
  assert.equal(f.calls.length, 0);
});

test("override must be exactly { reason } with 10-500 characters", () => {
  assert.equal(assertOverride(undefined), null);
  assert.deepEqual(assertOverride({ reason: "  Client paid late, covering payroll  " }), { reason: "Client paid late, covering payroll" });
  for (const b of [{}, { reason: "short" }, { reason: "x".repeat(501) }, { reason: "long enough reason", extra: 1 }, "reason", [], { reason: 5 }]) assert.throws(() => assertOverride(b), FinanceV3Error, JSON.stringify(b));
});

test("protected spending paths send p_override and nothing else changes", async () => {
  const f = fake(); const api = createPhase4Api(f.rpc);
  await api.payBill(ORG, "k", ID, "10.00", "2026-11-24", ID, { override: { reason: "Supplier threatens to stop work" } });
  assert.equal(f.calls[0][0], "fin3_pay_bill");
  assert.deepEqual(Object.keys(f.calls[0][1]).sort(), ["p_amount", "p_bill", "p_key", "p_org", "p_override", "p_paid_on", "p_pay_account", "p_reference"]);
  assert.deepEqual(f.calls[0][1].p_override, { reason: "Supplier threatens to stop work" });
  await api.recordOwnerPayment(ORG, "k2", "salary", "100.00", "KES", "2026-11-24", ID);
  assert.equal(f.calls[1][1].p_override, null);
  await api.moveReserve(ORG, "k3", ID, "withdrawal", "5.00", "2026-11-24");
  assert.equal(f.calls[2][0], "fin3_move_reserve");
  await api.postTransfer(ORG, "k4", { fromAccountId: ID, toAccountId: ID, fromCurrency: "KES", amountFrom: "5.00", date: "2026-11-24" });
  assert.equal(f.calls[3][1].p_to_ccy, "KES");
  assert.equal(f.calls[3][1].p_override, null);
});

test("every Phase 4 RPC has a wrapper that calls it, and every wrapper calls a real RPC", async () => {
  const f = fake(); const api = createPhase4Api(f.rpc);
  const dec = "1.00", d = "2026-11-24";
  await Promise.all([
    api.getProtectionSettings(ORG), api.updateProtectionSettings(ORG, { mode: "warn" }), api.safeToSpend(ORG), api.checkSpend(ORG, dec, "KES"), api.listProtectionEvents(ORG),
    api.upsertProjectFinance(ORG, ID, { budget: dec }), api.getProjectFinancials(ORG, ID), api.listProjectFinancials(ORG),
    api.upsertAnimatorAssignment(ORG, { agreed_rate: dec }), api.listAnimatorAssignments(ORG), api.submitAnimatorWork(ORG, "k", ID, { quantity: dec }),
    api.approveAnimatorWork(ORG, ID), api.rejectAnimatorWork(ORG, ID, "r"), api.voidAnimatorWork(ORG, ID, "r"), api.payAnimator(ORG, "k", ID, dec, d, ID),
    api.reverseAnimatorPayment(ORG, ID, "r"), api.listAnimatorObligations(ORG), api.animatorStatement(ORG, ID),
    api.allocateProjectFunds(ORG, "k", ID, "production", dec), api.releaseAllocation(ORG, ID), api.listAllocations(ORG),
    api.upsertReserve(ORG, { name: "Tax" }), api.moveReserve(ORG, "k", ID, "contribution", dec, d), api.listReserves(ORG), api.reserveHistory(ORG, ID),
    api.recordOwnerPayment(ORG, "k", "draw", dec, "KES", d, ID), api.scheduleOwnerPayment(ORG, "k", "salary", dec, "KES", d), api.executeOwnerPayment(ORG, ID, d),
    api.cancelOwnerPayment(ORG, ID, "r"), api.reverseOwnerPayment(ORG, ID, "r"), api.recordOwnerPaidExpense(ORG, "k", { amount: dec }), api.listOwnerPayments(ORG), api.ownerSummary(ORG),
  ]);
  assert.deepEqual([...new Set(f.calls.map((c) => c[0]))].sort(), [...PHASE4_RPCS].sort());
});

test("database errors keep their stable code; V3007 means blocked by protection", async () => {
  const api = createPhase4Api(async () => ({ data: null, error: { code: "V3007", message: "Spending blocked" } }));
  await assert.rejects(api.safeToSpend(ORG), (e) => e instanceof FinanceV3Error && e.code === "V3007" && e.codeName === "PROTECTION_BLOCKED");
});
