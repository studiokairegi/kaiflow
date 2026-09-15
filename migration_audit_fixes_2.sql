-- Fixes from the second external review of the merged build. Run this
-- after every other migration (including migration_security_hardening.sql
-- and migration_crm_v2.sql) - it schedules the lead-archiving cron job
-- that migration_crm_v2.sql left commented out.

-- =========================================================================
-- NOTE: this section used to redefine get_shared_shot() here too, and that
-- version was actually broken (it referenced s.status/s.reference_url,
-- neither of which exist on shots - the real columns are s.stage and
-- s.review_status - so it would have errored on every call, breaking every
-- freelancer share link outright). migration_audit_fixes_5.sql has the
-- real fix and its own comment explains this mistake in more detail.
-- get_shared_shot() now has exactly one definition, in
-- migration_audit_fixes_5.sql, and nothing else in this project should
-- ever `create or replace` it again.
-- =========================================================================

-- 2. Stop user_has_pro_access() from leaking other users' plan/admin status
-- =========================================================================
-- This was introduced in migration_security_hardening.sql, granted to
-- `authenticated` so the project/budget-planner limit triggers could call
-- it - but it took an arbitrary p_user_id, so any signed-in user could
-- call it directly (supabase.rpc) to check whether *another* account is
-- Pro or admin. Minor information disclosure, not a data-modification
-- risk, but unnecessary. The triggers that call it run as SECURITY
-- DEFINER themselves, so they execute as the function owner and don't
-- need - and never needed - a grant to `authenticated` to keep working.
-- Simplest fix: don't expose it to the browser at all.
revoke execute on function public.user_has_pro_access(uuid) from authenticated;
revoke execute on function public.user_has_pro_access(uuid) from anon;

-- =========================================================================
-- 3. Make Planner -> Project conversion atomic
-- =========================================================================
-- The client previously did this as two separate calls (insert project,
-- then update the planner's status/converted_project_id). If the second
-- call failed after the first succeeded, you'd end up with a real project
-- and a planner that still claims it was never converted - permanently,
-- since there was nothing to retry against. Wrapping both in one plpgsql
-- function makes them succeed or fail together: a single function call is
-- one implicit transaction. security invoker (the default) keeps this
-- running as the calling user, so RLS and the free-plan project-limit
-- trigger from migration_security_hardening.sql both still apply exactly
-- as they do on a normal insert - this only removes the "succeeded
-- halfway" failure mode, it doesn't change who's allowed to do what.
create or replace function public.convert_planner_to_project(p_plan_id uuid)
returns projects
language plpgsql
set search_path = public
as $$
declare
  v_plan budget_planners%rowtype;
  v_project projects%rowtype;
  v_summary text;
begin
  select * into v_plan from budget_planners where id = p_plan_id and user_id = auth.uid();
  if not found then
    raise exception 'Budget plan not found' using errcode = 'P0002';
  end if;
  if v_plan.converted_project_id is not null then
    raise exception 'This plan has already been converted to a project' using errcode = 'P0001';
  end if;

  v_summary := concat_ws(
    E'\n',
    'Converted from Budget Planner: ' || coalesce(v_plan.name, 'Untitled plan'),
    'Target profit: ' || coalesce(v_plan.target_profit_percent, 0)::text || '%',
    'Production budget: ' || coalesce(v_plan.currency, '$') || coalesce(v_plan.budget, 0)::text,
    nullif(v_plan.notes, '')
  );

  insert into projects (
    name, client, notes, budget, budget_mode, currency, deadline, priority,
    share_enabled, share_token, user_id
  ) values (
    coalesce(v_plan.name, 'Untitled project'), coalesce(v_plan.client_name, ''), v_summary,
    v_plan.budget, 'manual', coalesce(v_plan.currency, '$'), v_plan.deadline, 'normal',
    false, null, auth.uid()
  )
  returning * into v_project;

  update budget_planners
  set status = 'converted', converted_project_id = v_project.id
  where id = p_plan_id;

  return v_project;
end;
$$;

revoke all on function public.convert_planner_to_project(uuid) from public;
grant execute on function public.convert_planner_to_project(uuid) to authenticated;

-- =========================================================================
-- 4. Actually schedule the lead-archiving cron job
-- =========================================================================
-- migration_crm_v2.sql left this commented out because pg_cron has to be
-- turned on in the Supabase dashboard first (Database > Extensions) -
-- a migration can't enable a dashboard-gated extension for you. This
-- block schedules the job automatically if pg_cron is already on, and
-- prints exactly what to run by hand if it isn't yet, instead of failing
-- the whole migration either way.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('archive-stale-leads', '0 3 * * *', 'select public.archive_stale_leads();');
    raise notice 'Scheduled archive-stale-leads to run daily at 03:00 UTC.';
  else
    raise notice 'pg_cron is not enabled, so archive-stale-leads was NOT scheduled. Enable it in the Supabase dashboard under Database > Extensions, then run: select cron.schedule(''archive-stale-leads'', ''0 3 * * *'', ''select public.archive_stale_leads();'');';
  end if;
exception when others then
  raise notice 'Could not schedule archive-stale-leads automatically (%). Enable pg_cron in Database > Extensions, then run the select cron.schedule(...) command from migration_crm_v2.sql by hand.', sqlerrm;
end $$;
