# KairFlow — Confirmed Production Bugfix Report

**Scope:** Four confirmed findings from `KairFlow_All_Phases_Production_Audit.md`.
**Base:** `KairFlow_Phase7_Confirmed_Bugfixes.zip`.
**Status:** Source changes and Node regression suite complete. Database integration and production deployment are not performed.

## Fixes

1. **ComposeDialog runtime crash (P1):** moved CRM recipient matching, lead-link selection, and `crmLinkProblem` initialization before the aggregate `problem` expression. Added a regression test that guards the initialization order.
2. **Sender email regex (P1):** added a forward migration that replaces the broken sender-safety RPC with a corrected regex `20261224100000_email_crm_confirmed_production_bugfixes.sql` so databases that already applied the broken migration receive the corrected `email_upsert_account` RPC. Added a PostgreSQL regression SQL fixture for a valid dotted-domain address.
3. **Auto-reply header persistence (P2):** inbound webhook ingestion now persists a bounded allowlist of threading, unsubscribe, and auto-reply headers. It includes `auto-submitted`, `precedence`, `x-autoreply`, and `x-autorespond`; unrelated headers are excluded. Added unit coverage for allowlisting and length bounds.
4. **Structured CRM activity attribution (P2):** the forward migration makes `email_crm_activities.lead_id` nullable, backfills existing activity rows from their current conversation lead, and updates the structured row whenever a conversation is relinked, unlinked, or its message is rethreaded. Unlinking retains the activity but clears its lead association. Added transactional SQL coverage for relink and unlink.

## Files changed

- `src/email/components/ComposeDialog.jsx`
- `src/email/composer-send-regressions.test.mjs`
- `src/email/email.test.mjs`
- `src/email/production-bugfixes.test.mjs` (new)
- `supabase/functions/_shared/email_resend_logic.ts`
- `supabase/migrations/20261224100000_email_crm_confirmed_production_bugfixes.sql` (new)
- `supabase/tests/email_crm_activity_relink.test.sql` (new)
- `supabase/tests/email_sender_regex.test.sql` (new)
- `supabase/tests/run_intelligence_auth.sh`
- `docs/PHASE_7_DEPLOYMENT_MANIFEST.md`
- `docs/PHASE_7_CONFIRMED_PRODUCTION_BUGFIX_REPORT.md` (new)

## Verification

- `npm test`: **1,034 passed, 0 failed**.
- `node --experimental-strip-types --check supabase/functions/_shared/email_resend_logic.ts`: passed.
- `python -m pytest intelligence-worker/tests -q`: **748 passed, 383 subtests passed**.
- `npm run build`: **not run successfully**; the supplied archive's `node_modules` is incomplete and `vite` is unavailable (`sh: vite: not found`).
- PostgreSQL SQL fixtures: **not executed**; `psql`/PostgreSQL are unavailable in this environment. They are registered in `supabase/tests/run_intelligence_auth.sh` for execution against the disposable PostgreSQL test database.
- No browser render test, live Supabase test, live Resend call, email send, migration push, or deployment was performed.

## Deployment notes

- Apply `20261224100000_email_crm_confirmed_production_bugfixes.sql` after the existing Phase 7 migration sequence. It is a forward migration for databases where the earlier sender-safety migration is already applied.
- The migration performs a one-time structured-activity attribution backfill. Back up the database before applying it.
- `email_crm_activities.lead_id` becomes nullable intentionally so unlinking a conversation does not delete the historical email activity. Do not roll this back by restoring `NOT NULL` until all NULL rows have been manually reconciled.
- The source changes are not deployed. Check remote migration history and inspect the Supabase dry run before applying migrations. The migration test runner should be executed against PostgreSQL before production rollout.
- No changes were made to KairFlow Intelligence routing, campaign behavior, autonomy, provider secrets, RLS policy intent, or real email delivery behavior.


## Follow-up correction — delayed CRM recovery attribution

The independent recheck found that a provider-accepted message could be relinked or unlinked before its structured CRM activity existed, after which the recovery worker could recreate the activity against the stale `email_messages.crm_lead_id`. The new forward migration `20261225100000_email_crm_recovery_current_link.sql` makes the conversation's current `lead_id` authoritative at activity-recording time, skips unlinked conversations in the recovery queue, and retains the existing ownership checks and service-role-only grants. The SQL regression fixture now covers relink-before-recovery, unlink-before-recovery, and recovery after a later relink.
