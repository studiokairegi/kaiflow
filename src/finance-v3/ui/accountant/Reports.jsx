// Phase 6 accountant screens: report picker, exports, alert settings and system health. All figures come from the database; nothing is calculated here.
import React, { useState } from "react";
import { Async, Banner, Button, Card, DataTable, EmptyState, Field, Pill, Stat, useBusy, useFinance, useResource } from "../shared/kit.jsx";
import { fmtDateTime, groupMoney, label } from "../shared/format.js";
import { friendlyError } from "../shared/errors.js";
import { EXPORT_KINDS } from "../../contracts/index.js";
import { RangeBar, ccyArg, useRange, validRange } from "./common.jsx";

/** @type {[string, string, boolean, boolean][]} */
const REPORTS = [
  ["invoiceStatus", "Invoice status", true, true], ["paymentHistory", "Payment history", true, true], ["paymentReconciliation", "Payment reconciliation", true, false],
  ["expenseBreakdown", "Expense breakdown", true, true], ["animatorObligations", "Animator obligations", false, true], ["reservesReport", "Business reserve", false, false],
  ["ownerCompensation", "Owner compensation", true, false], ["emailDelivery", "Email delivery", true, false]];
const DEC = /^-?\d+(\.\d+)?$/;
const cell = (v) => (v === null || v === undefined || v === "" ? "—" : typeof v === "boolean" ? (v ? "Yes" : "No") : typeof v === "string" && DEC.test(v) ? groupMoney(v) : typeof v === "object" ? JSON.stringify(v) : String(v));
// Shows any report result: plain values as figures, lists of records as tables.
export function ReportResult({ data = undefined }) {
  if (!data || typeof data !== "object") return null;
  const scalars = Object.entries(data).filter(([, v]) => v === null || typeof v !== "object");
  const lists = Object.entries(data).filter(([, v]) => Array.isArray(v) && v.length && typeof v[0] === "object");
  const objs = Object.entries(data).filter(([, v]) => v && typeof v === "object" && !Array.isArray(v));
  return (<div className="stack">
    {scalars.length > 0 && <div className="grid">{scalars.map(([k, v]) => <Stat key={k} label={label({}, k)} value={cell(v)} />)}</div>}
    {objs.map(([k, o]) => <Card key={k} title={label({}, k)}><div className="grid">{Object.entries(o).filter(([, v]) => typeof v !== "object").map(([kk, v]) => <Stat key={kk} label={label({}, kk)} value={cell(v)} />)}</div></Card>)}
    {lists.map(([k, rows]) => <Card key={k} title={label({}, k)}><DataTable caption={label({}, k)} rows={rows} rowKey={(r, i) => r.id ?? i}
      columns={Object.keys(rows[0]).filter((c) => typeof rows[0][c] !== "object").slice(0, 8).map((c) => ({ key: c, header: label({}, c), num: DEC.test(String(rows[0][c] ?? "")), render: (r) => cell(r[c]) }))} /></Card>)}
    {!scalars.length && !lists.length && !objs.length && <EmptyState title="Nothing to show for this report" />}</div>);
}
export function Reports() {
  const { api, org } = useFinance(); const [id, setId] = useState(REPORTS[0][0]); const [r, setR] = useRange(30); const [c, setC] = useState("");
  const rep = REPORTS.find((x) => x[0] === id); const needRange = rep[2];
  const res = useResource(() => {
    if (needRange && !validRange(r)) return Promise.resolve(null);
    if (id === "animatorObligations") return api.animatorObligations(org, ccyArg(c));
    if (id === "reservesReport") return api.reservesReport(org);
    if (id === "ownerCompensation" || id === "paymentReconciliation" || id === "emailDelivery") return api[id](org, r.from, r.to);
    return api[id](org, r.from, r.to, ccyArg(c));
  }, [api, org, id, r.from, r.to, c]);
  return (<div className="stack"><Field label="Report"><select value={id} onChange={(e) => setId(e.target.value)}>{REPORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
    {needRange ? <RangeBar range={r} onChange={setR} currency={rep[3] ? c : undefined} onCurrency={rep[3] ? setC : undefined} /> : rep[3] && <RangeBar range={r} onChange={setR} single currency={c} onCurrency={setC} />}
    {needRange && !validRange(r) ? <Banner tone="warning">Choose a start date that is not after the end date.</Banner> : <Async res={res}>{(d) => <ReportResult data={d} />}</Async>}
    <p className="sub">Profit and loss, balance sheet, cash flow, trial balance and general ledger are in their own tabs.</p></div>);
}
const EXPORT_LABEL = { invoices: "Invoices", payments: "Payments", transactions: "Ledger transactions", audit: "Audit history", project_profitability: "Project profitability", email_delivery: "Email delivery", expenses: "Expenses", report_profit_loss: "Profit and loss" };
export function Exports() {
  const { api, org, can } = useFinance(); const [kind, setKind] = useState(EXPORT_KINDS[0]); const [r, setR] = useRange(30); const [busy, wrap] = useBusy(); const [msg, setMsg] = useState(null);
  const run = () => wrap(async () => {
    setMsg(null);
    try {
      const o = validRange(r) ? { from: r.from, to: r.to } : {};
      const out = await api.exportCsv(org, kind, o);
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([out.csv], { type: "text/csv;charset=utf-8" })); a.download = out.fileName; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      setMsg({ tone: out.truncated ? "warning" : "ok", text: `${out.rowCount} row${out.rowCount === 1 ? "" : "s"} exported to ${out.fileName}.${out.truncated ? " The export was cut at the maximum size; narrow the dates and export again." : ""}` });
    } catch (e) { setMsg({ tone: "critical", text: friendlyError(e) }); }
  });
  return (<div className="stack"><Card title="Export to CSV" sub="Opens in Excel or Google Sheets. Exports are recorded in the audit history and leave out secrets and card data.">
    <Field label="What to export"><select value={kind} onChange={(e) => setKind(e.target.value)}>{EXPORT_KINDS.map((k) => <option key={k} value={k}>{EXPORT_LABEL[k] || label({}, k)}</option>)}</select></Field>
    <RangeBar range={r} onChange={setR} />
    <div className="row"><Button kind="primary" busy={busy} disabled={!can("finance.read")} onClick={run}>Download CSV</Button></div>
    {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}</Card></div>);
}
const SET_FIELDS = [["due_soon_days", "Warn this many days before an invoice is due", 0, 30], ["budget_warn_percent", "Warn when a project has used this % of its budget", 1, 100],
  ["pending_payment_minutes", "Flag payments pending longer than (minutes)", 1, 10080], ["reminder_first_after_days", "First reminder after overdue (days)", 0, 90], ["reminder_repeat_days", "Repeat reminder every (days)", 1, 90], ["max_reminders", "Maximum reminders per invoice", 0, 20]];
