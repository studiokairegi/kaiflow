# Phase 3 CRM Compose — Confirmed Bugfix Handoff

## Scope

Applied the confirmed Phase 3 CRM lead Compose fixes to the supplied repository. Existing unrelated project files and pre-existing repository changes were preserved.

## Fixes

1. **Unusable sender hand-off no longer remains pending.**
   - Added `leadComposeReadiness()` to distinguish loading, registry errors, send-ready, and no-sendable-account states.
   - A CRM compose request is retained while registries are loading or have errors.
   - Once both registries have loaded successfully and no sender can send, the request is consumed and the Inbox displays: “No connected sender can send right now...”.
   - Leaving the CRM Inbox/module clears the pending hand-off, preventing an old lead composer from appearing later.

2. **CRM association cannot silently follow a changed recipient.**
   - The composer detects when the original lead email is no longer present in the To field.
   - It warns the user and requires an explicit “Send without linking” choice before sending to a different recipient.
   - The client omits the CRM lead association when that choice is selected.
   - The server independently verifies that an explicitly linked lead's saved email matches a To recipient; mismatches are rejected with HTTP 409 before outbound row creation/provider submission.
   - The server-side lead lookup now fetches the lead email as well as its id.

3. **Minor confirmed fixes.**
   - Whitespace-only company names now fall back to the contact person or email address.
   - Reopened CRM-linked drafts restore the lead label from the loaded CRM lead list.
   - Subject receives focus when the To field is prefilled.

4. **Regression coverage.**
   - Added behavioral tests for readiness outcomes, recipient-link matching, whitespace labels, and server-side recipient mismatch rejection.
   - Updated existing CRM send fixtures to include the lead email and reflect the new server contract.

## Validation

- Full Node test suite: **1,026 passed, 0 failed**.
- Browser/manual UI testing was not performed.
- Production build was not run: this extracted repository has no `node_modules`/Vite installation (`npm run build` cannot execute because `vite` is unavailable).

## Files changed for this fix

- `src/App.jsx`
- `src/email/InboxModule.jsx`
- `src/email/components/ComposeDialog.jsx`
- `src/email/lib/logic.js`
- `supabase/functions/_shared/email_resend_logic.ts`
- `supabase/functions/_shared/email_resend_store.ts`
- Phase 3 and related email regression tests

## Deployment note

The server-side recipient check is in the Edge Function shared send logic. Deploy the updated email-send function together with the application code. No database migration is required for these changes.
