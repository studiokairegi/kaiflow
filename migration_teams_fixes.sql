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

-- Per-project and per-invoice currency selection
alter table projects add column if not exists currency text not null default '$';
alter table invoices add column if not exists currency text not null default '$';

-- More personalized settings: default landing tab, default shot priority, studio logo
alter table user_settings add column if not exists default_landing_tab text not null default 'dashboard';
alter table user_settings add column if not exists default_shot_priority text not null default 'normal';
alter table user_settings add column if not exists logo_url text default '';

-- Per-project and per-invoice currency selection
alter table projects add column if not exists currency text not null default '$';
alter table invoices add column if not exists currency text not null default '$';

-- Additional personalization settings
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

-- The Freelancer share-link RPC needs to also return payment info now
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
