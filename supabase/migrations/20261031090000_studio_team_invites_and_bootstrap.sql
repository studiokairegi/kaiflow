-- KairFlow: cohesive Teams onboarding, one-time invitations, and new-owner bootstrap.
-- Additive only. Run after chat_collaboration and studio_multiuser_core have been
-- verified on a staging database. It does not modify existing applied migrations.

begin;

create extension if not exists pgcrypto with schema extensions;

do $$
begin
  if to_regclass('public.team_members') is null then
    raise exception 'KairFlow Teams prerequisite missing: public.team_members must exist before team invite onboarding can be installed.';
  end if;
end $$;

alter table public.studio_memberships
  add column if not exists team_member_id uuid references public.team_members(id) on delete set null;
create unique index if not exists studio_memberships_org_team_member_unique_idx
  on public.studio_memberships(organization_id, team_member_id) where team_member_id is not null;

alter table public.studio_project_members
  add column if not exists grant_source text not null default 'manual';
do $$ begin
  if not exists (select 1 from pg_constraint where conname='studio_project_members_grant_source_check') then
    alter table public.studio_project_members add constraint studio_project_members_grant_source_check
      check (grant_source in ('manual','shot_assignment'));
  end if;
end $$;

create table if not exists public.studio_member_invites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  team_member_id uuid not null references public.team_members(id) on delete cascade,
  invited_email text not null check (char_length(invited_email) between 3 and 254),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 80),
  role text not null check (role in ('staff','department_admin','freelancer')),
  department_id uuid,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending','accepted','revoked','expired')),
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_by uuid not null references auth.users(id) on delete restrict,
  accepted_user_id uuid references auth.users(id) on delete set null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, department_id)
    references public.studio_departments(organization_id, id) on delete restrict
);
create index if not exists studio_member_invites_org_status_idx
  on public.studio_member_invites(organization_id, status, created_at desc);
create index if not exists studio_member_invites_team_member_idx
  on public.studio_member_invites(team_member_id, status, created_at desc);
alter table public.studio_member_invites enable row level security;
revoke all on public.studio_member_invites from public, anon, authenticated;

create or replace function public.studio_hash_invite_token(p_token text)
returns text language sql immutable security definer
set search_path = pg_catalog, public, extensions
as $$
  select encode(digest(convert_to(btrim(coalesce(p_token,'')), 'UTF8'), 'sha256'), 'hex');
$$;
revoke all on function public.studio_hash_invite_token(text) from public, anon, authenticated;

