-- Phase 4: job settlement hardening. Two small, additive function replacements. No table, column, constraint or data changes.
--
-- 1. intel_agent_fail_job now requires the job to be 'running'. Before this, it matched on (id, org, locked_by) only. complete_job leaves
--    locked_by set on a succeeded row, so a late or repeated failure report from the same worker (for example: the completion call committed,
--    its response was lost on the network, and the worker then reported a "transient" failure) turned a SUCCEEDED job back into 'queued' and
--    re-ran it. Now such a call returns 'not_owner' and changes nothing. fail_job_permanent already had this check.
-- 2. intel_agent_complete_job is idempotent for the same worker: repeating the completion of a job that this worker already completed returns
--    true instead of false. The worker retries completion on network errors; the first attempt may have committed.
--
-- The worker works with either version of both functions (it treats 'not_owner' and false as "lease lost" and never re-runs a handler for them).
-- Safe to apply twice (create or replace). Argument lists, return types and defaults are unchanged, so PostgREST resolution and grants are unaffected.
-- ROLLBACK (manual, only if needed): re-apply the two definitions from 20261109120000_intelligence_rpcs.sql.

create or replace function public.intel_agent_complete_job(p_job_id uuid, p_worker_id text, p_result jsonb default '{}'::jsonb) returns boolean
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org();
begin
  update public.intel_jobs set state = 'succeeded', result = p_result, lease_until = null, finished_at = now(), updated_at = now()
   where id = p_job_id and organization_id = v_org and state = 'running' and locked_by = p_worker_id;
  if found then return true; end if;
  -- Idempotent repeat by the same worker (the first response may have been lost): report success, change nothing.
  return exists (select 1 from public.intel_jobs
                  where id = p_job_id and organization_id = v_org and state = 'succeeded' and locked_by = p_worker_id);
end $$;

create or replace function public.intel_agent_fail_job(p_job_id uuid, p_worker_id text, p_error text, p_retry_seconds int default 60) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org(); j public.intel_jobs;
begin
  select * into j from public.intel_jobs
   where id = p_job_id and organization_id = v_org and state = 'running' and locked_by = p_worker_id for update;
  if not found then return 'not_owner'; end if;
  update public.intel_jobs
     set state = case when attempts >= max_attempts then 'dead' else 'queued' end,
         run_after = now() + make_interval(secs => greatest(1, least(p_retry_seconds, 86400))),
         last_error = left(p_error, 1000), locked_by = null, lease_until = null, updated_at = now(),
         finished_at = case when attempts >= max_attempts then now() end
   where id = j.id;
  return case when j.attempts >= j.max_attempts then 'dead' else 'queued' end;
end $$;

revoke all on function public.intel_agent_complete_job(uuid, text, jsonb) from public, anon;
grant execute on function public.intel_agent_complete_job(uuid, text, jsonb) to authenticated;
revoke all on function public.intel_agent_fail_job(uuid, text, text, int) from public, anon;
grant execute on function public.intel_agent_fail_job(uuid, text, text, int) to authenticated;
