-- =========================================================================
-- Project pipeline redesign, phase 5: explicit legacy -> canonical
-- migration workflow (design report v2 §10.2, §3.6)
-- =========================================================================
-- Requires migration_project_pipeline_phase2.sql to already be running in
-- production (pipeline_stages, project_stages, set_project_pipeline, the
-- seeding trigger, and the composite FK all need to exist first).
--
-- This file adds the ONLY way a legacy project's pipeline can become a
-- canonical one. There is still no automatic stage mapping anywhere in
-- this file: migrate_project_pipeline() requires the caller (the
-- ProjectEditor "Move to the new pipeline..." dialog) to supply an
-- explicit mapping for every legacy stage that currently holds a cut, and
-- refuses to run without one for each of them. Cuts already at Delivered
-- are never touched or included in the mapping.
--
-- Idempotent, like the phase-2 file.

-- =========================================================================
-- 1. Audit table (design report v2 §3.6). One row per migration attempt;
--    holds enough of the pre-migration state to support undo.
-- =========================================================================

create table if not exists project_pipeline_migrations (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references projects(id) on delete cascade,
  user_id        uuid not null references auth.users(id) on delete cascade,
  from_preset    text not null,
  to_preset      text not null,
  old_stages     jsonb not null,   -- full copy of the replaced project_stages rows
  shot_moves     jsonb not null,   -- [{shot_id, from_key, to_key}, ...]
  before_percent int,
  after_percent  int,
  created_at     timestamptz not null default now(),
  undone_at      timestamptz
);

alter table project_pipeline_migrations enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'project_pipeline_migrations' and policyname = 'Users read their own pipeline migrations'
  ) then
    create policy "Users read their own pipeline migrations"
      on project_pipeline_migrations for select
      using (auth.uid() = user_id);
  end if;
end $$;
-- No insert/update/delete policy: only the two functions below (both
-- SECURITY DEFINER) ever write to this table.

create index if not exists project_pipeline_migrations_project_id_idx
  on project_pipeline_migrations(project_id);

-- =========================================================================
-- 2. Internal helper: a project's completion percent, computed the exact
--    same way pipeline.js's cutProgress/projectProgress compute it
--    (design report v2 §6.2, §6.3), so before/after numbers shown in the
--    migration dialog always agree with what the rest of the app shows.
--    NOT exposed to clients directly - it takes no ownership check, so it
--    is only ever called from within the two SECURITY DEFINER functions
--    below, which already verified the caller owns the project.
-- =========================================================================