create or replace function public.studio_create_team_invite(
  p_organization_id uuid,
  p_team_member_id uuid,
  p_department_id uuid,
  p_role text,
  p_token text
) returns table(invite_id uuid, invited_email text, display_name text, role text, department_id uuid, expires_at timestamptz)
language plpgsql security definer set search_path = pg_catalog, public, auth
as $$
declare v_roster record; v_role text := lower(btrim(coalesce(p_role,''))); v_invite_id uuid; v_expires timestamptz;
begin
  if auth.uid() is null or not public.chat_is_org_master(p_organization_id) then
    raise exception 'master_user_required' using errcode='42501';
  end if;
  if p_token is null or p_token !~ '^[0-9a-fA-F]{64}$' then raise exception 'invalid_invite_token' using errcode='22023'; end if;
  if v_role not in ('staff','department_admin','freelancer') then raise exception 'invalid_invite_role' using errcode='22023'; end if;
  if v_role in ('staff','department_admin') and p_department_id is null then raise exception 'department_required' using errcode='22023'; end if;
  if v_role='freelancer' and p_department_id is not null then raise exception 'department_role_mismatch' using errcode='22023'; end if;
  if p_department_id is not null and not exists(
    select 1 from public.studio_departments d where d.id=p_department_id and d.organization_id=p_organization_id
  ) then raise exception 'department_not_found' using errcode='22023'; end if;
  select tm.id, tm.user_id, tm.name, lower(btrim(tm.email)) as email, tm.status
    into v_roster from public.team_members tm
    where tm.id=p_team_member_id and tm.user_id=auth.uid()
    for update;
  if not found then raise exception 'team_member_not_found' using errcode='P0002'; end if;
  if coalesce(v_roster.status,'active') <> 'active' then raise exception 'team_member_inactive' using errcode='22023'; end if;
  if v_roster.email is null or v_roster.email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'team_member_email_required' using errcode='22023';
  end if;
  if exists(select 1 from public.studio_memberships m where m.organization_id=p_organization_id and m.team_member_id=p_team_member_id and m.status='active') then
    raise exception 'team_member_already_linked' using errcode='23505';
  end if;
  update public.studio_member_invites i set status='revoked', updated_at=now()
    where i.organization_id=p_organization_id and i.team_member_id=p_team_member_id and i.status='pending';
  insert into public.studio_member_invites(
    organization_id,team_member_id,invited_email,display_name,role,department_id,token_hash,status,expires_at,created_by
  ) values (
    p_organization_id,p_team_member_id,v_roster.email,left(btrim(v_roster.name),80),v_role,p_department_id,
    public.studio_hash_invite_token(p_token),'pending',now()+interval '7 days',auth.uid()
  ) returning id,studio_member_invites.expires_at into v_invite_id,v_expires;
  insert into public.studio_audit_events(organization_id,actor_user_id,entity_type,entity_id,action,metadata)
  values(p_organization_id,auth.uid(),'team_invite',v_invite_id,'created',
    jsonb_build_object('teamMemberId',p_team_member_id,'role',v_role,'departmentId',p_department_id));
  return query select v_invite_id,v_roster.email,left(btrim(v_roster.name),80),v_role,p_department_id,v_expires;
end;
$$;

create or replace function public.studio_list_team_access_links(p_organization_id uuid)
returns table(team_member_id uuid,user_id uuid,display_name text,email text,role text,status text,department_name text)
language plpgsql stable security definer set search_path = pg_catalog, public, auth
as $$
begin
  if auth.uid() is null or not public.chat_is_org_master(p_organization_id) then
    raise exception 'master_user_required' using errcode='42501';
  end if;
  return query select m.team_member_id,m.user_id,m.display_name,u.email::text,m.role,m.status,
    (select string_agg(d.name, ', ' order by d.name) from public.studio_department_memberships dm
      join public.studio_departments d on d.id=dm.department_id and d.organization_id=dm.organization_id
      where dm.organization_id=m.organization_id and dm.user_id=m.user_id)
  from public.studio_memberships m join auth.users u on u.id=m.user_id
  where m.organization_id=p_organization_id and m.team_member_id is not null
  order by m.display_name;
end;
$$;

-- Public only as a bearer-token lookup. Returns minimal invitation information and
-- only for a live pending token; the raw token is never stored or returned.
create or replace function public.studio_get_team_invite(p_token text)
returns table(studio_name text, invited_email text, display_name text, role text, department_name text, expires_at timestamptz)
language sql stable security definer set search_path = pg_catalog, public, extensions
as $$
  select o.name, i.invited_email, i.display_name, i.role, d.name, i.expires_at
  from public.studio_member_invites i
  join public.studio_organizations o on o.id=i.organization_id
  left join public.studio_departments d on d.id=i.department_id and d.organization_id=i.organization_id
  where p_token ~ '^[0-9a-fA-F]{64}$'
    and i.token_hash=public.studio_hash_invite_token(p_token)
    and i.status='pending' and i.expires_at > now()
  limit 1;
$$;

create or replace function public.studio_list_team_invites(p_organization_id uuid)
returns table(invite_id uuid, team_member_id uuid, invited_email text, display_name text, role text,
  department_id uuid, department_name text, status text, expires_at timestamptz, created_at timestamptz)
