-- Run this in the Supabase SQL Editor to add Google Drive integration.
-- Safe to run alongside your existing schema.

create extension if not exists pgcrypto;

-- One Drive connection per studio user. The refresh token is encrypted at
-- rest using a key that only lives in the Edge Functions' environment,
-- never in the database and never sent to the browser.
create table if not exists google_drive_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  refresh_token_encrypted text not null,
  connected_email text default '',
  root_folder_id text,
  created_at timestamptz default now()
);

alter table google_drive_connections enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'google_drive_connections' and policyname = 'Users manage their own drive connection'
  ) then
    create policy "Users manage their own drive connection"
      on google_drive_connections for all
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end $$;

-- Where each project's Drive folders live
alter table projects add column if not exists drive_folder_id text;
alter table projects add column if not exists drive_folder_url text;
alter table projects add column if not exists drive_deliverables_folder_id text;
