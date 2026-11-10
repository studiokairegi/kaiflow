# KairFlow Phase 6 — Independent Bug Recheck

**Artifact audited:** `KairFlow_Phase6_Complete.zip`
**Baseline:** uploaded `KairFlow_Phase5_Complete(1).zip`
**Scope:** Phase 6 frontend changes, changed email API wrappers, account/provider loading and sending eligibility.
**Audit mode:** Inspection and test execution only. No source files were modified.

## Executive result

Phase 6 is **not yet clean for production release**. The repository test suite was independently rerun and passed **963/963 tests**, but the current tests do not exercise several important UI failure paths. The production build could not be run because Vite is not installed in the supplied environment.

## Confirmed findings

### P1 — Provider registry errors do not actually fail closed after a successful load

**Location:** `src/email/InboxModule.jsx` around provider state setup and `providerRows` derivation; `src/email/components/ComposeDialog.jsx`; `src/email/components/InlineReply.jsx`; `src/email/components/SetupAccount.jsx`.

`useLoad` retains the previous `data` value when a later refresh fails. `InboxModule` then sets `providerRows = providers.data || []` even when `providers.error` is populated. The UI displays a warning that sending is paused, but `accountCanSend()` still receives the stale provider rows and can return `true`. Compose and inline reply therefore remain enabled against stale provider state. The setup screen can also continue showing stale provider choices and leave account creation enabled.

**Impact:** The visible fail-closed warning contradicts actual UI eligibility. If an administrator disables a provider or the registry becomes unavailable after the initial load, the browser may still offer sending/account actions based on stale registry data. The server remains the final authority, but the frontend's stated safety behavior is not implemented.

**Required correction:** Treat a registry error as untrusted provider state: derive an empty provider list while `providers.error` exists, disable send and provider setup actions, and provide an explicit retry path. Add tests for a successful initial load followed by a failed refresh.

### P2 — Account-list failures are presented as an empty account list

**Location:** `src/email/InboxModule.jsx`, early-return setup condition and `errorText` construction.

The setup-screen condition checks only `!accounts.loading`, `!providers.loading`, and `accts.length === 0`. It does not check `accounts.error`. Since `useLoad` leaves `data` null on an initial failure, `accts` becomes `[]`, and the UI renders `SetupAccount` as though the organization has no accounts. `accounts.error` is not included in the rendered error state.

**Impact:** A transient permission, network, or database error is misrepresented as first-time setup. Users may attempt to add an account when the real issue is that the account list could not be loaded.

**Required correction:** Distinguish `accounts.error` from a successful empty result. Render an account-loading error with retry, and only show first-account setup after a successful empty response. Add tests for initial account-list failure and successful empty account list.

### P2 — Additional account setup is unreachable after the first account exists

**Location:** `src/email/InboxModule.jsx`; `src/email/components/SetupAccount.jsx`.

`SetupAccount` is rendered only when `accts.length === 0`. There is no Add account action in the inbox, account list, composer, or another general Email account-management surface. Once the first account is created, users cannot add another provider/account through this UI, even though the database model and composer support multiple accounts.

**Impact:** Multi-account setup and switching can only work for accounts provisioned outside this frontend. Users cannot complete the normal UI workflow to add a second sending account or replace an account when one already exists.

**Required correction:** Provide an explicit Add account entry point and a reusable setup dialog/panel that is available when accounts already exist. Preserve existing sender/account ownership constraints.

### P2 — Duplicate email API modules have diverged

**Locations:** `src/email/lib/api.js` and `src/email/api.js`.

The canonical `lib/api.js` send wrapper includes CRM metadata and preserves normalized error fields (`outcome`, `code`, `retry_with_same_key`, `message_id`, and `duplicate`). The duplicate `src/email/api.js` wrapper omits CRM metadata and reduces send errors to a plain `Error`, losing those fields. The Phase 6 handoff says the duplicate wrapper was kept in sync, but source comparison disproves that statement.

**Impact:** The current composer and inline reply import `lib/api.js`, so their active path retains the richer behavior. `useEmailUnread.js` imports the duplicate module but currently calls only `unreadTotal`. This is therefore a latent integration defect rather than a demonstrated failure in the current send route. Any future caller of `src/email/api.js` could lose CRM activity metadata and idempotency retry semantics.

**Required correction:** Remove the duplicate implementation and re-export the canonical `lib/api.js` wrapper, or make one module the sole source of truth. Add an import-contract test to prevent drift.

## Verification performed

- Compared Phase 6 source against the supplied Phase 5 baseline.
- Inspected all Phase 6 changed email UI/API files and the Phase 6 frontend tests.
- Ran `node --experimental-strip-types --test` from the repository root: **963 passed, 0 failed, 0 skipped**.
- Attempted `npm run build`: **blocked** with `sh: 1: vite: not found`.
- No database migrations, production configuration, Edge Functions, or deployment targets were changed.
- No source changes were made during this recheck.

## Coverage gaps / release risks

1. The four Phase 6 tests mainly test pure provider helper behavior and source-text contracts; they do not mount the React components or simulate provider/account request failures.
2. Browser interaction QA remains outstanding for first-account setup, adding a second account, switching sender accounts, saving/editing drafts, sending, attachments, and inline replies.
3. The production frontend build remains unverified because Vite dependencies are unavailable in the supplied environment.
4. Resend remains the only enabled built-in general Email provider in the supplied registry. This phase does not implement Gmail, Zoho, Microsoft Graph, or IMAP/SMTP mailbox integrations.

## Release decision

**Do not certify Phase 6 for production yet.** Correct the four findings, add component-level failure-path tests, install the locked dependencies, obtain a successful production build, and complete browser smoke tests. The existing 963 passing tests are useful regression evidence but do not cover the confirmed UI defects above.
