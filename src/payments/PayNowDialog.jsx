import React, { useState } from "react";
import { S, T, Btn, Banner, Field, Modal, useBusy } from "../finance/ui.jsx";
import { formatMoney, symbolToCode } from "../finance/currency.js";
import { SANDBOX_NOTICE, checkoutBlocker, isValidEmail, outstandingOf } from "./logic.js";
import { startCheckout, verifyPayment } from "./api.js";

// Starts a SANDBOX Paystack checkout for an invoice. Amount, currency and reference are decided
// on the server; this dialog only offers an optional partial amount that the server validates.
export default function PayNowDialog({ invoice, defaultEmail = "", onClose, onChanged }) {
  const code = symbolToCode(invoice.currency);
  const outstanding = outstandingOf(invoice);
  const [email, setEmail] = useState(defaultEmail);
  const [amount, setAmount] = useState(String(outstanding));
  const [session, setSession] = useState(null); // { reference, authorization_url, amount, currency }
  const [result, setResult] = useState(null);
  const { busy, error, run } = useBusy();
  const blocker = checkoutBlocker(invoice);
  const amt = Number(amount);
  const amountOk = Number.isFinite(amt) && amt > 0 && amt <= outstanding + 0.005;

  const open = () => run(async () => {
    const s = await startCheckout(invoice.id, email.trim(), amt === outstanding ? null : amt);
    setSession(s);
    window.open(s.authorization_url, "_blank", "noopener,noreferrer");
    onChanged?.();
  });
  const verify = () => run(async () => {
    const r = await verifyPayment(session.reference);
    setResult(r);
    onChanged?.();
  });

  return (
    <Modal title={`Pay ${invoice.invoiceNumber} (sandbox)`} onClose={onClose} width={520}
      footer={<Btn onClick={onClose}>Close</Btn>}>
      <Banner tone="warn"><strong>{SANDBOX_NOTICE}.</strong> This opens Paystack's test checkout. Use Paystack's test cards only; no real card is charged and no real money moves.</Banner>
      {error && <Banner tone="bad">{error}</Banner>}
      {blocker ? <Banner tone="bad">{blocker}</Banner> : !session ? (
        <>
          <p style={S.sub}>Outstanding balance: <strong>{formatMoney(code, outstanding)}</strong>. You can collect part of it now; the rest stays outstanding.</p>
          <Field label="Customer email" hint="Paystack needs an email for the checkout."><input style={S.input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="client@example.com" autoComplete="off" /></Field>
          <Field label={`Amount (${code})`} hint={amountOk ? "" : `Enter an amount up to ${formatMoney(code, outstanding)}.`}><input style={S.input} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <div><Btn kind="primary" disabled={busy || !isValidEmail(email.trim()) || !amountOk} onClick={open}>{busy ? "Starting…" : "Open sandbox checkout"}</Btn></div>
        </>
      ) : (
        <>
          <p style={S.sub}>Checkout for <strong>{formatMoney(session.currency, session.amount)}</strong> opened in a new tab{session.reused ? " (resumed an existing one)" : ""}. Reference <code>{session.reference}</code>.</p>
          <p style={S.sub}>After paying with a test card, come back and verify. The invoice only updates once Paystack confirms the payment to our server; returning from the checkout page is not proof of payment.</p>
          <div style={S.row}>
            <Btn kind="primary" disabled={busy} onClick={verify}>{busy ? "Verifying…" : "Verify payment"}</Btn>
            <a href={session.authorization_url} target="_blank" rel="noopener noreferrer" style={{ color: T.accentText, fontSize: 13 }}>Reopen checkout</a>
          </div>
          {result && (
            <Banner tone={result.applied ? "ok" : result.status === "failed" ? "bad" : "info"}>
              {result.applied ? "Payment verified and recorded against the invoice (test data)."
                : result.status === "failed" ? "Paystack reports this payment failed."
                : result.apply_status === "failed" ? `Paystack confirmed the payment but it could not be applied: ${result.apply_error}. See Payments > Reconciliation.`
                : result.note || "Not paid yet. Finish the test checkout, then verify again."}
            </Banner>
          )}
        </>
      )}
    </Modal>
  );
}
