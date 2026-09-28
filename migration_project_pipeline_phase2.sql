-- =========================================================================
-- Project pipeline redesign, phase 2: schema expand + backfill + FK
-- =========================================================================
-- Implements design report v2 §3 (data model), §5 (legacy preservation),
-- §10.1 (rollout sequence), §14 (RLS). This file is additive only:
--
--   * No row in `shots` is read, written, or otherwise touched.
--   * No row in `projects` is modified except adding the new
--     `pipeline_preset` column, which defaults every existing project to
--     'legacy' - a metadata label, not a data change.
--   * The only INSERTs this file performs are the new `pipeline_stages`
--     library rows and one `project_stages` row per (existing project x
--     legacy stage) - i.e. it gives every existing project its own frozen
--     copy of today's exact 12-stage pipeline, in today's exact order.
--
-- Per the corrected design (approved 2026), there is NO mapping from any
-- legacy stage to any canonical stage anywhere in this file. Frame Test
-- does not become Shiage. Cleanup & Color does not become Shiage. Every
-- legacy project keeps exactly the stages it has today until a studio
-- member explicitly runs the (separate, not-yet-written) per-project
-- migration.
--
-- Ordering matters and must not be reshuffled (explicit user requirement):
--   1. library                 (pipeline_stages)
--   2. pipeline_preset column  (projects, default 'legacy')
--   3. project_stages table
--   4. seed/backfill           (every existing project's legacy rows)
--   5. verify                  (query at the bottom of this file)
--   6. composite FK, validated (shots -> project_stages)
--   [deploy new client, then flip the pipeline_preset default - both are
--    separate, later steps, not part of this file]
--
-- Idempotent throughout (this project has no migration-history table), so
-- safe to re-run.

-- =========================================================================
-- 1. Pipeline stage library - the single source of truth (design report
--    v2 §1, §3.1). Two families that are deliberately never merged:
--    'canonical' (offered to new projects) and 'legacy_v1' (exists only to
--    let existing projects keep meaning what they already mean). 'shared'
--    holds the one row both families reuse: Delivered.
-- =========================================================================

create table if not exists pipeline_stages (
  id            text primary key,
  family        text not null check (family in ('canonical', 'legacy_v1', 'shared')),
  kind          text not null check (kind in ('stage', 'terminal')),
  name          text not null,
  description   text not null default '',
  phase         text check (phase in ('pre_production', 'production', 'post_production')),
  default_order int  not null,
  is_selectable boolean not null default false,   -- true only for canonical, non-terminal rows
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  check ((family = 'canonical' and kind = 'stage') = (phase is not null))
);

alter table pipeline_stages enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'pipeline_stages' and policyname = 'Anyone can read the pipeline library'
  ) then
    create policy "Anyone can read the pipeline library"
      on pipeline_stages for select
      using (true);
  end if;
end $$;
-- No insert/update/delete policy: the library is seeded by this migration
-- only. Nothing in the app writes to it.

-- 1a. Canonical library (design report v2 §1.1). Order steps by 10 so a
--     later addition never requires renumbering existing rows.
insert into pipeline_stages (id, family, kind, name, phase, default_order, is_selectable)
values
  ('brief',              'canonical', 'stage', 'Brief',                     'pre_production',  10, true),
  ('storyboard',         'canonical', 'stage', 'Storyboard / Stillomatic',  'pre_production',  20, true),
  ('character_concept',  'canonical', 'stage', 'Character Concept',        'pre_production',  30, true),
  ('background_concept', 'canonical', 'stage', 'Background Concept',       'pre_production',  40, true),
  ('colorscript',        'canonical', 'stage', 'Colorscript',              'pre_production',  50, true),
  ('frame_test',         'canonical', 'stage', 'Frame Test',               'pre_production',  60, true),
  ('layout',             'canonical', 'stage', 'Layout',                   'production',      70, true),
  ('enshutsu',           'canonical', 'stage', 'Enshutsu',                 'production',      80, true),
  ('sakkan',              'canonical', 'stage', 'Sakkan',                   'production',      90, true),
  ('coc',                'canonical', 'stage', 'COC',                      'production',     100, true),
  ('genga',              'canonical', 'stage', 'Genga',                    'production',     110, true),
  ('douga',              'canonical', 'stage', 'Douga',                    'production',     120, true),
  ('shiage',             'canonical', 'stage', 'Shiage',                   'production',     130, true),
  ('cgi',                'canonical', 'stage', 'CGI',                      'production',     140, true),
  ('bg_environment',     'canonical', 'stage', 'BG Environment',           'production',     150, true),
  ('sfx_bgm',            'canonical', 'stage', 'SFX/BGM',                  'production',     160, true),
  ('editing',            'canonical', 'stage', 'Editing',                  'post_production',170, true),
  ('compositing',        'canonical', 'stage', 'Compositing',              'post_production',180, true)
