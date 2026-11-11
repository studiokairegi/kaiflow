# Phase 2 sender-account bugfix report

**Scope:** sender-account validation, OAuth connection-state enforcement, CRM Compose hand-off, draft sender recovery, and account RPC hardening.

## Fixed

1. **Server-side OAuth connection gate.** `email-send` now reads `connection_status` from the organization-scoped account row and refuses OAuth-capable providers unless the row is `connected`. The browser selector is no longer the only enforcement point.
2. **CRM Compose hand-off.** The hand-off now requires at least one account that `accountCanSend` considers usable. It does not consume the request while account/provider refreshes are failing, so stale cached account rows cannot cause a silent drop.
3. **Recovering drafts/replies after sender pause or disconnection.** A locked draft/conversation now offers “Copy to a new message with another sender” when its current sender is unavailable. The copy retains recipient, Cc/Bcc, subject, body, and CRM lead attribution; the original saved draft is left intact.
4. **Account RPC hardening.** New additive migration `20261220100000_email_provider_sender_safety.sql` removes `last_connection_error` from account RPC payloads, requires provider `send` capability before an account can be added, and serializes first-account/default creation per organization to prevent a concurrent first-account race.

## Not changed / remaining

- **OAuth lifecycle transitions:** there is no OAuth sending adapter or OAuth token-refresh path installed in this snapshot. The send boundary now fails closed for disconnected OAuth accounts, but marking `reauthorization_required`, `disconnected`, or `error` must be wired to the eventual provider adapter's token/refresh error classifications. Inventing those transitions before an OAuth adapter exists would be misleading and could misclassify transient provider failures.
- **Per-user account permissions:** the audit raised whether any Email-authorized organization member may send from any organization account. That is a product/security policy decision, not a confirmed implementation defect without the intended permission model. Existing organization scoping remains unchanged.
- **Provider refresh UX:** fail-closed behavior during a failed provider refresh remains intentional; the UI continues to pause sending until registry state can be verified.

## Verification

- `npm test`: **1022 passed, 0 failed**.
- `npm run build`: **not run successfully**; this checkout has no installed `node_modules` (`vite: not found`). Run `npm ci && npm run build` in CI or locally.
- SQL migration was added to `supabase/tests/run_intelligence_auth.sh`, but **no PostgreSQL/staging database was available**, so SQL integration tests and live migration application remain unverified.
- No live email was sent and no production database was changed.
