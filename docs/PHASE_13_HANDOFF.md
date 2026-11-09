# Phase 13 — Multi-account inbound synchronization

## Purpose

The outbound dispatcher already assigns each message to a durable Gmail/Zoho/SMTP account. Before this phase, inbound synchronization still used the legacy `intel_mail_account` singleton cursor and only the configured fallback adapter. This left replies arriving in secondary mailboxes outside the Intelligence conversation pipeline.

## Changes

- Added `intel_agent_receive_accounts()`, which returns only the current agent organization's Gmail/Zoho account metadata. It reports `receive_enabled` separately from account existence so a disabled registry account cannot silently fall back to a legacy mailbox.
- Added `intel_agent_receive_sync_state(uuid, jsonb)`, which reads/updates one account's `sync_cursor` and `last_sync_at`. Both RPCs require the registered agent identity through `intel_agent_org()`.
- Emma now instantiates the installed adapter for each receive-enabled Gmail/Zoho account and synchronizes each inbox with its own overlap cursor.
- Inbound provider-local IDs are namespaced as `in:<provider>:<account-id>:<provider-message-id>` before entering the existing inbound idempotency RPC. This avoids collisions where two accounts use the same provider-local ID.
- Cursor advancement happens only after message persistence and classification-job enqueue complete. Repeated scans are safe through the existing idempotency constraints.
- Registry accounts are checked even when `KAIRFLOW_MAIL_PROVIDER=none`; the legacy fallback's disabled state must not block account-scoped mailbox synchronization.
- SMTP is explicitly send-only and does not run through the inbox sync handler. Connect Gmail or Zoho to synchronize replies.
- Resend remains a separate transactional integration and is not an Emma prospect-outreach adapter.

## Deployment

1. Back up the database and apply all pending migrations in timestamp order, including `20261203090000_intelligence_multi_account_inbox_sync.sql`.
2. Deploy the existing `intel-provider-token` Edge Function version compatible with the provider account registry.
3. Update/restart Emma with the matching worker code.
4. Keep the kill switch ON during acceptance.
5. Verify that every intended Gmail/Zoho account is connected, enabled, and has the provider registry enabled.

## Acceptance checks

- A connected/enabled Gmail account syncs inbound messages using its own cursor.
- A connected/enabled Zoho account syncs inbound messages using its own cursor.
- Identical provider-local message IDs in two different accounts create distinct inbound records.
- A disabled/disconnected registry account is not polled and does not activate the legacy singleton fallback.
- With `KAIRFLOW_MAIL_PROVIDER=none`, active registry accounts still sync.
- SMTP-only configuration reports that inbound sync is unavailable without attempting `list_messages`.
- A database failure during inbound persistence does not advance that account's cursor.
- Re-running the same mailbox scan does not create duplicate inbound messages or classification jobs.

## Not verified by this source patch

No production Supabase migration was applied, no Edge Function was deployed, and no real Gmail/Zoho account was contacted. Run the acceptance checks in staging before production rollout.
