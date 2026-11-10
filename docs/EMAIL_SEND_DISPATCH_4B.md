# Email sending dispatch (revised Phase 4B)

Implements the dispatch part of `EMAIL_SEND_ARCHITECTURE_4A.md`. Code: `supabase/functions/_shared/email_resend_logic.ts` (`sendInner`), `email_resend_store.ts`. Tests: `src/email/dispatch-4b.test.mjs`.

## Order of checks in `email-send` (each refusal creates and sends nothing)
1. Authenticate (admin + active Master User; organization comes from the database). `401 unauthenticated` / `403 forbidden`.
2. Validate the body. `400 invalid_request`. Only the documented fields survive validation (`account_id, to, cc, bcc, subject, text, html, reply_to, conversation_id, draft_id, idempotency_key, attachments, crm`). Provider, adapter, organization, user and sender fields are never read.
3. Sender account from the database, scoped to the caller's organization, and re-checked against it. `404 account_not_found`. A paused account: `409 account_not_usable`.
4. Adapter from `account.provider` + registry row. `409 provider_not_registered`, `503 provider_disabled`, `503 adapter_unavailable`.
5. Adapter configuration, then the adapter's legacy kill switch. `503 not_configured`, `503 provider_disabled`.
6. Optional `crm.lead_id`: must be a lead owned by the signed-in user (leads are per user). `404 lead_not_found` for missing and not-yours alike. Verified only: it is not stored and never reaches an adapter in 4B.
7. Limits. `429 rate_limited`.
8. Idempotent outbound row, then the adapter's `send`.

## Answers
Every non-2xx answer carries `{ error, code }`. Results carry `outcome`:

| outcome | HTTP | notes |
|---|---|---|
| `accepted` | 200 | `status: "sent"`; `warning: "sent_status_not_saved"` if bookkeeping failed after acceptance |
| `duplicate` | 200 | repeat of a stored key; read `status` (unconfirmed-repeat handling is phase 4C) |
| `rejected` | 422 | `provider_rejected`; sanitised provider text shown |
| `failed` | 502 | `provider_unavailable` or `rate_limited`; fixed message, no provider text |
| `unknown` | 202 | `outcome_unknown`, `retry_with_same_key: true`; never resent automatically |

Provider text is passed through `sanitizeProviderMessage` (single line, 200 characters, credentials and long tokens redacted) before it is stored in `email_messages.error` or shown.

## Not in 4B
Idempotency and client key rotation (4C), the activity table and recorder (4D), Inbox sync and persisting the lead association (4E), end-to-end validation (4F). The browser does not send `crm` yet.
