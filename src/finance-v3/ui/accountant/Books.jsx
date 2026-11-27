import React, { useEffect, useState } from "react";
import { Async, Banner, Button, Card, DataTable, EmptyState, Field, Stat, useBusy, useFinance, useResource } from "../shared/kit.jsx";
import { ActionDialog, InvoiceStatusPill, Money } from "../shared/parts.jsx";
import { INVOICE_STATUS, fmtDate, isZero, label, todayISO } from "../shared/format.js";
import { friendlyError } from "../shared/errors.js";
import InvoiceDetail from "../simple/InvoiceDetail.jsx";
import SafeToSpendExplainer from "../shared/SafeToSpendExplainer.jsx";
import { RangeBar, ccyArg, useRange, validRange } from "./common.jsx";

export function Overview({ go = undefined }) {
  const { api, org } = useFinance(); const [explain, setExplain] = useState(false);
  const o = useResource(() => api.overview(org), [api, org]); const tb = useResource(() => api.trialBalance(org), [api, org]);
  return (<div className="stack"><Async res={o}>{(d) => (<><div className="grid">
    <Stat hero label="Safe to spend" value={<Money value={d.safe_to_spend} currency={d.currency} />} onClick={() => setExplain(true)} hint="Trace it to accounts" />
    <Stat label="Available cash" value={<Money value={d.available_cash} currency={d.currency} />} /><Stat label="Receivables" value={<Money value={d.clients_owe_you} currency={d.currency} />} sub={`${d.clients_overdue} overdue`} />
    <Stat label="Owed to animators" value={<Money value={d.owed_to_animators} currency={d.currency} />} /><Stat label="Supplier bills" value={<Money value={d.other_bills_outstanding} currency={d.currency} />} /><Stat label="Reserves" value={<Money value={d.business_reserve} currency={d.currency} />} /></div>
    {d.warnings.map((w) => <Banner key={w.code + (w.invoice_id || "")} tone={w.severity === "critical" ? "critical" : "warning"}>{w.message}</Banner>)}</>)}</Async>
    <Card title="Ledger health"><Async res={tb} lines={2}>{(t) => (<p>{t.balanced ? "The trial balance is balanced" : "The trial balance does NOT balance"} · debits {t.total_debits} · credits {t.total_credits} · base currency {t.base_currency}. <Button small onClick={() => go("tb")}>Open trial balance</Button></p>)}</Async></Card>
    {explain && <SafeToSpendExplainer currency={o.data?.currency} onClose={() => setExplain(false)} />}</div>);
}

