// The secret link token is returned once when the link is created and never stored in readable form, so a lost link is regenerated (which revokes the old one).
import React, { useState } from "react";
import { Async, Banner, Button, Card, EmptyState, useBusy, useFinance, useResource } from "../shared/kit.jsx";
import { friendlyError } from "../shared/errors.js";
import { fmtDateTime, label } from "../shared/format.js";

export default function PaymentLinkPanel({ invoice = undefined, onChanged = undefined }) {
  const { api, org, toast, payUrl } = useFinance();
  const res = useResource(() => api.intentForInvoice(org, invoice.id), [api, org, invoice.id, invoice.amount_paid]);
  const [link, setLink] = useState(null); const [err, setErr] = useState(null); const [busy, wrap] = useBusy(); const [copied, setCopied] = useState(false);
  const create = (regen) => wrap(async () => { setErr(null); try { if (regen) await api.revokeLinks(org, invoice.id); const r = await api.createPaymentLink(org, invoice.id, {}); setLink({ url: payUrl ? payUrl(r.token) : null, expires: r.expires_at }); setCopied(false); res.reload(); } catch (e) { setErr(e); } });
  const copy = async () => { try { await navigator.clipboard.writeText(link.url); setCopied(true); toast?.("Link copied."); } catch { setCopied(false); toast?.("Copy failed. Select the link and copy it by hand.", "bad"); } };
  return (<Card title="Online payment link" sub="Lets the client pay by card or mobile money. Payments are confirmed by the payment provider, not by the client's browser.">
    {err && <Banner tone="critical">{friendlyError(err)}</Banner>}
    {link ? (<div className="stack"><Banner tone="ok" title="Link ready. Copy it now: for safety it is shown only once.">It expires {fmtDateTime(link.expires)}.</Banner>
      {link.url ? <><pre className="copy" data-testid="pay-link">{link.url}</pre><div className="row"><Button onClick={copy}>{copied ? "Copied" : "Copy link"}</Button><Button kind="danger" busy={busy} onClick={() => create(true)}>Make a new link (old one stops working)</Button></div></> : <Banner tone="warning">The link address could not be built here. Use the email button instead.</Banner>}</div>)
      : <div className="row"><Button kind="primary" busy={busy} onClick={() => create(false)}>Create payment link</Button><Button busy={busy} onClick={() => create(true)}>Replace existing link</Button></div>}
    <h3>Online payment attempts</h3>
    <Async res={res} empty={Object.assign((d) => !d || (Array.isArray(d) && d.length === 0), { node: <EmptyState title="No online payment attempts yet" /> })} lines={2}>{(d) => { const rows = Array.isArray(d) ? d : [d];
      return (<ul style={{ margin: 0, paddingLeft: 18 }}>{rows.map((r) => <li key={r.id}>{label({}, r.status)} · ref {r.reference || "—"} · {r.environment === "live" ? "live" : "test mode"}{r.review_reason ? ` · ${r.review_reason}` : ""}</li>)}</ul>); }}</Async></Card>);
}
