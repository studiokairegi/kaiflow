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

create index if not exists shots_project_id_idx on shots(project_id);
create index if not exists projects_user_id_idx on projects(user_id);
create index if not exists shots_user_id_idx on shots(user_id);
