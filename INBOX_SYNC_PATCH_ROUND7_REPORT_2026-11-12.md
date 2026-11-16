# Inbox sync — Round 7: account selection and eligibility

## Summary

Round 7 adds a fail-closed, database-authoritative account selector for the scheduled Email mailbox sync. It does not enable Gmail or Zoho synchronization, change provider capabilities, opt in any mailbox, or alter the legacy Intelligence worker.

## Eligibility rule

An account is eligible only when all of the following are true:

1. The Email account is Gmail or Zoho, active, connected, linked to its source Intelligence provider account, and its normalized mailbox address matches that source account.
2. The linked `intel_provider_accounts` row is connected and `is_enabled = true`.
3. The Intelligence provider registry row is enabled.
4. The Email provider registry row is enabled and its JSON capabilities explicitly contain `remote_sync: true`.
5. The account is not inside its retry backoff and has no unexpired sync lease.

The selector orders eligible accounts by least-recent attempt and then account UUID, and clamps the requested batch size to 1–25.

## Changes

- Added `supabase/migrations/20261229100000_email_mailbox_sync_eligibility.sql`.
  - Adds service-only `email_mailbox_sync_account_eligible(uuid)`.
  - Adds service-only `email_list_sync_accounts(integer)`.
  - Rechecks eligibility atomically in `email_claim_sync`.
  - Rechecks eligibility on lease renewal, checkpoint commit and sync finish. If an account is disabled or its provider capability is withdrawn mid-run, the worker cannot continue renewing or advance/finalize its checkpoint.
  - Preserves the existing two-argument `email_finish_sync` compatibility overload.
- Updated `supabase/functions/email-mailbox-sync/index.ts` to use the selector RPC instead of listing all active/connected accounts.
- Added source-contract tests in `src/email/mailbox-sync-eligibility.test.mjs`.
- Added runner tests for the registry capability backstop and loss of eligibility during a run.

## Explicitly unchanged

- Gmail and Zoho `remote_sync` remain `false`; both providers remain ineligible.
- No Intelligence account is enabled or disabled by this patch.
- No changes to `intel_provider_accounts`, the legacy Intelligence sync worker, token refresh, reply classification, or inbox timeline ownership.
- No adapter, coordinator message contract, message persistence, or cursor changes.
- No IMAP investigation or activation.
- No message, conversation, CRM, or credential data is deleted or modified by the migration.

## Verification

- Focused Round 7 tests: **12 passed, 0 failed**.
- Full Node test suite: **1,083 passed, 0 failed, 0 skipped**.
- The full suite includes the Round 6 adapter tests and prior 1,076-test baseline.
- Production build: **not verified**. `npm run build` could not find `node_modules/vite/bin/vite.js`; an `npm ci --ignore-scripts --no-audit --no-fund` attempt timed out before dependencies were installed. No source/build failure was established.
- No PostgreSQL instance was available, so the migration was not applied against a live database. No Deno check or live provider request was run.

## Deployment and safety notes

Apply the migration before deploying the updated Edge Function. Until `remote_sync` is deliberately enabled in a separately reviewed acceptance change, the selector should return zero Gmail/Zoho accounts. The legacy Intelligence worker remains independently capable of polling its own enabled accounts; Round 7 does not resolve the previously identified shared-token/quota or reply-classification ownership decisions.

## Next step

Round 8 should specify and review the backward-compatible adapter change model, state-update persistence path, tombstone semantics, and quarantine behavior before implementing Gmail History API support.
