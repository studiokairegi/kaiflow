import React, { useEffect, useState } from "react";
import { Async, Banner, DataTable, EmptyState, Field, Pager, useFinance, useResource } from "../shared/kit.jsx";
import { EmailStatusPill, Money, VerificationPill } from "../shared/parts.jsx";
import { EMAIL_STATUS, EMAIL_TYPE, PAYMENT_STATUS, fmtDateTime, label } from "../shared/format.js";

export function AuditHistory() {
  const { api, org } = useFinance(); const [type, setType] = useState(""); const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [type]);
  const res = useResource(() => api.listAudit(org, { objectType: type || null, limit: 50, offset }), [api, org, type, offset]);
  return (<div className="stack"><Field label="Filter by record type"><select value={type} onChange={(e) => setType(e.target.value)}><option value="">Everything</option>{["receivable", "payable", "payment", "journal_entry", "account", "animator_work", "reserve", "owner_payment", "settings"].map((t) => <option key={t} value={t}>{label({}, t)}</option>)}</select></Field>
    <Async res={res}>{(d) => (<><DataTable caption="Audit history" rows={d.items} columns={[{ key: "at", header: "When", render: (r) => fmtDateTime(r.at) }, { key: "action", header: "Action", render: (r) => label({}, r.action) },
      { key: "object_type", header: "Record", render: (r) => label({}, r.object_type) }, { key: "object_id", header: "Record id" }, { key: "actor", header: "By" }, { key: "reason", header: "Reason" }]} empty={<EmptyState title="No audit entries" />} />
      <Pager total={d.total} limit={d.limit} offset={d.offset} onChange={setOffset} /></>)}</Async></div>);
}

export function PaymentRecords() {
  const { api, org } = useFinance(); const [status, setStatus] = useState("");
  const res = useResource(() => api.listPayments(org, status || null, 200), [api, org, status]);
  return (<div className="stack"><Field label="Verification"><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option><option value="verified">Verified</option><option value="pending_verification">Pending</option><option value="rejected">Rejected</option></select></Field>
    <Async res={res}>{(rows) => <DataTable caption="Payment transaction records" rows={rows} columns={[{ key: "received_at", header: "Received", render: (r) => fmtDateTime(r.received_at) }, { key: "provider", header: "Provider", render: (r) => label({}, r.provider || r.method) },
      { key: "provider_reference", header: "Provider reference", render: (r) => r.provider_reference || r.reference }, { key: "environment", header: "Mode" }, { key: "amount", header: "Amount", num: true, render: (r) => <Money value={r.amount} currency={r.currency} /> },
      { key: "fee_amount", header: "Fee", num: true }, { key: "v", header: "Verification", render: (r) => <VerificationPill status={r.verification_status} /> }, { key: "status", header: "State", render: (r) => label(PAYMENT_STATUS, r.status) },
      { key: "ledger_entry_id", header: "Journal", render: (r) => (r.ledger_entry_id ? "Posted" : "Not posted") }]} empty={<EmptyState title="No payment records" />} />}</Async></div>);
}

export function EmailAudit() {
  const { api, org, can } = useFinance(); const [status, setStatus] = useState("");
  const res = useResource(() => (can("finance.view_integrations") ? api.listEmails(org, status || null, 200) : Promise.resolve(null)), [api, org, status]);
  if (!can("finance.view_integrations")) return <Banner tone="info" title="Email delivery details are for finance admins.">Open an invoice to see the status of its emails.</Banner>;
  return (<div className="stack"><Field label="Status"><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{Object.entries(EMAIL_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
    <Async res={res}>{(rows) => rows && <DataTable caption="Email delivery audit" rows={rows} columns={[{ key: "created_at", header: "Queued", render: (r) => fmtDateTime(r.created_at) }, { key: "email_type", header: "Type", render: (r) => label(EMAIL_TYPE, r.email_type) }, { key: "recipient", header: "To" }, { key: "subject", header: "Subject" },
      { key: "status", header: "Status", render: (r) => <EmailStatusPill status={r.status} /> }, { key: "attempt_count", header: "Attempts", num: true }, { key: "sent_at", header: "Sent", render: (r) => fmtDateTime(r.sent_at) }, { key: "delivered_at", header: "Delivered", render: (r) => fmtDateTime(r.delivered_at) },
      { key: "failure_detail", header: "Problem", render: (r) => r.failure_detail || r.failure_code || "—" }]} empty={<EmptyState title="No emails yet" />} />}</Async></div>);
}
