# General Email: provider-neutral database foundation (multi-provider plan, phase 2)

Applies to the general Email module (CRM > Inbox) only. KairFlow Intelligence keeps its own provider tables, flags and OAuth, and is not touched.

## Objects

| Object | Purpose |
|---|---|
| `email_provider_registry` | The one list of mailbox providers: `provider_key`, `adapter_key`, `display_name`, explicit `capabilities`, `enabled`. Seeded with `resend` only. Read-only to clients (admin + active Master User). |
| `email_accounts.provider` / `email_messages.provider` | Reference the registry. A message's provider is its account's provider (filled by trigger, refused if it disagrees, enforced by a composite foreign key). Neither can be changed by UPDATE. |
| `email_accounts_provider_address_uidx` | One account per (organization, provider, address). The same address may exist under two providers. |
| `email_messages_account_provider_uidx`, `email_messages_account_rfc_uidx` | Deduplication per account: provider ids and RFC ids are not assumed unique across mailboxes or providers. |
| `email_upsert_account(address, name, provider default 'resend')` | Provider is checked against the registry on the server. |
| `email_save_draft`, `email_create_outbound` | Refuse a draft or conversation that belongs to another sender account. |
| `email_provider_flags_get()` | Now answered from the registry (Resend only). The `email_provider_flags` table itself is Intelligence's and is unchanged. |

## Rules for adapters (phase 3 must follow these)

1. Add a provider by inserting a registry row **after** its adapter exists. Connecting an account never flips `enabled`.
2. Store provider event ids with the provider key as a prefix (for example `gmail:...`). `email_events.provider_event_id` keeps a global unique index in this phase.
3. Inbound ingest passes `provider` in its payload; the account's provider must match it (default `resend`).
4. Select the adapter from the account row in the database, never from a browser-supplied provider name.

## Deliberately unchanged

`email_provider_flags`, `email_provider_enabled()`, `_shared/provider_guard.ts`, `email_apply_delivery_event`, `email_webhook_claim`, the delivery-event replay trigger, `intel_agent_email_save_draft`, and every `intel_*` object. Since phase 3 the send gate is the registry row's `enabled` AND, for Resend, `email_provider_enabled('resend')` (see `docs/EMAIL_ADAPTER_ARCHITECTURE.md`). Either one off blocks sending.
