-- Phase 8: a send job denied by a terminal policy/eligibility gate is not a success.
-- Do not retry it: the message gate has already recorded the definitive send outcome.
create or replace function public.intel_agent_fail_job_permanent(
  p_job_id uuid,
  p_worker_id text,
  p_error text
) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.intel_agent_org();
  j public.intel_jobs;
begin
  select * into j
    from public.intel_jobs
   where id = p_job_id
     and organization_id = v_org
     and state = 'running'
     and locked_by = p_worker_id
   for update;

  if not found then return 'not_owner'; end if;

  update public.intel_jobs
     set state = 'dead',
         last_error = left(p_error, 1000),
         locked_by = null,
         lease_until = null,
         updated_at = now(),
         finished_at = now()
   where id = j.id;

  return 'dead';
end $$;
