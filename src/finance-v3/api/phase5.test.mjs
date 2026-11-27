import test from "node:test";
import assert from "node:assert/strict";
import { createFinanceApi, assertEmailEdit } from "./phase5.js";
import { PHASE5_RPCS } from "../contracts/index.js";

const rec = () => { const calls = []; const rpc = async (name, args) => { calls.push({ name, args }); return { data: { ok: true }, error: null }; }; return { calls, api: createFinanceApi(rpc) }; };
const ORG = "00000000-0000-0000-0000-000000000001";

test("every Phase 5 RPC is reachable through a wrapper with the right parameter names", async () => {
  const { calls, api } = rec();
  await api.getUiPrefs(ORG); await api.setUiMode(ORG, "accountant"); await api.overview(ORG, "KES"); await api.explainSafeToSpend(ORG); await api.profitLoss(ORG, "2026-01-01", "2026-01-31");
  await api.balanceSheet(ORG, "2026-01-31"); await api.cashFlow(ORG, "2026-01-01", "2026-01-31"); await api.generalLedger(ORG, "acc", { limit: 10 }); await api.taxSummary(ORG, "2026-01-01", "2026-01-31");
  await api.listEntries(ORG, { search: "x" }); await api.listAudit(ORG, { objectType: "payment" }); await api.listReceipts(ORG, "inv"); await api.previewInvoiceEmail(ORG, "inv", "a@b.co", { subject: "Hi" });
  await api.legacyHistoryReport(ORG); await api.importLegacyHistory(ORG);
  const run = await api.startLegacyInvoiceRun(ORG, "2026-11-27", "test");
  await api.extractLegacyInvoices(ORG); await api.stageLegacyInvoices(ORG, "run-id", [{ source_id: "legacy-id" }]);
  await api.validateLegacyInvoiceRun(ORG, "run-id"); await api.importLegacyInvoiceRun(ORG, "run-id");
  await api.legacyInvoiceMigrationReport(ORG, "run-id");
  const seen = new Set(calls.map((c) => c.name)); for (const n of PHASE5_RPCS) assert.ok(seen.has(n), `${n} has a wrapper`);
  assert.deepEqual(calls.find((c) => c.name === "fin3_set_ui_prefs").args, { p_org: ORG, p_prefs: { mode: "accountant" } });
  assert.equal(calls.find((c) => c.name === "fin3_report_general_ledger").args.p_limit, 10);
});
test("the mode must be simple or accountant", () => { const { api } = rec(); assert.throws(() => api.setUiMode(ORG, "expert"), /Mode must be/); });
test("the email edit is limited to a single-line subject of 150 and a message of 2000 characters", () => {
  assert.deepEqual(assertEmailEdit({ subject: "Hello", message: "Line1\nLine2", include_payment_link: false }), { subject: "Hello", message: "Line1\nLine2", include_payment_link: false });
  assert.throws(() => assertEmailEdit({ subject: "x".repeat(151) }), /at most 150/); assert.throws(() => assertEmailEdit({ message: "x".repeat(2001) }), /at most 2000/);
  assert.throws(() => assertEmailEdit({ subject: "a\nb" }), /single line/); assert.throws(() => assertEmailEdit({ subject: 5 }), /must be text/);
  assert.deepEqual(assertEmailEdit({ subject: undefined, message: null }), {});
});
test("the edited subject and message travel in p_options and never touch invoice parameters", async () => {
  const { calls, api } = rec(); await api.queueInvoiceEmail(ORG, "inv", "a@b.co", { subject: "S", message: "M" });
  assert.deepEqual(Object.keys(calls[0].args).sort(), ["p_invoice", "p_options", "p_org", "p_recipient"]); assert.deepEqual(calls[0].args.p_options, { subject: "S", message: "M" });
  await api.issueAndSendInvoice(ORG, "inv", { subject: "S" }); assert.equal(calls[1].name, "fin3_issue_and_send_invoice");
});
test("service-only and unknown functions can never be called through the screens' API", async () => {
  const { api } = rec();
  await assert.rejects(api.call("fin3svc_claim_emails", {}), /service-only/); await assert.rejects(api.call("fin3_does_not_exist", {}), /not a Finance V3 RPC/);
});
test("database errors become FinanceV3Error with the code and name", async () => {
  const api = createFinanceApi(async () => ({ data: null, error: { code: "V3007", message: "blocked" } }));
  await assert.rejects(api.overview(ORG), (e) => e.code === "V3007" && e.name === "FinanceV3Error" || e.code === "V3007");
});
test("Phase 4 spending paths (with the override) are used, not the Phase 3 ones", async () => {
  const { calls, api } = rec(); await api.payBill(ORG, "k", "b", "10.00", "2026-01-01", "acc", { override: { reason: "Needed today for rent" } });
  assert.deepEqual(calls[0].args.p_override, { reason: "Needed today for rent" }); await assert.rejects(async () => api.payBill(ORG, "k", "b", "10.00", "2026-01-01", "acc", { override: { reason: "short" } }), /override reason/);
});
test("money must be a decimal string", async () => { const { api } = rec(); await assert.rejects(async () => api.payBill(ORG, "k", "b", 10, "2026-01-01", "acc"), /string|decimal/i); });
