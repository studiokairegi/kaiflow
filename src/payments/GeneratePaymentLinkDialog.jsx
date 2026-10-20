import React, { useState } from "react";
import { S, T, Btn, Banner, Field, Modal, useBusy } from "../finance/ui.jsx";
import { formatMoney, symbolToCode } from "../finance/currency.js";
import { outstandingOf, payableInvoices } from "./logic.js";
import { checkoutUrl } from "./providers.js";
import { createCheckoutSession } from "./api.js";

// Admin: Invoice -> Generate payment link. Amount and currency are decided by the database from
// the invoice; the optional partial amount is only validated down. The link is shown ONCE (only
// its hash is stored), so copy it before closing.
export default function GeneratePaymentLinkDialog({ invoice, onClose, onChanged }) {
  const code = symbolToCode(invoice.currency);
  const outstanding = outstandingOf(invoice);
  const [amount, setAmount] = useState(String(outstanding));
  const [days, setDays] = useState("14");
  const [link, setLink] = useState(null);
  const [copied, setCopied] = useState(false);
  const { busy, error, run } = useBusy();
  const amt = Number(amount);
  const amountOk = Number.isFinite(amt) && amt > 0 && amt <= outstanding + 0.005;
  const daysOk = Number.isInteger(Number(days)) && Number(days) >= 1 && Number(days) <= 90;
  const blocked = !payableInvoices([invoice]).length ? "Nothing is outstanding on this document." : "";

  const create = () => run(async () => {
    const r = await createCheckoutSession(invoice.id, amt === outstanding ? null : amt, Number(days));
    setLink({ url: checkoutUrl(r.token, window.location.origin), amount: r.amount, currency: r.currency, expires: r.expires_at });
    onChanged?.();
  });
  const copy = async () => { try { await navigator.clipboard.writeText(link.url); setCopied(true); } catch { setCopied(false); } };

  return (
    <Modal title={`Payment link for ${invoice.invoiceNumber}`} onClose={onClose} width={540} footer={<Btn onClick={onClose}>Close</Btn>}>
      {error && <Banner tone="bad">{error}</Banner>}
      {blocked ? <Banner tone="bad">{blocked}</Banner> : !link ? (
        <>
          <p style={S.sub}>Outstanding: <strong>{formatMoney(code, outstanding)}</strong>. The client opens a StudioKairegi checkout page and picks an available payment method.</p>
          <Field label={`Amount (${code})`} hint={amountOk ? "" : `Enter an amount up to ${formatMoney(code, outstanding)}.`}><input style={S.input} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label="Link valid for (days)" hint={daysOk ? "" : "Between 1 and 90."}><input style={S.input} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} /></Field>
          <div><Btn kind="primary" disabled={busy || !amountOk || !daysOk} onClick={create}>{busy ? "Creating…" : "Generate payment link"}</Btn></div>
        </>
      ) : (
        <>
          <Banner tone="warn">Copy this link now. For security it is shown only once and can’t be retrieved later.</Banner>
          <input readOnly style={S.input} value={link.url} onFocus={(e) => e.target.select()} aria-label="Payment link" />
          <div style={S.row}><Btn kind="primary" onClick={copy}>{copied ? "Copied" : "Copy link"}</Btn><span style={{ color: T.muted, fontSize: 13 }}>{formatMoney(link.currency, link.amount)} · expires {new Date(link.expires).toLocaleDateString()}</span></div>
          <p style={S.sub}>Until a payment provider is connected, the page will tell the client online payment isn’t available yet.</p>
        </>
      )}
    </Modal>
  );
}
