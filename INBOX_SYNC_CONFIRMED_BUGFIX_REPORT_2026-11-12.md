# Inbox Multi-Account Sync — Confirmed Bugfix Report

Date: 2026-11-12

## Changes made

1. **Token refresh lockout protection.** The shared OAuth token gateway now marks an account `status=error` only for a confirmed revoked-authorization response (`invalid_grant` or HTTP 401). HTTP 429 and other non-revocation failures leave the account connected and mark health degraded so scheduled retry remains possible. This avoids turning provider throttling into a forced reconnect.
2. **Per-invocation token reuse.** The mailbox runner now creates one adapter context for the invocation. The Edge Function context memoizes the shared provider-token request by account and operation, so page fetches for the same account reuse the same access token and do not refresh on every page.
3. **Execution bounds.** The runner has a 100-second invocation budget and defers remaining accounts when reached. Each account has a 40-second processing budget and exits at a page boundary with its checkpoint preserved. Provider HTTP calls have a 20-second abort timeout.
4. **Removed duplicate credential preflight.** The coordinator no longer decrypts/loads the same authoritative Intelligence credentials before the token gateway performs its own authoritative account/policy/credential validation. This removes an unnecessary per-account credential read/decrypt.

## Validation

- `npm test`: **1,057 passed, 0 failed**.
- Focused mailbox sync and runner tests: **10 passed, 0 failed**.
- Strict TypeScript check for the shared adapter, OAuth, coordinator and runner modules: **passed**.

## Intentionally not changed

- `remote_sync` remains `false` for Gmail and Zoho. Do not enable until the remaining work is complete and staging acceptance succeeds.
- Gmail History API and Zoho change-cursor incremental sync are not implemented by this patch. Existing adapters still perform paged mailbox crawls.
- The due-account RPC/selection redesign is not implemented. The current account-list query still needs provider-capability and enabled-state alignment against the deployed schema.
- Bad-message quarantine/skip semantics are not implemented; checkpoint safety remains all-or-nothing per page.
- Deletion/unread semantics and Zoho sent-message identity require provider-backed staging verification.
- No live provider calls, deployed database, Deno runtime, or production Edge Function execution were available in this environment.

## Safety note

This patch improves refresh behavior and execution bounds but does **not** make multi-account remote sync production-ready. Keep remote sync disabled until incremental cursors, due-account selection, poison-message handling and live mailbox acceptance are completed.
