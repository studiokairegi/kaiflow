# Manual Lead Email Composition — Phase 5: Inbox & CRM Synchronization

**Status:** Phase 5 confirmed-bug fixes implemented in source. `npm test`: 1,028 passed. Not deployed; the new migration has not been applied; no live provider send or browser test was performed.

## Audit result (already in the repo from earlier 4E/4F work)
- Sent mail appears in the Inbox Sent folder. Resend's provider-generated RFC `Message-ID` is retrieved from `GET /emails/:id` and persisted; signed delivery webhooks also carry it as a recovery path. Replies use the stored RFC id for `In-Reply-To`/`References`.
- Outbound replies inherit the conversation's CRM lead; a conflicting lead is refused (`crm_lead_conflict`).
- Inbound replies attach to the matched conversation, which keeps its `lead_id`; the Inbox shows "Open lead".
- Duplicates: unique `email_crm_activities.message_id`, provider-event claims, account-scoped provider/RFC uniqueness, idempotent send.

## Gap found and fixed
The server writes the `email_sent` timeline entry into `leads.activity_log` after a send, but the CRM keeps its own loaded copy of each lead, so the lead editor did not show the email until a full reload.
- `mergeEmailTimeline(local, server)` (`src/email/lib/logic.js`) adds only server email entries missing locally (matched by `emailMessageId`) without reordering existing activity. `sortEmailTimelineForDisplay` sorts once for display; invalid/missing timestamps remain stable at the end.
- `refreshLeadTimeline` (`src/App.jsx`) reads only `id, activity_log` for one lead and merges it. It runs after an Inbox send that was linked to a lead, when a lead card is opened, and when jumping from the Inbox to a lead. It never writes; on any error the lead is used as loaded.
- Timeline rows for emails show an **Email** tag.

## Files
`src/email/lib/logic.js`, `src/email/InboxModule.jsx` (`onLeadEmailSent`), `src/App.jsx`, `src/email/phase5-sync.test.mjs` (new, 6 tests).

## Verification
The original Phase 5 verification notes below describe the earlier implementation and have been superseded by the confirmed-bugfix report at the end of this file.

## Follow-up: the three limitations, fixed
1. **Inbound replies on the lead timeline.** `20261221090000_email_crm_inbound_timeline.sql` adds an `AFTER INSERT` trigger on inbound `email_messages`: when the conversation is linked to a lead, one `email_received` entry (with `emailMessageId` and `emailConversationId`) is appended to `leads.activity_log`. It covers every ingestion path, fires only for rows actually inserted (a duplicate provider delivery adds nothing), is idempotent per message id, and never blocks receiving mail (errors become a warning). The Phase 4D stale-editor guard now preserves both `email_sent` and `email_received` entries.
2. **Open email.** New `email_message_conversation(uuid)` RPC (authenticated, org-checked via `email_require_access`; other-org or unknown ids return null). Timeline email entries get an **Open email** button that closes the lead and opens that conversation in the Inbox. Works for entries written before this migration.
3. **Live refresh.** While a lead is open the editor re-reads its `activity_log` every 30 s (read-only) and shows merged entries; they are never copied into the form, so saving cannot rewrite them.

Files: `supabase/migrations/20261221090000_email_crm_inbound_timeline.sql`, `supabase/tests/email_crm_inbound_timeline.test.sql`, `src/App.jsx`, `src/email/InboxModule.jsx`, `src/email/lib/logic.js`, `src/email/phase5-sync.test.mjs`, `src/email/phase4-recovery-schedule.test.mjs` (order assertion relaxed).

Verification: `npm test` 987 passed. The new migration was applied twice (idempotent) to a throwaway PostgreSQL 16 and `email_crm_inbound_timeline.test.sql` passed 6/6 plus an RPC check, **but against minimal stub tables**, not the full migration chain: the repo's own SQL runner (`run_intelligence_auth.sh`) already fails at its baseline (an old cut-review migration and `leads.activity_log` missing from its stubs), so the real chain could not be run. Run the new test file after the real chain in your environment.

## Confirmed-bug fixes — 2026-11-11

1. **RFC reply association:** no synthetic `Message-ID` is sent (Resend owns that header). After acceptance, the Resend adapter reads the provider-generated `message_id` from `GET /emails/:id`; inability to read it does not turn an accepted send into a failure. The signed `email.*` webhook path persists the same RFC id through a service-role-only reconciliation RPC. Follow-ups can then use the saved id in `In-Reply-To` and `References`.
2. **Stable timeline ordering:** background merges append missing server email entries without sorting or moving existing notes. The lead editor applies one stable display sort; missing/invalid timestamps are placed last, preserving their relative order.
3. **Link/unlink/rethread reconciliation:** a new trigger migration rebuilds the email timeline projection when a conversation's lead changes or a message is moved to another conversation. Existing sent/received email entries are removed from the previous lead and backfilled to the new lead. The controlled relink flag bypasses the stale-editor preservation guard only during this reconciliation.
4. **Automatic replies and bounces:** inbound timeline projection ignores `mailer-daemon`/`postmaster`, auto-submitted/auto-reply headers, bulk/list precedence and common out-of-office/delivery-failure subjects.
5. **Test brittleness:** removed the Phase 5 test's assertion that the migration directory's last filename must remain a fixed timestamp.

New migration: `supabase/migrations/20261223100000_email_crm_timeline_reconciliation.sql`.

Verification: `npm test` — 1,028 passed, 0 failed. Targeted Email/Phase 5/Phase 6 tests also pass. SQL migration execution and the live Resend API/webhook were not run. `npm run build` could not run because this extracted workspace has no installed `vite` binary (`node_modules` is absent). Apply the migration only after reviewing it against the linked Supabase schema, then test with a real Resend send/reply.
