import React, { useState } from "react";
import { Async, Button, Card, DataTable, EmptyState, Pager, Skeleton, useFinance, useResource } from "../shared/kit.jsx";
import { InvoiceStatusPill, Money } from "../shared/parts.jsx";
import { INVOICE_STATUS, fmtDate } from "../shared/format.js";
import InvoiceEditor from "./InvoiceEditor.jsx";
import InvoiceDetail from "./InvoiceDetail.jsx";

export default function Invoices({ openId = undefined }) {
  const { api, org, can } = useFinance();
  const [sel, setSel] = useState(openId || null); const [status, setStatus] = useState(""); const [overdue, setOverdue] = useState(false);
  const [stack, setStack] = useState([null]); const [creating, setCreating] = useState(false);
  const cursor = stack[stack.length - 1];
  const res = useResource(() => api.listInvoices(org, { status: status || null, overdueOnly: overdue, limit: 25, cursor }), [api, org, status, overdue, cursor && JSON.stringify(cursor)]);
  if (sel) return <InvoiceDetail id={sel} onBack={() => { setSel(null); res.reload(); }} />;
  const reset = () => setStack([null]);
  return (<div className="stack">
    <div className="head"><h2>Invoices</h2>{can("finance.post") && <Button kind="primary" onClick={() => setCreating(true)}>Create an invoice</Button>}</div>
    <div className="row"><label className="row sub">Show <select value={status} onChange={(e) => { setStatus(e.target.value); reset(); }} style={{ width: "auto" }}><option value="">All</option>{Object.entries(INVOICE_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
      <label className="row sub"><input type="checkbox" checked={overdue} onChange={(e) => { setOverdue(e.target.checked); reset(); }} /> Overdue only</label></div>
    <Async res={res}>{(d) => (<><DataTable caption="Invoices" rows={d.items} onRowClick={(r) => setSel(r.id)} columns={[
      { key: "invoice_no", header: "Invoice", render: (r) => r.invoice_no || "Draft" }, { key: "client", header: "Client", render: (r) => r.client?.name },
      { key: "issue_date", header: "Date", render: (r) => fmtDate(r.issue_date) }, { key: "due_date", header: "Due", render: (r) => fmtDate(r.due_date) },
      { key: "total", header: "Total", num: true, render: (r) => <Money value={r.total} currency={r.currency} /> }, { key: "outstanding", header: "Owing", num: true, render: (r) => <Money value={r.outstanding} currency={r.currency} /> },
      { key: "status", header: "Status", render: (r) => <InvoiceStatusPill invoice={r} /> }]}
      empty={<EmptyState title={status || overdue ? "No invoices match" : "No invoices yet"}>{status || overdue ? "Try a different filter." : "Create one to start getting paid."}</EmptyState>} />
      <div className="row" style={{ justifyContent: "space-between" }}><Button small disabled={stack.length < 2} onClick={() => setStack((s) => s.slice(0, -1))}>Newer</Button><Button small disabled={!d.next_cursor} onClick={() => setStack((s) => [...s, d.next_cursor])}>Older</Button></div></>)}</Async>
    {creating && <InvoiceEditor onClose={() => setCreating(false)} onSaved={(inv) => { setCreating(false); setSel(inv.id); }} />}</div>);
}
