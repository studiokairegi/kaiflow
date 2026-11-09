-- Phase 13: account-scoped inbound synchronization for the multi-account provider registry.
-- The legacy intel_mail_account singleton remains a migration fallback only.
begin;

-- Fail with a useful prerequisite error rather than leaving a function that
-- cannot run on installations missing the Phase 2/Phase 10 account registry.
do $$
declare v_missing text[];
begin
  if to_regclass('public.intel_provider_accounts') is null
     or to_regclass('public.intel_email_provider_registry') is null then
    raise exception 'Apply the provider registry and Phase 10 schema-alignment migrations before Phase 13';
  end if;
  select array_agg(required.column_name order by required.column_name) into v_missing
    from (values
      ('intel_provider_accounts','id'), ('intel_provider_accounts','organization_id'),
      ('intel_provider_accounts','provider_key'), ('intel_provider_accounts','mailbox'),
      ('intel_provider_accounts','status'), ('intel_provider_accounts','is_enabled'),
      ('intel_provider_accounts','sync_cursor'), ('intel_provider_accounts','last_sync_at'),
      ('intel_provider_accounts','updated_at'), ('intel_email_provider_registry','provider_key'),
      ('intel_email_provider_registry','enabled')
    ) required(table_name,column_name)
   where not exists (
     select 1 from pg_attribute a
      where a.attrelid = to_regclass('public.' || required.table_name)
        and a.attname = required.column_name and a.attnum > 0 and not a.attisdropped
   );
  if coalesce(cardinality(v_missing),0) > 0 then
    raise exception 'Phase 13 provider schema is incomplete: %', array_to_string(v_missing, ', ');
  end if;
end;
$$;

create or replace function public.intel_agent_receive_accounts()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org uuid := public.intel_agent_org();
  v_accounts jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id,
    'provider_key', a.provider_key,
    'mailbox', a.mailbox,
    'status', a.status,
    'is_enabled', a.is_enabled,
    'registry_enabled', coalesce(r.enabled, false),
    'receive_enabled', (a.status = 'connected' and a.is_enabled is true and coalesce(r.enabled, false)),
    'sync_cursor', coalesce(a.sync_cursor, '{}'::jsonb)
  ) order by a.created_at, a.id), '[]'::jsonb)
    into v_accounts
    from public.intel_provider_accounts a
    left join public.intel_email_provider_registry r
      on r.provider_key = a.provider_key
   where a.organization_id = v_org
     and a.provider_key in ('gmail', 'zoho');
  return v_accounts;
end;
$$;

create or replace function public.intel_agent_receive_sync_state(
  p_account_id uuid,
  p_set jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org uuid := public.intel_agent_org();
  v_cursor jsonb;
begin
  if p_set is not null then
    update public.intel_provider_accounts
       set sync_cursor = p_set,
           last_sync_at = now(),
           updated_at = now()
     where organization_id = v_org
       and id = p_account_id
       and provider_key in ('gmail', 'zoho')
       and status = 'connected'
       and is_enabled is true;
    if not found then
      raise exception 'receive account is unavailable' using errcode = '42501';
    end if;
  end if;

  select coalesce(a.sync_cursor, '{}'::jsonb)
    into v_cursor
    from public.intel_provider_accounts a
   where a.organization_id = v_org
     and a.id = p_account_id
     and a.provider_key in ('gmail', 'zoho')
     and a.status = 'connected'
     and a.is_enabled is true;
  if not found then
    raise exception 'receive account is unavailable' using errcode = '42501';
  end if;
  return v_cursor;
end;
$$;

revoke all on function public.intel_agent_receive_accounts() from public, anon;
revoke all on function public.intel_agent_receive_sync_state(uuid, jsonb) from public, anon;
grant execute on function public.intel_agent_receive_accounts() to authenticated;
grant execute on function public.intel_agent_receive_sync_state(uuid, jsonb) to authenticated;

commit;
