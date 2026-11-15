-- Emma: a small live snapshot of the app, handed to the model at the start of every turn so it already knows the current state
-- (is sending stopped, which campaigns are paused, what waits for approval, recent activity) without spending tool calls.
-- Read only, same agent and administrator checks as intel_agent_chat_context. It writes no chat message, so the chat shows no tool activity
-- and it does not count toward the per-request tool-call cap. No contact details, subjects or message text are returned: counts and settings only.
-- Additive and re-runnable. The worker works without it (it simply skips the snapshot).
begin;

create or replace function public.intel_agent_chat_snapshot(p_thread_id uuid, p_message_id bigint) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org(); t public.intel_chat_threads; s public.intel_settings;
begin
  select * into t from public.intel_chat_threads where id = p_thread_id and organization_id = v_org;
  if not found then return public._intel_deny('thread_not_found'); end if;
  if not exists (select 1 from public.intel_chat_messages m where m.id = p_message_id and m.thread_id = t.id and m.role = 'user') then return public._intel_deny('message_not_found'); end if;
  if not public.intel_is_authorized_user(t.user_id, v_org) then return public._intel_deny('requester_not_authorized'); end if;
  select * into s from public.intel_settings where organization_id = v_org;
  return jsonb_build_object('ok', true, 'as_of', now(),
    'sending_stopped', s.kill_switch, 'autonomy', s.autonomy,
    'send_window', jsonb_build_object('start_hour', s.send_start_hour, 'end_hour', s.send_end_hour, 'timezone', s.timezone, 'weekdays_only', s.send_weekdays_only),
    'limits', jsonb_build_object('daily_initial_cap', s.daily_initial_cap, 'daily_followup_cap', s.daily_followup_cap, 'followup_business_days', s.followup_business_days,
                                 'max_followups', s.max_followups, 'warmup_enabled', s.warmup_enabled),
    'campaigns', coalesce((select jsonb_agg(jsonb_build_object('type', c.type, 'name', c.name, 'status', c.status, 'daily_cap', c.daily_cap,
                   'prospects', (select count(*) from public.intel_prospects p where p.campaign_id = c.id)) order by c.type)
                   from public.intel_campaigns c where c.organization_id = v_org), '[]'::jsonb),
    'prospects_by_status', coalesce((select jsonb_object_agg(q.status, q.n) from (select status, count(*) n from public.intel_prospects where organization_id = v_org group by status) q), '{}'::jsonb),
    'drafts_waiting_for_approval', (select count(*) from public.intel_messages where organization_id = v_org and direction = 'outbound' and state = 'pending_approval'),
    'failed_messages', (select count(*) from public.intel_messages where organization_id = v_org and direction = 'outbound' and state = 'failed'),
    'last_7_days', jsonb_build_object(
      'introductions_sent', (select count(*) from public.intel_messages where organization_id = v_org and direction = 'outbound' and state = 'sent' and kind = 'initial' and sent_at > now() - interval '7 days'),
      'followups_sent', (select count(*) from public.intel_messages where organization_id = v_org and direction = 'outbound' and state = 'sent' and kind = 'followup' and sent_at > now() - interval '7 days'),
      'replies_received', (select count(*) from public.intel_messages where organization_id = v_org and direction = 'inbound' and created_at > now() - interval '7 days')),
    'knowledge_entries_approved', (select count(*) from public.intel_kb where organization_id = v_org and approved));
exception when others then
  return public._intel_deny('snapshot_failed: ' || left(sqlerrm, 160));
end $$;

revoke all on function public.intel_agent_chat_snapshot(uuid, bigint) from public, anon;
grant execute on function public.intel_agent_chat_snapshot(uuid, bigint) to authenticated;

notify pgrst, 'reload schema';

commit;
