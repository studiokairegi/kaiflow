-- Phase 6: preserve scoring history and make CRM/takeover provenance explicit.
-- Additive and fail-closed. Review and apply separately; never applied automatically.
begin;

alter table public.intel_prospects
  add column if not exists score_model text not null default 'legacy-unknown',
  add column if not exists origin_detail jsonb not null default '{}'::jsonb,
  add column if not exists takeover_actor uuid,
  add column if not exists takeover_at timestamptz;

-- Backfill model identity from evidence already stored with the score. Unknown is explicit;
-- do not infer a model from the score value alone.
update public.intel_prospects p
   set score_model = coalesce(
     (select x ->> 'model' from jsonb_array_elements(case when jsonb_typeof(p.score_breakdown) = 'array' then p.score_breakdown else '[]'::jsonb end) x where x ? 'model' limit 1),
     p.facts -> 'estimates' ->> 'scoring_model',
     case when p.score is null then 'unscored' else 'legacy-unknown' end
   )
 where p.score_model = 'legacy-unknown';

update public.intel_prospects p
   set origin_detail = case
     when origin = 'discovered' then jsonb_build_object('kind','discovered','recorded_at',created_at)
     when origin = 'crm_existing' and exists (select 1 from public.intel_lead_history h where h.prospect_id=p.id) then jsonb_build_object('kind','taken_over','recorded_at',created_at)
     when origin = 'crm_existing' then jsonb_build_object('kind','manual','recorded_at',created_at)
     else jsonb_build_object('kind','unknown','recorded_at',created_at)
   end
 where origin_detail = '{}'::jsonb;

update public.intel_prospects p
   set takeover_actor = (select h.created_by from public.intel_lead_history h where h.prospect_id=p.id order by h.created_at desc limit 1),
       takeover_at = (select h.created_at from public.intel_lead_history h where h.prospect_id=p.id order by h.created_at desc limit 1),
       origin_detail = coalesce(p.origin_detail,'{}'::jsonb) || jsonb_build_object(
         'kind','taken_over',
         'history_id',(select h.id from public.intel_lead_history h where h.prospect_id=p.id order by h.created_at desc limit 1),
         'actor_id',(select h.created_by from public.intel_lead_history h where h.prospect_id=p.id order by h.created_at desc limit 1),
         'taken_over_at',(select h.created_at from public.intel_lead_history h where h.prospect_id=p.id order by h.created_at desc limit 1))
 where p.origin='crm_existing' and p.takeover_actor is null
   and exists (select 1 from public.intel_lead_history h where h.prospect_id=p.id);

create table if not exists public.intel_score_history (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  prospect_id uuid not null references public.intel_prospects(id) on delete cascade,
  prior_status text not null,
  prior_score integer,
  prior_model text not null,
  prior_breakdown jsonb not null default '{}'::jsonb,
  prior_review_reason text not null default '',
  evidence_snapshot jsonb not null default '[]'::jsonb,
  change_source text not null default 'score_update',
  actor_user_id uuid,
  recorded_at timestamptz not null default now()
);
create index if not exists intel_score_history_prospect_idx on public.intel_score_history(organization_id, prospect_id, recorded_at desc);
alter table public.intel_score_history enable row level security;
revoke all on public.intel_score_history from public, anon, authenticated;
grant select on public.intel_score_history to authenticated;
drop policy if exists intel_select on public.intel_score_history;
create policy intel_select on public.intel_score_history for select to authenticated using (public.intel_is_authorized(organization_id));

-- One-time snapshot of the current score and its supporting evidence. This is the earliest
-- recoverable historical point; the system does not claim to reconstruct evidence that was never stored.
insert into public.intel_score_history(organization_id, prospect_id, prior_status, prior_score, prior_model, prior_breakdown, prior_review_reason, evidence_snapshot, change_source, recorded_at)
select p.organization_id, p.id, p.status, p.score, p.score_model, coalesce(p.score_breakdown,'{}'::jsonb), coalesce(p.review_reason,''),
       coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'source',e.source,'url',e.url,'fact_type',e.fact_type,'snippet',e.snippet,'verified',e.verified,'fetched_at',e.fetched_at) order by e.fetched_at)
                   from (select * from public.intel_evidence e where e.prospect_id=p.id order by e.fetched_at desc limit 100) e), '[]'::jsonb),
       'phase6_baseline', coalesce(p.updated_at,p.created_at,now())
  from public.intel_prospects p
 where p.score is not null
   and not exists (select 1 from public.intel_score_history h where h.prospect_id=p.id);

