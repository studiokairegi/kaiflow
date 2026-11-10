-- Phase 5 follow-up: renewable sync leases and provider-owned folder/deletion state.
-- Additive and service-role only. No message content or local user metadata is overwritten.
-- Rollback: drop the two service-only RPCs and the three provider-state columns; existing message content is untouched. Nothing here deletes messages.
begin;

alter table public.email_messages
  add column if not exists provider_folder_ids text[] not null default '{}',
  add column if not exists provider_is_deleted boolean not null default false,
  add column if not exists provider_updated_at timestamptz;

create or replace function public.email_renew_sync(
  p_account_id uuid, p_lease_token uuid, p_lease_seconds integer default 180
) returns boolean
language plpgsql security definer set search_path = pg_catalog, public as $$
declare n integer; v_lease integer := least(greatest(coalesce(p_lease_seconds,180),30),600);
begin
  update public.email_sync_state s
     set lease_expires_at = now() + make_interval(secs => v_lease)
    from public.email_accounts a
   where s.account_id = p_account_id and s.lease_token = p_lease_token
     and s.lease_expires_at > now() and a.id = s.account_id
     and a.status = 'active' and a.connection_status = 'connected';
  get diagnostics n = row_count;
  return n = 1;
end $$;
revoke all on function public.email_renew_sync(uuid,uuid,integer) from public, anon, authenticated;
grant execute on function public.email_renew_sync(uuid,uuid,integer) to service_role;

-- Reconcile only provider-owned state, scoped by account + provider + direction + provider ID.
-- Folder identifiers are opaque provider identifiers, not local folder records.
create or replace function public.email_reconcile_synced_message_state(
  p_account_id uuid, p_provider text, p_provider_message_id text, p_direction text,
  p_folder_ids text[] default '{}', p_is_deleted boolean default false,
  p_provider_updated_at timestamptz default null
) returns boolean
language plpgsql security definer set search_path = pg_catalog, public as $$
declare a public.email_accounts; n integer;
begin
  if coalesce(p_direction,'') not in ('inbound','outbound') or nullif(btrim(coalesce(p_provider_message_id,'')),'') is null or nullif(btrim(coalesce(p_provider,'')),'') is null then
    raise exception 'Invalid provider message identity' using errcode = '22023';
  end if;
  select * into a from public.email_accounts where id = p_account_id;
  if not found or a.provider <> lower(coalesce(p_provider,'')) or a.status <> 'active' then
    raise exception 'Mailbox account is not authorized' using errcode = '42501';
  end if;
  update public.email_messages
     set provider_folder_ids = coalesce((select array_agg(distinct x) from unnest(coalesce(p_folder_ids,'{}'::text[])) x where nullif(btrim(x),'') is not null), '{}'),
         provider_is_deleted = coalesce(p_is_deleted,false),
         provider_updated_at = coalesce(p_provider_updated_at,provider_updated_at)
   where account_id = p_account_id and organization_id = a.organization_id
     and provider = a.provider and direction = p_direction and provider_message_id = p_provider_message_id;
  get diagnostics n = row_count;
  return n = 1;
end $$;
revoke all on function public.email_reconcile_synced_message_state(uuid,text,text,text,text[],boolean,timestamptz) from public, anon, authenticated;
grant execute on function public.email_reconcile_synced_message_state(uuid,text,text,text,text[],boolean,timestamptz) to service_role;

commit;
