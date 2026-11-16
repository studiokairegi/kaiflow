# KairFlow Inbox Sync Patch Round 3 — Deadline Partial-Page Recovery

**Status:** Implemented locally; focused and full automated tests pass.

## Confirmed defects fixed

1. **Deadline during a provider page no longer discards already-fetched messages.** Gmail and Zoho adapters now return the messages successfully normalized before the deadline with `partial: true`, `has_more: true`, and the original checkpoint. The coordinator persists those messages through the existing idempotent upsert path and deliberately does not commit the page checkpoint. The next run retries the same page; duplicate provider IDs are safely upserted.
2. **Deadline during persistence also prevents checkpoint advancement.** The coordinator checks the account deadline between message upserts. If it expires, already persisted rows remain safe and the page checkpoint is held for retry.
3. **Zero-progress deadline runs are visible and backed off.** If a deadline expires before any messages have been recovered, the coordinator records a bounded retry failure rather than repeatedly finishing as a healthy-looking partial run.
4. **Late accounts are deferred.** The runner does not start another mailbox when fewer than five seconds remain in the overall 100-second invocation budget. It records `deferred:insufficient_run_budget` in the run summary.
5. **Timeout classification is robust to timer ordering.** When the request timeout was capped by the remaining account budget, a `TimeoutError` is classified as `sync_deadline` even if the clock has not quite reached `deadlineAt`. Both Gmail and Zoho are covered.
6. **Cleanup:** removed the unused `oauthError` local from `intel_provider_oauth.ts`.

## Regression coverage

- Gmail and Zoho return actual fetched messages as incomplete pages with unchanged checkpoints when the deadline is reached mid-page.
- Coordinator persists a partial page, does not advance the checkpoint, and safely retries it without duplicate inserts.
- Zero-progress deadline is backed off rather than silently marked as a successful partial run.
- Accounts with less than five seconds left in the run budget are deferred before registry lookup or sync claim.
- Gmail and Zoho `TimeoutError` just before the deadline maps to `sync_deadline`.

## Validation

- Focused Inbox adapter/coordinator/runner suite: **30 passed, 0 failed**.
- Full Node suite: **1,068 passed, 0 failed** (`npm test`).
- Strict TypeScript check across the Inbox adapter/coordinator/OAuth files: **passed**.
- `remote_sync: false` remains set for Gmail and Zoho in migration `20261228110000` (verified in source; no migration applied).

## Files changed

- `supabase/functions/_shared/email_adapter.ts`
- `supabase/functions/_shared/email_adapter_gmail.ts`
- `supabase/functions/_shared/email_adapter_zoho.ts`
- `supabase/functions/_shared/email_mailbox_sync.ts`
- `supabase/functions/_shared/email_mailbox_sync_runner.ts`
- `supabase/functions/_shared/intel_provider_oauth.ts`
- `src/email/gmail-zoho-adapter.test.mjs`
- `supabase/functions/_shared/email_mailbox_sync.test.mjs`
- `supabase/functions/_shared/email_mailbox_sync_runner.test.mjs`
- `INBOX_SYNC_PATCH_ROUND3_REPORT_2026-11-12.md` (this report)

## Scope and deployment

No deployment, database migration, provider activation, mailbox sync, live OAuth refresh, or live email operation was performed. Gmail History API and Zoho change-cursor incremental sync remain outstanding. Account-selection hardening and staging acceptance remain the next steps. Keep `remote_sync: false` until those steps and live-provider acceptance are complete.
