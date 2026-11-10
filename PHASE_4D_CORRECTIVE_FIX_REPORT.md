# Phase 4D — Corrective Fix Report

## Findings addressed

1. **Conversation attribution gap:** outbound messages could store `crm_lead_id` while their conversation remained unlinked. The corrected `email_create_outbound()` now writes a newly supplied lead to the conversation in the same transaction and inherits an existing conversation lead for replies.
2. **Stale association race:** the Edge Function's earlier conversation lookup was not authoritative. The database RPC now locks the conversation row, resolves and validates the lead while holding the lock, and rejects conflicting explicit lead IDs.
3. **Draft attribution:** draft rows are locked and their conversation association is resolved before queuing; sending a saved draft inherits the conversation lead.
4. **Concurrent idempotency race:** submissions sharing an organization-scoped idempotency key are serialized with a transaction-scoped advisory lock before duplicate lookup and message creation.
5. **Lead ownership race:** the lead row is held with `FOR SHARE` while ownership is verified, preventing a concurrent ownership change during the transaction.

## Files changed

- `supabase/migrations/20261209100000_email_crm_conversation_attribution.sql` — corrective replacement for `email_create_outbound(jsonb)`.
- `supabase/tests/email_crm_activity.test.sql` — SQL regression cases for new conversation binding, stale association rejection, reply inheritance, and saved-draft inheritance.
- `src/email/crm-attribution-corrective.test.mjs` — source-contract tests for locking, atomic association, ownership and grants.
- `src/email/provider-foundation.test.mjs` — migration-order test now includes the corrective migration.
- `PHASE_4D_HANDOFF_REPORT_MULTI_PROVIDER.md` — appended corrective handoff notes.

## Verification

- Full Node test suite: **925 passed, 0 failed, 0 skipped**.
- Production build: **not run successfully**; Vite is not installed (`vite: not found`).
- PostgreSQL SQL regression tests: **not executed**; no `psql` or Supabase CLI is available in this environment.
- Hosted migration and Edge Function deployment: **not performed**.
- Live provider tests: **not performed**.

The corrective migration is additive and does not contact any provider. It must be applied before deploying the updated Edge Function. Do not treat Phase 4D as production-approved until the SQL regression file is executed against the project's PostgreSQL database and deployment acceptance tests pass.
