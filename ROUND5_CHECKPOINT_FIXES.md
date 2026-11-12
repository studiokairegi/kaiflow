# Round 5 — Inbox Sync Checkpoint Fixes

## Scope

This pass modifies only the Gmail adapter, Zoho adapter, and their adapter regression tests. No database migration, provider registry capability, account setting, or remote-sync enablement was changed.

## Changes

- Gmail and Zoho partial-page checkpoints now include `lastProcessedId`, the provider message ID of the last successfully normalized message.
- On resume, adapters locate that stable ID in the freshly fetched page and continue immediately after it.
- If the anchor is absent (for example, a message was deleted, archived, or moved), adapters replay an overlapping prefix of up to five rows. Replays are safe because message persistence is idempotent.
- Gmail keeps the exact page token used for the interrupted page. A provider 400 is treated as an expired/invalid page token only when Gmail's response explicitly identifies a page-token error. In that case, the adapter retries the current label from its first page with the stale token and in-page cursor cleared. This is a safe backfill restart, not an account-level permanent failure.
- Normal page completion emits the ordinary next-page checkpoint and drops `offset` and `lastProcessedId`.

## Regression coverage

Added adapter-level tests for:

- Gmail stable-ID resume after a newly inserted row shifts list positions.
- Gmail preserving the page token used for the interrupted page.
- Gmail clearing in-page resume fields on completion.
- Gmail replay overlap when the stored anchor disappears.
- Gmail invalid page-token recovery from the beginning of the label listing.
- Zoho stable-ID resume and overlap replay when the anchor disappears.

## Validation

- `node --experimental-strip-types --test src/email/gmail-zoho-adapter.test.mjs`: **19 passed, 0 failed**.
- `npm test`: **1,074 passed, 0 failed**.
- Build: not verified. The snapshot did not contain `node_modules`; `npm ci --ignore-scripts --no-audit --no-fund` did not complete within the available execution window, so Vite was unavailable.
- No migration was added or edited. Existing Gmail/Zoho registry migrations still declare `remote_sync: false`.

## Remaining operational note

The five-row fallback is a bounded safety overlap, not a mathematically lossless cursor if more than five messages disappear from the provider listing between runs. Stable-ID anchoring handles ordinary inserts/reordering; a durable provider cursor (Gmail History ID / Zoho change cursor) remains the proper incremental-sync design. Until then, periodic full backfill remains the recovery safety net.
