-- Shot Tracker schema for Supabase
-- Run this in the Supabase SQL Editor: project > SQL Editor > New query

create extension if not exists "pgcrypto";

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null default 'Untitled project',
  client text default '',
  notes text default '',
  created_at timestamptz default now()
);

create table if not exists shots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  title text not null default 'Untitled shot',
  client text default '',
  rate text default '',
  due text default '',
  priority text default 'normal',
  notes text default '',
  stage text not null default 'quote',
  created_at timestamptz default now()
);

alter table projects enable row level security;
alter table shots enable row level security;

create policy "Users manage their own projects"
  on projects for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users manage their own shots"
  on shots for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

alter table projects add column if not exists budget text default '';
alter table projects add column if not exists deadline text default '';
alter table projects add column if not exists priority text default 'normal';

create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  company_name text not null default 'Untitled lead',
  contact_person text default '',
  email text default '',
  website text default '',
  country text default '',
  notes text default '',
  stage text not null default 'pool',
  emails jsonb not null default '[
    {"label":"Initial Email","message":"","sent":false,"dateSent":null},
    {"label":"Follow-up 1","message":"","sent":false,"dateSent":null},
    {"label":"Follow-up 2","message":"","sent":false,"dateSent":null},
    {"label":"Follow-up 3","message":"","sent":false,"dateSent":null}
  ]'::jsonb,
  proposed_budget text default '',
  estimated_deadline text default '',
  project_notes text default '',
  lost_reason text default '',
  linked_project_id uuid references projects(id) on delete set null,
  created_at timestamptz default now()
);

alter table leads enable row level security;

create policy "Users manage their own leads"
  on leads for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists leads_user_id_idx on leads(user_id);
create index if not exists shots_project_id_idx on shots(project_id);
create index if not exists projects_user_id_idx on projects(user_id);
create index if not exists shots_user_id_idx on shots(user_id);

-- Studio Time work-session tracker (Dashboard clock in/out) and Pomodoro
-- focus-session support, merged in from migration_work_sessions.sql and
-- migration_pomodoro_sessions.sql so a fresh install from this file alone
-- includes the feature - both blocks are idempotent and safe to re-run.

-- One row per clock-in/clock-out session. clock_out (and duration) stay
-- null while a session is active. duration is stored in whole seconds,
-- matching the plain-column style used elsewhere in this schema rather
-- than a Postgres interval type.
create table if not exists work_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  clock_in timestamptz not null default now(),
  clock_out timestamptz,
  duration integer,
  created_at timestamptz not null default now()
);

alter table work_sessions enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'work_sessions' and policyname = 'Users manage their own work sessions'
  ) then
    create policy "Users manage their own work sessions"
      on work_sessions for all
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end $$;

-- Enforces "at most one active session per user" at the database level, so
-- a double-click or a second browser tab can never create two overlapping
-- clock-ins - the second insert simply fails with a unique_violation
-- (Postgres error code 23505), which the client treats as "already
-- clocked in" and resyncs, rather than as an error.
create unique index if not exists work_sessions_one_active_per_user_idx
  on work_sessions(user_id)
  where clock_out is null;

create index if not exists work_sessions_user_id_idx on work_sessions(user_id);
create index if not exists work_sessions_clock_in_idx on work_sessions(user_id, clock_in);

-- Clocks out the caller's own active session using the database's clock for
-- both clock_out and duration, rather than trusting the browser's clock or
-- a separate read-then-write round trip. security invoker (the default,
-- stated explicitly) means it runs as the calling user, so auth.uid() is
-- always that user's own id and the update below can only ever touch
-- their own row - the work_sessions RLS policy above still applies on top
-- of this regardless.
create or replace function clock_out_active_session()
returns work_sessions
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_session work_sessions%rowtype;
begin
  update work_sessions
    set clock_out = now(),
        duration = extract(epoch from (now() - clock_in))::integer
    where user_id = auth.uid() and clock_out is null
    returning * into v_session;

  if not found then
    raise exception 'No active session to clock out';
  end if;

  return v_session;
end;
$$;

revoke execute on function clock_out_active_session() from public;
grant execute on function clock_out_active_session() to authenticated;

alter table work_sessions
  add column if not exists session_type text not null default 'manual';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'work_sessions_session_type_check'
  ) then
    alter table work_sessions
      add constraint work_sessions_session_type_check
      check (session_type in ('manual', 'pomodoro'));
  end if;
end $$;

create index if not exists work_sessions_session_type_idx on work_sessions(user_id, session_type);
