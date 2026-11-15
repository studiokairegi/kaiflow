-- KairFlow Intelligence: Emma (the Agent Chat) can now ACT, not only talk.
-- Adds tools that change things in KairFlow when the administrator asks: save or retire knowledge-base entries, change settings, rewrite a drafted
-- message, send an email to any address. Nothing about the safety model is weakened:
--   * The worker (agent identity) still only PROPOSES. Execution happens in the signed-in administrator's own session, through the existing
--     intel_admin_* functions, after those functions re-check authorization.
--   * Each kind of action belongs to a category. The administrator decides, per category, whether Emma must ask first ("ask") or may go ahead ("auto").
--     "auto" is still the administrator's own session running it (the open Emma window confirms on their behalf), is re-validated against the current
--     state, is audited, and expires with the card. Categories marked 'protected' can never be auto-run: turning sending on, changing autonomy,
--     do-not-contact entries, sender identity and the legal footer.
--   * There is still NO path from chat to user roles, admin status, memberships, any permission, or removing a suppression.
--   * Sending an email runs in the browser through the existing email-send function (the same path as the Inbox composer), claimed once in the
--     database so a double click or a retry can never send twice. Recipients on the do-not-contact list are refused.
-- Requires 20261109160000_intelligence_chat_actions.sql. Additive and re-runnable. Not applied anywhere.
begin;

do $$ begin
  if to_regclass('public.intel_chat_actions') is null or to_regprocedure('public.intel_agent_chat_propose(uuid,bigint,text,jsonb)') is null then
    raise exception 'Apply 20261109160000_intelligence_chat_actions.sql first';
  end if;
end $$;

-- 1. Columns ------------------------------------------------------------------------------------------------------------------------
alter table public.intel_settings add column if not exists emma_authority jsonb not null default '{"knowledge": "ask", "settings": "ask"}'::jsonb;
alter table public.intel_chat_actions add column if not exists category text not null default 'protected';
alter table public.intel_chat_actions add column if not exists auto boolean not null default false;

do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.intel_chat_actions'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%status%' loop
    execute format('alter table public.intel_chat_actions drop constraint %I', c.conname);
  end loop;
  alter table public.intel_chat_actions add constraint intel_chat_actions_status_check
    check (status in ('pending', 'running', 'confirmed', 'cancelled', 'failed', 'expired'));
end $$;

-- 2. Categories and authority ---------------------------------------------------------------------------------------------------------
create or replace function public._intel_chat_category(p_tool text, p_args jsonb default '{}'::jsonb) returns text
language sql immutable as $$
  select case
    when p_tool in ('save_knowledge', 'retire_knowledge') then 'knowledge'
    -- Sender identity, the send window, warm-up and every daily limit decide who may be emailed, when and how much: they always wait for Confirm and can never auto-run.
    when p_tool = 'change_setting' then case when (p_args ->> 'setting') in ('sender_name', 'sender_email', 'physical_address', 'opt_out_text', 'timezone', 'send_start_hour', 'send_end_hour',
                                                                          'send_weekdays_only', 'warmup_enabled', 'allow_cap_shift', 'daily_followup_cap', 'max_auto_replies_per_thread') then 'protected' else 'settings' end
    when p_tool in ('update_limits', 'set_campaign_cap') then 'protected'
    when p_tool in ('approve_messages', 'discard_messages', 'edit_message') then 'messages'
    when p_tool in ('review_prospect', 'resume_campaign') then 'prospects'
    when p_tool = 'send_email' then 'email'
    else 'protected'      -- enable_sending, set_autonomy, add_suppression and anything unknown
  end
$$;

create or replace function public._intel_chat_executor(p_tool text) returns text
language sql immutable as $$ select case when p_tool = 'send_email' then 'browser' else 'database' end $$;

create or replace function public._intel_chat_may_auto(p_org uuid, p_category text) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select p_category in ('knowledge', 'settings', 'messages', 'prospects', 'email')
     and coalesce((select (s.emma_authority ->> p_category) = 'auto' from public.intel_settings s where s.organization_id = p_org), false)
$$;

