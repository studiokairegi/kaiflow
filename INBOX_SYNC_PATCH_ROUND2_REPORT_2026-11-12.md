# Inbox multi-account sync patch round 2 — 2026-11-12

## Scope
Addressed the auditor's test-coverage, in-page deadline, Zoho refresh-revocation classification, and OAuth network-timeout gaps. Existing Settings/Intelligence OAuth accounts, encrypted credentials, account IDs, and token lifecycle remain authoritative. `remote_sync` remains disabled; no migration or live account activation was performed.

## Changes
- Added regression coverage for revoked-vs-transient OAuth responses, account deadline propagation, Gmail/Zoho adapter deadline checks, and coordinator handling of a deadline as a resumable partial run.
- Runner now passes a per-account absolute deadline bounded by both the 40-second account budget and the 100-second invocation budget.
- Gmail and Zoho adapters check the deadline before each provider request and each per-message iteration. Each request timeout is the lesser of 20 seconds and the remaining account budget. Deadline aborts are translated to `sync_deadline`; coordinator releases the lease as a partial run without advancing the unprocessed page checkpoint.
- OAuth token endpoint fetches in the mailbox sync Edge Function now have a 15-second timeout.
- Added a shared OAuth revoked-response classifier. Gmail `invalid_grant`/401 and Zoho `invalid_code`/401 are classified as revoked. Official Zoho OAuth guidance identifies `invalid_code` for a refresh-token value that is invalid or revoked; `invalid_client` remains a configuration failure, not user revocation. `invalid_client` remains a configuration failure, not user revocation.

## Verification
- Focused Inbox sync/runner/adapter tests: 26 passed.
- Full Node test suite: 1,064 passed, 0 failed.
- Strict TypeScript check of gateway, token-cache, adapter, runner, coordinator and OAuth modules: passed.

## Zoho response evidence
Zoho official OAuth troubleshooting guidance states that `invalid_code` for `grant_type=refresh_token` means the refresh token is invalid or was manually revoked. This supports the `invalid_code` classifier. A live KairFlow Zoho account was not used to capture an actual response, so staging acceptance remains required. See https://help.zoho.com/portal/en/kb/accounts/faqs-troubleshooting/faqs/oauth/articles/invalid-code-redirect-uri and https://www.zoho.com/developer/oauth/web-server-apps/refresh-access-token.html.

## Limitations
- No live Zoho token was revoked for end-to-end confirmation; staging acceptance remains required.
- This does not implement Gmail History API or Zoho change-cursor incremental sync. The full-crawl behavior remains.
- Account selection, disabled-mailbox filtering, SMTP row exclusion, due-account RPC, poison-message quarantine, deletion/unread reconciliation, and Zoho sent-copy identity remain outstanding.
- Keep `remote_sync: false` for Gmail and Zoho until incremental sync, account selection and staging acceptance are complete.