on conflict (id) do nothing;

-- 1b. Legacy library: an exact, mechanical copy of the STAGES constant
--     that today's App.jsx/SharedViews.jsx hard-code, prefixed so these
--     ids can never collide with a canonical id. Never selectable for new
--     projects. `default_order` matches today's array order exactly.
insert into pipeline_stages (id, family, kind, name, phase, default_order, is_selectable)
values
  ('legacy_character_design', 'legacy_v1', 'stage', 'Character Design',      null, 10, false),
  ('legacy_bg_lighting',      'legacy_v1', 'stage', 'BG & Lighting Design',  null, 20, false),
  ('legacy_storyboard',       'legacy_v1', 'stage', 'Storyboard',            null, 30, false),
  ('legacy_layout',           'legacy_v1', 'stage', 'Layout',                null, 40, false),
  ('legacy_genga',            'legacy_v1', 'stage', 'Genga',                 null, 50, false),
  ('legacy_douga',            'legacy_v1', 'stage', 'Douga',                 null, 60, false),
  ('legacy_backgrounds',      'legacy_v1', 'stage', 'Backgrounds',           null, 70, false),
  ('legacy_frametest',        'legacy_v1', 'stage', 'Frame Test',            null, 80, false),
  ('legacy_cleanup',          'legacy_v1', 'stage', 'Cleanup & Color',       null, 90, false),
  ('legacy_compositing',      'legacy_v1', 'stage', 'Compositing',           null,100, false),
  ('legacy_editing',          'legacy_v1', 'stage', 'Editing',               null,110, false)
on conflict (id) do nothing;

-- 1c. The one shared terminal row. Every project, legacy or canonical,
--     uses this same id for "delivered" - it is what keeps a fully
--     delivered legacy project's completion meaning the same thing after
--     any later migration (design report v2 §5.3, §C3 in v1).
insert into pipeline_stages (id, family, kind, name, phase, default_order, is_selectable)
values ('delivered', 'shared', 'terminal', 'Delivered', null, 1000, false)
on conflict (id) do nothing;

-- =========================================================================
-- 2. Per-project pipeline preset (design report v2 §3.2, §5.1)
-- =========================================================================
-- Defaulting every existing project to 'legacy' is metadata only - it
-- reclassifies rows that already exist, it does not alter any of their
-- other columns or touch `shots` at all.

alter table projects
  add column if not exists pipeline_preset text not null default 'legacy';

do $$
begin
  alter table projects drop constraint if exists projects_pipeline_preset_check;
  alter table projects
    add constraint projects_pipeline_preset_check
    check (pipeline_preset in ('legacy', 'full', 'custom')) not valid;
  alter table projects validate constraint projects_pipeline_preset_check;
end $$;

-- =========================================================================
-- 3. Per-project pipeline configuration (design report v2 §3.2)
-- =========================================================================

create table if not exists project_stages (
  project_id       uuid not null references projects(id) on delete cascade,
  stage_key        text not null,
  library_stage_id text not null references pipeline_stages(id),
  user_id          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  is_enabled       boolean not null default true,
  sort_order       int  not null,
  disabled_at      timestamptz,
  created_at       timestamptz not null default now(),
  primary key (project_id, stage_key),
  unique (project_id, library_stage_id)
);

alter table project_stages enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'project_stages' and policyname = 'Users read their own project stages'
  ) then
    create policy "Users read their own project stages"
      on project_stages for select
      using (auth.uid() = user_id);
  end if;
end $$;
-- Deliberately no insert/update/delete policy for ordinary clients (design
-- report v2 §14): a direct client write could disable every stage on a
-- project or attach a stage from the wrong family. All writes go through
-- the SECURITY DEFINER functions below and the seeding trigger.

create index if not exists project_stages_project_id_idx on project_stages(project_id);
create index if not exists project_stages_user_id_idx on project_stages(user_id);

