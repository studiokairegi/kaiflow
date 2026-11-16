# Manual Lead Email Composition — Phase 3: CRM Lead Composer Integration

**Status:** implemented in source, tests pass. Not deployed; no migration; no real email sent.

## Behaviour
- Pipeline lead cards show a **Compose** button only when the user has Email access (`canAccessEmail`) and `leadComposeTarget(lead)` is non-null: saved UUID id, not archived, at least one valid address in `lead.email` (first valid address is used).
- Clicking it (without opening the lead editor or starting a drag) switches the CRM to the Inbox tab, where the **existing** `ComposeDialog` opens with To pre-filled and `crmLeadId` set. The existing sender selector, availability checks, drafts, attachments and Send path are unchanged.
- `InboxModule` opens the composer only after accounts and providers have loaded without error and at least one account exists. Otherwise the request is dropped and the usual setup/error screens show; nothing is sent.
- The dialog shows "Linked to CRM lead: <name>" so the user sees what will be recorded. Phase 4's `email-send` / `email_record_crm_activity` records the send on that lead.

## Files changed
- `src/email/lib/logic.js` — `leadComposeTarget`
- `src/email/InboxModule.jsx` — `composeRequest` / `onComposeHandled`
- `src/email/components/ComposeDialog.jsx` — lead-link notice
- `src/App.jsx` — state, board-card button, style, props
- `src/email/phase3-compose.test.mjs` — 8 tests (new)

## Verification
`npm test`: 975 passed, 0 failed (967 before + 8). JSX syntax-checked with tsc; `npm run build` not run (vite not installed). Not checked visually in a browser (desktop/mobile layout is Phase 7).

## Limitations
- Button is on pipeline board cards only (not the archived list or the lead editor).
- Compose is dropped, not queued, if no sender account is connected.
- Leads with several addresses use only the first valid one.
