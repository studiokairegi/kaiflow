-- Run this in the Supabase SQL Editor to add the Budget Planner module
-- (Phase 1, 2, and 5 of the roadmap: core planner, profit presets, and
-- live recalculation, the rest of the roadmap is a later pass).
-- Safe to run alongside your existing schema.

create table if not exists budget_planners (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'Untitled plan',
  client_name text default '',
  project_type text default '',
  budget numeric not null default 0,
  currency text not null default '$',
  target_profit_percent numeric not null default 25,
  notes text default '',
  created_at timestamptz default now()
);

alter table budget_planners enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'budget_planners' and policyname = 'Users manage their own budget planners'
  ) then
    create policy "Users manage their own budget planners"
      on budget_planners for all
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end $$;

create index if not exists budget_planners_user_id_idx on budget_planners(user_id);