language plpgsql stable security definer set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null or not public.chat_is_org_master(p_organization_id) then
    raise exception 'master_user_required' using errcode='42501';
  end if;
  return query select i.id,i.team_member_id,i.invited_email,i.display_name,i.role,i.department_id,d.name,
    case when i.status='pending' and i.expires_at<=now() then 'expired' else i.status end,
    i.expires_at,i.created_at
  from public.studio_member_invites i left join public.studio_departments d
    on d.id=i.department_id and d.organization_id=i.organization_id
  where i.organization_id=p_organization_id order by i.created_at desc limit 100;
end;
$$;

create or replace function public.studio_revoke_team_invite(p_invite_id uuid)
returns boolean language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_org uuid;
begin
  select organization_id into v_org from public.studio_member_invites where id=p_invite_id for update;
  if v_org is null then raise exception 'invite_not_found' using errcode='P0002'; end if;
  if auth.uid() is null or not public.chat_is_org_master(v_org) then raise exception 'master_user_required' using errcode='42501'; end if;
  update public.studio_member_invites set status='revoked',updated_at=now()
    where id=p_invite_id and status='pending';
  insert into public.studio_audit_events(organization_id,actor_user_id,entity_type,entity_id,action,metadata)
  values(v_org,auth.uid(),'team_invite',p_invite_id,'updated',jsonb_build_object('status','revoked'));
  return true;
end;
$$;

-- A single source of truth for role/department-based app chrome. It is a UI hint;
-- the RLS policies on data remain the actual security boundary.
create or replace function public.studio_get_my_app_access_context()
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public
as $$
declare v_row record; v_departments text[]; v_department_roles text[]; v_permissions text[]; v_projects integer;
begin
  if auth.uid() is null then return jsonb_build_object('is_member',false); end if;
  select m.organization_id,m.role,m.display_name,m.team_member_id into v_row
    from public.studio_memberships m where m.user_id=auth.uid() and m.status='active'
    order by (m.role='master_user') desc,m.created_at asc limit 1;
  if not found then return jsonb_build_object('is_member',false); end if;
  select coalesce(array_agg(distinct d.name order by d.name),'{}'::text[]),
         coalesce(array_agg(distinct dm.department_role),'{}'::text[]),
         coalesce(array_agg(distinct dp.permission_key) filter(where dp.permission_key is not null),'{}'::text[])
    into v_departments,v_department_roles,v_permissions
  from public.studio_department_memberships dm
  join public.studio_departments d on d.id=dm.department_id and d.organization_id=dm.organization_id
  left join public.studio_department_permissions dp on dp.organization_id=dm.organization_id and dp.department_id=dm.department_id
  where dm.organization_id=v_row.organization_id and dm.user_id=auth.uid();
  select count(distinct pm.project_id)::integer into v_projects from public.studio_project_members pm
    where pm.organization_id=v_row.organization_id and pm.user_id=auth.uid() and pm.status='active';
  return jsonb_build_object('is_member',true,'organization_id',v_row.organization_id,'role',v_row.role,
    'display_name',v_row.display_name,'team_member_id',v_row.team_member_id,
    'department_names',to_jsonb(v_departments),'department_roles',to_jsonb(v_department_roles),
    'department_permission_keys',to_jsonb(v_permissions),'assigned_project_count',coalesce(v_projects,0),
    'is_master',v_row.role='master_user');
end;
$$;

