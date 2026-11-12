# Inbox sync - Round 7.2: fixes from the Round 7.1 audit

## Fixed
1. **A fetched page was saved even if the account was disabled during the provider request.** The coordinator now calls the lease renewal, which includes the eligibility check, after the fetch and before the save loop. On refusal nothing from the page is written, the lease is released through the 7.1 path, and no failure is recorded. A disable that lands in the middle of the save loop can still let the remainder of that single bounded page finish. That residual window is one page and is idempotent on replay.
2. **Crashed runs left `running` rows forever.** New migration `20261229120000_email_mailbox_sync_orphan_runs.sql` replaces only `email_claim_sync`. After the existing eligibility, retry and live-lease guards, and under the existing row lock, it closes earlier `running` rows for that account as `failed` with the fixed message "Run was interrupted before completion". Failure counters and retry state are not touched.

## Deliberately not changed
- When a revoked token makes an account ineligible, `email_sync_state.last_error` is still not written. Rule 4 of Round 7.1 says to preserve existing failure history, and the reason remains on the Intelligence account `last_error` and the projected `last_connection_error`.

## Verification
- Full Node suite: 1,104 passed, 0 failed. That is 1,099 plus 5 new tests.
- Staging script now has 58 checks, including Section C and C2 for orphaned runs and cleanup boundaries. All 58 passed on PostgreSQL 18 against a reduced stub schema that used the real Round 7, 7.1 and 7.2 migrations, the real projection trigger and the real `email_fail_sync`.
- Removing the orphan cleanup from the migration makes Section C fail, so the gate detects the regression.
- Strict `tsc` shows no errors in the changed source files. Two pre-existing errors in `email_token_vault.ts` are unrelated.
- Not verified: the real staging database, Deno, a production build, live provider requests.

## Apply order
20261229100000, then 20261229110000, then 20261229120000, then run the staging gate, then deploy the Edge Function.
