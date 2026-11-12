# KairFlow Inbox Sync Patch Round 4

Date: 2026-11-12

## Confirmed defects addressed

1. **A provider page that exceeds the 40-second account budget could never finish.** Gmail and Zoho now carry an in-page resume offset in the persisted checkpoint. Gmail resumes the same `pageToken` at the first unprocessed message ID; Zoho resumes the same folder/start window at the first unprocessed row. The offset advances only after the message's provider data has been fetched and normalized. Previously fetched rows are skipped on the next invocation.
2. **Partial pages now make durable bounded progress.** The coordinator persists the recovered prefix through the existing idempotent message upsert, then commits the partial page's resume checkpoint. The checkpoint does not advance past any row that was not recovered and persisted. A later run resumes within the page rather than restarting at its first row.
3. **Zero-progress partial responses now back off.** If an adapter reports a partial page but returns the same checkpoint (including a timeout during the first per-message fetch), the coordinator raises `sync_deadline`; the existing failure path records bounded backoff. This is independent of whether the adapter threw or returned `partial: true`.
4. **Persistence completes for the bounded provider response.** Once the adapter returns a bounded page/partial-page response, the coordinator finishes persisting that response even if the provider request deadline has elapsed. Aborting local upserts at the deadline would replay the same persistence prefix indefinitely. Provider network requests remain deadline-bound; the response is bounded by provider page sizes (Gmail 100, Zoho 25).

## Regression coverage

- Gmail and Zoho partial-page checkpoints carry the resumable row offset.
- Deadline before any message is fetched preserves the original checkpoint and reaches backoff.
- Partial response with no checkpoint progress reaches the normal failure/backoff path.
- A 100-message page requiring 60 seconds under a 40-second per-run account budget is resumed over successive runs (66 + 34 in the regression model), reaches completion, and persists 100 unique message IDs.
- The coordinator persists the entire bounded partial response after the provider deadline expires, allowing its offset to be committed safely.

## Verification

- Focused Inbox adapter/coordinator suite: **27 passed, 0 failed**.
- Full Node test suite: **1,070 passed, 0 failed**.
- Strict TypeScript check for the modified sync, adapter, runner, and OAuth modules: **passed**.
- Migration check: Gmail and Zoho `remote_sync: false` values remain unchanged.
- No provider account, mailbox, deployment, migration, or live staging environment was accessed.

## Scope still outstanding

- Gmail History API incremental sync and Zoho change-cursor incremental sync are not implemented by this patch.
- Account eligibility/selection audit remains next.
- Zoho attachment workflows and live provider acceptance remain outstanding.
- Keep `remote_sync: false` until incremental sync and staging acceptance are complete.
