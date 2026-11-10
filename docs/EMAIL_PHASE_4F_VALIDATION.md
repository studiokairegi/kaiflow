# Phase 4F — End-to-End Sending Validation (Corrective Update)

**Status:** Confirmed source-level defects corrected; automated tests pass. Production approval remains withheld pending PostgreSQL execution, build, controlled deployment and live provider verification.

## Scope validated

- CRM lead-to-composer send contract and authenticated sender account resolution.
- Database-account-selected adapter dispatch across two controlled sender accounts (Resend plus a test-only fake adapter).
- Successful provider acceptance and CRM activity creation.
- Idempotent replay after acceptance without a second provider submission.
- CRM activity retry after a transient CRM persistence failure.
- Ambiguous provider outcomes remaining unknown and not being resubmitted on replay.
- Inbound account routing and RFC `In-Reply-To` / `References` conversation matching.
- Delivery-event handling and separation from Intelligence's transactional Resend path.
- Source-hash isolation of transactional/Intelligence functions.
- Inbox counters, unread counts, normalized snippets and chronological ordering.
- Recovery of a provider-accepted message when all synchronous post-acceptance database writes fail.
- Monotonic message status when a delivery webhook arrives before the synchronous send response is persisted.

All send and webhook integration tests use controlled fakes. No real prospect email is sent.

## Defects corrected

### 1. Phase 4E Inbox counter trigger

The Phase 4E `_email_message_counters()` trigger referenced `v_at` without declaring it, had incorrect whitespace normalization, and did not recalculate unread counts on `is_read` changes.

Added migration:

`supabase/migrations/20261212100000_email_inbox_phase4f_counter_repair.sql`

### 2. Accepted provider message not recoverable after database outage

Previously, if the provider accepted an email but all three synchronous writes of `status='sent'` and `provider_message_id` failed, the message remained `sending`. The provider ID was only logged and CRM recovery could not identify the accepted email.

Corrective implementation:

- `AdapterSendInput` now carries the server-generated persisted `email_messages.id` as `correlationId`.
- The Resend adapter sends that UUID as the custom `kf_message_id` tag.
- Resend's signed `email.*` webhook events include custom tags; the webhook handler extracts the tag and calls a service-role-only reconciliation RPC.
- The database verifies the exact persisted message, Resend provider, outbound direction, sender account/organization, sender address, subject and recipients before binding the provider message ID.
- The RPC applies the provider event and records the CRM activity in the same transaction. If CRM recording fails, the transaction rolls back and the webhook can be retried.
- The webhook recovery path never calls the provider send endpoint and never trusts a browser-supplied provider ID.

Added migration:

`supabase/migrations/20261213100000_email_accepted_send_reconciliation.sql`

Operational prerequisite: the Resend webhook endpoint must be subscribed to at least `email.sent`; for delivery-state reconciliation also subscribe to `email.delivered`, `email.delivery_delayed`, `email.bounced` and `email.complained`. Without a configured accepted-message webhook, no webhook-driven recovery can run.

### 3. Late accepted response downgrading delivery state

The previous direct status update could change `delivered` back to `sent` if a delivery webhook raced the send response.

`email_mark_provider_accepted()` now persists the provider ID and timestamp while preserving the higher-ranked current status. The database status ordering remains monotonic.

## Test additions and results

- `src/email/phase-4f.e2e.test.mjs`
- `src/email/adapter.test.mjs`
- `src/email/email.test.mjs`
- `src/email/provider-foundation.test.mjs`
- `src/intelligence/v1-completion.test.mjs` (migration-order test updated to classify the new Email migration correctly)
- `supabase/tests/email_phase4f_validation.test.sql`
- `supabase/tests/run_intelligence_auth.sh`

`npm test` on Node v22.16.0:

- **943 passed**
- **0 failed**
- **0 skipped**

Email-focused suite:

- **158 passed**
- **0 failed**
- **0 skipped**

The recovery regression simulates provider acceptance, three failed synchronous persistence attempts, then a signed-webhook-shaped event. It verifies provider ID recovery, status transition, one CRM activity and no second provider call.

## Provider scope limitation

The production `BUILTIN_ADAPTERS` registry currently contains the Resend adapter only. The second-provider dispatch path was exercised with a test-only fake adapter. This validates provider selection, not a live Gmail, Zoho or SMTP integration.

## Environment and deployment limitations

The extracted repository has no installed `node_modules`; the production build was not run. PostgreSQL client/server tools (`psql`, `pg_ctl`) and Deno are unavailable, so SQL integration tests and Edge Function type/runtime validation could not be executed in this environment.

No Supabase migration was applied, no Edge Function was deployed, and no live provider request was made.

## Files changed in this corrective update

- `supabase/functions/_shared/email_adapter.ts`
- `supabase/functions/_shared/email_adapter_resend.ts`
- `supabase/functions/_shared/email_resend_logic.ts`
- `supabase/functions/_shared/email_resend_store.ts`
- `supabase/migrations/20261213100000_email_accepted_send_reconciliation.sql` (new)
- `supabase/tests/email_phase4f_validation.test.sql`
- `supabase/tests/run_intelligence_auth.sh`
- `src/email/adapter.test.mjs`
- `src/email/email.test.mjs`
- `src/email/phase-4f.e2e.test.mjs`
- `src/email/provider-foundation.test.mjs`
- `src/intelligence/v1-completion.test.mjs`
- `docs/EMAIL_PHASE_4F_VALIDATION.md`
- `PHASE_4F_HANDOFF_REPORT_MULTI_PROVIDER.md`

## Approval

The previously confirmed accepted-send recovery gap is corrected in source and covered by controlled regression tests. Phase 4F is **not yet production-approved** until:

1. The complete PostgreSQL 16 migration/test runner passes.
2. The production build succeeds.
3. Both `email-send` and `resend-webhook` Edge Functions are deployed in a controlled environment.
4. Resend webhook subscriptions include the accepted-message lifecycle events listed above.
5. Provider acceptance, persistence outage recovery, duplicate prevention, CRM recovery, delivery ordering and Inbox history are verified with controlled accounts.
