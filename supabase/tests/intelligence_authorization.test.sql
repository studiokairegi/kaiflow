-- KairFlow Intelligence authorization: real Postgres, real functions.
-- Run through supabase/tests/run_intelligence_auth.sh (applies the migrations first).
-- Every assertion raises on failure; a clean run prints only PASS lines.
-- Rule under test:  is_admin = true  AND  an ACTIVE master_user membership  (both, always).

create schema if not exists ti;
grant usage on schema ti to anon, authenticated, service_role;

create or replace function ti.ok(p_cond boolean, p_msg text) returns void language plpgsql as $$
begin
  if p_cond is not true then raise exception 'FAIL: %', p_msg; end if;
  raise notice 'PASS: %', p_msg;
end $$;

create or replace function ti.throws(p_sql text, p_pattern text, p_msg text) returns void language plpgsql as $$
declare v_msg text;
begin
  begin execute p_sql; exception when others then v_msg := sqlerrm; end;
  if v_msg is null then raise exception 'FAIL: % (no error was raised)', p_msg; end if;
  if v_msg !~* p_pattern then raise exception 'FAIL: % (got: %)', p_msg, v_msg; end if;
  raise notice 'PASS: %', p_msg;
end $$;

create or replace function ti.as_user(u uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(u::text, ''), false);
  perform set_config('request.jwt.claim.role', 'authenticated', false);
  execute 'reset role'; execute 'set role authenticated';
end $$;
create or replace function ti.as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', false);
  perform set_config('request.jwt.claim.role', 'anon', false);
  execute 'reset role'; execute 'set role anon';
end $$;
create or replace function ti.as_super() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.role', 'service_role', false);
  execute 'reset role';
end $$;
grant execute on all functions in schema ti to anon, authenticated, service_role;

set session_replication_role = replica; -- skip the signup bootstrap trigger for fixture users

