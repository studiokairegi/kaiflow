-- Run this in the Supabase SQL Editor to add CRM support.
-- Safe to run even if you already ran the original schema.sql,
-- this only adds new things, it doesn't touch your existing tables' policies.

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

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'leads' and policyname = 'Users manage their own leads'
  ) then
    create policy "Users manage their own leads"
      on leads for all
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end $$;

create index if not exists leads_user_id_idx on leads(user_id);
