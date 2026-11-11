# Manual Lead Email Composition — Phase 4: Email Sending & CRM Activity Tracking

**Status:** source complete, tests pass. Not deployed; no migration applied; no real email sent.

## Audit result
The sending and CRM-recording contract already existed (earlier 4A–4D work, documented in `EMAIL_CRM_ACTIVITY_4D.md`): `email-send` reuses the provider adapter; CRM activity is created only for provider-accepted statuses; the lead/user are in the idempotency fingerprint; a CRM failure after acceptance returns `crm_activity_pending` and never resubmits; replays repair CRM only. The 4D table stores sender, recipients, subject, text/html body, timestamp, provider and provider message id.

## Gaps found and fixed in this phase
1. **Recovery was manual only.** Added `20261220090000_email_crm_recovery_schedule.sql`: schedules `email_recover_crm_activities(100)` every 10 minutes **only if pg_cron is already enabled**; otherwise it raises a notice and does nothing. Idempotent; rollback in the file. It never calls a provider.
2. **Colleague leads offered Compose but the send would be refused.** `email-send` accepts only leads whose `user_id` equals the sender. Leads now carry `ownerUserId`, and `leadComposeTarget(lead, userId)` hides Compose for leads owned by someone else. (Phase 3 file touched: `logic.js`, `App.jsx`.)

## Files
`supabase/migrations/20261220090000_email_crm_recovery_schedule.sql`, `src/email/phase4-recovery-schedule.test.mjs`, `src/email/lib/logic.js`, `src/email/phase3-compose.test.mjs`, `src/App.jsx` (lead `ownerUserId`, call site).

## Verification
`npm test`: 978 passed, 0 failed. Not run: SQL tests (need the project's Postgres harness, incl. `supabase/tests/email_crm_activity.test.sql`), the migration against a real database, a live provider send, `npm run build`.

## Limitations
- If pg_cron is not enabled, recovery stays manual: `select public.email_recover_crm_activities(100);` as service role.
- Studio colleagues cannot email from another member's lead; supporting that would need a server-side authorization change (not made).
- After `crm_activity_pending` the dialog shows an error telling the user to press Send again; the repeat uses the same key and does not resend the email.