-- Fixture ------------------------------------------------------------------------------------
-- orgA: the studio. orgB / orgC: other studios (their Masters must never open orgA's data).
do $$
declare
  u_am  uuid := '00000000-0000-0000-0000-0000000000e1';  -- admin + active Master (orgA)   -> ALLOW
  u_mo  uuid := '00000000-0000-0000-0000-0000000000e2';  -- Master (orgB), NOT admin        -> deny
  u_ao  uuid := '00000000-0000-0000-0000-0000000000e3';  -- admin, no membership            -> deny
  u_ai  uuid := '00000000-0000-0000-0000-0000000000e4';  -- admin + SUSPENDED Master (orgC) -> deny
  u_nd  uuid := '00000000-0000-0000-0000-0000000000e5';  -- department_admin, not admin     -> deny
  u_ad  uuid := '00000000-0000-0000-0000-0000000000e6';  -- admin + department_admin        -> deny
  u_as  uuid := '00000000-0000-0000-0000-0000000000e7';  -- admin + staff                   -> deny
  u_af  uuid := '00000000-0000-0000-0000-0000000000e8';  -- admin + freelancer              -> deny
  u_ac  uuid := '00000000-0000-0000-0000-0000000000e9';  -- admin + client                  -> deny
  u_ns  uuid := '00000000-0000-0000-0000-0000000000ea';  -- Master (orgA2) w/o settings row -> deny
  u_no  uuid := '00000000-0000-0000-0000-0000000000eb';  -- signed in, nothing else         -> deny
  orgA uuid := '20000000-0000-0000-0000-00000000000a'; orgB uuid := '20000000-0000-0000-0000-00000000000b';
  orgC uuid := '20000000-0000-0000-0000-00000000000c'; orgD uuid := '20000000-0000-0000-0000-00000000000d';
  dep uuid;
begin
  insert into auth.users(id,email) values
    (u_am,'am@t.test'),(u_mo,'mo@t.test'),(u_ao,'ao@t.test'),(u_ai,'ai@t.test'),(u_nd,'nd@t.test'),
    (u_ad,'ad@t.test'),(u_as,'as@t.test'),(u_af,'af@t.test'),(u_ac,'ac@t.test'),(u_ns,'ns@t.test'),(u_no,'no@t.test');
  insert into studio_organizations(id,name,slug,created_by) values
    (orgA,'Studio A','studio-a',u_am),(orgB,'Studio B','studio-b',u_mo),
    (orgC,'Studio C','studio-c',u_ai),(orgD,'Studio D','studio-d',u_ns);
  insert into studio_memberships(organization_id,user_id,role,status,display_name,created_by) values
    (orgA,u_am,'master_user','active','Admin Master',u_am),
    (orgB,u_mo,'master_user','active','Plain Master',u_mo),
    (orgC,u_ai,'master_user','suspended','Inactive Master',u_ai),
    (orgA,u_nd,'department_admin','active','Dept Admin',u_am),
    (orgA,u_ad,'department_admin','active','Admin Dept Admin',u_am),
    (orgA,u_as,'staff','active','Admin Staff',u_am),
    (orgA,u_af,'freelancer','active','Admin Freelancer',u_am),
    (orgA,u_ac,'client','active','Admin Client',u_am),
    (orgD,u_ns,'master_user','active','No Settings Master',u_ns);
  insert into user_settings(user_id,is_admin) values
    (u_am,true),(u_mo,false),(u_ao,true),(u_ai,true),(u_nd,false),(u_ad,true),(u_as,true),(u_af,true),(u_ac,true)
    on conflict (user_id) do update set is_admin = excluded.is_admin;
  -- u_ns deliberately has NO user_settings row; u_no has neither settings nor membership.
  insert into user_settings(user_id,is_admin) values (u_no,false) on conflict (user_id) do nothing;
  delete from user_settings where user_id = u_no;
end $$;
set session_replication_role = origin;

-- The account matrix --------------------------------------------------------------------------
do $$
declare
  u_am uuid := '00000000-0000-0000-0000-0000000000e1'; u_mo uuid := '00000000-0000-0000-0000-0000000000e2';
  u_ao uuid := '00000000-0000-0000-0000-0000000000e3'; u_ai uuid := '00000000-0000-0000-0000-0000000000e4';
  u_nd uuid := '00000000-0000-0000-0000-0000000000e5'; u_ad uuid := '00000000-0000-0000-0000-0000000000e6';
  u_as uuid := '00000000-0000-0000-0000-0000000000e7'; u_af uuid := '00000000-0000-0000-0000-0000000000e8';
  u_ac uuid := '00000000-0000-0000-0000-0000000000e9'; u_ns uuid := '00000000-0000-0000-0000-0000000000ea';
  u_no uuid := '00000000-0000-0000-0000-0000000000eb';
  orgA uuid := '20000000-0000-0000-0000-00000000000a'; orgB uuid := '20000000-0000-0000-0000-00000000000b';
begin
  perform ti.as_user(u_am);
  perform ti.ok(intel_is_authorized() is true, 'admin + active Master User: ALLOW');
  perform ti.ok(intel_is_authorized(orgA) is true, 'admin + active Master User: ALLOW for their own studio');
  perform ti.ok(intel_is_authorized(orgB) is false, 'admin Master of studio A: DENIED for studio B (org-scoped)');
  perform ti.ok(intel_is_authorized(null::uuid) is false, 'null organization: DENY');
  perform ti.ok(intel_require_authorized() = u_am, 'require_authorized returns the caller id when allowed');

  perform ti.as_user(u_mo); perform ti.ok(intel_is_authorized() is false, 'Master User without admin: DENY');
  perform ti.ok(intel_is_authorized(orgB) is false, 'Master User without admin: DENY even in their own studio');
  perform ti.throws('select intel_require_authorized()', 'restricted', 'Master User without admin: privileged RPC guard raises');

  perform ti.as_user(u_ao); perform ti.ok(intel_is_authorized() is false, 'admin without Master membership: DENY');
  perform ti.as_user(u_ai); perform ti.ok(intel_is_authorized() is false, 'admin + SUSPENDED Master membership: DENY');
  perform ti.as_user(u_nd); perform ti.ok(intel_is_authorized() is false, 'non-admin department admin: DENY');
  perform ti.as_user(u_ad); perform ti.ok(intel_is_authorized() is false, 'admin + department admin: DENY');
  perform ti.as_user(u_as); perform ti.ok(intel_is_authorized() is false, 'admin + staff employee: DENY');
  perform ti.as_user(u_af); perform ti.ok(intel_is_authorized() is false, 'admin + freelancer: DENY');
  perform ti.as_user(u_ac); perform ti.ok(intel_is_authorized() is false, 'admin + client: DENY');
  perform ti.as_user(u_ns); perform ti.ok(intel_is_authorized() is false, 'missing user_settings row: DENY');
  perform ti.as_user(u_no); perform ti.ok(intel_is_authorized() is false, 'no settings and no membership: DENY');

  -- Unauthenticated -------------------------------------------------------------------------
  perform ti.as_user(null);
  perform ti.ok(intel_is_authorized() is false, 'authenticated role with no user id: DENY');
  perform ti.throws('select intel_require_authorized()', 'not authenticated', 'no user id: guard raises not-authenticated');
  perform ti.as_anon();
  perform ti.throws('select intel_is_authorized()', 'permission denied', 'anon cannot execute intel_is_authorized()');
  perform ti.throws('select intel_is_authorized(gen_random_uuid())', 'permission denied', 'anon cannot execute the org-scoped check');
  perform ti.throws('select intel_require_authorized()', 'permission denied', 'anon cannot execute the RPC guard');

  -- Forged claims in the request are ignored: only the database rows count ---------------------
  perform ti.as_user(u_mo);
  perform set_config('request.jwt.claim.is_admin', 'true', false);
  perform set_config('request.jwt.claims', '{"role":"authenticated","is_admin":true,"user_metadata":{"is_admin":true},"app_metadata":{"is_admin":true,"role":"master_user"}}', false);
  perform ti.ok(intel_is_authorized() is false, 'forged is_admin claims in the JWT do not grant access');
  perform set_config('request.jwt.claim.is_admin', '', false);
  perform set_config('request.jwt.claims', '', false);

  perform ti.as_super();
end $$;

-- Revocation and role changes take effect immediately -----------------------------------------
do $$
declare
  u_am uuid := '00000000-0000-0000-0000-0000000000e1'; u_as uuid := '00000000-0000-0000-0000-0000000000e7';
  orgA uuid := '20000000-0000-0000-0000-00000000000a'; dep uuid := gen_random_uuid();
begin
  perform ti.as_user(u_am); perform ti.ok(intel_is_authorized() is true, 'baseline: allowed');

  -- A signed-in user cannot promote themselves to admin or Pro through direct table writes.
  perform ti.as_user(u_mo);
  update user_settings set is_admin = true, plan = 'pro' where user_id = u_mo;
  perform ti.ok((select is_admin is false and plan = 'free' from user_settings where user_id = u_mo),
    'privileged-user trigger blocks self-grant of admin and Pro');

  perform ti.as_super(); update user_settings set is_admin = false where user_id = u_am;
  perform ti.as_user(u_am); perform ti.ok(intel_is_authorized() is false, 'revoking is_admin removes access');
  perform ti.as_super(); update user_settings set is_admin = true where user_id = u_am;

  update studio_memberships set status = 'suspended' where user_id = u_am and organization_id = orgA;
  perform ti.as_user(u_am); perform ti.ok(intel_is_authorized() is false, 'suspending the Master membership removes access');
  perform ti.as_super(); update studio_memberships set status = 'active' where user_id = u_am and organization_id = orgA;
  perform ti.as_user(u_am); perform ti.ok(intel_is_authorized() is true, 'restoring both conditions restores access');
  perform ti.as_super();

  -- Department changes never grant Intelligence --------------------------------------------
  insert into studio_departments(id,organization_id,name,created_by) values (dep,orgA,'Sales',u_am);
  insert into studio_department_memberships(organization_id,department_id,user_id,department_role,created_by)
    values (orgA,dep,u_as,'admin',u_am);
  perform ti.as_user(u_as); perform ti.ok(intel_is_authorized() is false, 'department assignment (as dept admin) does not grant access');
  perform ti.as_super();
end $$;

-- Nothing was mutated by the checks, and existing authorization is untouched --------------------
do $$
begin
  perform ti.as_super();
  perform ti.ok((select count(*) from user_settings where is_admin) = 7, 'checks did not modify user_settings');
  if to_regprocedure('public.payments_is_admin()') is not null then
    perform ti.as_user('00000000-0000-0000-0000-0000000000e3');
    perform ti.ok(payments_is_admin() is true, 'Payments: admin without Master User still passes payments_is_admin()');
    perform ti.as_user('00000000-0000-0000-0000-0000000000e2');
    perform ti.ok(payments_is_admin() is false, 'Payments: Master without admin still fails payments_is_admin()');
    perform ti.as_super();
  else
    raise notice 'SKIP: payments_is_admin() not installed in this harness (covered by payments_admin.test.sql)';
  end if;
  perform ti.ok(chat_is_org_master('20000000-0000-0000-0000-00000000000b') is not null, 'chat_is_org_master() still callable (unchanged)');
end $$;
