# General Email: provider adapter layer (multi-provider plan, phase 3)

Applies to the general Email module (CRM > Inbox) only. KairFlow Intelligence has its own provider system and is not touched or reused.

## Files

| File | Role |
|---|---|
| `_shared/email_adapter.ts` | The contract: `EmailAdapter`, operation names, `AdapterError` / `CapabilityError` with normalised codes. Required operation: `send`. Everything else is an optional capability. |
| `_shared/email_adapter_resend.ts` | The Resend adapter. Resend code **moved verbatim** from `email_resend_logic.ts`: `sendViaResend`, `buildResendPayload`, Svix verification, received-email normalisation. The only new code is the `resendAdapter` object. The only file that names `api.resend.com`. |
| `_shared/email_adapter_registry.ts` | `resolveAdapter(accountProvider, registryRow)`: picks and validates the adapter. Pure. |
| `_shared/email_common.ts` | Provider-neutral pure helpers (addresses, subjects, thread headers, file names, `providerEventId`), moved verbatim. |
| `_shared/email_resend_logic.ts` | Shared service (validation, limits, idempotency, threading, persistence, error normalisation, audit). Keeps its name; re-exports every name it used to export. |
| `_shared/email_resend_store.ts` | Supabase store. No hardcoded provider: the provider comes from the account row or the adapter. |

## How a send is routed

1. Authenticate (admin + active Master User, unchanged) and validate the body. A `provider` field in the body is ignored.
2. Read the account row from the database, scoped to the caller's organization. Its `provider` column is the only input to selection.
3. Read that provider's row from `email_provider_registry`. Refuse with a normalised code if there is none (`provider_not_registered`, 409), it is disabled (`provider_disabled`, 503), or the row names an adapter this deployment does not contain (`adapter_unavailable`, 503).
4. `adapter.configurationProblem(env)` (Resend: `RESEND_API_KEY` present), then the legacy shared kill switch `email_provider_flags` if the adapter declares one (Resend does).
5. Limits: 20 emails/minute per organization (all providers); daily quota per provider (Resend: 100, `EMAIL_DAILY_LIMIT`).
6. Idempotent outbound row, then `adapter.send(...)`. Outcome handling is unchanged: unknown outcome is never auto-resent; 4xx is `rejected`; 429/5xx is `failed`.

A provider is usable only if **both** the registry row is enabled **and** its legacy flag (if any) is on. Either switch alone turns it off. Connecting an account never enables anything.

## Capabilities

`effectiveOperations` = what the adapter implements AND what the registry row declares `true`. The registry can narrow code, never widen it. A declared operation without a real function is treated as unsupported. Unsupported operations throw `CapabilityError` (`unsupported_operation`, 501).

Resend implements `send`, `reply`, `forward` (sends with threading headers). It has no folders, sync, search, remote drafts, read or archive state; those answer `CapabilityError`.

## Adding a provider (checklist)

1. Write `_shared/email_adapter_<provider>.ts` implementing `EmailAdapter` (its own credentials, never `intel_*`).
2. Add it to `BUILTIN_ADAPTERS`.
3. Insert its row in `email_provider_registry` by a reviewed migration, with honest capabilities.
4. Store event ids as `providerEventId("<key>", id)` (prefixed).
5. No change to the shared service, conversation model or Inbox UI.

## Event ids

`email_events.provider_event_id` is still globally unique. Resend keeps its bare Svix id (already stored that way; prefixing now would break duplicate detection for earlier events). Every later provider is prefixed `<provider_key>:`.

## Not in this phase

Folder sync, remote search, draft sync, read/archive, OAuth and connection state are Phases 4 and 5. No browser endpoint for those exists yet, so no operation other than `send` is reachable.

## Phase 4B addendum (sending dispatch)
The send path now re-checks sender ownership, refuses paused senders with `account_not_usable`, verifies an optional CRM lead for the caller, and answers in one normalised shape. See `EMAIL_SEND_DISPATCH_4B.md`. The adapter contract itself is unchanged.
