-- Enable Supabase Realtime for activity_log so the app can react immediately to new activity events.
alter publication supabase_realtime add table public.activity_log;