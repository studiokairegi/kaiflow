import React, { useState } from "react";
import { Async, Banner, Button, Card, DataTable, EmptyState, useBusy, useFinance, useResource } from "../shared/kit.jsx";
import { EmailStatusPill, Money } from "../shared/parts.jsx";
import { REFUND_STATUS, fmtDate, label } from "../shared/format.js";
import { friendlyError } from "../shared/errors.js";

export default function Receipts({ invoice = undefined, onChanged = undefined }) {
  const { api, org, can, toast, downloadDocument } = useFinance();
  const res = useResource(() => api.listReceipts(org, invoice.id), [api, org, invoice.id, invoice.amount_paid]);
  const refunds = useResource(() => api.listRefunds(org), [api, org, invoice.id]);
  const [err, setErr] = useState(null); const [busy, wrap] = useBusy();
  const mine = (refunds.data || []).filter((r) => r.invoice_id === invoice.id);
  const send = (r) => wrap(async () => { setErr(null); try { await api.queueReceiptEmail(org, r.id); toast?.("Receipt email queued."); res.reload(); } catch (e) { setErr(e); } });
  return (<Card title="Receipts and refunds">
    {err && <Banner tone="critical">{friendlyError(err)}</Banner>}
    <Async res={res} lines={2}>{(d) => <DataTable caption="Receipts" rows={d.items} columns={[{ key: "receipt_no", header: "Receipt" }, { key: "issued_at", header: "Issued", render: (r) => fmtDate(r.issued_at) },
      { key: "amount", header: "Amount", num: true, render: (r) => <Money value={r.amount} currency={r.currency} /> }, { key: "email", header: "Email", render: (r) => r.email_status ? <EmailStatusPill status={r.email_status} /> : "Not sent" },
      { key: "act", header: "", render: (r) => <span className="row"><Button small onClick={() => downloadDocument("receipt", r.id).catch(setErr)}>Download PDF</Button>{can("finance.send_email") && <Button small busy={busy} onClick={() => send(r)}>{r.email_status ? "Resend" : "Email receipt"}</Button>}</span> }]}
      empty={<EmptyState title="No receipts yet">A receipt is made when a payment is confirmed.</EmptyState>} />}</Async>
    {mine.length > 0 && <><h3>Refunds</h3><DataTable caption="Refunds" rows={mine} columns={[{ key: "refund_no", header: "Refund" }, { key: "amount", header: "Amount", num: true, render: (r) => <Money value={r.amount} currency={r.currency} /> },
      { key: "status", header: "Status", render: (r) => label(REFUND_STATUS, r.status) }, { key: "reason", header: "Reason" }]} /></>}</Card>);
}
