# Inbox sync — Round 6 (backfill safety) + legacy Intelligence sync audit

## Round 6 change (strictly scoped)
- Gmail and Zoho adapters: when `lastProcessedId` is not found in the current page listing, the page restarts at row 0 (was: resume at `offset - 5`).
  Persistence is idempotent, so replaying a page is always safe; a fixed overlap cannot bound how many rows vanished.
- Tests (`src/email/gmail-zoho-adapter.test.mjs`): updated the Gmail missing-anchor test; added Gmail and Zoho tests where 8 processed rows
  (including the anchor) disappear. Mutation check: these tests FAIL against the Round 5 adapters and pass now.
- Not changed: coordinator, schema, migrations, `remote_sync` (still false for Gmail and Zoho).
- Verification: adapter tests 21/21; full Node suite 1,076 passed, 0 failed. No Vite build, Deno run, or live provider call was performed.

## Legacy Intelligence sync audit (read-only)
1. Trigger: Python worker (`intelligence-worker`) scheduler enqueues a `sync_mail` job every 120 s (`jobs.py` periodic()); handler `h_sync_mail`
   -> `mailops.sync_provider_accounts`. It is independent of the Edge Function cron (`email-mailbox-sync`).
2. Account overlap: YES. It reads `intel_agent_receive_accounts()` = every `intel_provider_accounts` row for gmail/zoho in the org with
   status connected, is_enabled, registry enabled. These are the same rows projected into `email_accounts`.
   It runs even with `KAIRFLOW_MAIL_PROVIDER=none`.
3. Persistence overlap: none found. Legacy writes go through `intel_agent_record_inbound` / `intel_agent_enqueue_job` (intel_* tables). The
   migrations defining those RPCs reference no email_* tables. The email side (`email_ingest_inbound` etc.) writes only email_* tables.
   Not verified: CRM-facing objects that both sides may touch via other functions (e.g. intel_prospects status vs email CRM timeline).
4. Checkpoint overlap: none. Legacy cursor = `intel_provider_accounts.sync_cursor` ({last_time_ms}); email cursor = `email_sync_state.cursor`.
   The projection trigger does not fire on sync_cursor/last_sync_at/updated_at updates.
5. Shared resources that DO interact:
   - Same OAuth refresh token refreshed from two places: legacy via the `intel-provider-token` function (cached ~1 h in-process),
     email sync via `getSharedProviderAccessToken` (once per account per invocation, every 2 min when cron is on). Zoho refresh limits apply to the sum.
   - Both update `intel_provider_accounts` health columns on refresh.
   - Same provider API quota per mailbox (two readers).
6. Behavioral difference worth noting: legacy sync is time-window incremental (cursor `last_time_ms`, 1 h overlap, stops after a page of stale items)
   and reads the inbox only; email sync is the full crawl.
7. Not audited: whether the worker is deployed/running in production, and `intel-provider-token`'s own rate behavior.

## Implications for Round 8 contract / later rounds
- Two readers per mailbox is acceptable only if token refresh and API quota are budgeted for both; decide whether the legacy path should keep
  polling inbox replies once the email sync is the system of record.
- Reconcile outcomes: legacy classification of replies (intel_messages) and the email inbox timeline can disagree about the same message; define the owner.