create or replace function public._intel_phase6_capture_score_history() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_model text;
begin
  if new.score is distinct from old.score or new.score_breakdown is distinct from old.score_breakdown then
    v_model := coalesce(
      (select x ->> 'model' from jsonb_array_elements(case when jsonb_typeof(new.score_breakdown)='array' then new.score_breakdown else '[]'::jsonb end) x where x ? 'model' limit 1),
      new.facts -> 'estimates' ->> 'scoring_model',
      'legacy-unknown'
    );
    new.score_model := v_model;
    insert into public.intel_score_history(organization_id, prospect_id, prior_status, prior_score, prior_model, prior_breakdown, prior_review_reason, evidence_snapshot, change_source, actor_user_id)
    select old.organization_id, old.id, old.status, old.score, coalesce(old.score_model,'legacy-unknown'), coalesce(old.score_breakdown,'{}'::jsonb), coalesce(old.review_reason,''),
           coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'source',e.source,'url',e.url,'fact_type',e.fact_type,'snippet',e.snippet,'verified',e.verified,'fetched_at',e.fetched_at) order by e.fetched_at)
                       from (select * from public.intel_evidence e where e.prospect_id=old.id order by e.fetched_at desc limit 100) e), '[]'::jsonb),
           case when coalesce(new.facts -> 'estimates' ->> 'reeval_run','') <> '' then 'reevaluation' else 'score_update' end,
           auth.uid();
  end if;
  return new;
end $$;
drop trigger if exists intel_phase6_score_history on public.intel_prospects;
create trigger intel_phase6_score_history before update of score, score_breakdown on public.intel_prospects
for each row execute function public._intel_phase6_capture_score_history();
revoke all on function public._intel_phase6_capture_score_history() from public, anon, authenticated;

-- Record the source and the human who initiated a takeover. Existing pasted-history rows
-- retain created_by/created_at; these prospect-level fields make the current takeover state filterable.
create or replace function public._intel_phase6_capture_origin() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_history public.intel_lead_history; v_old_history text := '';
begin
  if tg_op = 'INSERT' then
    if new.origin_detail = '{}'::jsonb then
      new.origin_detail := jsonb_build_object('kind', case when new.origin='discovered' then 'discovered' when new.origin='crm_existing' then 'manual' else 'unknown' end, 'recorded_at', now());
    end if;
  elsif new.origin is distinct from old.origin then
    new.origin_detail := coalesce(old.origin_detail,'{}'::jsonb) || jsonb_build_object('kind', case when new.origin='discovered' then 'discovered' when new.origin='crm_existing' then 'manual' else 'unknown' end, 'recorded_at', now());
  end if;
  if tg_op <> 'INSERT' then v_old_history := coalesce(old.takeover ->> 'history_id',''); end if;
  if new.origin='crm_existing' and coalesce(new.takeover ->> 'history_id','') <> '' and
     v_old_history is distinct from new.takeover ->> 'history_id' then
    begin
      select * into v_history from public.intel_lead_history where id=(new.takeover ->> 'history_id')::uuid and organization_id=new.organization_id;
      if not found then raise exception 'takeover history record not found'; end if;
      new.takeover_actor := coalesce(auth.uid(),v_history.created_by);
      new.takeover_at := coalesce(v_history.created_at,now());
      new.origin_detail := coalesce(new.origin_detail,'{}'::jsonb) || jsonb_build_object('kind','taken_over','history_id',v_history.id,'actor_id',new.takeover_actor,'taken_over_at',new.takeover_at);
    exception when invalid_text_representation then
      raise exception 'invalid takeover history id';
    end;
  elsif new.origin='crm_existing' and coalesce(new.takeover ->> 'history_id','') = '' and v_old_history <> '' then
    new.takeover_actor := null;
    new.takeover_at := null;
    new.origin_detail := coalesce(new.origin_detail,'{}'::jsonb) || jsonb_build_object('kind','manual','history_id',null,'actor_id',null,'taken_over_at',null);
  end if;
  return new;
