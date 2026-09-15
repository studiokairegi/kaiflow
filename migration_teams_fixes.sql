-- Run this in the Supabase SQL Editor for this round of fixes.
-- Safe to run alongside your existing schema.

-- Freelancer payment tracking per shot
alter table shots add column if not exists assigned_pay numeric not null default 0;
alter table shots add column if not exists assigned_paid boolean not null default false;

-- Per-project and per-invoice currency selection
alter table projects add column if not exists currency text not null default '$';
alter table invoices add column if not exists currency text not null default '$';

-- Settings personalization: default landing tab, default shot priority, studio logo
alter table user_settings add column if not exists default_landing_tab text not null default 'dashboard';
alter table user_settings add column if not exists default_shot_priority text not null default 'normal';
alter table user_settings add column if not exists logo_url text default '';

-- Simple Teams roster, a manual list of freelancers/collaborators.
-- Not tied to real logins, just a lightweight directory the studio maintains.
create table if not exists team_members (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null default 'Untitled member',
  role text default '',
  email text default '',
  rate text default '',
  availability text not null default 'available',
  notes text default '',
  created_at timestamptz default now()
);

alter table team_members enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'team_members' and policyname = 'Users manage their own team members'
  ) then
    create policy "Users manage their own team members"
      on team_members for all
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end $$;

create index if not exists team_members_user_id_idx on team_members(user_id);

-- NOTE: this file used to also redefine get_shared_shot() here (with a
-- comment claiming it needed to return payment info, which it never
-- actually did - the RETURNS TABLE never included assigned_pay/
-- assigned_paid). That redefinition has been removed entirely: with no
-- enforced migration order across this project's 29-odd migration files,
-- four different files redefining the same function meant plain
-- alphabetical run order could silently pick this file's copy - the
-- oldest, most incomplete one - over the actually-correct, later fixes.
-- get_shared_shot() now has exactly one definition, in
-- migration_audit_fixes_5.sql, and nothing else in this project should
-- ever `create or replace` it again.
