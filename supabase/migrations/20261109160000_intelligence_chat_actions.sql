-- KairFlow Intelligence: Agent Chat "propose, then you confirm".
-- The assistant can PREPARE changes (approve/discard messages, resume a campaign, enable sending, change limits or autonomy, add a suppression,
-- approve/reject a prospect). Preparing changes nothing. The change runs only when the administrator presses Confirm, as that administrator,
-- through the existing intel_admin_* functions (so every existing check still applies). The summary the administrator reads is built here from
-- the stored arguments, never from model text. There is deliberately NO path from chat to user roles, admin status, memberships or any
-- permission outside this module. Requires the earlier Intelligence migrations. Additive and re-runnable. Not applied anywhere.
begin;

do $$ begin
  if to_regclass('public.intel_chat_threads') is null or to_regprocedure('public.intel_agent_chat_tool(uuid,bigint,text,jsonb)') is null then
    raise exception 'Apply 20261109140000_intelligence_v1_completion.sql first';
  end if;
end $$;

create table if not exists public.intel_chat_actions (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.intel_chat_threads(id) on delete cascade,
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  message_id bigint not null,                      -- the administrator's request this answers
  tool text not null,
  args jsonb not null,
  args_hash text generated always as (md5(args::text)) stored,
  summary text not null,
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'cancelled', 'failed', 'expired')),
  result jsonb,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  expires_at timestamptz not null default now() + interval '30 minutes'
);
create unique index if not exists intel_chat_actions_dedupe_uidx on public.intel_chat_actions(thread_id, message_id, tool, args_hash);
create index if not exists intel_chat_actions_thread_idx on public.intel_chat_actions(thread_id, created_at);

alter table public.intel_chat_actions enable row level security;
revoke all on public.intel_chat_actions from public, anon, authenticated;
grant select on public.intel_chat_actions to authenticated;
drop policy if exists intel_chat_actions_select on public.intel_chat_actions;
create policy intel_chat_actions_select on public.intel_chat_actions for select to authenticated
  using (user_id = auth.uid() and public.intel_is_authorized(organization_id));

