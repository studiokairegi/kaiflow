# KairFlow Phase 5 â€” Confirmed Bugfix Report

**Date:** 2026-11-11
**Scope:** Fix confirmed Phase 5 sync defects from the audit. No live provider, database, or production environment was changed.

## Changes made

### 1. RFC Message-ID and reply threading
- Removed the invalid approach of inventing and sending a custom `Message-ID`. Resend generates this header.
- After a successful send, the Resend adapter retrieves the generated `message_id` using `GET /emails/:id`.
- The provider-generated RFC id is saved to `email_messages.rfc_message_id` alongside the accepted-send state.
- If the GET lookup fails, the send remains successful; it is not converted into a failed/unknown send.
- Signed Resend `email.*` webhooks also carry `data.message_id`. A new service-role-only RPC wrapper persists that RFC id during tagged delivery reconciliation, covering a failed GET or a database write outage.
- Follow-up sends continue to use the stored parent RFC id for `In-Reply-To` and `References`.

### 2. Timeline ordering
- `mergeEmailTimeline` now appends missing server email entries without sorting the existing array.
- `sortEmailTimelineForDisplay` performs a stable chronological sort only for the lead editor's display.
- Entries with missing or invalid timestamps appear last, preserving their relative order.

### 3. Link/unlink/rethread timeline reconciliation
- New migration `20261223100000_email_crm_timeline_reconciliation.sql`.
- Existing email timeline entries are removed from the old lead and rebuilt on the currently linked lead when a conversation is linked, unlinked, or relinked.
- A message moved to a different conversation by the inbound duplicate-update path is reconciled by an `email_messages.conversation_id` trigger.
- The original `email_link_lead` authorization rule is preserved: the caller can link only their own lead.
- A transaction-local relink flag lets this controlled operation remove entries without weakening the normal stale-editor guard.

### 4. Auto-reply/bounce filtering
- Timeline projection ignores mailer-daemon/postmaster senders, `Auto-Submitted`, `Precedence: bulk/list/junk`, common auto-reply headers, and common out-of-office/delivery-failure subjects.

### 5. Smaller test issue
- Removed the brittle test assertion that the newest migration must always have one exact filename.

## Files changed
- `supabase/functions/_shared/email_adapter.ts`
- `supabase/functions/_shared/email_adapter_resend.ts`
- `supabase/functions/_shared/email_resend_logic.ts`
- `supabase/functions/_shared/email_resend_store.ts`
- `src/email/lib/logic.js`
- `src/App.jsx`
- `src/email/email.test.mjs`
- `src/email/adapter.test.mjs`
- `src/email/phase5-sync.test.mjs`
- `src/email/phase6-security.test.mjs`
- `src/email/dispatch-4b.test.mjs`
- `src/email/phase-4f.e2e.test.mjs`
- `docs/PHASE_5_INBOX_CRM_SYNC.md`
- `supabase/migrations/20261223100000_email_crm_timeline_reconciliation.sql`

## Verification
- `npm test`: **1,028 passed, 0 failed**.
- Targeted Email, adapter, Phase 5 sync and Phase 6 security tests passed.
- SQL migration was not executed against PostgreSQL/Supabase.
- Live Resend send, GET lookup, webhook and actual reply were not tested.
- `npm run build` could not run because `vite` is not installed in the extracted workspace (`node_modules` absent).

## Deployment note
The new migration is additive and has not been applied. Review it against the linked Supabase schema and apply it before deploying the Edge Function/source changes. Then verify one outbound send, its persisted RFC `Message-ID`, a real reply, and link/unlink/relink behavior in a non-production test workspace.

## Explicitly not included
The audit's separately labelled gaps remain separate follow-up work: adding inbound replies to `email_crm_activities` (not only `leads.activity_log`) and generalizing provider-thread-id association for future mailbox-provider sending. No claims are made that those gaps are fixed.
