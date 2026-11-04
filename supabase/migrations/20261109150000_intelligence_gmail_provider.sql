-- KairFlow Intelligence: Gmail as a second mail provider (free alternative to Zoho). Additive and re-runnable.
-- One mailbox per studio: connecting Gmail replaces a Zoho connection (and vice versa); the worker is told which one to expect
-- with KAIRFLOW_MAIL_PROVIDER and the token functions refuse a mismatch. Nothing is sent by applying this migration.
-- Column names such as zoho_message_id keep their historical names; for Gmail they hold the Gmail message id.
begin;

do $$ begin
  if to_regclass('public.intel_mail_account') is null or to_regclass('public.intel_oauth_states') is null then
    raise exception 'Apply the earlier Intelligence migrations first';
  end if;
end $$;

alter table public.intel_mail_account drop constraint if exists intel_mail_account_provider_check;
alter table public.intel_mail_account add constraint intel_mail_account_provider_check check (provider in ('zoho', 'gmail'));

alter table public.intel_oauth_states add column if not exists provider text not null default 'zoho';
alter table public.intel_oauth_states drop constraint if exists intel_oauth_states_provider_check;
alter table public.intel_oauth_states add constraint intel_oauth_states_provider_check check (provider in ('zoho', 'gmail'));
alter table public.intel_oauth_states drop constraint if exists intel_oauth_states_data_center_check;
alter table public.intel_oauth_states add constraint intel_oauth_states_data_center_check
  check (data_center in ('com','eu','in','com.au','jp','ca','sa','com.cn','google'));

create or replace function public.intel_admin_set_kill_switch(p_on boolean) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_admin_org(); s public.intel_settings;
begin
  select * into s from public.intel_settings where organization_id = v_org for update;
  if not found then raise exception 'Run setup first (intel_admin_bootstrap)'; end if;
  if p_on is false then
    if s.sender_email = '' or s.physical_address = '' or btrim(s.opt_out_text) = '' then
      raise exception 'Set sender email, physical address and opt-out text before enabling sending';
    end if;
    if not exists (select 1 from public.intel_mail_account a where a.organization_id = v_org and a.status = 'connected') then
      raise exception 'Connect your mailbox (Gmail or Zoho Mail) in Settings before enabling sending';
    end if;
    if s.agent_user_id is null then raise exception 'Register the agent identity before enabling sending'; end if;
  end if;
  update public.intel_settings
     set kill_switch = p_on,
         warmup_started_on = case when p_on is false and warmup_started_on is null then public._intel_today(v_org) else warmup_started_on end,
         updated_at = now(), updated_by = auth.uid()
   where organization_id = v_org;
  perform public._intel_log(v_org, 'admin', case when p_on then 'kill_switch_on' else 'kill_switch_off' end, 'settings', v_org::text, '{}'::jsonb);
  return jsonb_build_object('kill_switch', p_on);
end $$;

create or replace function public.intel_admin_mail_status() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_admin_org();
begin
  return coalesce((select jsonb_build_object('status', a.status, 'provider', a.provider, 'data_center', a.data_center, 'mailbox', a.mailbox, 'scope', a.scope,
                                             'connected_at', a.connected_at, 'last_sync_at', a.last_sync_at, 'last_error', a.last_error)
                     from public.intel_mail_account a where a.organization_id = v_org),
                  jsonb_build_object('status', 'disconnected'));
end $$;

commit;

-- Rollback (only while no Gmail connection exists):
--   alter table public.intel_mail_account drop constraint intel_mail_account_provider_check;
--   alter table public.intel_mail_account add constraint intel_mail_account_provider_check check (provider = 'zoho');
