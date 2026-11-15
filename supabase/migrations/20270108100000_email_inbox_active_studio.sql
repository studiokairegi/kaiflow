-- Inbox follows the studio the person is working in.
-- Problem: public.email_require_access() chose ONE studio for a Master User who belongs to several (the one with email accounts, then the oldest),
-- ignoring the studio selected in the app header. The Inbox, the unread badge and email-send could therefore show and send from another studio.
-- Fix: the app records the selected studio per user (email_set_active_organization) and email_require_access() prefers it while that person is
-- still an active Master User of it. With no record (or a lapsed membership) the previous choice applies, so nothing changes for single-studio users.
-- The record is per user, not per browser tab: with two tabs on different studios the most recently synced one wins until the other tab regains focus.
begin;

do $$ begin
  if to_regprocedure('public.email_has_access()') is null or to_regprocedure('public.email_can_access(uuid)') is null
     or to_regclass('public.studio_organizations') is null or to_regclass('public.studio_memberships') is null then
    raise exception 'Apply 20261216090000_email_independent_access.sql first';
  end if;
end $$;

create table if not exists public.email_active_organization (
  user_id uuid primary key references auth.users(id) on delete cascade,
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  updated_at timestamptz not null default now()
);
alter table public.email_active_organization enable row level security;       -- no policies: reachable only through the functions below
revoke all on table public.email_active_organization from public, anon, authenticated;

create or replace function public.email_set_active_organization(p_organization_id uuid) returns uuid
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if p_organization_id is null or not public.email_can_access(p_organization_id) then
    raise exception 'Email is restricted.' using errcode = '42501';           -- admin AND active Master User of THAT studio
  end if;
  insert into public.email_active_organization (user_id, organization_id, updated_at)
  values (v_uid, p_organization_id, now())
  on conflict (user_id) do update set organization_id = excluded.organization_id, updated_at = now();
  return p_organization_id;
end $$;
revoke all on function public.email_set_active_organization(uuid) from public, anon;
grant execute on function public.email_set_active_organization(uuid) to authenticated;

create or replace function public.email_require_access() returns uuid
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_uid uuid := auth.uid(); v uuid;
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if not public.email_has_access() then raise exception 'Email is restricted.' using errcode = '42501'; end if;
  -- 1. The studio the person selected, only while the Master User membership is still active.
  select m.organization_id into v
    from public.email_active_organization a
    join public.studio_memberships m on m.user_id = a.user_id and m.organization_id = a.organization_id
                                    and m.role = 'master_user' and m.status = 'active'
   where a.user_id = v_uid;
  -- 2. Otherwise the previous rule (unchanged).
  if v is null then
    select m.organization_id into v
      from public.studio_memberships m
     where m.user_id = v_uid and m.role = 'master_user' and m.status = 'active'
     order by exists (select 1 from public.email_accounts a where a.organization_id = m.organization_id) desc, m.created_at
     limit 1;
  end if;
  if v is null then raise exception 'Email is restricted.' using errcode = '42501'; end if;
  return v;
end $$;
revoke all on function public.email_require_access() from public, anon;
grant execute on function public.email_require_access() to authenticated;

commit;

-- Rollback (restores the previous studio choice; the table can stay or be dropped):
--   create or replace function public.email_require_access() returns uuid language plpgsql stable security definer set search_path = pg_catalog, public as $f$
--   declare v_uid uuid := auth.uid(); v uuid; begin
--     if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
--     if not public.email_has_access() then raise exception 'Email is restricted.' using errcode = '42501'; end if;
--     select m.organization_id into v from public.studio_memberships m where m.user_id = v_uid and m.role = 'master_user' and m.status = 'active'
--      order by exists (select 1 from public.email_accounts a where a.organization_id = m.organization_id) desc, m.created_at limit 1;
--     if v is null then raise exception 'Email is restricted.' using errcode = '42501'; end if; return v; end $f$;
--   drop function if exists public.email_set_active_organization(uuid);
--   drop table if exists public.email_active_organization;
