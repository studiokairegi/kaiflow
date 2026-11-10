# KairFlow Phase 7 — Delivery Event Bugfix Handoff

## Scope

Applied the five confirmed Phase 7 delivery-event fixes to the Phase 6 confirmed-bugs-fixed repository snapshot. Phase 2–6 fixes were retained. This package is source-only: no migration was executed, no database was changed, no deployment or Git push was performed, and no worker or email sending was activated.

## Fixes

1. **Provider suppression propagation**
   - `email.suppressed` is routed to both CRM and Intelligence delivery handlers.
   - Intelligence records the message as failed/rejected (not falsely as a bounce) and creates an email suppression with reason `provider_suppressed`.
   - CRM-only provider-suppressed messages also create Intelligence suppressions when the exact recipient is known.

2. **CRM-only bounce suppression**
   - CRM delivery-event persistence now creates the matching Intelligence email suppression for a confirmed bounce or complaint, including when no Intelligence message row exists.
   - Recipient identity comes from the single verified webhook recipient, with a single-recipient CRM message fallback; ambiguous multi-recipient cases are not guessed.

3. **Temporary/soft bounce classification**
   - Resend `temporary`, `transient`, and `soft` bounce types map to `delivery_delayed` in CRM and `delayed` in Intelligence.
   - Permanent/unspecified bounces remain `bounced`.
   - Worker normalization honors explicit soft-bounce subtypes without allowing unrelated conflicting adapter statuses to override the provider event type.
   - Temporary bounces do not create permanent contactability suppressions.

4. **Durable unmatched-event reconciliation**
   - Removed the 120-second discard rule.
   - Authenticated unmatched event payloads remain stored in `email_webhook_events` and are marked as awaiting reconciliation.
   - Database triggers replay the exact stored provider event when the corresponding CRM or Intelligence message later receives its provider message ID.
   - Replay is idempotent and indexed by provider message ID; it does not guess across ambiguous message/account matches.

5. **Suppression provenance protection**
   - Complaint upgrades are restricted to existing agent/provider delivery suppressions with bounce-related reasons.
   - Administrator/legal and unrelated agent/provider suppression reasons and provenance are preserved.
   - Provider-suppressed markers do not downgrade complaint suppressions.

## Files changed

- `supabase/migrations/20261203100000_intelligence_phase7_delivery_event_corrective.sql` — new corrective migration.
- `supabase/functions/_shared/email_resend_logic.ts` — soft-bounce classification, recipient evidence and durable unmatched-event handling.
- `supabase/functions/_shared/email_resend_store.ts` — Intelligence soft-bounce mapping.
- `intelligence-worker/kairflow_intel/delivery_events.py` — soft-bounce normalization.
- `src/email/email.test.mjs` — updated Resend webhook regression expectations.
- `intelligence-worker/tests/test_delivery_events.py` — worker soft-bounce regression coverage.
- `src/intelligence/phase7-resend-delivery-regression.test.mjs` — new Phase 7 regression/contract tests.

## Verification

> **Historical snapshot:** This report records the test totals at the time of this specific delivery-event bug-fix handoff; these are historical snapshot counts, not the final aggregate Phase 7 suite totals.

- Full JavaScript test suite: **842 passed, 0 failed**.
- Full Intelligence worker Python suite: **747 passed**.
- Focused delivery-event Python tests: **13 passed**.
- Python compilation: passed.
- Focused Phase 6/7 and Resend JavaScript regressions: **29 passed**.

## Production acceptance still required

- Apply the new migration in a disposable/staging PostgreSQL database and run the SQL test suite.
- Verify the trigger replay behavior with actual CRM-only, Intelligence-only, unmatched-then-matched, duplicate, and out-of-order event fixtures.
- Exercise signed Resend webhook delivery against a staging Resend account.
- Confirm the real Resend bounce-type payload values used by the configured account/provider.

No PostgreSQL server/client or Supabase CLI was available in this environment, so SQL execution and live webhook verification were not possible. The passing tests include source-level contract/regression tests and do not substitute for staging database acceptance.