-- Defensive backstop (design report v2 §14): a project_stages row's
-- library family must match its project's pipeline_preset family. This
-- can only ever be reached via the DEFINER functions/trigger below, since
-- ordinary clients have no write policy on this table - but the checks
-- inside those functions are the primary guarantee; this is belt-and-
-- braces, matching the style of enforce_project_id_ownership() already in
-- this codebase.
create or replace function public.enforce_project_stage_family()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_preset text;
  v_family text;
begin
  select pipeline_preset into v_preset from projects where id = new.project_id;
  select family into v_family from pipeline_stages where id = new.library_stage_id;
  if v_family = 'shared' then
    return new; -- delivered is valid for every project
  end if;
  if v_preset = 'legacy' and v_family <> 'legacy_v1' then
    raise exception 'A legacy project can only use legacy pipeline stages' using errcode = 'P0001';
  end if;
  if v_preset in ('full', 'custom') and v_family <> 'canonical' then
    raise exception 'A canonical project can only use canonical pipeline stages' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_project_stage_family on project_stages;
create trigger trg_enforce_project_stage_family
before insert or update on project_stages
for each row execute function public.enforce_project_stage_family();

-- =========================================================================
-- 4. Backfill: give every EXISTING project its own frozen legacy pipeline
-- =========================================================================
-- This is a mechanical, order-preserving copy of the 11 legacy stages plus
-- Delivered, for every project that does not already have project_stages
-- rows. No interpretation, no mapping to canonical stages, no change to
-- any project's pipeline_preset (already defaulted to 'legacy' in step 2).
-- Re-running this file is safe: `on conflict do nothing` skips projects
-- that already have rows (e.g. new projects created after step 2 shipped,
-- which the trigger in step 6 will have already seeded correctly).

insert into project_stages (project_id, stage_key, library_stage_id, user_id, is_enabled, sort_order)
select p.id, ls.legacy_key, ls.id, p.user_id, true, ls.default_order
from projects p
cross join (
  select id, default_order,
    case id
      when 'legacy_character_design' then 'character_design'
      when 'legacy_bg_lighting'      then 'bg_lighting'
      when 'legacy_storyboard'       then 'storyboard'
      when 'legacy_layout'           then 'layout'
      when 'legacy_genga'            then 'genga'
      when 'legacy_douga'            then 'douga'
      when 'legacy_backgrounds'      then 'backgrounds'
      when 'legacy_frametest'        then 'frametest'
      when 'legacy_cleanup'          then 'cleanup'
      when 'legacy_compositing'      then 'compositing'
      when 'legacy_editing'          then 'editing'
    end as legacy_key
  from pipeline_stages where family = 'legacy_v1'
) ls
where p.pipeline_preset = 'legacy'
on conflict (project_id, stage_key) do nothing;

insert into project_stages (project_id, stage_key, library_stage_id, user_id, is_enabled, sort_order)
select p.id, 'delivered', 'delivered', p.user_id, true, 1000
from projects p
where p.pipeline_preset = 'legacy'
on conflict (project_id, stage_key) do nothing;

-- =========================================================================
-- 5. Verify (read-only; inspect the output before proceeding to step 6)
-- =========================================================================
-- Run this block's query by itself first. Every row must show
-- stage_count = 12 and unmapped_shots = 0 before the composite FK below
-- is added. If any project fails either check, stop and investigate -
-- do NOT proceed to step 6 against it.

-- select p.id, p.name,
--        (select count(*) from project_stages ps where ps.project_id = p.id) as stage_count,
--        (select count(*) from shots s
--           where s.project_id = p.id
--             and not exists (
--               select 1 from project_stages ps
--               where ps.project_id = s.project_id and ps.stage_key = s.stage
--             )
--        ) as unmapped_shots
-- from projects p
-- order by unmapped_shots desc, stage_count asc;

