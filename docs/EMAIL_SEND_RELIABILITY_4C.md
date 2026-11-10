# Email submission reliability — revised Phase 4C

**Baseline:** Phase 4B handoff package, 10 November 2026
**Status:** Implemented in this package; not deployed and no live email was sent.

## Guarantees

1. The idempotency key identifies one logical submission. A retry after a timeout, missing response, or `unknown` result keeps the same key.
2. A repeated key is lookup-only: the server never calls the provider again for a row already created with that key.
3. A repeated key whose row is `sent`, `delivered`, `delivery_delayed`, `bounced`, or `complained` returns a successful `duplicate` result.
4. A repeated key whose row is `queued` or `sending` returns HTTP 202 / `outcome: unknown` / `retry_with_same_key: true`. It does not return a false success and does not submit again.
5. A confirmed provider rejection or confirmed non-acceptance failure returns `retry_with_same_key: false`; the composer rotates the key only for these terminal outcomes.
6. Pre-send refusals, network errors, malformed responses, and unknown outcomes retain the current key. This prevents a new logical send being created after a client-side timeout.
7. Resend retries 429/5xx with the same provider idempotency key. Any network error or 5xx makes the final exhausted result ambiguous, even if a later attempt returns 429. A 429-only retry sequence remains a confirmed non-acceptance. Resend's `concurrent_idempotent_requests` 409 is treated as unknown and retried boundedly with the same key; `invalid_idempotent_request` is a terminal rejection.
8. Once the provider accepts, only the database status write is retried (three bounded attempts). The provider is never called again. If all writes fail, the API still reports accepted with `sent_status_not_saved`; the opaque provider message id is retained in the structured send-result audit event for repair.

## Validation and attachments

The Phase 4B request validation and limits remain unchanged: valid recipients, required subject, non-empty text or HTML, bounded body and request size, maximum 50 recipients, maximum 10 attachments and 10 MB total attachment payload. Attachment storage remains post-acceptance and cannot convert a sent email into a reported send failure.

## Files changed

- `supabase/functions/_shared/email_resend_logic.ts` — duplicate state mapping, provider-id audit field, bounded post-acceptance database-write retries.
- `supabase/functions/_shared/email_adapter_resend.ts` — sticky ambiguous-outcome handling for exhausted retry sequences.
- `src/email/lib/api.js` — preserves normalized outcome metadata from Edge Function responses.
- `src/email/lib/helpers.js` — key-rotation policy helper.
- `src/email/components/ComposeDialog.jsx` — retains key except after confirmed provider rejection/failure.
- `src/email/dispatch-4b.test.mjs` — Phase 4C duplicate, unknown and provider-id persistence regression tests.
- `src/email/dispatch-4c.test.mjs` — composer key-rotation policy tests.
- `src/email/email.test.mjs` — Resend mixed 5xx/429 ambiguous retry test and stricter exhausted-5xx assertion.
- `docs/EMAIL_SEND_RELIABILITY_4C.md` — this handoff.

## Migrations and deployment

No schema change or migration is included. No deployment, database operation, secret change, or real email send was performed. Existing unique index `(organization_id, idempotency_key)` and `email_create_outbound` RPC are reused.

## Test status

The Phase 4B baseline was 902 passing tests. The complete repository suite now passes **910 tests, 0 failures** (eight new Phase 4C tests). Focused email regression tests pass **108 tests, 0 failures**. Strict TypeScript checking of the six shared email modules passes with 0 errors. All provider behavior tests use mocks/fakes.

## Isolation

No changes were made to `intel-resend-send`, `intel-resend-webhook`, `resend-webhook`, `provider_guard.ts`, or `intel_resend_logic.ts`. Transactional/Intelligence Resend paths remain outside the CRM Email send reliability changes.

## Remaining considerations

- Resend documents a 24-hour idempotency-key retention window and distinguishes concurrent requests from same-key/different-payload conflicts. Internal retries use the same key; the local unique key row remains the primary duplicate guard after the provider retention window. A stale unresolved row still requires reconciliation, not a new key. See the [Resend idempotency contract](https://resend.com/changelog/idempotency-keys).
- A provider that does not implement idempotency must conservatively report ambiguous outcomes; the shared service cannot manufacture provider-side exactly-once delivery.
- A durable reconciliation worker for stuck `sending` rows is not introduced here; that remains a separate operational follow-up and must never resend automatically. Phase 4D's CRM recorder must consume accepted rows and never invoke provider sending.
- A provider-accepted message whose database write fails is returned as accepted and logged with provider message id. Automated durable repair is still needed if the database remains unavailable beyond the bounded retries.

## Rollback

Redeploy the previous `email-send` and `resend-webhook` bundles and restore the changed shared email logic/adapter files plus the composer/API files. No migration rollback is required. The rollback must be coordinated because both Edge Functions import the shared module; webhook behavior itself was not changed.

## Approval boundary

Phase 4C is complete for review only. Do not start Phase 4D until explicit approval.
