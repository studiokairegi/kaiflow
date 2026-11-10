# Phase 4F — End-to-End Sending Validation Handoff (Corrected)

**Source status:** Confirmed source-level bugs corrected. **Production approval:** Pending PostgreSQL, build and controlled deployment verification.

## Results

- Full repository `npm test`: **943 passed, 0 failed, 0 skipped**.
- Email-focused suite: **158 passed, 0 failed, 0 skipped**.
- Controlled end-to-end recovery test: provider acceptance survives simulated post-acceptance DB failure; a tagged signed-webhook event binds the provider ID, advances message status and records exactly one CRM activity without another provider call.
- Transactional Resend/Intelligence source-hash isolation remains passing.

## Corrective changes

The new migration `20261213100000_email_accepted_send_reconciliation.sql` adds service-role-only RPCs for monotonic provider acceptance persistence and signed Resend webhook reconciliation. The Resend adapter sends the server-generated persisted message UUID as custom tag `kf_message_id`. The webhook verifies sender, account, recipients and subject before binding. CRM activity recording is part of the recovery transaction.

The prior Phase 4E counter trigger repair remains included in `20261212100000_email_inbox_phase4f_counter_repair.sql`.

## Required operational configuration

Configure the existing Resend webhook to receive `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced` and `email.complained`. At minimum, `email.sent` is required to recover an accepted send whose synchronous DB write failed.

## Deployment order

1. Apply migrations through `20261213100000_email_accepted_send_reconciliation.sql` in timestamp order, including the Phase 4C–4F migrations.
2. Deploy updated `email-send` and `resend-webhook` Edge Functions.
3. Confirm Resend webhook subscriptions and signature secret.
4. Run controlled provider acceptance, database-outage recovery, CRM activity and Inbox tests.
5. Run the production frontend build.

## Remaining verification

- PostgreSQL 16 migration/test runner: not executed (`psql` unavailable).
- Deno Edge Function type/runtime validation: not executed (`deno` unavailable).
- Production build: not executed (`node_modules`/Vite unavailable).
- Hosted Supabase migration and Edge Function deployment: not performed.
- Live provider verification: not performed.

Only Resend is currently installed as a production adapter. FakeMail in tests is a mock, not a live second-provider integration. No real prospect emails were sent.

See `PHASE_4F_CORRECTIVE_FIX_REPORT.md` and `docs/EMAIL_PHASE_4F_VALIDATION.md` for detailed implementation and verification records.