export function Alerts() {
  const { api, org, can } = useFinance(); const res = useResource(() => api.getAlertSettings(org), [api, org]); const [form, setForm] = useState(null); const [busy, wrap] = useBusy(); const [msg, setMsg] = useState(null);
  const sched = useResource(() => api.schedulerStatus(org).catch(() => null), [api, org]); const integ = useResource(() => api.integrity(org).catch(() => null), [api, org]);
  const f = form || res.data; const admin = can("finance.admin");
  const save = () => wrap(async () => { setMsg(null); try { const d = await api.setAlertSettings(org, form); setForm(null); res.reload(); setMsg({ tone: "ok", text: "Settings saved." }); return d; } catch (e) { setMsg({ tone: "critical", text: friendlyError(e) }); } });
  return (<div className="stack">
    <Card title="Alerts and reminders" sub="Client reminders and automatic receipts are off until you turn them on. They never send twice for the same invoice step.">
      <Async res={res}>{() => f && (<>
        <div className="grid2">{SET_FIELDS.map(([k, l, min, max]) => <Field key={k} label={l}><input type="number" min={min} max={max} value={f[k]} disabled={!admin} onChange={(e) => setForm({ ...f, [k]: e.target.value === "" ? "" : Number(e.target.value) })} /></Field>)}</div>
        <label className="row"><input type="checkbox" checked={!!f.reminders_enabled} disabled={!admin} onChange={(e) => setForm({ ...f, reminders_enabled: e.target.checked })} /> Send overdue reminders to clients automatically</label>
        <label className="row"><input type="checkbox" checked={!!f.auto_receipts} disabled={!admin} onChange={(e) => setForm({ ...f, auto_receipts: e.target.checked })} /> Send receipts to clients automatically</label>
        {admin ? <div className="row"><Button kind="primary" busy={busy} disabled={!form} onClick={save}>Save settings</Button></div> : <p className="sub">Only a finance admin can change these.</p>}
        {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}</>)}</Async></Card>
    <Card title="Background checks"><Async res={sched}>{(s) => s ? (<div className="grid"><Stat label="Last run" value={s.last_run_at ? fmtDateTime(s.last_run_at) : "Never"} /><Stat label="Scheduler" value={s.configured ? "Set up" : "Not set up"} tone={s.configured ? undefined : "warn"} />
      <Stat label="Last result" value={s.last_error ? "Had an error" : s.last_run_at ? "Completed" : "—"} tone={s.last_error ? "bad" : undefined} /><Stat label="Open alerts" value={String(s.open_notifications ?? 0)} /></div>) : <p className="sub">Status is not available to your role.</p>}</Async></Card>
    <Card title="Books health" sub="Checks that invoices, payments and the ledger agree."><Async res={integ}>{(d) => d ? (<><Banner tone={d.all_ok === false ? "critical" : "ok"}>{d.all_ok === false ? "Some records do not agree. See the details below." : "All checks passed."}</Banner><ReportResult data={d} /></>) : <p className="sub">Not available to your role.</p>}</Async></Card></div>);
}
