# Phase 4F — Confirmed Bug Fix Report

**Outcome:** The previously confirmed accepted-provider-message recovery defect and delivery-status race have been corrected in source. Full Node regression suite passes.

## Confirmed bugs fixed

1. **Accepted message stranded in `sending`:** The Resend adapter now sends a server-generated `kf_message_id` tag. Signed Resend webhook events can reconcile that tag to the original persisted outbound row, validate sender/account/recipient/subject evidence, attach the provider message ID, apply the delivery state and record the CRM activity transactionally. The webhook recovery path never submits another email.
2. **CRM activity skipped after post-acceptance database outage:** The reconciliation RPC invokes `email_record_crm_activity()` after it proves acceptance. A failed CRM write rolls back and leaves the signed webhook retryable.
3. **Late `sent` update downgrades `delivered`:** `email_mark_provider_accepted()` uses `_email_status_rank()` to preserve a more advanced state.
4. **Phase 4E Inbox counter trigger defect:** Preserved the Phase 4F counter-repair migration that declares `v_at`, recalculates unread counts and fixes whitespace normalization.

## New migration

`supabase/migrations/20261213100000_email_accepted_send_reconciliation.sql`

Adds service-role-only RPCs:

- `email_mark_provider_accepted(uuid,text,timestamptz)`
- `email_reconcile_tagged_delivery_event(uuid,text,text,text,timestamptz,jsonb,text,text[],text)`

No email is sent by applying the migration. It does not delete messages.

## Regression results

| Suite | Passed | Failed | Skipped |
|---|---:|---:|---:|
| Full repository `npm test` | **943** | 0 | 0 |
| Email-focused suite | **158** | 0 | 0 |

The accepted-send outage regression simulates a provider acceptance followed by repeated DB write failures, then delivers the corresponding tagged webhook. It verifies that the original message row is repaired, CRM activity is created once and provider send count remains one.

## Deployment prerequisites and remaining verification

- Configure Resend webhook events `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced` and `email.complained` on the existing signed webhook endpoint.
- Apply migrations in order through `20261213100000_email_accepted_send_reconciliation.sql`.
- Deploy updated `email-send` and `resend-webhook` Edge Functions.
- Run PostgreSQL 16 integration tests and production build.
- Test with controlled accounts before production release.

`psql`, Deno and installed frontend dependencies are unavailable in this environment. SQL execution, Edge Function runtime/type-check and production build therefore remain unverified. No migration or deployment was performed and no real prospect email was sent.

## Provider limitation

Resend is the only installed production adapter. The second provider used in dispatch tests is a fake test adapter, not a live Gmail, Zoho or SMTP integration.

## Approval

The source-level confirmed bugs are fixed. Phase 4F remains **pending deployment verification**, not production-approved.
