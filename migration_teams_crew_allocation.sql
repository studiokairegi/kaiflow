-- Prepares the Teams roster (team_members) to supply everything the
-- upcoming Planner "Intelligent Crew Allocation" feature needs:
-- skills, skill level, department, structured rate, availability window,
-- capacity, dependability, and a self-reported speed default.
--
-- Additive only. Does not touch the Budget Planner tables/logic.
-- Safe to run alongside the existing schema; existing team_members rows
-- get sensible defaults and are not destroyed.

-- Identity / project-type matching
alter table team_members add column if not exists department text default '';

-- Skills (multi-select). Stored as a jsonb array of strings so custom
-- skills typed by the user are supported without a lookup table.
alter table team_members add column if not exists skills jsonb not null default '[]'::jsonb;

-- Normalized skill level, 1 (Beginner) - 5 (Expert), per planner_crew_allocation.txt section 3.
alter table team_members add column if not exists skill_level integer not null default 3;

-- Structured rate so the Planner can normalize/compare costs (section 4).
-- The legacy free-text `rate` column is preserved as an optional note
-- (e.g. "negotiable", "$15/cut - rush only") for anything structured
-- fields can't express.
alter table team_members add column if not exists rate_type text not null default 'hour';
alter table team_members add column if not exists rate_amount numeric not null default 0;

-- Availability window + weekly capacity (section 5). The existing
-- `availability` text column (available/busy/unavailable) is unchanged.
alter table team_members add column if not exists available_start_date date;
alter table team_members add column if not exists available_end_date date;
alter table team_members add column if not exists capacity_value numeric not null default 0;
alter table team_members add column if not exists capacity_unit text not null default 'hours/week';

-- Dependability factor, 0-100 (section 6).
alter table team_members add column if not exists dependability_score integer not null default 80;

-- Self-reported default speed, used only when there isn't enough
-- historical data yet (section 7). Kept explicit ("default_") so the
-- Planner never has to guess whether a number is a real historical
-- average or a placeholder.
alter table team_members add column if not exists default_speed_value numeric not null default 0;
alter table team_members add column if not exists default_speed_unit text not null default '';

-- Guardrails so bad data can't quietly break planner scoring math.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'team_members_skill_level_range'
  ) then
    alter table team_members
      add constraint team_members_skill_level_range check (skill_level between 1 and 5);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'team_members_dependability_range'
  ) then
    alter table team_members
      add constraint team_members_dependability_range check (dependability_score between 0 and 100);
  end if;
end $$;

create index if not exists team_members_department_idx on team_members(department);
