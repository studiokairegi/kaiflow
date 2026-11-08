# Phase 2.5 — Multi-account dispatch and policy enforcement

## Implemented

- Outbound messages receive a durable `provider_account_id` and `provider_key` before provider submission. Retries reuse that assignment rather than silently switching mailboxes.
- The worker resolves the installed adapter from the assigned account at send/reconciliation time. Adapter code remains installed/reviewed code; the database catalogue cannot execute or install arbitrary code.
- Account selection is organization-scoped, row-locked, purpose-aware, and skips locked accounts so concurrent workers do not pick the same mailbox simultaneously.
- Per-account rolling daily/hourly/minute quota accounting is atomic. New accounts receive conservative defaults of 25/day, 5/hour, and 1/minute. Quota exhaustion is re-queued after a short delay rather than treated as a delivery failure.
- The provider-wide sending gate and legacy provider pause flag both remain authoritative. Each account must also be connected, sync-enabled, send-enabled, and allow the message purpose. The organization kill switch and existing global caps/send-spacing remain in force.
- Prospecting (`initial` and `followup`) requires an active, exact-recipient `consented_prospecting` permission record with evidence metadata. Missing consent fails closed before the provider call.
- Business correspondence requires evidence of an inbound message from the exact recipient address. An admin can record/revoke an explicit permission through the new permission RPC; revocation invalidates prior grants for that exact address and purpose.
- Admin settings expose provider-wide sending gate, per-account send gate, prospecting-purpose permission, and conservative quota display. The account's default purpose remains business correspondence only.
- Resend remains excluded from the prospect dispatcher. Existing Resend transactional routes are unchanged.

## New migration

`supabase/migrations/20261125090000_intelligence_multi_account_dispatch.sql`

Apply only after reconciling the hosted Supabase migration history with the repository. The archive contains future-dated migrations and local changes; do not blindly push/replay them against production. The migration has not been executed against a live database in this environment.

## Safety / rollout

- New account send gates and the provider-wide registry gate default OFF.
- Enabling an account does not enable its provider; enabling the provider does not enable individual accounts.
- Prospecting remains blocked until a human records a documented permission basis for the exact recipient and explicitly allows the account's prospecting purpose.
- Existing global kill switch, human approval, suppression checks, business-hours rules, campaign caps, CRM address validation, and send-slot pacing remain in the existing reservation path.
- Messages with uncertain provider outcomes are still reconciled and never automatically resent.
- The final `mark_sending` transition rechecks the assigned account, account purpose, provider registry gate, legacy provider pause flag, and organization kill switch immediately before provider submission. Disabling a mailbox after assignment prevents the send.
- Existing legacy single-mailbox compatibility remains available only where no corresponding account-registry row exists. Once a mailbox is represented in the registry, its account-level controls cannot be bypassed by the legacy fallback.

## Verification

- Python worker suite: 390 tests pass.
- JavaScript suite: 767 tests pass.
- Python bytecode compilation passes.
- SQL migration, Supabase Edge Functions, and React production build were not executed here because PostgreSQL/Supabase/Deno/Vite deployment tooling and live credentials are unavailable. No accounts were enabled, no credentials were changed, and no email was sent during this work.

## Remaining follow-up

- Live migration validation against a staging database, including concurrency tests for account assignment and rolling quotas.
- End-to-end Gmail OAuth, send, Sent reconciliation, and inbound-thread tests with a dedicated test mailbox.
- Phase 2.6 SMTP adapter foundation and Phase 2.7 account-scoped Zoho adapter have since been added in separate increments.
