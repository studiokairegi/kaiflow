-- Preserve claimed send jobs when the operator kill switch is enabled.
-- A deferred job is returned to the queue without consuming an attempt.

create or replace function public.intel_agent_defer_job(
  p_job_id uuid,
  p_worker_id text,
  p_retry_seconds int default 60,
  p_reason text default 'deferred'
) returns boolean
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.intel_agent_org();
begin
  update public.intel_jobs
     set state = 'queued',
         attempts = greatest(0, attempts - 1),
         run_after = now() + make_interval(secs => greatest(1, least(p_retry_seconds, 86400))),
         locked_by = null,
         lease_until = null,
         last_error = left('deferred: ' || coalesce(nullif(btrim(p_reason), ''), 'deferred'), 1000),
         finished_at = null,
         updated_at = now()
   where id = p_job_id
     and organization_id = v_org
     and state = 'running'
     and locked_by = p_worker_id;
  return found;
end $$;
