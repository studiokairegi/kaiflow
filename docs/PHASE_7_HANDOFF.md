# KairFlow Intelligence — Phase 7 Handoff

**Phase:** 7 — Delivery events, bounces and complaint processing  
**Status:** Central delivery-event reconciliation implemented locally; provider-specific event acquisition remains an adapter integration/configuration task.  
**Disposition:** Ready for reviewed staging migration and adapter-level verification. No database migration was applied, no webhook was configured, no worker was activated, and no live message was sent.

## 1. Delivery state model

The implementation deliberately separates the send workflow (`intel_messages.state`) from downstream delivery (`intel_messages.delivery_status`). A provider accepting a send changes the workflow state to `sent` and delivery state to `accepted`; it does **not** mean the recipient mailbox received it.

Canonical delivery statuses:

- `pending`
- `accepted`
- `delayed`
- `delivered`
- `failed`
- `bounced`
- `complained`

The database applies monotonic progression: accepted < delayed < delivered < failed < bounced < complained. Duplicate events are no-ops. A late delayed/delivered event cannot erase a bounce or complaint. A complaint can upgrade a bounce. Event timestamps are retained for audit, but event arrival order cannot regress a stronger status.

## 2. Changes

### Provider-neutral event ingestion

- Added `kairflow_intel.delivery_events` to normalize Gmail, Zoho, SMTP and future adapter event vocabularies to canonical states.
- Requires a stable provider event ID, provider key, exact provider account ID and provider message ID. Missing identity is rejected; the worker never invents event IDs.
- Reduces events to safe metadata. Raw message bodies, headers, credentials and arbitrary provider payloads are not sent to the database.
- Exposes `apply_event(rpc, event)` as the adapter ingestion contract. The service-role-only database RPC is the authoritative idempotency and reconciliation boundary.

### Database reconciliation

Added `supabase/migrations/20261127100000_intelligence_delivery_events.sql`:

- Adds separate `delivery_status`, `delivery_event_at`, `delivered_at` and `delivery_error` fields to `intel_messages`.
- Backfills existing confirmed sends as `accepted`, not `delivered`.
- Backfills generic `provider_message_id` from the legacy provider message column only when the provider/account assignment is complete and no same-org/provider ID collision exists. Ambiguous historical IDs are left untouched.
- Updates `intel_agent_confirm_send` to persist the provider-neutral message ID for dynamically assigned Gmail, Zoho and SMTP messages while retaining the legacy `zoho_message_id` field for existing threading/reconciliation code.
- Adds append-only-by-convention event receipts in `intel_delivery_events`, uniquely keyed by organization, provider, provider account and provider event ID. Identical event IDs from different mailboxes are isolated; reuse within one account for a different message is treated as a collision, not accepted as a duplicate.
- Adds `intel_agent_apply_delivery_event`, callable only by `service_role`. It matches outbound messages by exact organization/provider/account/provider-message ID and verifies that the account is registered to that provider, optionally validates the recipient, records the event once, applies monotonic status progression, and synchronizes the corresponding CRM email slot's `deliveryStatus`/`deliveryUpdatedAt` metadata.
- Bounce and complaint events add an exact-address `intel_suppressions` record. Suppression reasons use the existing contactability vocabulary (`bounce` / `complaint`), so Phase 5 contactability checks recognize them. Complaint upgrades an existing bounce marker, but preserves administrator/legal/other independent suppression reasons and their provenance.
- No domain-wide suppression is created from an individual recipient bounce or complaint.

### Scope and safety

- No provider fallback, automatic resend, account reassignment, quota change, kill-switch change or autonomy change.
- No Resend prospecting integration. The existing Resend transactional Inbox webhook remains separate.
- Zoho remains human-approved; no approval gate was weakened.
- CRM `sent` remains provider acceptance, while `deliveryStatus` records the downstream outcome. A bounce does not falsely turn a previously accepted send into a message that was never sent.

## 3. Files changed

