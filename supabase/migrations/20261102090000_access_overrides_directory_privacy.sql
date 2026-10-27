-- KairFlow access hardening, part 1 of 2 (part 2: 20261102100000_portal_guest_client_chat.sql).
--
--  * Master-managed, auditable per-member permission overrides (allow / deny) layered on top of
--    department defaults, plus two explicit capabilities: directory.view and chat.create_groups.
--  * Private company directory: ordinary members can no longer list the whole roster.
--  * Group creation is off by default and granted only by the Master User.
--
-- Additive and re-runnable. It re-declares existing functions with CREATE OR REPLACE using the
-- same signatures, never drops data, and does not touch the finance ledger or its RPC-only paths.
-- Depends on 20261029090000 .. 20261101090000. It does not apply itself to any database.

begin;

-- ---------------------------------------------------------------------------------------------
-- 1. Per-member overrides (organization scoped, Master managed)
-- ---------------------------------------------------------------------------------------------
-- Data keys that an individual grant may open. Project and shot data are deliberately NOT here:
-- they stay governed by explicit project assignment (studio_project_members). Finance keys are
-- NOT here either: invoices/expenses remain department-level so a single toggle cannot expose them.
create table if not exists public.studio_member_overrides (
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  user_id uuid not null,
  permission_key text not null,
  effect text not null check (effect in ('allow','deny')),
  reason text check (reason is null or char_length(reason) <= 200),
  set_by uuid references auth.users(id) on delete set null,
  set_at timestamptz not null default now(),
  primary key (organization_id, user_id, permission_key),
  foreign key (organization_id, user_id)
    references public.studio_memberships(organization_id, user_id) on delete cascade,
  constraint studio_member_overrides_key_check check (
    (permission_key in ('directory.view','chat.create_groups') and effect = 'allow')
    or permission_key in ('crm.read','crm.write','contacts.read','contacts.write','teams.read','teams.write')
  )
);
create index if not exists studio_member_overrides_user_idx
  on public.studio_member_overrides(organization_id, user_id, permission_key);
alter table public.studio_member_overrides enable row level security;
revoke all on public.studio_member_overrides from public, anon, authenticated;

-- Internal helper: capability check for an explicit user. Master always has every capability.
-- Never granted to clients; it is only called from SECURITY DEFINER functions below.
create or replace function public.studio_has_capability(p_organization_id uuid, p_user_id uuid, p_capability text)
returns boolean language sql stable security definer set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.studio_memberships m
    where m.organization_id = p_organization_id and m.user_id = p_user_id
      and m.status = 'active' and m.role <> 'client'
      and (m.role = 'master_user' or exists (
        select 1 from public.studio_member_overrides o
        where o.organization_id = m.organization_id and o.user_id = m.user_id
          and o.permission_key = p_capability and o.effect = 'allow'))
  );
