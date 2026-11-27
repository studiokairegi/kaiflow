// "How is this worked out?": the same service as the Home figure, with every deduction traced to its commitments.
import React from "react";
import { Async, Banner, Button, DataTable, Dialog, useFinance, useResource } from "./kit.jsx";
import { Money } from "./parts.jsx";
import { fmtDate, isZero } from "./format.js";

export default function SafeToSpendExplainer({ currency = undefined, onClose = undefined }) {
  const { api, org } = useFinance();
  const res = useResource(() => api.explainSafeToSpend(org, currency), [api, org, currency]);
  return (<Dialog title="How safe-to-spend is worked out" wide onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
    <Async res={res}>{(e) => { const c = e.currency || currency; return (<div className="stack">
      <table className="fv3-table"><tbody>
        <tr><td>Cash you hold</td><td className="num"><Money value={e.available_cash ?? e.cash_total} currency={c} /></td></tr>
        {(e.deductions || []).map((d) => <tr key={d.key}><td>Less: {d.label}</td><td className="num"><Money value={`-${String(d.amount).replace(/^-/, "")}`} currency={c} /></td></tr>)}
        <tr className="totals"><td>Safe to spend (never below zero)</td><td className="num"><Money value={e.safe_to_spend} currency={c} /></td></tr></tbody></table>
      {!isZero(e.shortfall) && <Banner tone="warning" title="You are short.">Your commitments are {e.shortfall} more than the cash you hold.</Banner>}
      {(e.reserves || []).length > 0 && <div><h3>Reserves</h3><DataTable caption="Reserves" rows={e.reserves} rowKey={(r, i) => i} columns={[{ key: "name", header: "Reserve" }, { key: "treatment", header: "How it is treated" }, { key: "amount", header: "Amount", num: true, render: (r) => <Money value={r.balance} currency={c} /> }]} /></div>}
      {(e.items?.animator_obligations || []).length > 0 && <div><h3>Owed to animators</h3><DataTable caption="Animator obligations" rows={e.items.animator_obligations} columns={[{ key: "ref", header: "Work" }, { key: "description", header: "Description" }, { key: "outstanding", header: "Owed", num: true, render: (r) => <Money value={r.outstanding} currency={c} /> }, { key: "ledger_account", header: "Ledger account" }]} /></div>}
      {(e.items?.approved_bills || []).length > 0 && <div><h3>Approved supplier bills</h3><DataTable caption="Approved bills" rows={e.items.approved_bills} columns={[{ key: "bill_no", header: "Bill" }, { key: "due_date", header: "Due", render: (r) => fmtDate(r.due_date) }, { key: "outstanding", header: "Owed", num: true, render: (r) => <Money value={r.outstanding} currency={c} /> }, { key: "ledger_account", header: "Ledger account" }]} /></div>}
      {(e.items?.scheduled_owner_payments || []).length > 0 && <div><h3>Owner payments coming up (next {e.commitment_horizon_days} days)</h3><DataTable caption="Scheduled owner payments" rows={e.items.scheduled_owner_payments} columns={[{ key: "kind", header: "Kind" }, { key: "scheduled_for", header: "On", render: (r) => fmtDate(r.scheduled_for) }, { key: "amount", header: "Amount", num: true, render: (r) => <Money value={r.amount} currency={c} /> }]} /></div>}
      {(e.items?.allocations || []).length > 0 && <div><h3>Money set aside for projects</h3><DataTable caption="Project allocations" rows={e.items.allocations} columns={[{ key: "purpose", header: "Purpose" }, { key: "remaining", header: "Set aside", num: true, render: (r) => <Money value={r.remaining} currency={c} /> }]} /></div>}
      {(e.cash_accounts || []).length > 0 && <div><h3>Accounts counted as cash</h3><DataTable caption="Cash accounts" rows={e.cash_accounts} rowKey={(r, i) => i} columns={[{ key: "code", header: "Code" }, { key: "name", header: "Account" }, { key: "balance", header: "Balance", num: true, render: (r) => <Money value={r.balance} currency={c} /> }]} /></div>}
      {e.how_it_is_worked_out && <p className="sub">{e.how_it_is_worked_out}</p>}
      <p className="sub">Accountant view shows the same accounts, entries and commitments in full.</p></div>); }}</Async></Dialog>);
}
