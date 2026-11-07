-- Phase 2 (round 3): evidence traceability on the message row, and recipient names for name-swap detection.
-- Forward-only; earlier migrations are not edited.
--  1. intel_messages.evidence_trace: the evidence snippets a model-written draft was grounded on (write-once, set by the worker).
--  2. intel_agent_set_message_evidence: the worker's only way to set it.
--  3. intel_agent_context: evidence rows now carry their database id, so the ids the model cites are stable ids, not content hashes.
--  4. intel_agent_recent_outbound: also returns the recipient prospect's name and contact name (and keeps idempotency_key), so
--     the duplicate check can mask each message's own recipient names ("2K Games", "id Software") when comparing.
begin;

alter table public.intel_messages add column if not exists evidence_trace jsonb;

create or replace function public.intel_agent_set_message_evidence(p_message_id uuid, p_evidence jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org uuid := public.intel_agent_org();
  v_n int;
begin
  if p_evidence is null or jsonb_typeof(p_evidence) <> 'array' or jsonb_array_length(p_evidence) > 30 then
    return public._intel_deny('bad_evidence');
  end if;
  update public.intel_messages
     set evidence_trace = p_evidence
   where id = p_message_id
     and organization_id = v_org
     and direction = 'outbound'
     and evidence_trace is null;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'stored', v_n = 1);
end;
$$;

revoke all on function public.intel_agent_set_message_evidence(uuid, jsonb) from public, anon;
grant execute on function public.intel_agent_set_message_evidence(uuid, jsonb) to authenticated;

-- (3) context: unchanged except that each evidence row now includes its id.
create or replace function public.intel_agent_context(p_prospect_id uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org();
begin
  return (select jsonb_build_object(
      'prospect', to_jsonb(p),
      'evidence', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'source', e.source, 'url', e.url, 'fact_type', e.fact_type, 'snippet', e.snippet, 'verified', e.verified) order by e.fetched_at) from public.intel_evidence e where e.prospect_id = p.id), '[]'::jsonb),
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

revoke all on function public.intel_agent_context(uuid) from public, anon;
grant execute on function public.intel_agent_context(uuid) to authenticated;

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
        select m.id, m.prospect_id, m.kind, m.state, m.subject, m.body_text, m.idempotency_key, m.created_at,
               p.name as prospect_name, p.contact_name
          from public.intel_messages m
          left join public.intel_prospects p on p.id = m.prospect_id
         where m.organization_id = v_org
           and m.direction = 'outbound'
           and m.state in ('draft','pending_approval','approved','reserved','sending','sent','unknown')
           and m.created_at >= now() - interval '180 days'
         order by m.created_at desc
         limit v_limit
      ) x
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.intel_agent_recent_outbound(int) from public, anon;
grant execute on function public.intel_agent_recent_outbound(int) to authenticated;

commit;
