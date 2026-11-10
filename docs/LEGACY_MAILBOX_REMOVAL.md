# Removing the legacy single-mailbox Gmail/Zoho path

Migration: `supabase/migrations/20261217090000_intelligence_remove_legacy_mailbox.sql`

The provider-account registry (`intel_provider_accounts`) is now the only source of truth for Gmail, Zoho Mail and SMTP.
Resend is separate and untouched.

## What the migration does
1. Runs a final idempotent backfill of any legacy `intel_mail_account` row into the registry and **aborts** if any
   connected legacy credential is not present there afterwards.
2. Drops the legacy sync trigger/function, the `intel_agent_sync_state` RPC, `intel_oauth_states` and `intel_mail_account`.
3. Replaces `intel_admin_mail_status`, `intel_admin_disconnect_mail` and `intel_agent_assign_provider_account`
   with registry-only versions (same grants).

It does not change kill_switch, autonomy, provider gates or any `send_enabled` flag. Backfilled accounts stay
`is_enabled = false` and `send_enabled = false`; enable them in Settings.

## Deploy order
1. Stop the worker (it must not run the old code against the new schema).
2. Apply the migration: `supabase db push`.
3. Deploy the new worker code, then start it.
4. Delete the old deployed functions: `supabase functions delete intel-gmail-connect intel-gmail-callback intel-gmail-token intel-zoho-connect intel-zoho-callback intel-zoho-token`.
5. Deploy the frontend. Reconnect accounts from Settings if you want fresh credentials.
