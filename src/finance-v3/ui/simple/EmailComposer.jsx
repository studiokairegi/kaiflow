// Invoice email: review -> confirm recipient -> edit subject / added message -> confirm payment link -> send.
// Editing here changes only the two text fields that travel with the email. It never changes the invoice, its amounts or its PDF.
import React, { useEffect, useRef, useState } from "react";
import { Async, Banner, Button, Dialog, Field, useBusy, useFinance, useResource } from "../shared/kit.jsx";
import { EmailStatusPill, Money } from "../shared/parts.jsx";
import { EMAIL_EDIT_LIMITS } from "../../contracts/index.js";
import { friendlyError } from "../shared/errors.js";
import { fmtDate } from "../shared/format.js";

export default function EmailComposer({ invoice = undefined, onClose = undefined, onDone = undefined }) {
  const { api, org, downloadDocument, toast } = useFinance();
  const [recipient, setRecipient] = useState(invoice.client?.email || ""); const [subject, setSubject] = useState(null); const [message, setMessage] = useState("");
  const [withLink, setWithLink] = useState(true); const [confirmed, setConfirmed] = useState(false); const [sent, setSent] = useState(null);
  const [busy, wrap] = useBusy(); const [fail, setFail] = useState(null);
  const opts = { include_payment_link: withLink };
  const res = useResource(() => api.previewInvoiceEmail(org, invoice.id, recipient.trim() || null, opts), [api, org, invoice.id, recipient, withLink]);
  const p = res.data; const subj = subject ?? p?.subject ?? "";
  const tooLongS = subj.length > EMAIL_EDIT_LIMITS.subjectMax, tooLongM = message.length > EMAIL_EDIT_LIMITS.messageMax;
  const send = () => wrap(async () => { setFail(null); try {
    const o = { ...opts, ...(subject !== null && subject !== p.default_subject ? { subject: subj } : {}), ...(message.trim() ? { message } : {}) };
    const msg = p.will_issue_invoice ? await api.issueAndSendInvoice(org, invoice.id, { ...o, recipient: recipient.trim() }) : await api.queueInvoiceEmail(org, invoice.id, recipient.trim(), o);
    setSent(msg); toast?.("Email queued. It is sent in the background; check the invoice activity for delivery."); onDone?.(); } catch (e) { setFail(e); } });
  if (sent) return (<Dialog title="Email on its way" onClose={onClose} footer={<Button kind="primary" onClick={onClose}>Done</Button>}>
    <Banner tone="ok" title="The email is queued.">It goes out in the background. You will see Sent and Delivered in the invoice activity as the mail provider reports back.</Banner></Dialog>);
  const ready = p?.valid && confirmed && !tooLongS && !tooLongM && recipient.trim();
  return (<Dialog title={p?.will_issue_invoice ? "Issue and send invoice" : "Send invoice by email"} wide onClose={onClose}
    footer={<><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind="primary" busy={busy} disabled={!ready} onClick={send}>{p?.will_issue_invoice ? "Issue and send" : "Send email"}</Button></>}>
    <Async res={res}>{() => (<div className="stack">
      {p.will_issue_invoice && <Banner tone="info" title="Sending also issues this invoice.">It gets its final number and the money owed is recorded. After that its amounts can no longer be edited.</Banner>}
      {p.already_queued && <Banner tone="warning" title="This invoice was already emailed.">{`An email for this version was queued on ${fmtDate(p.already_queued.created_at)} (`}<EmailStatusPill status={p.already_queued.status} />{"). Sending again will not create a duplicate; use Resend from the activity list if the client did not get it."}</Banner>}
      {(p.problems || []).map((x, i) => <Banner key={i} tone="critical">{typeof x === "string" ? x : x.message}</Banner>)}
      <Field label="Send to" hint="Check the address. This is the only place the email goes."><input type="email" value={recipient} onChange={(e) => { setRecipient(e.target.value); setConfirmed(false); }} autoComplete="off" /></Field>
      <Field label="Subject" error={tooLongS ? `At most ${EMAIL_EDIT_LIMITS.subjectMax} characters.` : null}><input value={subj} onChange={(e) => setSubject(e.target.value.replace(/[\r\n]/g, " "))} /></Field>
      <Field label="Add a personal message (optional)" hint={`Shown above the invoice summary. ${message.length}/${EMAIL_EDIT_LIMITS.messageMax}`} error={tooLongM ? "That is too long." : null}><textarea value={message} onChange={(e) => setMessage(e.target.value)} /></Field>
      <div className="card"><h3>What the client receives</h3>
        <p>Invoice {p.invoice.invoice_no || "(number is assigned when issued)"} for <Money value={p.invoice.total} currency={p.invoice.currency} />, due {fmtDate(p.invoice.due_date)}. The amounts come from the invoice and cannot be changed here.</p>
        <p>Attachment: {(p.attachments || []).map((a) => a.filename).join(", ")} {!p.will_issue_invoice && <Button small onClick={() => downloadDocument("invoice", invoice.id).catch((e) => setFail(e))}>Preview the PDF</Button>}</p>
        <label className="row"><input type="checkbox" checked={withLink} onChange={(e) => { setWithLink(e.target.checked); setConfirmed(false); }} disabled={p.payment_link.included === false && p.payment_link.reason?.startsWith("Online payment is not")} /> Include a “Pay online” link</label>
        <p className="sub">{p.payment_link.included ? `A secure payment link is added, valid for ${p.payment_link.expires_in_days} days.` : p.payment_link.reason}</p></div>
      <label className="row"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> I have checked the recipient, subject and payment link.</label>
      {fail && <Banner tone="critical" title="It could not be sent.">{friendlyError(fail)}</Banner>}</div>)}</Async></Dialog>);
}
