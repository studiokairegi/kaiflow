import React, { useState } from "react";
import { Async, Banner, Button, DataTable, EmptyState, useFinance, useResource } from "../shared/kit.jsx";
import { Money, VerificationPill } from "../shared/parts.jsx";
import { PAYMENT_STATUS, PAYMENT_VERIFICATION, fmtDate, label } from "../shared/format.js";

export default function Payments({ go = undefined }) {
  const { api, org } = useFinance(); const [status, setStatus] = useState("");
  const res = useResource(() => api.listPayments(org, status || null, 100), [api, org, status]);
  return (<div className="stack"><div className="head"><h2>Payments</h2>
    <label className="row sub">Show <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: "auto" }}><option value="">All</option>{Object.entries(PAYMENT_VERIFICATION).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label></div>
    <Async res={res}>{(rows) => <DataTable caption="Payments" rows={rows} onRowClick={(r) => go("invoices", r.invoice_id)} columns={[
      { key: "received_at", header: "Received", render: (r) => fmtDate(r.received_at) }, { key: "amount", header: "Amount", num: true, render: (r) => <Money value={r.amount} currency={r.currency} /> },
      { key: "method", header: "How", render: (r) => label({}, r.provider || r.method) }, { key: "reference", header: "Reference" }, { key: "v", header: "Check", render: (r) => <VerificationPill status={r.verification_status} /> },
      { key: "status", header: "State", render: (r) => label(PAYMENT_STATUS, r.status) }]}
      empty={<EmptyState title="No payments" />} />}</Async></div>);
}
