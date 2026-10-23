# Kairil payments — Paystack (test + live)

Paystack is the default and only active provider. PayPal and Payoneer stay in the UI, greyed out as
"Coming soon — not configured", and cannot be selected or started. Wise and M-Pesa are placeholders.

## How a payment flows

1. **Invoice PDF** (`downloadInvoicePDF`, `src/App.jsx`): for invoices/proformas with a balance, the PDF calls
   `payments_create_checkout_session` and draws a **Pay Now** button (a PDF link annotation) plus the full URL as text
   under it. If a link can't be created (not an admin, nothing outstanding) the PDF is produced exactly as before.
2. **Hosted checkout** `/pay/{64-hex-token}` (`PayCheckoutPage.jsx`): shows invoice number, verified amount and
   currency from the database, and the methods offered. Only the token's SHA-256 is stored.
3. **Start** (`paystack-checkout`, public): `payments_checkout_prepare` locks the session and invoice, takes amount and
   currency from the database, and either creates one attempt, reuses the open one, or asks us to verify it first.
   The server then calls Paystack `transaction/initialize` and redirects to Paystack-hosted checkout.
4. **Return** `/pay/{token}/return`: the page asks the server to `confirm`. The server calls Paystack `transaction/verify`
   and checks reference, amount, currency and domain (test/live) against **our stored row**. Success is shown only after
   that, and only once the database reports the payment applied.
5. **Webhook** (`paystack-webhook`): HMAC-SHA512 signature check; the environment is whichever configured key reproduces
   the signature; every event is de-duplicated, re-verified with Paystack, then applied. A closed browser never loses a payment.
6. **Apply** (`payments_apply_to_invoice`): one ledger payment per attempt (unique index), invoice status synced, the actual
   Paystack fee booked once as an expense (kept separate from the invoice amount), the checkout link closed.

## Duplicate-charge protection

- One open attempt per invoice and environment: partial unique index `paystack_tx_one_open_per_invoice_uidx`.
- `payments_checkout_prepare` holds row locks on the session and the invoice, so simultaneous requests serialise.
- Refresh / second click on the same channel reuses the same Paystack checkout URL.
- An attempt whose outcome is unknown is **verified with Paystack before any new one starts**; a timeout is never treated as failure.
- A young unpaid attempt (< 30 min) is never retired, because the customer may still be paying it in another tab.
- Unique provider references; unique ledger payment per attempt; webhook events unique per environment + event.
- A settled payment is never downgraded by a late failed/pending answer.
- Honest limit: Paystack gives no exactly-once guarantee. If a customer pays an attempt we had already retired (>30 min idle)
  *and* a replacement, the second payment is recorded as `needs_review` in Reconciliation rather than hidden or double counted.

## Server configuration (Supabase secrets — never in git or frontend)

| Secret | Value |
|---|---|
| `PAYSTACK_MODE` | `test` or `live` — the ACTIVE environment. Anything else disables payments. |
| `PAYSTACK_TEST_SECRET_KEY` | `sk_test_…` |
| `PAYSTACK_LIVE_SECRET_KEY` | `sk_live_…` (set **after rotating**, see below) |
| `APP_URL` | `https://<your Kairil domain>` — required for live; used for the return page |

The key prefix must match its environment or payments stay disabled. Both keys may be set at once: the webhook accepts
events for both (decided by signature), while checkout uses the key for `PAYSTACK_MODE`.

```
supabase secrets set PAYSTACK_MODE=test PAYSTACK_TEST_SECRET_KEY=sk_test_... APP_URL=https://your-app
supabase db push                                   # applies 20261021090000 and 20261025090000 (+ earlier pending ones)
supabase functions deploy paystack-payments        # JWT required
supabase functions deploy paystack-checkout --no-verify-jwt
supabase functions deploy paystack-webhook --no-verify-jwt
```

Host rewrite: `/pay/*` must serve `index.html` (already required for `/pay/{token}`); `/pay/{token}/return` uses the same rewrite.

## Webhook

URL (same for both environments): `https://hlplzosdgciavucaebfd.supabase.co/functions/v1/paystack-webhook`

Paystack dashboard → Settings → API Keys & Webhooks: set it as the **Test webhook URL** and the **Live webhook URL**.
Leave Paystack's own "callback URL" empty (or the app URL): Kairil sends a per-transaction callback to `/pay/{token}/return`.
The static `studiokairegi.com/payment-thank-you.html` cannot verify a payment and is not used as the callback.

## Connecting and going live

1. Kairil → Payments → Providers → Paystack → **Connect** (checks the active key against Paystack, makes Paystack the default).
2. Under *Enabled on your Paystack account*, tick only the channels and currencies your Paystack dashboard actually has on
   (bank transfer and USD are not on every Kenyan account). Clients are offered exactly those.
3. Payment links are bound to the environment they were created in: test links stop working in live and vice versa.

## Small live payment procedure (not yet performed)

1. Rotate the live secret key (the old one was pasted into a chat). Set `PAYSTACK_LIVE_SECRET_KEY`, `APP_URL`, `PAYSTACK_MODE=live`; redeploy; Connect.
2. Create a real invoice for a small amount (e.g. KES 100) for a client you control. Download its PDF; confirm Pay Now opens the page with the right invoice and amount.
3. Pay by card. Confirm: return page says paid; invoice is Paid; one Finance payment labelled "Paystack"; one fee expense; Payments → Live shows it matched.
4. Check Paystack dashboard → Developer → Webhooks shows 200 for `charge.success`. Re-send it; confirm nothing is recorded twice.
5. Refund it from the Paystack dashboard; confirm Kairil voids the payment and re-opens the invoice.

## Limitations

- Which channels/currencies the merchant account supports is configuration you set in Providers; Kairil does not detect it.
- USD checkout works only if Paystack has enabled USD for the account; no FX conversion is done by Kairil. Settlement currency, FX and
  payout timing are Paystack's; only the actual fee Paystack reports is recorded.
- The admin "Pay now" shortcut is test-mode only; live payments go through the invoice payment link.
- Each PDF download creates a new payment link (the earlier ones stay valid until they expire or are used). The duplicate-charge guard works across links.
- Public endpoints have no rate limiting beyond Supabase's defaults.
