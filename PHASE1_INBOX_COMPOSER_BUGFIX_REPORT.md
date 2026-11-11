# Phase 1 â€” Inbox composer, send and CRM corrective fixes

**Source snapshot:** `00_repo_35_phase7-final.zip` (Phase 7 repository snapshot)
**Scope:** Existing Inbox composer, outbound send/idempotency path, CRM attribution and recovery.
**Mode:** Corrective implementation; existing unrelated phases and data contracts were preserved.

## Implemented fixes

1. **Composer recovery after `idempotency_conflict`** â€” the client now rotates its request key when the server explicitly reports a fingerprint conflict. Ambiguous/network outcomes still retain the original key.
2. **CRM attribution on saved drafts** â€” the composer passes `crmLeadId` to draft persistence; the database stores it on the draft and conversation; draft editing restores it; sending the draft retains it. The old nine-argument RPC remains available as a compatibility wrapper.
3. **Recoverable queued sends** â€” a service-only `email_claim_outbound` RPC atomically claims a `queued` row. A retry with the same key can resume a row that was persisted but never claimed; only one concurrent caller can transition it to `sending`.
4. **Shared lead-linked conversation replies** â€” a colleague can reply in an organization-shared thread without being granted write access to another user's lead. Such a reply does not claim CRM attribution; the conversation's existing lead link remains intact.
5. **Idempotency before rate limits** â€” quota checks now run inside `email_create_outbound`, after the idempotency lookup and before inserting/updating an outbound row. An organization advisory lock serializes quota checks. Duplicate CRM-repair retries are therefore not blocked by quota, and a rate-limited attempt leaves no queued row behind.
6. **HTML expansion** â€” quotation marks are no longer unnecessarily encoded in HTML text nodes. The request validator and SQL persistence cap now allow 1.1 MB of HTML for a 200,000-character plain-text body with entity expansion.
7. **Default sender selection** â€” a new composer prefers the first account currently allowed to send rather than blindly selecting the organization's default account. Explicit sender selections for drafts/threads remain unchanged.
8. **CRM recovery fairness** â€” recovery records attempt count and last-attempt time, prioritizes never-tried rows, skips locked rows, and stops retrying a permanently failing record after ten attempts.
9. **Stable retry fingerprint** â€” dynamic `In-Reply-To` and `References` headers are excluded from the immutable content fingerprint so a newly arrived reply cannot invalidate a retry of the same message.

## Database migration and regression coverage

Added:

- `supabase/migrations/20261222100000_email_composer_send_crm_fixes.sql`
- `supabase/tests/email_composer_send_crm_fixes.test.sql`

The migration is additive and re-runnable. It does not delete messages, drafts, CRM activities, accounts, or provider credentials. It retains the legacy draft RPC signature and grants the queued-claim/recovery functions only to `service_role`.

The SQL integration runner now applies the corrective migration twice and runs the new database regression test:

- `supabase/tests/run_intelligence_auth.sh`

## Verification

| Check | Result |
|---|---:|
| Full repository `npm test` | **1019 passed, 0 failed** |
| Inbox email test suite | **231 passed, 0 failed** |
| `git diff --check` | Passed |
| `bash -n supabase/tests/run_intelligence_auth.sh` | Passed |

### Not verified in this environment

- The PostgreSQL/Supabase SQL integration suite was not executed: neither `psql` nor the Supabase CLI is installed in this runtime. The SQL migration and database regression test are included for execution in the project's database test environment.
- `npm run build` was attempted but could not start because the snapshot has no installed `vite` executable (`vite: not found`). No dependency installation was performed.
- No live Supabase database, provider account, or outbound email was contacted.

## Deployment

Apply `20261222100000_email_composer_send_crm_fixes.sql` to the target Supabase database before deploying the updated application and `email-send` Edge Function. Then run `supabase/tests/run_intelligence_auth.sh` in the configured PostgreSQL test environment and run the normal frontend build with project dependencies installed.
