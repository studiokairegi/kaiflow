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