$$;
revoke all on function public.studio_has_capability(uuid, uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. Permission predicate: explicit override beats department defaults. Everything else is the
--    previous (20261031090000) behavior, unchanged.
-- ---------------------------------------------------------------------------------------------
create or replace function public.studio_user_has_app_permission(
  p_permission_key text,
  p_owner_user_id uuid,
  p_project_id uuid default null,
  p_record_type text default null,
  p_record_id uuid default null
) returns boolean language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare v_org uuid; v_override text;
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

  -- Master-set individual override for module data. A deny wins over any department default.
  -- An allow opens only records owned by a studio-mapped data owner, and only for the keys the
  -- table constraint permits (never project, shot or finance data).
  select o.effect into v_override from public.studio_member_overrides o
   where o.organization_id=v_org and o.user_id=auth.uid() and o.permission_key=p_permission_key;
  if v_override = 'deny' then return false; end if;
  if v_override = 'allow' then
    return exists(select 1 from public.studio_data_owners own
      where own.organization_id=v_org and own.user_id=p_owner_user_id);
  end if;

  if exists (
    select 1 from public.studio_memberships me
    join public.studio_role_permissions rp on rp.role=me.role and rp.permission_key=p_permission_key
    where me.organization_id=v_org and me.user_id=auth.uid() and me.status='active'
      and case rp.access_scope
        when 'own' then p_owner_user_id=auth.uid()
        when 'organization' then false
        when 'assigned' then p_project_id is not null and exists (
          select 1 from public.studio_project_members pm where pm.organization_id=v_org and pm.project_id=p_project_id
            and pm.user_id=auth.uid() and pm.status='active'
            and (p_permission_key like '%.read' or (p_permission_key like '%.write' and pm.access_level in ('contributor','editor'))
              or (p_permission_key like '%.delete' and pm.access_level='editor'))
        )
        else false end
  ) then return true; end if;

  if p_permission_key in ('projects.read','projects.write','projects.delete','shots.read','shots.write','shots.delete') then
    return p_project_id is not null and exists(
      select 1 from public.studio_project_members pm where pm.organization_id=v_org
        and pm.project_id=p_project_id and pm.user_id=auth.uid() and pm.status='active'
        and (p_permission_key like '%.read'
          or (p_permission_key like '%.write' and pm.access_level in ('contributor','editor'))
          or (p_permission_key like '%.delete' and pm.access_level='editor'))
    );
  end if;

  if p_permission_key = 'activity.read' and p_project_id is not null then
    return exists (
      select 1 from public.studio_project_members pm
      where pm.organization_id=v_org and pm.project_id=p_project_id
        and pm.user_id=auth.uid() and pm.status='active'
    );
  end if;

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
revoke all on function public.studio_user_has_app_permission(text,uuid,uuid,text,uuid) from public, anon;
grant execute on function public.studio_user_has_app_permission(text,uuid,uuid,text,uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. Master-only management RPCs
-- ---------------------------------------------------------------------------------------------
create or replace function public.studio_set_member_override(
  p_organization_id uuid, p_user_id uuid, p_permission_key text, p_effect text, p_reason text default null
) returns boolean language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_role text; v_old text;
begin
  if auth.uid() is null or not public.chat_is_org_master(p_organization_id) then
    raise exception 'master_user_required' using errcode='42501';
  end if;
  p_effect := lower(btrim(coalesce(p_effect,'')));
  if p_effect not in ('allow','deny','inherit') then raise exception 'invalid_effect' using errcode='22023'; end if;
  if p_permission_key is null or p_permission_key not in (
    'directory.view','chat.create_groups','crm.read','crm.write','contacts.read','contacts.write','teams.read','teams.write'
  ) then raise exception 'invalid_permission' using errcode='22023'; end if;
  if p_permission_key in ('directory.view','chat.create_groups') and p_effect = 'deny' then
    raise exception 'capabilities_are_off_by_default' using errcode='22023';
  end if;
  select m.role into v_role from public.studio_memberships m
    where m.organization_id=p_organization_id and m.user_id=p_user_id and m.status='active';
  if v_role is null then raise exception 'target_not_active_member' using errcode='42501'; end if;
  if v_role = 'master_user' then raise exception 'cannot_override_master' using errcode='42501'; end if;
  if v_role = 'client' then raise exception 'target_not_eligible' using errcode='42501'; end if;
  select o.effect into v_old from public.studio_member_overrides o
    where o.organization_id=p_organization_id and o.user_id=p_user_id and o.permission_key=p_permission_key;
  if p_effect = 'inherit' then
    delete from public.studio_member_overrides
      where organization_id=p_organization_id and user_id=p_user_id and permission_key=p_permission_key;
  else
    insert into public.studio_member_overrides(organization_id,user_id,permission_key,effect,reason,set_by,set_at)
    values(p_organization_id,p_user_id,p_permission_key,p_effect,left(nullif(btrim(coalesce(p_reason,'')),''),200),auth.uid(),now())
    on conflict(organization_id,user_id,permission_key) do update
      set effect=excluded.effect, reason=excluded.reason, set_by=auth.uid(), set_at=now();
  end if;
  insert into public.studio_audit_events(organization_id,actor_user_id,owner_user_id,entity_type,entity_id,action,metadata)
  values(p_organization_id,auth.uid(),p_user_id,'member_override',p_user_id,'updated',
    jsonb_build_object('permission',p_permission_key,'from',coalesce(v_old,'inherit'),'to',p_effect));
  return true;
end;
$$;

create or replace function public.studio_list_member_overrides(p_organization_id uuid, p_user_id uuid default null)
returns table(user_id uuid, permission_key text, effect text, reason text, set_by uuid, set_at timestamptz)
language plpgsql stable security definer set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null or not public.chat_is_org_master(p_organization_id) then
    raise exception 'master_user_required' using errcode='42501';
  end if;
  return query select o.user_id,o.permission_key,o.effect,o.reason,o.set_by,o.set_at
    from public.studio_member_overrides o
    where o.organization_id=p_organization_id and (p_user_id is null or o.user_id=p_user_id)
    order by o.user_id,o.permission_key;
end;
$$;

-- "Why can this person see that?" Reports the effective result and its source for each key.
create or replace function public.studio_member_effective_permissions(p_organization_id uuid, p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public
as $$
declare
  v_role text; v_name text; v_is_master boolean; v_items jsonb := '[]'::jsonb; v_key text;
  v_override text; v_dept text; v_scope text; v_assigned integer; v_departments text[];
  v_effective boolean; v_source text; v_detail text;
begin
  if auth.uid() is null or not public.chat_is_org_master(p_organization_id) then
    raise exception 'master_user_required' using errcode='42501';
  end if;
  select m.role, m.display_name into v_role, v_name from public.studio_memberships m
    where m.organization_id=p_organization_id and m.user_id=p_user_id and m.status='active';
  if v_role is null then raise exception 'target_not_active_member' using errcode='42501'; end if;
  v_is_master := v_role = 'master_user';
  select coalesce(array_agg(distinct d.name order by d.name),'{}'::text[]) into v_departments
    from public.studio_department_memberships dm
    join public.studio_departments d on d.id=dm.department_id and d.organization_id=dm.organization_id
    where dm.organization_id=p_organization_id and dm.user_id=p_user_id;
  select count(distinct pm.project_id)::integer into v_assigned from public.studio_project_members pm
    where pm.organization_id=p_organization_id and pm.user_id=p_user_id and pm.status='active';

  foreach v_key in array array[
    'crm.read','crm.write','contacts.read','contacts.write','teams.read','teams.write',
    'invoices.read','expenses.read','activity.read','projects.read','shots.read',
    'directory.view','chat.create_groups'
  ] loop
    v_effective := false; v_source := 'none'; v_detail := null;
    select o.effect into v_override from public.studio_member_overrides o
      where o.organization_id=p_organization_id and o.user_id=p_user_id and o.permission_key=v_key;
    if v_is_master then
      v_effective := true; v_source := 'master';
    elsif v_override = 'deny' then
      v_effective := false; v_source := 'override_deny';
    elsif v_override = 'allow' then
      v_effective := true; v_source := 'override_allow';
    elsif v_key in ('projects.read','shots.read') then
      -- Module visibility is separate from data: data always needs an explicit project assignment.
      v_effective := v_assigned > 0;
      v_source := case when v_assigned > 0 then 'project_assignment' else 'none' end;
      v_detail := case when v_assigned > 0 then v_assigned::text || ' assigned project(s)' else null end;
      if v_assigned = 0 and exists (select 1 from public.studio_department_memberships dm
          join public.studio_department_permissions dp on dp.organization_id=dm.organization_id and dp.department_id=dm.department_id
          where dm.organization_id=p_organization_id and dm.user_id=p_user_id and dp.permission_key=v_key) then
        v_source := 'department_module_only';
        v_detail := 'Department opens the module; no project is assigned yet';
      end if;
    elsif v_key in ('directory.view','chat.create_groups') then
      v_effective := false; v_source := 'none';
    else
      select d.name into v_dept from public.studio_department_memberships dm
        join public.studio_departments d on d.id=dm.department_id and d.organization_id=dm.organization_id
        join public.studio_department_permissions dp on dp.organization_id=dm.organization_id and dp.department_id=dm.department_id
        where dm.organization_id=p_organization_id and dm.user_id=p_user_id and dp.permission_key=v_key
        order by d.name limit 1;
      if v_dept is not null then
        v_effective := true; v_source := 'department'; v_detail := v_dept;
      else
        select rp.access_scope into v_scope from public.studio_role_permissions rp
          where rp.role=v_role and rp.permission_key=v_key limit 1;
        if v_scope is not null then
          v_effective := true; v_source := 'role_default'; v_detail := v_scope || ' scope';
        end if;
      end if;
    end if;
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'key',v_key,'effective',v_effective,'source',v_source,'detail',v_detail,'override',v_override));
  end loop;
  return jsonb_build_object('user_id',p_user_id,'display_name',v_name,'role',v_role,
    'departments',to_jsonb(v_departments),'assigned_project_count',coalesce(v_assigned,0),'items',v_items);
end;
$$;

-- What the signed-in person can see about their own grants (UI hint only; RPCs and RLS decide).
create or replace function public.studio_get_my_capabilities(p_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public
as $$
declare v_overrides jsonb;
begin
  if auth.uid() is null or not public.chat_is_internal_member(p_organization_id) then
    return jsonb_build_object('can_view_directory',false,'can_create_groups',false,'overrides','{}'::jsonb);
  end if;
  select coalesce(jsonb_object_agg(o.permission_key,o.effect),'{}'::jsonb) into v_overrides
    from public.studio_member_overrides o where o.organization_id=p_organization_id and o.user_id=auth.uid();
  return jsonb_build_object(
    'can_view_directory',public.studio_has_capability(p_organization_id,auth.uid(),'directory.view'),
    'can_create_groups',public.studio_has_capability(p_organization_id,auth.uid(),'chat.create_groups'),
    'overrides',v_overrides);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 3b. Access context carries the caller's own grants (UI hint only; RLS/RPCs remain the boundary).
--     The original function is kept under a new name and wrapped, so its body is not duplicated.
-- ---------------------------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.studio_access_context_base_for_org(uuid)') is null then
    alter function public.studio_get_app_access_context_for_org(uuid) rename to studio_access_context_base_for_org;
  end if;
end $$;
revoke all on function public.studio_access_context_base_for_org(uuid) from public, anon, authenticated;

create or replace function public.studio_get_app_access_context_for_org(p_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public
as $$
declare v_base jsonb; v_caps jsonb;
begin
  v_base := public.studio_access_context_base_for_org(p_organization_id);
  if coalesce((v_base->>'is_member')::boolean, false) is not true then return v_base; end if;
  v_caps := public.studio_get_my_capabilities(p_organization_id);
  return v_base || jsonb_build_object(
    'member_overrides', coalesce(v_caps->'overrides','{}'::jsonb),
    'can_view_directory', coalesce((v_caps->>'can_view_directory')::boolean,false),
    'can_create_groups', coalesce((v_caps->>'can_create_groups')::boolean,false));
end;
$$;
revoke all on function public.studio_get_app_access_context_for_org(uuid) from public, anon;
grant execute on function public.studio_get_app_access_context_for_org(uuid) to authenticated;

-- Master-only list used by the Teams permissions panel to map roster people to logins.
create or replace function public.studio_list_member_logins(p_organization_id uuid)
returns table(user_id uuid, team_member_id uuid, display_name text, role text, status text)
language plpgsql stable security definer set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null or not public.chat_is_org_master(p_organization_id) then
    raise exception 'master_user_required' using errcode='42501';
  end if;
  return query select m.user_id, m.team_member_id, m.display_name, m.role, m.status
    from public.studio_memberships m where m.organization_id = p_organization_id and m.role <> 'client'
    order by m.display_name;
end;
$$;
revoke all on function public.studio_list_member_logins(uuid) from public, anon;
grant execute on function public.studio_list_member_logins(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 4. Private directory
-- ---------------------------------------------------------------------------------------------
-- A person is visible to the caller when the caller is Master, has the directory.view grant,
-- is that person, or already shares an active conversation with them.
create or replace function public.chat_can_see_person(p_organization_id uuid, p_target_user_id uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, public
as $$
  select p_target_user_id is not null and auth.uid() is not null
    and public.chat_is_internal_member(p_organization_id)
    and (
      p_target_user_id = auth.uid()
      or public.studio_has_capability(p_organization_id, auth.uid(), 'directory.view')
      or exists (
        select 1 from public.chat_conversation_members mine
        join public.chat_conversation_members theirs on theirs.conversation_id = mine.conversation_id
        join public.chat_conversations c on c.id = mine.conversation_id
        where mine.user_id = auth.uid() and mine.status = 'active'
          and theirs.user_id = p_target_user_id and theirs.status = 'active'
          and c.organization_id = p_organization_id and c.archived_at is null
      )
    );
$$;
revoke all on function public.chat_can_see_person(uuid, uuid) from public, anon, authenticated;

create or replace function public.chat_list_directory(p_organization_id uuid)
returns table (user_id uuid, display_name text, role text, department_names text[])
language plpgsql stable security definer set search_path = pg_catalog, public
as $$
declare v_all boolean;
begin
  if auth.uid() is null or not public.chat_is_internal_member(p_organization_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_all := public.studio_has_capability(p_organization_id, auth.uid(), 'directory.view');
  return query
  select m.user_id, m.display_name, m.role,
    case when v_all then coalesce(array_agg(distinct d.name) filter (where d.name is not null), '{}'::text[])
         else '{}'::text[] end
  from public.studio_memberships m
  left join public.studio_department_memberships dm
    on v_all and dm.organization_id = m.organization_id and dm.user_id = m.user_id
  left join public.studio_departments d on d.organization_id = dm.organization_id and d.id = dm.department_id
  where m.organization_id = p_organization_id and m.status = 'active'
    and m.role <> 'client' and m.user_id <> auth.uid()
    and (v_all or public.chat_can_see_person(p_organization_id, m.user_id))
  group by m.user_id, m.display_name, m.role
  order by m.display_name
  limit 500;
end;
$$;

create or replace function public.chat_list_departments(p_organization_id uuid)
returns table (department_id uuid, name text, member_count bigint, is_admin boolean)
language plpgsql stable security definer set search_path = pg_catalog, public
as $$
declare v_all boolean;
begin
  if auth.uid() is null or not public.chat_is_internal_member(p_organization_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_all := public.studio_has_capability(p_organization_id, auth.uid(), 'directory.view');
  return query
  select d.id, d.name,
    case when v_all or public.chat_is_org_master(d.organization_id) then count(dm.user_id) else 0::bigint end,
    (public.chat_is_org_master(d.organization_id) or public.chat_is_department_admin(d.organization_id, d.id))
  from public.studio_departments d left join public.studio_department_memberships dm
    on dm.organization_id = d.organization_id and dm.department_id = d.id
  where d.organization_id = p_organization_id
    and (v_all or exists (select 1 from public.studio_department_memberships mine
          where mine.organization_id = d.organization_id and mine.department_id = d.id and mine.user_id = auth.uid()))
  group by d.id, d.name, d.organization_id order by d.name;
end;
$$;

-- Minimum identity for rendering a conversation the caller may already read: display names only
-- (no email, role-in-studio, department or contact data). Includes former members and any
-- sender whose message is in the conversation, so history never degrades to "Team member".
create or replace function public.chat_conversation_people(p_conversation_id uuid)
returns table (user_id uuid, display_name text, member_role text, member_status text)
language plpgsql stable security definer set search_path = pg_catalog, public
as $$
declare v_org uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode='28000'; end if;
  select c.organization_id into v_org from public.chat_conversations c where c.id = p_conversation_id;
  if v_org is null or not public.chat_can_read_conversation(p_conversation_id) then
    raise exception 'not_authorized' using errcode='42501';
  end if;
  return query
  with people as (
    select cm.user_id as uid, cm.role as mrole, cm.status as mstatus
      from public.chat_conversation_members cm where cm.conversation_id = p_conversation_id
    union
    select distinct msg.sender_user_id, 'member'::text, 'former'::text
      from public.chat_messages msg
      where msg.conversation_id = p_conversation_id and msg.sender_user_id is not null
        and not exists (select 1 from public.chat_conversation_members x
          where x.conversation_id = p_conversation_id and x.user_id = msg.sender_user_id)
  )
  select p.uid,
    coalesce(nullif(btrim(sm.display_name),''), case when p.mstatus = 'active' then 'Team member' else 'Former member' end),
    p.mrole, p.mstatus
  from people p
  left join public.studio_memberships sm on sm.organization_id = v_org and sm.user_id = p.uid
  order by 2
  limit 500;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 5. Conversation creation and membership honor the directory boundary
-- ---------------------------------------------------------------------------------------------
create or replace function public.chat_start_direct(p_organization_id uuid, p_target_user_id uuid)
returns uuid language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_pair text; v_id uuid; v_role text;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode='28000'; end if;
  if p_target_user_id=auth.uid() then raise exception 'cannot_message_self' using errcode='22023'; end if;
  if not public.chat_is_internal_member(p_organization_id) then raise exception 'not_authorized' using errcode='42501'; end if;
  select role into v_role from public.studio_memberships
    where organization_id=p_organization_id and user_id=p_target_user_id and status='active';
  if v_role is null or v_role='client' then raise exception 'target_not_chat_eligible' using errcode='42501'; end if;
  if not public.chat_can_see_person(p_organization_id, p_target_user_id) then
    raise exception 'target_not_visible' using errcode='42501';
  end if;
  v_pair := least(auth.uid(),p_target_user_id)::text || ':' || greatest(auth.uid(),p_target_user_id)::text;
  insert into public.chat_conversations(organization_id,kind,audience,direct_pair_key,created_by)
  values(p_organization_id,'direct','internal',v_pair,auth.uid())
  on conflict (organization_id,direct_pair_key) where kind='direct'
  do update set updated_at=now()
  returning id into v_id;
  insert into public.chat_conversation_members(organization_id,conversation_id,user_id,role,status)
  values(p_organization_id,v_id,auth.uid(),'member','active'),(p_organization_id,v_id,p_target_user_id,'member','active')
  on conflict (conversation_id,user_id) do update set status='active', left_at=null, removed_at=null, joined_at=now();
  return v_id;
end;
$$;

create or replace function public.chat_add_conversation_member(p_conversation_id uuid, p_target_user_id uuid)
returns boolean language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_conv public.chat_conversations%rowtype; v_role text;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode='28000'; end if;
  select * into v_conv from public.chat_conversations where id=p_conversation_id and archived_at is null;
  if not found or not public.chat_can_manage_conversation(p_conversation_id) then raise exception 'not_authorized' using errcode='42501'; end if;
  if v_conv.kind='direct' then raise exception 'direct_membership_is_fixed' using errcode='22023'; end if;
  select role into v_role from public.studio_memberships where organization_id=v_conv.organization_id and user_id=p_target_user_id and status='active';
  if v_role is null or v_role='client' then raise exception 'target_not_chat_eligible' using errcode='42501'; end if;
  -- Managing a conversation is not a license to pull in people the caller cannot see.
  if not public.chat_can_see_person(v_conv.organization_id, p_target_user_id) then
    raise exception 'target_not_visible' using errcode='42501';
  end if;
  if v_conv.kind='project' and not public.chat_user_can_access_project(v_conv.organization_id,v_conv.project_id,p_target_user_id) then
    raise exception 'project_access_required' using errcode='42501';
  end if;
  if v_conv.department_id is not null and not exists (
    select 1 from public.studio_department_memberships dm where dm.organization_id=v_conv.organization_id and dm.department_id=v_conv.department_id and dm.user_id=p_target_user_id
  ) then raise exception 'target_not_in_department' using errcode='42501'; end if;
  insert into public.chat_conversation_members(organization_id,conversation_id,user_id,role,status)
  values(v_conv.organization_id,v_conv.id,p_target_user_id,'member','active')
  on conflict (conversation_id,user_id) do update set status='active', left_at=null, removed_at=null, joined_at=now();
  return true;
end;
$$;

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
  -- Groups are disabled by default. Only the Master User, or a member the Master explicitly
  -- granted chat.create_groups, may create one. The check uses the caller's JWT identity only.
  if p_kind='group' and not public.studio_has_capability(p_organization_id, auth.uid(), 'chat.create_groups') then
    raise exception 'group_creation_not_permitted' using errcode='42501';
  end if;
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
  -- Creating a group is not permission to browse the roster: invitees must be people the creator can see.
  if exists (
    select 1 from (select distinct x from unnest(coalesce(p_member_ids,'{}'::uuid[])) x where x is not null and x<>auth.uid()) t
    where not public.chat_can_see_person(p_organization_id, t.x)
  ) then raise exception 'one_or_more_members_not_visible' using errcode='42501'; end if;
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

-- ---------------------------------------------------------------------------------------------
-- 6. Grants (explicit; nothing is left to defaults)
-- ---------------------------------------------------------------------------------------------
revoke all on function public.studio_set_member_override(uuid,uuid,text,text,text) from public, anon;
revoke all on function public.studio_list_member_overrides(uuid,uuid) from public, anon;
revoke all on function public.studio_member_effective_permissions(uuid,uuid) from public, anon;
revoke all on function public.studio_get_my_capabilities(uuid) from public, anon;
revoke all on function public.chat_conversation_people(uuid) from public, anon;
revoke all on function public.chat_list_directory(uuid) from public, anon;
revoke all on function public.chat_list_departments(uuid) from public, anon;
revoke all on function public.chat_start_direct(uuid,uuid) from public, anon;
revoke all on function public.chat_add_conversation_member(uuid,uuid) from public, anon;
revoke all on function public.chat_create_conversation(uuid,text,text,uuid[],uuid,uuid) from public, anon;
grant execute on function public.studio_set_member_override(uuid,uuid,text,text,text),
  public.studio_list_member_overrides(uuid,uuid), public.studio_member_effective_permissions(uuid,uuid),
  public.studio_get_my_capabilities(uuid), public.chat_conversation_people(uuid),
  public.chat_list_directory(uuid), public.chat_list_departments(uuid), public.chat_start_direct(uuid,uuid),
  public.chat_add_conversation_member(uuid,uuid), public.chat_create_conversation(uuid,text,text,uuid[],uuid,uuid)
  to authenticated;

commit;
