-- Run this in the Supabase SQL Editor to add Pomodoro focus-session support
-- on top of the work_sessions table from migration_work_sessions.sql. Run
-- that migration first if you haven't. Safe to run alongside your existing
-- schema, and safe to re-run.

alter table work_sessions
  add column if not exists session_type text not null default 'manual';

-- Idempotent constraint add - plain ALTER TABLE ADD CONSTRAINT has no
-- IF NOT EXISTS, so this checks pg_constraint first, matching the pattern
-- used for policies elsewhere in this project's migrations.
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
