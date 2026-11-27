import React, { useState } from "react";
import { Async, Banner, Button, Card, DataTable, EmptyState, useBusy, useFinance, useResource } from "../shared/kit.jsx";
import { ActionDialog, EmailStatusPill, InvoiceStatusPill, Money, VerificationPill } from "../shared/parts.jsx";
import { PAYMENT_STATUS, REFUND_STATUS, fmtDate, fmtDateTime, label } from "../shared/format.js";
import { friendlyError } from "../shared/errors.js";
import InvoiceEditor from "./InvoiceEditor.jsx";
import QuickActionDialog from "./QuickActions.jsx";
import EmailComposer from "./EmailComposer.jsx";
import PaymentLinkPanel from "./PaymentLinkPanel.jsx";
import Timeline from "./Timeline.jsx";
import Receipts from "./Receipts.jsx";

export default function InvoiceDetail({ id = undefined, onBack = undefined }) {
  const { api, org, can, toast, downloadDocument } = useFinance();
  const res = useResource(() => api.getInvoice(org, id), [api, org, id]);
  const [dlg, setDlg] = useState(null); const [busy, wrap] = useBusy(); const [err, setErr] = useState(null);
  const refresh = () => res.reload();
  const run = (fn, msg) => wrap(async () => { setErr(null); try { await fn(); toast?.(msg); refresh(); } catch (e) { setErr(e); } });
  return (<div className="stack">
    <div><Button small kind="ghost" onClick={onBack}>&larr; All invoices</Button></div>
    <Async res={res} lines={6}>{(inv) => { const st = inv.status; const live = ["issued", "partially_paid"].includes(st); return (<>
      <div className="head"><div><h2>{inv.invoice_no || "Draft invoice"} <InvoiceStatusPill invoice={inv} /></h2><p className="sub">{inv.client?.name}{inv.client?.email ? ` · ${inv.client.email}` : ""}</p></div>
        <div className="row">
          {st === "draft" && can("finance.post") && <Button onClick={() => setDlg("edit")}>Edit draft</Button>}
          {st === "draft" && can("finance.approve") && <Button kind="primary" busy={busy} onClick={() => run(() => api.approveInvoice(org, id), "Invoice approved.")}>Approve</Button>}
          {["approved", "issued", "partially_paid"].includes(st) && can("finance.send_email") && <Button kind="primary" onClick={() => setDlg("email")}>{st === "approved" ? "Issue and send" : "Send or resend"}</Button>}
          {st === "approved" && can("finance.approve") && <Button busy={busy} onClick={() => run(() => api.issueInvoice(org, id), "Invoice issued.")}>Issue without sending</Button>}
          {live && can("finance.post") && <Button onClick={() => setDlg("payment")}>Record a payment</Button>}
          {st !== "draft" && st !== "void" && <Button onClick={() => downloadDocument("invoice", id).catch((e) => setErr(e))}>Download PDF</Button>}
          {["draft", "approved", "issued"].includes(st) && can("finance.approve") && <Button kind="danger" onClick={() => setDlg("void")}>Cancel invoice</Button>}</div></div>
      {err && <Banner tone="critical" title="That did not work.">{friendlyError(err)}</Banner>}
      {live && inv.is_overdue && <Banner tone="warning" title={`This invoice is ${inv.days_overdue} day${inv.days_overdue === 1 ? "" : "s"} overdue.`}>Send a reminder or follow up with the client.</Banner>}
      <div className="grid">
        <div className="stat"><span className="l">Total</span><span className="v"><Money value={inv.total} currency={inv.currency} /></span></div>
        <div className="stat"><span className="l">Paid</span><span className="v"><Money value={inv.amount_paid} currency={inv.currency} /></span></div>
        <div className="stat"><span className="l">Still owing</span><span className="v"><Money value={inv.outstanding} currency={inv.currency} /></span><span className="sub">Due {fmtDate(inv.due_date)}</span></div></div>
      <Card title="What was charged"><DataTable caption="Invoice lines" rows={inv.lines} rowKey={(r) => r.line_no} columns={[{ key: "description", header: "Description" }, { key: "quantity", header: "Qty", num: true },
        { key: "unit_price", header: "Price", num: true }, { key: "tax_rate", header: "Tax %", num: true }, { key: "line_total", header: "Total", num: true, render: (r) => <Money value={r.line_total} currency={inv.currency} /> }]}
        totals={["", "", "", "Total", <Money key="t" value={inv.total} currency={inv.currency} />]} /></Card>
      <div className="grid2">
        {live && can("finance.collect") && <PaymentLinkPanel invoice={inv} onChanged={refresh} />}
        <Card title="Payments"><DataTable caption="Payments" rows={inv.payments} columns={[{ key: "received_at", header: "Received", render: (r) => fmtDate(r.received_at) }, { key: "amount", header: "Amount", num: true, render: (r) => <Money value={r.amount} currency={inv.currency} /> },
          { key: "method", header: "How", render: (r) => label({}, r.method) }, { key: "reference", header: "Reference" }, { key: "v", header: "Check", render: (r) => <VerificationPill status={r.verification_status} /> },
          { key: "status", header: "State", render: (r) => label(PAYMENT_STATUS, r.status) },
          { key: "act", header: "", render: (r) => r.verification_status === "pending_verification" && can("finance.verify_payment") ? <span className="row"><Button small onClick={() => run(() => api.verifyManualPayment(org, r.id), "Payment confirmed.")}>Confirm</Button><Button small kind="danger" onClick={() => setDlg({ reject: r.id })}>Reject</Button></span> : null }]}
          empty={<EmptyState title="No payments yet" />} /></Card></div>
      <Receipts invoice={inv} onChanged={refresh} />
      <Card title="Activity" sub="Money events and emails, newest first."><Timeline invoiceId={id} version={inv.payments?.length + ":" + st} /></Card>
      {dlg === "edit" && <InvoiceEditor invoice={inv} onClose={() => setDlg(null)} onSaved={() => { setDlg(null); refresh(); }} />}
      {dlg === "email" && <EmailComposer invoice={inv} onClose={() => setDlg(null)} onDone={refresh} />}
      {dlg === "payment" && <QuickActionDialog action="record_payment" invoice={inv} onClose={() => setDlg(null)} onDone={refresh} />}
      {dlg === "void" && <ActionDialog title="Cancel this invoice" confirmText="Cancel invoice" intro="A cancelled invoice can no longer be paid. If it was already issued, the accounting entry is reversed, not deleted." fields={[{ name: "reason", label: "Why is it cancelled", type: "textarea", required: true }]} onClose={() => setDlg(null)} onDone={refresh} onSubmit={(v) => api.voidInvoice(org, id, v.reason)} />}
      {dlg?.reject && <ActionDialog title="Reject this payment" confirmText="Reject payment" fields={[{ name: "reason", label: "Why", type: "textarea", required: true }]} onClose={() => setDlg(null)} onDone={refresh} onSubmit={(v) => api.rejectManualPayment(org, dlg.reject, v.reason)} />}</>); }}</Async></div>);
}
