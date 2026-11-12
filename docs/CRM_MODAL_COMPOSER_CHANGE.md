# CRM lead composer: modal over the CRM (replaces the Inbox hand-off)

- Saved lead with a valid email, opened from the pipeline: the email row shows a mail icon beside Copy.
- Click opens `LeadComposeModal` over the CRM: To pre-filled, sender selector, subject, message, Send. No tab switch.
- After a successful send the modal closes and the user is still on the CRM; the lead timeline is refreshed.
- Same ComposeDialog / `email-send` / `email_record_crm_activity` path as before (CRM lead id, idempotency, recipient-match guard unchanged).
- Removed: pipeline-card Compose button and the Inbox `composeRequest` hand-off.
- Files: `src/email/components/LeadComposeModal.jsx` (new), `src/App.jsx`, `src/email/InboxModule.jsx`, `phase3-compose.test.mjs`, `provider-foundation.test.mjs`.
- No migrations, no DB or edge-function changes. Not checked visually in a browser.
