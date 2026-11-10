# Phase 4C — Corrective bug-fix handoff

## Scope

Fixed the two findings from the Phase 4C second bug audit. No live database, provider account, secrets, or deployment was accessed or changed.

## 1. Queued-to-sending persistence failure

`supabase/functions/_shared/email_resend_logic.ts` now retries the `queued` → `sending` persistence transition up to three times, with bounded exponential backoff (100 ms, 200 ms). The provider adapter is not called unless that transition succeeds. If all attempts fail, the message remains `queued` and the endpoint returns HTTP 503 with `status: queued`, `code: database_unavailable`, and `retry_with_same_key: true`.

## 2. Idempotency-key binding

The new migration `20261206100000_email_provider_idempotency.sql` adds `email_messages.request_fingerprint` and updates `email_create_outbound`. The fingerprint binds the key to the sender account, submitting user, conversation/draft identity, recipients, reply-to, subject, text/HTML body, thread headers, and attachment names/types/contents. Reuse with a different fingerprint or sender account raises `idempotency_key_conflict`; the API returns HTTP 409 and never calls the provider. Existing rows without a fingerprint fail closed on key reuse.

## Regression coverage

Added tests for three failed pre-send database writes (provider call count remains zero) and idempotency conflicts (HTTP 409, provider call count remains zero). Added migration contract checks.

- Full repository tests: **913 passed, 0 failed, 0 skipped**.
- Build: not run successfully because this extracted ZIP has no installed `node_modules` (`vite: not found`).
- Live PostgreSQL migration execution: not performed.
- Live provider behavior: not verified.

## Deployment note

Apply `20261206100000_email_provider_idempotency.sql` to the linked Supabase project before deploying the updated Edge Function. The migration is additive and does not delete existing messages. Do not deploy the function before the migration is applied.
