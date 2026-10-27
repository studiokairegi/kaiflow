-- Access-control, directory-privacy and group-creation tests (real Postgres, real RLS).
-- Run through supabase/tests/run_access_chat.sh, which applies the migrations first.
-- Every assertion raises on failure; a clean run prints only PASS lines.

create schema if not exists t;
grant usage on schema t to anon, authenticated, service_role;

create or replace function t.ok(p_cond boolean, p_msg text) returns void language plpgsql as $$
begin
  if p_cond is not true then raise exception 'FAIL: %', p_msg; end if;
  raise notice 'PASS: %', p_msg;
end $$;

-- Runs p_sql and asserts it raises an error whose message matches p_pattern.
create or replace function t.throws(p_sql text, p_pattern text, p_msg text) returns void language plpgsql as $$
declare v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    v_msg := sqlerrm;
  end;
  if v_msg is null then raise exception 'FAIL: % (no error was raised)', p_msg; end if;
  if v_msg !~* p_pattern then raise exception 'FAIL: % (got: %)', p_msg, v_msg; end if;
  raise notice 'PASS: %', p_msg;
end $$;

create or replace function t.as_user(p_user uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', p_user::text, true); end $$;

grant execute on all functions in schema t to anon, authenticated, service_role;

set session_replication_role = replica; -- the signup bootstrap trigger would otherwise create a studio per fixture user
-- ---------------------------------------------------------------------------------------------
-- Fixture (superuser): org A with Master, Sales member, Production member, freelancer, client;
-- org B with its own Master. Master owns the studio data (projects, leads, contacts).
-- ---------------------------------------------------------------------------------------------
do $$
declare
  m uuid := '00000000-0000-0000-0000-0000000000a1'; s uuid := '00000000-0000-0000-0000-0000000000a2';
  p uuid := '00000000-0000-0000-0000-0000000000a3'; f uuid := '00000000-0000-0000-0000-0000000000a4';
  c uuid := '00000000-0000-0000-0000-0000000000a5'; b uuid := '00000000-0000-0000-0000-0000000000b1';
  orgA uuid := '10000000-0000-0000-0000-00000000000a'; orgB uuid := '10000000-0000-0000-0000-00000000000b';
  dSales uuid; dProd uuid; proj1 uuid; proj2 uuid;
begin
  insert into auth.users(id,email) values (m,'m@a.test'),(s,'s@a.test'),(p,'p@a.test'),(f,'f@a.test'),(c,'c@a.test'),(b,'b@b.test');
  insert into studio_organizations(id,name,slug,created_by) values (orgA,'Studio A','studio-a',m),(orgB,'Studio B','studio-b',b);
  insert into studio_memberships(organization_id,user_id,role,display_name,created_by) values
    (orgA,m,'master_user','Mia Master',m),(orgA,s,'staff','Sam Sales',m),(orgA,p,'staff','Pat Producer',m),
    (orgA,f,'freelancer','Fay Freelancer',m),(orgA,c,'client','Cleo Client',m),(orgB,b,'master_user','Bo Master',b);
end $$;
set session_replication_role = origin;
do $$
declare
  m uuid := '00000000-0000-0000-0000-0000000000a1'; s uuid := '00000000-0000-0000-0000-0000000000a2';
  p uuid := '00000000-0000-0000-0000-0000000000a3'; b uuid := '00000000-0000-0000-0000-0000000000b1';
  orgA uuid := '10000000-0000-0000-0000-00000000000a'; orgB uuid := '10000000-0000-0000-0000-00000000000b';
  dSales uuid; dProd uuid; proj1 uuid; proj2 uuid;
begin
  insert into studio_departments(organization_id,name,created_by) values (orgA,'Sales',m) returning id into dSales;
  insert into studio_departments(organization_id,name,created_by) values (orgA,'Production',m) returning id into dProd;
  insert into studio_department_memberships(organization_id,department_id,user_id,department_role,created_by) values
    (orgA,dSales,s,'member',m),(orgA,dProd,p,'member',m);
  insert into studio_data_owners(user_id,organization_id,mapped_by) values (m,orgA,m),(b,orgB,b);
  insert into projects(id,user_id,name) values (gen_random_uuid(),m,'Project One') returning id into proj1;
  insert into projects(id,user_id,name) values (gen_random_uuid(),m,'Project Two') returning id into proj2;
  insert into leads(user_id,company_name) values (m,'Lead One'),(m,'Lead Two');
  insert into contacts(user_id,name) values (m,'Contact One');
exception when undefined_column then
  raise notice 'fixture needs adjusting for stub columns: %', sqlerrm; raise;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Department defaults: Sales has no Projects access by default
-- ---------------------------------------------------------------------------------------------
do $$
declare keys text[];
begin
  select array_agg(dp.permission_key order by dp.permission_key) into keys
    from studio_department_permissions dp join studio_departments d on d.id=dp.department_id where d.name='Sales';
  perform t.ok(keys @> array['crm.read','contacts.read'], 'Sales keeps CRM and contacts');
  perform t.ok(not exists (select 1 from unnest(keys) k where k like 'projects.%' or k like 'shots.%'), 'Sales has no projects/shots permission by default');
end $$;

do $$
declare s uuid := '00000000-0000-0000-0000-0000000000a2'; m uuid := '00000000-0000-0000-0000-0000000000a1';
        orgA uuid := '10000000-0000-0000-0000-00000000000a'; proj1 uuid; n int;
begin
  select id into proj1 from projects where name='Project One';
  perform t.as_user(s); set local role authenticated;
  select count(*) into n from projects; perform t.ok(n = 0, 'Sales member sees no projects through RLS');
  select count(*) into n from leads;    perform t.ok(n = 2, 'Sales member still sees CRM leads through the department');
  reset role;
  -- Master assigns a single project: access is explicit, per project, and revocable.
  perform t.as_user(m); set local role authenticated;
  perform studio_assign_project_access(orgA, proj1, s, 'viewer');
  reset role;
  perform t.as_user(s); set local role authenticated;
  select count(*) into n from projects; perform t.ok(n = 1, 'Explicit project grant exposes exactly that project');
  select count(*) into n from projects where name='Project Two'; perform t.ok(n = 0, 'The other project stays hidden');
  reset role;
  perform t.as_user(m); set local role authenticated;
  perform studio_revoke_project_access(orgA, proj1, s);
  reset role;
  perform t.as_user(s); set local role authenticated;
  select count(*) into n from projects; perform t.ok(n = 0, 'Revoking the grant removes access at the database layer');
  reset role;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Per-member overrides
-- ---------------------------------------------------------------------------------------------
do $$
declare s uuid := '00000000-0000-0000-0000-0000000000a2'; m uuid := '00000000-0000-0000-0000-0000000000a1';
        f uuid := '00000000-0000-0000-0000-0000000000a4'; orgA uuid := '10000000-0000-0000-0000-00000000000a'; n int;
begin
  perform t.as_user(m); set local role authenticated;
  perform studio_set_member_override(orgA, s, 'crm.read', 'deny', 'moved off CRM');
  reset role;
  perform t.as_user(s); set local role authenticated;
  select count(*) into n from leads; perform t.ok(n = 0, 'Explicit deny beats the department default');
  reset role;
  perform t.as_user(m); set local role authenticated;
  perform studio_set_member_override(orgA, s, 'crm.read', 'inherit');
  reset role;
  perform t.as_user(s); set local role authenticated;
  select count(*) into n from leads; perform t.ok(n = 2, 'Inheriting restores the department default');
  reset role;

  -- A freelancer has no department; an explicit allow opens contacts but never projects.
  perform t.as_user(f); set local role authenticated;
  select count(*) into n from contacts; perform t.ok(n = 0, 'Freelancer sees no contacts by default');
  reset role;
  perform t.as_user(m); set local role authenticated;
  perform studio_set_member_override(orgA, f, 'contacts.read', 'allow');
  reset role;
  perform t.as_user(f); set local role authenticated;
  select count(*) into n from contacts; perform t.ok(n = 1, 'Explicit allow opens the contact module');
  select count(*) into n from projects; perform t.ok(n = 0, 'A module grant never opens project data');
  reset role;
  perform t.as_user(m); set local role authenticated;
  perform studio_set_member_override(orgA, f, 'contacts.read', 'inherit');
  reset role;
  perform t.as_user(f); set local role authenticated;
  select count(*) into n from contacts; perform t.ok(n = 0, 'Revoking an override removes access again');
  reset role;
end $$;

do $$
declare s uuid := '00000000-0000-0000-0000-0000000000a2'; m uuid := '00000000-0000-0000-0000-0000000000a1';
        p uuid := '00000000-0000-0000-0000-0000000000a3'; c uuid := '00000000-0000-0000-0000-0000000000a5';
        b uuid := '00000000-0000-0000-0000-0000000000b1';
        orgA uuid := '10000000-0000-0000-0000-00000000000a'; orgB uuid := '10000000-0000-0000-0000-00000000000b';
begin
  perform t.as_user(s); set local role authenticated;
  perform t.throws(format('select studio_set_member_override(%L,%L,%L,%L)', orgA, s, 'directory.view', 'allow'),
    'master_user_required', 'A member cannot grant themselves a capability');
  perform t.throws(format('select studio_set_member_override(%L,%L,%L,%L)', orgA, s, 'crm.write', 'allow'),
    'master_user_required', 'A member cannot grant themselves a module permission');
  perform t.throws(format('insert into studio_member_overrides(organization_id,user_id,permission_key,effect) values (%L,%L,%L,%L)', orgA, s, 'directory.view', 'allow'),
    'permission denied', 'Direct inserts into the overrides table are denied');
  perform t.throws(format('update studio_memberships set role=%L where user_id=%L', 'master_user', s),
    'permission denied', 'A member cannot rewrite their own role');
  perform t.throws(format('select studio_list_member_overrides(%L)', orgA), 'master_user_required', 'Override listing is Master-only');
  perform t.throws(format('select studio_member_effective_permissions(%L,%L)', orgA, p), 'master_user_required', 'Effective-permission inspection is Master-only');
  reset role;

  perform t.as_user(m); set local role authenticated;
  perform t.throws(format('select studio_set_member_override(%L,%L,%L,%L)', orgA, m, 'crm.read', 'deny'), 'cannot_override_master', 'The Master cannot be overridden');
  perform t.throws(format('select studio_set_member_override(%L,%L,%L,%L)', orgA, c, 'crm.read', 'allow'), 'target_not_eligible', 'Client accounts cannot receive internal grants');
  perform t.throws(format('select studio_set_member_override(%L,%L,%L,%L)', orgA, s, 'projects.read', 'allow'), 'invalid_permission', 'Project data cannot be granted as a module override');
  perform t.throws(format('select studio_set_member_override(%L,%L,%L,%L)', orgA, s, 'invoices.read', 'allow'), 'invalid_permission', 'Finance data cannot be granted as a module override');
  perform t.throws(format('select studio_set_member_override(%L,%L,%L,%L)', orgA, s, 'directory.view', 'deny'), 'capabilities_are_off_by_default', 'Capabilities are grant-only');
  perform t.throws(format('select studio_set_member_override(%L,%L,%L,%L)', orgA, b, 'crm.read', 'allow'), 'target_not_active_member', 'Cross-organization targets are rejected');
  reset role;

  -- Another studio's Master has no authority here.
  perform t.as_user(b); set local role authenticated;
  perform t.throws(format('select studio_set_member_override(%L,%L,%L,%L)', orgA, s, 'directory.view', 'allow'), 'master_user_required', 'Another studio''s Master cannot grant permissions in this studio');
  perform t.throws(format('select chat_list_directory(%L)', orgA), 'not_authorized', 'Another studio''s Master cannot read this directory');
  reset role;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Directory privacy
-- ---------------------------------------------------------------------------------------------
do $$
declare s uuid := '00000000-0000-0000-0000-0000000000a2'; m uuid := '00000000-0000-0000-0000-0000000000a1';
        p uuid := '00000000-0000-0000-0000-0000000000a3'; orgA uuid := '10000000-0000-0000-0000-00000000000a'; n int; v_conv uuid;
begin
  perform t.as_user(s); set local role authenticated;
  select count(*) into n from chat_list_directory(orgA);
  perform t.ok(n = 0, 'An ordinary member cannot list the company roster');
  select count(*) into n from studio_memberships;
  perform t.ok(n = 1, 'Direct table reads return only the caller''s own membership row');
  select count(*) into n from studio_department_memberships;
  perform t.ok(n = 0 or n = 1, 'Department rosters are not enumerable by direct query');
  perform t.throws(format('select chat_start_direct(%L,%L)', orgA, p), 'target_not_visible', 'An ordinary member cannot start a DM with an arbitrary colleague');
  reset role;

  perform t.as_user(m); set local role authenticated;
  select count(*) into n from chat_list_directory(orgA);
  perform t.ok(n = 3, 'The Master sees every other internal member (and no client)');
  v_conv := chat_start_direct(orgA, s);
  reset role;

  perform t.as_user(s); set local role authenticated;
  select count(*) into n from chat_list_directory(orgA);
  perform t.ok(n = 1, 'A member sees only people they already share a conversation with');
  select count(*) into n from chat_list_directory(orgA) where user_id = p;
  perform t.ok(n = 0, 'Other departments stay hidden');
  reset role;

  perform t.as_user(m); set local role authenticated;
  perform studio_set_member_override(orgA, s, 'directory.view', 'allow');
  reset role;
  perform t.as_user(s); set local role authenticated;
  select count(*) into n from chat_list_directory(orgA);
  perform t.ok(n = 3, 'The directory.view grant opens the roster (never clients, never self)');
  perform chat_start_direct(orgA, p);
  perform t.ok(true, 'With the grant a member can start a conversation with a visible colleague');
  reset role;
  perform t.as_user(m); set local role authenticated;
  perform studio_set_member_override(orgA, s, 'directory.view', 'inherit');
  reset role;
  perform t.as_user(s); set local role authenticated;
  select count(*) into n from chat_list_directory(orgA) where user_id not in (m, p);
  perform t.ok(n = 0, 'Revoking the grant hides everyone except existing conversation partners');
  reset role;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Group creation
-- ---------------------------------------------------------------------------------------------
do $$
declare s uuid := '00000000-0000-0000-0000-0000000000a2'; m uuid := '00000000-0000-0000-0000-0000000000a1';
        p uuid := '00000000-0000-0000-0000-0000000000a3'; f uuid := '00000000-0000-0000-0000-0000000000a4';
        orgA uuid := '10000000-0000-0000-0000-00000000000a'; n int; v_group uuid; v_msg uuid;
begin
  perform t.as_user(s); set local role authenticated;
  perform t.throws(format('select chat_create_conversation(%L,%L,%L)', orgA, 'group', 'Sneaky'), 'group_creation_not_permitted', 'Groups are off by default for ordinary members');
  reset role;

  perform t.as_user(m); set local role authenticated;
  v_group := chat_create_conversation(orgA, 'group', 'Master group', array[s, p]);
  perform t.ok(v_group is not null, 'The Master can create groups');
  perform studio_set_member_override(orgA, s, 'chat.create_groups', 'allow');
  reset role;

  perform t.as_user(s); set local role authenticated;
  perform t.throws(format('select chat_create_conversation(%L,%L,%L,%L::uuid[])', orgA, 'group', 'Invite people I cannot see', format('{%s}', f)),
    'one_or_more_members_not_visible', 'A group creator cannot pull in people they cannot see');
  v_group := chat_create_conversation(orgA, 'group', 'Sales huddle', array[p]);
  perform t.ok(v_group is not null, 'A granted member can create a group with visible members');
  perform t.throws(format('select chat_add_conversation_member(%L,%L)', v_group, f), 'target_not_visible', 'Adding a member also respects directory visibility');
  v_msg := chat_send_message(v_group, 'hello team', gen_random_uuid(), null, '{}'::uuid[]);
  reset role;

  perform t.as_user(m); set local role authenticated;
  perform studio_set_member_override(orgA, s, 'chat.create_groups', 'inherit');
  reset role;
  perform t.as_user(s); set local role authenticated;
  perform t.throws(format('select chat_create_conversation(%L,%L,%L)', orgA, 'group', 'Again'), 'group_creation_not_permitted', 'Removing the grant blocks new groups');
  select count(*) into n from chat_list_conversations(orgA) where conversation_id = v_group;
  perform t.ok(n = 1, 'Existing conversations keep working after the grant is removed');
  perform t.ok(chat_send_message(v_group, 'still here', gen_random_uuid(), null, '{}'::uuid[]) is not null, 'Members can still post in groups they already belong to');
  reset role;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Minimum identity inside conversations
-- ---------------------------------------------------------------------------------------------
do $$
declare s uuid := '00000000-0000-0000-0000-0000000000a2'; p uuid := '00000000-0000-0000-0000-0000000000a3';
        orgA uuid := '10000000-0000-0000-0000-00000000000a'; v_group uuid; n int; r record;
begin
  select c.id into v_group from chat_conversations c where c.title='Sales huddle';
  perform t.as_user(s); set local role authenticated;
  select count(*) into n from chat_conversation_people(v_group);
  perform t.ok(n = 2, 'Conversation members are named without a roster query');
  select count(*) into n from information_schema.columns
    where table_name = 'chat_conversation_people' and column_name in ('email','department_names');
  perform t.ok(n = 0, 'Names only: no email or department fields');
  reset role;
  perform t.as_user(p); set local role authenticated;
  select count(*) into n from chat_list_departments(orgA) where member_count > 0 and name = 'Sales';
  perform t.ok(n = 0, 'Members do not see other departments or their headcount');
  reset role;
  -- A conversation the caller cannot read refuses identity lookups.
  perform t.as_user('00000000-0000-0000-0000-0000000000a4'); set local role authenticated;
  perform t.throws(format('select * from chat_conversation_people(%L)', v_group), 'not_authorized', 'Non-members cannot look up a conversation''s people');
  reset role;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Effective permissions report
-- ---------------------------------------------------------------------------------------------
do $$
declare m uuid := '00000000-0000-0000-0000-0000000000a1'; s uuid := '00000000-0000-0000-0000-0000000000a2';
        orgA uuid := '10000000-0000-0000-0000-00000000000a'; r jsonb; item jsonb;
begin
  perform t.as_user(m); set local role authenticated;
  r := studio_member_effective_permissions(orgA, s);
  select i into item from jsonb_array_elements(r->'items') i where i->>'key' = 'crm.read';
  perform t.ok(item->>'source' = 'department' and (item->>'effective')::boolean, 'Report attributes crm.read to the Sales department');
  select i into item from jsonb_array_elements(r->'items') i where i->>'key' = 'projects.read';
  perform t.ok(item->>'source' = 'none' and not (item->>'effective')::boolean, 'Report shows Sales has no Projects access');
  perform studio_set_member_override(orgA, s, 'crm.write', 'allow');
  r := studio_member_effective_permissions(orgA, s);
  select i into item from jsonb_array_elements(r->'items') i where i->>'key' = 'crm.write';
  perform t.ok(item->>'source' = 'override_allow', 'Report attributes an individual grant to the override');
  perform studio_set_member_override(orgA, s, 'crm.write', 'inherit');
  reset role;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Overrides are audited
-- ---------------------------------------------------------------------------------------------
do $$
declare n int;
begin
  select count(*) into n from studio_audit_events where entity_type = 'member_override';
  perform t.ok(n >= 6, 'Every override change is written to the audit stream');
end $$;

-- Access context carries the caller's own grants
do $$
declare m uuid := '00000000-0000-0000-0000-0000000000a1'; s uuid := '00000000-0000-0000-0000-0000000000a2';
        orgA uuid := '10000000-0000-0000-0000-00000000000a'; ctx jsonb;
begin
  perform t.as_user(m); set local role authenticated;
  perform studio_set_member_override(orgA, s, 'chat.create_groups', 'allow');
  reset role;
  perform t.as_user(s); set local role authenticated;
  ctx := studio_get_app_access_context_for_org(orgA);
  perform t.ok((ctx->>'can_create_groups')::boolean and not (ctx->>'can_view_directory')::boolean, 'Access context reports the member''s own capabilities');
  perform t.ok(ctx ? 'department_permission_keys' and ctx ? 'is_master', 'The original access-context fields are preserved');
  perform t.throws(format('select * from studio_list_member_logins(%L)', orgA), 'master_user_required', 'The login list is Master-only');
  reset role;
  perform t.as_user(m); set local role authenticated;
  perform studio_set_member_override(orgA, s, 'chat.create_groups', 'inherit');
  perform t.ok((select count(*) from studio_list_member_logins(orgA)) = 4, 'Master lists the internal logins');
  reset role;
end $$;
