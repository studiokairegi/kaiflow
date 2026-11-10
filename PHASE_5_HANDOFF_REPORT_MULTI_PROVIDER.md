# KairFlow Email — Phase 5 Handoff Report

**Baseline:** `KairFlow_MultiProvider_Phase4F_Corrected.zip` (Phase 4F)

**Delivery status:** Phase 5 foundation implemented and source-tested. **Not a production-ready multi-provider release.** The provider-specific live adapters and their OAuth/API flows are not yet implemented; they have intentionally not been registered or enabled.

## 1. Product and provider responsibilities

| Provider | KairFlow responsibility | Execution boundary |
|---|---|---|
| Zoho Mail | Manual business conversations, client inbox, replies, drafts and attachments | Zoho Mail HTTPS API adapter |
| Gmail | Outreach account sending and response monitoring | Gmail API HTTPS adapter |
| Microsoft 365 / Outlook | Outreach account sending and response monitoring | Microsoft Graph HTTPS adapter |
| Generic IMAP/SMTP | Outreach accounts on compatible hosts | Dedicated TCP-capable worker; not Supabase Edge Function fetch |
| Resend | Existing general Email send path where already used, plus existing transactional notification infrastructure | Existing Resend adapter and independent transactional path |

The shared Email model remains provider-neutral. Provider capability declarations must only be enabled after a real adapter implements and tests the corresponding operation.

## 2. Phase 4F findings confirmed

- `email_adapter.ts`, `email_adapter_registry.ts` and `email_adapter_resend.ts` are retained.
- `BUILTIN_ADAPTERS` still contains only Resend.
- The existing registry is deliberately seeded with Resend only.
- The second-provider dispatch coverage in Phase 4F is a fake/test adapter, not a live mailbox provider.
- The general Email database has provider-scoped accounts/messages and existing inbound ingestion, but Phase 4F did not deliver independent general Email OAuth/token storage or remote mailbox synchronization.
- The existing Intelligence Gmail/Zoho implementations are separate and were not reused.

## 3. Files added

### Runtime modules

- `supabase/functions/_shared/email_token_vault.ts`
  - AES-256-GCM credential envelope encryption/decryption.
  - Random 96-bit nonce and 128-bit authentication tag.
  - Account/organization/provider binding as AES-GCM additional authenticated data.
  - Strict 32-byte base64 key validation.

- `supabase/functions/_shared/email_mailbox_sync.ts`
  - Provider-neutral bounded synchronization coordinator.
  - Eight-page maximum per run.
  - Per-account lease acquisition.
  - Duplicate provider message ID suppression within each page.
  - Message persistence before checkpoint advancement.
  - Does not advance a page checkpoint after a persistence failure.
  - Releases the lease on successful completion; failure path records a safe error and retry time.

- `supabase/functions/_shared/email_mailbox_store.ts`
  - Service-role persistence adapter for the new credential and sync schema.
  - Loads/saves/deletes general Email credential envelopes.
  - Uses the database sync lease/checkpoint RPCs.
  - Imports inbound messages through the existing account/provider-scoped `email_ingest_inbound` RPC.
  - Imports already-sent outbound messages through a new persistence-only RPC; this path cannot send mail.
  - Resolves provider thread identity independently from RFC Message-ID and falls back to RFC `In-Reply-To`/`References` matching.
  - Persists attachment metadata; binary attachment fetch/upload remains provider-adapter work.

### Database

- `supabase/migrations/20261214100000_email_mailbox_phase5_foundation.sql`
  - Adds general Email connection lifecycle fields to `email_accounts`.
  - Adds service-role-only `email_provider_credentials` encrypted envelope storage.
  - Adds service-role-only single-use OAuth state storage (`email_oauth_states`) and an atomic consume RPC; state hashes are stored, and PKCE verifier fields are reserved for encrypted values.
  - Extends `email_sync_state` with lease, retry and health fields.
  - Adds service-role-only `email_sync_runs` audit storage.
  - Adds sync lease claim/checkpoint/finish/failure RPCs.
  - Adds account-scoped provider thread identity and an atomic get-or-create thread RPC.
  - Adds `email_ingest_synced_outbound`, a persistence-only import RPC with per-account deduplication.
  - Uses additive schema changes; no existing email messages/conversations are deleted or rewritten.

## 4. Files modified

- `supabase/functions/_shared/email_adapter.ts`
  - Formalized normalized adapter sync message/page contracts.
  - Added a server-only credential resolver hook to adapter context.
  - Added optional method slots for full message retrieval, attachment upload and move operations.
  - Kept existing Resend required send behavior and existing operation capability checks.

- `src/email/provider-foundation.test.mjs`
  - Added Phase 5 migration ordering and static security/foundation assertions.

- `src/intelligence/v1-completion.test.mjs`
  - Updated migration-order classification so the new general Email migration is not mistaken for an Intelligence migration.

- `supabase/tests/run_intelligence_auth.sh`
  - Added Phase 5 migration and SQL test to the existing PostgreSQL integration runner.

- `docs/EMAIL_PHASE_5_IMPLEMENTATION_NOTES.md`
  - Added provider responsibility and implementation notes.

## 5. Tests added

