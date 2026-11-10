# Phase 2.7 — Account-scoped Zoho Mail adapter

## Delivered locally

- Promoted Zoho in the installed provider registry to `supports_multiple_accounts=true` and `account_selection_required=true`.
- Added Zoho to the provider-neutral OAuth adapter set used by `intel-provider-connect`, `intel-provider-callback`, and `intel-provider-token`.
- The administrator chooses the Zoho data center (`com`, `eu`, `in`, `com.au`, `jp`, `ca`, `sa`, or `com.cn`) when starting each connection. The data center is stored in short-lived OAuth state and in the encrypted credential envelope/account metadata.
- Callback exchanges the authorization code at that data center, identifies the mailbox/account through the Zoho Mail Accounts API, and upserts a separate `intel_provider_accounts` row keyed by organization/provider/mailbox.
- Worker token refresh is account-ID scoped. The refresh token stays encrypted server-side; the worker receives only a short-lived access token, Zoho API base, account ID and mailbox.
- `providers/zoho.py` now constructs the existing `ZohoClient` against `ProviderAccountTokenProvider`, preserving its send, read, reply-threading and Sent-folder reconciliation behavior without duplicating Zoho REST logic.
- Intelligence Settings now offers Zoho alongside Gmail and SMTP for additional account connections and per-account inventory/controls.
- Additive migration `20261125110000_intelligence_zoho_multi_account.sql` updates the Zoho manifest and fills missing data-center/scope metadata on migrated Zoho account rows. Existing legacy Zoho records and legacy endpoints are not deleted or rewritten.

## Safety and limitations

- Newly connected Zoho accounts start with `is_enabled=false` and `send_enabled=false`; the provider-wide `sending_enabled` gate remains false in this migration.
- Zoho's only permitted purpose in the manifest is `business_correspondence`; no consented-prospecting purpose is granted by this adapter.
- The old `intel-zoho-*` singleton functions have been removed. The new dynamic worker uses the `intel-provider-*` account-scoped path when configured with `KAIRFLOW_MAIL_PROVIDER=zoho` and `KAIRFLOW_MAIL_ACCOUNT_ID=<account uuid>`.
- Zoho REST API response shapes and OAuth grants have not been exercised against a live Zoho tenant. The existing Zoho REST client documentation continues to mark live API compatibility as unverified. Verify the chosen data center and required plan/API access before activating any mailbox.
- No automatic fallback between mailboxes is introduced. Message/account assignment remains durable through the Phase 2.5 dispatch layer.

## Deployment checklist

1. Reconcile migration filenames/order with the actual hosted Supabase migration history before applying. The repository snapshot includes future-dated migration files relative to the local audit date.
2. Configure `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, and `ZOHO_REDIRECT_URI` for the generic callback URL `/functions/v1/intel-provider-callback` in the Zoho API Console. Do not remove legacy redirect URIs until old connections are no longer needed.
3. Apply the additive migration through the reviewed migration process.
4. Deploy the generic `intel-provider-connect`, `intel-provider-callback` (with JWT verification disabled for the provider redirect only), and `intel-provider-token` functions.
5. Connect a test mailbox and verify identity, token refresh, account inventory and read-only folder access. Do not enable sending during this verification.
6. Keep provider and account sending gates off until production database policies, consent rules, quota reservation, approval, kill switch and ambiguous-send reconciliation are confirmed in the target environment.

## Verification in this workspace

- Python worker unit tests: 397 passed.
- JavaScript tests: 770 passed.
- Python `compileall`: passed.
- OAuth callback unit test covers Zoho EU code exchange, account identity, data-center persistence and inactive account defaults.
- No Deno/Supabase CLI or live Zoho credentials were available. SQL migration execution, Edge Function deployment, live OAuth, live Zoho API compatibility and production frontend build remain unverified.
- No environment variables changed, no account connected, no worker restarted and no email sent.
