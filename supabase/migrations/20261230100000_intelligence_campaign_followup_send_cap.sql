-- Enforce the campaign-specific follow-up ceiling at the final provider-send transition.
-- Indie Game Developers may use four follow-ups; every other campaign remains capped at three.
-- The Phase 8 mark_sending RPC locks intel_settings FOR UPDATE before it transitions a
-- message to `sending`, serializing this count with concurrent sends for the organization.
begin;

create or replace function public._intel_enforce_campaign_followup_send_cap()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_campaign_type text;
  v_configured_cap integer;
  v_effective_cap integer;
  v_existing integer;
begin
  if new.state <> 'sending' or new.direction <> 'outbound' or new.kind <> 'followup' then
    return new;
  end if;

  select p.type into v_campaign_type
    from public.intel_prospects p
   where p.id = new.prospect_id
     and p.organization_id = new.organization_id;
  if v_campaign_type is null then
    raise exception 'follow-up campaign type could not be verified'
      using errcode = '23514';
  end if;

  select s.max_followups into v_configured_cap
    from public.intel_settings s
   where s.organization_id = new.organization_id;
  if v_configured_cap is null then
    raise exception 'follow-up settings could not be verified'
      using errcode = '23514';
  end if;

  v_effective_cap := least(v_configured_cap,
    case when v_campaign_type = 'indie_game_developer' then 4 else 3 end);

  select count(*) into v_existing
    from public.intel_messages m
   where m.organization_id = new.organization_id
     and m.prospect_id = new.prospect_id
     and m.kind = 'followup'
     and m.id <> new.id
     and m.state in ('reserved', 'sending', 'sent', 'unknown');

  if v_existing >= v_effective_cap then
    raise exception 'campaign follow-up limit reached (maximum: %)', v_effective_cap
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public._intel_enforce_campaign_followup_send_cap() from public, anon, authenticated;
drop trigger if exists intel_campaign_followup_send_cap on public.intel_messages;
create trigger intel_campaign_followup_send_cap
before update of state on public.intel_messages
for each row
when (new.state = 'sending' and old.state is distinct from new.state)
execute function public._intel_enforce_campaign_followup_send_cap();

-- Keep the admin chat settings validator aligned with Indie V2's four-step ceiling.
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
      if (a ->> 'max_followups') !~ '^\d$' or (a ->> 'max_followups')::int > 4 then return jsonb_build_object('ok', false, 'reason', 'max_followups_must_be_0_to_4'); end if;
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

revoke all on function public._intel_chat_prepare(uuid, text, jsonb) from public, anon, authenticated;

commit;

-- Rollback:
-- drop trigger if exists intel_campaign_followup_send_cap on public.intel_messages;
-- drop function if exists public._intel_enforce_campaign_followup_send_cap();
