# KairFlow Email — Phase 5 Implementation Notes

## Provider responsibility model

- **Zoho Mail:** manual business conversations, client inbox, replies, drafts and attachments.
- **Gmail:** outreach account sending and response monitoring.
- **Microsoft 365 / Outlook:** outreach account sending and response monitoring.
- **Generic IMAP/SMTP:** outreach accounts on compatible hosts. IMAP/SMTP transport must execute in a TCP-capable worker; it must not be implemented as a fake HTTPS adapter inside Supabase Edge Functions.
- **Resend:** preserve the existing Resend adapter and transactional notification path independently from connected mailbox providers.

## Implemented in this source update

1. Extended the adapter contract with normalized sync page/message types and optional methods for fetch-message, upload-attachment and move operations.
2. Added a provider-neutral mailbox sync coordinator. It bounds each run to eight pages, deduplicates duplicate provider IDs inside a page, persists each normalized message before advancing that page's checkpoint, and leaves the checkpoint unchanged when message persistence fails.
3. Added an independent AES-256-GCM token envelope helper. Credential ciphertext is authenticated with account/provider binding as additional authenticated data, preventing a credential envelope from being copied to another account/provider.
4. Added a service-role-only mailbox store for credential envelopes and sync lease/checkpoint RPCs. It imports inbound messages through the existing account/provider-scoped RPC and already-sent outbound messages through a new persistence-only RPC.
5. Added an additive SQL migration for general Email's encrypted credential envelope table, single-use OAuth state table with an atomic consume RPC, connection lifecycle metadata, provider thread identity, sync lease fields, sync run audit table, and service-role-only sync RPCs.
6. Added automated tests for checkpoint ordering, persistence failure behavior, duplicate IDs, capability refusal, credential encryption, wrong-key rejection, account binding, credential persistence and sync RPC dispatch.

## Deliberately not enabled

No Zoho, Gmail, Microsoft or generic IMAP/SMTP adapter is registered or enabled by this change. The Phase 4F code has only the Resend adapter in `BUILTIN_ADAPTERS`; advertising provider capabilities before the corresponding OAuth/token refresh/API implementation is complete would be misleading and unsafe.

## Required next implementation work before real provider use

- Provider-specific OAuth authorization/callback and refresh-token rotation for Zoho, Google and Microsoft, using `email_oauth_states` and `email_provider_credentials` only.
- Provider API adapters and normalized MIME parsing for Zoho Mail, Gmail API and Microsoft Graph.
- A TCP-capable, independently authenticated worker for generic IMAP/SMTP, with credential retrieval restricted to a narrow job interface.
- Provider-specific pagination/history cursor implementations and live integration tests using dedicated test mailboxes.
- Attachment binary download/upload adapters, remote draft/reply/thread behavior and remote read/archive/move behavior.
- A mailbox operation Edge Function and UI wiring after the adapters are actually present.

## Migration safety

`20261214100000_email_mailbox_phase5_foundation.sql` is additive. It does not remove or alter `intel_*` objects, transactional Resend configuration, existing messages, conversations or provider registry rows. It has not been applied to a hosted database.
