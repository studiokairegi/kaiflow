-- Phase 1: CRM lead take-over.
--   * An administrator can PASTE a lead's earlier conversation (sent manually or from another mailbox). Intelligence stores it,
--     reads it, decides the next step (follow up, reply, wait, stop or hand to a human) and prepares a DRAFT that waits for approval.
--   * One rule, enforced at the two places every email passes through (draft creation and send reservation): a lead is only
--     followed up or contacted if it has an email address in the CRM, and the message goes to exactly that address.
-- Safe to run more than once. Requires the Intelligence migrations up to 20261115110000.
begin;

-- 1. Job kind ---------------------------------------------------------------------------------------------------------------------
alter table public.intel_jobs drop constraint if exists intel_jobs_kind_check;
alter table public.intel_jobs add constraint intel_jobs_kind_check check (kind in
  ('discover','research','qualify','resolve','draft','send','sync_mail','classify','reconcile','followup_scan','retention','chat',
   'seed_sources','analyze_site','news_scan','feed_poll','crawl_index','manual_post','profile_terms','takeover'));
-- (This list is the union of the earlier migrations plus 'takeover'. Keep it that way if you edit it.)

-- 2. Take-over state on the prospect ----------------------------------------------------------------------------------------------
--    {state: pending|ready|failed, next_action, reason, summary, last_speaker, last_contact, history_id, ...}. Written only by
--    intel_admin_crm_import_history (pending) and intel_agent_takeover_result (the worker's analysis).
alter table public.intel_prospects add column if not exists takeover jsonb not null default '{}'::jsonb;

-- 3. Pasted conversations ---------------------------------------------------------------------------------------------------------
create table if not exists public.intel_lead_history (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  prospect_id uuid references public.intel_prospects(id) on delete cascade,
  entries jsonb not null default '[]'::jsonb,        -- [{direction: outbound|inbound, at: 'YYYY-MM-DD'|null, subject, body}], oldest first
  raw_text text not null default '' check (char_length(raw_text) <= 120000),
  source_email text not null default '',             -- the other address the earlier emails were sent from (information only)
  last_contact date not null,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists intel_lead_history_lead_idx on public.intel_lead_history(lead_id, created_at);
create index if not exists intel_lead_history_prospect_idx on public.intel_lead_history(prospect_id, created_at);
alter table public.intel_lead_history enable row level security;
revoke all on public.intel_lead_history from public, anon, authenticated;
grant select on public.intel_lead_history to authenticated;
drop policy if exists intel_select on public.intel_lead_history;
create policy intel_select on public.intel_lead_history for select to authenticated using (public.intel_is_authorized(organization_id));

-- 4. The email rule ---------------------------------------------------------------------------------------------------------------
--    Returns NULL when the lead may be contacted, otherwise the reason. p_to = the intended recipient (NULL for a reply to someone
--    who wrote to us: we then only require that the lead has an email at all).
create or replace function public._intel_lead_email_gate(p_lead uuid, p_to text) returns text
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare l public.leads; v_email text; v_to text := public.intel_norm_email(p_to);
begin
  select * into l from public.leads where id = p_lead;
  if not found then return 'no_crm_lead'; end if;
  v_email := public.intel_norm_email(l.email);
  if v_email = '' or position('@' in v_email) < 2 then return 'lead_has_no_email'; end if;
  if v_to <> '' and v_to <> v_email then return 'lead_email_mismatch'; end if;
  return null;
end $$;

-- 5. Replaced agent functions (each is the current definition plus the change described) ----------------------------------------
-- (a) context: also returns the pasted conversations and the lead's CRM email.
create or replace function public.intel_agent_context(p_prospect_id uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org();
begin
  return (select jsonb_build_object(
      'prospect', to_jsonb(p),
      'evidence', coalesce((select jsonb_agg(jsonb_build_object('source', e.source, 'url', e.url, 'fact_type', e.fact_type, 'snippet', e.snippet, 'verified', e.verified) order by e.fetched_at) from public.intel_evidence e where e.prospect_id = p.id), '[]'::jsonb),
      'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'idempotency_key', m.idempotency_key, 'direction', m.direction, 'kind', m.kind, 'step', m.step, 'state', m.state, 'subject', m.subject, 'body_text', left(m.body_text, 4000), 'rfc_message_id', m.rfc_message_id, 'references_ids', m.references_ids, 'zoho_message_id', m.zoho_message_id, 'from_email', m.from_email, 'created_at', m.created_at, 'sent_at', m.sent_at) order by m.created_at) from public.intel_messages m where m.prospect_id = p.id), '[]'::jsonb),
      'history', coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'entries', h.entries, 'last_contact', h.last_contact, 'source_email', h.source_email, 'created_at', h.created_at) order by h.created_at)
                             from public.intel_lead_history h where h.prospect_id = p.id), '[]'::jsonb),
      'lead', (select jsonb_build_object('id', l.id, 'email', l.email, 'contact_person', l.contact_person, 'stage', l.stage, 'source_kind', l.source_kind, 'last_contacted_at', l.last_contacted_at,
                 'sent_flags', coalesce((select jsonb_agg(coalesce(x.e ->> 'sent', 'false') = 'true' order by x.n)
                                           from jsonb_array_elements(case when jsonb_typeof(l.emails) = 'array' then l.emails else '[]'::jsonb end) with ordinality as x(e, n)), '[]'::jsonb),
                 'sent_dates', coalesce((select jsonb_agg(jsonb_build_object('idx', x.n - 1, 'date', x.e ->> 'dateSent') order by x.n)
                                           from jsonb_array_elements(case when jsonb_typeof(l.emails) = 'array' then l.emails else '[]'::jsonb end) with ordinality as x(e, n)
                                          where x.e ->> 'sent' = 'true'), '[]'::jsonb))
                 from public.leads l where l.id = p.lead_id))
     from public.intel_prospects p where p.id = p_prospect_id and p.organization_id = v_org);
