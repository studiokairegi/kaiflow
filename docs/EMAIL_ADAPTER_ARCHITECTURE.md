# KairFlow Email / Intelligence — shared mailbox architecture

## Governing rule

Settings / Intelligence is the single source of truth for mailbox connections, account identity, authentication and credentials. Users connect Gmail, Zoho or SMTP once in Settings. The central Inbox reuses that account; it must not start another OAuth flow, collect another password or create a second mailbox identity.

The Inbox's existing relational model is retained for message-history compatibility. A row in `public.email_accounts` for a shared Intelligence mailbox uses the **same UUID** as `public.intel_provider_accounts.id` and carries `source_provider_account_id` back to that row. It is a non-secret compatibility projection, not a second credential/account source.

## Account and credential ownership

- `public.intel_provider_accounts` owns provider account identity, organization ownership, status and account-level policy.
- `credentials_ciphertext` in `intel_provider_accounts` remains the sole encrypted credential store for Gmail OAuth, Zoho OAuth and SMTP passwords.
- The Inbox must not create corresponding rows in `email_provider_credentials` for shared Intelligence accounts.
- `loadSharedIntelligenceCredentials` reads the Intelligence account by the exact same account UUID, organization UUID and provider key, and decrypts with the existing `INTEL_TOKEN_ENCRYPTION_KEY` format.
- Decryption and provider calls happen only in trusted server/worker code. Tokens/passwords must never reach browser responses or logs.
- `email_accounts` mirrors only mailbox address, display name, connection status and the same account UUID. Its sync checkpoint/lease tables are Inbox operational state, not a second credential source.
- `email_upsert_account` is revoked and fails closed. The Inbox has no Add Account UI. A disconnected/expired account must be fixed in Settings / Intelligence.

## Provider responsibilities

| Provider | Manual correspondence | Automated outreach | Receive/sync |
|---|---|---|---|
| Gmail | Allowed | Allowed | Existing Intelligence Gmail implementation supports receive/sync; central Inbox gateway remains to be completed |
| SMTP | Allowed | Allowed | Existing Intelligence SMTP adapter is submission-only; IMAP is not implemented |
| Zoho | Allowed | Prohibited | Existing Intelligence Zoho receive implementation exists; central Inbox gateway remains to be completed |
| Resend | Excluded from Inbox | Prohibited | Excluded from Inbox |

Zoho's `intel_email_provider_registry.manifest.message_purposes` and every Zoho account's `allowed_message_purposes` are restricted to `business_correspondence`. The Python worker provider manifest has the same restriction. This is a backend rule, not a frontend-only filter.

Gmail and SMTP remain eligible for outreach under the existing Intelligence policy. Resend remains available only through unrelated transactional services that use their separate routes; the Inbox registry row and Inbox legacy send flag are disabled.

## Adapter and gateway boundary

The neutral Inbox adapter contract remains in `_shared/email_adapter.ts`. The registry in `_shared/email_adapter_registry.ts` validates both the compiled adapter and the database capability row. A database row cannot claim a capability that code does not implement.

The existing Python Intelligence worker contains account-scoped Gmail, Zoho and SMTP adapters. The central Inbox Edge Functions are TypeScript/Deno and cannot safely import those Python classes. A reviewed, authenticated service gateway is therefore required to bridge Inbox operations to the existing worker. The gateway must:
- authenticate service-to-service calls;
- re-check user, organization, provider and account ownership;
- accept only the same `intel_provider_accounts.id`;
- apply provider-purpose restrictions on the server;
- keep credentials and access tokens inside trusted services;
- return normalized message/send outcomes, never credentials.

Until that gateway and reviewed TypeScript adapter wrappers are deployed, the Gmail, Zoho and SMTP rows in `email_provider_registry` are intentionally disabled and their capabilities are all false. This is deliberate fail-closed behavior; the Inbox may discover the account identity but must not claim send or sync is available.

## SMTP versus IMAP

SMTP submission and IMAP receiving are distinct protocols. The existing worker's `SMTPClient` sends mail; its manifest explicitly has no receive capability. Do not enable `remote_sync` or represent SMTP mailbox receiving as implemented until a separately configured IMAP client/worker, credential validation, synchronization and tests exist.

## Inbox send and synchronization

The existing Inbox message/conversation schema and synchronization persistence remain usable:
- normalized provider messages;
- provider thread IDs stored separately from internal conversation IDs;
- RFC Message-ID / In-Reply-To / References matching;
- idempotent inbound/outbound ingestion;
- pagination and checkpoint persistence;
- lease renewal and retry handling;
- attachment metadata;
- read/folder/deletion state reconciliation.

Those persistence capabilities do not by themselves mean a provider can synchronize. The adapter must implement the operation, and the database registry must explicitly enable it. Until the authenticated gateway is complete, provider sync remains disabled.

## Resend exclusion

The Resend row is retained as a disabled tombstone because historical Inbox rows/messages and provider foreign keys may reference it. Its capabilities are false and its legacy Inbox flag is off. This prevents live selection/sending while preserving old records. The compiled Resend adapter helper remains for legacy webhook parsing/regression compatibility; it is not an enabled mailbox provider. The separate Intelligence transactional Resend routes are not changed.

## Migration

`supabase/migrations/20261227110000_email_shared_intelligence_accounts.sql`:
- creates the same-UUID account projection and trigger;
- backfills identity/status only, never credentials;
- inserts disabled Gmail/Zoho/SMTP Inbox registry rows;
- disables Inbox Resend;
- applies the Zoho manual-only purpose rule;
- disables the old Inbox account-creation RPC.

The migration is forward-only and preserves existing messages and credentials. It fails if the same organization/provider/address already exists under a different Inbox account UUID, requiring explicit reconciliation rather than silently reassigning history.

## Required next implementation phase

1. Build and deploy the authenticated worker gateway.
2. Add Gmail Inbox adapter wrappers for send, thread/message retrieval, incremental sync, attachments and read state.
3. Add Zoho manual-only adapter wrappers for send/reply and mailbox sync.
4. Add separately configured IMAP support to SMTP accounts and worker, then expose only tested capabilities.
5. Add end-to-end campaign tests proving Zoho is rejected from every automated sequence, queue, retry and final-send path.
6. Reconcile token refresh/revocation and health state between Intelligence and Inbox.
7. Run live provider acceptance and cross-organization isolation tests before enabling registry capabilities.
