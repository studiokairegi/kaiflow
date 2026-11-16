-- Notification audit fixes. Safe to run twice.
--
-- 1. Realtime: put activity_log in the supabase_realtime publication so the bell updates live on a
--    database built only from supabase/migrations (previously only the root migration_activity_notifications.sql did this).
-- 2. Push delivery: remember which devices already received a job so a retry only targets the ones
--    that failed, instead of re-sending to healthy devices.

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and to_regclass('public.activity_log') is not null
     and not exists (
       select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'activity_log'
     ) then
    execute 'alter publication supabase_realtime add table public.activity_log';
  end if;
end $$;

alter table public.push_jobs add column if not exists delivered_sub_ids uuid[] not null default '{}';
