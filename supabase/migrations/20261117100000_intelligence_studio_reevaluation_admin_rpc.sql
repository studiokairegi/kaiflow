-- Admin-facing controls for pre-outreach studio prospect reevaluation (rejected, review and qualified).
-- Keep worker RPCs and intel_agent_org() unchanged.
-- Every admin RPC resolves its organization through intel_admin_org(),
-- which enforces Admin AND active Master User authorization.

begin;

create or replace function public.intel_admin_reeval_start(p_name text, p_limit int default null, p_dry_run boolean default true, p_include_previous boolean default false, p_all boolean default false, p_expect_count int default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_admin_org(); v_run public.intel_reeval_runs; v_eligible int; v_noweb int; v_human int; v_total int; v_added int := 0; v_inserted int := 0; v_queued int := 0; v_name text; r record;
begin
  drop table if exists pg_temp._reeval_pool;
  create temporary table _reeval_pool (prospect_id uuid primary key, has_website boolean, created_at timestamptz) on commit drop;
  truncate pg_temp._reeval_pool;
  insert into pg_temp._reeval_pool
  select p.id, coalesce(p.website, '') <> '', p.created_at
    from public.intel_prospects p
   where p.organization_id = v_org and p.type = 'animation_studio_support' and p.origin = 'discovered' and p.status in ('rejected','needs_review','qualified','lead_linked')
     and ((p.lead_id is null and not exists (select 1 from public.leads l where l.intel_prospect_id=p.id))
       or (p.lead_id is not null and exists (select 1 from public.leads l where l.id=p.lead_id and l.intel_prospect_id=p.id)))
     and not exists (select 1 from public.intel_messages m where m.prospect_id = p.id)
     and not exists (select 1 from public.intel_lead_history h where h.prospect_id = p.id)
     and not exists (
       select 1 from public.intel_suppressions s
        where s.organization_id = v_org
          and (
            (s.kind = 'domain' and s.value in (
              coalesce(p.domain, ''),
              coalesce(public.intel_domain_of(coalesce(p.website, '')), '')
            ))
            or
            (s.kind = 'email' and (
              s.value = coalesce(public.intel_norm_email(p.contact_email), '')
              or (
                coalesce(public.intel_norm_email(p.contact_email), '') <> ''
                and coalesce(public.intel_norm_email(p.contact_email), '') like '%@' || s.value
              )
            ))
          )
     )
     and (coalesce(p_include_previous, false) or not exists (select 1 from public.intel_reeval_items i where i.prospect_id = p.id and i.state = 'scored'));
  select count(*) into v_total from public.intel_prospects p where p.organization_id = v_org and p.type = 'animation_studio_support' and p.origin = 'discovered' and p.status in ('rejected','needs_review','qualified','lead_linked');
  select count(*) into v_human from public.intel_prospects p
   where p.organization_id = v_org and p.type = 'animation_studio_support' and p.origin = 'discovered' and p.status in ('rejected','needs_review','qualified','lead_linked')
     and exists (select 1 from public.intel_actions a where a.organization_id = v_org and a.action = 'review_prospect_reject' and a.entity_type = 'prospect' and a.entity_id = p.id::text);
  -- A person's rejection is a decision, not a model result: those prospects are never selected.
  delete from pg_temp._reeval_pool where prospect_id in (select p.id from public.intel_prospects p join public.intel_actions a on a.entity_id = p.id::text and a.entity_type = 'prospect' and a.action = 'review_prospect_reject' and a.organization_id = v_org);
  select count(*), count(*) filter (where not has_website) into v_eligible, v_noweb from pg_temp._reeval_pool;
  if p_dry_run is distinct from false then
    return jsonb_build_object('dry_run', true, 'pre_outreach_discovered_studios', v_total, 'eligible', v_eligible, 'eligible_with_website', v_eligible - v_noweb,
                              'eligible_without_website', v_noweb, 'excluded_human_rejections', v_human);
  end if;
  if btrim(coalesce(p_name, '')) = '' then raise exception 'run name required'; end if;
  if length(btrim(p_name)) > 80 then raise exception 'run name must be 80 characters or fewer'; end if;
  v_name := btrim(p_name);

  if p_limit is not null and p_limit < 1 then
    raise exception 'p_limit must be a positive integer';
  end if;
  -- Pilot runs are deliberately bounded at the database boundary. Full-population
  -- runs must use the separate explicit p_all + p_expect_count confirmation path.
  if p_limit is not null and p_limit > 50 then
    raise exception 'pilot p_limit cannot exceed 50; use explicit full-population confirmation';
  end if;
  if p_limit is null then
    if p_all is distinct from true then
      raise exception 'full population requires explicit p_all confirmation';
    end if;
    if p_expect_count is null or p_expect_count <> v_eligible then
      raise exception 'eligible count changed; expected %, currently %', p_expect_count, v_eligible;
    end if;
  else
    if p_all is distinct from false or p_expect_count is not null then
      raise exception 'p_all and p_expect_count are only valid for a full-population start';
    end if;
  end if;

  select * into v_run from public.intel_reeval_runs where organization_id = v_org and name = v_name for update;
  if not found then
    insert into public.intel_reeval_runs(organization_id, name) values (v_org, v_name) returning * into v_run;
    perform public._intel_log(v_org, 'agent', 'reeval_run_started', 'reeval_run', v_run.id::text, jsonb_build_object('name', v_run.name, 'eligible', v_eligible));
  elsif v_run.state <> 'running' then
    raise exception 'run % is %', v_run.name, v_run.state;
  end if;
  for r in select pool.prospect_id from pg_temp._reeval_pool pool
            where not exists (select 1 from public.intel_reeval_items i where i.run_id = v_run.id and i.prospect_id = pool.prospect_id)
            order by pool.created_at, pool.prospect_id limit p_limit
  loop
    insert into public.intel_reeval_items(run_id, prospect_id, organization_id, prev_status, prev_score, prev_model)
    select v_run.id, p.id, v_org, p.status, p.score,
           coalesce((select x ->> 'model' from jsonb_array_elements(case when jsonb_typeof(p.score_breakdown) = 'array' then p.score_breakdown else '[]'::jsonb end) x where x ? 'model' limit 1),
                    p.facts -> 'estimates' ->> 'scoring_model', case when p.score is null then '' else 'studio-v1' end)
      from public.intel_prospects p where p.id = r.prospect_id
    on conflict do nothing;
    get diagnostics v_inserted = row_count;
    v_added := v_added + v_inserted;
  end loop;
  -- (Re)queue a job for every still-queued item. The idempotency key makes this a no-op for jobs that already exist, so a repeated call
  -- after a crash or a worker restart fills any gap and never duplicates work.
  for r in select prospect_id from public.intel_reeval_items where run_id = v_run.id and state = 'queued' loop
    insert into public.intel_jobs(organization_id, kind, payload, idempotency_key, priority)
    values (v_org, 'reeval_studio', jsonb_build_object('run_id', v_run.id, 'prospect_id', r.prospect_id), left('reeval-studio:' || v_run.id || ':' || r.prospect_id, 200), -5)
    on conflict (organization_id, idempotency_key) do update
       set state = 'queued', attempts = 0, run_after = now(), lease_until = null, locked_by = null, finished_at = null, updated_at = now()
     where public.intel_jobs.state in ('dead','failed');          -- a dead job must not strand its item; queued/running/succeeded jobs are left alone
    if found then v_queued := v_queued + 1; end if;
  end loop;
  perform public._intel_reeval_maybe_complete(v_run.id);
  return jsonb_build_object('dry_run', false, 'run_id', v_run.id, 'started_at', v_run.started_at, 'eligible', v_eligible, 'items_added', v_added, 'jobs_queued', v_queued);
end $$;

revoke all on function public.intel_admin_reeval_start(text, integer, boolean, boolean, boolean, integer) from public, anon;
grant execute on function public.intel_admin_reeval_start(text, integer, boolean, boolean, boolean, integer) to authenticated;


create or replace function public.intel_admin_reeval_status(p_run_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_admin_org(); v_run public.intel_reeval_runs;
begin
  select * into v_run from public.intel_reeval_runs where organization_id = v_org and (p_run_id is null or id = p_run_id) order by created_at desc limit 1;
  if not found then return jsonb_build_object('run', null); end if;
  return jsonb_build_object('run', jsonb_build_object('id', v_run.id, 'name', v_run.name, 'state', v_run.state, 'started_at', v_run.started_at, 'finished_at', v_run.finished_at),
    'by_state', coalesce((select jsonb_object_agg(s, n) from (select state s, count(*) n from public.intel_reeval_items where run_id = v_run.id group by state) q), '{}'::jsonb),
    'by_outcome', coalesce((select jsonb_object_agg(s, n) from (select state || ':' || outcome s, count(*) n from public.intel_reeval_items where run_id = v_run.id group by 1) q), '{}'::jsonb),
    'queued_items_without_live_job', (select count(*) from public.intel_reeval_items i where i.run_id = v_run.id and i.state = 'queued'
        and not exists (select 1 from public.intel_jobs j where j.organization_id = v_org and j.kind = 'reeval_studio' and j.state in ('queued','running') and j.payload ->> 'prospect_id' = i.prospect_id::text and j.payload ->> 'run_id' = v_run.id::text)),
    'by_new_decision', coalesce((select jsonb_object_agg(s, n) from (select coalesce(new_decision, 'none') s, count(*) n from public.intel_reeval_items where run_id = v_run.id and state = 'scored' group by 1) q), '{}'::jsonb));
end $$;

revoke all on function public.intel_admin_reeval_status(uuid) from public, anon;
grant execute on function public.intel_admin_reeval_status(uuid) to authenticated;


create or replace function public.intel_admin_reeval_cancel(p_run_id uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_admin_org(); n int;
begin
  update public.intel_reeval_runs set state = 'cancelled', finished_at = now() where id = p_run_id and organization_id = v_org and state = 'running';
  if not found then return jsonb_build_object('cancelled', false); end if;
  update public.intel_jobs set state = 'cancelled', finished_at = now(), updated_at = now(), lease_until = null, locked_by = null
   where organization_id = v_org and kind = 'reeval_studio' and state = 'queued' and payload ->> 'run_id' = p_run_id::text;
  get diagnostics n = row_count;
  perform public._intel_log(v_org, 'agent', 'reeval_run_cancelled', 'reeval_run', p_run_id::text, jsonb_build_object('jobs_cancelled', n));
  return jsonb_build_object('cancelled', true, 'jobs_cancelled', n);
end $$;

revoke all on function public.intel_admin_reeval_cancel(uuid) from public, anon;
grant execute on function public.intel_admin_reeval_cancel(uuid) to authenticated;

commit;
