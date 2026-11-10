# KairFlow Email — Phase 6 Frontend Integration Handoff

**Baseline:** `KairFlow_Phase5_Complete(1).zip` (uploaded Phase 5 complete repository)
**Scope:** Phase 6 — Frontend Integration and Unified Email Experience
**Implementation status:** Implemented in the supplied repository; local automated tests pass.
**Production status:** Not certified for deployment. No production configuration, database, Edge Function, or deployment changes were made.

## 1. Objective and scope

Connect the existing provider registry and account model to one shared KairFlow Email interface. Preserve the inbox, conversation, draft, reply, forward, attachment, and Resend sending behavior. Provider choices and sender eligibility must be derived from the authorized provider registry and account state, not from a frontend hardcoded provider list.

This is Phase 6 only. No database migration was added and no migration was applied. No Edge Function, provider adapter, OAuth callback, Resend transactional delivery path, or KairFlow Intelligence integration was modified.

## 2. Repository findings that constrained the implementation

The supplied Phase 5 repository contains one built-in general Email adapter: Resend. The provider registry seed declares Resend send capability, inbound webhook/delivery events, and attachment capabilities, while remote mailbox sync, remote search, remote folders, remote drafts, and OAuth are false. Therefore this frontend does not advertise Gmail, Zoho, or another mailbox provider as operational. It also does not invent an OAuth flow.

Resend accounts are verified sending-address configurations, not OAuth-connected mailboxes. Their `connection_status` may remain `not_connected` under the Phase 5 schema; the UI correctly describes them as **Sending address configured** rather than falsely displaying **Connected**.

## 3. Implemented changes

### Provider-aware account setup

- Added a browser API wrapper for `email_provider_registry_list()`.
- Account creation now sends the selected registry `provider_key` to the existing three-argument `email_upsert_account` RPC.
- Setup choices are limited to enabled registry entries that declare `capabilities.send === true`.
- OAuth-required providers are not presented with a fake address-entry or connection action. The UI explains that a real provider connection flow is not available in this frontend release.
- Empty, disabled, and failed provider-catalog states are shown explicitly.

### Unified inbox and account identity

- The existing shared inbox and conversation interface is preserved.
- The sidebar now identifies each sender account by provider, address, and usable status.
- The active conversation header identifies the sender address associated with that conversation.
- Provider catalog failures fail closed for sending rather than treating an unknown provider as usable.

### Shared composer and safe account switching

- The shared composer is retained for new messages, forwards, and saved drafts.
- The sender (`From`) field is explicit even when only one account exists.
- Available accounts show provider identity; inactive, disabled, unregistered, or unconnected OAuth accounts cannot be selected for sending.
- Saved drafts and existing conversations retain their immutable sender selection.
- Inline replies continue to use the conversation's original account and are blocked when that account is not eligible to send.
- Existing To, Cc, Bcc, subject, body, attachment limits, draft save/delete, idempotency key handling, and send error handling are preserved.

### Provider/account capability logic

Added pure helpers for enabled send-capable providers, provider lookup by account, sender eligibility, and user-facing account connection labels. These helpers use registry capabilities and account status; they do not make provider selection decisions from browser-supplied send requests.

## 4. Files changed

- `src/email/lib/api.js`
- `src/email/api.js` (kept in sync with the legacy duplicate wrapper)
- `src/email/lib/logic.js`
- `src/email/InboxModule.jsx`
- `src/email/components/SetupAccount.jsx`
- `src/email/components/ComposeDialog.jsx`
- `src/email/components/InlineReply.jsx`
- `src/email/styles/inbox-chat.css`
- `src/email/phase6-frontend.test.mjs` (new)
- `docs/PHASE_6_HANDOFF_REPORT.md` (new)
- `docs/PHASE_6_TEST_RESULTS.txt` (new)

## 5. Database, security, and compatibility

- **Database changes:** None.
- **Migrations:** None created, changed, or applied.
- **Authorization:** Existing authorized `email_provider_registry_list`, `email_list_accounts`, and `email_upsert_account` RPCs are used. The server-side RPC continues to validate the selected provider against the registry.
- **Provider selection:** The browser passes provider identity only when creating an account; the existing send path continues to resolve the provider from the persisted account row.
- **Credentials:** No provider secret, OAuth token, or Resend key is read or stored in browser state.
- **Transactional Resend:** No changes to the independent application notification delivery path.
- **KairFlow Intelligence:** No `intel_*` tables, policies, callbacks, tokens, or worker code changed.

## 6. Verification

### Automated tests

`npm test` completed successfully using Node `v22.16.0` and the repository's configured command `node --experimental-strip-types --test`.

- Total tests: **963**
- Passed: **963**
- Failed: **0**
- Skipped: **0**

The four new Phase 6 tests cover registry filtering, account/provider eligibility, accurate OAuth-vs-Resend status labels, and the frontend integration contracts. The full existing suite also passes.

### Production build

`npm run build` was attempted but could not run because Vite is not installed (`sh: 1: vite: not found`). An `npm ci --ignore-scripts --no-audit --no-fund` attempt timed out before dependencies became available. This is an environment/dependency availability limitation, not a passing build result.

### Not performed

- Browser-based visual or interactive QA.
- Frontend production build (blocked by unavailable Vite dependency).
- PostgreSQL migration execution (no migration introduced in this phase).
- Live provider connection or send/receive tests.
- Production deployment.

## 7. Remaining limitations and risks

1. Resend remains the only enabled built-in general Email provider in the supplied registry. This phase provides a registry-driven frontend, not new Gmail, Zoho, Microsoft Graph, or IMAP/SMTP adapters.
2. Resend supports sending and configured inbound/delivery webhook handling; it does not provide remote mailbox folder listing, remote mailbox search, or OAuth mailbox sync. The unified inbox continues to display data already represented in the shared KairFlow model and must not be described as a full external mailbox sync experience.
3. An OAuth provider added to the registry must have its actual connection flow and server-side operations implemented before it can be enabled for users. The current UI deliberately does not fabricate that flow.
4. Install the repository's locked dependencies, run `npm run build`, and perform browser QA before release.
5. Verify the deployment's registry and provider enablement state before exposing account setup to users.

## 8. Release recommendation

**Phase 6 implementation is complete at source/test level, but production release remains conditional.** The complete JavaScript test suite passes. Do not claim a production-ready build until dependency installation succeeds, Vite build passes, and browser smoke tests verify setup, account switching, draft editing, sending, attachments, and inline replies against a controlled environment.
