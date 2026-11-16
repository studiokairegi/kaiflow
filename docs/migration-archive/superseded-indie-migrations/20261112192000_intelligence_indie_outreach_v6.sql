-- Indie Game Developers V2 / Session 6.
-- Extends the existing approval-first sequence to two timed follow-ups and two evidence-gated re-engagements.
-- Existing organization limits are preserved; admins must deliberately raise max_followups to 4 to use all stages.
begin;

alter table public.intel_settings alter column max_followups set default 4;
alter table public.intel_settings drop constraint if exists intel_settings_max_followups_check;
alter table public.intel_settings add constraint intel_settings_max_followups_check check (max_followups between 0 and 4);

create or replace function public.intel_agent_followup_candidates(p_limit int default 20) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.intel_agent_org();
  s public.intel_settings;
  v_today date;
begin
  select * into s from public.intel_settings where organization_id = v_org;
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
               when not exists (select 1 from public.intel_lead_history h where h.prospect_id = p.id)
                and f.sent_followups >= greatest(0, s.max_followups - 1) then 'reengagement'
               else 'followup'
             end as draft_kind
        from public.intel_prospects p
        join public.leads l on l.id = p.lead_id
        join lateral (
          select min(m.sent_at) filter (where m.kind = 'initial') as initial_sent_at,
                 max(m.sent_at) as last_sent_at
            from public.intel_messages m
           where m.prospect_id = p.id
             and m.direction = 'outbound'
             and m.kind in ('initial','followup')
             and m.state = 'sent'
        ) i on i.last_sent_at is not null
        cross join lateral (
          select count(*)::int as sent_followups
            from public.intel_messages f
           where f.prospect_id = p.id and f.kind = 'followup'
             and f.state not in ('discarded','failed')
        ) f
       where p.organization_id = v_org
         and p.status = 'contacted'
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
       limit greatest(1, least(p_limit, 100))
    ) x
  ), '[]'::jsonb);
end $$;

revoke all on function public.intel_agent_followup_candidates(int) from public, anon;
grant execute on function public.intel_agent_followup_candidates(int) to authenticated;

comment on function public.intel_agent_followup_candidates(int) is
  'Indie sequence: business day 5 and 10 follow-ups, then month 3 and month 6 re-engagement. Any inbound reply interrupts the sequence. The worker additionally requires new verified dated project evidence before either re-engagement. Other campaign types retain their configured business-day sequence.';

notify pgrst, 'reload schema';
commit;