-- 3. Validate arguments and build the summary the administrator will read (older tools unchanged; new tools added) ------------------
create or replace function public._intel_chat_prepare(p_org uuid, p_tool text, p_args jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  a jsonb := case when jsonb_typeof(coalesce(p_args, '{}'::jsonb)) = 'object' then p_args else '{}'::jsonb end;
  v_ids uuid[]; v_n int; v_have int; v_type text := nullif(a ->> 'type', ''); v_list text; v_val text; s public.intel_settings; v_clean jsonb;
  v_cap int; v_x text; pr public.intel_prospects; v_state text[];
  v_key text; v_kind text; v_title text; v_body text; kbr public.intel_kb; v_set text; v_old text; v_subj text; v_to text; v_mid uuid; v_lead uuid;
  dm public.intel_messages;
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

  elsif p_tool = 'save_knowledge' then
    v_key := lower(btrim(coalesce(a ->> 'key', '')));
    if v_key !~ '^[a-z0-9][a-z0-9_.-]{0,79}$' then return jsonb_build_object('ok', false, 'reason', 'key_must_be_lowercase_letters_digits_dots_dashes_underscores'); end if;
    v_kind := a ->> 'kind';
    if v_kind is null or v_kind not in ('studio', 'service', 'portfolio', 'faq', 'policy', 'template', 'pricing_guidance', 'availability') then return jsonb_build_object('ok', false, 'reason', 'bad_kind'); end if;
    v_title := left(btrim(coalesce(a ->> 'title', '')), 120);
    v_body := btrim(coalesce(a ->> 'body', ''));
    if v_body = '' then return jsonb_build_object('ok', false, 'reason', 'empty_body'); end if;
    if char_length(v_body) > 8000 then return jsonb_build_object('ok', false, 'reason', 'body_over_8000_characters'); end if;
    if v_body ~* '<[[:space:]]*/?[[:space:]]*(approved_knowledge|untrusted)' then return jsonb_build_object('ok', false, 'reason', 'body_contains_reserved_tags'); end if;
    select * into kbr from public.intel_kb where organization_id = p_org and key = v_key;
    return jsonb_build_object('ok', true, 'args', jsonb_build_object('key', v_key, 'kind', v_kind, 'title', v_title, 'body', v_body),
      'summary', case when found then format('Replace the knowledge entry "%s" (now version %s) and approve the new text:', v_key, kbr.version)
                      else format('Add a new knowledge entry "%s" (%s) and approve it, so Emma and the email composer can use it:', v_key, v_kind) end
                 || E'\n' || coalesce(nullif(v_title, ''), '(no title)') || E'\n\n' || left(v_body, 1200) || case when char_length(v_body) > 1200 then E'\n...' else '' end);

  elsif p_tool = 'retire_knowledge' then
    v_key := lower(btrim(coalesce(a ->> 'key', '')));
    select * into kbr from public.intel_kb where organization_id = p_org and key = v_key and approved is true;
    if not found then return jsonb_build_object('ok', false, 'reason', 'no_approved_entry_with_that_key'); end if;
    return jsonb_build_object('ok', true, 'args', jsonb_build_object('key', v_key),
      'summary', format('Retire the knowledge entry "%s" (%s). Emma and the email composer stop using it. The entry stays in Settings > Knowledge base and can be approved again.', v_key, coalesce(nullif(kbr.title, ''), kbr.kind)));

  elsif p_tool = 'change_setting' then
    v_set := a ->> 'setting';
    v_val := btrim(coalesce(a ->> 'value', ''));
    if v_set is null or v_set not in ('sender_name', 'sender_email', 'physical_address', 'opt_out_text', 'timezone', 'send_start_hour', 'send_end_hour',
                                      'send_weekdays_only', 'warmup_enabled', 'allow_cap_shift', 'daily_followup_cap', 'max_auto_replies_per_thread') then
      return jsonb_build_object('ok', false, 'reason', 'setting_not_changeable_from_chat');
    end if;
    if v_set in ('send_weekdays_only', 'warmup_enabled', 'allow_cap_shift') then
      v_val := case when lower(v_val) in ('true', 'yes', 'on', '1') then 'true' when lower(v_val) in ('false', 'no', 'off', '0') then 'false' end;
      if v_val is null then return jsonb_build_object('ok', false, 'reason', 'value_must_be_yes_or_no'); end if;
      v_old := case v_set when 'send_weekdays_only' then s.send_weekdays_only::text when 'warmup_enabled' then s.warmup_enabled::text else s.allow_cap_shift::text end;
    elsif v_set in ('send_start_hour', 'send_end_hour', 'daily_followup_cap', 'max_auto_replies_per_thread') then
      if v_val !~ '^[0-9]{1,3}$' then return jsonb_build_object('ok', false, 'reason', 'value_must_be_a_whole_number'); end if;
      v_n := v_val::int;
      v_val := v_n::text;
      if v_set = 'send_start_hour' and (v_n > 23 or v_n >= s.send_end_hour) then return jsonb_build_object('ok', false, 'reason', 'start_hour_must_be_0_to_23_and_before_the_end_hour'); end if;
      if v_set = 'send_end_hour' and (v_n < 1 or v_n > 24 or v_n <= s.send_start_hour) then return jsonb_build_object('ok', false, 'reason', 'end_hour_must_be_1_to_24_and_after_the_start_hour'); end if;
      if v_set = 'daily_followup_cap' and v_n > 100 then return jsonb_build_object('ok', false, 'reason', 'daily_followup_cap_must_be_0_to_100'); end if;
      if v_set = 'max_auto_replies_per_thread' and v_n > 5 then return jsonb_build_object('ok', false, 'reason', 'max_auto_replies_must_be_0_to_5'); end if;
      v_old := case v_set when 'send_start_hour' then s.send_start_hour::text when 'send_end_hour' then s.send_end_hour::text
                          when 'daily_followup_cap' then s.daily_followup_cap::text else s.max_auto_replies_per_thread::text end;
    else
      if v_set = 'sender_name' and char_length(v_val) not between 1 and 80 then return jsonb_build_object('ok', false, 'reason', 'sender_name_must_be_1_to_80_characters'); end if;
      if v_set = 'sender_email' and (char_length(v_val) > 254 or v_val !~* '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$') then return jsonb_build_object('ok', false, 'reason', 'sender_email_must_be_a_valid_address'); end if;
      if v_set = 'physical_address' and char_length(v_val) not between 5 and 300 then return jsonb_build_object('ok', false, 'reason', 'physical_address_must_be_5_to_300_characters'); end if;
      if v_set = 'opt_out_text' and char_length(v_val) not between 10 and 500 then return jsonb_build_object('ok', false, 'reason', 'opt_out_text_must_be_10_to_500_characters'); end if;
      if v_set = 'timezone' then
        if char_length(v_val) not between 1 and 64 then return jsonb_build_object('ok', false, 'reason', 'unknown_time_zone'); end if;
        begin
          perform now() at time zone v_val;
        exception when others then
          return jsonb_build_object('ok', false, 'reason', 'unknown_time_zone');
        end;
      end if;
      v_old := case v_set when 'sender_name' then s.sender_name when 'sender_email' then s.sender_email when 'physical_address' then s.physical_address
                          when 'opt_out_text' then s.opt_out_text else s.timezone end;
    end if;
    if v_old is not distinct from v_val then return jsonb_build_object('ok', false, 'reason', 'already_set_to_that_value'); end if;
    return jsonb_build_object('ok', true, 'args', jsonb_build_object('setting', v_set, 'value', v_val),
      'summary', format('Change %s from "%s" to "%s".', replace(v_set, '_', ' '), left(coalesce(nullif(v_old, ''), '(empty)'), 120), left(v_val, 300))
                 || case when v_set in ('sender_email', 'physical_address', 'opt_out_text') then E'\nThis is part of the sender identity or legal footer of outgoing email, so it is never applied without your Confirm.' else '' end);

  elsif p_tool = 'edit_message' then
    v_mid := public._intel_juuid(a, 'message_id');
    v_subj := nullif(left(btrim(coalesce(a ->> 'subject', '')), 300), '');
    v_body := nullif(btrim(coalesce(a ->> 'body', '')), '');
    if v_mid is null then return jsonb_build_object('ok', false, 'reason', 'message_id_required'); end if;
    if v_subj is null and v_body is null then return jsonb_build_object('ok', false, 'reason', 'nothing_to_change'); end if;
    if v_subj ~ '[\r\n]' then return jsonb_build_object('ok', false, 'reason', 'subject_has_line_breaks'); end if;
    if char_length(coalesce(v_body, '')) > 20000 then return jsonb_build_object('ok', false, 'reason', 'message_too_long'); end if;
    select * into dm from public.intel_messages where id = v_mid and organization_id = p_org and direction = 'outbound' and state in ('draft', 'pending_approval', 'failed');
    if not found then return jsonb_build_object('ok', false, 'reason', 'message_not_editable'); end if;
    return jsonb_build_object('ok', true, 'args', jsonb_strip_nulls(jsonb_build_object('message_id', v_mid, 'subject', v_subj, 'body', v_body)),
      'summary', format('Rewrite the %s draft to %s. It goes back to "waiting for approval"; nothing is sent.', dm.kind, dm.to_email)
                 || coalesce(E'\nNew subject: ' || v_subj, '') || coalesce(E'\nNew text starts: ' || replace(left(v_body, 500), E'\n', ' '), ''));

  elsif p_tool = 'send_email' then
    -- "Stop ALL outgoing email" must also stop Emma's one-off emails. Checked here, so it applies when the card is prepared AND again when it is claimed (claim re-runs this function).
    if s.kill_switch then return jsonb_build_object('ok', false, 'reason', 'sending_is_stopped_emergency_stop_is_on'); end if;
    v_to := lower(btrim(coalesce(a ->> 'to', '')));
    v_subj := btrim(coalesce(a ->> 'subject', ''));
    v_body := btrim(coalesce(a ->> 'body', ''));
    if char_length(v_to) > 254 or v_to !~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$' then return jsonb_build_object('ok', false, 'reason', 'recipient_must_be_one_valid_email_address'); end if;
    if v_subj = '' then return jsonb_build_object('ok', false, 'reason', 'subject_required'); end if;
    if char_length(v_subj) > 200 or v_subj ~ '[\r\n]' then return jsonb_build_object('ok', false, 'reason', 'subject_too_long_or_has_line_breaks'); end if;
    if v_body = '' then return jsonb_build_object('ok', false, 'reason', 'message_required'); end if;
    if char_length(v_body) > 20000 then return jsonb_build_object('ok', false, 'reason', 'message_too_long'); end if;
    if exists (select 1 from public.intel_suppressions x where x.organization_id = p_org
                  and ((x.kind = 'email' and x.value = v_to) or (x.kind = 'domain' and x.value = split_part(v_to, '@', 2)))) then
      return jsonb_build_object('ok', false, 'reason', 'recipient_is_on_the_do_not_contact_list');
    end if;
    return jsonb_build_object('ok', true, 'args', jsonb_build_object('to', v_to, 'subject', v_subj, 'body', v_body),
      'summary', format('Send this email to %s from your studio mailbox:', v_to) || E'\nSubject: ' || v_subj || E'\n\n' || left(v_body, 1500) || case when char_length(v_body) > 1500 then E'\n...' else '' end);

  end if;
  return jsonb_build_object('ok', false, 'reason', 'unknown_tool');
end $$;

-- 3b. Execute a stored DATABASE action. Runs ONLY from intel_admin_chat_confirm, in the confirming administrator's session ----------
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
  elsif p_tool = 'save_knowledge' then
    perform public.intel_admin_upsert_kb(a ->> 'key', a ->> 'kind', a ->> 'title', a ->> 'body');
    perform public.intel_admin_approve_kb(a ->> 'key', true);
    return jsonb_build_object('done', 1, 'key', a ->> 'key');
  elsif p_tool = 'retire_knowledge' then perform public.intel_admin_approve_kb(a ->> 'key', false);
  elsif p_tool = 'change_setting' then perform public.intel_admin_update_settings(jsonb_build_object(a ->> 'setting', a ->> 'value'));
  elsif p_tool = 'edit_message' then perform public.intel_admin_review_message((a ->> 'message_id')::uuid, 'edit', a ->> 'subject', a ->> 'body');
  elsif p_tool = 'send_email' then raise exception 'send_email runs in the browser, through the email sender, never inside the database';
  else raise exception 'unknown tool';
  end if;
  return jsonb_build_object('done', 1);
end $$;

-- 4. The agent can only PROPOSE ---------------------------------------------------------------------------------------------------
create or replace function public.intel_agent_chat_propose(p_thread_id uuid, p_message_id bigint, p_tool text, p_args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org(); t public.intel_chat_threads; v_prep jsonb; v_id uuid; v_n int; v_cat text; v_auto boolean;
begin
  select * into t from public.intel_chat_threads where id = p_thread_id and organization_id = v_org;
  if not found then return public._intel_deny('thread_not_found'); end if;
  if not exists (select 1 from public.intel_chat_messages m where m.id = p_message_id and m.thread_id = t.id and m.role = 'user') then return public._intel_deny('message_not_found'); end if;
  if not public.intel_is_authorized_user(t.user_id, v_org) then
    perform public._intel_log(v_org, 'agent', 'chat_denied_unauthorized', 'chat', t.id::text, jsonb_build_object('tool', left(coalesce(p_tool, ''), 40)));
    return public._intel_deny('requester_not_authorized');
  end if;
  if p_tool is null or p_tool not in ('approve_messages','discard_messages','resume_campaign','set_campaign_cap','enable_sending','set_autonomy','update_limits','add_suppression','review_prospect',
                                      'save_knowledge','retire_knowledge','change_setting','edit_message','send_email') then
    perform public._intel_log(v_org, 'agent', 'chat_denied_unknown_tool', 'chat', t.id::text, jsonb_build_object('tool', left(coalesce(p_tool, ''), 40)));
    return public._intel_deny('unknown_tool');
  end if;
  select count(*) into v_n from public.intel_chat_actions where message_id = p_message_id and thread_id = t.id;
  if v_n >= 10 then return public._intel_deny('too_many_proposals_for_one_request'); end if;
  select count(*) into v_n from public.intel_chat_actions where thread_id = t.id and status = 'pending' and expires_at > now();
  if v_n >= 10 then return public._intel_deny('too_many_pending_actions'); end if;
  v_prep := public._intel_chat_prepare(v_org, p_tool, p_args);
  if not coalesce((v_prep ->> 'ok')::boolean, false) then return public._intel_deny(coalesce(v_prep ->> 'reason', 'invalid')); end if;
  v_cat := public._intel_chat_category(p_tool, v_prep -> 'args');
  v_auto := public._intel_chat_may_auto(v_org, v_cat);
  insert into public.intel_chat_actions(thread_id, organization_id, user_id, message_id, tool, args, summary, category)
  values (t.id, v_org, t.user_id, p_message_id, p_tool, v_prep -> 'args', left(v_prep ->> 'summary', 2500), v_cat)
  on conflict (thread_id, message_id, tool, args_hash) do nothing returning id into v_id;
  if v_id is null then
    select id into v_id from public.intel_chat_actions where thread_id = t.id and message_id = p_message_id and tool = p_tool and args_hash = md5((v_prep -> 'args')::text);
  end if;
  insert into public.intel_chat_messages(thread_id, organization_id, role, content, tool_name, tool_args, tool_result, reply_to)
  values (t.id, v_org, 'tool', '', p_tool, v_prep -> 'args', jsonb_build_object('proposed', true), p_message_id);
  perform public._intel_log(v_org, 'agent', 'chat_proposed', 'chat_action', v_id::text, jsonb_build_object('tool', p_tool, 'category', v_cat, 'args', v_prep -> 'args', 'requested_by', t.user_id));
  return jsonb_build_object('ok', true, 'action_id', v_id, 'status', 'pending', 'summary', v_prep ->> 'summary', 'will_run_automatically', v_auto,
    'note', case when v_auto
                 then 'Queued. The administrator allowed this kind of action without asking, so it runs by itself as soon as their open chat window picks it up. It has NOT run yet: the card shows the result.'
                 else 'NOTHING has changed yet. The administrator must press Confirm on the card in the chat.' end);
end $$;

-- 5. The administrator decides (database actions) ---------------------------------------------------------------------------------
drop function if exists public.intel_admin_chat_confirm(uuid);
create or replace function public.intel_admin_chat_confirm(p_action_id uuid, p_auto boolean default false) returns jsonb
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
  if public._intel_chat_executor(x.tool) <> 'database' then raise exception 'this action runs in the browser: use intel_admin_chat_claim'; end if;
  if coalesce(p_auto, false) and not public._intel_chat_may_auto(v_org, public._intel_chat_category(x.tool, x.args)) then
    return jsonb_build_object('ok', false, 'status', 'pending', 'error', 'auto_not_allowed');      -- the card stays pending for a manual Confirm
  end if;
  begin
    r := public._intel_chat_exec(v_org, x.tool, x.args);
    update public.intel_chat_actions set status = 'confirmed', result = r, decided_at = now(), auto = coalesce(p_auto, false) where id = x.id;
    perform public._intel_log(v_org, 'admin', case when coalesce(p_auto, false) then 'chat_action_auto_confirmed' else 'chat_action_confirmed' end, 'chat_action', x.id::text,
                              jsonb_build_object('tool', x.tool, 'category', x.category, 'args', x.args));
    return jsonb_build_object('ok', true, 'status', 'confirmed', 'result', r);
  exception when others then
    update public.intel_chat_actions set status = 'failed', result = jsonb_build_object('error', left(sqlerrm, 300)), decided_at = now(), auto = coalesce(p_auto, false) where id = x.id;
    return jsonb_build_object('ok', false, 'status', 'failed', 'error', left(sqlerrm, 300));
  end;
end $$;

-- 5b. Browser actions (send_email): claim once, send in the browser, then report ---------------------------------------------------
create or replace function public.intel_admin_chat_claim(p_action_id uuid, p_auto boolean default false) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_admin_org(); x public.intel_chat_actions; v_prep jsonb;
begin
  select * into x from public.intel_chat_actions where id = p_action_id and organization_id = v_org and user_id = auth.uid() for update;
  if not found then raise exception 'action not found'; end if;
  if x.status <> 'pending' then return jsonb_build_object('ok', false, 'status', x.status); end if;                    -- one claim, ever: no second send
  if now() > x.expires_at then
    update public.intel_chat_actions set status = 'expired', decided_at = now() where id = x.id;
    return jsonb_build_object('ok', false, 'status', 'expired');
  end if;
  if public._intel_chat_executor(x.tool) <> 'browser' then raise exception 'this action runs in the database: use intel_admin_chat_confirm'; end if;
  -- Emergency stop: nothing is claimed and the card stays pending, so it can still be sent after sending is turned back on (until it expires).
  if x.tool = 'send_email' and exists (select 1 from public.intel_settings s where s.organization_id = v_org and s.kill_switch) then
    return jsonb_build_object('ok', false, 'status', 'pending', 'error', 'sending_is_stopped');
  end if;
  if coalesce(p_auto, false) and not public._intel_chat_may_auto(v_org, public._intel_chat_category(x.tool, x.args)) then
    return jsonb_build_object('ok', false, 'status', 'pending', 'error', 'auto_not_allowed');
  end if;
  v_prep := public._intel_chat_prepare(v_org, x.tool, x.args);                                                          -- re-validated against the CURRENT state (for example a new do-not-contact entry)
  if not coalesce((v_prep ->> 'ok')::boolean, false) then
    update public.intel_chat_actions set status = 'failed', result = jsonb_build_object('error', 'no longer valid: ' || coalesce(v_prep ->> 'reason', 'invalid')), decided_at = now() where id = x.id;
    return jsonb_build_object('ok', false, 'status', 'failed', 'error', 'no longer valid: ' || coalesce(v_prep ->> 'reason', 'invalid'));
  end if;
  update public.intel_chat_actions set status = 'running', auto = coalesce(p_auto, false), decided_at = now() where id = x.id;
  perform public._intel_log(v_org, 'admin', case when coalesce(p_auto, false) then 'chat_action_auto_claimed' else 'chat_action_claimed' end, 'chat_action', x.id::text,
                            jsonb_build_object('tool', x.tool, 'category', x.category, 'to', v_prep -> 'args' ->> 'to'));
  return jsonb_build_object('ok', true, 'status', 'running', 'tool', x.tool, 'args', v_prep -> 'args');
end $$;

create or replace function public.intel_admin_chat_finish(p_action_id uuid, p_ok boolean, p_result jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_admin_org(); x public.intel_chat_actions; r jsonb := case when jsonb_typeof(coalesce(p_result, '{}'::jsonb)) = 'object' then coalesce(p_result, '{}'::jsonb) else '{}'::jsonb end; v_clean jsonb;
begin
  select * into x from public.intel_chat_actions where id = p_action_id and organization_id = v_org and user_id = auth.uid() for update;
  if not found then raise exception 'action not found'; end if;
  if x.status <> 'running' then return jsonb_build_object('ok', false, 'status', x.status); end if;
  v_clean := jsonb_strip_nulls(jsonb_build_object('message_id', left(r ->> 'message_id', 80), 'outcome', left(r ->> 'outcome', 40),
                                                  'edited', (r ->> 'edited') = 'true', 'error', left(r ->> 'error', 300), 'note', left(r ->> 'note', 300)));
  update public.intel_chat_actions set status = case when coalesce(p_ok, false) then 'confirmed' else 'failed' end, result = v_clean, decided_at = now() where id = x.id;
  perform public._intel_log(v_org, 'admin', case when coalesce(p_ok, false) then 'chat_action_done' else 'chat_action_failed' end, 'chat_action', x.id::text,
                            jsonb_build_object('tool', x.tool, 'category', x.category, 'result', v_clean));
  return jsonb_build_object('ok', true, 'status', case when coalesce(p_ok, false) then 'confirmed' else 'failed' end);
end $$;

-- 6. Emma's permissions: which kinds of action she may run without asking -----------------------------------------------------------
create or replace function public.intel_admin_set_emma_authority(p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_admin_org(); k text; v text; v_cur jsonb;
begin
  if jsonb_typeof(coalesce(p_patch, 'null'::jsonb)) <> 'object' then raise exception 'patch must be an object'; end if;
  select emma_authority into v_cur from public.intel_settings where organization_id = v_org for update;
  if not found then raise exception 'Run setup first (intel_admin_bootstrap)'; end if;
  for k, v in select key, value #>> '{}' from jsonb_each(p_patch) loop
    if k not in ('knowledge', 'settings', 'messages', 'prospects', 'email') then raise exception 'unknown category: %', left(k, 30); end if;
    if v not in ('ask', 'auto') then raise exception 'value must be ask or auto'; end if;
    v_cur := coalesce(v_cur, '{}'::jsonb) || jsonb_build_object(k, v);
  end loop;
  update public.intel_settings set emma_authority = v_cur, updated_at = now(), updated_by = auth.uid() where organization_id = v_org;
  perform public._intel_log(v_org, 'admin', 'set_emma_authority', 'settings', v_org::text, p_patch);
  return v_cur;
end $$;

-- 7. Read tools for Emma (no changes, audited, capped) --------------------------------------------------------------------------------
create or replace function public.intel_agent_chat_read(p_thread_id uuid, p_message_id bigint, p_tool text, p_args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.intel_agent_org(); t public.intel_chat_threads; s public.intel_settings;
  a jsonb := case when jsonb_typeof(coalesce(p_args, '{}'::jsonb)) = 'object' then coalesce(p_args, '{}'::jsonb) else '{}'::jsonb end;
  v_out jsonb; v_n int; v_key text; v_email text; v_limit int := public._intel_jint(a, 'limit', 10, 1, 25); kbr public.intel_kb;
begin
  select * into t from public.intel_chat_threads where id = p_thread_id and organization_id = v_org;
  if not found then return public._intel_deny('thread_not_found'); end if;
  if not exists (select 1 from public.intel_chat_messages m where m.id = p_message_id and m.thread_id = t.id and m.role = 'user') then return public._intel_deny('message_not_found'); end if;
  if not public.intel_is_authorized_user(t.user_id, v_org) then
    perform public._intel_log(v_org, 'agent', 'chat_denied_unauthorized', 'chat', t.id::text, jsonb_build_object('tool', left(coalesce(p_tool, ''), 40)));
    return public._intel_deny('requester_not_authorized');
  end if;
  if p_tool is null or p_tool not in ('settings_overview', 'knowledge_list', 'knowledge_get', 'list_drafts', 'check_recipient') then
    perform public._intel_log(v_org, 'agent', 'chat_denied_unknown_tool', 'chat', t.id::text, jsonb_build_object('tool', left(coalesce(p_tool, ''), 40)));
    return public._intel_deny('unknown_tool');
  end if;
  select count(*) into v_n from public.intel_chat_messages m where m.thread_id = t.id and m.role = 'tool' and m.reply_to = p_message_id;
  if v_n >= 12 then return public._intel_deny('too_many_tool_calls'); end if;
  select * into s from public.intel_settings where organization_id = v_org;

  begin
    if p_tool = 'settings_overview' then
      v_out := jsonb_build_object('ok', true, 'sending_stopped', s.kill_switch, 'autonomy', s.autonomy,
        'settings', jsonb_build_object('sender_name', s.sender_name, 'sender_email', s.sender_email, 'physical_address_set', s.physical_address <> '', 'timezone', s.timezone,
          'send_start_hour', s.send_start_hour, 'send_end_hour', s.send_end_hour, 'send_weekdays_only', s.send_weekdays_only, 'warmup_enabled', s.warmup_enabled,
          'allow_cap_shift', s.allow_cap_shift, 'daily_initial_cap', s.daily_initial_cap, 'daily_followup_cap', s.daily_followup_cap,
          'followup_business_days', s.followup_business_days, 'max_followups', s.max_followups, 'max_auto_replies_per_thread', s.max_auto_replies_per_thread),
        'emma_runs_without_asking', coalesce(s.emma_authority, '{}'::jsonb));

    elsif p_tool = 'knowledge_list' then
      v_out := jsonb_build_object('ok', true, 'entries', coalesce((select jsonb_agg(jsonb_build_object('key', k.key, 'kind', k.kind, 'title', k.title, 'approved', k.approved,
                 'version', k.version, 'characters', char_length(k.body), 'updated_at', k.updated_at) order by k.key)
                 from (select * from public.intel_kb where organization_id = v_org order by key limit 80) k), '[]'::jsonb));

    elsif p_tool = 'knowledge_get' then
      v_key := lower(btrim(coalesce(a ->> 'key', '')));
      select * into kbr from public.intel_kb where organization_id = v_org and key = v_key;
      if not found then return public._intel_deny('no_entry_with_that_key'); end if;
      v_out := jsonb_build_object('ok', true, 'entry', jsonb_build_object('key', kbr.key, 'kind', kbr.kind, 'title', kbr.title, 'body', kbr.body, 'approved', kbr.approved, 'version', kbr.version));

    elsif p_tool = 'list_drafts' then
      v_out := jsonb_build_object('ok', true, 'drafts', coalesce((select jsonb_agg(jsonb_build_object('message_id', d.id, 'kind', d.kind, 'state', d.state, 'to_email', d.to_email,
                 'subject', left(d.subject, 160), 'preview', left(replace(d.body_text, E'\n', ' '), 300), 'prospect', d.prospect_name, 'created_at', d.created_at) order by d.created_at desc)
                 from (select m.*, (select p.name from public.intel_prospects p where p.id = m.prospect_id) as prospect_name
                         from public.intel_messages m
                        where m.organization_id = v_org and m.direction = 'outbound' and m.state in ('draft', 'pending_approval', 'failed')
                        order by m.created_at desc limit v_limit) d), '[]'::jsonb));

    elsif p_tool = 'check_recipient' then
      v_email := lower(btrim(coalesce(a ->> 'email', '')));
      if v_email !~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$' then return public._intel_deny('not_an_email_address'); end if;
      v_out := jsonb_build_object('ok', true, 'email', v_email,
        'do_not_contact', exists (select 1 from public.intel_suppressions x where x.organization_id = v_org
                                    and ((x.kind = 'email' and x.value = v_email) or (x.kind = 'domain' and x.value = split_part(v_email, '@', 2)))),
        'known_prospects', coalesce((select jsonb_agg(jsonb_build_object('name', p.name, 'status', p.status, 'type', p.type)) from (select * from public.intel_prospects
                                       where organization_id = v_org and lower(contact_email) = v_email limit 3) p), '[]'::jsonb),
        'messages_we_sent', (select count(*) from public.intel_messages where organization_id = v_org and direction = 'outbound' and state = 'sent' and lower(to_email) = v_email),
        'last_sent_at', (select max(sent_at) from public.intel_messages where organization_id = v_org and direction = 'outbound' and state = 'sent' and lower(to_email) = v_email));
    end if;
  exception when others then
    return public._intel_deny('tool_failed: ' || left(sqlerrm, 160));
  end;

  insert into public.intel_chat_messages(thread_id, organization_id, role, content, tool_name, tool_args, tool_result, reply_to)
  values (t.id, v_org, 'tool', '', p_tool, a, v_out, p_message_id);
  perform public._intel_log(v_org, 'agent', 'chat_read', 'chat', t.id::text, jsonb_build_object('tool', p_tool, 'message_id', p_message_id, 'requested_by', t.user_id));
  return v_out;
end $$;

-- 8. Grants: same rule as before (client roles run intel_* only; _intel_* are internal) -------------------------------------------------
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig, p.proname
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and (p.proname like 'intel\_%' or p.proname like '\_intel\_%' or p.proname = 'crm_find_lead_duplicates')
  loop
    execute format('revoke all on function %s from public, anon', r.sig);
    if r.proname in ('intel_resend_record_inbound', 'intel_agent_apply_delivery_event') then
      execute format('revoke all on function %s from authenticated', r.sig);       -- service-role only (see 20270105090000): never re-granted, whatever the migration order
    elsif r.proname like '\_intel\_%' or r.proname = 'intel_is_authorized_user' then
      execute format('revoke all on function %s from authenticated', r.sig);
    else
      execute format('grant execute on function %s to authenticated', r.sig);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';

commit;

-- Rollback: drop function if exists public.intel_agent_chat_read(uuid, bigint, text, jsonb), public.intel_admin_set_emma_authority(jsonb),
--   public.intel_admin_chat_finish(uuid, boolean, jsonb), public.intel_admin_chat_claim(uuid, boolean), public.intel_admin_chat_confirm(uuid, boolean),
--   public._intel_chat_may_auto(uuid, text), public._intel_chat_executor(text), public._intel_chat_category(text, jsonb);
--   then re-apply 20261109160000_intelligence_chat_actions.sql (restores the 1-argument confirm and the older prepare/exec/propose);
--   alter table public.intel_settings drop column if exists emma_authority;  alter table public.intel_chat_actions drop column if exists category, drop column if exists auto;
