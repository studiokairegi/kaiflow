-- Frictionless team onboarding.
--
-- Product rule: the master user adds people in Teams, copies a one-time invite
-- link, and the invitee only types an email + password to join. So:
--   * an invitation is bound to a Teams roster entry (+ optional department), NOT to an email;
--   * the roster entry no longer needs an email before it can be invited;
--   * the role is derived: no department = freelancer portal, department = dedicated view;
--   * the link itself is the credential: 256-bit token, stored hashed, used once, expires in 7 days.
--
-- Additive: older migrations are untouched. Existing pending invites keep working.

begin;

alter table public.studio_member_invites alter column invited_email drop not null;

-- 1. Create an invite for a roster member. Same signature as before; p_role is now
--    only a hint (staff vs department_admin) and is ignored without a department.
create or replace function public.studio_create_team_invite(
  p_organization_id uuid,
  p_team_member_id uuid,
  p_department_id uuid,
  p_role text,
  p_token text
) returns table(invite_id uuid, invited_email text, display_name text, role text, department_id uuid, expires_at timestamptz)
language plpgsql security definer set search_path = pg_catalog, public, auth
as $$
declare v_roster record; v_role text; v_invite_id uuid; v_expires timestamptz;
begin
  if auth.uid() is null or not public.chat_is_org_master(p_organization_id) then
    raise exception 'master_user_required' using errcode='42501';
  end if;
  if p_token is null or p_token !~ '^[0-9a-fA-F]{64}$' then raise exception 'invalid_invite_token' using errcode='22023'; end if;
  v_role := case
    when p_department_id is null then 'freelancer'
    when lower(btrim(coalesce(p_role,''))) = 'department_admin' then 'department_admin'
    else 'staff' end;
  if p_department_id is not null and not exists(
    select 1 from public.studio_departments d where d.id=p_department_id and d.organization_id=p_organization_id
  ) then raise exception 'department_not_found' using errcode='22023'; end if;
  select tm.id, tm.user_id, tm.name, tm.status
    into v_roster from public.team_members tm
    where tm.id=p_team_member_id and tm.user_id=auth.uid()
    for update;
  if not found then raise exception 'team_member_not_found' using errcode='P0002'; end if;
  if coalesce(v_roster.status,'active') <> 'active' then raise exception 'team_member_inactive' using errcode='22023'; end if;
  if exists(select 1 from public.studio_memberships m where m.organization_id=p_organization_id and m.team_member_id=p_team_member_id and m.status='active') then
    raise exception 'team_member_already_linked' using errcode='23505';
  end if;
  update public.studio_member_invites i set status='revoked', updated_at=now()
    where i.organization_id=p_organization_id and i.team_member_id=p_team_member_id and i.status='pending';
  insert into public.studio_member_invites(
    organization_id,team_member_id,display_name,role,department_id,token_hash,status,expires_at,created_by
  ) values (
    p_organization_id,p_team_member_id,left(btrim(v_roster.name),80),v_role,p_department_id,
    public.studio_hash_invite_token(p_token),'pending',now()+interval '7 days',auth.uid()
  ) returning id,studio_member_invites.expires_at into v_invite_id,v_expires;
  insert into public.studio_audit_events(organization_id,actor_user_id,entity_type,entity_id,action,metadata)
  values(p_organization_id,auth.uid(),'team_invite',v_invite_id,'created',
    jsonb_build_object('teamMemberId',p_team_member_id,'role',v_role,'departmentId',p_department_id));
  return query select v_invite_id,null::text,left(btrim(v_roster.name),80),v_role,p_department_id,v_expires;
end;
$$;

