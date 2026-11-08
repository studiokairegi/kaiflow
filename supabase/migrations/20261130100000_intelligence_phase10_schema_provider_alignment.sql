-- Phase 10: align provider status and kill-switch prerequisites with the dynamic
-- Gmail/Zoho/SMTP account registry. Resend remains a separate transactional service.
begin;

-- Repair known additive schema drift in installations where the registry table was
-- created by an earlier partial rollout. These columns are already part of the
-- canonical Phase 2.1 schema; ADD IF NOT EXISTS is deliberately non-destructive.
do $$
declare
  v_missing text[];
begin
  if to_regclass('public.intel_provider_accounts') is null
     or to_regclass('public.intel_email_provider_registry') is null then
    raise exception 'Apply the Intelligence provider-registry migration before Phase 10';
  end if;

  -- These identity/relationship columns cannot be safely fabricated by an
  -- additive repair. Fail with an actionable message instead of allowing a
  -- later ALTER, RPC, or index statement to fail unpredictably.
  select array_agg(required.column_name order by required.column_name)
    into v_missing
    from (values
      ('intel_provider_accounts','id'),
      ('intel_provider_accounts','organization_id'),
      ('intel_provider_accounts','provider_key'),
      ('intel_provider_accounts','mailbox'),
      ('intel_provider_accounts','status'),
      ('intel_provider_accounts','created_at'),
      ('intel_email_provider_registry','provider_key'),
      ('intel_email_provider_registry','enabled'),
      ('intel_email_provider_registry','sending_enabled')
    ) as required(table_name, column_name)
   where not exists (
     select 1 from pg_attribute a
      where a.attrelid = to_regclass('public.' || required.table_name)
        and a.attname = required.column_name
        and a.attnum > 0 and not a.attisdropped
   );

  if coalesce(cardinality(v_missing), 0) > 0 then
    raise exception 'Phase 10 cannot repair missing provider identity columns: %. Restore the canonical Phase 2 provider-registry schema first.', array_to_string(v_missing, ', ');
  end if;

  -- Names alone are not enough: reject incompatible pre-existing definitions.
  -- This migration is additive and deliberately does not attempt destructive casts.
  if exists (
    select 1 from (values
      ('intel_provider_accounts','id','uuid'),
      ('intel_provider_accounts','organization_id','uuid'),
      ('intel_provider_accounts','provider_key','text'),
      ('intel_provider_accounts','mailbox','text'),
      ('intel_provider_accounts','status','text'),
      ('intel_provider_accounts','created_at','timestamp with time zone'),
      ('intel_email_provider_registry','provider_key','text'),
      ('intel_email_provider_registry','enabled','boolean'),
      ('intel_email_provider_registry','sending_enabled','boolean')
    ) expected(table_name, column_name, expected_type)
    join pg_attribute a
      on a.attrelid = to_regclass('public.' || expected.table_name)
     and a.attname = expected.column_name
     and a.attnum > 0 and not a.attisdropped
    join pg_type t on t.oid = a.atttypid
    where format_type(a.atttypid, a.atttypmod) <> expected.expected_type
  ) then
    raise exception 'Phase 10 found incompatible provider-registry column types. Restore the canonical Phase 2 provider-registry schema before applying this migration.';
  end if;
end $$;

alter table public.intel_provider_accounts
  add column if not exists display_name text not null default '',
  add column if not exists auth_method text not null default 'unknown',
  add column if not exists scopes text not null default '',
  add column if not exists data_center text not null default '',
  add column if not exists credentials_ciphertext text not null default '',
  add column if not exists credential_version smallint not null default 1,
  add column if not exists health_status text not null default 'unknown',
  add column if not exists is_enabled boolean not null default false,
  add column if not exists send_enabled boolean not null default false,
  add column if not exists allowed_message_purposes text[] not null default array['business_correspondence']::text[],
  add column if not exists daily_send_limit integer,
  add column if not exists hourly_send_limit integer,
  add column if not exists minute_send_limit integer,
  add column if not exists sync_cursor jsonb not null default '{}'::jsonb,
  add column if not exists last_sync_at timestamptz,
  add column if not exists last_health_check_at timestamptz,
  add column if not exists last_error text not null default '',
  add column if not exists connected_by uuid references auth.users(id) on delete set null,
  add column if not exists connected_at timestamptz not null default now(),
  add column if not exists disconnected_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

-- The legacy singleton table is a migration bridge only. The registry is the
-- authoritative account inventory for outbound messages.
create or replace function public.intel_admin_mail_status() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.intel_admin_org();
  v_accounts jsonb;
  v_legacy jsonb;
  v_count integer;
