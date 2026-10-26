-- KairFlow shared-studio access foundation.
-- Depends on 20261029090000_chat_collaboration.sql for organizations, memberships,
-- departments, and authenticated internal chat. This migration does not apply itself.
-- Existing owner-only policies remain in place; additional policies grant only the
-- cross-user access approved by the studio membership/permission model.

begin;

-- Explicit opt-in map from a login's existing workspace data to one studio.
-- Membership in chat alone does NOT expose a member's existing business records.
create table if not exists public.studio_data_owners (
  user_id uuid primary key references auth.users(id) on delete restrict,
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  mapped_by uuid references auth.users(id) on delete set null,
  mapped_at timestamptz not null default now(),
  unique (organization_id, user_id)
);
create index if not exists studio_data_owners_org_idx
  on public.studio_data_owners(organization_id, user_id);
alter table public.studio_data_owners enable row level security;
revoke all on public.studio_data_owners from public, anon, authenticated;

-- Role defaults are narrow and capability-based. Master User is handled through
-- the trusted membership role, never a profile flag or user-supplied argument.
create table if not exists public.studio_role_permissions (
  role text not null check (role in ('master_user','department_admin','staff','freelancer','client')),
  permission_key text not null check (permission_key ~ '^[a-z][a-z0-9_]*\.(read|write|delete)$'),
  access_scope text not null check (access_scope in ('own','assigned','organization')),
  created_at timestamptz not null default now(),
  primary key (role, permission_key)
);
alter table public.studio_role_permissions enable row level security;
revoke all on public.studio_role_permissions from public, anon, authenticated;

-- A department permission always scopes to records owned by members of that
-- department. It cannot be configured as whole-organization access.
create table if not exists public.studio_department_permissions (
  organization_id uuid not null,
  department_id uuid not null,
  permission_key text not null check (permission_key in (
    'crm.read','crm.write','contacts.read','contacts.write',
    'projects.read','projects.write','shots.read','shots.write',
    'teams.read','teams.write','activity.read','invoices.read','expenses.read'
  )),
  access_scope text not null default 'department' check (access_scope = 'department'),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (department_id, permission_key),
  foreign key (organization_id, department_id)
    references public.studio_departments(organization_id, id) on delete cascade
);
alter table public.studio_department_permissions enable row level security;
revoke all on public.studio_department_permissions from public, anon, authenticated;

-- Explicit per-project sharing. This table grants access to a project and its
-- production records; a conversation invite alone does not grant project access.
create table if not exists public.studio_project_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null,
  access_level text not null check (access_level in ('viewer','contributor','editor')),
  status text not null default 'active' check (status in ('active','revoked')),
  added_by uuid references auth.users(id) on delete set null,
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, user_id),
  foreign key (organization_id, user_id)
    references public.studio_memberships(organization_id, user_id) on delete cascade
);
create index if not exists studio_project_members_user_idx
  on public.studio_project_members(organization_id, user_id, status, project_id);
create index if not exists studio_project_members_project_idx
  on public.studio_project_members(project_id, status, user_id);
alter table public.studio_project_members enable row level security;
revoke all on public.studio_project_members from public, anon, authenticated;