-- =========================================================================
-- 6. Composite FK: a shot can only ever reference a stage that belongs to
--    its own project's pipeline (design report v2 §3.3, the core new
--    database invariant).
-- =========================================================================
-- NOT VALID first (so this can't fail outright against unexpected data),
-- then VALIDATE (so any shot that doesn't resolve surfaces as a clear,
-- named error here rather than silently passing). Deferrable, because
-- the explicit per-project migration workflow (a later, separate file)
-- swaps a project's stage rows and its shots' `stage` values in one
-- transaction, and project deletion cascades to both tables at once.

alter table shots drop constraint if exists shots_project_stage_fkey;
alter table shots
  add constraint shots_project_stage_fkey
  foreign key (project_id, stage) references project_stages(project_id, stage_key)
  deferrable initially deferred
  not valid;

alter table shots validate constraint shots_project_stage_fkey;

-- The old whitelist check is now redundant: every shot's stage is
-- guaranteed to exist in ITS OWN project's pipeline, which is strictly
-- stronger than "is one of these 12 strings". Dropped only after the new
-- constraint above has been validated against all existing data.
alter table shots drop constraint if exists shots_stage_check;

-- =========================================================================
-- 7. Seeding trigger: every NEW project gets pipeline rows automatically
-- =========================================================================
-- Covers every project-creation path with one trigger - the existing
-- create_project_with_shots RPC, convert_planner_to_project, and any
-- future insert - none of which need to be edited for this to apply to
-- them (design report v2 §3.4, §10.1). AFTER INSERT so it runs once the
-- new project row (and its id) definitely exists; SECURITY DEFINER
-- because ordinary clients have no write policy on project_stages.

create or replace function public.seed_project_pipeline()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.pipeline_preset = 'legacy' then
    insert into project_stages (project_id, stage_key, library_stage_id, user_id, is_enabled, sort_order)
    select new.id, ls.legacy_key, ls.id, new.user_id, true, ls.default_order
    from (
      select id, default_order,
        case id
          when 'legacy_character_design' then 'character_design'
          when 'legacy_bg_lighting'      then 'bg_lighting'
          when 'legacy_storyboard'       then 'storyboard'
          when 'legacy_layout'           then 'layout'
          when 'legacy_genga'            then 'genga'
          when 'legacy_douga'            then 'douga'
          when 'legacy_backgrounds'      then 'backgrounds'
          when 'legacy_frametest'        then 'frametest'
          when 'legacy_cleanup'          then 'cleanup'
          when 'legacy_compositing'      then 'compositing'
          when 'legacy_editing'          then 'editing'
        end as legacy_key
      from pipeline_stages where family = 'legacy_v1'
    ) ls;
  else
    -- 'full' or 'custom': seed all 18 canonical stages enabled. A
    -- 'custom' creator (the phase-3+ client) narrows this down with
    -- set_project_pipeline in the same request, right after creation -
    -- this trigger never has to know which stages were actually chosen.
    insert into project_stages (project_id, stage_key, library_stage_id, user_id, is_enabled, sort_order)
    select new.id, ps.id, ps.id, new.user_id, true, ps.default_order
    from pipeline_stages ps
    where ps.family = 'canonical';
  end if;

  insert into project_stages (project_id, stage_key, library_stage_id, user_id, is_enabled, sort_order)
  values (new.id, 'delivered', 'delivered', new.user_id, true, 1000)
  on conflict (project_id, stage_key) do nothing;

  return new;
end;
$$;

drop trigger if exists trg_seed_project_pipeline on projects;
create trigger trg_seed_project_pipeline
after insert on projects
for each row execute function public.seed_project_pipeline();

-- =========================================================================
-- 8. Pipeline read/write RPCs (design report v2 §3.5)
-- =========================================================================

-- 8a. Public library read - lets the picker in a not-yet-authenticated
--     context (and the portals) show real stage names instead of raw ids.
create or replace function public.get_pipeline_library()
returns setof pipeline_stages
language sql
security definer
set search_path = public
stable
as $$
  select * from pipeline_stages where is_active order by family, default_order;
$$;

revoke all on function public.get_pipeline_library() from public;
grant execute on function public.get_pipeline_library() to anon, authenticated;

-- 8b. Enable/disable stages on a project the caller owns. Never writes to
--     `shots` (design report v2 §6 invariant I1). Rejects: disabling every
--     stage, touching the shared terminal row, or naming a stage from the
--     wrong family for this project. Logs one activity_log entry.
create or replace function public.set_project_pipeline(
  p_project_id uuid,
  p_enabled_keys text[]
)
returns setof project_stages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_preset text;
  v_valid_count int;
  v_added text[];
  v_removed text[];
begin
  select user_id, pipeline_preset into v_owner, v_preset from projects where id = p_project_id;
  if v_owner is null or v_owner <> auth.uid() then
    raise exception 'Project not found' using errcode = 'P0001';
  end if;
  if p_enabled_keys is null or array_length(p_enabled_keys, 1) is null then
    raise exception 'A project must have at least one enabled stage' using errcode = 'P0001';
  end if;

  select count(*) into v_valid_count
  from project_stages ps
  where ps.project_id = p_project_id
    and ps.stage_key = any(p_enabled_keys)
    and ps.library_stage_id <> 'delivered';
  if v_valid_count <> array_length(p_enabled_keys, 1) then
    raise exception 'One or more stages are not part of this project''s pipeline' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(stage_key), '{}')
    into v_added
    from project_stages
    where project_id = p_project_id and library_stage_id <> 'delivered'
      and is_enabled = false and stage_key = any(p_enabled_keys);
  select coalesce(array_agg(stage_key), '{}')
    into v_removed
    from project_stages
    where project_id = p_project_id and library_stage_id <> 'delivered'
      and is_enabled = true and not (stage_key = any(p_enabled_keys));

  update project_stages
  set is_enabled = true, disabled_at = null
  where project_id = p_project_id and library_stage_id <> 'delivered'
    and stage_key = any(p_enabled_keys) and is_enabled = false;

  update project_stages
  set is_enabled = false, disabled_at = now()
  where project_id = p_project_id and library_stage_id <> 'delivered'
    and not (stage_key = any(p_enabled_keys)) and is_enabled = true;

  if array_length(v_added, 1) > 0 or array_length(v_removed, 1) > 0 then
    insert into activity_log (user_id, project_id, event_type, description)
    values (
      auth.uid(), p_project_id, 'pipeline_changed',
      'Pipeline changed'
        || case when array_length(v_added, 1) > 0 then ' — enabled: ' || array_to_string(v_added, ', ') else '' end
        || case when array_length(v_removed, 1) > 0 then ' — disabled: ' || array_to_string(v_removed, ', ') else '' end
    );
  end if;

  return query select * from project_stages where project_id = p_project_id order by sort_order;
