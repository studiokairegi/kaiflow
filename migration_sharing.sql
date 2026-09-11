-- Run this in the Supabase SQL Editor to add Client Portal links,
-- Freelancer links, shot attachments, and simple task assignment.
-- Safe to run alongside your existing schema.

-- Public share link support for projects (Client Portal)
alter table projects add column if not exists share_token text;
alter table projects add column if not exists share_enabled boolean not null default false;
create unique index if not exists projects_share_token_idx on projects(share_token) where share_token is not null;

-- Public share link + simple assignment + attachments for shots (Freelancer link)
alter table shots add column if not exists share_token text;
alter table shots add column if not exists assigned_to text default '';
alter table shots add column if not exists attachments jsonb not null default '[]'::jsonb;
create unique index if not exists shots_share_token_idx on shots(share_token) where share_token is not null;

-- Public storage bucket for shot attachments and freelancer deliverables.
-- Public bucket + unguessable file paths, same security model as the share links themselves.
insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', true)
on conflict (id) do nothing;

-- Authenticated studio users can upload/manage files under their own user id folder
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'objects' and schemaname = 'storage'
      and policyname = 'Studio users manage their own attachment files'
  ) then
    create policy "Studio users manage their own attachment files"
      on storage.objects for all
      using (bucket_id = 'attachments' and auth.uid()::text = (storage.foldername(name))[1])
      with check (bucket_id = 'attachments' and auth.uid()::text = (storage.foldername(name))[1]);
  end if;
end $$;

-- Anyone can read files in the attachments bucket (needed for public download links)
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'objects' and schemaname = 'storage'
      and policyname = 'Public read access to attachments'
  ) then
    create policy "Public read access to attachments"
      on storage.objects for select
      using (bucket_id = 'attachments');
  end if;
end $$;

-- RPC: fetch a project's progress by share token, for the public Client Portal.
-- SECURITY DEFINER lets this bypass row-level security safely, since it only
-- ever returns data for the exact token passed in, never a full table scan.
create or replace function get_shared_project(p_token text)
returns table (
  project_name text,
  client_name text,
  deadline text,
  priority text,
  shot_title text,
  shot_stage text,
  shot_review_status text
)
language sql
security definer
set search_path = public
as $$
  select
    p.name as project_name,
    p.client as client_name,
    p.deadline,
    p.priority,
    s.title as shot_title,
    s.stage as shot_stage,
    s.review_status as shot_review_status
  from projects p
  left join shots s on s.project_id = p.id
  where p.share_token = p_token and p.share_enabled = true;
$$;

grant execute on function get_shared_project(text) to anon, authenticated;

-- RPC: fetch a single shot's brief and attachments by share token, for the
-- public Freelancer link.
create or replace function get_shared_shot(p_token text)
returns table (
  shot_title text,
  project_name text,
  studio_name text,
  stage text,
  review_status text,
  notes text,
  assigned_to text,
  attachments jsonb
)
language sql
security definer
set search_path = public
as $$
  select
    s.title as shot_title,
    p.name as project_name,
    coalesce(us.studio_name, 'Studio Kairegi') as studio_name,
    s.stage,
    s.review_status,
    s.notes,
    s.assigned_to,
    s.attachments
  from shots s
  join projects p on p.id = s.project_id
  left join user_settings us on us.user_id = s.user_id
  where s.share_token = p_token;
$$;

grant execute on function get_shared_shot(text) to anon, authenticated;