-- Accept only from an authenticated, email-confirmed account. Membership roles,
-- studio IDs and roster IDs all come from the stored invitation, never the browser.
create or replace function public.studio_accept_team_invite(p_token text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth
as $$
declare v_user uuid:=auth.uid(); v_email text; v_confirmed timestamptz; v_inv public.studio_member_invites%rowtype;
  v_existing_role text; v_existing_team_member_id uuid; v_member_id uuid;
begin
  if v_user is null then raise exception 'sign_in_required' using errcode='28000'; end if;
  select lower(u.email),u.email_confirmed_at into v_email,v_confirmed from auth.users u where u.id=v_user;
  if v_email is null then raise exception 'account_email_required' using errcode='22023'; end if;
  if v_confirmed is null then raise exception 'email_confirmation_required' using errcode='42501'; end if;
  if p_token is null or p_token !~ '^[0-9a-fA-F]{64}$' then raise exception 'invalid_invite_token' using errcode='22023'; end if;
  select * into v_inv from public.studio_member_invites i
    where i.token_hash=public.studio_hash_invite_token(p_token) for update;
  if not found then raise exception 'invite_not_found_or_expired' using errcode='P0002'; end if;
  if v_inv.status='accepted' and v_inv.accepted_user_id=v_user then
    return jsonb_build_object('accepted',true,'organization_id',v_inv.organization_id,'role',v_inv.role,'already_accepted',true);
  end if;
  if v_inv.status<>'pending' or v_inv.expires_at<=now() then raise exception 'invite_not_found_or_expired' using errcode='P0002'; end if;
  if v_email<>lower(v_inv.invited_email) then raise exception 'invite_email_mismatch' using errcode='42501'; end if;
  if exists(select 1 from public.studio_memberships m where m.user_id=v_user and m.status='active' and m.organization_id<>v_inv.organization_id) then
    raise exception 'account_already_in_studio' using errcode='23505';
  end if;
  if not exists(select 1 from public.team_members tm where tm.id=v_inv.team_member_id and lower(btrim(tm.email))=v_email) then
    raise exception 'team_member_email_changed' using errcode='22023';
  end if;
  select m.role,m.team_member_id into v_existing_role,v_existing_team_member_id
    from public.studio_memberships m where m.organization_id=v_inv.organization_id and m.user_id=v_user for update;
  if v_existing_role='master_user' then raise exception 'cannot_replace_master_membership' using errcode='42501'; end if;
  if v_existing_team_member_id is not null and v_existing_team_member_id <> v_inv.team_member_id then
    raise exception 'account_already_linked_to_other_roster' using errcode='23505';
  end if;
  if exists(select 1 from public.studio_memberships m where m.organization_id=v_inv.organization_id and m.team_member_id=v_inv.team_member_id and m.user_id<>v_user) then
    raise exception 'team_member_already_linked' using errcode='23505';
  end if;
  insert into public.studio_memberships(organization_id,user_id,role,status,display_name,created_by,team_member_id)
  values(v_inv.organization_id,v_user,v_inv.role,'active',v_inv.display_name,v_inv.created_by,v_inv.team_member_id)
  on conflict(organization_id,user_id) do update set
    role=excluded.role,status='active',display_name=excluded.display_name,
    team_member_id=excluded.team_member_id,updated_at=now()
  returning team_member_id into v_member_id;
  delete from public.studio_department_memberships dm where dm.organization_id=v_inv.organization_id and dm.user_id=v_user;
  if v_inv.department_id is not null then
    insert into public.studio_department_memberships(organization_id,department_id,user_id,department_role,created_by)
    values(v_inv.organization_id,v_inv.department_id,v_user,case when v_inv.role='department_admin' then 'admin' else 'member' end,v_inv.created_by)
    on conflict(department_id,user_id) do update set department_role=excluded.department_role,created_by=excluded.created_by;
  end if;
  update public.studio_member_invites set status='accepted',accepted_user_id=v_user,consumed_at=now(),updated_at=now() where id=v_inv.id;
  insert into public.studio_audit_events(organization_id,actor_user_id,owner_user_id,entity_type,entity_id,action,metadata)
  values(v_inv.organization_id,v_user,v_inv.created_by,'team_invite',v_inv.id,'updated',
    jsonb_build_object('status','accepted','teamMemberId',v_inv.team_member_id,'role',v_inv.role,'departmentId',v_inv.department_id));
  -- Existing shot assignments remain attached to this team roster record. They now
  -- grant only the corresponding project access; they do not change shot assignment IDs.
  perform public.studio_sync_shot_assignment(s.project_id,v_inv.team_member_id,true)
    from (select distinct sh.project_id from public.shots sh
          join public.projects p on p.id=sh.project_id
          join public.studio_data_owners own on own.user_id=p.user_id and own.organization_id=v_inv.organization_id
          where sh.assigned_member_id=v_inv.team_member_id
            and exists(select 1 from public.team_members tm where tm.id=sh.assigned_member_id and tm.user_id=p.user_id)) s;
  return jsonb_build_object('accepted',true,'organization_id',v_inv.organization_id,'role',v_inv.role,
    'department_id',v_inv.department_id,'team_member_id',v_inv.team_member_id);
end;
$$;

-- Reuse the existing permission predicate, but let ordinary department members
-- (not only department admins) use explicitly enabled department modules. Shared
-- records must belong to an owner mapped to this studio, and either a member of the
-- same department or the studio's Master User. Project assignments stay explicit.
create or replace function public.studio_user_has_app_permission(
  p_permission_key text,
  p_owner_user_id uuid,
  p_project_id uuid default null,
  p_record_type text default null,
  p_record_id uuid default null
) returns boolean language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare v_org uuid;
begin
  if auth.uid() is null or p_owner_user_id is null or p_permission_key is null then return false; end if;
  select o.organization_id into v_org from public.studio_data_owners o where o.user_id=p_owner_user_id;
  if v_org is null and p_project_id is not null then
    select o.organization_id into v_org from public.projects p
      join public.studio_data_owners o on o.user_id=p.user_id where p.id=p_project_id;
  end if;
  if v_org is null or not exists(select 1 from public.studio_memberships me
    where me.organization_id=v_org and me.user_id=auth.uid() and me.status='active') then return false; end if;
  if public.chat_is_org_master(v_org) then return true; end if;

  if exists (
    select 1 from public.studio_memberships me
    join public.studio_role_permissions rp on rp.role=me.role and rp.permission_key=p_permission_key
    where me.organization_id=v_org and me.user_id=auth.uid() and me.status='active'
      and case rp.access_scope
        when 'own' then p_owner_user_id=auth.uid()
        when 'organization' then false -- non-Master roles never receive organization-wide record access
        when 'assigned' then p_project_id is not null and exists (
          select 1 from public.studio_project_members pm where pm.organization_id=v_org and pm.project_id=p_project_id
            and pm.user_id=auth.uid() and pm.status='active'
            and (p_permission_key like '%.read' or (p_permission_key like '%.write' and pm.access_level in ('contributor','editor'))
              or (p_permission_key like '%.delete' and pm.access_level='editor'))
        )
        else false end
  ) then return true; end if;

  -- Project/shot data is never granted by department membership alone. A user
  -- must have an explicit active project grant (which shot assignment can create).
  if p_permission_key in ('projects.read','projects.write','projects.delete','shots.read','shots.write','shots.delete') then
    return p_project_id is not null and exists(
      select 1 from public.studio_project_members pm where pm.organization_id=v_org
        and pm.project_id=p_project_id and pm.user_id=auth.uid() and pm.status='active'
        and (p_permission_key like '%.read'
          or (p_permission_key like '%.write' and pm.access_level in ('contributor','editor'))
          or (p_permission_key like '%.delete' and pm.access_level='editor'))
    );
  end if;

  -- Project activity is still project data. A department's activity.read
  -- permission must never bypass the explicit project-assignment boundary.
  if p_permission_key = 'activity.read' and p_project_id is not null then
    return exists (
      select 1 from public.studio_project_members pm
      where pm.organization_id=v_org and pm.project_id=p_project_id
        and pm.user_id=auth.uid() and pm.status='active'
    );
  end if;

  -- Ordinary department members and department administrators have only the
  -- explicitly enabled module permission for data owned in that department or
  -- by this studio's mapped Master User. Department membership never means
  -- access to every project or every module in the organization.
  return exists (
    select 1 from public.studio_department_memberships mine
    join public.studio_memberships me on me.organization_id=mine.organization_id
      and me.user_id=mine.user_id and me.status='active'
    join public.studio_department_permissions dp on dp.organization_id=mine.organization_id
      and dp.department_id=mine.department_id and dp.permission_key=p_permission_key
    where mine.organization_id=v_org and mine.user_id=auth.uid()
      and (
        exists(select 1 from public.studio_department_memberships owner_dept
          join public.studio_memberships owner_member on owner_member.organization_id=owner_dept.organization_id
            and owner_member.user_id=owner_dept.user_id and owner_member.status='active'
          where owner_dept.organization_id=v_org and owner_dept.department_id=mine.department_id
            and owner_dept.user_id=p_owner_user_id)
        or exists(select 1 from public.studio_data_owners own
          join public.studio_memberships owner_master on owner_master.organization_id=own.organization_id
            and owner_master.user_id=own.user_id and owner_master.role='master_user' and owner_master.status='active'
          where own.organization_id=v_org and own.user_id=p_owner_user_id)
      )
  );
end;
$$;

create or replace function public.studio_assign_project_access(
  p_organization_id uuid, p_project_id uuid, p_user_id uuid, p_access_level text
) returns boolean language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_owner uuid;
begin
  if auth.uid() is null or not public.chat_is_org_master(p_organization_id) then raise exception 'master_user_required' using errcode='42501'; end if;
  if p_access_level not in ('viewer','contributor','editor') then raise exception 'invalid_access_level' using errcode='22023'; end if;
  select p.user_id into v_owner from public.projects p join public.studio_data_owners o on o.user_id=p.user_id and o.organization_id=p_organization_id where p.id=p_project_id;
  if v_owner is null then raise exception 'project_not_in_studio' using errcode='42501'; end if;
  if not exists(select 1 from public.studio_memberships m where m.organization_id=p_organization_id and m.user_id=p_user_id and m.status='active' and m.role in ('staff','freelancer','department_admin')) then
    raise exception 'target_not_eligible' using errcode='42501';
  end if;
  if p_user_id=v_owner then raise exception 'project_owner_already_has_access' using errcode='22023'; end if;
  insert into public.studio_project_members(organization_id,project_id,user_id,access_level,status,added_by,added_at,updated_at,grant_source)
  values(p_organization_id,p_project_id,p_user_id,p_access_level,'active',auth.uid(),now(),now(),'manual')
  on conflict(project_id,user_id) do update set organization_id=excluded.organization_id,access_level=excluded.access_level,status='active',
    added_by=auth.uid(),added_at=now(),updated_at=now(),grant_source='manual';
  insert into public.chat_conversation_members(organization_id,conversation_id,user_id,role,status,joined_at,left_at,removed_at)
  select p_organization_id,c.id,p_user_id,'member','active',now(),null,null from public.chat_conversations c
    where c.organization_id=p_organization_id and c.project_id=p_project_id and c.kind='project' and c.archived_at is null
  on conflict(conversation_id,user_id) do update set status='active',left_at=null,removed_at=null,joined_at=now();
  insert into public.studio_audit_events(organization_id,actor_user_id,owner_user_id,entity_type,entity_id,project_id,action,metadata)
  values(p_organization_id,auth.uid(),v_owner,'project_access',p_project_id,p_project_id,'updated',jsonb_build_object('targetUserId',p_user_id,'accessLevel',p_access_level,'status','active','grantSource','manual'));
  return true;
end;
$$;

create or replace function public.studio_sync_shot_assignment(p_project_id uuid, p_team_member_id uuid, p_assigned boolean)
returns void language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_org uuid; v_owner uuid; v_user uuid; v_old_status text;
begin
  if p_project_id is null or p_team_member_id is null then return; end if;
  select p.user_id,o.organization_id into v_owner,v_org from public.projects p
    join public.studio_data_owners o on o.user_id=p.user_id where p.id=p_project_id;
  if v_org is null then return; end if;
  if not exists(select 1 from public.team_members tm where tm.id=p_team_member_id and tm.user_id=v_owner) then return; end if;
  select m.user_id into v_user from public.studio_memberships m
    where m.organization_id=v_org and m.team_member_id=p_team_member_id and m.status='active' and m.role<>'client' limit 1;
  if v_user is null then return; end if;
  if p_assigned then
    select pm.status into v_old_status from public.studio_project_members pm where pm.project_id=p_project_id and pm.user_id=v_user;
    insert into public.studio_project_members(organization_id,project_id,user_id,access_level,status,added_by,added_at,updated_at,grant_source)
    values(v_org,p_project_id,v_user,'contributor','active',v_owner,now(),now(),'shot_assignment')
    on conflict(project_id,user_id) do update set organization_id=excluded.organization_id,
      access_level=case when public.studio_project_members.status='revoked' then 'contributor' else public.studio_project_members.access_level end,
      status='active',updated_at=now(),
      grant_source=case when public.studio_project_members.status='revoked' then 'shot_assignment' else public.studio_project_members.grant_source end;
    insert into public.chat_conversation_members(organization_id,conversation_id,user_id,role,status,joined_at,left_at,removed_at)
    select v_org,c.id,v_user,'member','active',now(),null,null from public.chat_conversations c
      where c.organization_id=v_org and c.project_id=p_project_id and c.kind='project' and c.archived_at is null
    on conflict(conversation_id,user_id) do update set status='active',left_at=null,removed_at=null,joined_at=now();
  else
    if exists(select 1 from public.shots sh join public.team_members tm on tm.id=sh.assigned_member_id and tm.user_id=v_owner
      where sh.project_id=p_project_id and sh.assigned_member_id=p_team_member_id) then return; end if;
    update public.studio_project_members set status='revoked',updated_at=now()
      where project_id=p_project_id and user_id=v_user and grant_source='shot_assignment';
    if not exists(select 1 from public.studio_project_members pm where pm.project_id=p_project_id and pm.user_id=v_user and pm.status='active') then
      update public.chat_conversation_members cm set status='removed',removed_at=now()
        from public.chat_conversations c where c.id=cm.conversation_id and c.organization_id=v_org and c.project_id=p_project_id
          and c.kind='project' and cm.user_id=v_user and cm.status='active';
    end if;
  end if;
end;
$$;
revoke all on function public.studio_sync_shot_assignment(uuid,uuid,boolean) from public, anon, authenticated;

create or replace function public.studio_sync_shot_assignment_trigger()
returns trigger language plpgsql security definer set search_path = pg_catalog, public
as $$
begin
  if tg_op='DELETE' then
    perform public.studio_sync_shot_assignment(old.project_id,old.assigned_member_id,false);
    return old;
  end if;
  if tg_op='UPDATE' and (old.project_id is distinct from new.project_id or old.assigned_member_id is distinct from new.assigned_member_id) then
    perform public.studio_sync_shot_assignment(old.project_id,old.assigned_member_id,false);
  end if;
  perform public.studio_sync_shot_assignment(new.project_id,new.assigned_member_id,true);
  return new;
end;
$$;
revoke all on function public.studio_sync_shot_assignment_trigger() from public, anon, authenticated;
drop trigger if exists studio_sync_shot_assignment_trigger on public.shots;
create trigger studio_sync_shot_assignment_trigger after insert or update of project_id,assigned_member_id or delete on public.shots
for each row execute function public.studio_sync_shot_assignment_trigger();

-- Active studio membership is checked by each chat/project permission helper. A
-- suspended membership therefore loses access without erasing its explicit grant
-- history; reactivation can restore the same previously-authorized access.

-- Provision a separate studio for new standalone signups. Invite signups are
-- deliberately skipped when their raw metadata contains a still-pending token;
-- the invitation is then validated and consumed by studio_accept_team_invite.
create or replace function public.studio_bootstrap_new_auth_user()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, auth, extensions
as $$
declare v_token text; v_name text; v_slug text; v_org uuid; v_invite_valid boolean := false;
begin
  v_token := nullif(new.raw_user_meta_data->>'studio_invite_token','');
  if v_token is not null then
    if v_token !~ '^[0-9a-fA-F]{64}$' then
      raise exception 'invite_not_found_or_expired' using errcode='22023';
    end if;
    select exists(
      select 1 from public.studio_member_invites i
      where i.token_hash=public.studio_hash_invite_token(v_token)
        and i.status='pending' and i.expires_at>now()
        and lower(i.invited_email)=lower(coalesce(new.email,''))
    ) into v_invite_valid;
    if not v_invite_valid then
      -- A token supplied during signup must match the invited email. Do not
      -- silently create a separate Master User account for a malformed or
      -- mismatched invitation request.
      raise exception 'invite_not_found_or_expired' using errcode='22023';
    end if;
    return new;
  end if;
  v_name := left(btrim(coalesce(nullif(new.raw_user_meta_data->>'full_name',''),nullif(new.raw_user_meta_data->>'name',''),split_part(coalesce(new.email,'kairflow'), '@', 1))),70);
  if v_name='' then v_name:='Studio owner'; end if;
  insert into public.studio_organizations(name,slug,created_by)
    values(v_name || '''s Studio','studio-' || substr(replace(new.id::text,'-',''),1,16),new.id)
    returning id into v_org;
  insert into public.studio_memberships(organization_id,user_id,role,status,display_name,created_by)
    values(v_org,new.id,'master_user','active',left(v_name,80),new.id);
  insert into public.studio_data_owners(user_id,organization_id,mapped_by) values(new.id,v_org,new.id)
    on conflict(user_id) do nothing;
  insert into public.studio_departments(organization_id,name,created_by) values
    (v_org,'Sales',new.id),(v_org,'Production',new.id),(v_org,'Finance',new.id),(v_org,'Management',new.id)
  on conflict do nothing;
  return new;
end;
$$;
revoke all on function public.studio_bootstrap_new_auth_user() from public, anon, authenticated;
drop trigger if exists studio_bootstrap_new_auth_user on auth.users;
create trigger studio_bootstrap_new_auth_user after insert on auth.users
for each row execute function public.studio_bootstrap_new_auth_user();

revoke all on function public.studio_create_team_invite(uuid,uuid,uuid,text,text) from public, anon;
revoke all on function public.studio_get_team_invite(text) from public;
revoke all on function public.studio_list_team_invites(uuid) from public, anon;
revoke all on function public.studio_list_team_access_links(uuid) from public, anon;
revoke all on function public.studio_revoke_team_invite(uuid) from public, anon;
revoke all on function public.studio_accept_team_invite(text) from public, anon;
revoke all on function public.studio_get_my_app_access_context() from public, anon;
grant execute on function public.studio_create_team_invite(uuid,uuid,uuid,text,text) to authenticated;
grant execute on function public.studio_get_team_invite(text) to anon, authenticated;
grant execute on function public.studio_list_team_invites(uuid) to authenticated;
grant execute on function public.studio_list_team_access_links(uuid) to authenticated;
grant execute on function public.studio_revoke_team_invite(uuid) to authenticated;
grant execute on function public.studio_accept_team_invite(text) to authenticated;
grant execute on function public.studio_get_my_app_access_context() to authenticated;

commit;
