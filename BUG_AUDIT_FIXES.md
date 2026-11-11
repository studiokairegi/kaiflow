# Bug audit fixes (this pass)

Verified by: `npm test` (1,039 pass), `tsc` type-check of the email shared modules (only the unrelated Uint8Array/BufferSource lib-version noise in email_token_vault.ts remains).
Not verified: production build (no node_modules in the archive, no network) and anything against live providers or a real Postgres.

1. **Synced conversations could never be created** - `email_get_or_create_synced_conversation` inserted 5 columns with 4 values. Fixed by `20261226110000_email_mailbox_synced_conversation_insert_fix.sql`. (`supabase/tests/email_phase5_foundation.test.sql` already exercises this and would have failed.)
2. **Inbox showed at most 50 conversations** - UI hard-coded limit 50 / offset 0 with no way to load more; SQL ordering had no tiebreaker. Added "Load more" (page grows by 50, max 500), reset on folder/search/filter change, and `20261226100000_email_inbox_stable_pagination.sql` (stable `sort_at desc, id desc`, cap raised to 500).
3. **Newly arrived messages in an open conversation stayed unread** - mark-read effect only ran when the conversation id changed; it now also reacts to `unread_count`.
4. **Inbound routing missed accounts whose local part contains `_`** - the LIKE fallback stripped `_`/`%` instead of escaping them (`email_resend_store.ts`).
5. **Type errors hidden by Node's type stripping** - `AdapterSyncPage` was not imported in `email_mailbox_sync.ts`; `crm_recipient_mismatch` was missing from `SendErrorCode`.
6. **`vite: Permission denied`** - scripts now call `node ./node_modules/vite/bin/vite.js` so a lost executable bit (zip/Windows) no longer blocks `npm run build`.

## Multi-account inbox synchronization audit (intelligence-worker/kairflow_intel/mailops.py)

7. **One failing account stopped every later account** - `sync_provider_accounts` had no per-account error boundary, so a revoked Gmail token starved all other mailboxes on every run. Each account is now isolated; its cursor is left untouched so the next run retries it, and the first error is re-raised after all accounts were attempted so the job still reports failure.
8. **Mail between the studio's own connected mailboxes was ingested as prospect replies** - only the polled account's own address was excluded. All connected mailboxes are now treated as own for every account.
9. **Every run walked the entire mailbox** - messages older than the cursor were skipped one by one but paging never stopped (Gmail fetched headers for each). The scan now stops after one page of consecutive messages older than the cursor window.

Tests: `intelligence-worker/tests/test_multi_account_sync_audit.py` (751 Python tests pass).

10. **Re-sync marked already-read mail unread again** - `email_ingest_inbound` overwrote `is_read` with the provider's value. A local read is now never undone (provider-read still marks read). `20261226120000_email_mailbox_resync_state_fixes.sql`.
11. **Attachments without a provider id were duplicated on every re-sync** - NULL never matched NULL. They now match by filename (inbound and synced-outbound ingest, same migration).
12. **`synchronizeMailbox` threw if recording a failure failed** - it now returns a failed result and lets the lease expire (test added).

13. **A newly connected Intelligence account read its whole inbox history** - with no cursor the first sync now reads only the last 30 days (`initial_lookback_ms`, `None` restores the old behaviour). Test added.
14. **The general Email mailbox sync coordinator was never run** - added the `email-mailbox-sync` Edge Function (secret-authenticated, `EMAIL_SYNC_CRON_SECRET`), the provider-neutral runner `email_mailbox_sync_runner.ts` (per-account isolation, skips providers without a `sync` capability, tested) and `20261226130000_email_mailbox_sync_schedule.sql` (pg_cron every 2 minutes via pg_net, only after you store the function URL and secret in `email_sync_config`).

Still open (needs live credentials, cannot be built or verified here): a Gmail/Zoho/IMAP *adapter with `sync`* and the OAuth connect flow for general Email. Until one is registered, the runner reports those accounts as `no_sync_capability`. Deploy checklist: set `EMAIL_SYNC_CRON_SECRET` and `EMAIL_TOKEN_ENCRYPTION_KEY`, deploy `email-mailbox-sync` with `--no-verify-jwt`, insert the `email_sync_config` row.