-- A normalized, append-only business audit stream. Chat keeps its own event
-- stream because it has chat-specific privacy rules and intentionally excludes
-- message bodies. This table records record IDs and changed column names only.
create table if not exists public.studio_audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  owner_user_id uuid references auth.users(id) on delete set null,
  entity_type text not null check (length(entity_type) between 1 and 80),
  entity_id uuid,
  project_id uuid,
  action text not null check (action in ('created','updated','deleted')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists studio_audit_events_org_created_idx
  on public.studio_audit_events(organization_id, created_at desc, id desc);
create index if not exists studio_audit_events_entity_idx
  on public.studio_audit_events(organization_id, entity_type, entity_id, created_at desc);
alter table public.studio_audit_events enable row level security;
revoke all on public.studio_audit_events from public, anon, authenticated;

-- Seed conservative role defaults. The original per-user policies continue to
-- govern each user's own records even when no studio has been bootstrapped.
insert into public.studio_role_permissions(role, permission_key, access_scope) values
  ('staff','projects.read','assigned'),
  ('staff','projects.write','assigned'),
  ('staff','shots.read','assigned'),
  ('staff','shots.write','assigned'),
  ('staff','crm.read','own'),
  ('staff','crm.write','own'),
  ('staff','contacts.read','own'),
  ('staff','contacts.write','own'),
  ('staff','activity.read','assigned'),
  ('freelancer','projects.read','assigned'),
  ('freelancer','shots.read','assigned'),
  ('freelancer','shots.write','assigned'),
  ('freelancer','activity.read','assigned')
on conflict (role, permission_key) do nothing;

-- Add safe defaults for recognizable departments, but do not restrict the
-- application to a hard-coded department list. New/renamed departments are
-- managed explicitly by the Master User in the Studio Access panel.
create or replace function public.studio_seed_department_permissions()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_name text := regexp_replace(lower(btrim(new.name)), '[^a-z0-9]+', '', 'g');
        v_permission text;
begin
  if v_name in ('sales','businessdevelopment') then
    foreach v_permission in array array['crm.read','crm.write','contacts.read','contacts.write','activity.read'] loop
      insert into public.studio_department_permissions(organization_id, department_id, permission_key)
      values (new.organization_id, new.id, v_permission) on conflict (department_id, permission_key) do nothing;
    end loop;
  elsif v_name in ('production','animation','postproduction') then
    foreach v_permission in array array['projects.read','projects.write','shots.read','shots.write','teams.read','activity.read'] loop
      insert into public.studio_department_permissions(organization_id, department_id, permission_key)
      values (new.organization_id, new.id, v_permission) on conflict (department_id, permission_key) do nothing;
    end loop;
  elsif v_name in ('finance','accounting') then
    foreach v_permission in array array['invoices.read','expenses.read','activity.read'] loop
      insert into public.studio_department_permissions(organization_id, department_id, permission_key)
      values (new.organization_id, new.id, v_permission) on conflict (department_id, permission_key) do nothing;
    end loop;
  elsif v_name in ('management','administration','managementadministration') then
    foreach v_permission in array array[
      'crm.read','projects.read','shots.read','teams.read','activity.read','invoices.read','expenses.read'
    ] loop
      insert into public.studio_department_permissions(organization_id, department_id, permission_key)
      values (new.organization_id, new.id, v_permission) on conflict (department_id, permission_key) do nothing;
    end loop;
  end if;
  return new;
end;
$$;
drop trigger if exists studio_seed_department_permissions on public.studio_departments;
create trigger studio_seed_department_permissions after insert on public.studio_departments
for each row execute function public.studio_seed_department_permissions();

-- Seed permissions for departments created by the preceding chat migration.
do $$
declare d record; v_permission text; v_name text;
begin
  for d in select id, organization_id, name from public.studio_departments loop
    v_name := regexp_replace(lower(btrim(d.name)), '[^a-z0-9]+', '', 'g');
    if v_name in ('sales','businessdevelopment') then
      foreach v_permission in array array['crm.read','crm.write','contacts.read','contacts.write','activity.read'] loop
        insert into public.studio_department_permissions(organization_id, department_id, permission_key)
        values (d.organization_id,d.id,v_permission) on conflict (department_id,permission_key) do nothing;
      end loop;
    elsif v_name in ('production','animation','postproduction') then
      foreach v_permission in array array['projects.read','projects.write','shots.read','shots.write','teams.read','activity.read'] loop
        insert into public.studio_department_permissions(organization_id, department_id, permission_key)
        values (d.organization_id,d.id,v_permission) on conflict (department_id,permission_key) do nothing;
      end loop;
    elsif v_name in ('finance','accounting') then
      foreach v_permission in array array['invoices.read','expenses.read','activity.read'] loop
        insert into public.studio_department_permissions(organization_id, department_id, permission_key)
        values (d.organization_id,d.id,v_permission) on conflict (department_id,permission_key) do nothing;
      end loop;
    elsif v_name in ('management','administration','managementadministration') then
      foreach v_permission in array array['crm.read','projects.read','shots.read','teams.read','activity.read','invoices.read','expenses.read'] loop
        insert into public.studio_department_permissions(organization_id, department_id, permission_key)
        values (d.organization_id,d.id,v_permission) on conflict (department_id,permission_key) do nothing;
      end loop;
    end if;
  end loop;
end $$;

-- Stable, trusted authorization predicate. Scope resolution is tied to the
-- explicit studio_data_owners mapping and active studio membership. Merely
-- knowing a user/project/record UUID is never enough.
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
  select o.organization_id into v_org
  from public.studio_data_owners o where o.user_id = p_owner_user_id;
  -- Child rows (for example a new shot authored by an assigned collaborator) may
  -- retain the collaborator as user_id. Resolve their organization from the parent
  -- project only when that project has an explicit owner-to-studio mapping.
  if v_org is null and p_project_id is not null then
    select o.organization_id into v_org from public.projects p
      join public.studio_data_owners o on o.user_id=p.user_id where p.id=p_project_id;
  end if;
  if v_org is null then return false; end if;
  if not exists (
    select 1 from public.studio_memberships me
    where me.organization_id = v_org and me.user_id = auth.uid() and me.status = 'active'
  ) then return false; end if;
  if public.chat_is_org_master(v_org) then return true; end if;

  if exists (
    select 1 from public.studio_memberships me
    join public.studio_role_permissions rp on rp.role = me.role and rp.permission_key = p_permission_key
    where me.organization_id = v_org and me.user_id = auth.uid() and me.status = 'active'
      and case rp.access_scope
        when 'own' then p_owner_user_id = auth.uid()
        when 'organization' then true
        when 'assigned' then p_project_id is not null and exists (
          select 1 from public.studio_project_members pm
          where pm.organization_id = v_org and pm.project_id = p_project_id
            and pm.user_id = auth.uid() and pm.status = 'active'
            and (
              p_permission_key like '%.read'
              or (p_permission_key like '%.write' and pm.access_level in ('contributor','editor'))
              or (p_permission_key like '%.delete' and pm.access_level = 'editor')
            )
        )
        else false
      end
  ) then return true; end if;

  -- Department administrators can access only the module permissions explicitly
  -- granted to their department, and only records owned by someone in that same department.
  return exists (
    select 1
    from public.studio_department_memberships mine
    join public.studio_memberships me
      on me.organization_id = mine.organization_id and me.user_id = mine.user_id
    join public.studio_department_permissions dp
      on dp.organization_id = mine.organization_id and dp.department_id = mine.department_id
    join public.studio_department_memberships owner_dept
      on owner_dept.organization_id = mine.organization_id and owner_dept.department_id = mine.department_id
      and owner_dept.user_id = p_owner_user_id
    join public.studio_memberships owner_member
      on owner_member.organization_id = mine.organization_id and owner_member.user_id = owner_dept.user_id
      and owner_member.status = 'active'
    where mine.organization_id = v_org and mine.user_id = auth.uid() and mine.department_role = 'admin'
      and me.status = 'active' and me.role = 'department_admin'
      and dp.permission_key = p_permission_key
  );
end;
$$;

create or replace function public.studio_is_member_of_org(p_organization_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public
as $$
  select exists (select 1 from public.studio_memberships m
    where m.organization_id = p_organization_id and m.user_id = auth.uid() and m.status = 'active');
$$;

-- Project authorization for chat and app records. A current member can open a
-- project if they own it, are the Master User for its mapped studio, or have an
-- explicit active project assignment.
create or replace function public.chat_user_can_access_project(
  p_organization_id uuid, p_project_id uuid, p_user_id uuid
) returns boolean language sql stable security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.projects p
    join public.studio_data_owners project_owner
      on project_owner.organization_id = p_organization_id and project_owner.user_id = p.user_id
    join public.studio_memberships actor
      on actor.organization_id = p_organization_id and actor.user_id = p_user_id
      and actor.status = 'active' and actor.role <> 'client'
    where p.id = p_project_id and (
      p.user_id = p_user_id
      or actor.role = 'master_user'
      or exists (select 1 from public.studio_project_members pm
        where pm.organization_id = p_organization_id and pm.project_id = p.id
          and pm.user_id = p_user_id and pm.status = 'active')
    )
  );
$$;

-- Workspace sharing is a separate explicit action. It is used by the Master
-- User when adding an authenticated staff account to the studio.
create or replace function public.chat_add_studio_member_with_workspace(
  p_organization_id uuid, p_email text, p_display_name text,
  p_role text default 'staff', p_department_id uuid default null,
  p_share_workspace_data boolean default false
) returns uuid language plpgsql security definer
set search_path = pg_catalog, public, auth
as $$
declare v_uid uuid; v_membership_id uuid; v_name text; v_existing_role text; v_existing_status text; v_existing_org uuid;
begin
  if auth.uid() is null or not public.chat_is_org_master(p_organization_id) then
    raise exception 'master_user_required' using errcode='42501';
  end if;
  if p_share_workspace_data is null then raise exception 'share_flag_required' using errcode='22023'; end if;
  p_role := lower(btrim(coalesce(p_role,'')));
  if p_role not in ('staff','freelancer','department_admin','client') then raise exception 'invalid_role' using errcode='22023'; end if;
  if p_role='department_admin' and p_department_id is null then raise exception 'department_required' using errcode='22023'; end if;
  if p_department_id is not null and not exists (select 1 from public.studio_departments d where d.id=p_department_id and d.organization_id=p_organization_id) then
    raise exception 'department_not_found' using errcode='22023';
  end if;
  if nullif(btrim(p_email),'') is null or char_length(btrim(p_email))>254 then raise exception 'invalid_email' using errcode='22023'; end if;
  select u.id into v_uid from auth.users u where lower(u.email)=lower(btrim(p_email)) limit 1;
  if v_uid is null then raise exception 'account_not_found: the person must have a KairFlow login first' using errcode='P0001'; end if;
  select role,status into v_existing_role,v_existing_status from public.studio_memberships where organization_id=p_organization_id and user_id=v_uid;
  if v_existing_role='master_user' then raise exception 'cannot_change_master_membership' using errcode='42501'; end if;
  if p_share_workspace_data then
    select organization_id into v_existing_org from public.studio_data_owners where user_id=v_uid;
    if v_existing_org is not null and v_existing_org<>p_organization_id then raise exception 'workspace_already_linked_to_another_studio' using errcode='23505'; end if;
  end if;
  v_name:=left(btrim(coalesce(nullif(p_display_name,''),split_part(p_email,'@',1))),80);
  if v_name='' then v_name:='Team member'; end if;
  insert into public.studio_memberships(organization_id,user_id,role,status,display_name,created_by)
  values(p_organization_id,v_uid,p_role,'active',v_name,auth.uid())
  on conflict(organization_id,user_id) do update set role=excluded.role,status='active',display_name=excluded.display_name,updated_at=now()
  returning id into v_membership_id;
  if p_role<>'department_admin' then
    update public.studio_department_memberships set department_role='member'
    where organization_id=p_organization_id and user_id=v_uid and department_role='admin';
  end if;
  if p_department_id is not null and p_role in ('department_admin','staff','freelancer') then
    insert into public.studio_department_memberships(organization_id,department_id,user_id,department_role,created_by)
    values(p_organization_id,p_department_id,v_uid,case when p_role='department_admin' then 'admin' else 'member' end,auth.uid())
    on conflict(department_id,user_id) do update set department_role=excluded.department_role,created_by=auth.uid();
  end if;
  if p_share_workspace_data then
    insert into public.studio_data_owners(user_id,organization_id,mapped_by) values(v_uid,p_organization_id,auth.uid())
    on conflict(user_id) do nothing;
    if not exists(select 1 from public.studio_data_owners o where o.user_id=v_uid and o.organization_id=p_organization_id) then
      raise exception 'workspace_already_linked_to_another_studio' using errcode='23505';
    end if;
    insert into public.studio_audit_events(organization_id,actor_user_id,owner_user_id,entity_type,entity_id,action,metadata)
    values(p_organization_id,auth.uid(),v_uid,'studio_data_owner',v_uid,'updated',jsonb_build_object('workspaceShared',true));
  end if;
  if v_existing_role is null then
    perform public.chat_write_audit(p_organization_id,null,auth.uid(),'studio_member_added',v_membership_id,jsonb_build_object('targetUserId',v_uid,'role',p_role));
  else
    if v_existing_role is distinct from p_role then
      perform public.chat_write_audit(p_organization_id,null,auth.uid(),'member_role_changed',v_membership_id,jsonb_build_object('targetUserId',v_uid,'oldRole',v_existing_role,'newRole',p_role));
    end if;
    if v_existing_status='suspended' then
      perform public.chat_write_audit(p_organization_id,null,auth.uid(),'studio_member_activated',v_membership_id,jsonb_build_object('targetUserId',v_uid,'role',p_role));
    end if;
  end if;
  return v_membership_id;
end;
$$;

-- Master-controlled project assignments. Assignment is allowed only when the
-- project's owner data was explicitly mapped to this studio.
create or replace function public.studio_list_manageable_projects(p_organization_id uuid)
returns table(project_id uuid, project_name text, owner_user_id uuid)
language plpgsql stable security definer set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null or not public.chat_is_org_master(p_organization_id) then
    raise exception 'master_user_required' using errcode='42501';
  end if;
  return query select p.id, p.name, p.user_id
    from public.projects p join public.studio_data_owners o
      on o.organization_id = p_organization_id and o.user_id = p.user_id
    order by p.name limit 1000;
end;
$$;

create or replace function public.studio_list_project_access(p_organization_id uuid, p_project_id uuid)
returns table(user_id uuid, display_name text, email text, access_level text, status text)
language plpgsql stable security definer set search_path = pg_catalog, public, auth
as $$
begin
  if auth.uid() is null or not public.chat_is_org_master(p_organization_id) then
    raise exception 'master_user_required' using errcode='42501';
  end if;
  if not exists (select 1 from public.projects p join public.studio_data_owners o
    on o.user_id=p.user_id and o.organization_id=p_organization_id where p.id=p_project_id) then
    raise exception 'project_not_in_studio' using errcode='42501';
  end if;
  return query
    select pm.user_id, m.display_name, u.email::text, pm.access_level, pm.status
    from public.studio_project_members pm
    join public.studio_memberships m on m.organization_id=pm.organization_id and m.user_id=pm.user_id
    join auth.users u on u.id=pm.user_id
    where pm.organization_id=p_organization_id and pm.project_id=p_project_id
    order by m.display_name;
end;
$$;

create or replace function public.studio_assign_project_access(
  p_organization_id uuid, p_project_id uuid, p_user_id uuid, p_access_level text
) returns boolean language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_owner uuid;
begin
  if auth.uid() is null or not public.chat_is_org_master(p_organization_id) then
    raise exception 'master_user_required' using errcode='42501';
  end if;
  if p_access_level not in ('viewer','contributor','editor') then raise exception 'invalid_access_level' using errcode='22023'; end if;
  select p.user_id into v_owner from public.projects p
  join public.studio_data_owners o on o.user_id=p.user_id and o.organization_id=p_organization_id
  where p.id=p_project_id;
  if v_owner is null then raise exception 'project_not_in_studio' using errcode='42501'; end if;
  if not exists (select 1 from public.studio_memberships m where m.organization_id=p_organization_id
    and m.user_id=p_user_id and m.status='active' and m.role in ('staff','freelancer','department_admin')) then
    raise exception 'target_not_eligible' using errcode='42501';
  end if;
  if p_user_id=v_owner then raise exception 'project_owner_already_has_access' using errcode='22023'; end if;
  insert into public.studio_project_members(organization_id,project_id,user_id,access_level,status,added_by,added_at,updated_at)
  values(p_organization_id,p_project_id,p_user_id,p_access_level,'active',auth.uid(),now(),now())
  on conflict(project_id,user_id) do update set organization_id=excluded.organization_id,
    access_level=excluded.access_level,status='active',added_by=auth.uid(),added_at=now(),updated_at=now();
  -- Keep an explicit chat membership in every existing conversation for this project.
  -- Realtime notifications rely on this durable recipient list; project assignment and
  -- conversation membership are updated atomically in this RPC transaction.
  insert into public.chat_conversation_members(organization_id,conversation_id,user_id,role,status,joined_at,left_at,removed_at)
  select p_organization_id,c.id,p_user_id,'member','active',now(),null,null
    from public.chat_conversations c
    where c.organization_id=p_organization_id and c.project_id=p_project_id and c.kind='project' and c.archived_at is null
  on conflict(conversation_id,user_id) do update set status='active',left_at=null,removed_at=null,joined_at=now();
  insert into public.studio_audit_events(organization_id,actor_user_id,owner_user_id,entity_type,entity_id,project_id,action,metadata)
  values(p_organization_id,auth.uid(),v_owner,'project_access',p_project_id,p_project_id,'updated',
    jsonb_build_object('targetUserId',p_user_id,'accessLevel',p_access_level,'status','active'));
  return true;
end;
$$;

create or replace function public.studio_revoke_project_access(
  p_organization_id uuid, p_project_id uuid, p_user_id uuid
) returns boolean language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_owner uuid;
begin
  if auth.uid() is null or not public.chat_is_org_master(p_organization_id) then
    raise exception 'master_user_required' using errcode='42501';
  end if;
  select p.user_id into v_owner from public.projects p
  join public.studio_data_owners o on o.user_id=p.user_id and o.organization_id=p_organization_id
  where p.id=p_project_id;
  if v_owner is null then raise exception 'project_not_in_studio' using errcode='42501'; end if;
  if p_user_id=v_owner then raise exception 'cannot_revoke_project_owner' using errcode='42501'; end if;
  update public.studio_project_members set status='revoked',updated_at=now()
    where organization_id=p_organization_id and project_id=p_project_id and user_id=p_user_id and status='active';
  update public.chat_conversation_members cm set status='removed',removed_at=now()
    from public.chat_conversations c
    where c.id=cm.conversation_id and c.organization_id=p_organization_id and c.project_id=p_project_id
      and c.kind='project' and cm.user_id=p_user_id and cm.status='active';
  insert into public.studio_audit_events(organization_id,actor_user_id,owner_user_id,entity_type,entity_id,project_id,action,metadata)
  values(p_organization_id,auth.uid(),v_owner,'project_access',p_project_id,p_project_id,'updated',
    jsonb_build_object('targetUserId',p_user_id,'status','revoked'));
  return true;
end;
$$;

create or replace function public.studio_list_department_permissions(p_organization_id uuid, p_department_id uuid)
returns table(permission_key text, access_scope text)
language plpgsql stable security definer set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null or not public.chat_is_org_master(p_organization_id) then
    raise exception 'master_user_required' using errcode='42501';
  end if;
  if not exists (select 1 from public.studio_departments d where d.organization_id=p_organization_id and d.id=p_department_id) then
    raise exception 'department_not_found' using errcode='22023';
  end if;
  return query select dp.permission_key, dp.access_scope from public.studio_department_permissions dp
    where dp.organization_id=p_organization_id and dp.department_id=p_department_id
    order by dp.permission_key;
end;
$$;

create or replace function public.studio_set_department_permission(
  p_organization_id uuid, p_department_id uuid, p_permission_key text, p_enabled boolean
) returns boolean language plpgsql security definer set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null or not public.chat_is_org_master(p_organization_id) then
    raise exception 'master_user_required' using errcode='42501';
  end if;
  if p_permission_key is null or p_permission_key not in (
    'crm.read','crm.write','contacts.read','contacts.write','projects.read','projects.write',
    'shots.read','shots.write','teams.read','teams.write','activity.read','invoices.read','expenses.read'
  ) then raise exception 'invalid_permission' using errcode='22023'; end if;
  if not exists (select 1 from public.studio_departments d where d.organization_id=p_organization_id and d.id=p_department_id) then
    raise exception 'department_not_found' using errcode='22023';
  end if;
  if p_enabled then
    insert into public.studio_department_permissions(organization_id,department_id,permission_key,access_scope,created_by,updated_at)
    values(p_organization_id,p_department_id,p_permission_key,'department',auth.uid(),now())
    on conflict(department_id,permission_key) do update set updated_at=now(),created_by=auth.uid();
  else
    delete from public.studio_department_permissions where organization_id=p_organization_id
      and department_id=p_department_id and permission_key=p_permission_key;
  end if;
  insert into public.studio_audit_events(organization_id,actor_user_id,entity_type,entity_id,action,metadata)
  values(p_organization_id,auth.uid(),'department_permission',p_department_id,'updated',
    jsonb_build_object('permission',p_permission_key,'enabled',p_enabled));
  return true;
end;
$$;

create or replace function public.studio_list_workspace_sharing(p_organization_id uuid)
returns table(user_id uuid, workspace_shared boolean, mapped_at timestamptz)
language plpgsql stable security definer set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null or not public.chat_is_org_master(p_organization_id) then
    raise exception 'master_user_required' using errcode='42501';
  end if;
  return query
    select m.user_id, (o.user_id is not null) as workspace_shared, o.mapped_at
    from public.studio_memberships m
    left join public.studio_data_owners o on o.user_id=m.user_id and o.organization_id=m.organization_id
    where m.organization_id=p_organization_id
    order by m.display_name;
end;
$$;

create or replace function public.studio_set_workspace_sharing(
  p_organization_id uuid, p_user_id uuid, p_share boolean
) returns boolean language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_existing_org uuid;
begin
  if auth.uid() is null or not public.chat_is_org_master(p_organization_id) then
    raise exception 'master_user_required' using errcode='42501';
  end if;
  if p_share is null then raise exception 'share_flag_required' using errcode='22023'; end if;
  if not exists (select 1 from public.studio_memberships m where m.organization_id=p_organization_id
    and m.user_id=p_user_id and m.status='active' and m.role <> 'client') then
    raise exception 'active_internal_member_required' using errcode='42501';
  end if;
  if p_share then
    select organization_id into v_existing_org from public.studio_data_owners where user_id=p_user_id;
    if v_existing_org is not null and v_existing_org<>p_organization_id then
      raise exception 'workspace_already_linked_to_another_studio' using errcode='23505';
    end if;
    insert into public.studio_data_owners(user_id,organization_id,mapped_by)
    values(p_user_id,p_organization_id,auth.uid()) on conflict(user_id) do nothing;
    insert into public.studio_audit_events(organization_id,actor_user_id,owner_user_id,entity_type,entity_id,action,metadata)
    values(p_organization_id,auth.uid(),p_user_id,'studio_data_owner',p_user_id,'updated',jsonb_build_object('workspaceShared',true));
  else
    -- Preserve project-chat privacy and stop active project sharing before unlinking the workspace.
    update public.studio_project_members pm set status='revoked',updated_at=now()
      where pm.organization_id=p_organization_id and pm.status='active'
        and pm.project_id in (select p.id from public.projects p where p.user_id=p_user_id);
    update public.chat_conversation_members cm set status='removed',removed_at=now()
      from public.chat_conversations c
      where c.id=cm.conversation_id and c.organization_id=p_organization_id and c.kind='project'
        and cm.user_id<>p_user_id and cm.status='active' and c.project_id in
          (select p.id from public.projects p where p.user_id=p_user_id);
    delete from public.studio_data_owners where user_id=p_user_id and organization_id=p_organization_id;
    insert into public.studio_audit_events(organization_id,actor_user_id,owner_user_id,entity_type,entity_id,action,metadata)
    values(p_organization_id,auth.uid(),p_user_id,'studio_data_owner',p_user_id,'updated',jsonb_build_object('workspaceShared',false));
  end if;
  return true;
end;
$$;

create or replace function public.studio_list_app_audit_events(p_organization_id uuid, p_limit integer default 100)
returns table(id uuid, actor_user_id uuid, owner_user_id uuid, entity_type text, entity_id uuid,
              project_id uuid, action text, metadata jsonb, created_at timestamptz)
language plpgsql stable security definer set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null or not public.chat_is_org_master(p_organization_id) then
    raise exception 'master_user_required' using errcode='42501';
  end if;
  return query select e.id,e.actor_user_id,e.owner_user_id,e.entity_type,e.entity_id,e.project_id,e.action,e.metadata,e.created_at
    from public.studio_audit_events e where e.organization_id=p_organization_id
    order by e.created_at desc,e.id desc limit greatest(1,least(coalesce(p_limit,100),200));
end;
$$;

-- Keep user_id as the record owner. Even a Master User cannot silently rewrite
-- ownership on an UPDATE; ownership transfer should be an explicit audited RPC.
create or replace function public.studio_preserve_record_owner()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'UPDATE' then new.user_id := old.user_id; end if;
  return new;
end;
$$;

-- Generic audit trigger records only operation metadata and the names of changed
-- columns. It never copies lead notes, invoice descriptions, financial amounts, or message text.
create or replace function public.studio_audit_app_record_trigger()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_old jsonb := '{}'::jsonb; v_new jsonb := '{}'::jsonb; v_source jsonb;
        v_owner uuid; v_project uuid; v_entity uuid; v_org uuid; v_action text;
        v_changed text[] := '{}'::text[]; v_key text;
begin
  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;
  v_source := case when tg_op='DELETE' then v_old else v_new end;
  v_owner := nullif(v_source->>'user_id','')::uuid;
  v_entity := nullif(v_source->>'id','')::uuid;
  v_project := nullif(v_source->>'project_id','')::uuid;
  if tg_table_name='projects' then v_project := v_entity; end if;
  select o.organization_id into v_org from public.studio_data_owners o where o.user_id=v_owner;
  if v_org is null and v_project is not null then
    select o.organization_id into v_org from public.projects p
      join public.studio_data_owners o on o.user_id=p.user_id where p.id=v_project;
  end if;
  if v_org is not null then
    if tg_op='UPDATE' then
      for v_key in select e.key from jsonb_each(v_new) as e(key, value) where v_new->e.key is distinct from v_old->e.key loop
        if v_key not in ('updated_at','updatedAt','last_seen_at','last_active_at') then v_changed := array_append(v_changed,v_key); end if;
      end loop;
    end if;
    v_action := case tg_op when 'INSERT' then 'created' when 'UPDATE' then 'updated' else 'deleted' end;
    insert into public.studio_audit_events(organization_id,actor_user_id,owner_user_id,entity_type,entity_id,project_id,action,metadata)
    values(v_org,auth.uid(),v_owner,tg_table_name,v_entity,v_project,v_action,
      jsonb_build_object('changedColumns',v_changed,'rowOwnerPreserved',tg_op='UPDATE'));
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;

-- Existing RLS remains the first layer and still allows each user to access their
-- own rows. These additional policies only enable authorized cross-user access.
do $$
declare r record;
begin
  -- Projects: explicit assigned access and department-scoped permissions.
  if to_regclass('public.projects') is not null then
    drop policy if exists studio_projects_shared_select on public.projects;
    create policy studio_projects_shared_select on public.projects for select to authenticated
      using (public.studio_user_has_app_permission('projects.read',user_id,id,'project',id));
    drop policy if exists studio_projects_shared_update on public.projects;
    create policy studio_projects_shared_update on public.projects for update to authenticated
      using (public.studio_user_has_app_permission('projects.write',user_id,id,'project',id))
      with check (public.studio_user_has_app_permission('projects.write',user_id,id,'project',id));
    drop policy if exists studio_projects_shared_delete on public.projects;
    create policy studio_projects_shared_delete on public.projects for delete to authenticated
      using (public.studio_user_has_app_permission('projects.delete',user_id,id,'project',id));
  end if;
  if to_regclass('public.shots') is not null then
    drop policy if exists studio_shots_shared_select on public.shots;
    create policy studio_shots_shared_select on public.shots for select to authenticated
      using (public.studio_user_has_app_permission('shots.read',user_id,project_id,'shot',id));
    drop policy if exists studio_shots_shared_insert on public.shots;
    create policy studio_shots_shared_insert on public.shots for insert to authenticated
      with check (user_id=auth.uid() and public.studio_user_has_app_permission('shots.write',user_id,project_id,'shot',id));
    drop policy if exists studio_shots_shared_update on public.shots;
    create policy studio_shots_shared_update on public.shots for update to authenticated
      using (public.studio_user_has_app_permission('shots.write',user_id,project_id,'shot',id))
      with check (public.studio_user_has_app_permission('shots.write',user_id,project_id,'shot',id));
    drop policy if exists studio_shots_shared_delete on public.shots;
    create policy studio_shots_shared_delete on public.shots for delete to authenticated
      using (public.studio_user_has_app_permission('shots.delete',user_id,project_id,'shot',id));
  end if;
  if to_regclass('public.leads') is not null then
    drop policy if exists studio_leads_shared_select on public.leads;
    create policy studio_leads_shared_select on public.leads for select to authenticated
      using (public.studio_user_has_app_permission('crm.read',user_id,null,'lead',id));
    drop policy if exists studio_leads_shared_update on public.leads;
    create policy studio_leads_shared_update on public.leads for update to authenticated
      using (public.studio_user_has_app_permission('crm.write',user_id,null,'lead',id))
      with check (public.studio_user_has_app_permission('crm.write',user_id,null,'lead',id));
    drop policy if exists studio_leads_shared_delete on public.leads;
    create policy studio_leads_shared_delete on public.leads for delete to authenticated
      using (public.studio_user_has_app_permission('crm.delete',user_id,null,'lead',id));
  end if;
  if to_regclass('public.contacts') is not null then
    drop policy if exists studio_contacts_shared_select on public.contacts;
    create policy studio_contacts_shared_select on public.contacts for select to authenticated
      using (public.studio_user_has_app_permission('contacts.read',user_id,null,'contact',id));
    drop policy if exists studio_contacts_shared_update on public.contacts;
    create policy studio_contacts_shared_update on public.contacts for update to authenticated
      using (public.studio_user_has_app_permission('contacts.write',user_id,null,'contact',id))
      with check (public.studio_user_has_app_permission('contacts.write',user_id,null,'contact',id));
    drop policy if exists studio_contacts_shared_delete on public.contacts;
    create policy studio_contacts_shared_delete on public.contacts for delete to authenticated
      using (public.studio_user_has_app_permission('contacts.delete',user_id,null,'contact',id));
  end if;
  -- Finance document reads may be shared with the Master User and designated
  -- Finance department administrators. Cross-owner writes remain under existing
  -- Finance/payment RPC and RLS rules until those paths are explicitly migrated.
  if to_regclass('public.invoices') is not null then
    drop policy if exists studio_invoices_shared_select on public.invoices;
    create policy studio_invoices_shared_select on public.invoices for select to authenticated
      using (public.studio_user_has_app_permission('invoices.read',user_id,project_id,'invoice',id));
  end if;
  if to_regclass('public.expenses') is not null then
    drop policy if exists studio_expenses_shared_select on public.expenses;
    create policy studio_expenses_shared_select on public.expenses for select to authenticated
      using (public.studio_user_has_app_permission('expenses.read',user_id,project_id,'expense',id));
  end if;
  if to_regclass('public.team_members') is not null then
    drop policy if exists studio_team_members_shared_select on public.team_members;
    create policy studio_team_members_shared_select on public.team_members for select to authenticated
      using (public.studio_user_has_app_permission('teams.read',user_id,null,'team_member',id));
    drop policy if exists studio_team_members_shared_update on public.team_members;
    create policy studio_team_members_shared_update on public.team_members for update to authenticated
      using (public.studio_user_has_app_permission('teams.write',user_id,null,'team_member',id))
      with check (public.studio_user_has_app_permission('teams.write',user_id,null,'team_member',id));
    drop policy if exists studio_team_members_shared_delete on public.team_members;
    create policy studio_team_members_shared_delete on public.team_members for delete to authenticated
      using (public.studio_user_has_app_permission('teams.delete',user_id,null,'team_member',id));
  end if;
  if to_regclass('public.activity_log') is not null then
    drop policy if exists studio_activity_shared_select on public.activity_log;
    create policy studio_activity_shared_select on public.activity_log for select to authenticated
      using (public.studio_user_has_app_permission('activity.read',user_id,project_id,'activity',id));
  end if;
end $$;

-- Enforce immutable row ownership across the shared-record tables.
do $$
declare v_table text;
begin
  foreach v_table in array array['projects','shots','leads','contacts','invoices','expenses','team_members'] loop
    if to_regclass('public.'||v_table) is not null and exists (
      select 1 from information_schema.columns c where c.table_schema='public' and c.table_name=v_table and c.column_name='user_id'
    ) then
      execute format('drop trigger if exists studio_preserve_record_owner on public.%I',v_table);
      execute format('create trigger studio_preserve_record_owner before update of user_id on public.%I for each row execute function public.studio_preserve_record_owner()',v_table);
      execute format('drop trigger if exists studio_audit_record_change on public.%I',v_table);
      execute format('create trigger studio_audit_record_change after insert or update or delete on public.%I for each row execute function public.studio_audit_app_record_trigger()',v_table);
    end if;
  end loop;
end $$;

-- Keep ownership of the remaining private workspace modules protected too; these
-- tables remain own-only in this release, but can safely be shared in a reviewed
-- follow-up by adding permission policies rather than changing identity columns.
do $$
declare v_table text;
begin
  foreach v_table in array array['budget_planners','planner_templates','pipeline_stages','project_stages','studio_tasks','studio_task_series','finance_settings','chart_accounts','journal_entries','journal_lines','finance_contacts','bank_accounts','bill_shots','bills','bill_payments','invoice_payments','finance_audit_log'] loop
    if to_regclass('public.'||v_table) is not null and exists (
      select 1 from information_schema.columns c where c.table_schema='public' and c.table_name=v_table and c.column_name='user_id'
    ) then
      execute format('drop trigger if exists studio_preserve_record_owner on public.%I',v_table);
      execute format('create trigger studio_preserve_record_owner before update of user_id on public.%I for each row execute function public.studio_preserve_record_owner()',v_table);
    end if;
  end loop;
end $$;

-- Keep project conversation creation compatible with explicit project assignments.
-- The prior version allowed only the project owner or Master User to select the
-- project, even after this migration introduced authorized project-member grants.
create or replace function public.chat_create_conversation(
  p_organization_id uuid, p_kind text, p_title text, p_member_ids uuid[] default '{}',
  p_department_id uuid default null, p_project_id uuid default null
) returns uuid language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_id uuid; v_project_name text; v_project_owner uuid; v_master_user uuid; v_target_count integer; v_valid_count integer;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode='28000'; end if;
  if not public.chat_is_internal_member(p_organization_id) then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_kind not in ('group','project') then raise exception 'invalid_conversation_kind' using errcode='22023'; end if;
  if p_kind='group' and (nullif(btrim(p_title),'') is null or char_length(btrim(p_title))>100) then raise exception 'invalid_group_title' using errcode='22023'; end if;
  if p_kind='project' then
    if p_project_id is null then raise exception 'project_required' using errcode='22023'; end if;
    select p.name,p.user_id into v_project_name,v_project_owner from public.projects p
      where p.id=p_project_id and public.chat_user_can_access_project(p_organization_id,p.id,auth.uid());
    if v_project_name is null then raise exception 'project_not_found_or_not_authorized' using errcode='42501'; end if;
    p_title := null;
  elsif p_project_id is not null then raise exception 'project_not_allowed_for_group' using errcode='22023';
  end if;
  if p_department_id is not null then
    if p_kind <> 'group' then raise exception 'department_only_for_groups' using errcode='22023'; end if;
    if not exists (select 1 from public.studio_departments d where d.id=p_department_id and d.organization_id=p_organization_id) then raise exception 'department_not_found' using errcode='22023'; end if;
    if not public.chat_is_org_master(p_organization_id) and not public.chat_is_department_admin(p_organization_id,p_department_id) then raise exception 'department_admin_required' using errcode='42501'; end if;
  end if;
  select count(*) into v_target_count from (select distinct x from unnest(coalesce(p_member_ids,'{}'::uuid[])) x where x is not null and x<>auth.uid()) s;
  if v_target_count > 49 then raise exception 'too_many_members' using errcode='22023'; end if;
  select count(*) into v_valid_count from (
    select distinct x from unnest(coalesce(p_member_ids,'{}'::uuid[])) x where x is not null and x<>auth.uid()
  ) t join public.studio_memberships m on m.organization_id=p_organization_id and m.user_id=t.x and m.status='active' and m.role<>'client';
  if v_valid_count<>v_target_count then raise exception 'one_or_more_members_not_eligible' using errcode='42501'; end if;
  if p_kind='project' and exists (
    select 1 from (select distinct x from unnest(coalesce(p_member_ids,'{}'::uuid[])) x where x is not null and x<>auth.uid()) t
    where not public.chat_user_can_access_project(p_organization_id,p_project_id,t.x)
  ) then raise exception 'project_access_required' using errcode='42501'; end if;
  if p_department_id is not null and exists (
    select 1 from (select distinct x from unnest(coalesce(p_member_ids,'{}'::uuid[])) x where x is not null and x<>auth.uid()) t
    where not exists (select 1 from public.studio_department_memberships dm where dm.organization_id=p_organization_id and dm.department_id=p_department_id and dm.user_id=t.x)
  ) then raise exception 'all_members_must_belong_to_department' using errcode='42501'; end if;
  insert into public.chat_conversations(organization_id,kind,audience,title,project_id,project_name,department_id,created_by)
  values(p_organization_id,p_kind,'internal',case when p_kind='group' then btrim(p_title) else null end,
    case when p_kind='project' then p_project_id else null end,
    case when p_kind='project' then v_project_name else null end,p_department_id,auth.uid()) returning id into v_id;
  insert into public.chat_conversation_members(organization_id,conversation_id,user_id,role,status)
  values(p_organization_id,v_id,auth.uid(),case when p_kind='project' and v_project_owner<>auth.uid() then 'admin' else 'owner' end,'active');
  if p_kind='project' then
    if v_project_owner<>auth.uid() then
      insert into public.chat_conversation_members(organization_id,conversation_id,user_id,role,status)
      values(p_organization_id,v_id,v_project_owner,'owner','active');
    end if;
    select user_id into v_master_user from public.studio_memberships
      where organization_id=p_organization_id and status='active' and role='master_user' limit 1;
    if v_master_user is not null and v_master_user<>auth.uid() and v_master_user<>v_project_owner then
      insert into public.chat_conversation_members(organization_id,conversation_id,user_id,role,status)
      values(p_organization_id,v_id,v_master_user,'admin','active');
    end if;
  end if;
  insert into public.chat_conversation_members(organization_id,conversation_id,user_id,role,status)
  select p_organization_id,v_id,t.x,'member','active'
  from (select distinct x from unnest(coalesce(p_member_ids,'{}'::uuid[])) x
        where x is not null and x<>auth.uid()
          and (v_project_owner is null or x<>v_project_owner)
          and (v_master_user is null or x<>v_master_user)) t
  on conflict(conversation_id,user_id) do nothing;
  if p_kind='project' then
    insert into public.chat_conversation_members(organization_id,conversation_id,user_id,role,status)
    select p_organization_id,v_id,pm.user_id,'member','active'
    from public.studio_project_members pm
    join public.studio_memberships sm on sm.organization_id=pm.organization_id and sm.user_id=pm.user_id
    where pm.organization_id=p_organization_id and pm.project_id=p_project_id and pm.status='active'
      and sm.status='active' and sm.role<>'client' and pm.user_id not in (auth.uid(),v_project_owner,coalesce(v_master_user,auth.uid()))
    on conflict(conversation_id,user_id) do nothing;
  end if;
  return v_id;
end;
$$;

-- Any project-linked chat now honors explicit project access, so revoking the
-- project assignment also denies future chat queries and attachment downloads.
create or replace function public.chat_list_project_options(p_organization_id uuid)
returns table(id uuid, name text)
language plpgsql stable security definer set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null or not public.chat_is_internal_member(p_organization_id) then
    raise exception 'not_authorized' using errcode='42501';
  end if;
  return query
    select distinct p.id,p.name from public.projects p
    where (p.user_id=auth.uid() or exists (select 1 from public.studio_data_owners o
        where o.user_id=p.user_id and o.organization_id=p_organization_id))
      and public.chat_user_can_access_project(p_organization_id,p.id,auth.uid())
    order by p.name limit 500;
end;
$$;

-- RPC hardening / grants. Direct table writes are never given to clients.
revoke all on function public.chat_user_can_access_project(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.studio_user_has_app_permission(text,uuid,uuid,text,uuid) from public, anon;
grant execute on function public.studio_user_has_app_permission(text,uuid,uuid,text,uuid) to authenticated;
revoke all on function public.studio_is_member_of_org(uuid) from public, anon;
grant execute on function public.studio_is_member_of_org(uuid) to authenticated;
revoke all on function public.studio_seed_department_permissions() from public, anon, authenticated;
revoke all on function public.studio_preserve_record_owner() from public, anon, authenticated;
revoke all on function public.studio_audit_app_record_trigger() from public, anon, authenticated;
revoke all on function public.chat_add_studio_member_with_workspace(uuid,text,text,text,uuid,boolean) from public, anon;
grant execute on function public.chat_add_studio_member_with_workspace(uuid,text,text,text,uuid,boolean) to authenticated;
revoke all on function public.studio_list_manageable_projects(uuid) from public, anon;
revoke all on function public.studio_list_project_access(uuid,uuid) from public, anon;
revoke all on function public.studio_assign_project_access(uuid,uuid,uuid,text) from public, anon;
revoke all on function public.studio_revoke_project_access(uuid,uuid,uuid) from public, anon;
revoke all on function public.studio_list_department_permissions(uuid,uuid) from public, anon;
revoke all on function public.studio_set_department_permission(uuid,uuid,text,boolean) from public, anon;
revoke all on function public.studio_list_app_audit_events(uuid,integer) from public, anon;
revoke all on function public.studio_list_workspace_sharing(uuid) from public, anon;
revoke all on function public.studio_set_workspace_sharing(uuid,uuid,boolean) from public, anon;
grant execute on function public.studio_list_manageable_projects(uuid), public.studio_list_project_access(uuid,uuid),
  public.studio_assign_project_access(uuid,uuid,uuid,text), public.studio_revoke_project_access(uuid,uuid,uuid),
  public.studio_list_department_permissions(uuid,uuid), public.studio_set_department_permission(uuid,uuid,text,boolean),
  public.studio_list_workspace_sharing(uuid), public.studio_set_workspace_sharing(uuid,uuid,boolean),
  public.studio_list_app_audit_events(uuid,integer) to authenticated;

commit;
