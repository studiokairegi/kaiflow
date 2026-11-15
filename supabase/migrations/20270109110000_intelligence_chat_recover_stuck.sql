-- Emma: resolve email actions that were claimed (status 'running') but never reported back.
-- The browser claims a send_email card, sends, then calls intel_admin_chat_finish. If the tab closed or the network dropped in between,
-- the card stayed 'running' forever and could not be retried. This marks such cards 'failed' with an "outcome unknown" note after a delay
-- (at least 5 minutes), so they stop spinning. The email key (emma-<action id>) is idempotent, so the message may or may not have been sent:
-- the note tells the administrator to check the Sent folder. Only the caller's own actions are touched. Additive and re-runnable.
-- Requires 20270103100000_intelligence_emma_actions.sql.
begin;

create or replace function public.intel_admin_chat_recover_stuck(p_minutes integer default 5) returns integer
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_admin_org(); x record; v_n integer := 0;
begin
  for x in
    update public.intel_chat_actions a
       set status = 'failed',
           result = jsonb_build_object('error', 'Outcome unknown: the app never reported back after sending. Check the Sent folder before trying again.'),
           decided_at = now()
     where a.organization_id = v_org and a.user_id = auth.uid() and a.status = 'running'
       and a.decided_at < now() - make_interval(mins => greatest(coalesce(p_minutes, 5), 5))
    returning a.id, a.tool, a.category
  loop
    v_n := v_n + 1;
    perform public._intel_log(v_org, 'admin', 'chat_action_recovered', 'chat_action', x.id::text, jsonb_build_object('tool', x.tool, 'category', x.category, 'reason', 'running_without_report'));
  end loop;
  return v_n;
end $$;

revoke all on function public.intel_admin_chat_recover_stuck(integer) from public, anon;
grant execute on function public.intel_admin_chat_recover_stuck(integer) to authenticated;
notify pgrst, 'reload schema';

commit;

-- Rollback: drop function if exists public.intel_admin_chat_recover_stuck(integer);
