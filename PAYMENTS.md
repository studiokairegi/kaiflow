# Payments module (Paystack SANDBOX only)

## Setup
1. Paystack dashboard -> switch to **Test mode** -> copy the test secret key (`sk_test_...`).
2. Supabase function secrets: `PAYSTACK_SECRET_KEY`, `PAYMENTS_MODE=sandbox`, optional `APP_URL` (post-checkout redirect). Without `PAYMENTS_MODE=sandbox` or with an `sk_live_` key everything stays disabled.
3. Apply `supabase/migrations/20261018090000_payments_paystack_sandbox.sql` (after the Finance v2 migrations).
4. `supabase functions deploy paystack-payments` and `supabase functions deploy paystack-webhook --no-verify-jwt`.
5. Paystack (Test mode) -> Settings -> API & Webhooks -> webhook URL `https://<project>.supabase.co/functions/v1/paystack-webhook`.

## Test an invoice payment
Invoice (project > Invoices, or Payments > Incoming) -> **Pay now (sandbox)** -> enter a customer email -> checkout opens -> pay with a Paystack test card -> **Verify payment** (the webhook also does it). The invoice updates only after the server verifies with Paystack.

## Test a freelancer payout (simulated)
Finance > Purchases: approve a bill for a team member. Payments > Freelancer payouts: New payment request -> Approve -> Start simulation -> Complete/Fail. Nothing is posted to Finance and nothing is paid (`SIMULATED - NO MONEY TRANSFERRED`). Record the real payment in Finance, then Reconcile.

## Tests
- `npm test` (node:test: sandbox guard, signatures, verification, summaries, obligations, reconciliation)
- `PGUSER=postgres ./supabase/tests/run.sh` (91 SQL checks on a scratch Postgres 16: RLS, duplicates, fees, refunds, payouts)
- `bun supabase/tests/edge_smoke.bun.ts` (Edge Function handlers: disabled/live-key/bad-signature paths)