-- 1. Validate arguments and build the summary the administrator will read -------------------------------------------------------
create or replace function public._intel_chat_prepare(p_org uuid, p_tool text, p_args jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  a jsonb := case when jsonb_typeof(coalesce(p_args, '{}'::jsonb)) = 'object' then p_args else '{}'::jsonb end;
  v_ids uuid[]; v_n int; v_have int; v_type text := nullif(a ->> 'type', ''); v_list text; v_val text; s public.intel_settings; v_clean jsonb;
  v_cap int; v_x text; pr public.intel_prospects; v_state text[];
begin
  select * into s from public.intel_settings where organization_id = p_org;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_set_up'); end if;

  if p_tool in ('approve_messages', 'discard_messages') then
    v_ids := public._intel_juuids(a, 'message_ids', 10);
    v_n := coalesce(array_length(v_ids, 1), 0);
    if v_n = 0 then return jsonb_build_object('ok', false, 'reason', 'no_valid_message_ids'); end if;
    v_state := case when p_tool = 'approve_messages' then array['pending_approval'] else array['draft', 'pending_approval', 'approved', 'failed'] end;
    select count(*), string_agg(format('- %s to %s, subject "%s"', m.kind, m.to_email, left(m.subject, 90)), E'\n' order by m.created_at)
      into v_have, v_list
      from public.intel_messages m
     where m.id = any (v_ids) and m.organization_id = p_org and m.direction = 'outbound' and m.state = any (v_state);
    if v_have <> v_n then return jsonb_build_object('ok', false, 'reason', 'some_messages_not_in_a_valid_state'); end if;
    if v_n = 1 and p_tool = 'approve_messages' then
      select E'\nStarts: ' || replace(left(m.body_text, 350), E'\n', ' ') into v_x from public.intel_messages m where m.id = v_ids[1];
    end if;
    return jsonb_build_object('ok', true, 'args', jsonb_build_object('message_ids', to_jsonb(v_ids)),
      'summary', case when p_tool = 'approve_messages' then format('Approve %s message(s) so the worker can send them (daily limits, warm-up and suppression still apply):', v_n)
                      else format('Discard %s message(s) (they will not be sent):', v_n) end || E'\n' || v_list || coalesce(v_x, ''));

  elsif p_tool = 'resume_campaign' then
    if v_type is null or v_type not in ('indie_game_developer', 'animation_studio_support') then return jsonb_build_object('ok', false, 'reason', 'bad_type'); end if;
    if not exists (select 1 from public.intel_campaigns where organization_id = p_org and type = v_type and status <> 'active') then return jsonb_build_object('ok', false, 'reason', 'campaign_already_active'); end if;
    return jsonb_build_object('ok', true, 'args', jsonb_build_object('type', v_type), 'summary', format('Start the "%s" campaign. Discovery runs again and approved messages for this campaign become sendable.', v_type));

  elsif p_tool = 'set_campaign_cap' then
    if v_type is null or v_type not in ('indie_game_developer', 'animation_studio_support') then return jsonb_build_object('ok', false, 'reason', 'bad_type'); end if;
    if (a ->> 'daily_cap') !~ '^\d{1,2}$' or (a ->> 'daily_cap')::int > 30 then return jsonb_build_object('ok', false, 'reason', 'daily_cap_must_be_0_to_30'); end if;
    return jsonb_build_object('ok', true, 'args', jsonb_build_object('type', v_type, 'daily_cap', (a ->> 'daily_cap')::int),
      'summary', format('Set the daily introduction limit for "%s" to %s.', v_type, a ->> 'daily_cap'));

  elsif p_tool = 'enable_sending' then
    if not s.kill_switch then return jsonb_build_object('ok', false, 'reason', 'sending_is_already_on'); end if;
    select count(*) into v_n from public.intel_messages where organization_id = p_org and state = 'approved';
    return jsonb_build_object('ok', true, 'args', '{}'::jsonb,
      'summary', format('Turn sending ON. %s message(s) are approved right now and will be emailed within the daily limits (%s introductions, %s follow-ups per day, warm-up %s). Needs a connected mailbox, a registered agent and your sender details.',
                        v_n, s.daily_initial_cap, s.daily_followup_cap, case when s.warmup_enabled then 'on' else 'off' end));

  elsif p_tool = 'set_autonomy' then
    v_x := a ->> 'autonomy';
    if v_x is null or v_x not in ('shadow', 'assisted', 'autonomous') then return jsonb_build_object('ok', false, 'reason', 'autonomy_must_be_shadow_assisted_or_autonomous'); end if;
    return jsonb_build_object('ok', true, 'args', jsonb_build_object('autonomy', v_x),
      'summary', 'Set autonomy to ' || v_x || ': ' || case v_x
        when 'shadow' then 'the agent drafts everything and every message waits for your approval.'
        when 'assisted' then 'follow-ups and safe auto-replies may go without approval; first introductions still need approval.'
        else 'introductions may be sent WITHOUT your approval (still within limits, suppression and the emergency stop).' end);

  elsif p_tool = 'update_limits' then
    v_clean := '{}'::jsonb;
    if a ? 'daily_initial_cap' then
      if (a ->> 'daily_initial_cap') !~ '^\d{1,2}$' or (a ->> 'daily_initial_cap')::int > 30 then return jsonb_build_object('ok', false, 'reason', 'daily_initial_cap_must_be_0_to_30'); end if;
      v_clean := v_clean || jsonb_build_object('daily_initial_cap', (a ->> 'daily_initial_cap')::int);
    end if;
    if a ? 'followup_business_days' then
      if (a ->> 'followup_business_days') !~ '^\d{1,2}$' or (a ->> 'followup_business_days')::int not between 1 and 30 then return jsonb_build_object('ok', false, 'reason', 'followup_business_days_must_be_1_to_30'); end if;
      v_clean := v_clean || jsonb_build_object('followup_business_days', (a ->> 'followup_business_days')::int);
    end if;
    if a ? 'max_followups' then
      if (a ->> 'max_followups') !~ '^\d$' or (a ->> 'max_followups')::int > 3 then return jsonb_build_object('ok', false, 'reason', 'max_followups_must_be_0_to_3'); end if;
      v_clean := v_clean || jsonb_build_object('max_followups', (a ->> 'max_followups')::int);
    end if;
    if v_clean = '{}'::jsonb then return jsonb_build_object('ok', false, 'reason', 'nothing_to_change'); end if;
    return jsonb_build_object('ok', true, 'args', v_clean, 'summary', 'Change sending limits: ' || (select string_agg(k || ' = ' || val, ', ') from jsonb_each_text(v_clean) as t(k, val)));

  elsif p_tool = 'add_suppression' then
    v_val := lower(btrim(coalesce(a ->> 'value', '')));
    if v_val !~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$' and v_val !~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$' then return jsonb_build_object('ok', false, 'reason', 'value_must_be_an_email_or_a_domain'); end if;
    return jsonb_build_object('ok', true, 'args', jsonb_build_object('value', v_val, 'reason', left(coalesce(a ->> 'reason', ''), 200)),
      'summary', format('Never contact %s again (%s).', v_val, case when position('@' in v_val) > 0 then 'this address' else 'everyone at this domain' end));

  elsif p_tool = 'review_prospect' then
    v_x := a ->> 'action';
    if v_x is null or v_x not in ('approve', 'reject') then return jsonb_build_object('ok', false, 'reason', 'action_must_be_approve_or_reject'); end if;
    select * into pr from public.intel_prospects where id = public._intel_juuid(a, 'prospect_id') and organization_id = p_org;
    if not found then return jsonb_build_object('ok', false, 'reason', 'prospect_not_found'); end if;
    return jsonb_build_object('ok', true, 'args', jsonb_build_object('prospect_id', pr.id, 'action', v_x),
      'summary', format('%s prospect "%s" (%s, currently %s).', case v_x when 'approve' then 'Approve' else 'Reject' end, pr.name, pr.type, pr.status));
  end if;
  return jsonb_build_object('ok', false, 'reason', 'unknown_tool');
end $$;

-- 2. Execute a stored action. Runs ONLY from intel_admin_chat_confirm, in the confirming administrator's session --------------------
create or replace function public._intel_chat_exec(p_org uuid, p_tool text, p_args jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_prepared jsonb; a jsonb; v_id uuid; v_n int := 0;
begin
  v_prepared := public._intel_chat_prepare(p_org, p_tool, p_args);       -- re-validate against the CURRENT state; never trust stored arguments
  if not coalesce((v_prepared ->> 'ok')::boolean, false) then raise exception 'no longer valid: %', v_prepared ->> 'reason'; end if;
  a := v_prepared -> 'args';
  if p_tool in ('approve_messages', 'discard_messages') then
    for v_id in select (x)::uuid from jsonb_array_elements_text(a -> 'message_ids') x loop
      perform public.intel_admin_review_message(v_id, case when p_tool = 'approve_messages' then 'approve' else 'discard' end);
      v_n := v_n + 1;
    end loop;
    return jsonb_build_object('done', v_n);
  elsif p_tool = 'resume_campaign' then perform public.intel_admin_update_campaign(a ->> 'type', jsonb_build_object('status', 'active'));
  elsif p_tool = 'set_campaign_cap' then perform public.intel_admin_update_campaign(a ->> 'type', jsonb_build_object('daily_cap', (a ->> 'daily_cap')::int));
  elsif p_tool = 'enable_sending' then perform public.intel_admin_set_kill_switch(false);
  elsif p_tool = 'set_autonomy' then perform public.intel_admin_update_settings(jsonb_build_object('autonomy', a ->> 'autonomy'));
  elsif p_tool = 'update_limits' then perform public.intel_admin_update_settings(a);
  elsif p_tool = 'add_suppression' then perform public.intel_admin_add_suppression(a ->> 'value', a ->> 'reason');
  elsif p_tool = 'review_prospect' then perform public.intel_admin_review_prospect((a ->> 'prospect_id')::uuid, a ->> 'action');
  else raise exception 'unknown tool';
  end if;
  return jsonb_build_object('done', 1);
end $$;

-- 3. The agent can only PROPOSE ---------------------------------------------------------------------------------------------------
create or replace function public.intel_agent_chat_propose(p_thread_id uuid, p_message_id bigint, p_tool text, p_args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org(); t public.intel_chat_threads; v_prep jsonb; v_id uuid; v_n int;
begin
  select * into t from public.intel_chat_threads where id = p_thread_id and organization_id = v_org;
  if not found then return public._intel_deny('thread_not_found'); end if;
  if not exists (select 1 from public.intel_chat_messages m where m.id = p_message_id and m.thread_id = t.id and m.role = 'user') then return public._intel_deny('message_not_found'); end if;
  if not public.intel_is_authorized_user(t.user_id, v_org) then
    perform public._intel_log(v_org, 'agent', 'chat_denied_unauthorized', 'chat', t.id::text, jsonb_build_object('tool', left(coalesce(p_tool, ''), 40)));
    return public._intel_deny('requester_not_authorized');
  end if;
  if p_tool is null or p_tool not in ('approve_messages','discard_messages','resume_campaign','set_campaign_cap','enable_sending','set_autonomy','update_limits','add_suppression','review_prospect') then
    perform public._intel_log(v_org, 'agent', 'chat_denied_unknown_tool', 'chat', t.id::text, jsonb_build_object('tool', left(coalesce(p_tool, ''), 40)));
    return public._intel_deny('unknown_tool');
  end if;
  select count(*) into v_n from public.intel_chat_actions where message_id = p_message_id and thread_id = t.id;
  if v_n >= 10 then return public._intel_deny('too_many_proposals_for_one_request'); end if;
  select count(*) into v_n from public.intel_chat_actions where thread_id = t.id and status = 'pending' and expires_at > now();
  if v_n >= 10 then return public._intel_deny('too_many_pending_actions'); end if;
  v_prep := public._intel_chat_prepare(v_org, p_tool, p_args);
  if not coalesce((v_prep ->> 'ok')::boolean, false) then return public._intel_deny(coalesce(v_prep ->> 'reason', 'invalid')); end if;
  insert into public.intel_chat_actions(thread_id, organization_id, user_id, message_id, tool, args, summary)
  values (t.id, v_org, t.user_id, p_message_id, p_tool, v_prep -> 'args', left(v_prep ->> 'summary', 2500))
  on conflict (thread_id, message_id, tool, args_hash) do nothing returning id into v_id;
  if v_id is null then
    select id into v_id from public.intel_chat_actions where thread_id = t.id and message_id = p_message_id and tool = p_tool and args_hash = md5((v_prep -> 'args')::text);
  end if;
  insert into public.intel_chat_messages(thread_id, organization_id, role, content, tool_name, tool_args, tool_result, reply_to)
  values (t.id, v_org, 'tool', '', p_tool, v_prep -> 'args', jsonb_build_object('proposed', true), p_message_id);
  perform public._intel_log(v_org, 'agent', 'chat_proposed', 'chat_action', v_id::text, jsonb_build_object('tool', p_tool, 'args', v_prep -> 'args', 'requested_by', t.user_id));
  return jsonb_build_object('ok', true, 'action_id', v_id, 'status', 'pending', 'summary', v_prep ->> 'summary',
                            'note', 'NOTHING has changed yet. The administrator must press Confirm on the card in the chat.');
end $$;

-- 4. The administrator decides ----------------------------------------------------------------------------------------------------
create or replace function public.intel_admin_chat_confirm(p_action_id uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_admin_org(); x public.intel_chat_actions; r jsonb;
begin
  select * into x from public.intel_chat_actions where id = p_action_id and organization_id = v_org and user_id = auth.uid() for update;
  if not found then raise exception 'action not found'; end if;
  if x.status <> 'pending' then return jsonb_build_object('ok', x.status = 'confirmed', 'status', x.status, 'result', x.result); end if;   -- double clicks do nothing
  if now() > x.expires_at then
    update public.intel_chat_actions set status = 'expired', decided_at = now() where id = x.id;
    return jsonb_build_object('ok', false, 'status', 'expired');
  end if;
  begin
    r := public._intel_chat_exec(v_org, x.tool, x.args);
    update public.intel_chat_actions set status = 'confirmed', result = r, decided_at = now() where id = x.id;
    perform public._intel_log(v_org, 'admin', 'chat_action_confirmed', 'chat_action', x.id::text, jsonb_build_object('tool', x.tool, 'args', x.args));
    return jsonb_build_object('ok', true, 'status', 'confirmed', 'result', r);
  exception when others then
    update public.intel_chat_actions set status = 'failed', result = jsonb_build_object('error', left(sqlerrm, 300)), decided_at = now() where id = x.id;
    return jsonb_build_object('ok', false, 'status', 'failed', 'error', left(sqlerrm, 300));
  end;
end $$;

create or replace function public.intel_admin_chat_cancel(p_action_id uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_admin_org(); v_n int;
begin
  update public.intel_chat_actions set status = 'cancelled', decided_at = now()
   where id = p_action_id and organization_id = v_org and user_id = auth.uid() and status = 'pending';
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'action not found or already decided'; end if;
  perform public._intel_log(v_org, 'admin', 'chat_action_cancelled', 'chat_action', p_action_id::text, '{}'::jsonb);
  return jsonb_build_object('ok', true, 'status', 'cancelled');
end $$;

-- 5. Grants: same rule as before (client roles run intel_* only; _intel_* internal) -----------------------------------------------
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig, p.proname
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and (p.proname like 'intel\_%' or p.proname like '\_intel\_%' or p.proname = 'crm_find_lead_duplicates')
  loop
    execute format('revoke all on function %s from public, anon', r.sig);
    if r.proname like '\_intel\_%' or r.proname = 'intel_is_authorized_user' then
      execute format('revoke all on function %s from authenticated', r.sig);
    else
      execute format('grant execute on function %s to authenticated', r.sig);
    end if;
  end loop;
end $$;

commit;

-- Rollback: drop function if exists public.intel_admin_chat_cancel(uuid), public.intel_admin_chat_confirm(uuid), public.intel_agent_chat_propose(uuid, bigint, text, jsonb),
--   public._intel_chat_exec(uuid, text, jsonb), public._intel_chat_prepare(uuid, text, jsonb);  drop table if exists public.intel_chat_actions;
