-- Phase 2.6: reviewed SMTP submission adapter. Credentials remain encrypted at rest.
-- SMTP is send-only; inbound IMAP and mailbox reconciliation are intentionally deferred.
begin;
insert into public.intel_email_provider_registry
  (provider_key, adapter_key, display_name, adapter_version, manifest, enabled, sending_enabled)
values
  ('smtp', 'smtp', 'SMTP', '1.0.0',
   '{"capabilities":["send","connection-test","rfc-message-id"],"auth_methods":["smtp_password"],"supports_multiple_accounts":true,"message_purposes":["business_correspondence","consented_prospecting"],"receive":false,"sending_enabled":false}'::jsonb,
   true, false)
on conflict (provider_key) do update set
  adapter_key=excluded.adapter_key, display_name=excluded.display_name,
  adapter_version=excluded.adapter_version, manifest=excluded.manifest,
  enabled=true, sending_enabled=false, updated_at=now();
commit;