- `supabase/functions/_shared/email_mailbox_sync.test.mjs`
  - Page checkpoint ordering.
  - Persistence failure does not advance checkpoint.
  - Capability refusal.
  - Duplicate IDs within a page.

- `supabase/functions/_shared/email_token_vault.test.mjs`
  - AES-GCM round trip.
  - Cross-account/provider binding rejection.
  - Wrong-key rejection.
  - Invalid key-length rejection.

- `supabase/functions/_shared/email_mailbox_store.test.mjs`
  - Encrypted credential persistence and scoped decryption.
  - Sync lease/checkpoint RPC dispatch.

- `supabase/tests/email_phase5_foundation.test.sql`
  - PostgreSQL assertions for RLS/privileges, credential ownership, lease exclusivity, checkpoint resume, provider thread identity, outbound sync import and duplicate suppression.

## 6. Verification results

- Full repository `npm test`: **954 passed, 0 failed, 0 skipped** after the Phase 5 additions.
- Shell syntax validation for `supabase/tests/run_intelligence_auth.sh`: passed.
- The new token-vault, sync coordinator and mailbox store modules were loaded by Node's test runner and their tests passed.
- PostgreSQL migration and SQL integration test: **not executed** (`psql` unavailable in this environment).
- Deno Edge Function type/runtime validation: **not executed** (`deno` unavailable).
- Frontend production build: **not executed** (`node_modules` are not installed in the supplied repository).
- Live Zoho, Gmail, Microsoft Graph, IMAP/SMTP and Resend provider tests: **not executed**.
- Hosted Supabase migration/deployment: **not performed**.

## 7. What is not complete — do not treat as production-enabled

The following are required before the requested provider workflows can be used:

1. Implement and register the Zoho Mail adapter, including Zoho OAuth, data-center selection, token refresh, folder/message APIs, reply/draft behavior and attachments.
2. Implement and register the Gmail adapter, including OAuth scopes, refresh-token handling, history/list pagination, MIME parsing, send and response monitoring.
3. Implement and register the Microsoft Graph adapter, including tenant/delegated OAuth handling, delta or equivalent incremental synchronization, MIME/attachment handling and send operations.
4. Implement a separate TCP-capable IMAP/SMTP worker, its authenticated job boundary, credential retrieval contract, mailbox sync and outbound-send safeguards. No raw IMAP/SMTP sockets should be attempted from Supabase Edge Functions.
5. Add provider-specific token refresh and OAuth callback handlers using only `email_oauth_states` and `email_provider_credentials`.
6. Add the mailbox operation Edge Function and wire the existing unified Inbox/composer UI to actual remote operations.
7. Add remote attachment download/upload, draft update, reply/forward, read/unread, archive/move and provider-specific search implementations.
8. Run PostgreSQL 16 migration tests, Deno type checks, production build and controlled live mailbox smoke tests before enabling any provider.

No Gmail, Zoho, Microsoft or generic IMAP/SMTP registry rows were inserted. No provider was enabled. This is intentional: a provider choice without a real, secure adapter would be a fake production capability.

## 8. Security and compatibility

- The existing Resend adapter and transactional Resend path were not rewritten.
- No application notification was redirected through a user mailbox.
- No `intel_*` table, credential, OAuth callback, token endpoint, kill switch or worker RPC was reused or modified.
- New credentials are ciphertext only in Postgres and are bound to the account/provider tuple during AES-GCM encryption.
- New credential/OAuth/sync audit tables revoke browser roles and have RLS enabled.
- Sync RPCs are executable by `service_role` only.
- No production secrets, OAuth client IDs, refresh tokens or encryption keys were added to the repository.

## 9. Deployment and next-step instructions

**Do not deploy this as a completed Phase 5 provider release.** The migration is additive but remains unexecuted here.

Before applying it:

1. Confirm the hosted database has all Phase 4F migrations through `20261213100000_email_accepted_send_reconciliation.sql` applied in order.
2. Review `20261214100000_email_mailbox_phase5_foundation.sql` against the actual hosted schema and PostgreSQL 16.
3. Run the updated `supabase/tests/run_intelligence_auth.sh` against a disposable PostgreSQL 16 database.
4. Only after the SQL suite passes, apply the migration to a controlled staging database.
5. Configure `EMAIL_TOKEN_ENCRYPTION_KEY` as a 32-byte base64 Edge Function secret before any OAuth credential storage is enabled. Do not put it in `.env.example` with a real value or in client configuration.
6. Implement and test provider OAuth/adapter endpoints before adding provider registry rows or enabling account connection.

### Rollback

The migration header contains the rollback outline. Rollback is safe only before any real provider account is connected or any credential envelope/OAuth state is stored. Drop the new service-only tables/RPCs and remove only the added columns/indexes; do not drop or rewrite existing messages, conversations, provider registry data or Intelligence objects.

## 10. Release decision

**Phase 5 foundation: source implementation complete; automated JavaScript tests pass.**

**Phase 5 provider integration: incomplete and not production-approved.** The next implementation slice should be the independent OAuth connection flow plus the Zoho adapter first (manual business inbox), followed by Gmail and Microsoft Graph outreach adapters, then the TCP worker for generic IMAP/SMTP.
