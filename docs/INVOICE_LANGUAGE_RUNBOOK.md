# Runbook: invoice client language (EN/JA), migration `20270111090000`

## Deploy order (forward)
1. **Back up** the database (or confirm a recent point-in-time backup).
2. **Staging first:** apply `supabase/migrations/20270111090000_*` to staging, then run the SQL suites, including
   `payments_language.test.sql`.
3. **Production: apply the migration BEFORE the frontend.** The migration is backward compatible with the old
   frontend (the 3-argument `payments_create_checkout_session` call still resolves to the new function).
4. **Verify:** `invoices.language` exists with its CHECK constraint; `create_milestone_invoices` and
   `payments_create_checkout_session` exist with the new signatures.
5. **Deploy the frontend** (and the `paystack-checkout` / `paystack-webhook` edge functions if changed).
6. **Smoke test:** open and save an existing invoice; mark one paid; create an English and a Japanese invoice;
   download both PDFs and confirm the Pay Now button; open each payment link in the browser.

Frontend-before-migration is now safe for editing existing invoices (the app sends `language` only once it has seen
the column). Creating a **Japanese** invoice before the migration still fails, deliberately.

## Rollback
The rollback (`supabase/rollback/20270111090000_invoice_client_language.rollback.sql`) **drops the language
columns and permanently deletes the Japanese text** (invoice language, `*_ja` settings). Export them first if needed.
1. Roll the **frontend back first**.
2. Then run the rollback SQL.
3. Re-verify: save an existing invoice and create a payment link.

## Known PDF behaviour
A payable PDF downloaded without a Pay Now button now shows a one-line notice and logs the reason in the browser
console (`Pay Now link not added to PDF`).

## Migration `20270112090000_remove_bank_transfer_channel`
Independent of the language migration (apply after it). It strips `bank_transfer` from stored Paystack provider
settings (an account left with no channel falls back to `card`) and stops admins re-enabling it. Old transactions are
untouched. Rollback: `supabase/rollback/20270112090000_remove_bank_transfer_channel.rollback.sql` (re-allows the
channel in the settings RPC; it does not restore it on accounts that had it).
Deploy the edge functions (`paystack-checkout`, `paystack-webhook`) together with it.
