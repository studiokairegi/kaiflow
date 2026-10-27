-- Test-only: columns the signup-bootstrap trigger reads from auth.users in real Supabase.
alter table auth.users add column if not exists raw_user_meta_data jsonb not null default '{}'::jsonb;
alter table auth.users add column if not exists email_confirmed_at timestamptz;