end $$;

-- (b) upsert_draft: the email rule applies to every draft.
create or replace function public.intel_agent_upsert_draft(
  p_prospect_id uuid, p_kind text, p_step int, p_subject text, p_body text, p_idempotency_key text, p_to_email text, p_auto_ok boolean default false,
  p_in_reply_to text default null, p_references text default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org(); s public.intel_settings; p public.intel_prospects; v_state text; v_id uuid; v_to text := public.intel_norm_email(p_to_email); v_gate text;
begin
  select * into s from public.intel_settings where organization_id = v_org;
  select * into p from public.intel_prospects where id = p_prospect_id and organization_id = v_org;
  if not found then raise exception 'prospect not found'; end if;
  if p_kind not in ('initial','followup','reply') then raise exception 'bad kind'; end if;
  if p.status in ('suppressed','rejected','closed') then return public._intel_deny('prospect_not_contactable'); end if;
  if not (v_to = public.intel_norm_email(p.contact_email)
          or (p_kind = 'reply' and exists (select 1 from public.intel_messages i where i.prospect_id = p.id and i.direction = 'inbound' and public.intel_norm_email(i.from_email) = v_to))) then
    return public._intel_deny('recipient_not_allowed');
  end if;
  if v_to = '' then return public._intel_deny('no_recipient'); end if;
  -- Email rule: only leads that have an email address in the CRM are followed up or contacted, and only at that address.
  if p.lead_id is null and p_kind in ('initial','followup') then return public._intel_deny('no_crm_lead'); end if;
  if p.lead_id is not null then
    v_gate := public._intel_lead_email_gate(p.lead_id, case when p_kind in ('initial','followup') then v_to else null end);
    if v_gate is not null then return public._intel_deny(v_gate); end if;
  end if;
  v_state := case
    when p.origin = 'crm_existing' then 'pending_approval'
    when s.autonomy = 'autonomous' and (p_kind <> 'reply' or p_auto_ok) then 'approved'
    when s.autonomy = 'assisted' and p_kind = 'followup' then 'approved'
    when s.autonomy = 'assisted' and p_kind = 'reply' and p_auto_ok then 'approved'
    else 'pending_approval' end;
  insert into public.intel_messages(organization_id, prospect_id, lead_id, campaign_type, direction, kind, step, state, to_email, from_email, subject, body_text,
                                    idempotency_key, auto_sent, in_reply_to, references_ids)
  values (v_org, p.id, p.lead_id, p.type, 'outbound', p_kind, coalesce(p_step, 0), v_state, v_to, s.sender_email, left(p_subject, 300), left(p_body, 20000),
          left(p_idempotency_key, 200), v_state = 'approved', left(p_in_reply_to, 998), left(p_references, 4000))
  on conflict (organization_id, idempotency_key) do nothing returning id into v_id;
  if v_id is null then
    select id into v_id from public.intel_messages where organization_id = v_org and idempotency_key = left(p_idempotency_key, 200);
    return jsonb_build_object('ok', true, 'message_id', v_id, 'created', false);
  end if;
  perform public._intel_log(v_org, 'agent', 'draft_' || p_kind, 'message', v_id::text, jsonb_build_object('state', v_state, 'origin', p.origin));
  return jsonb_build_object('ok', true, 'message_id', v_id, 'created', true, 'state', v_state);
exception when unique_violation then
  return public._intel_deny('already_introduced');
end $$;

-- (c) reserve_send: the email rule applies again at send time.
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
  if m.state = 'reserved' then   -- crash after reserve, before sending: safe to resume
    return jsonb_build_object('ok', true, 'resumed', true, 'message', to_jsonb(m));
  end if;
  if m.state <> 'approved' then return public._intel_deny('not_approved'); end if;
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

-- 6. Follow-up candidates: only leads with a CRM email; live drafts block another; a pasted conversation sets the timing anchor ------
create or replace function public.intel_agent_followup_candidates(p_limit int default 20) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org(); s public.intel_settings; v_today date;
begin
  select * into s from public.intel_settings where organization_id = v_org;
  v_today := public._intel_today(v_org);
  return coalesce((select jsonb_agg(x) from (
    select p.id as prospect_id, p.name, i.sent_at,
           exists (select 1 from public.intel_lead_history h where h.prospect_id = p.id) as takeover
      from public.intel_prospects p
      join public.leads l on l.id = p.lead_id
      join lateral (select max(m.sent_at) as sent_at from public.intel_messages m
                     where m.prospect_id = p.id and m.direction = 'outbound' and m.kind in ('initial','followup') and m.state = 'sent') i on i.sent_at is not null
     where p.organization_id = v_org and p.status = 'contacted'
       and position('@' in public.intel_norm_email(l.email)) > 1
       and public.intel_norm_email(l.email) = public.intel_norm_email(p.contact_email)
       and public.intel_business_days_between(
             (greatest(i.sent_at, nullif(p.takeover ->> 'last_contact', '')::date::timestamp at time zone s.timezone) at time zone s.timezone)::date,
             v_today) >= s.followup_business_days
       and (select count(*) from public.intel_messages f where f.prospect_id = p.id and f.kind = 'followup' and f.state not in ('discarded','failed')) < s.max_followups
       and not exists (select 1 from public.intel_messages f where f.prospect_id = p.id and f.kind = 'followup'
                        and f.state in ('draft','pending_approval','approved','reserved','sending','unknown'))
       and not exists (select 1 from public.intel_messages r where r.prospect_id = p.id and r.direction = 'inbound')
     order by i.sent_at limit greatest(1, least(p_limit, 100))) x), '[]'::jsonb);
end $$;

-- 7. Paste a conversation and let Intelligence take over a CRM lead ---------------------------------------------------------------
--    p_entries: the conversation, OLDEST FIRST, each {direction: 'outbound'|'inbound', at, subject, body}. The browser parses the paste
--    and the administrator confirms who said what; this function re-validates everything. It NEVER sends anything.
create or replace function public.intel_admin_crm_import_history(
  p_lead_id uuid, p_type text, p_entries jsonb, p_raw text, p_last_contact date, p_source_email text default '')
returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.intel_admin_org();
  s public.intel_settings; l public.leads; p public.intel_prospects; r jsonb; v_row jsonb;
  v_n int; v_i int; e jsonb; v_dir text; v_last_dir text; v_total int := 0; v_clean jsonb := '[]'::jsonb;
  v_hist uuid; v_domain text; v_key text; v_camp uuid; v_anchor timestamptz; v_status text; v_to text; v_job uuid; v_type text;
begin
  if p_type not in ('indie_game_developer', 'animation_studio_support') then raise exception 'bad campaign type'; end if;
  if jsonb_typeof(coalesce(p_entries, 'null'::jsonb)) <> 'array' then raise exception 'The conversation must be a list of messages'; end if;
  v_n := jsonb_array_length(p_entries);
  if v_n < 1 or v_n > 60 then raise exception 'Paste between 1 and 60 messages'; end if;
  if p_last_contact is null then raise exception 'The date of the last message is required'; end if;
  select * into s from public.intel_settings where organization_id = v_org;
  if not found then raise exception 'Run setup first (intel_admin_bootstrap)'; end if;
  if p_last_contact > public._intel_today(v_org) + 1 then raise exception 'The date of the last message is in the future'; end if;

  for v_i in 0 .. v_n - 1 loop
    e := p_entries -> v_i;
    if jsonb_typeof(e) <> 'object' then raise exception 'Message % is not valid', v_i + 1; end if;
    v_dir := e ->> 'direction';
    if v_dir is null or v_dir not in ('outbound', 'inbound') then raise exception 'Message % needs a direction (we sent it / they replied)', v_i + 1; end if;
    if nullif(btrim(coalesce(e ->> 'body', '')), '') is null then raise exception 'Message % is empty', v_i + 1; end if;
    v_clean := v_clean || jsonb_build_object('direction', v_dir, 'at', public._intel_safe_date(e ->> 'at')::text,
                                             'subject', left(btrim(coalesce(e ->> 'subject', '')), 300), 'body', left(btrim(e ->> 'body'), 8000));
    v_total := v_total + char_length(e ->> 'body');
    v_last_dir := v_dir;
  end loop;
  if v_total > 100000 then raise exception 'The pasted conversation is too long'; end if;

  perform pg_advisory_xact_lock(hashtext(v_org::text || ':lead'));
  select * into l from public.leads where id = p_lead_id and user_id = s.owner_user_id and archived_at is null for update;
  if not found then raise exception 'CRM lead not found'; end if;
  v_to := public.intel_norm_email(l.email);
  if v_to = '' or position('@' in v_to) < 2 then
    raise exception 'This lead has no email address in the CRM. Add one first: Intelligence only follows up leads that have an email.';
  end if;
  r := public._intel_crm_review(v_org, 500, array[p_lead_id]);
  select x into v_row from jsonb_array_elements(r -> 'leads') x limit 1;
  if v_row is null then raise exception 'CRM lead not found'; end if;
  if (v_row ->> 'bucket') in ('do_not_contact', 'no_email') then raise exception 'This lead cannot be followed up: %', v_row ->> 'reason'; end if;

  v_anchor := p_last_contact::timestamp at time zone s.timezone;
  select * into p from public.intel_prospects where organization_id = v_org and lead_id = l.id order by updated_at desc limit 1 for update;

  if found then
    if p.status in ('closed', 'rejected', 'suppressed') then raise exception 'This lead is closed in Intelligence (%)', p.status; end if;
    v_type := p.type;
    v_status := case when v_last_dir = 'inbound' then 'replied'
                     when exists (select 1 from public.intel_messages m where m.prospect_id = p.id and m.direction = 'inbound') then 'replied'
                     else 'contacted' end;
    -- Anything not yet sent for this lead was planned without this history: drop it, the new analysis replans.
    update public.intel_messages set state = 'discarded', error = 'conversation history imported; Intelligence is replanning this lead'
     where prospect_id = p.id and direction = 'outbound' and kind in ('initial', 'followup') and state in ('draft', 'pending_approval', 'approved');
  else
    v_type := p_type;
    select id into v_camp from public.intel_campaigns where organization_id = v_org and type = v_type;
    v_domain := public.intel_domain_of(l.website);
    v_key := case when v_domain <> '' then 'd:' || v_domain
                  when public.intel_norm_company(l.company_name) <> '' then 'n:' || public.intel_norm_company(l.company_name)
                  else 'l:' || l.id::text end;
    v_status := case when v_last_dir = 'inbound' then 'replied' else 'contacted' end;
    begin
      insert into public.intel_prospects(organization_id, campaign_id, type, canonical_key, name, website, domain, contact_name, contact_email,
                                         country, status, facts, lead_id, origin)
      values (v_org, v_camp, v_type, v_key, left(l.company_name, 200), left(coalesce(l.website, ''), 300), v_domain, left(coalesce(l.contact_person, ''), 200),
              v_to, left(coalesce(l.country, ''), 80), v_status,
              jsonb_build_object('verified', '{}'::jsonb, 'estimates', jsonb_build_object('adopted_from_crm', true, 'conversation_pasted', true)), l.id, 'crm_existing')
      returning * into p;
    exception when unique_violation then
      raise exception 'Another Intelligence prospect already uses this website or company name. Open it under Discovered Prospects first.';
    end;
  end if;

  -- The follow-up clock needs one sent "first email" on record. Real Intelligence sends win; otherwise an imported marker at the last contact date.
  if not exists (select 1 from public.intel_messages m where m.prospect_id = p.id and m.direction = 'outbound' and m.kind = 'initial' and m.state = 'sent') then
    begin
      insert into public.intel_messages(organization_id, prospect_id, lead_id, campaign_type, direction, kind, step, state, to_email, from_email,
                                        subject, body_text, idempotency_key, sent_at, summary)
      values (v_org, p.id, l.id, v_type, 'outbound', 'initial', 0, 'sent', v_to, s.sender_email, 'Imported from CRM history', '',
              'crm-import:' || l.id::text, v_anchor,
              'Imported from the CRM and a pasted conversation. The last contact date anchors follow-up timing. Nothing was sent by Intelligence.')
      on conflict (organization_id, idempotency_key) do update set sent_at = excluded.sent_at, state = 'sent';
    exception when unique_violation then
      raise exception 'Another prospect with this email address already has a first email on record.';
    end;
  end if;

  insert into public.intel_lead_history(organization_id, lead_id, prospect_id, entries, raw_text, source_email, last_contact, created_by)
  values (v_org, l.id, p.id, v_clean, left(coalesce(p_raw, ''), 120000), left(public.intel_norm_email(p_source_email), 320), p_last_contact, auth.uid())
  returning id into v_hist;

  update public.intel_prospects
     set origin = 'crm_existing', contact_email = v_to, status = v_status, updated_at = now(),
         takeover = jsonb_build_object('state', 'pending', 'history_id', v_hist, 'last_contact', p_last_contact, 'last_speaker', v_last_dir,
                                       'messages', v_n, 'requested_at', now())
   where id = p.id;

  insert into public.intel_jobs(organization_id, kind, payload, priority, idempotency_key)
  values (v_org, 'takeover', jsonb_build_object('prospect_id', p.id, 'history_id', v_hist), 5, 'takeover:' || p.id::text || ':' || v_hist::text)
  on conflict (organization_id, idempotency_key) do nothing returning id into v_job;

  perform public._intel_log(v_org, 'admin', 'crm_import_history', 'lead', l.id::text,
                            jsonb_build_object('prospect_id', p.id, 'history_id', v_hist, 'messages', v_n, 'last_speaker', v_last_dir));
  return jsonb_build_object('ok', true, 'prospect_id', p.id, 'history_id', v_hist, 'status', v_status, 'queued', v_job is not null);
end $$;

-- Remove one pasted conversation (it may contain personal data). The remaining history, if any, is analysed again.
create or replace function public.intel_admin_crm_remove_history(p_history_id uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_admin_org(); h public.intel_lead_history; v_left int; v_next uuid; v_job uuid;
begin
  select * into h from public.intel_lead_history where id = p_history_id and organization_id = v_org for update;
  if not found then raise exception 'Conversation not found'; end if;
  delete from public.intel_lead_history where id = h.id;
  select count(*), (array_agg(x.id order by x.created_at desc))[1] into v_left, v_next from public.intel_lead_history x where x.prospect_id = h.prospect_id;
  if h.prospect_id is not null then
    if v_left = 0 then
      update public.intel_prospects set takeover = '{}'::jsonb, updated_at = now() where id = h.prospect_id and organization_id = v_org;
    else
      update public.intel_prospects set takeover = jsonb_build_object('state', 'pending', 'history_id', v_next, 'requested_at', now()), updated_at = now()
       where id = h.prospect_id and organization_id = v_org;
      insert into public.intel_jobs(organization_id, kind, payload, priority, idempotency_key)
      values (v_org, 'takeover', jsonb_build_object('prospect_id', h.prospect_id, 'history_id', v_next), 5, 'takeover:' || h.prospect_id::text || ':rm:' || h.id::text)
      on conflict (organization_id, idempotency_key) do nothing returning id into v_job;
    end if;
  end if;
  perform public._intel_log(v_org, 'admin', 'crm_remove_history', 'lead', h.lead_id::text, jsonb_build_object('history_id', h.id, 'remaining', v_left));
  return jsonb_build_object('ok', true, 'remaining', v_left, 'queued', v_job is not null);
end $$;

-- Ask for the analysis and draft to be redone (for example after the lead's email changed or the knowledge base was updated).
create or replace function public.intel_admin_crm_takeover_refresh(p_lead_id uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_admin_org(); p public.intel_prospects; v_hist uuid; v_job uuid;
begin
  select * into p from public.intel_prospects where organization_id = v_org and lead_id = p_lead_id order by updated_at desc limit 1 for update;
  if not found then raise exception 'This lead is not in Intelligence yet'; end if;
  if p.status in ('closed', 'rejected', 'suppressed') then raise exception 'This lead is closed in Intelligence (%)', p.status; end if;
  select id into v_hist from public.intel_lead_history where prospect_id = p.id order by created_at desc limit 1;
  if v_hist is null then raise exception 'Paste a conversation for this lead first'; end if;
  if exists (select 1 from public.intel_jobs j where j.organization_id = v_org and j.kind = 'takeover' and j.state in ('queued', 'running')
                and j.payload ->> 'prospect_id' = p.id::text) then
    return jsonb_build_object('ok', true, 'queued', false, 'note', 'Already being analysed');
  end if;
  update public.intel_prospects set takeover = takeover || jsonb_build_object('state', 'pending', 'history_id', v_hist, 'requested_at', now()), updated_at = now() where id = p.id;
  insert into public.intel_jobs(organization_id, kind, payload, priority, idempotency_key)
  values (v_org, 'takeover', jsonb_build_object('prospect_id', p.id, 'history_id', v_hist, 'manual', true), 5, 'takeover:' || p.id::text || ':refresh:' || gen_random_uuid()::text)
  returning id into v_job;
  perform public._intel_log(v_org, 'admin', 'crm_takeover_refresh', 'lead', p_lead_id::text, jsonb_build_object('prospect_id', p.id));
  return jsonb_build_object('ok', true, 'queued', true);
end $$;

-- 8. Introduce CRM leads that were never contacted (only those with an email address) ---------------------------------------------------
--    Creates the Intelligence record and asks for an introduction DRAFT. It waits for approval; nothing is sent here.
create or replace function public.intel_admin_crm_introduce(p_lead_ids uuid[], p_type text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.intel_admin_org(); s public.intel_settings; r jsonb; v_row jsonb; l public.leads; v_id uuid; v_ids uuid[]; v_camp uuid;
  v_domain text; v_key text; v_prospect uuid; v_ok int := 0; v_skipped jsonb := '[]'::jsonb;
begin
  if p_type not in ('indie_game_developer', 'animation_studio_support') then raise exception 'bad campaign type'; end if;
  select array_agg(distinct x) into v_ids from unnest(coalesce(p_lead_ids, '{}'::uuid[])) x;
  if v_ids is null or array_length(v_ids, 1) is null then raise exception 'no leads selected'; end if;
  if array_length(v_ids, 1) > 25 then raise exception 'introduce at most 25 leads at a time'; end if;
  select * into s from public.intel_settings where organization_id = v_org;
  if not found then raise exception 'Run setup first (intel_admin_bootstrap)'; end if;
  perform pg_advisory_xact_lock(hashtext(v_org::text || ':lead'));
  select id into v_camp from public.intel_campaigns where organization_id = v_org and type = p_type;
  r := public._intel_crm_review(v_org, 500, v_ids);
  foreach v_id in array v_ids loop
    select x into v_row from jsonb_array_elements(r -> 'leads') x where (x ->> 'lead_id')::uuid = v_id limit 1;
    if v_row is null then v_skipped := v_skipped || jsonb_build_object('lead_id', v_id, 'reason', 'not_found'); continue; end if;
    if (v_row ->> 'tracked')::boolean then v_skipped := v_skipped || jsonb_build_object('lead_id', v_id, 'reason', 'already_tracked'); continue; end if;
    if (v_row ->> 'bucket') <> 'not_contacted' then
      v_skipped := v_skipped || jsonb_build_object('lead_id', v_id, 'reason', v_row ->> 'bucket', 'detail', v_row ->> 'reason'); continue;
    end if;
    select * into l from public.leads where id = v_id and user_id = s.owner_user_id;
    if not found or public._intel_lead_email_gate(l.id, null) is not null then
      v_skipped := v_skipped || jsonb_build_object('lead_id', v_id, 'reason', 'no_email'); continue;
    end if;
    v_domain := public.intel_domain_of(l.website);
    v_key := case when v_domain <> '' then 'd:' || v_domain
                  when public.intel_norm_company(l.company_name) <> '' then 'n:' || public.intel_norm_company(l.company_name)
                  else 'l:' || l.id::text end;
    begin
      insert into public.intel_prospects(organization_id, campaign_id, type, canonical_key, name, website, domain, contact_name, contact_email,
                                         country, status, facts, lead_id, origin)
      values (v_org, v_camp, p_type, v_key, left(l.company_name, 200), left(coalesce(l.website, ''), 300), v_domain, left(coalesce(l.contact_person, ''), 200),
              public.intel_norm_email(l.email), left(coalesce(l.country, ''), 80), 'lead_linked',
              jsonb_build_object('verified', '{}'::jsonb, 'estimates', jsonb_build_object('introduced_from_crm', true)), l.id, 'crm_existing')
      returning id into v_prospect;
      insert into public.intel_jobs(organization_id, kind, payload, idempotency_key)
      values (v_org, 'draft', jsonb_build_object('prospect_id', v_prospect, 'kind', 'initial'), 'draft:' || v_prospect::text || ':initial')
      on conflict (organization_id, idempotency_key) do nothing;
      perform public._intel_log(v_org, 'admin', 'crm_introduce', 'lead', l.id::text, jsonb_build_object('prospect_id', v_prospect, 'type', p_type));
      v_ok := v_ok + 1;
    exception when unique_violation then
      v_skipped := v_skipped || jsonb_build_object('lead_id', v_id, 'reason', 'already_tracked_or_duplicate');
    end;
  end loop;
  return jsonb_build_object('introduced', v_ok, 'skipped', v_skipped);
end $$;

-- 9. The worker's analysis of a pasted conversation -------------------------------------------------------------------------------
--    p_suppress ('unsubscribe' or 'complaint'): the lead asked not to be contacted. The address is suppressed, the prospect closed and
--    anything unsent for it discarded. p_notify: a short message for the administrator's notification centre (deduplicated).
create or replace function public.intel_agent_takeover_result(p_prospect_id uuid, p_takeover jsonb, p_notify text default null, p_suppress text default null)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org(); p public.intel_prospects; v_t jsonb;
begin
  select * into p from public.intel_prospects where id = p_prospect_id and organization_id = v_org for update;
  if not found then raise exception 'prospect not found'; end if;
  if jsonb_typeof(coalesce(p_takeover, 'null'::jsonb)) <> 'object' or pg_column_size(p_takeover) > 12000 then raise exception 'bad takeover result'; end if;
  if p_suppress is not null and p_suppress not in ('unsubscribe', 'complaint') then raise exception 'bad suppression reason'; end if;
  v_t := p_takeover || jsonb_build_object('analyzed_at', now());
  update public.intel_prospects set takeover = v_t, updated_at = now() where id = p.id;

  if p_suppress is not null and public.intel_norm_email(p.contact_email) <> '' then
    insert into public.intel_suppressions(organization_id, kind, value, reason, source)
    values (v_org, 'email', public.intel_norm_email(p.contact_email), p_suppress, 'agent') on conflict do nothing;
    update public.intel_prospects set status = 'closed', updated_at = now() where id = p.id;
    update public.intel_messages set state = 'discarded', error = 'lead asked not to be contacted'
     where prospect_id = p.id and direction = 'outbound' and state in ('draft', 'pending_approval', 'approved');
  end if;
  if nullif(btrim(coalesce(p_notify, '')), '') is not null then
    perform public._intel_notify(v_org, 'intel_needs_review', 'Take-over needs you: ' || left(p.name, 100), left(p_notify, 480),
                                 p.lead_id, p.id, null, 'takeover:' || p.id::text || ':' || coalesce(v_t ->> 'history_id', '') || ':' || coalesce(v_t ->> 'next_action', ''));
  end if;
  perform public._intel_log(v_org, 'agent', 'takeover_result', 'prospect', p.id::text,
                            jsonb_build_object('next_action', v_t ->> 'next_action', 'state', v_t ->> 'state', 'suppressed', p_suppress is not null));
  return jsonb_build_object('ok', true);
end $$;

-- 10. Grants --------------------------------------------------------------------------------------------------------------------------
revoke all on function public._intel_lead_email_gate(uuid, text) from public, anon, authenticated;
revoke all on function public.intel_admin_crm_import_history(uuid, text, jsonb, text, date, text) from public, anon;
grant execute on function public.intel_admin_crm_import_history(uuid, text, jsonb, text, date, text) to authenticated;
revoke all on function public.intel_admin_crm_remove_history(uuid) from public, anon;
grant execute on function public.intel_admin_crm_remove_history(uuid) to authenticated;
revoke all on function public.intel_admin_crm_takeover_refresh(uuid) from public, anon;
grant execute on function public.intel_admin_crm_takeover_refresh(uuid) to authenticated;
revoke all on function public.intel_admin_crm_introduce(uuid[], text) from public, anon;
grant execute on function public.intel_admin_crm_introduce(uuid[], text) to authenticated;
revoke all on function public.intel_agent_takeover_result(uuid, jsonb, text, text) from public, anon;
grant execute on function public.intel_agent_takeover_result(uuid, jsonb, text, text) to authenticated;
revoke all on function public.intel_agent_followup_candidates(int) from public, anon;
grant execute on function public.intel_agent_followup_candidates(int) to authenticated;
revoke all on function public.intel_agent_context(uuid) from public, anon;
grant execute on function public.intel_agent_context(uuid) to authenticated;
revoke all on function public.intel_agent_upsert_draft(uuid, text, int, text, text, text, text, boolean, text, text) from public, anon;
grant execute on function public.intel_agent_upsert_draft(uuid, text, int, text, text, text, text, boolean, text, text) to authenticated;
revoke all on function public.intel_agent_reserve_send(uuid) from public, anon;
grant execute on function public.intel_agent_reserve_send(uuid) to authenticated;

commit;
