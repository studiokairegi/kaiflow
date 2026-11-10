-- KairFlow Email: independent authorization (audit finding KF-01). NEW, ADDITIVE, re-runnable migration.
--
-- Problem: public.email_can_access / email_has_access / email_require_access (20261110090000) delegated to
-- public.intel_is_authorized() / public.intel_admin_org(), so any change to Intelligence authorization silently changed who can use
-- general Email, and Intelligence had to be installed before Email.
--
-- Fix: the three Email access functions now evaluate the rule themselves from base tables only
-- (user_settings.is_admin AND an active studio_memberships row with role = 'master_user'). The rule is IDENTICAL today, so no one gains
-- or loses access when this is applied, but it is now owned by Email: widening or narrowing Intelligence no longer moves it.
--
-- Organization choice for users who are Master User in several studios: previously intel_admin_org() preferred a studio that has
-- intel_settings. Email now prefers a studio that already has an email account, then the oldest membership. Single-studio users see no change.
--
-- Not touched: any intel_* object, public.email_provider_flags (Intelligence owns it), every email_* table, policy and RPC body
-- (they call these three functions by name, so they pick the new behaviour automatically). Nothing is sent by applying this.
begin;

do $$ begin
  if to_regclass('public.email_accounts') is null
     or to_regclass('public.user_settings') is null
     or to_regclass('public.studio_memberships') is null then
    raise exception 'Apply 20261110090000_email_resend_core.sql first (needs email_accounts, user_settings, studio_memberships)';
  end if;
end $$;

-- 1. Organization-scoped check (used by RLS policies and the attachment storage policy).
create or replace function public.email_can_access(p_organization_id uuid) returns boolean
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null or p_organization_id is null then return false; end if;
  return exists (select 1 from public.user_settings s where s.user_id = v_uid and s.is_admin is true)
     and exists (select 1 from public.studio_memberships m
                  where m.user_id = v_uid and m.organization_id = p_organization_id
                    and m.role = 'master_user' and m.status = 'active');
exception when others then
  return false;                                  -- fail closed
end $$;
revoke all on function public.email_can_access(uuid) from public, anon;
grant execute on function public.email_can_access(uuid) to authenticated;

-- 2. Organization-less check (navigation, registry policy, edge-function pre-check).
create or replace function public.email_has_access() returns boolean
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return false; end if;
  return exists (select 1 from public.user_settings s where s.user_id = v_uid and s.is_admin is true)
     and exists (select 1 from public.studio_memberships m
                  where m.user_id = v_uid and m.role = 'master_user' and m.status = 'active');
exception when others then
  return false;
end $$;
revoke all on function public.email_has_access() from public, anon;
grant execute on function public.email_has_access() to authenticated;

-- 3. Guard for Email RPCs: raises for anyone not allowed, returns the studio the caller works in.
create or replace function public.email_require_access() returns uuid
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_uid uuid := auth.uid(); v uuid;
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if not public.email_has_access() then raise exception 'Email is restricted.' using errcode = '42501'; end if;
  select m.organization_id into v
    from public.studio_memberships m
   where m.user_id = v_uid and m.role = 'master_user' and m.status = 'active'
   order by exists (select 1 from public.email_accounts a where a.organization_id = m.organization_id) desc, m.created_at
   limit 1;
  if v is null then raise exception 'Email is restricted.' using errcode = '42501'; end if;
  return v;
end $$;
revoke all on function public.email_require_access() from public, anon;
grant execute on function public.email_require_access() to authenticated;

commit;

-- OWNER NOTES (not executed)
--   * Fresh installs: 20261110090000 still checks that the Intelligence migrations exist before it runs. That historical file is not edited here;
--     after this migration the Email functions no longer call any intel_* function at run time.
-- Rollback (restores the previous delegation to Intelligence):
--   create or replace function public.email_can_access(p_organization_id uuid) returns boolean language sql stable security definer set search_path = pg_catalog, public as $f$ select public.intel_is_authorized(p_organization_id) $f$;
--   create or replace function public.email_has_access() returns boolean language sql stable security definer set search_path = pg_catalog, public as $f$ select public.intel_is_authorized() $f$;
--   create or replace function public.email_require_access() returns uuid language plpgsql stable security definer set search_path = pg_catalog, public as $f$ begin return public.intel_admin_org(); end $f$;
