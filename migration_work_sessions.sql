-- Run this in the Supabase SQL Editor to add the Studio Time work-session
-- tracker (Dashboard clock in/out). Safe to run alongside your existing
-- schema.

create extension if not exists pgcrypto;

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
