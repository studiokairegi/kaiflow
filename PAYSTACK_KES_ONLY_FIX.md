# Paystack KES-only checkout fix

The failed transaction response `Currency not supported by merchant` means Paystack was initialized with an unsupported currency. The previous SQL selected the invoice currency whenever `payment_providers.settings.currencies` listed it, even though this merchant's Paystack account collects only KES.

The migration `supabase/migrations/20261028090000_force_kes_paystack_checkout.sql` updates the server-side quote and checkout preparation RPCs so:

- KES invoices are charged in KES without FX conversion.
- USD, EUR, GBP, and JPY invoices are quoted and charged in KES using the existing FX quote logic.
- Original invoice currency and amount remain stored separately for settlement/accounting.
- Checkout refuses to proceed if KES is not enabled in Paywise's Paystack provider settings.
- Only `service_role` can call the modified RPCs.

## Deploy

1. Back up the project/database.
2. Apply this migration through your normal Supabase migration workflow.
3. Confirm the Paystack provider settings include `KES` under currencies.
4. Open a fresh payment link or refresh the quote, then test a small KES invoice and a small foreign-currency invoice.
5. Verify the Paystack initialization request is KES and confirm successful payments settle against the original invoice amount/currency.

This ZIP does not apply the migration to Supabase and does not change secrets. Do not retry the old failed quote; create a fresh quote after deployment.