end;
$$;

revoke all on function public.set_project_pipeline(uuid, text[]) from public;
grant execute on function public.set_project_pipeline(uuid, text[]) to authenticated;

-- 8c. Switch a project's preset between 'full' and 'custom'. Full = every
--     canonical stage enabled. Custom = only p_enabled_keys enabled. Both
--     branches only ever touch is_enabled/disabled_at - never `shots`.
--     Cannot be used on a 'legacy' project (that route is the explicit
--     migration workflow, a separate function).
create or replace function public.set_project_pipeline_preset(
  p_project_id uuid,
  p_preset text,
  p_enabled_keys text[] default null
)
returns setof project_stages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_current_preset text;
begin
  select user_id, pipeline_preset into v_owner, v_current_preset from projects where id = p_project_id;
  if v_owner is null or v_owner <> auth.uid() then
    raise exception 'Project not found' using errcode = 'P0001';
  end if;
  if v_current_preset = 'legacy' then
    raise exception 'Use the pipeline migration workflow for a legacy project' using errcode = 'P0001';
  end if;
  if p_preset not in ('full', 'custom') then
    raise exception 'Invalid preset' using errcode = 'P0001';
  end if;

  update projects set pipeline_preset = p_preset where id = p_project_id;

  if p_preset = 'full' then
    update project_stages set is_enabled = true, disabled_at = null
    where project_id = p_project_id and library_stage_id <> 'delivered' and is_enabled = false;
    return query select * from project_stages where project_id = p_project_id order by sort_order;
  else
    return query select * from set_project_pipeline(p_project_id, coalesce(p_enabled_keys, '{}'));
  end if;
end;
$$;

revoke all on function public.set_project_pipeline_preset(uuid, text, text[]) from public;
grant execute on function public.set_project_pipeline_preset(uuid, text, text[]) to authenticated;

