-- Phase 12 migration contract checks. Run after all Phase 11 migrations and Phase 12 migration.
do $$
declare
  v text;
  v_token text;
begin
  select pg_get_functiondef('public.intel_agent_claim_job(text,text[],integer)'::regprocedure) into v;
  if v not ilike '%lease expired at%' or v not ilike '%lease_until <= now()%' then
    raise exception 'FAIL: expired leases are not recovered with diagnostics';
  end if;
  raise notice 'PASS: expired worker leases are reclaimed with diagnostics';

  select pg_get_functiondef('public.intel_agent_approved_outbound(integer)'::regprocedure) into v;
  if v not ilike '%send_weekdays_only%' or v not ilike '%send_start_hour%' then
    raise exception 'FAIL: periodic queue scan does not respect local send windows';
  end if;
  raise notice 'PASS: periodic queue scan avoids enqueueing initial/follow-up sends outside the local window';

  select pg_get_functiondef('public.intel_agent_send_window_status(uuid)'::regprocedure) into v;
  if v not ilike '%next_open_at%' or v not ilike '%send_weekdays_only%' or v not ilike '%timezone(%' then
    raise exception 'FAIL: local-time send-window deferral contract is incomplete';
  end if;
  raise notice 'PASS: send-window status returns the next permitted local opening';

  select pg_get_functiondef('public.intel_agent_record_inbound(text,text,text,text,text,text,text,timestamptz,text,text)'::regprocedure) into v;
  if v not ilike '%regexp_matches(p_in_reply_to%' or v not ilike '%regexp_matches(p_references%'
     or v not ilike '%array_position(v_ids%' or v not ilike '%intel_norm_email(m.to_email) = v_from%'
     or v not ilike '%not exists%' then
    raise exception 'FAIL: RFC Message-ID threading association is incomplete';
  end if;
  raise notice 'PASS: inbound association tokenizes In-Reply-To and References and verifies sender';

  -- Token matching is also sender-bound; comments alone are not sufficient.
  v_token := split_part(v, '-- Exact In-Reply-To Message-ID match first', 1);
  if v_token not ilike '%m.token = p_token%'
     or v_token not ilike '%public.intel_norm_email(m.to_email) = v_from%' then
    raise exception 'FAIL: token-based inbound association does not verify sender against outbound recipient';
  end if;
  raise notice 'PASS: token-based inbound association verifies sender';

  select pg_get_functiondef('public.intel_admin_overview()'::regprocedure) into v;
  if v not ilike '%worker_info%' or v not ilike '%running_jobs%' or v not ilike '%expired_leases%' then
    raise exception 'FAIL: unified worker operational metrics are incomplete';
  end if;
  raise notice 'PASS: admin overview exposes unified worker and queue health';

  select pg_get_functiondef('public.intel_admin_requeue_job(uuid)'::regprocedure) into v;
  if v not ilike '%intel_admin_org%' or v not ilike '%dead%' or v not ilike '%failed%' then
    raise exception 'FAIL: manual queue recovery is not admin-scoped or state-restricted';
  end if;
  if not has_function_privilege('authenticated','public.intel_admin_requeue_job(uuid)','EXECUTE')
     or has_function_privilege('anon','public.intel_admin_requeue_job(uuid)','EXECUTE') then
    raise exception 'FAIL: queue recovery function grants are incorrect';
  end if;
  raise notice 'PASS: manual queue recovery is restricted to authenticated admin RPC';

  if not has_function_privilege('authenticated','public.intel_agent_send_window_status(uuid)','EXECUTE')
     or has_function_privilege('anon','public.intel_agent_send_window_status(uuid)','EXECUTE') then
    raise exception 'FAIL: send-window status function grants are incorrect';
  end if;
  raise notice 'PASS: send-window status RPC is not executable by anon';
end $$;
