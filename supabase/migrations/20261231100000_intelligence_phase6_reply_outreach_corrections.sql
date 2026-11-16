-- Phase 6 corrective release migration (forward-only).
-- Repairs reply labels/suppression, restores campaign-specific follow-up behavior,
-- and preserves review holds. Apply after all existing migrations.
begin;

-- Keep the historic Animation Studio Support default at three. Indie can opt in
-- to four stages by explicitly setting max_followups=4.
alter table public.intel_settings alter column max_followups set default 3;
alter table public.intel_settings drop constraint if exists intel_settings_max_followups_check;
alter table public.intel_settings add constraint intel_settings_max_followups_check check (max_followups between 0 and 4);

create or replace function public.intel_agent_classify_inbound(p_message_id uuid, p_class text, p_confidence numeric, p_escalate boolean, p_summary text, p_related_email text default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org(); m public.intel_messages; p public.intel_prospects; v_event text; v_title text; v_name text; v_who text;
begin
  if p_class not in ('positive','meeting_request','pricing','negotiation','portfolio_request','project_opportunity','rejection','unsubscribe','ambiguous','complaint','bounce','out_of_office','auto_reply','other','not_now','not_interested','already_has_trailer','wrong_person','referral','tell_me_more') then
    raise exception 'unknown class';
  end if;
  select * into m from public.intel_messages where id = p_message_id and organization_id = v_org and direction = 'inbound' for update;
  if not found then raise exception 'inbound message not found'; end if;
  update public.intel_messages set classification = p_class, classification_confidence = p_confidence, escalated = coalesce(p_escalate, false), summary = left(coalesce(p_summary, ''), 500) where id = m.id;
  if m.prospect_id is not null then select * into p from public.intel_prospects where id = m.prospect_id; end if;
  v_name := coalesce(p.name, m.from_email, 'a prospect');

  if p_class in ('unsubscribe','complaint') and m.from_email <> '' then
    insert into public.intel_suppressions(organization_id, kind, value, reason, source) values (v_org, 'email', m.from_email, p_class, 'agent') on conflict do nothing;
  end if;
  if p_class = 'bounce' and coalesce(p_related_email, '') <> '' then
    insert into public.intel_suppressions(organization_id, kind, value, reason, source) values (v_org, 'email', public.intel_norm_email(p_related_email), 'bounce', 'agent') on conflict do nothing;
    update public.intel_prospects set status = 'closed', updated_at = now() where organization_id = v_org and contact_email = public.intel_norm_email(p_related_email) and status in ('contacted','lead_linked');
  end if;
  if m.prospect_id is not null and p_class not in ('out_of_office','auto_reply','bounce') then
    update public.intel_prospects set status = case when p_class in ('rejection','unsubscribe','complaint','not_interested','already_has_trailer') then 'closed' else 'replied' end, updated_at = now() where id = m.prospect_id and status not in ('closed');
    -- stop anything still queued for this prospect
    update public.intel_messages set state = 'discarded', error = 'prospect replied' where prospect_id = m.prospect_id and direction = 'outbound' and kind in ('initial','followup') and state in ('draft','pending_approval','approved','reserved');
    if p_class in ('positive','meeting_request','pricing','negotiation','portfolio_request','project_opportunity') and m.lead_id is not null then
      update public.leads set stage = 'responded', stage_changed_at = now(), last_contacted_at = now() where id = m.lead_id and stage in ('pool','cold_email');
    end if;
  end if;

  v_event := case p_class when 'positive' then 'intel_positive_reply' when 'meeting_request' then 'intel_meeting_request' when 'pricing' then 'intel_pricing_inquiry'
                          when 'negotiation' then 'intel_negotiation' when 'portfolio_request' then 'intel_portfolio_request' when 'project_opportunity' then 'intel_project_opportunity'
                          when 'rejection' then 'intel_needs_review' when 'unsubscribe' then 'intel_unsubscribe' when 'bounce' then 'intel_bounce'
                          when 'ambiguous' then 'intel_needs_review' when 'complaint' then 'intel_needs_review'
                          when 'not_now' then 'intel_needs_review' when 'not_interested' then 'intel_needs_review'
                          when 'already_has_trailer' then 'intel_needs_review' when 'wrong_person' then 'intel_needs_review'
                          when 'referral' then 'intel_needs_review' when 'tell_me_more' then 'intel_needs_review' else null end;
  if v_event is not null then
    v_title := case p_class when 'positive' then 'Positive reply from ' when 'meeting_request' then 'Meeting request from ' when 'pricing' then 'Pricing enquiry from '
                            when 'negotiation' then 'Negotiation with ' when 'portfolio_request' then 'Portfolio request from ' when 'project_opportunity' then 'Project opportunity: '
                            when 'rejection' then 'Reply needs review from ' when 'unsubscribe' then 'Unsubscribe from ' when 'bounce' then 'Email bounced: '
                            when 'not_now' then 'Not now: ' when 'not_interested' then 'Not interested: '
                            when 'already_has_trailer' then 'Existing trailer: ' when 'wrong_person' then 'Wrong contact: '
                            when 'referral' then 'Referral: ' when 'tell_me_more' then 'More information requested by '
                            else 'Needs your review: ' end || v_name;
    perform public._intel_notify(v_org, v_event, v_title, coalesce(nullif(p_summary, ''), 'Open the conversation to read the message.'), m.lead_id, m.prospect_id, m.id, 'in:' || coalesce(m.zoho_message_id, m.id::text));
  end if;
  perform public._intel_log(v_org, 'agent', 'classify_inbound', 'message', m.id::text, jsonb_build_object('class', p_class, 'escalate', p_escalate));
  return jsonb_build_object('ok', true, 'notified', v_event is not null);
end $$;


create or replace function public.intel_agent_followup_candidates(p_limit int default 20) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.intel_agent_org();
  s public.intel_settings;
  v_today date;
begin
  select * into s from public.intel_settings where organization_id = v_org;
  if not found then return '[]'::jsonb; end if;
  v_today := public._intel_today(v_org);
  return coalesce((
    select jsonb_agg(x) from (
      select p.id as prospect_id,
             p.name,
             case when p.type = 'indie_game_developer' then i.initial_sent_at else i.last_sent_at end as sent_at,
             exists (select 1 from public.intel_lead_history h where h.prospect_id = p.id) as takeover,
             case
               when p.type = 'indie_game_developer' and f.sent_followups >= 2 then 'reengagement'
               when p.type = 'indie_game_developer' then 'followup'
               when s.max_followups >= 2
                and not exists (select 1 from public.intel_lead_history h where h.prospect_id = p.id)
                and f.sent_followups >= least(3, s.max_followups) - 1 then 'reengagement'
               else 'followup'
             end as draft_kind
        from public.intel_prospects p
        join public.leads l on l.id = p.lead_id
        join lateral (
          select min(m.sent_at) filter (where m.kind = 'initial') as initial_sent_at,
                 max(m.sent_at) as last_sent_at
            from public.intel_messages m
           where m.prospect_id = p.id and m.direction = 'outbound'
             and m.kind in ('initial','followup') and m.state = 'sent'
        ) i on i.last_sent_at is not null
        cross join lateral (
          select count(*)::int as sent_followups
            from public.intel_messages f
           where f.prospect_id = p.id and f.kind = 'followup'
             and f.state not in ('discarded','failed')
        ) f
       where p.organization_id = v_org
         and p.status = 'contacted'
         and coalesce(p.review_reason, '') !~ '^(Individualized English draft|Draft is too similar|Draft blocked by outbound policy|Re-engagement held:)'
         and position('@' in public.intel_norm_email(l.email)) > 1
         and public.intel_norm_email(l.email) = public.intel_norm_email(p.contact_email)
         and case
           when p.type = 'indie_game_developer' then
             i.initial_sent_at is not null
             and f.sent_followups < least(4, s.max_followups)
             and case f.sent_followups
               when 0 then public.intel_business_days_between((i.initial_sent_at at time zone s.timezone)::date, v_today) >= 5
               when 1 then public.intel_business_days_between((i.initial_sent_at at time zone s.timezone)::date, v_today) >= 10
               when 2 then v_today >= (((i.initial_sent_at at time zone s.timezone)::date + interval '3 months')::date)
               when 3 then v_today >= (((i.initial_sent_at at time zone s.timezone)::date + interval '6 months')::date)
               else false
             end
           else
             public.intel_business_days_between(
               (greatest(i.last_sent_at, nullif(p.takeover ->> 'last_contact', '')::date::timestamp at time zone s.timezone) at time zone s.timezone)::date,
               v_today) >= s.followup_business_days
             and f.sent_followups < least(3, s.max_followups)
           end
         and not exists (
           select 1 from public.intel_messages f2
            where f2.prospect_id = p.id and f2.kind = 'followup'
              and f2.state in ('draft','pending_approval','approved','reserved','sending','unknown')
         )
         and not exists (
           select 1 from public.intel_messages r
            where r.prospect_id = p.id and r.direction = 'inbound'
         )
       order by case when p.type = 'indie_game_developer' then i.initial_sent_at else i.last_sent_at end
       limit greatest(1, least(coalesce(p_limit, 20), 100))
    ) x
  ), '[]'::jsonb);
end $$;

revoke all on function public.intel_agent_followup_candidates(int) from public, anon;
grant execute on function public.intel_agent_followup_candidates(int) to authenticated;

comment on function public.intel_agent_followup_candidates(int) is
  'Indie: day 5/day 10 follow-ups, month 3/month 6 evidence-gated re-engagement. Other campaigns preserve their three-slot cap and only use re-engagement when max_followups is at least two. Held drafts stay out of the daily candidate loop until review_reason is cleared. Any inbound reply interrupts cold follow-ups.';

notify pgrst, 'reload schema';
commit;