begin
  select count(*), coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id, 'provider', a.provider_key, 'provider_key', a.provider_key,
    'mailbox', a.mailbox, 'status', a.status, 'health_status', a.health_status,
    'is_enabled', a.is_enabled, 'send_enabled', a.send_enabled,
    'sending_eligible', coalesce((a.status = 'connected' and a.is_enabled and a.send_enabled
      and r.enabled and r.sending_enabled and a.health_status in ('unknown','healthy')), false),
    'provider_gate_enabled', r.enabled, 'provider_gate_sending_enabled', r.sending_enabled,
    'last_sync_at', a.last_sync_at, 'last_health_check_at', a.last_health_check_at,
    'last_error', a.last_error
  ) order by a.created_at), '[]'::jsonb)
    into v_count, v_accounts
    from public.intel_provider_accounts a
    left join public.intel_email_provider_registry r on r.provider_key = a.provider_key
   where a.organization_id = v_org;

  if v_count > 0 then
    return jsonb_build_object(
      'status', case when exists (
        select 1 from public.intel_provider_accounts a
         where a.organization_id = v_org and a.status = 'connected'
      ) then 'connected' else 'disconnected' end,
      'sending_eligible', exists (
        select 1 from public.intel_provider_accounts a
        join public.intel_email_provider_registry r on r.provider_key = a.provider_key
        where a.organization_id = v_org and a.provider_key in ('gmail','zoho','smtp')
          and a.status = 'connected' and a.is_enabled and a.send_enabled
          and r.enabled and r.sending_enabled and a.health_status in ('unknown','healthy')
      ),
      'provider', case when v_count = 1 then v_accounts->0->>'provider_key' else 'multiple' end,
      'mailbox', case when v_count = 1 then v_accounts->0->>'mailbox' else null end,
      'accounts', v_accounts,
      'source_of_truth', 'intel_provider_accounts'
    );
  end if;

  -- Preserve visibility for not-yet-migrated legacy installations; never use this
  -- singleton result to authorize a Phase 8 outbound message.
  select jsonb_build_object('status', a.status, 'provider', a.provider,
    'data_center', a.data_center, 'mailbox', a.mailbox, 'scope', a.scope,
    'connected_at', a.connected_at, 'last_sync_at', a.last_sync_at,
    'last_error', a.last_error, 'accounts', '[]'::jsonb,
    'source_of_truth', 'legacy_migration_bridge')
    into v_legacy
    from public.intel_mail_account a where a.organization_id = v_org;
  return coalesce(v_legacy, jsonb_build_object(
    'status', 'disconnected', 'accounts', '[]'::jsonb,
    'source_of_truth', 'intel_provider_accounts'
  ));
end $$;
revoke all on function public.intel_admin_mail_status() from public, anon;
grant execute on function public.intel_admin_mail_status() to authenticated;

-- Enabling the emergency-stop toggle is not provider activation. It merely refuses
-- to lift the stop unless at least one registered mailbox is actually eligible.
create or replace function public.intel_admin_set_kill_switch(p_on boolean) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_admin_org(); s public.intel_settings;
begin
  select * into s from public.intel_settings where organization_id = v_org for update;
  if not found then raise exception 'Run setup first (intel_admin_bootstrap)'; end if;
  if p_on is false then
    if nullif(btrim(coalesce(s.sender_email, '')), '') is null
       or nullif(btrim(coalesce(s.physical_address, '')), '') is null
       or nullif(btrim(coalesce(s.opt_out_text, '')), '') is null then
      raise exception 'Set sender email, physical address and opt-out text before enabling sending';
    end if;
    if s.agent_user_id is null then raise exception 'Register the agent identity before enabling sending'; end if;
    if not exists (
      select 1
        from public.intel_provider_accounts a
        join public.intel_email_provider_registry r on r.provider_key = a.provider_key
       where a.organization_id = v_org
         and a.provider_key in ('gmail','zoho','smtp')
         and a.status = 'connected' and a.is_enabled and a.send_enabled
         and r.enabled and r.sending_enabled
    ) then
      raise exception 'Enable at least one connected Gmail, Zoho Mail or SMTP account and its deployment provider gate before enabling sending';
    end if;
  end if;
  update public.intel_settings
     set kill_switch = p_on,
         warmup_started_on = case when p_on is false and warmup_started_on is null then public._intel_today(v_org) else warmup_started_on end,
         updated_at = now(), updated_by = auth.uid()
   where organization_id = v_org;
  perform public._intel_log(v_org, 'admin', case when p_on then 'kill_switch_on' else 'kill_switch_off' end, 'settings', v_org::text, '{}'::jsonb);
  return jsonb_build_object('kill_switch', p_on);
end $$;
revoke all on function public.intel_admin_set_kill_switch(boolean) from public, anon;
grant execute on function public.intel_admin_set_kill_switch(boolean) to authenticated;

commit;
