# Inbox sync - Round 7.1: eligibility loss is not a provider failure

## Problem
In Round 7, renewal, checkpoint commit and finish refuse to act once an account becomes ineligible. The coordinator treated every refusal as a lease failure and called `email_fail_sync`. That increments `consecutive_failures` and sets a backoff of up to six hours, so disabling an account punished it.

## Rule implemented
1. Any error path in the coordinator first asks the database whether the account is ineligible now.
2. If yes, provider work stops and the lease is released through a dedicated path.
3. That path does not increment failure counters or set a retry delay.
4. It does not touch `consecutive_failures`, `next_retry_at`, `last_error`, `cursor`, `last_success_at` or `last_attempt_at`.
5. When the account becomes eligible again, normal selection applies according to its existing retry state.

If the account is still eligible, the release does nothing and returns false, so genuine failures and real lease expiry still go through `email_fail_sync` with backoff.

## Changes
- New migration `20261229110000_email_mailbox_sync_ineligible_release.sql` adds service-only `email_release_sync_ineligible(uuid, uuid)`. It requires the Round 7 helper, replaces no existing function, and closes the run row as `skipped`, an already allowed status.
- `MailboxSyncStore` gains `releaseIneligibleSync`, implemented in `email_mailbox_store.ts` over the new RPC.
- `synchronizeMailbox` calls it at the top of the catch block. On success it returns `status: skipped`, `skip_reason: account_ineligible`, so the runner counts a skip, not a failure. If the release call itself errors, the normal failure path runs and lease expiry remains the backstop.
- `email_fail_sync` is unchanged.

## Tests
- Coordinator: eligibility loss at renewal, checkpoint commit, partial-page commit and finish all release without failure; a provider error after disablement is not penalized; genuine lease loss and genuine provider failure on an eligible account still record failure and backoff; a failing release falls back to the failure path.
- Runner: an ineligible account counts as skipped with `skipped:account_ineligible`; an eligible account with an unrenewable lease still counts as failed.
- Store: RPC name and arguments.
- SQL contract: additive, ordered after Round 7, no assignment to any failure or retry column, token-holder and currently-ineligible guards, grants, run closed without a failure message.
- Full suite: 1,099 passed, 0 failed, 0 skipped. That is the 1,083 baseline plus 16 new tests.

## Staging release gate
`supabase/verification/email_mailbox_sync_eligibility_staging.sql` runs in one transaction that always rolls back. Section A is the nine-scenario eligibility truth table, with the registry scenario split into Intelligence registry, Email registry and capability flag. Section B checks the 7.1 behavior: refusals at renew, commit and finish, wrong-token no-op, no-op on an eligible account, preserved failure count, error text, cursor and unrelated retry time, run row closed as skipped, re-enable and reclaim, and `email_fail_sync` still penalizing genuine failures. It raises an exception and exits non-zero on any mismatch.

Run: `psql "$STAGING_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/verification/email_mailbox_sync_eligibility_staging.sql`

## Not verified
- No PostgreSQL server was available. Both SQL files were parsed with the PostgreSQL grammar, including every PL/pgSQL body, but neither was executed. The staging script is unrun.
- Fixture inserts assume `auth_method = 'oauth2'` and that several Gmail accounts can exist in one organization. If staging rejects a fixture insert, adjust the fixture, not the migration.
- No Deno check, no production build, no live provider request.

## Deployment order
Apply `20261229100000`, then `20261229110000`, then run the staging gate, then deploy the Edge Function. Keep both migrations unapplied to production until the gate passes.