export function Sales() {
  const { api, org } = useFinance(); const [status, setStatus] = useState(""); const [overdue, setOverdue] = useState(false); const [sel, setSel] = useState(null); const [stack, setStack] = useState([null]);
  const cursor = stack[stack.length - 1];
  const res = useResource(() => api.listInvoices(org, { status: status || null, overdueOnly: overdue, limit: 50, cursor }), [api, org, status, overdue, cursor && JSON.stringify(cursor)]);
  if (sel) return <InvoiceDetail id={sel} onBack={() => setSel(null)} />;
  return (<div className="stack"><div className="row"><Field label="Status"><select value={status} onChange={(e) => { setStatus(e.target.value); setStack([null]); }}><option value="">All</option>{Object.entries(INVOICE_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
    <label className="row sub"><input type="checkbox" checked={overdue} onChange={(e) => { setOverdue(e.target.checked); setStack([null]); }} /> Overdue only</label></div>
    <Async res={res}>{(d) => (<><DataTable caption="Sales invoices" rows={d.items} onRowClick={(r) => setSel(r.id)} columns={[{ key: "invoice_no", header: "No.", render: (r) => r.invoice_no || "Draft" }, { key: "client", header: "Client", render: (r) => r.client?.name }, { key: "issue_date", header: "Date", render: (r) => fmtDate(r.issue_date) },
      { key: "subtotal", header: "Net", num: true, render: (r) => <Money value={r.subtotal} currency={r.currency} /> }, { key: "tax_total", header: "Tax", num: true, render: (r) => <Money value={r.tax_total} currency={r.currency} /> }, { key: "total", header: "Total", num: true, render: (r) => <Money value={r.total} currency={r.currency} /> },
      { key: "outstanding", header: "Open", num: true, render: (r) => <Money value={r.outstanding} currency={r.currency} /> }, { key: "status", header: "Status", render: (r) => <InvoiceStatusPill invoice={r} /> }]} empty={<EmptyState title="No invoices match" />} />
      <div className="row" style={{ justifyContent: "space-between" }}><Button small disabled={stack.length < 2} onClick={() => setStack((s) => s.slice(0, -1))}>Newer</Button><Button small disabled={!d.next_cursor} onClick={() => setStack((s) => [...s, d.next_cursor])}>Older</Button></div></>)}</Async></div>);
}
function Aging({ load = undefined, partyKey = undefined, partyName = undefined, title = undefined, countKey = undefined }) {
  const { api, org } = useFinance(); const [asOf, setAsOf] = useState(todayISO()); const [c, setC] = useState("");
  const res = useResource(() => load(api, org, asOf, ccyArg(c)), [api, org, asOf, c]);
  const cols = [["current", "Current"], ["days_1_30", "1–30"], ["days_31_60", "31–60"], ["days_61_90", "61–90"], ["over_90", "Over 90"], ["total", "Total"]];
  return (<div className="stack"><RangeBar range={{ from: "", to: asOf }} onChange={(x) => setAsOf(x.to)} single currency={c} onCurrency={setC} />
    <Async res={res}>{(d) => (<>{[["Totals", d.totals, null], [title, d[partyKey], partyName]].map(([t, rows, nm]) => <Card key={t} title={t}><DataTable caption={t} rows={rows} rowKey={(r, i) => i} columns={[...(nm ? [{ key: nm, header: nm === "client_name" ? "Client" : "Supplier" }] : []), { key: "currency", header: "Currency" },
      ...cols.map(([k, l]) => ({ key: k, header: l, num: true, render: (r) => <Money value={r[k]} /> })), { key: countKey, header: "Count", num: true }]} empty={<EmptyState title="Nothing outstanding" />} /></Card>)}</>)}</Async></div>);
}
Sales.Aging = () => <Aging load={(a, o, d, c) => a.receivablesAging(o, d, c)} partyKey="clients" partyName="client_name" title="By client" countKey="invoice_count" />;

export function Purchases() {
  const { api, org } = useFinance(); const [status, setStatus] = useState(""); const [sel, setSel] = useState(null);
  const res = useResource(() => api.listBills(org, status || null, 200), [api, org, status]);
  const bill = useResource(() => (sel ? api.getBill(org, sel) : Promise.resolve(null)), [api, org, sel]);
  return (<div className="stack"><Field label="Status"><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{["draft", "approved", "partially_paid", "paid", "void"].map((s) => <option key={s} value={s}>{label({}, s)}</option>)}</select></Field>
    <Async res={res}>{(rows) => <DataTable caption="Supplier bills" rows={rows} onRowClick={(r) => setSel(r.id)} columns={[{ key: "bill_no", header: "Bill" }, { key: "supplier", header: "Supplier", render: (r) => r.supplier?.name }, { key: "bill_date", header: "Date", render: (r) => fmtDate(r.bill_date) }, { key: "due_date", header: "Due", render: (r) => fmtDate(r.due_date) },
      { key: "total", header: "Total", num: true, render: (r) => <Money value={r.total} currency={r.currency} /> }, { key: "amount_paid", header: "Paid", num: true, render: (r) => <Money value={r.amount_paid} currency={r.currency} /> }, { key: "status", header: "Status", render: (r) => label({}, r.status) }]} empty={<EmptyState title="No supplier bills" />} />}</Async>
    {sel && <Card title="Bill detail" actions={<Button small onClick={() => setSel(null)}>Close</Button>}><Async res={bill} lines={3}>{(b) => b && <DataTable caption="Bill lines" rows={b.lines} rowKey={(l) => l.line_no} columns={[{ key: "line_no", header: "#" }, { key: "description", header: "Description" }, { key: "account_id", header: "Account" }, { key: "amount", header: "Amount", num: true, render: (l) => <Money value={l.amount} currency={b.currency} /> }]} />}</Async></Card>}</div>);
}
Purchases.Aging = () => <Aging load={(a, o, d, c) => a.payablesAging(o, d, c)} partyKey="suppliers" partyName="supplier_name" title="By supplier" countKey="bill_count" />;

export function Expenses() {
  const { api, org } = useFinance(); const [r, setR] = useRange(90);
  const res = useResource(() => (validRange(r) ? api.listExpenses(org, r.from, r.to, 200) : Promise.resolve(null)), [api, org, r.from, r.to]);
  const cats = useResource(() => api.listExpenseCategories(org), [api, org]); const cat = Object.fromEntries((cats.data || []).map((c) => [c.id, c]));
  return (<div className="stack"><RangeBar range={r} onChange={setR} />{validRange(r) ? <Async res={res}>{(rows) => rows && <DataTable caption="Expenses" rows={rows} columns={[{ key: "expense_date", header: "Date", render: (x) => fmtDate(x.expense_date) }, { key: "expense_no", header: "No." }, { key: "description", header: "Description" },
    { key: "category_id", header: "Category / account", render: (x) => (cat[x.category_id] ? `${cat[x.category_id].account_code} ${cat[x.category_id].name}` : "—") }, { key: "vendor_name", header: "Vendor" }, { key: "tax_class", header: "Tax class", render: (x) => label({}, x.tax_class) },
    { key: "amount", header: "Amount", num: true, render: (x) => <Money value={x.amount} currency={x.currency} /> }, { key: "payment_status", header: "Payment", render: (x) => label({}, x.payment_status) }]} empty={<EmptyState title="No expenses in this period" />} />}</Async> : <Banner tone="warning">Choose a start date that is not after the end date.</Banner>}</div>);
}

export function Banking() {
  const { api, org } = useFinance(); const [asOf, setAsOf] = useState(todayISO());
  const res = useResource(() => api.listBankAccounts(org, asOf), [api, org, asOf]);
  return (<div className="stack"><RangeBar range={{ from: "", to: asOf }} onChange={(x) => setAsOf(x.to)} single />
    <Async res={res}>{(rows) => <DataTable caption="Bank and cash accounts" rows={rows} columns={[{ key: "name", header: "Account" }, { key: "kind", header: "Kind", render: (b) => label({}, b.kind) }, { key: "account_last4", header: "Last 4" }, { key: "currency", header: "Currency" },
      { key: "ledger_balance", header: "Ledger balance", num: true, render: (b) => <Money value={b.ledger_balance} currency={b.currency} /> }, { key: "is_active", header: "Active", render: (b) => (b.is_active ? "Yes" : "No") }]} empty={<EmptyState title="No bank accounts yet" />} />}</Async></div>);
}

export function Reconciliation() {
  const { api, org, can } = useFinance(); const banks = useResource(() => api.listBankAccounts(org), [api, org]); const [rec, setRec] = useState(null); const [open, setOpen] = useState(false);
  const sum = useResource(() => (rec ? api.reconciliationSummary(org, rec) : Promise.resolve(null)), [api, org, rec]);
  return (<div className="stack"><p className="sub">Compare a bank statement balance with the ledger. Starting a reconciliation records nothing in the ledger.</p>
    {can("finance.post") && <div><Button kind="primary" onClick={() => setOpen(true)}>Start a reconciliation</Button></div>}
    {rec && <Card title="Reconciliation summary"><Async res={sum} lines={3}>{(s) => s && <dl className="kv"><dt>Status</dt><dd>{label({}, s.status)}</dd><dt>Statement date</dt><dd>{fmtDate(s.statement_date)}</dd><dt>Statement balance</dt><dd><Money value={s.statement_balance} currency={s.currency} /></dd>
      <dt>Ledger balance</dt><dd><Money value={s.ledger_balance} currency={s.currency} /></dd><dt>Cleared balance</dt><dd><Money value={s.cleared_balance} currency={s.currency} /></dd><dt>Difference</dt><dd><Money value={s.difference} currency={s.currency} /> {isZero(s.difference) ? "· agrees" : "· does not agree yet"}</dd></dl>}</Async></Card>}
    {open && <ActionDialog title="Start a reconciliation" confirmText="Start" intro="Enter the closing balance exactly as shown on the bank statement."
      fields={[{ name: "bank", label: "Account", type: "select", required: true, options: (banks.data || []).map((b) => ({ value: b.id, label: `${b.name} (${b.currency})` })) }, { name: "date", label: "Statement date", type: "date", required: true, default: todayISO() }, { name: "bal", label: "Statement closing balance", type: "money", allowZero: true }]}
      onClose={() => setOpen(false)} onSubmit={async (v) => { const r = await api.startReconciliation(org, v.bank, v.date, v.bal); setRec(r.reconciliation?.id || r.id); }} />}</div>);
}

export function Settings() {
  const { api, org } = useFinance(); const res = useResource(() => api.getOrgSettings(org), [api, org]);
  return (<Async res={res}>{(s) => (<Card title="Accounting settings" sub="Read-only here. Changes are made by a finance admin through the settings tools."><dl className="kv">{Object.entries(s).filter(([, v]) => typeof v !== "object" || v === null || Array.isArray(v)).map(([k, v]) => <React.Fragment key={k}><dt>{label({}, k)}</dt><dd>{Array.isArray(v) ? v.join(", ") || "—" : String(v ?? "—")}</dd></React.Fragment>)}</dl></Card>)}</Async>);
}
