-- Run this in the Supabase SQL Editor to add Settings and Dashboard support.
-- Safe to run alongside your existing schema.

alter table invoices add column if not exists paid_date text default '';

create table if not exists user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  studio_name text not null default 'Studio Kairegi',
  studio_tagline text not null default 'Anime-style animation & production',
  currency_symbol text not null default '$',
  milestone_defaults jsonb not null default '[50,25,25]'::jsonb,
  updated_at timestamptz default now()
);

alter table user_settings enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'user_settings' and policyname = 'Users manage their own settings'
  ) then
    create policy "Users manage their own settings"
      on user_settings for all
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end $$;