- `intelligence-worker/kairflow_intel/delivery_events.py` (new)
- `intelligence-worker/tests/test_delivery_events.py` (new)
- `supabase/migrations/20261127100000_intelligence_delivery_events.sql` (new)
- `src/intelligence/phase7-delivery-events-contract.test.mjs` (new)
- `docs/PHASE_7_HANDOFF.md` (new)

## 4. Verification

- Python worker suite: **435 passed, 0 failed**.
- JavaScript suite (`npm test`): **787 passed, 0 failed**.
- Python compilation: passed (`python -m compileall -q intelligence-worker/kairflow_intel`).
- The worker test run prints some expected mocked/preflight environment diagnostics (including missing optional live Supabase RPC probes); the unittest suite itself completed successfully.
- No PostgreSQL server/client or SQL parser was available in this environment. The migration received source-level contract checks but was **not executed** against PostgreSQL. Apply to a disposable staging database first and run the SQL regression suite before production.

## 5. Provider event acquisition limitation

This phase supplies the shared, trusted ingestion and reconciliation contract, but it does not claim that all providers emit the same delivery webhooks:

- Gmail/Zoho adapter-specific delivery evidence must be normalized and submitted through `apply_event` after the provider-specific source has been authenticated/validated. Recipient DSNs may be available through mailbox synchronization, but no new Gmail/Zoho push subscription or DSN polling job was configured here.
- SMTP submission has no standard delivery webhook. SMTP delivery outcomes require a trusted DSN/relay integration (and, for mailbox-based DSN collection, an explicitly configured receiving/IMAP capability). SMTP acceptance alone remains `accepted`, never `delivered`.
- Provider event-source subscriptions, account credentials, and worker schedules must be reviewed and configured separately. Until an event is received, delivery status remains `accepted` or `pending`; it is not guessed.

## 6. Required staging checks before production

1. Apply all prior migrations through the provider-assignment integrity migration, then this Phase 7 migration, to a disposable staging database.
2. Confirm the migration's `intel_agent_confirm_send` signature and grants remain callable by the existing worker identity.
3. Use synthetic provider events for accepted → delayed → delivered, duplicate replay, delivered → delayed, delivered → bounced, bounced → delivered, and bounced → complained.
4. Verify an event ID collision across messages/accounts is rejected and recipient mismatch does not mutate message status or suppression state. Confirm that unmatched/mismatched events are not acknowledged as successful consumption.
5. Verify bounce/complaint suppressions are visible through `intel_agent_contactability_facts` and prevent subsequent send reservation.
6. Verify CRM email slot metadata updates without changing the original sent flag or creating a second send.
7. Connect each provider-specific event source only after its signature/authentication and stable event-ID contract has been verified.

## 8. Phase 7 bug-audit fixes

A follow-up audit found four confirmed defects; all four are corrected in this package:

1. **Account-scoped event idempotency:** event receipts now use `(organization_id, provider_key, provider_account_id, provider_event_id)`, and duplicate lookup uses the same key. Separate Gmail/Zoho accounts can safely reuse an event ID without suppressing one another's receipt.
2. **Fail-closed unmatched events:** the RPC returns `ok=false` for unmatched provider messages and recipient mismatches. The worker requires `ok=true`, `found=true`, and an explicit durable outcome (`applied` or `duplicate`) before acknowledging.
3. **Provider/account message identity:** the old organization-wide Resend/provider-message and legacy Zoho uniqueness indexes are removed and replaced with `(organization_id, provider_key, provider_account_id, provider_message_id)`. The account must also belong to the provider named by the event. A non-unique legacy Zoho lookup index remains for compatibility.
4. **Suppression provenance:** a complaint upgrades only an existing bounce/complaint marker. It does not overwrite administrator, legal, or unrelated suppression reasons or provenance.

Regression coverage was added for the worker acknowledgement contract and SQL source invariants. The SQL migration still requires execution against disposable PostgreSQL staging; source-contract tests are not a substitute for database execution.

## 9. Stop condition

Phase 7 central event reconciliation is implemented locally. Stop here; Phase 8 must not begin until separately requested. No staging or production activation is implied by this handoff.
