import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFinanceApi } from "./phase6.js";
import { PHASE6_RPCS, EXPORT_KINDS } from "../contracts/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sql = fs.readFileSync(path.join(ROOT, "supabase/migrations/20270117090000_finance_v3_reporting_alerts.sql"), "utf8").replace(/--.*$/gm, "");
const ORG = "00000000-0000-0000-0000-000000000001", ID = "00000000-0000-0000-0000-0000000000aa";
const rec = (data = { ok: true }) => { const calls = []; const rpc = async (name, args) => { calls.push({ name, args }); return { data, error: null }; }; return { calls, api: createFinanceApi(rpc) }; };

// Parse "create or replace function public.NAME(args) returns" so wrappers are checked against the real parameter names.
function sqlArgs(name) {
  const m = sql.match(new RegExp(`function public\\.${name}\\(([\\s\\S]*?)\\)\\s*returns`)); assert.ok(m, `${name} defined`);
  return m[1].split(/,(?![^(]*\))/).map((a) => a.trim()).filter(Boolean).map((a) => ({ name: a.split(/\s+/)[0], required: !/\bdefault\b/i.test(a) }));
}

test("every Phase 6 RPC has a wrapper whose argument names match the SQL signature exactly", async () => {
  const { calls, api } = rec(); const F = "2026-01-01", T = "2026-01-31";
  await api.dashboard(ORG, { currency: "KES", from: F, to: T }); await api.integrity(ORG); await api.schedulerStatus(ORG); await api.emmaSnapshot(ORG);
  await api.expenseBreakdown(ORG, F, T); await api.animatorObligations(ORG); await api.reservesReport(ORG); await api.ownerCompensation(ORG, F, T); await api.invoiceStatus(ORG, F, T);
  await api.paymentHistory(ORG, F, T); await api.paymentReconciliation(ORG, F, T); await api.emailDelivery(ORG, F, T);
  await api.notifications(ORG, { unreadOnly: true, category: "invoice" }); await api.notificationCounts(ORG); await api.markNotificationsRead(ORG, [ID]); await api.getAlertSettings(ORG);
  await api.setAlertSettings(ORG, { due_soon_days: 5 }); await api.projectFinanceDetail(ORG, ID); await api.setRecordLink(ORG, "work_item", ID, ID, ID, "animation"); await api.exportRows(ORG, "invoices", { from: F, to: T });
  const seen = new Set(calls.map((c) => c.name));
  for (const n of PHASE6_RPCS) assert.ok(seen.has(n), `${n} has a wrapper`);
  for (const c of calls) {
    const decl = sqlArgs(c.name), names = decl.map((d) => d.name);
    for (const k of Object.keys(c.args)) assert.ok(names.includes(k), `${c.name}: ${k} is a real parameter (${names.join(", ")})`);
    for (const d of decl.filter((x) => x.required)) assert.ok(d.name in c.args, `${c.name}: required ${d.name} is sent`);
  }
});
test("dates must be real dates and exports need both or neither", () => {
  const { api } = rec();
  assert.throws(() => api.expenseBreakdown(ORG, "01/01/2026", "2026-01-31"), /From must be a date/); assert.throws(() => api.ownerCompensation(ORG, "2026-01-01", ""), /To must be a date/);
  assert.throws(() => api.exportRows(ORG, "invoices", { from: "2026-01-01" }), /both dates or neither/); assert.throws(() => api.exportRows(ORG, "everything"), /Unknown export/);
  assert.throws(() => api.setRecordLink(ORG, "payment", ID, ID), /Unknown record type/);
});
test("every export kind in the contract is accepted by the wrapper and by the SQL", async () => {
  const { calls, api } = rec({ columns: ["a"], rows: [["1"]], row_count: 1, truncated: false });
  for (const k of EXPORT_KINDS) { await api.exportRows(ORG, k); assert.match(sql, new RegExp(`'${k}'`), `${k} is handled in SQL`); }
  assert.equal(calls.length, EXPORT_KINDS.length);
});
test("exportCsv turns database rows into a defused CSV and reports truncation", async () => {
  const { api } = rec({ columns: ["client", "amount"], rows: [["=HYPERLINK(\"x\")", "-5.00"], ["Acme, Inc", "7.00"]], row_count: 2, truncated: true });
  const r = await api.exportCsv(ORG, "invoices", { orgLabel: "Studio A" });
  assert.equal(r.rowCount, 2); assert.equal(r.truncated, true); assert.match(r.fileName, /^finance-invoices-studio-a-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.ok(r.csv.includes(`"'=HYPERLINK(""x"")",-5.00`)); assert.ok(r.csv.includes('"Acme, Inc",7.00'));
});
test("service-only and unlisted functions cannot be called through call6", async () => {
  const { api } = rec();
  await assert.rejects(api.call6("fin3svc_run_scheduled", {}), /service-only/); await assert.rejects(api.call6("fin3_delete_everything", {}), /not a Phase 6/);
  await assert.rejects(api.call6("intel_agent_finance_read", {}), /not a Phase 6/);
});
test("database errors surface as FinanceV3Error with the code", async () => {
  const api = createFinanceApi(async () => ({ data: null, error: { code: "V3005", message: "You do not have access" } }));
  await assert.rejects(api.dashboard(ORG), (e) => e.code === "V3005" && /access/.test(e.message));
});
test("the Phase 5 API is still there underneath", async () => {
  const { calls, api } = rec(); await api.overview(ORG); assert.equal(calls[0].name, "fin3_overview");
});
