-- Indie Game Developers V2 / Phase 4 corrective fixes.
-- 1) Excluding Kickstarter cancels queued/running manual intake jobs.
-- 2) Worker import is transactionally gated against source exclusion.
-- 3) Kickstarter's unverified attribution cannot downgrade verified identity facts.
begin;

-- Preserve the existing admin source controls while making exclusion an immediate
-- queue action. Running workers are also cancelled; the transactional commit RPC
-- below prevents a worker that has not committed yet from importing after exclusion.
create or replace function public.intel_admin_update_source(
  p_key text, p_enabled boolean default null, p_tos_status text default null, p_daily_budget int default null
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.intel_admin_org();
  s public.intel_sources;
  v_excluded boolean := false;
  v_cancelled integer := 0;
begin
  select * into s from public.intel_sources
   where organization_id = v_org and key = p_key for update;
  if not found then raise exception 'unknown source'; end if;
  if p_key = 'kickstarter' and coalesce(p_enabled, s.enabled) is true then
    raise exception 'automated Kickstarter discovery is unavailable; use manual project intake until written permission and an authorized connector exist';
  end if;
  if p_tos_status is not null and p_tos_status not in ('confirmed','unverified','excluded') then
    raise exception 'bad terms status';
  end if;
  if coalesce(p_tos_status, s.tos_status) <> 'confirmed' and coalesce(p_enabled, s.enabled) then
    raise exception 'Confirm the source''s terms before enabling it';
  end if;

  update public.intel_sources set
    enabled = coalesce(p_enabled, enabled),
    tos_status = coalesce(p_tos_status, tos_status),
    daily_budget = coalesce(p_daily_budget, daily_budget),
    consecutive_failures = case when p_enabled is true then 0 else consecutive_failures end,
    circuit_open_until = case when p_enabled is true then null else circuit_open_until end,
    updated_at = now()
  where organization_id = v_org and key = p_key
  returning * into s;

  v_excluded := p_key = 'kickstarter' and s.tos_status = 'excluded';
  if v_excluded then
    update public.intel_jobs j
       set state = 'cancelled', finished_at = now(), updated_at = now(),
           lease_until = null, locked_by = null,
           last_error = 'Cancelled: Kickstarter intake excluded by administrator'
     where j.organization_id = v_org
       and j.kind = 'manual_post'
       and j.state in ('queued','running')
       and exists (
         select 1 from public.intel_source_items i
          where i.organization_id = v_org
            and i.id::text = j.payload ->> 'item_id'
            and i.source_key = 'kickstarter_manual'
       );
    get diagnostics v_cancelled = row_count;
    update public.intel_source_items i
       set meta = coalesce(i.meta, '{}'::jsonb) || jsonb_build_object(
         'intake_status', 'blocked_source_excluded',
         'intake_blocked_at', now()
       ), last_seen = now()
     where i.organization_id = v_org
       and i.source_key = 'kickstarter_manual'
       and exists (
         select 1 from public.intel_jobs j
          where j.organization_id = v_org
            and j.kind = 'manual_post'
            and j.state = 'cancelled'
            and j.payload ->> 'item_id' = i.id::text
            and j.last_error = 'Cancelled: Kickstarter intake excluded by administrator'
       );
  end if;

  perform public._intel_log(v_org, 'admin', 'update_source', 'source', p_key,
    jsonb_build_object('enabled', p_enabled, 'tos', p_tos_status, 'budget', p_daily_budget,
                       'kickstarter_jobs_cancelled', v_cancelled));
  return to_jsonb(s) || jsonb_build_object('cancelled_jobs', v_cancelled);
end $$;

-- Worker preflight also prevents even protected-item bookkeeping from running
-- after the source is excluded. The commit RPC below repeats this check atomically.
create or replace function public.intel_agent_kickstarter_intake_allowed() returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select exists (
    select 1 from public.intel_sources
     where organization_id = public.intel_agent_org()
       and key = 'kickstarter'
       and tos_status <> 'excluded'
  )
$$;
revoke all on function public.intel_agent_kickstarter_intake_allowed() from public, anon, authenticated;
grant execute on function public.intel_agent_kickstarter_intake_allowed() to service_role;

-- Atomic import boundary. The shared lock serializes the complete import against
-- intel_admin_update_source(), which takes an update lock on the same source row.
-- Kickstarter stays disabled for automated discovery; manual imports are permitted
-- unless the administrator explicitly marks the source excluded.
create or replace function public.intel_agent_kickstarter_commit_import(
  p_item_id uuid,
  p_name text,
  p_website text,
  p_verified jsonb,
  p_title text,
  p_notes text default ''
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.intel_agent_org();
  v_source public.intel_sources;
  v_item public.intel_source_items;
  v_existing_verified jsonb := '{}'::jsonb;
  v_preserve jsonb := '{}'::jsonb;
  v_key text;
  v_status text;
  v_upsert jsonb;
  v_pid uuid;
begin
  select * into v_source
    from public.intel_sources
   where organization_id = v_org and key = 'kickstarter'
   for share;
  if not found or v_source.tos_status = 'excluded' then
    return jsonb_build_object('blocked', true, 'reason', 'source_excluded_or_unconfigured');
  end if;

  select * into v_item
    from public.intel_source_items
   where id = p_item_id and organization_id = v_org
   for update;
  if not found or v_item.source_key <> 'kickstarter_manual' or v_item.item_type <> 'game_project' then
    raise exception 'valid Kickstarter manual project item not found';
  end if;

  -- The canonical project key matches intel_agent_upsert_prospect() for this
  -- project identity, allowing us to snapshot existing verification before merge.
  if nullif(btrim(coalesce(p_title, '')), '') is not null then
    v_key := 'project:' || md5(
      lower(regexp_replace(btrim(p_name), '\s+', ' ', 'g')) || '|' ||
      lower(regexp_replace(btrim(p_title), '\s+', ' ', 'g'))
    );
    select coalesce(facts -> 'verified', '{}'::jsonb)
      into v_existing_verified
      from public.intel_prospects
     where organization_id = v_org and canonical_key = v_key
     for update;
  end if;

  v_status := lower(coalesce(v_existing_verified ->> 'developer_identity_status', ''));
  if v_status in ('independently_verified','human_confirmed','verified') then
    v_preserve := v_preserve || jsonb_strip_nulls(jsonb_build_object(
      'developer_name', v_existing_verified -> 'developer_name',
      'developer_identity_status', v_existing_verified -> 'developer_identity_status',
      'developer_attribution_source', v_existing_verified -> 'developer_attribution_source'
    ));
  end if;
  if lower(coalesce(v_existing_verified ->> 'kickstarter_creator_role_verified', 'false')) = 'true'
     and nullif(btrim(coalesce(v_existing_verified ->> 'kickstarter_creator_role', '')), '') is not null then
    v_preserve := v_preserve || jsonb_strip_nulls(jsonb_build_object(
      'kickstarter_creator_role', v_existing_verified -> 'kickstarter_creator_role',
      'kickstarter_creator_role_verified', v_existing_verified -> 'kickstarter_creator_role_verified'
    ));
  end if;

  v_upsert := public.intel_agent_upsert_prospect(
    'indie_game_developer', p_name, coalesce(p_website, ''), '', '', '', '', 'other', coalesce(p_verified, '{}'::jsonb)
  );
  v_pid := (v_upsert ->> 'prospect_id')::uuid;

  -- Restore independently verified identity/role facts over the unverified
  -- Kickstarter submission. Other project-specific evidence is still merged.
  if v_preserve <> '{}'::jsonb then
    update public.intel_prospects
       set facts = jsonb_set(
         coalesce(facts, '{}'::jsonb), '{verified}',
         coalesce(facts -> 'verified', '{}'::jsonb) || v_preserve, true
       ), updated_at = now()
     where id = v_pid and organization_id = v_org;
  end if;

  perform public.intel_agent_record_item(
    'kickstarter_manual', 'game_project', v_item.url, p_title, coalesce(p_notes, ''), '', v_pid,
    coalesce(p_verified, '{}'::jsonb) || jsonb_build_object('intake_status', 'imported')
  );

  return coalesce(v_upsert, '{}'::jsonb) || jsonb_build_object('blocked', false);
end $$;

revoke all on function public.intel_agent_kickstarter_commit_import(uuid,text,text,jsonb,text,text) from public, anon, authenticated;
grant execute on function public.intel_agent_kickstarter_commit_import(uuid,text,text,jsonb,text,text) to service_role;

commit;
