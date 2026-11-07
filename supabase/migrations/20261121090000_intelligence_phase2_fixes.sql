-- Phase 2 fixes (forward-only; earlier migrations are not edited).
--  1. intel_agent_recent_outbound also returns idempotency_key, so the worker can leave a draft's own earlier copy
--     out of the duplicate check when a job is retried.
--  2. intel_agent_followup_candidates:
--     - re-engagement is only chosen for the LAST follow-up slot when more than one follow-up is configured.
--       With max_followups = 1 (the default) the single follow-up is a normal follow-up.
--     - prospects the worker already flagged for manual review (draft needs a person) are not offered again, so
--       they are not re-drafted every day and cannot fill the candidate window ahead of newer prospects.
--       Clearing review_reason on the prospect makes it a candidate again.
begin;

create or replace function public.intel_agent_recent_outbound(p_limit int default 500)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org uuid := public.intel_agent_org();
  v_limit int := greatest(1, least(coalesce(p_limit, 500), 500));
begin
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.created_at desc)
      from (
        select id, prospect_id, kind, state, subject, body_text, idempotency_key, created_at
          from public.intel_messages
         where organization_id = v_org
           and direction = 'outbound'
           and state in ('draft','pending_approval','approved','reserved','sending','sent','unknown')
           and created_at >= now() - interval '180 days'
         order by created_at desc
         limit v_limit
      ) x
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.intel_agent_recent_outbound(int) from public, anon;
grant execute on function public.intel_agent_recent_outbound(int) to authenticated;

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
               when s.max_followups >= 2
                and not exists (select 1 from public.intel_lead_history h where h.prospect_id = p.id)
                and (select count(*) from public.intel_messages f
                     where f.prospect_id = p.id and f.kind = 'followup'
                       and f.state not in ('discarded','failed')) >= s.max_followups - 1
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
         and p.review_reason !~ '^(Individualized English draft|Draft is too similar|Draft blocked by outbound policy)'
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

commit;