-- 2. One internal routine links a login to the invited roster entry. It is shared by the
--    signed-in path (existing account) and the service-role path (new account created by
--    the studio-invite-accept edge function). Never callable by browsers directly.
create or replace function public.studio_apply_team_invite(p_token text, p_user uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth
as $$
declare v_inv public.studio_member_invites%rowtype; v_existing_role text; v_existing_team_member_id uuid; v_email text;
begin
  if p_user is null then raise exception 'sign_in_required' using errcode='28000'; end if;
  if p_token is null or p_token !~ '^[0-9a-fA-F]{64}$' then raise exception 'invalid_invite_token' using errcode='22023'; end if;
  select * into v_inv from public.studio_member_invites i
    where i.token_hash=public.studio_hash_invite_token(p_token) for update;
  if not found then raise exception 'invite_not_found_or_expired' using errcode='P0002'; end if;
  if v_inv.status='accepted' and v_inv.accepted_user_id=p_user then
    return jsonb_build_object('accepted',true,'organization_id',v_inv.organization_id,
      'organization_name',(select o.name from public.studio_organizations o where o.id=v_inv.organization_id),
      'role',v_inv.role,'already_accepted',true);
  end if;
  if v_inv.status<>'pending' or v_inv.expires_at<=now() then raise exception 'invite_not_found_or_expired' using errcode='P0002'; end if;
  perform pg_advisory_xact_lock(hashtext(v_inv.organization_id::text), hashtext(p_user::text));

  select m.role,m.team_member_id into v_existing_role,v_existing_team_member_id
    from public.studio_memberships m where m.organization_id=v_inv.organization_id and m.user_id=p_user for update;
  if v_existing_role='master_user' then raise exception 'cannot_replace_master_membership' using errcode='42501'; end if;
  if v_existing_team_member_id is not null and v_existing_team_member_id <> v_inv.team_member_id then
    raise exception 'account_already_linked_to_other_roster' using errcode='23505';
  end if;
  if exists(select 1 from public.studio_memberships m where m.organization_id=v_inv.organization_id and m.team_member_id=v_inv.team_member_id and m.status='active' and m.user_id<>p_user) then
    raise exception 'team_member_already_linked' using errcode='23505';
  end if;
  insert into public.studio_memberships(organization_id,user_id,role,status,display_name,created_by,team_member_id)
  values(v_inv.organization_id,p_user,v_inv.role,'active',v_inv.display_name,v_inv.created_by,v_inv.team_member_id)
  on conflict(organization_id,user_id) do update set
    role=excluded.role,status='active',display_name=excluded.display_name,
    team_member_id=excluded.team_member_id,updated_at=now();
  delete from public.studio_department_memberships dm where dm.organization_id=v_inv.organization_id and dm.user_id=p_user;
  if v_inv.department_id is not null then
    insert into public.studio_department_memberships(organization_id,department_id,user_id,department_role,created_by)
    values(v_inv.organization_id,v_inv.department_id,p_user,case when v_inv.role='department_admin' then 'admin' else 'member' end,v_inv.created_by)
    on conflict(department_id,user_id) do update set department_role=excluded.department_role,created_by=excluded.created_by;
  end if;
  update public.studio_member_invites set status='accepted',accepted_user_id=p_user,consumed_at=now(),updated_at=now() where id=v_inv.id;
  -- Remember the login email on the roster entry when the owner did not have one.
  select lower(u.email) into v_email from auth.users u where u.id=p_user;
  if v_email is not null then
    update public.team_members tm set email=v_email
      where tm.id=v_inv.team_member_id and (tm.email is null or btrim(tm.email)='');
  end if;
  insert into public.studio_audit_events(organization_id,actor_user_id,owner_user_id,entity_type,entity_id,action,metadata)
  values(v_inv.organization_id,p_user,v_inv.created_by,'team_invite',v_inv.id,'updated',
    jsonb_build_object('status','accepted','teamMemberId',v_inv.team_member_id,'role',v_inv.role,'departmentId',v_inv.department_id));
  -- Existing shot assignments stay attached to the roster record and now grant project access.
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

-- 3. Signed-in path: an existing account opens the link and joins. The token is the credential;
--    no email match and no confirmation gate (the account is already authenticated).
create or replace function public.studio_accept_team_invite(p_token text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth
as $$
begin
  return public.studio_apply_team_invite(p_token, auth.uid());
end;
$$;

-- 4. New-account path: only the studio-invite-accept edge function (service role) may call this
--    after creating the auth user.
create or replace function public.studio_redeem_team_invite(p_token text, p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth
as $$
begin
  return public.studio_apply_team_invite(p_token, p_user_id);
end;
$$;

-- 5. Signup trigger: a valid pending token alone lets an invited signup skip provisioning a
--    brand-new studio. Email is no longer compared with anything.
create or replace function public.studio_bootstrap_new_auth_user()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, auth, extensions
as $$
declare v_token text; v_name text; v_org uuid; v_invite_valid boolean := false;
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
    ) into v_invite_valid;
    if not v_invite_valid then
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

-- 6. Teams roster overview: one call tells the roster which people have a login, which have a
--    pending link, and which department they are in.
create or replace function public.studio_team_access_overview(p_organization_id uuid)
returns table(team_member_id uuid, state text, role text, department_id uuid, department_name text,
  invite_id uuid, expires_at timestamptz, login_email text)
language plpgsql stable security definer set search_path = pg_catalog, public, auth
as $$
begin
  if auth.uid() is null or not public.chat_is_org_master(p_organization_id) then
    raise exception 'master_user_required' using errcode='42501';
  end if;
  return query
  select m.team_member_id, case when m.status='active' then 'active' else 'paused' end, m.role, dm.department_id, d.name,
         null::uuid, null::timestamptz, u.email::text
    from public.studio_memberships m
    join auth.users u on u.id=m.user_id
    left join lateral (select x.department_id from public.studio_department_memberships x
        where x.organization_id=m.organization_id and x.user_id=m.user_id
        order by x.created_at, x.department_id limit 1) dm on true
    left join public.studio_departments d on d.id=dm.department_id and d.organization_id=m.organization_id
   where m.organization_id=p_organization_id and m.team_member_id is not null and m.status in ('active','suspended')
  union all
  select i.team_member_id, 'invited'::text, i.role, i.department_id, d.name,
         i.id, i.expires_at, null::text
    from public.studio_member_invites i
    left join public.studio_departments d on d.id=i.department_id and d.organization_id=i.organization_id
   where i.organization_id=p_organization_id and i.status='pending' and i.expires_at>now()
     and not exists(select 1 from public.studio_memberships m2
        where m2.organization_id=i.organization_id and m2.team_member_id=i.team_member_id and m2.status='active');
end;
$$;

-- 7. Move a linked person between "freelancer portal" (no department) and a department view.
create or replace function public.studio_set_member_department(
  p_organization_id uuid, p_team_member_id uuid, p_department_id uuid
) returns boolean language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_user uuid; v_role text;
begin
  if auth.uid() is null or not public.chat_is_org_master(p_organization_id) then
    raise exception 'master_user_required' using errcode='42501';
  end if;
  select m.user_id,m.role into v_user,v_role from public.studio_memberships m
    where m.organization_id=p_organization_id and m.team_member_id=p_team_member_id and m.status='active' for update;
  if not found then raise exception 'member_not_linked' using errcode='P0002'; end if;
  if v_role='master_user' then raise exception 'cannot_change_master' using errcode='42501'; end if;
  if p_department_id is not null and not exists(
    select 1 from public.studio_departments d where d.id=p_department_id and d.organization_id=p_organization_id
  ) then raise exception 'department_not_found' using errcode='22023'; end if;
  delete from public.studio_department_memberships dm where dm.organization_id=p_organization_id and dm.user_id=v_user;
  if p_department_id is not null then
    insert into public.studio_department_memberships(organization_id,department_id,user_id,department_role,created_by)
    values(p_organization_id,p_department_id,v_user,case when v_role='department_admin' then 'admin' else 'member' end,auth.uid());
  end if;
  update public.studio_memberships m set updated_at=now(),
    role=case when p_department_id is null then 'freelancer' when v_role='department_admin' then 'department_admin' else 'staff' end
    where m.organization_id=p_organization_id and m.user_id=v_user;
  insert into public.studio_audit_events(organization_id,actor_user_id,entity_type,entity_id,action,metadata)
  values(p_organization_id,auth.uid(),'team_member_access',p_team_member_id,'updated',
    jsonb_build_object('departmentId',p_department_id));
  return true;
end;
$$;

-- 8. Pause or restore a person's login for this studio (their roster entry and shots stay).
create or replace function public.studio_set_member_access(
  p_organization_id uuid, p_team_member_id uuid, p_active boolean
) returns boolean language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_role text;
begin
  if auth.uid() is null or not public.chat_is_org_master(p_organization_id) then
    raise exception 'master_user_required' using errcode='42501';
  end if;
  select m.role into v_role from public.studio_memberships m
    where m.organization_id=p_organization_id and m.team_member_id=p_team_member_id for update;
  if not found then raise exception 'member_not_linked' using errcode='P0002'; end if;
  if v_role='master_user' then raise exception 'cannot_change_master' using errcode='42501'; end if;
  update public.studio_memberships m set status=case when p_active then 'active' else 'suspended' end, updated_at=now()
    where m.organization_id=p_organization_id and m.team_member_id=p_team_member_id;
  insert into public.studio_audit_events(organization_id,actor_user_id,entity_type,entity_id,action,metadata)
  values(p_organization_id,auth.uid(),'team_member_access',p_team_member_id,'updated',
    jsonb_build_object('active',p_active));
  return true;
end;
$$;

revoke all on function public.studio_create_team_invite(uuid,uuid,uuid,text,text) from public, anon;
revoke all on function public.studio_apply_team_invite(text,uuid) from public, anon, authenticated;
revoke all on function public.studio_accept_team_invite(text) from public, anon;
revoke all on function public.studio_redeem_team_invite(text,uuid) from public, anon, authenticated;
revoke all on function public.studio_team_access_overview(uuid) from public, anon;
revoke all on function public.studio_set_member_department(uuid,uuid,uuid) from public, anon;
revoke all on function public.studio_set_member_access(uuid,uuid,boolean) from public, anon;
grant execute on function public.studio_create_team_invite(uuid,uuid,uuid,text,text) to authenticated;
grant execute on function public.studio_accept_team_invite(text) to authenticated;
grant execute on function public.studio_redeem_team_invite(text,uuid) to service_role;
grant execute on function public.studio_get_team_invite(text) to service_role;
grant execute on function public.studio_team_access_overview(uuid) to authenticated;
grant execute on function public.studio_set_member_department(uuid,uuid,uuid) to authenticated;
grant execute on function public.studio_set_member_access(uuid,uuid,boolean) to authenticated;

commit;