create or replace function public._project_completion_percent(p_project_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int;
  v_sum numeric := 0;
  v_counted int := 0;
  r record;
  v_stored_order int;
  v_passed int;
begin
  select count(*) into v_n from project_stages
    where project_id = p_project_id and is_enabled = true and library_stage_id <> 'delivered';
  if v_n = 0 then
    return null; -- "No pipeline configured" (design report v2 §13)
  end if;

  for r in select s.stage as stage_key from shots s where s.project_id = p_project_id
  loop
    if r.stage_key = 'delivered' then
      v_sum := v_sum + 100;
      v_counted := v_counted + 1;
      continue;
    end if;

    select sort_order into v_stored_order
      from project_stages where project_id = p_project_id and stage_key = r.stage_key;
    if v_stored_order is null then
      continue; -- unrecognized stage key: excluded, same as pipeline.js
    end if;

    select count(*) into v_passed from project_stages
      where project_id = p_project_id and is_enabled = true and library_stage_id <> 'delivered'
        and sort_order < v_stored_order;

    v_sum := v_sum + round((least(v_passed, v_n - 1)::numeric / v_n) * 100);
    v_counted := v_counted + 1;
  end loop;

  if v_counted = 0 then
    return null; -- "No shots yet" / all-unrecognized (design report v2 §13)
  end if;
  return round(v_sum / v_counted);
end;
$$;

revoke all on function public._project_completion_percent(uuid) from public;

-- =========================================================================
-- 3. migrate_project_pipeline (design report v2 §10.2)
-- =========================================================================
-- p_mapping is a JSON object of { "<legacy stage_key>": "<canonical
-- stage_key>" }. Required to include EVERY legacy stage that currently
-- holds at least one non-Delivered shot in this project - nothing else.
-- Everything below is one transaction: either the whole swap (old
-- project_stages replaced, matching shots moved, preset flipped, audit
-- row written) happens, or none of it does.

create or replace function public.migrate_project_pipeline(
  p_project_id uuid,
  p_target_preset text,        -- 'full' or 'custom'
  p_target_keys text[],        -- required (non-empty) when p_target_preset = 'custom'
  p_mapping jsonb              -- {legacy_stage_key: canonical_stage_key, ...}
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_preset text;
  v_occupied text[];
  v_missing text[];
  v_valid_targets text[];
  v_old_stages jsonb;
  v_shot_moves jsonb;
  v_before int;
  v_after int;
  v_migration_id uuid;
  r record;
begin
  select user_id, pipeline_preset into v_owner, v_preset from projects where id = p_project_id;
  if v_owner is null or v_owner <> auth.uid() then
    raise exception 'Project not found' using errcode = 'P0001';
  end if;
  if v_preset <> 'legacy' then
    raise exception 'Only a legacy project can be moved to the new pipeline' using errcode = 'P0001';
  end if;
  if p_target_preset not in ('full', 'custom') then
    raise exception 'Invalid target preset' using errcode = 'P0001';
  end if;

  -- Every legacy stage_key with >=1 non-Delivered shot must be mapped.
  select coalesce(array_agg(distinct s.stage), '{}') into v_occupied
    from shots s where s.project_id = p_project_id and s.stage <> 'delivered';

  select coalesce(array_agg(k), '{}') into v_missing
    from unnest(v_occupied) as k
    where not (p_mapping ? k);
  if array_length(v_missing, 1) > 0 then
    raise exception 'A target stage is required for: %', array_to_string(v_missing, ', ')
      using errcode = 'P0001';
  end if;

  -- The set of canonical stages this migration is about to enable.
  if p_target_preset = 'full' then
    select array_agg(id) into v_valid_targets from pipeline_stages where family = 'canonical';
  else
    if p_target_keys is null or array_length(p_target_keys, 1) is null then
      raise exception 'Select at least one stage for the custom pipeline' using errcode = 'P0001';
    end if;
    select coalesce(array_agg(id), '{}') into v_valid_targets
      from pipeline_stages where family = 'canonical' and id = any(p_target_keys);
    if array_length(v_valid_targets, 1) <> array_length(p_target_keys, 1) then
      raise exception 'One or more selected stages are not valid canonical stages' using errcode = 'P0001';
    end if;
  end if;

  -- Every mapped target must actually be one of those enabled stages -
  -- this is what makes "map Frame Test to a stage you didn't enable"
  -- impossible, per design report v2 §9.4 step 2.
  for r in select value from jsonb_each_text(p_mapping) loop
    if not (r.value = any(v_valid_targets)) then
      raise exception 'Mapped target "%" is not an enabled stage in the chosen pipeline', r.value
        using errcode = 'P0001';
    end if;
  end loop;

  -- Snapshot everything needed for the audit row / undo, before touching
  -- anything.
  select coalesce(jsonb_agg(to_jsonb(ps)), '[]'::jsonb) into v_old_stages
    from project_stages ps where ps.project_id = p_project_id;
  v_before := public._project_completion_percent(p_project_id);
  select coalesce(jsonb_agg(jsonb_build_object(
      'shot_id', s.id, 'from_key', s.stage, 'to_key', p_mapping ->> s.stage
    )), '[]'::jsonb)
    into v_shot_moves
    from shots s
    where s.project_id = p_project_id and s.stage <> 'delivered' and (p_mapping ? s.stage);

  -- Swap the pipeline. The shots(project_id, stage) FK is deferrable
  -- (migration_project_pipeline_phase2.sql §3.3), so this brief window
  -- where old rows are gone and shots still point at them is fine - the
  -- constraint is only checked at commit, by which point every shot
  -- points at a row that exists again.
  delete from project_stages where project_id = p_project_id;

  -- projects.pipeline_preset must flip to the target BEFORE the
  -- canonical rows below are inserted: trg_enforce_project_stage_family
  -- (migration_project_pipeline_phase2.sql §3) checks each new
  -- project_stages row's family against the project's CURRENT
  -- pipeline_preset, and would reject inserting canonical rows while
  -- the project is still marked 'legacy'.
  update projects set pipeline_preset = p_target_preset where id = p_project_id;

  if p_target_preset = 'full' then
    insert into project_stages (project_id, stage_key, library_stage_id, user_id, is_enabled, sort_order)
    select p_project_id, ps.id, ps.id, v_owner, true, ps.default_order
    from pipeline_stages ps where ps.family = 'canonical';
  else
    insert into project_stages (project_id, stage_key, library_stage_id, user_id, is_enabled, sort_order)
    select p_project_id, ps.id, ps.id, v_owner, (ps.id = any(p_target_keys)), ps.default_order
    from pipeline_stages ps where ps.family = 'canonical';
  end if;

  insert into project_stages (project_id, stage_key, library_stage_id, user_id, is_enabled, sort_order)
  values (p_project_id, 'delivered', 'delivered', v_owner, true, 1000);

  -- Move only the mapped (non-Delivered) shots. Delivered shots are
  -- never in p_mapping, so they are never touched - they stay Delivered
  -- (design report v2 §5.3, §10.2).
  update shots s
  set stage = p_mapping ->> s.stage
  where s.project_id = p_project_id and s.stage <> 'delivered' and (p_mapping ? s.stage);

  v_after := public._project_completion_percent(p_project_id);

  insert into project_pipeline_migrations (
    project_id, user_id, from_preset, to_preset, old_stages, shot_moves, before_percent, after_percent
  ) values (
    p_project_id, v_owner, v_preset, p_target_preset, v_old_stages, v_shot_moves, v_before, v_after
  )
  returning id into v_migration_id;

  insert into activity_log (user_id, project_id, event_type, description)
  values (
    v_owner, p_project_id, 'pipeline_migrated',
    format('Moved to the new pipeline (%s). Completion %s%% -> %s%%.',
      p_target_preset, coalesce(v_before::text, '—'), coalesce(v_after::text, '—'))
  );

  return jsonb_build_object('migration_id', v_migration_id, 'before_percent', v_before, 'after_percent', v_after);
end;
$$;

revoke all on function public.migrate_project_pipeline(uuid, text, text[], jsonb) from public;
grant execute on function public.migrate_project_pipeline(uuid, text, text[], jsonb) to authenticated;

-- =========================================================================
-- 4. undo_project_pipeline_migration (design report v2 §10.2, §17)
-- =========================================================================
-- Refuses if any moved shot no longer holds exactly the post-migration
-- stage recorded at migration time (design's "cuts have moved since"
-- rule) - undo must never silently overwrite newer progress.

create or replace function public.undo_project_pipeline_migration(p_migration_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_migration record;
  v_owner uuid;
  v_mismatch boolean := false;
  r record;
begin
  select * into v_migration from project_pipeline_migrations where id = p_migration_id;
  if v_migration is null then
    raise exception 'Migration not found' using errcode = 'P0001';
  end if;

  select user_id into v_owner from projects where id = v_migration.project_id;
  if v_owner is null or v_owner <> auth.uid() then
    raise exception 'Project not found' using errcode = 'P0001';
  end if;
  if v_migration.undone_at is not null then
    raise exception 'This migration was already undone' using errcode = 'P0001';
  end if;

  for r in
    select * from jsonb_to_recordset(v_migration.shot_moves) as x(shot_id uuid, from_key text, to_key text)
  loop
    if not exists (select 1 from shots where id = r.shot_id and stage = r.to_key) then
      v_mismatch := true;
      exit;
    end if;
  end loop;
  if v_mismatch then
    raise exception 'Cuts have moved since this migration — undo is no longer safe' using errcode = 'P0001';
  end if;

  delete from project_stages where project_id = v_migration.project_id;

  -- Same ordering requirement as migrate_project_pipeline above: flip
  -- pipeline_preset back to legacy BEFORE inserting the restored legacy
  -- rows, or trg_enforce_project_stage_family rejects them.
  update projects set pipeline_preset = v_migration.from_preset where id = v_migration.project_id;

  insert into project_stages (project_id, stage_key, library_stage_id, user_id, is_enabled, sort_order, disabled_at, created_at)
  select
    (x ->> 'project_id')::uuid,
    x ->> 'stage_key',
    x ->> 'library_stage_id',
    (x ->> 'user_id')::uuid,
    (x ->> 'is_enabled')::boolean,
    (x ->> 'sort_order')::int,
    nullif(x ->> 'disabled_at', '')::timestamptz,
    (x ->> 'created_at')::timestamptz
  from jsonb_array_elements(v_migration.old_stages) as x;

  for r in
    select * from jsonb_to_recordset(v_migration.shot_moves) as x(shot_id uuid, from_key text, to_key text)
  loop
    update shots set stage = r.from_key where id = r.shot_id;
  end loop;

  update project_pipeline_migrations set undone_at = now() where id = p_migration_id;

  insert into activity_log (user_id, project_id, event_type, description)
  values (v_owner, v_migration.project_id, 'pipeline_migration_undone', 'Undid the move to the new pipeline.');

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.undo_project_pipeline_migration(uuid) from public;
grant execute on function public.undo_project_pipeline_migration(uuid) to authenticated;