end $$;
drop trigger if exists intel_phase6_origin_capture on public.intel_prospects;
create trigger intel_phase6_origin_capture before insert or update of origin, takeover on public.intel_prospects
for each row execute function public._intel_phase6_capture_origin();
revoke all on function public._intel_phase6_capture_origin() from public, anon, authenticated;

-- Prevent two Intelligence prospect records from independently owning the same CRM lead, or one prospect
-- from being attached to multiple CRM leads. Fail rather than silently merge pre-existing conflicts.
do $$ begin
  if exists (select 1 from public.intel_prospects where lead_id is not null group by organization_id,lead_id having count(*)>1) then
    raise exception 'Phase 6 blocked: duplicate intel_prospects lead_id ownership exists; reconcile manually before applying';
  end if;
  if exists (select 1 from public.leads where intel_prospect_id is not null group by intel_prospect_id having count(*)>1) then
    raise exception 'Phase 6 blocked: one prospect is linked to multiple CRM leads; reconcile manually before applying';
  end if;
end $$;
create unique index if not exists intel_prospects_one_per_lead_uidx on public.intel_prospects(organization_id,lead_id) where lead_id is not null;
create unique index if not exists leads_one_per_intel_prospect_uidx on public.leads(intel_prospect_id) where intel_prospect_id is not null;

-- Admin-only inventory of taken-over leads, separate from ordinary discovered prospects.
create or replace function public.intel_admin_crm_taken_over(p_limit integer default 200) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_admin_org(); v_limit integer := least(500,greatest(1,coalesce(p_limit,200)));
begin
  return jsonb_build_object('items',coalesce((
    select jsonb_agg(jsonb_build_object('prospect_id',p.id,'lead_id',p.lead_id,'name',p.name,'type',p.type,'status',p.status,'takeover',p.takeover,
      'takeover_actor',p.takeover_actor,'takeover_at',p.takeover_at,'origin_detail',p.origin_detail,'history_count',(select count(*) from public.intel_lead_history h where h.prospect_id=p.id)) order by p.takeover_at desc nulls last)
      from (select * from public.intel_prospects where organization_id=v_org and origin='crm_existing' and origin_detail->>'kind'='taken_over' order by takeover_at desc nulls last limit v_limit) p
  ),'[]'::jsonb));
end $$;
revoke all on function public.intel_admin_crm_taken_over(integer) from public, anon;
grant execute on function public.intel_admin_crm_taken_over(integer) to authenticated;


-- Snapshot report for the administrator: current classifications by model/status, historical score versions,
-- and prospect origin. This is an inventory only; it does not alter any prospect or CRM row.
create or replace function public.intel_admin_phase6_score_audit() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_admin_org();
begin
  return jsonb_build_object(
    'current_by_status_model', coalesce((select jsonb_agg(jsonb_build_object('status',q.status,'model',q.model,'count',q.n) order by q.status,q.model)
      from (select status,score_model model,count(*) n from public.intel_prospects where organization_id=v_org group by status,score_model) q),'[]'::jsonb),
    'history_by_model', coalesce((select jsonb_agg(jsonb_build_object('model',q.model,'count',q.n) order by q.model)
      from (select prior_model model,count(*) n from public.intel_score_history where organization_id=v_org group by prior_model) q),'[]'::jsonb),
    'origin_counts', coalesce((select jsonb_agg(jsonb_build_object('origin',q.origin,'kind',q.kind,'count',q.n) order by q.origin,q.kind)
      from (select origin,coalesce(origin_detail->>'kind','unknown') kind,count(*) n from public.intel_prospects where organization_id=v_org group by origin,coalesce(origin_detail->>'kind','unknown')) q),'[]'::jsonb),
    'pre_outreach_studio_candidates', (select count(*) from public.intel_prospects p where p.organization_id=v_org and p.type='animation_studio_support' and p.origin='discovered'
      and p.status in ('rejected','needs_review','qualified','lead_linked')
      and not exists(select 1 from public.intel_messages m where m.prospect_id=p.id)
      and not exists(select 1 from public.intel_lead_history h where h.prospect_id=p.id)),
    'score_history_rows', (select count(*) from public.intel_score_history where organization_id=v_org)
  );
end $$;
revoke all on function public.intel_admin_phase6_score_audit() from public, anon;
grant execute on function public.intel_admin_phase6_score_audit() to authenticated;

commit;
