# KairFlow Email Shared-Account Correction — Implementation Handoff

Date: 2026-11-12

## Executive summary

This handoff corrects the account-ownership boundary and removes the Inbox's independent account-creation path. Settings/Intelligence is the account source of truth. Inbox account rows are a compatibility projection using the **same UUID** as `intel_provider_accounts`; credentials remain encrypted only in Intelligence.

This is a foundation correction, not a claim that all provider acceptance scenarios are complete. The central Inbox's TypeScript adapter registry does not yet contain reviewed Gmail, Zoho or SMTP adapters, and the existing SMTP implementation is submission-only. The migration therefore keeps the new Inbox provider catalogue entries disabled and advertises no unsupported capabilities.

## Changes made

### Database

New migration:

- `supabase/migrations/20261227110000_email_shared_intelligence_accounts.sql`

It:

- Adds `email_accounts.source_provider_account_id` with a foreign key to `intel_provider_accounts`.
- Projects Gmail, Zoho and SMTP account identity into `email_accounts` with the **same account UUID**.
- Adds an after-insert/update trigger so account address, display name and connection state follow the Intelligence account.
- Backfills existing Intelligence provider accounts without copying tokens/passwords.
- Adds disabled Inbox provider-catalogue rows for Gmail, Zoho and SMTP. All capability flags are false until a reviewed Inbox adapter/gateway is deployed.
- Disables the Resend Inbox catalogue row and legacy Inbox send flag while preserving the registry row as a historical/FK tombstone.
- Restricts Zoho's authoritative Intelligence message-purpose manifest and account purpose list to `business_correspondence`.
- Replaces the old Inbox account-upsert RPC with a fail-closed response directing users to Settings/Intelligence.

The migration is additive and forward-only. It does not delete email conversations, messages, attachments, account records or encrypted Intelligence credentials. It deliberately fails if the same organization/provider/address already exists under a different Inbox account UUID, because silently merging that account would risk breaking historical message foreign keys.

### Runtime and credential handling

- `supabase/functions/_shared/email_mailbox_store.ts`
  - Adds `loadSharedIntelligenceCredentials`.
  - Loads the exact same Intelligence account by account ID, organization ID and provider.
  - Decrypts the existing `credentials_ciphertext` with the existing Intelligence encryption format.
  - Fails closed on wrong identity, disconnected account or decryption failure.
  - Does not fall back to a second Inbox credential record for a linked Intelligence account.

- `supabase/functions/email-mailbox-sync/index.ts`
  - Uses `INTEL_TOKEN_ENCRYPTION_KEY` and the shared Intelligence credential loader instead of the independent Inbox credential vault for mailbox sync credentials.

- `intelligence-worker/kairflow_intel/providers/registry.py`
  - Zoho's worker manifest now allows only `business_correspondence`.

### Frontend

- `src/email/InboxModule.jsx`
  - Removes the Add Account control and independent setup modal.
  - When no mailbox accounts exist, directs users to Settings → Intelligence → Email accounts.
- `src/email/lib/api.js`
  - Removes the Inbox account-creation API wrapper.
- `src/email/components/SetupAccount.jsx`
  - Removed; the Inbox no longer has a separate connection component.

### Documentation and tests

- `docs/EMAIL_ADAPTER_ARCHITECTURE.md` updated with the shared-account boundary and current capability limitations.
- `src/email/phase6-frontend.test.mjs` updated to enforce the no-independent-account-creation UI.
- `supabase/functions/_shared/email_mailbox_store.test.mjs` adds shared-credential lookup and fail-closed decryption tests.
- `intelligence-worker/tests/test_provider_registry.py` asserts Zoho's manual-correspondence-only manifest.

## Exact changed-file inventory

**Added**
- `supabase/migrations/20261227110000_email_shared_intelligence_accounts.sql`
- `EMAIL_SHARED_ACCOUNT_CORRECTION_HANDOFF.md`

**Modified**
- `supabase/functions/_shared/email_mailbox_store.ts`
- `supabase/functions/_shared/email_mailbox_store.test.mjs`
- `supabase/functions/email-mailbox-sync/index.ts`
- `src/email/InboxModule.jsx`
- `src/email/lib/api.js`
- `src/email/phase6-frontend.test.mjs`
- `intelligence-worker/kairflow_intel/providers/registry.py`
- `intelligence-worker/tests/test_provider_registry.py`
- `docs/EMAIL_ADAPTER_ARCHITECTURE.md`

**Removed**
- `src/email/components/SetupAccount.jsx` (obsolete independent Inbox account-connection UI)

