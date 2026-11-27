import test from "node:test";
import assert from "node:assert/strict";
import { createPhase3Api, FinanceV3Error, assertDecimalString } from "./phase3.js";
import { PHASE3_RPCS, PHASE3_SERVICE_RPCS } from "../contracts/index.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const fake = (reply = { data: { ok: true }, error: null }) => { const calls = []; return { calls, rpc: async (n, a) => { calls.push([n, a]); return reply; } }; };

test("service-only RPCs and unknown functions are refused client-side", async () => {
  const f = fake(); const api = createPhase3Api(f.rpc);
  for (const n of PHASE3_SERVICE_RPCS) await assert.rejects(api.call(n, {}), (e) => e instanceof FinanceV3Error && e.codeName === "NOT_AUTHORIZED");
  await assert.rejects(api.call("fin3_post_journal", {}), FinanceV3Error);    // a Phase 2 RPC is not part of this client
  await assert.rejects(api.call("some_other_rpc", {}), FinanceV3Error);
  assert.equal(f.calls.length, 0);
});

test("money must be a decimal string: numbers, exponents and signs never reach the database", async () => {
  const f = fake(); const api = createPhase3Api(f.rpc);
  for (const bad of [12.5, "1e3", "-5", "5.", ".5", " 5", "1,000", null, undefined, "0x10"]) assert.throws(() => assertDecimalString(bad), FinanceV3Error, String(bad));
  assert.equal(assertDecimalString("0.50"), "0.50");
  await assert.rejects(async () => api.creditInvoice(ORG, "k", ORG, 10, "x"), FinanceV3Error);
  await assert.rejects(async () => api.saveInvoiceDraft(ORG, "k", { clientId: ORG, currency: "KES", lines: [{ description: "a", quantity: 2, unit_price: "1.00" }] }), FinanceV3Error);
  assert.equal(f.calls.length, 0);
});

test("each wrapper sends the documented named parameters to the right RPC", async () => {
  const f = fake(); const api = createPhase3Api(f.rpc);
  await api.recordManualPayment(ORG, "k1", { invoiceId: "i", amount: "100.00", currency: "KES", receivedOn: "2026-11-23", method: "cash", cashAccountId: "a" });
  assert.equal(f.calls[0][0], "fin3_record_manual_payment");
  assert.deepEqual(Object.keys(f.calls[0][1]).sort(), ["p_amount", "p_cash_account", "p_currency", "p_evidence", "p_invoice", "p_key", "p_method", "p_notes", "p_org", "p_received_on", "p_reference"]);
  await api.createPaymentLink(ORG, "i", { amount: "50.00" });
  assert.deepEqual(f.calls[1][1], { p_org: ORG, p_invoice: "i", p_link_kind: "pay", p_amount: "50.00", p_expires_days: 30 });
  await api.listInvoices(ORG, { overdueOnly: true });
  assert.equal(f.calls[2][1].p_overdue_only, true);
});

test("every RPC name the wrappers use is a real Phase 3 RPC", async () => {
  const f = fake(); const api = createPhase3Api(f.rpc);
  const real = new Set(PHASE3_RPCS);
  const src = (await import("node:fs")).readFileSync(new URL("./phase3.js", import.meta.url), "utf8");
  const used = [...src.matchAll(/call\("(fin3_[a-z_0-9]+)"/g)].map((m) => m[1]);
  assert.ok(used.length > 30);
  for (const n of used) assert.ok(real.has(n), n);
});

test("database errors keep their stable V3xxx code and name", async () => {
  const api = createPhase3Api(async () => ({ data: null, error: { code: "V3012", message: "more than the outstanding balance" } }));
  await assert.rejects(api.approveInvoice(ORG, "i"), (e) => e.code === "V3012" && e.codeName === "OVERPAYMENT");
});