-- 8d. New-project creation with an explicit pipeline. Additive overload -
--     the existing 13-arg create_project_with_shots (in
--     migration_project_client_billing_rpc.sql: p_name, p_client, p_notes,
--     p_budget, p_budget_mode, p_currency, p_deadline, p_priority,
--     p_share_enabled, p_share_token, p_shot_count, p_client_address,
--     p_client_tax_id) is left exactly as it is, so the current client
--     keeps working unmodified against this schema. This adds two more
--     trailing params, so it is a genuinely different (15-arg) overload,
--     not a replacement - no explicit drop needed, unlike the note in
--     that file about the 11 -> 13 arg change. This is what a phase-3+
--     client calls once it starts offering Full/Custom at creation time.
create or replace function public.create_project_with_shots(
  p_name text,
  p_client text,
  p_notes text,
  p_budget text,
  p_budget_mode text,
  p_currency text,
  p_deadline text,
  p_priority text,
  p_share_enabled boolean,
  p_share_token text,
  p_shot_count int,
  p_client_address text,
  p_client_tax_id text,
  p_pipeline_preset text,
  p_stage_keys text[]
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_project projects%rowtype;
  v_shots jsonb;
  v_total int := greatest(0, least(500, coalesce(p_shot_count, 0)));
  v_pad int := greatest(2, length(v_total::text));
  v_preset text := coalesce(p_pipeline_preset, 'full');
  v_first_stage text;
begin
  if v_preset not in ('full', 'custom') then
    raise exception 'p_pipeline_preset must be full or custom' using errcode = 'P0001';
  end if;

  insert into projects (
    name, client, client_address, client_tax_id, notes, budget, budget_mode, currency, deadline, priority,
    share_enabled, share_token, user_id, pipeline_preset
  ) values (
    coalesce(p_name, 'Untitled project'), coalesce(p_client, ''), coalesce(p_client_address, ''),
    coalesce(p_client_tax_id, ''), p_notes, coalesce(p_budget, ''),
    coalesce(p_budget_mode, 'manual'), coalesce(p_currency, '$'), nullif(p_deadline, ''),
    coalesce(p_priority, 'normal'), coalesce(p_share_enabled, false), p_share_token, auth.uid(),
    v_preset
  )
  returning * into v_project;
  -- trg_seed_project_pipeline has now populated all 18 canonical stages
  -- (enabled) + Delivered for this project.

  if v_preset = 'custom' then
    perform set_project_pipeline(v_project.id, coalesce(p_stage_keys, '{}'));
  end if;

  select stage_key into v_first_stage
  from project_stages
  where project_id = v_project.id and is_enabled = true and library_stage_id <> 'delivered'
  order by sort_order limit 1;

  if v_total > 0 then
    insert into shots (project_id, title, client, rate, due, priority, notes, stage, user_id)
    select
      v_project.id,
      'Cut ' || lpad(gs::text, v_pad, '0'),
      coalesce(p_client, ''),
      '', '', 'normal', '',
      v_first_stage,
      auth.uid()
    from generate_series(1, v_total) as gs;
  end if;

  select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) into v_shots from shots s where s.project_id = v_project.id;

  return jsonb_build_object('project', to_jsonb(v_project), 'shots', v_shots);
end;
$$;

revoke all on function public.create_project_with_shots(text,text,text,text,text,text,text,text,boolean,text,int,text,text,text,text[]) from public;
grant execute on function public.create_project_with_shots(text,text,text,text,text,text,text,text,boolean,text,int,text,text,text,text[]) to authenticated;

-- 8e. Public portal reads (design report v2 §12). Additive - the existing
--     get_shared_project / get_shared_shot are untouched, so an
--     already-open or cached portal page keeps working exactly as today.
create or replace function public.get_shared_project_pipeline(p_token text)
returns table (stage_key text, name text, phase text, kind text, sort_order int, is_enabled boolean)
language sql
security definer
set search_path = public
stable
as $$
  select ps.stage_key, coalesce(lib.name, ps.stage_key), lib.phase, lib.kind, ps.sort_order, ps.is_enabled
  from projects p
  join project_stages ps on ps.project_id = p.id
  join pipeline_stages lib on lib.id = ps.library_stage_id
  where p.share_token = p_token and p.share_enabled = true
  order by ps.sort_order;
$$;

revoke all on function public.get_shared_project_pipeline(text) from public;
grant execute on function public.get_shared_project_pipeline(text) to anon, authenticated;

create or replace function public.get_shared_shot_stage(p_token text)
returns table (stage_key text, name text, phase text, kind text)
language sql
security definer
set search_path = public
stable
as $$
  select ps.stage_key, coalesce(lib.name, ps.stage_key), lib.phase, lib.kind
  from shots s
  join project_stages ps on ps.project_id = s.project_id and ps.stage_key = s.stage
  join pipeline_stages lib on lib.id = ps.library_stage_id
  where s.share_token = p_token;
$$;

revoke all on function public.get_shared_shot_stage(text) from public;
grant execute on function public.get_shared_shot_stage(text) to anon, authenticated;

-- =========================================================================
-- Done. NOT part of this file, by design (design report v2 §10.1):
--   - flipping the `pipeline_preset` column default to 'full'
--   - the explicit per-project legacy -> canonical migration workflow
--     (migrate_project_pipeline / undo_project_pipeline_migration)
--   - any client (src/*.jsx) change beyond what already shipped in phase 1
-- Each is its own later step, run only after this one is verified.
-- =========================================================================