## Verification

| Check | Result |
|---|---|
| Node test suite (`npm test`) | 1,045 tests passed, 0 failed (full Node suite) |
| Focused mailbox store/sync tests | 16 passed, 0 failed |
| Intelligence worker provider registry tests | 8 passed |
| Vite production build | Not run: repository archive does not include `node_modules`; `vite` is unavailable |
| Full Python worker test discovery | Not clean: suite includes environment/production probes and package-relative import failures when invoked with plain `unittest discover -s tests`; this is not a clean full-suite pass |
| SQL migration execution | Not run: no connected Supabase/Postgres database in this environment |
| Live provider acceptance | Not run: no live OAuth accounts, SMTP credentials, worker deployment or production database |

Expected non-fatal console messages from webhook tests are simulated failure-path logs.

## Important remaining work — do not deploy as a completed provider integration

The following work is still required before Gmail, Zoho or SMTP can actually send/sync through the central Inbox:

1. **Authenticated provider gateway:** The repository has existing Python Intelligence adapters, but the central Inbox Edge Functions cannot directly import them. Implement a server-authenticated gateway from the Inbox Edge Functions to the existing Intelligence worker, with organization/account authorization and no browser-visible credentials.
2. **Gmail adapter bridge:** Implement and test send, message/thread retrieval, incremental history sync, pagination, attachments, read state and token refresh through the existing Intelligence Gmail implementation.
3. **Zoho adapter bridge:** Implement and test manual send/reply and mailbox sync through the existing Zoho implementation. Enforce `business_correspondence` at the gateway and final send boundary. Do not add campaign support.
4. **SMTP/IMAP:** The existing SMTP adapter sends only. Add a separately configured IMAP capability and secure worker implementation before advertising mailbox receive/sync. SMTP sending does not imply IMAP receiving.
5. **Campaign enforcement audit:** The Zoho DB purpose list and worker manifest are corrected, but the complete campaign selection, queue, retry and final-send paths still need integration tests proving Zoho cannot be selected, including manually approved campaigns.
6. **Account health reconciliation:** Project token refresh/revocation and worker health results back into the same Intelligence account status so Settings and Inbox show one consistent status.
7. **Live acceptance:** Test Gmail, SMTP+IMAP and Zoho with real test accounts, then verify cross-organization isolation, duplicate prevention, thread identity, outbound ingestion and Resend transactional regressions.

Until the gateway/adapters are implemented, Gmail/Zoho/SMTP appear as shared account identities but are deliberately disabled for Inbox send/sync. This is safer than advertising capabilities that are not present.

## Deployment notes

1. Review the new migration against the actual production schema, especially any organization/provider/address collisions detected by the preflight check.
2. Apply the migration only after the existing Intelligence account registry and Email Inbox migrations.
3. Ensure `INTEL_TOKEN_ENCRYPTION_KEY` is present in the mailbox-sync Edge Function environment and matches the key used by Intelligence account credential encryption.
4. Do not enable Gmail, Zoho or SMTP in `email_provider_registry` until the authenticated gateway and tested adapters exist.
5. Keep SMTP IMAP receive capability disabled until IMAP settings and worker support are implemented.
6. Verify Resend's unrelated transactional routes independently; this migration only disables the central Inbox registry and flag.

## Acceptance status

- Single Intelligence account identity and credential source: foundation implemented; live DB migration not yet applied.
- Inbox no longer offers a separate connection flow: implemented in frontend and RPC.
- Resend excluded from active Inbox selection/sending: disabled via DB registry/flag; historical registry row and parser code retained for referential integrity and legacy webhook parsing.
- Zoho outreach prohibited: provider manifest and DB purpose list restricted; full campaign E2E still required.
- Gmail/SMTP outreach and Zoho manual correspondence through central Inbox: **not yet complete** because the secure adapter gateway is not implemented.
- Gmail/Zoho mailbox sync through central Inbox: **not yet complete** for the same reason.
- SMTP IMAP receive: **not implemented** in the existing worker.

## Scope amendment — SMTP/IMAP deferred (2026-11-12)

The owner has deferred SMTP and IMAP from the current implementation cycle. Preserve existing SMTP-related code, settings, account data, credentials and migrations; do not delete or destructively alter them. SMTP/IMAP are not blockers or acceptance criteria for this cycle. Complete Gmail and Zoho instead. Zoho remains restricted to manual business correspondence only, enforced at every backend sending boundary. See `SCOPE_DECISION_2026-11-12_SMTP_DEFERRED.md` for the authoritative revised scope.
