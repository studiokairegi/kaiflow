// Invoice activity: financial events and email events in one list, visibly different (tag + wording).
import React from "react";
import { Async, EmptyState, useFinance, useResource } from "../shared/kit.jsx";
import { EmailStatusPill, Money } from "../shared/parts.jsx";
import { EMAIL_TYPE, REFUND_STATUS, fmtDateTime, label } from "../shared/format.js";

const ACTIONS = { create_invoice_draft: "Draft created", approve_invoice: "Invoice approved", issue_invoice: "Invoice issued to the ledger", void_invoice: "Invoice cancelled", credit_invoice: "Credit note applied" };
function describe(it) {
  switch (it.kind) {
    case "email": { const m = it.email; return { tag: "email", text: <>{label(EMAIL_TYPE, m.email_type)} email to {m.recipient} <EmailStatusPill status={m.status} />{m.failure_detail ? <span className="sub"> ({m.failure_detail})</span> : null}{m.subject ? <div className="sub">Subject: {m.subject}</div> : null}</> }; }
    case "payment": { const p = it.payment; return { tag: "money", text: <>Payment of <Money value={p.amount} currency={p.currency} /> {p.verification_status === "verified" ? "confirmed" : p.verification_status === "rejected" ? "rejected" : "received, waiting to be checked"}{p.reference ? <span className="sub"> · ref {p.reference}</span> : null}</> }; }
    case "receipt": return { tag: "doc", text: <>Receipt {it.receipt_no} {it.status === "issued" ? "issued" : it.status}</> };
    case "refund": { const r = it.refund; return { tag: "money", text: <>Refund of <Money value={r.amount} currency={r.currency} /> – {label(REFUND_STATUS, r.status)}</> }; }
    case "payment_attempt": return { tag: "money", text: <>Online payment attempt: {label({}, it.status)}{it.reference ? <span className="sub"> · ref {it.reference}</span> : null}{it.review_reason ? <div className="sub">{it.review_reason}</div> : null}</> };
    case "credit": return { tag: "money", text: <>Credit {it.credit_no} of <Money value={it.amount} /> – {it.reason}</> };
    default: return { tag: "doc", text: ACTIONS[it.action] || label({}, it.action) };
  }
}
const TAGS = { money: "Money", email: "Email", doc: "Invoice" };
export default function Timeline({ invoiceId = undefined, version = undefined }) {
  const { api, org } = useFinance();
  const res = useResource(() => api.invoiceCommunications(org, invoiceId), [api, org, invoiceId, version]);
  return (<Async res={res} empty={Object.assign((d) => !d || d.length === 0, { node: <EmptyState title="No activity yet" /> })}>{(items) => (
    <ol className="timeline" aria-label="Invoice activity">{items.map((it, i) => { const d = describe(it); return (
      <li key={i}><div><span className={`tag ${d.tag}`}>{TAGS[d.tag]}</span><div className="sub">{fmtDateTime(it.at)}</div></div><div>{d.text}</div></li>); })}</ol>)}</Async>);
}
