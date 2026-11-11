-- Phase 8 hotfix: the shared lock trigger function is installed on both
-- intel_suppressions and intel_contact_permissions.  The suppression row type
-- has no purpose column, so the function must branch by trigger table before
-- dereferencing NEW/OLD fields.
begin;

create or replace function public._intel_phase8_lock_policy_key()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_old_key bigint;
  v_new_key bigint;
begin
  if tg_op <> 'INSERT' then
    if tg_table_name = 'intel_suppressions' then
      v_old_key := hashtextextended(old.organization_id::text || ':suppression:' || old.kind || ':' || old.value, 0);
    elsif tg_table_name = 'intel_contact_permissions' then
      v_old_key := hashtextextended(old.organization_id::text || ':permission:' || old.purpose || ':' || old.email, 0);
    else
      raise exception 'unsupported table for _intel_phase8_lock_policy_key: %', tg_table_name;
    end if;
  end if;

  if tg_op <> 'DELETE' then
    if tg_table_name = 'intel_suppressions' then
      v_new_key := hashtextextended(new.organization_id::text || ':suppression:' || new.kind || ':' || new.value, 0);
    elsif tg_table_name = 'intel_contact_permissions' then
      v_new_key := hashtextextended(new.organization_id::text || ':permission:' || new.purpose || ':' || new.email, 0);
    else
      raise exception 'unsupported table for _intel_phase8_lock_policy_key: %', tg_table_name;
    end if;
  end if;

  if v_old_key is not null and v_new_key is not null then
    if v_old_key <= v_new_key then
      perform pg_advisory_xact_lock(v_old_key);
      if v_new_key <> v_old_key then perform pg_advisory_xact_lock(v_new_key); end if;
    else
      perform pg_advisory_xact_lock(v_new_key);
      perform pg_advisory_xact_lock(v_old_key);
    end if;
  elsif v_old_key is not null then
    perform pg_advisory_xact_lock(v_old_key);
  elsif v_new_key is not null then
    perform pg_advisory_xact_lock(v_new_key);
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public._intel_phase8_lock_policy_key() from public, anon, authenticated;

drop trigger if exists intel_phase8_suppression_lock on public.intel_suppressions;
create trigger intel_phase8_suppression_lock
before insert or update or delete on public.intel_suppressions
for each row execute function public._intel_phase8_lock_policy_key();

drop trigger if exists intel_phase8_contact_permission_lock on public.intel_contact_permissions;
create trigger intel_phase8_contact_permission_lock
before insert or update or delete on public.intel_contact_permissions
for each row execute function public._intel_phase8_lock_policy_key();

commit;

-- Rollback: restore the prior function/trigger definition from
-- 20261128100000_intelligence_phase8_final_send_boundary.sql. This migration
-- does not drop application tables or delete message data.
