-- KairFlow Intelligence: strict authorization (Admin AND Master User).
--
-- Rule (both halves are mandatory; neither can substitute for the other):
--     auth.uid() is not null
--     AND user_settings.is_admin is true                       (for that same user)
--     AND an ACTIVE studio_memberships row with role = 'master_user'   (for that same user)
--
-- This migration installs the privileged-field guard and adds authorization functions.
-- It creates no tables, changes no existing user rows or roles, and does not touch
-- payments_is_admin(), chat_is_org_master() or any existing policy.
-- Safe to run more than once. Apply to production only after review.
--
-- How the rest of Intelligence must use it (no Intelligence table exists yet):
--   * Every Intelligence table: enable RLS, revoke all from anon/authenticated, then add policies
--     whose USING / WITH CHECK is  public.intel_is_authorized(organization_id)  (or the no-arg form
--     for tables without an organization column). Never a policy that only checks is_admin or
--     only checks Master User.
--   * Every user-facing Intelligence RPC: SECURITY DEFINER, and its first statement is
--     perform public.intel_require_authorized();
--   * The worker's own identity is separate (intel_agent_* functions, added later). It must not
--     be given EXECUTE on user-facing RPCs and does not make anyone else authorized.
--   * Edge Functions: authenticate the caller's JWT and call intel_is_authorized() with THAT
--     JWT before any service-role work (see supabase/functions/_shared/intel_auth.ts).
--     Under the service-role key auth.uid() is null, so these functions return false.

begin;

-- Install the privileged-field trigger before exposing any Intelligence authorization
-- function. Without this prerequisite, a signed-in user could self-set is_admin.
create or replace function public.protect_privileged_user_settings()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.is_admin := false;
    new.plan := 'free';
  else
    new.is_admin := old.is_admin;
    new.plan := old.plan;
  end if;
  return new;
end;
$$;
revoke all on function public.protect_privileged_user_settings() from public, anon, authenticated;
drop trigger if exists trg_protect_privileged_user_settings on public.user_settings;
create trigger trg_protect_privileged_user_settings
before insert or update on public.user_settings
for each row execute function public.protect_privileged_user_settings();

do $$
begin
  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where t.tgname = 'trg_protect_privileged_user_settings'
      and n.nspname = 'public' and c.relname = 'user_settings'
      and not t.tgisinternal and t.tgenabled in ('O','A')
  ) then
    raise exception 'Privileged user_settings guard is not enabled';
  end if;
end;
$$;

-- 1. Organization-scoped check: the strict rule, with the Master membership required in the
--    SPECIFIC studio that owns the data. Use this in RLS for any table that has organization_id.
create or replace function public.intel_is_authorized(p_organization_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or p_organization_id is null then return false; end if;
  return exists (
           select 1 from public.user_settings s
            where s.user_id = v_uid and s.is_admin is true
         )
     and exists (
           select 1 from public.studio_memberships m
            where m.user_id = v_uid
              and m.organization_id = p_organization_id
              and m.role = 'master_user'
              and m.status = 'active'
         );
exception when others then
  return false; -- fail closed: anything unexpected is a denial, never an allow
end;
$$;

-- 2. Same rule without an organization: an active Master User membership in ANY studio.
--    Used by the navigation check and by objects that have no organization column.
create or replace function public.intel_is_authorized()
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return false; end if;
  return exists (
           select 1 from public.user_settings s
            where s.user_id = v_uid and s.is_admin is true
         )
     and exists (
           select 1 from public.studio_memberships m
            where m.user_id = v_uid
              and m.role = 'master_user'
              and m.status = 'active'
         );
exception when others then
  return false;
end;
$$;

-- 3. Guard for privileged RPCs. Returns the caller's id. The message deliberately does not say
--    which half of the rule failed.
create or replace function public.intel_require_authorized()
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not public.intel_is_authorized() then
    raise exception 'KairFlow Intelligence is restricted.' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

-- 4. Only signed-in users may call these; anonymous and PUBLIC may not.
revoke all on function public.intel_is_authorized(uuid) from public, anon;
revoke all on function public.intel_is_authorized() from public, anon;
revoke all on function public.intel_require_authorized() from public, anon;
grant execute on function public.intel_is_authorized(uuid) to authenticated;
grant execute on function public.intel_is_authorized() to authenticated;
grant execute on function public.intel_require_authorized() to authenticated;

-- 5. Safety net. is_admin cannot be self-granted ONLY if trg_protect_privileged_user_settings
--    (migration_security_hardening.sql) is installed. Warn loudly if it is not. This never
--    changes data and does not stop the migration.
do $$
begin
  if not exists (
    select 1 from pg_trigger
     where tgname = 'trg_protect_privileged_user_settings' and not tgisinternal
  ) then
    raise warning 'trg_protect_privileged_user_settings is NOT installed: users could set their own is_admin. Apply migration_security_hardening.sql before relying on Intelligence authorization.';
  end if;
end $$;

commit;

-- Rollback (manual):
--   drop function if exists public.intel_require_authorized();
--   drop function if exists public.intel_is_authorized();
--   drop function if exists public.intel_is_authorized(uuid);
