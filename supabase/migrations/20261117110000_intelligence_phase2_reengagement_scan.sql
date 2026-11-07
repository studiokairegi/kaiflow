-- Phase 2: schedule individualized re-engagement as the final configured follow-up slot.
-- The persisted intel_messages.kind contract remains initial/followup/reply; re-engagement
-- is a composition mode, stored as the final followup so all existing send gates and caps apply.
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
             i.sent_at,
             exists (select 1 from public.intel_lead_history h where h.prospect_id = p.id) as takeover,
             case
               when not exists (select 1 from public.intel_lead_history h where h.prospect_id = p.id)
                and (select count(*) from public.intel_messages f
                     where f.prospect_id = p.id and f.kind = 'followup'
                       and f.state not in ('discarded','failed')) >= greatest(0, s.max_followups - 1)
               then 'reengagement'
               else 'followup'
             end as draft_kind
        from public.intel_prospects p
        join public.leads l on l.id = p.lead_id
        join lateral (
          select max(m.sent_at) as sent_at
            from public.intel_messages m
           where m.prospect_id = p.id
             and m.direction = 'outbound'
             and m.kind in ('initial','followup')
             and m.state = 'sent'
        ) i on i.sent_at is not null
       where p.organization_id = v_org
         and p.status = 'contacted'
         and position('@' in public.intel_norm_email(l.email)) > 1
         and public.intel_norm_email(l.email) = public.intel_norm_email(p.contact_email)
         and public.intel_business_days_between(
               (greatest(i.sent_at, nullif(p.takeover ->> 'last_contact', '')::date::timestamp at time zone s.timezone) at time zone s.timezone)::date,
               v_today) >= s.followup_business_days
         and (select count(*) from public.intel_messages f
              where f.prospect_id = p.id and f.kind = 'followup'
                and f.state not in ('discarded','failed')) < s.max_followups
         and not exists (
           select 1 from public.intel_messages f
            where f.prospect_id = p.id and f.kind = 'followup'
              and f.state in ('draft','pending_approval','approved','reserved','sending','unknown')
         )
         and not exists (
           select 1 from public.intel_messages r
            where r.prospect_id = p.id and r.direction = 'inbound'
         )
       order by i.sent_at
       limit greatest(1, least(p_limit, 100))
    ) x
  ), '[]'::jsonb);
end $$;

revoke all on function public.intel_agent_followup_candidates(int) from public, anon;
grant execute on function public.intel_agent_followup_candidates(int) to authenticated;

comment on function public.intel_agent_followup_candidates(int) is
  'Returns due follow-up candidates and draft_kind. The final configured follow-up slot is composed as re-engagement while persisted as kind=followup to preserve the existing message and safety contracts.';
