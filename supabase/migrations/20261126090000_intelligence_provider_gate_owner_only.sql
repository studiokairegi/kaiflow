-- Phase 2.8 release hardening: provider catalogue sending gates are deployment-owner controls.
-- The catalogue is global, so an organization administrator must never be able to change it.
-- Per-organization admins retain control of their own account is_enabled/send_enabled settings.
begin;

drop function if exists public.intel_admin_set_provider_sending_enabled(text,boolean);

-- Reassert the default-off state for all reviewed adapters during the initial rollout.
update public.intel_email_provider_registry
   set sending_enabled = false, updated_at = now()
 where provider_key in ('gmail','zoho','smtp');

commit;
