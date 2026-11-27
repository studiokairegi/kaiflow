import React, { useState } from "react";
import { Async, Banner, Button, Card, DataTable, EmptyState, Stat, useFinance, useResource } from "../shared/kit.jsx";
import { InvoiceStatusPill, Money, VerificationPill } from "../shared/parts.jsx";
import { fmtDate, fmtDateTime, isNegative, isZero, label } from "../shared/format.js";
import { UI_ACTIONS } from "./actions.js";
import QuickActionDialog from "./QuickActions.jsx";
import InvoiceEditor from "./InvoiceEditor.jsx";
import SafeToSpendExplainer from "../shared/SafeToSpendExplainer.jsx";

// "This month" comes from the same reporting service the Accountant statements use (fin3_dashboard); nothing is added up here.
function ThisMonth() {
  const { api, org } = useFinance(); const res = useResource(() => api.dashboard(org), [api, org]);
  return (<Card title="This month" sub="Revenue, costs and profit from the ledger."><Async res={res} lines={2}>{(d) => (<div className="grid">
    <Stat label="Revenue" value={<Money value={d.revenue} currency={d.currency} />} />
    <Stat label="Expenses" value={<Money value={d.expenses} currency={d.currency} />} />
    <Stat label="Profit" value={<Money value={d.profit} currency={d.currency} />} tone={isNegative(d.profit) ? "bad" : undefined} />
    <Stat label="Overdue invoices" value={d.overdue_invoice_count} sub={<Money value={d.overdue_invoices} currency={d.currency} />} tone={d.overdue_invoice_count > 0 ? "warn" : undefined} /></div>)}</Async></Card>);
}
export default function Home({ go = undefined }) {
  const { api, org, can } = useFinance();
  const [action, setAction] = useState(null); const [explain, setExplain] = useState(false);
  const res = useResource(() => api.overview(org), [api, org]);
  const done = () => res.reload();
  const act = (a) => { if (a.go) go(a.go); else setAction(a.id); };
  return (<div className="stack">
    <Async res={res} lines={6}>{(o) => (<>
      <p className="sub">Showing money in {o.currency}.</p>
      {o.warnings?.map((w) => <Banner key={w.code + (w.invoice_id || "")} tone={w.severity === "critical" ? "critical" : w.severity === "info" ? "info" : "warning"}>{w.message}</Banner>)}
      <div className="grid">
        <Stat hero label="Safe to spend" value={<Money value={o.safe_to_spend} currency={o.currency} />} tone={isZero(o.safe_to_spend) ? "warn" : undefined} sub={isZero(o.safe_to_spend) && !isZero(o.shortfall) ? `Short by ${o.shortfall}` : undefined} onClick={() => setExplain(true)} hint="Tap to see how this is worked out" />
        <Stat label="Money in the bank" value={<Money value={o.money_in_bank} currency={o.currency} />} />
        <Stat label="Received in the last 30 days" value={<Money value={o.money_received_last_30_days} currency={o.currency} />} />
        <Stat label="Clients owe you" value={<Money value={o.clients_owe_you} currency={o.currency} />} sub={!isZero(o.clients_overdue) ? `${o.clients_overdue} overdue` : undefined} tone={!isZero(o.clients_overdue) ? "warn" : undefined} onClick={() => go("invoices")} />
        <Stat label="You owe animators" value={<Money value={o.owed_to_animators} currency={o.currency} />} />
        <Stat label="Other bills to pay" value={<Money value={o.other_bills_outstanding} currency={o.currency} />} />
        <Stat label="Business reserve" value={<Money value={o.business_reserve} currency={o.currency} />} />
      </div>
      <ThisMonth />
      <Card title="Quick actions"><div className="row">{UI_ACTIONS.filter((a) => can(a.needs)).map((a) => <Button key={a.id} onClick={() => act(a)}>{a.label}</Button>)}</div></Card>
      <div className="grid2">
        <Card title="Recent payments"><DataTable caption="Recent payments" rows={o.recent_payments} columns={[
          { key: "invoice_no", header: "Invoice" }, { key: "amount", header: "Amount", num: true, render: (r) => <Money value={r.amount} currency={r.currency} /> },
          { key: "received_at", header: "Received", render: (r) => fmtDate(r.received_at) }, { key: "v", header: "Status", render: (r) => <VerificationPill status={r.verification_status} /> }]}
          onRowClick={(r) => go("invoices", r.invoice_id)} empty={<EmptyState title="No payments yet">Payments appear here as clients pay.</EmptyState>} /></Card>
        <Card title="Recent invoices"><DataTable caption="Recent invoices" rows={o.recent_invoices} columns={[
          { key: "invoice_no", header: "Invoice", render: (r) => r.invoice_no || "Draft" }, { key: "client_name", header: "Client" },
          { key: "outstanding", header: "Owing", num: true, render: (r) => <Money value={r.outstanding} currency={r.currency} /> }, { key: "status", header: "Status", render: (r) => <InvoiceStatusPill invoice={r} /> }]}
          onRowClick={(r) => go("invoices", r.id)} empty={<EmptyState title="No invoices yet" action={can("finance.post") && <Button kind="primary" onClick={() => setAction("create_invoice")}>Create your first invoice</Button>} />} /></Card>
      </div>
      <Card title="Recent activity"><DataTable caption="Recent activity" rows={o.recent_activity} rowKey={(r, i) => i} columns={[
        { key: "at", header: "When", render: (r) => fmtDateTime(r.at) }, { key: "action", header: "What happened", render: (r) => label({}, r.action) }, { key: "object_type", header: "About", render: (r) => label({}, r.object_type) }]}
        empty={<EmptyState title="Nothing yet" />} /></Card></>)}</Async>
    {explain && <SafeToSpendExplainer currency={res.data?.currency} onClose={() => setExplain(false)} />}
    {action === "create_invoice" && <InvoiceEditor onClose={() => setAction(null)} onSaved={(inv) => { setAction(null); go("invoices", inv.id); }} />}
    {action && action !== "create_invoice" && <QuickActionDialog action={action} onClose={() => setAction(null)} onDone={done} />}
  </div>);
}
