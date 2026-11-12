-- Kickstarter Phase 4 corrective migration contract checks.
-- Run after 20261112190000_intelligence_kickstarter_exclusion_identity_fixes.sql.
do $$
declare
  v text;
begin
  select pg_get_functiondef('public.intel_admin_update_source(text,boolean,text,integer)'::regprocedure) into v;
  if v not ilike '%tos_status = ''excluded''%'
     or v not ilike '%state = ''cancelled''%'
     or v not ilike '%kickstarter_manual%'
     or v not ilike '%lease_until = null%'
     or v not ilike '%locked_by = null%' then
    raise exception 'FAIL: excluding Kickstarter does not cancel queued/running manual intake jobs';
  end if;
  raise notice 'PASS: source exclusion cancels pending and running Kickstarter manual intake jobs';

  select pg_get_functiondef('public.intel_agent_kickstarter_intake_allowed()'::regprocedure) into v;
  if v not ilike '%key = ''kickstarter''%' or v not ilike '%tos_status <> ''excluded''%' then
    raise exception 'FAIL: worker preflight does not fail closed for an excluded/missing Kickstarter source';
  end if;
  if not has_function_privilege('service_role','public.intel_agent_kickstarter_intake_allowed()','EXECUTE')
     or has_function_privilege('authenticated','public.intel_agent_kickstarter_intake_allowed()','EXECUTE')
     or has_function_privilege('anon','public.intel_agent_kickstarter_intake_allowed()','EXECUTE') then
    raise exception 'FAIL: Kickstarter worker preflight privileges are not service-only';
  end if;
  raise notice 'PASS: worker preflight is fail-closed and service-role only';

  select pg_get_functiondef('public.intel_agent_kickstarter_commit_import(uuid,text,text,jsonb,text,text)'::regprocedure) into v;
  if v not ilike '%for share%'
     or v not ilike '%tos_status = ''excluded''%'
     or v not ilike '%intel_agent_upsert_prospect%'
     or v not ilike '%intel_agent_record_item%'
     or v not ilike '%independently_verified%'
     or v not ilike '%human_confirmed%'
     or v not ilike '%kickstarter_creator_role_verified%'
     or v not ilike '%v_preserve%' then
    raise exception 'FAIL: atomic Kickstarter import or verified identity preservation is incomplete';
  end if;
  if not has_function_privilege('service_role','public.intel_agent_kickstarter_commit_import(uuid,text,text,jsonb,text,text)','EXECUTE')
     or has_function_privilege('authenticated','public.intel_agent_kickstarter_commit_import(uuid,text,text,jsonb,text,text)','EXECUTE')
     or has_function_privilege('anon','public.intel_agent_kickstarter_commit_import(uuid,text,text,jsonb,text,text)','EXECUTE') then
    raise exception 'FAIL: Kickstarter commit RPC privileges are not service-only';
  end if;
  raise notice 'PASS: atomic import serializes against exclusion and preserves higher-confidence identity facts';
end $$;
