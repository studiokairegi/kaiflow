# Paystack checkout FX refresh

This update makes Paystack checkout refresh its currency snapshot from `open.er-api.com` on the server whenever a client requests a payment quote.

## Behaviour

- The browser cannot submit an exchange rate, converted amount, or charge currency.
- The Edge Function fetches the provider's USD-base rates and accepts only a successful payload with a provider update timestamp no more than 36 hours old and no more than five minutes in the future.
- The function stores EUR, GBP, JPY, and KES snapshots against the owner of the unexpired checkout session. It never trusts a user ID from the browser.
- The quote database function prefers these checkout-specific snapshots and falls back to existing Finance FX snapshots only if those are still within the same 36-hour freshness limit.
- If the provider is unavailable, a valid fresh snapshot can still be used. If no reliable rate exists, checkout fails closed and asks the client to try later.
- The original invoice amount/currency remains unchanged. The quote contains the converted KES charge, and Paystack receives only the server-approved KES amount.
- JPY rounding remains zero-decimal; KES uses two decimals.

## Deployment

1. Review and apply the new migration `supabase/migrations/20261027090000_payment_checkout_live_fx.sql` using your normal database migration workflow. Do not apply it from an unreviewed environment.
2. Deploy the updated Edge Function: `supabase functions deploy paystack-checkout --no-verify-jwt`.
3. Verify the function has `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and the existing live Paystack environment secrets configured.
4. Test EUR, JPY, and USD invoices with a small test invoice/link in the appropriate environment. Confirm the checkout shows the original invoice amount and the converted KES amount, then verify the stored quote provenance and the Paystack transaction amount/currency.
5. If `open.er-api.com` is unavailable, confirm a recent snapshot can still be used; then test that stale snapshots are refused.

The migration and Edge Function must both be deployed for automatic refresh to work. This code change does not itself apply a migration or deploy the function.
