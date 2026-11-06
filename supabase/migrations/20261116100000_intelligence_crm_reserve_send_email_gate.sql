-- Correct CRM email validation before resuming reserved messages.
create or replace function public.intel_agent_reserve_send(p_message_id uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.intel_agent_org(); s public.intel_settings; m public.intel_messages; p public.intel_prospects; l public.leads; c public.intel_campaigns;
  v_today date; v_used int; v_cap int; v_last_initial timestamptz; v_fu_sent int; v_domain text; v_gate text;
begin
  select * into s from public.intel_settings where organization_id = v_org for update;     -- serialises cap accounting
  select * into m from public.intel_messages where id = p_message_id and organization_id = v_org for update;
  if not found then return public._intel_deny('not_found'); end if;
  if m.direction <> 'outbound' then return public._intel_deny('not_outbound'); end if;
  if m.state = 'sent' then return public._intel_deny('already_sent'); end if;
  if m.state in ('sending','unknown') then return public._intel_deny('needs_reconcile'); end if;
  if s.kill_switch then return public._intel_deny('kill_switch'); end if;

  v_today := public._intel_today(v_org);
  v_domain := split_part(public.intel_norm_email(m.to_email), '@', 2);
  if exists (select 1 from public.intel_suppressions x where x.organization_id = v_org and
             ((x.kind = 'email' and x.value = public.intel_norm_email(m.to_email)) or (x.kind = 'domain' and x.value = v_domain))) then
    update public.intel_messages set state = 'discarded', error = 'suppressed' where id = m.id;
    return public._intel_deny('suppressed');
  end if;

  if m.prospect_id is not null then
    select * into p from public.intel_prospects where id = m.prospect_id;
    if p.status in ('rejected','closed','suppressed') then
      update public.intel_messages set state = 'discarded', error = 'prospect ' || p.status where id = m.id; return public._intel_deny('prospect_' || p.status);
    end if;
    if m.kind in ('initial','followup') and p.status = 'replied' then
      update public.intel_messages set state = 'discarded', error = 'prospect replied' where id = m.id; return public._intel_deny('prospect_replied');
    end if;
  end if;

  -- Email rule (second line of defence, at the moment of sending): the lead must still have an email address in the CRM,
  -- and a first email or follow-up must go to exactly that address.
  if m.kind in ('initial','followup') and m.lead_id is null then
    update public.intel_messages set state = 'discarded', error = 'no CRM lead' where id = m.id;
    return public._intel_deny('no_crm_lead');
  end if;
  if m.lead_id is not null then
    v_gate := public._intel_lead_email_gate(m.lead_id, case when m.kind in ('initial','followup') then m.to_email else null end);
    if v_gate is not null then
      update public.intel_messages set state = 'discarded', error = 'CRM email check failed: ' || v_gate where id = m.id;
      return public._intel_deny(v_gate);
    end if;
  end if;
  if m.state = 'reserved' then   -- crash after reserve, before sending: safe to resume
    return jsonb_build_object('ok', true, 'resumed', true, 'message', to_jsonb(m));
  end if;
  if m.state <> 'approved' then return public._intel_deny('not_approved'); end if;

  if m.kind in ('initial','followup') then
    select * into c from public.intel_campaigns where organization_id = v_org and type = m.campaign_type;
    if c.status <> 'active' then return public._intel_deny('campaign_paused'); end if;
    -- Business-hours window in the studio time zone (cold email at 3 a.m. looks automated and hurts deliverability).
    if extract(hour from (now() at time zone s.timezone)) < s.send_start_hour
       or extract(hour from (now() at time zone s.timezone)) >= s.send_end_hour
       or (s.send_weekdays_only and extract(isodow from (now() at time zone s.timezone)) > 5) then
      return public._intel_deny('outside_send_hours');
    end if;
    if btrim(s.sender_email) = '' or btrim(s.physical_address) = '' or btrim(s.opt_out_text) = ''
       or position(lower(btrim(s.opt_out_text)) in lower(m.body_text)) = 0
       or position(lower(btrim(s.physical_address)) in lower(m.body_text)) = 0 then
      return public._intel_deny('missing_compliance_footer');
    end if;
  end if;

  if m.kind = 'initial' then
    if m.lead_id is not null then
      select * into l from public.leads where id = m.lead_id;
      if l.last_contacted_at is not null or l.stage <> 'pool' or coalesce((l.emails -> 0 ->> 'sent')::boolean, false) then
        update public.intel_messages set state = 'discarded', error = 'lead already contacted' where id = m.id;
        return public._intel_deny('already_contacted');
      end if;
    end if;
    v_cap := public._intel_effective_initial_cap(v_org);
    select count(*) into v_used from public.intel_messages where organization_id = v_org and kind = 'initial' and send_day = v_today and state in ('reserved','sending','sent','unknown');
    if v_used >= v_cap then return public._intel_deny('daily_cap'); end if;
    if not s.allow_cap_shift then
      select count(*) into v_used from public.intel_messages where organization_id = v_org and kind = 'initial' and send_day = v_today
         and campaign_type = m.campaign_type and state in ('reserved','sending','sent','unknown');
      if v_used >= c.daily_cap then return public._intel_deny('campaign_cap'); end if;
    end if;
  elsif m.kind = 'followup' then
    select count(*) into v_used from public.intel_messages where organization_id = v_org and kind = 'followup' and send_day = v_today and state in ('reserved','sending','sent','unknown');
    if v_used >= s.daily_followup_cap then return public._intel_deny('followup_cap'); end if;
    select max(sent_at) into v_last_initial from public.intel_messages where prospect_id = m.prospect_id and kind = 'initial' and state = 'sent';
    if v_last_initial is null then return public._intel_deny('no_initial_sent'); end if;
    select count(*) into v_fu_sent from public.intel_messages where prospect_id = m.prospect_id and kind = 'followup' and state in ('reserved','sending','sent','unknown') and id <> m.id;
    if v_fu_sent >= s.max_followups then
      update public.intel_messages set state = 'discarded', error = 'follow-up limit reached' where id = m.id; return public._intel_deny('max_followups');
    end if;
    if exists (select 1 from public.intel_messages i where i.prospect_id = m.prospect_id and i.direction = 'inbound') then
      update public.intel_messages set state = 'discarded', error = 'prospect replied' where id = m.id; return public._intel_deny('prospect_replied');
    end if;
    if public.intel_business_days_between((v_last_initial at time zone s.timezone)::date, v_today) < s.followup_business_days then
      return public._intel_deny('followup_not_due');
    end if;
  elsif m.kind = 'reply' and m.auto_sent then
    select count(*) into v_used from public.intel_messages where prospect_id = m.prospect_id and kind = 'reply' and auto_sent and state in ('reserved','sending','sent','unknown') and id <> m.id;
    if v_used >= s.max_auto_replies_per_thread then
      update public.intel_messages set state = 'pending_approval', auto_sent = false, error = 'automatic reply limit reached; needs your approval' where id = m.id;
      return public._intel_deny('auto_reply_limit');
    end if;
  end if;

  update public.intel_messages
     set state = 'reserved', send_day = v_today, reserved_at = now(), from_email = s.sender_email,
         token = coalesce(token, 'kf' || replace(gen_random_uuid()::text, '-', ''))
   where id = m.id returning * into m;
  perform public._intel_log(v_org, 'agent', 'reserve_send', 'message', m.id::text, jsonb_build_object('kind', m.kind));
  return jsonb_build_object('ok', true, 'resumed', false, 'message', to_jsonb(m));
end $$;

revoke all on function public.intel_agent_reserve_send(uuid) from public, anon;
grant execute on function public.intel_agent_reserve_send(uuid) to authenticated;
