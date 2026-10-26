-- Multi-organization accounts: preserve each per-studio role and workspace.
-- Additive follow-up to the already-deployed invite/bootstrap migration.
-- Does not change or remove existing memberships, project grants, or ownership mappings.

begin;

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
    return jsonb_build_object('accepted',true,'organization_id',v_inv.organization_id,'organization_name',(select o.name from public.studio_organizations o where o.id=v_inv.organization_id),'role',v_inv.role,'already_accepted',true);
  end if;
  if v_inv.status<>'pending' or v_inv.expires_at<=now() then raise exception 'invite_not_found_or_expired' using errcode='P0002'; end if;
  if v_email<>lower(v_inv.invited_email) then raise exception 'invite_email_mismatch' using errcode='42501'; end if;
  -- Serialize accepts for the same user and target organization. Without this lock,
  -- two valid invitations from different roster records could both observe no row and
  -- race through ON CONFLICT, relinking the account to whichever transaction writes last.
  -- The lock key includes both IDs, so invitations into different studios remain independent.
  perform pg_advisory_xact_lock(hashtext(v_inv.organization_id::text), hashtext(v_user::text));

  -- A login may belong to multiple studios. Never delete, downgrade, or replace
  -- memberships in any other organization; this invitation only writes the row
  -- for v_inv.organization_id below.
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
  return jsonb_build_object('accepted',true,'organization_id',v_inv.organization_id,
    'organization_name',(select o.name from public.studio_organizations o where o.id=v_inv.organization_id),
    'role',v_inv.role,'department_id',v_inv.department_id,'team_member_id',v_inv.team_member_id);
end;
$$;


create or replace function public.studio_get_app_access_context_for_org(p_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public
as $$
declare
  v_row record;
  v_departments text[] := '{}'::text[];
  v_department_roles text[] := '{}'::text[];
  v_permissions text[] := '{}'::text[];
  v_owner_ids uuid[] := '{}'::uuid[];
  v_primary_owner uuid;
  v_projects integer := 0;
  v_editable_projects integer := 0;
begin
  if auth.uid() is null or p_organization_id is null then
    return jsonb_build_object('is_member', false);
  end if;

  select m.organization_id, o.name as organization_name, o.slug as organization_slug,
         m.role, m.display_name, m.team_member_id
    into v_row
    from public.studio_memberships m
    join public.studio_organizations o on o.id = m.organization_id
   where m.organization_id = p_organization_id
     and m.user_id = auth.uid()
     and m.status = 'active';
  if not found then
    return jsonb_build_object('is_member', false, 'organization_id', p_organization_id);
  end if;

  select coalesce(array_agg(distinct d.name order by d.name), '{}'::text[]),
         coalesce(array_agg(distinct dm.department_role), '{}'::text[]),
         coalesce(array_agg(distinct dp.permission_key) filter (where dp.permission_key is not null), '{}'::text[])
    into v_departments, v_department_roles, v_permissions
    from public.studio_department_memberships dm
    join public.studio_departments d
      on d.id = dm.department_id and d.organization_id = dm.organization_id
    left join public.studio_department_permissions dp
      on dp.organization_id = dm.organization_id and dp.department_id = dm.department_id
   where dm.organization_id = p_organization_id and dm.user_id = auth.uid();

  select coalesce(array_agg(o.user_id order by o.user_id), '{}'::uuid[])
    into v_owner_ids
    from public.studio_data_owners o
   where o.organization_id = p_organization_id;

  -- The primary record owner is the authenticated Master User mapped to this
  -- studio. An invitation into a second studio never maps the invited account's
  -- existing workspace into it and therefore cannot transfer workspace ownership.
  select o.user_id into v_primary_owner
    from public.studio_data_owners o
    join public.studio_memberships master
      on master.organization_id = o.organization_id
     and master.user_id = o.user_id
     and master.role = 'master_user'
     and master.status = 'active'
   where o.organization_id = p_organization_id
   order by master.created_at, o.mapped_at
   limit 1;

  select count(distinct pm.project_id)::integer,
         count(distinct pm.project_id) filter (where pm.access_level in ('contributor','editor'))::integer
    into v_projects, v_editable_projects
    from public.studio_project_members pm
   where pm.organization_id = p_organization_id
     and pm.user_id = auth.uid() and pm.status = 'active';

  return jsonb_build_object(
    'is_member', true,
    'organization_id', v_row.organization_id,
    'organization_name', v_row.organization_name,
    'organization_slug', v_row.organization_slug,
    'role', v_row.role,
    'display_name', v_row.display_name,
    'team_member_id', v_row.team_member_id,
    'department_names', to_jsonb(v_departments),
    'department_roles', to_jsonb(v_department_roles),
    'department_permission_keys', to_jsonb(v_permissions),
    'assigned_project_count', coalesce(v_projects, 0),
    'editable_project_count', coalesce(v_editable_projects, 0),
    'data_owner_user_ids', to_jsonb(v_owner_ids),
    'primary_data_owner_user_id', v_primary_owner,
    'is_master', v_row.role = 'master_user'
  );
end;
$$;

revoke all on function public.studio_get_app_access_context_for_org(uuid) from public, anon;
grant execute on function public.studio_get_app_access_context_for_org(uuid) to authenticated;


-- Selected-organization view and shared writes keep new records under the studio's
-- mapped data owner rather than accidentally attaching them to an account's other studio.
do $$
begin
  if to_regclass('public.leads') is not null then
    drop policy if exists studio_leads_shared_insert on public.leads;
    create policy studio_leads_shared_insert on public.leads for insert to authenticated
      with check (public.studio_user_has_app_permission('crm.write', user_id, null, 'lead', id));
  end if;

  if to_regclass('public.shots') is not null then
    drop policy if exists studio_shots_shared_insert on public.shots;
    create policy studio_shots_shared_insert on public.shots for insert to authenticated
      with check (
        user_id = (select p.user_id from public.projects p where p.id = project_id)
        and public.studio_user_has_app_permission('shots.write', user_id, project_id, 'shot', id)
      );
  end if;

  if to_regclass('public.activity_log') is not null then
    drop policy if exists studio_activity_shared_insert on public.activity_log;
    create policy studio_activity_shared_insert on public.activity_log for insert to authenticated
      with check (
        user_id = (select p.user_id from public.projects p where p.id = project_id)
        and public.studio_user_has_app_permission('shots.write', user_id, project_id, 'activity', id)
      );
    drop policy if exists studio_activity_shared_select on public.activity_log;
    create policy studio_activity_shared_select on public.activity_log for select to authenticated
      using (public.studio_user_has_app_permission('activity.read', user_id, project_id, 'activity', id));
  end if;

  if to_regclass('public.project_stages') is not null then
    drop policy if exists studio_project_stages_shared_select on public.project_stages;
    create policy studio_project_stages_shared_select on public.project_stages for select to authenticated
      using (public.studio_user_has_app_permission('projects.read', user_id, project_id, 'project', project_id));
  end if;
end $$;

-- Reassert the exact execution boundary for the replaced invitation RPC.
revoke all on function public.studio_accept_team_invite(text) from public, anon;
grant execute on function public.studio_accept_team_invite(text) to authenticated;

commit;
