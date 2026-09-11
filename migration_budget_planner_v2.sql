-- Budget Planner v2 — additive migration for the rest of the planner
-- roadmap (Phases 3, 4, 7, 8, 9, 10, 11, 12).
--
-- Safe to run alongside the existing schema and migration_budget_planner.sql.
-- Only adds columns/tables; nothing here drops or rewrites existing data.

-- ---------------------------------------------------------------------------
-- budget_planners: new columns
-- ---------------------------------------------------------------------------

alter table budget_planners
  add column if not exists status text not null default 'draft',
  add column if not exists deadline date,
  add column if not exists start_date date,
  add column if not exists contingency_percent numeric not null default 7,
  add column if not exists department_allocations jsonb not null default '{}'::jsonb,
  add column if not exists crew jsonb not null default '[]'::jsonb,
  add column if not exists scope jsonb not null default '{}'::jsonb,
  add column if not exists template_id uuid,
  add column if not exists converted_project_id uuid references projects(id) on delete set null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'budget_planners_status_check'
  ) then
    alter table budget_planners
      add constraint budget_planners_status_check
      check (status in ('draft', 'proposal_sent', 'negotiating', 'approved', 'rejected', 'converted'));
  end if;
end $$;

create index if not exists budget_planners_status_idx on budget_planners(status);
create index if not exists budget_planners_converted_project_idx on budget_planners(converted_project_id);

-- ---------------------------------------------------------------------------
-- planner_templates (Phase 3 + Phase 11): user-saved reusable structures.
-- Built-in starting templates (Anime Trailer, Anime Short, Commercial,
-- Music Video, Game Trailer, Custom) are defined client-side and are not
-- rows in this table.
-- ---------------------------------------------------------------------------

create table if not exists planner_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'Untitled template',
  project_type text default '',
  target_profit_percent numeric not null default 25,
  department_allocations jsonb,
  crew jsonb not null default '[]'::jsonb,
  scope jsonb not null default '{}'::jsonb,
  created_at timestamptz default now()
);

alter table planner_templates enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'planner_templates' and policyname = 'Users manage their own planner templates'
  ) then
    create policy "Users manage their own planner templates"
      on planner_templates for all
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end $$;

create index if not exists planner_templates_user_id_idx on planner_templates(user_id);

-- template_id on budget_planners references planner_templates, but a plan
-- can also be started from a built-in template (no row to reference), so
-- this stays a loose uuid column rather than a hard FK.
