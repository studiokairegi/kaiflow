# Payments: provider-neutral architecture (design + scaffolding)

No live provider calls exist. Wise, Paystack, PayPal, Payoneer and M-Pesa are placeholders.

## Flow

    Invoice -> Checkout Session -> Provider -> Payment Transaction -> Invoice Payment -> Finance / Ledger
               /pay/{token}        (adapter)   (neutral row)          (finance_settle)

The checkout page and Payments UI only see neutral types. Provider specifics live in one adapter each.

## Data model (migration 20261021090000)

| Table | Purpose |
|---|---|
| `payment_providers` | per-admin config: enabled, primary, status (`coming_soon`/`not_connected`/`connected`/`error`). Non-secret settings only. |
| `payment_checkout_sessions` | the `/pay/{token}` link. Only the SHA-256 of the token is stored. Amount/currency derived from the invoice. |
| `payment_transactions` | one row per attempt, any provider. `unique(provider, provider_reference)`; one ledger payment per transaction. |
| `payment_events` | de-duplicated provider events, `unique(provider, event_key)`. |

Legacy `paystack_*` tables stay (admin-only) as the Paystack sandbox history. Backfill into `payment_transactions` is a later step.

## Provider contract (`supabase/functions/_shared/payments/`)

`PaymentProvider`: `createCheckout`, `getCheckoutStatus`, `handleWebhook`, `verifyPayment`, `refundPayment`, `reconcilePayment`.
`registry.availablePaymentMethods(configs, currency)` is the only place that decides what a client sees. A provider is offered only if implemented in code AND enabled AND connected AND supports the currency. Placeholders throw `ProviderNotImplementedError`, so nothing can half-work.

Wise is modelled as `flow: "embedded"` (Embedded Solutions), not a card form. Its currencies, confirmation mechanism and refund support are `null`/`false` on purpose: fill them in from Wise's documentation for our account, do not guess.

## Admin-only enforcement

* DB: `payments_is_admin()` reads `user_settings.is_admin`. RLS on every payments table requires owner AND admin. Every browser-callable `payments_*` RPC checks admin (legacy ones were renamed `*_impl`, made uncallable, and wrapped).
* Edge: `paystack-payments` checks `is_admin` for every action, including `status`.
* UI: non-admins see a locked "Payments / Coming Soon" tab with the explanatory message; the module, "Pay now", "Payment link", the dashboard Payments card and the payments data load are all hidden or skipped.

## Public checkout

`/pay/{64-hex-token}` (244 random bits). Rendered by `PayCheckoutPage`, backed by one anonymous RPC `payments_public_checkout(token)` returning only invoice number, client name, amount, currency, status, expiry and available methods. Invalid, malformed and unknown tokens are indistinguishable. Page sets `noindex` and `no-referrer`.

## Before this ships

1. Host must rewrite `/pay/*` to `index.html` (SPA).
2. Add rate limiting in front of `payments_public_checkout` (token space is large, but it is anonymous).
3. Wise: implement `WiseProvider` per Wise Embedded Solutions docs; then add a server-side "start checkout / confirm" path that creates `payment_transactions` and applies to the invoice via the same idempotent pattern as `payments_apply_to_invoice`.
4. Run `supabase/tests/run.sh` (needs local Postgres). The new SQL has not been executed.
