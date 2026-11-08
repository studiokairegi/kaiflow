# Phase 10 — Confirmed Bug Fix Handoff

## Objective
Correct confirmed Phase 10 schema/provider alignment issues while preserving the existing Supabase, Edge Function, provider registry, worker, CRM, authorization, and email architecture.

## Corrections
1. **Legacy Gmail/Zoho OAuth registry synchronization:** Added a database trigger on `intel_mail_account` inserts, updates, and deletes to keep its bridge record synchronized with `intel_provider_accounts`. A migration backfill reconciles legacy accounts that connected after the original registry migration. Ciphertext stays encrypted and is copied only into the service-role-owned registry. New bridge records default to `is_enabled=false` and `send_enabled=false`; re-authentication does not silently change those controls. Replaced/deleted identities are marked disconnected.
2. **Provider status clarity:** `intel_admin_mail_status()` now exposes connection status separately from `sending_eligible`, plus deployment provider-gate status. The organization-level connection status still accurately reflects connected mailboxes, not a sending authorization claim.
3. **Schema drift detection:** Phase 10 validates the declared types of critical existing identity and provider-gate columns and fails with a direct actionable exception rather than accepting same-name incompatible columns.

## Files changed
- `supabase/migrations/20261130100000_intelligence_phase10_schema_provider_alignment.sql`
- `supabase/migrations/20261130110000_intelligence_phase10_legacy_account_sync.sql` (new)
- `src/intelligence/phase10-provider-schema-contract.test.mjs`

## Tests
- Phase 10 provider schema contract tests: **9 passed**.
- SQL execution against disposable PostgreSQL: **not performed**.
- Live Gmail/Zoho OAuth: **not performed**.
- Resend real webhook integration: **not performed**.

## Safety
No deployment, push, worker activation, kill-switch change, autonomy enablement, or real email sending occurred. Provider account sending remains disabled by default for newly synchronized accounts.

## Remaining validation
Apply migrations to a disposable PostgreSQL instance and test: legacy callback insert/update/delete sync; changed mailbox identity disconnect; status eligibility fields; pre-existing incompatible column type fail-fast behavior; and race/concurrency of migration backfill with OAuth writes.

## Next phase
Phase 11 — Security and controller hardening. Do not start automatically; prior phase acceptance is required.
