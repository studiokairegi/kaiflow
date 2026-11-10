# KairFlow Email — Phase 4D CRM Activity Recording

**Status:** Implemented in the supplied Phase 4C repository snapshot; local source tests pass. Not deployed. No real provider submission or live database write was performed.

## Contract

1. `email-send` verifies the lead belongs to the authenticated sender before creating an outbound row.
2. `email_create_outbound` independently checks that ownership in SQL and stores `crm_lead_id` on `email_messages` before the provider call. The CRM lead and user are included in the idempotency fingerprint; a reused key cannot silently switch leads.
3. Only provider-accepted statuses (`sent`, `delivered`, `delivery_delayed`, `bounced`, `complained`) can create a CRM activity.
4. `email_record_crm_activity(message_id)` atomically creates a full-content row in `email_crm_activities` and appends one compact `email_sent` entry to `leads.activity_log`. A unique message id and timeline message reference make replay idempotent.
5. A CRM write failure after provider acceptance returns `outcome: accepted`, `crm.activity: pending`, and `warning: crm_activity_pending`. It does not return a send retry instruction and does not call the provider again.
6. Replaying the same accepted idempotent send attempts CRM recording again without provider submission.
7. `email_recover_crm_activities(limit)` scans accepted outbound messages with a persisted CRM lead association but no activity record. It repairs CRM only; it never invokes an adapter or changes send status.
8. A trigger preserves previously recorded email timeline entries if a stale CRM editor snapshot later saves the lead's JSON activity log.

## Stored activity fields

The dedicated `email_crm_activities` row stores organization, lead, sender account, authenticated user, provider, provider message id, sender address/name, To/CC/BCC, reply-to, subject, approved text and HTML content, and accepted timestamp. The lead timeline receives a compact entry with `type=email_sent`, timestamp, note, email message id, activity id, provider and provider message id.

## Recovery operation

Run with the Supabase service role (never from a browser session):

```sql
select public.email_recover_crm_activities(100);
```

The function is granted only to `service_role`, clamps each batch to 1–500, isolates failures per message, and returns attempted/recorded/failed counts. Schedule it with Supabase Cron/pg_cron after deployment if automatic recovery is desired. This migration does not create a schedule.

## Files changed

- `supabase/functions/_shared/email_resend_logic.ts`
- `supabase/functions/_shared/email_resend_store.ts`
- `supabase/migrations/20261208100000_email_crm_activity.sql`
- `src/email/dispatch-4b.test.mjs` (updated Phase 4B expectation to the completed 4D behavior)
- `src/email/dispatch-4d.test.mjs`
- `supabase/tests/email_crm_activity.test.sql`
- `docs/EMAIL_CRM_ACTIVITY_4D.md`

## Verification boundaries

- Node repository tests: **921 passed, 0 failed, 0 skipped** (`npm test`).
- Strict TypeScript check for the two modified shared email modules: passed.
- SQL behavior test: `supabase/tests/email_crm_activity.test.sql` requires the project's PostgreSQL test harness and the Phase 4D migration; it was not executed in this environment.
- Vite production build: attempted but unavailable because this extracted repository has no `node_modules` (`vite: not found`).
- No migration was applied to hosted Supabase; no Edge Function was deployed; no live provider behavior was tested.

## Rollback

Use the non-destructive rollback comments at the bottom of the Phase 4D migration. Rollback removes only the Phase 4D recording machinery and the CRM lead association column; it does not delete or resubmit email messages. If Phase 4D has been deployed and CRM activity rows contain useful audit data, export them before dropping the table.
