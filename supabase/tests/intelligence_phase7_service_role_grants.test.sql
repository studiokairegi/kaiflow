-- Phase 7 grant migration (20270105090000) against real Postgres. Same fixture conventions as intelligence_phase4_job_reliability.test.sql
-- (AGENT ...f0, helpers ti.as_user / ti.ok from intelligence_authorization.test.sql).
-- NOT EXECUTED where this file was written (no PostgreSQL available there): run it, after the full migration chain, before trusting the migration.
-- REQUIRES the ti.* helpers and fixtures created by intelligence_authorization.test.sql (run_intelligence_auth.sh builds that database), and
-- the roles service_role, authenticated and anon, which that bootstrap creates. run_intelligence_phase7.sh is a thin wrapper for a database that has them.
-- Not wired into run_intelligence_auth.sh: that script applies a hand-picked subset of migrations and could not be re-verified in the Phase 7 session.
do $$
declare
  AGENT uuid := '00000000-0000-0000-0000-0000000000f0';
  fn text; fns text[] := array[
    'public.intel_resend_record_inbound(text,text,text,text,text,text,text,timestamptz,text)',
    'public.intel_agent_apply_delivery_event(text,uuid,text,text,text,text,timestamptz,text,text)'];
  msg text; v_called boolean := false;
begin
  foreach fn in array fns loop
    perform ti.ok(has_function_privilege('service_role', fn, 'execute'), fn || ' stays executable by service_role');
    perform ti.ok(not has_function_privilege('authenticated', fn, 'execute'), fn || ' is not executable by authenticated');
    perform ti.ok(not has_function_privilege('anon', fn, 'execute'), fn || ' is not executable by anon (nor via PUBLIC)');
  end loop;

  -- model of the whole Intelligence function set: nothing is callable without signing in; private helpers are not callable by signed-in users
  perform ti.ok(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                              where n.nspname = 'public' and (p.proname like 'intel\_%' or p.proname like '\_intel\_%')
                                and has_function_privilege('anon', p.oid, 'execute')),
                'no intel_* function is executable by anon');
  perform ti.ok(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                              where n.nspname = 'public' and p.proname like '\_intel\_%'
                                and has_function_privilege('authenticated', p.oid, 'execute')),
                'no private _intel_* helper is executable by authenticated');

  -- 1) with the grant narrowed, a signed-in caller is stopped at the privilege check. The call result is recorded in variables and asserted
  --    OUTSIDE the exception handler: ti.ok raises on failure, so asserting inside a "when others" block would turn a failure into a pass.
  perform ti.as_user(AGENT);
  begin
    perform public.intel_agent_apply_delivery_event('resend', gen_random_uuid(), 'm', 'e', 'delivered', 'delivered', now(), 'x@example.com', '');
    v_called := true;
  exception when others then
    get stacked diagnostics msg = message_text;
  end;
  perform ti.as_super();
  perform ti.ok(not v_called, 'a signed-in agent must not be able to apply a delivery event');
  perform ti.ok(msg ~* 'permission denied', 'the refusal is the privilege check (got: ' || coalesce(left(msg, 60), 'no error') || ')');

  -- 2) defence in depth: temporarily re-open the wider grant and prove the function BODY still refuses a signed-in caller.
  --    Runs as superuser (as_super above); the grant is revoked again immediately, inside the same transaction as this block.
  v_called := false; msg := null;
  execute 'grant execute on function public.intel_agent_apply_delivery_event(text,uuid,text,text,text,text,timestamptz,text,text) to authenticated';
  perform ti.as_user(AGENT);
  begin
    perform public.intel_agent_apply_delivery_event('resend', gen_random_uuid(), 'm', 'e', 'delivered', 'delivered', now(), 'x@example.com', '');
    v_called := true;
  exception when others then
    get stacked diagnostics msg = message_text;
  end;
  perform ti.as_super();
  execute 'revoke all on function public.intel_agent_apply_delivery_event(text,uuid,text,text,text,text,timestamptz,text,text) from public, anon, authenticated';
  perform ti.ok(not v_called, 'even with the wider grant, the function body refuses a signed-in caller');
  perform ti.ok(msg is not null and msg !~* 'permission denied', 'the refusal comes from the body, not the privilege check (got: ' || coalesce(left(msg, 60), 'no error') || ')');
  perform ti.ok(not has_function_privilege('authenticated', 'public.intel_agent_apply_delivery_event(text,uuid,text,text,text,text,timestamptz,text,text)', 'execute'),
                'the temporary grant was removed again');
end $$;
