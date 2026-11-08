-- Phase 9: make source-budget reservations atomic and fail closed.
-- Existing discovery handlers use the same RPC; changing its result to 1/0
-- makes the result an authorization decision rather than a remaining-budget count.
begin;

create or replace function public.intel_agent_source_use(p_key text, p_n int default 1) returns int
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.intel_agent_org();
  v_today date := public._intel_today(v_org);
  v_n int := greatest(coalesce(p_n, 0), 0);
begin
  if v_n < 1 or p_key is null or btrim(p_key) = '' then return 0; end if;

  update public.intel_sources
     set used_today = case when used_on is distinct from v_today then v_n else used_today + v_n end,
         used_on = v_today,
         updated_at = now()
   where organization_id = v_org
     and key = p_key
     and enabled is true
     and tos_status = 'confirmed'
     and (circuit_open_until is null or circuit_open_until <= now())
     and (case when used_on is distinct from v_today then v_n else used_today + v_n end) <= daily_budget;

  if found then return 1; end if;
  return 0;
end $$;

revoke all on function public.intel_agent_source_use(text, int) from public, anon;
grant execute on function public.intel_agent_source_use(text, int) to authenticated;

commit;
