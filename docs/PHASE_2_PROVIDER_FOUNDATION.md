# Phase 2 — Dynamic provider foundation (increment 2.1–2.3)

## Scope delivered in this increment

This increment establishes the code-installed adapter registry, a multi-account Supabase model, and account-scoped Gmail OAuth/token plumbing. It deliberately does not build the provider-management UI, account-selection dispatcher, quota enforcement, SMTP, or Zoho multi-account OAuth. Those remain later Phase 2 increments.

### Adapter model

- `intelligence-worker/kairflow_intel/providers/base.py` defines `ProviderManifest`, `ProviderRegistry`, and registration errors.
- `providers/registry.py` exports the registry API.
- `providers/gmail.py` constructs the same `GmailClient` implementation for any account UUID.
- `providers/zoho.py` now constructs the existing Zoho REST client with the account-scoped token provider; the original singleton bridge remains available through the legacy functions during migration.
- Provider metadata is descriptive. Database rows cannot upload or execute adapter code.
- Resend is intentionally not registered in the prospect communication registry. Its existing transactional/Inbox integration is left intact for a later, separate route.

### Account storage

Migration `20261124090000_intelligence_provider_registry_accounts.sql` adds. Its timestamp is intentionally later than the repository snapshot’s latest migration (`20261123100000`); reconcile the actual hosted migration history before applying it, especially because this snapshot contains future-dated migration filenames relative to the current audit date:

- `intel_email_provider_registry`: installed provider catalogue metadata.
- `intel_provider_accounts`: one row per connected mailbox, including encrypted credentials, auth method, provider identity, health, activation, allowed purposes, independent limits, and synchronization cursor.
- `intel_provider_oauth_states`: short-lived, single-use OAuth state per connection attempt.
- `intel_messages.provider_account_id`, `provider_key`, and `provider_message_id` for future send-attempt/account attribution.

The migration copies existing connected Gmail/Zoho singleton records into account rows without deleting or modifying the legacy records. Existing encrypted refresh-token ciphertext is copied unchanged. The token endpoint accepts both the legacy raw-token ciphertext format and the new JSON credential envelope during this transition.

All credential-bearing tables have RLS enabled and no client grants. Admin/worker RPCs return safe metadata only; ciphertext and refresh tokens are never returned.

New Gmail account rows default to `is_enabled=false` and `send_enabled=false`. The provider catalogue also has an independent `sending_enabled=false` gate. Connecting an account does not activate sending. Existing Gmail/Zoho/Resend legacy pause flags retain their current behavior; the new token route additionally requires the dynamic registry sending gate.

### Gmail OAuth and worker token flow

New Edge Functions:

- `intel-provider-connect`: authenticated admin starts an account connection.
- `intel-provider-callback`: verifies the single-use state, rechecks the initiating user's authorization, exchanges OAuth code, verifies mailbox identity and creates/updates that mailbox's own account row.
- `intel-provider-token`: worker-agent-only, account-scoped token refresh. It requires a connected, enabled, send-enabled account and returns only a short-lived access token.

The worker uses `KAIRFLOW_MAIL_PROVIDER=gmail` plus `KAIRFLOW_MAIL_ACCOUNT_ID=<uuid>` to instantiate the same Gmail adapter against the selected account. The worker does not receive refresh tokens or provider client secrets.

## Important staged limitations

- Account selection is explicit by worker configuration in this increment. Dynamic per-message account dispatch, persistent account assignment, provider/account quota reservation and failover rules belong to increment 2.5.
- The new Gmail OAuth flow stores accounts but does not enable them for sending. Activation and UI controls belong to increment 2.4/2.5 after policy checks are complete.
- Phase 2.7 now adds account-scoped Zoho OAuth/token support using the same provider-neutral Edge Functions. Existing legacy Zoho endpoints remain for backwards compatibility.
- SMTP/IMAP is not added here; the SMTP foundation is increment 2.6.
- Gmail's manifest allows business correspondence and consented prospecting as adapter capabilities, but new accounts default to `business_correspondence` only. No account may be used for unsolicited or prohibited traffic. Message-purpose enforcement is completed in the dispatcher increment.
- Resend is not a prospect adapter and cannot be selected by this worker registry.

## Configuration

Safe default remains:

```dotenv
KAIRFLOW_MAIL_PROVIDER=none
KAIRFLOW_MAIL_ACCOUNT_ID=
```

For a specifically enabled Gmail account after the account-management/activation controls are deployed:

```dotenv
KAIRFLOW_MAIL_PROVIDER=gmail
KAIRFLOW_MAIL_ACCOUNT_ID=<connected-account-uuid>
```

Do not activate a new account until the dispatcher, provider policy gate, global cap, account/provider limits, kill-switch checks, and send-attempt reconciliation are all in place.

## Deployment order

1. Review and reconcile the repository's migration history against the actual hosted Supabase migration history.
2. Configure existing Google OAuth secrets and redirect URI for the new generic callback route; do not rotate or replace existing secrets as part of this migration.
3. Apply the migration through the project's normal reviewed migration process.
4. Deploy the three `intel-provider-*` Edge Functions, with callback JWT verification disabled only because the OAuth provider redirect has no Supabase JWT; callback trust is the single-use state plus authorization recheck.
5. Do not enable account sending. Frontend connection controls and dispatch/limits are not yet complete.

No migration was applied, no Edge Function was deployed, no account was connected, no environment variable was changed, and no email was sent as part of this local implementation.

## Phase 2.4 account management UI (implemented in the follow-on patch)

The Intelligence Settings page now includes a provider-account inventory backed by the safe catalogue/account RPCs. It can initiate another Gmail OAuth connection, list each mailbox independently, pause/resume account sync, and disconnect one account without affecting the others. Account management does not expose credentials and does not provide a send-enable control. Gmail and Zoho are offered for additional OAuth connections; SMTP is available through its dedicated account-credential flow. Zoho connections retain their selected data center and remain disabled for sending until explicitly activated under policy.

A separate additive migration adds administrator-scoped account pause/disconnect RPCs. Disconnect clears that account's encrypted credential payload and leaves other accounts untouched.

## Phase 2.5 status

Multi-account message routing, durable account assignment, purpose/consent enforcement at dispatch, and atomic per-account minute/hour/day quotas are **not yet implemented**. The account schema contains purpose and quota fields, but these are not enforcement by themselves. Do not enable provider-level or account-level sending for the new registry until the dispatcher and its database reservation path are completed and tested. Existing legacy mail routes continue to use their existing kill switch, global caps, approval rules, and provider flags.


## Phase 2.7 Zoho adapter

See [PHASE_2_7_ZOHO_MULTI_ACCOUNT.md](PHASE_2_7_ZOHO_MULTI_ACCOUNT.md) for the account-scoped OAuth/token flow, migration, deployment checklist and remaining live-validation requirements.
