-- Run this in the Supabase SQL Editor to add Patreon membership syncing.
-- Safe to run alongside your existing schema.

-- Holds the studio's own campaign id, discovered automatically the first
-- time the creator (you) connects Patreon, rather than needing it typed in
-- as a secret. Deliberately a single row: this app has exactly one campaign.
create table if not exists patreon_campaign_config (
  id boolean primary key default true,
  campaign_id text not null,
  discovered_at timestamptz default now(),
  constraint patreon_campaign_config_singleton check (id)
);

-- RLS enabled with no policies at all, on purpose: the only code that ever
-- needs to touch this table is the Edge Functions, which use the service
-- role key and bypass RLS entirely regardless of policy. With RLS on and
-- zero permissive policies, every other role (including any signed-in
-- user calling the Supabase client directly from the browser) is denied
-- by default. Leaving RLS off here would have let any authenticated user
-- read or overwrite this shared config table directly.
alter table patreon_campaign_config enable row level security;

create table if not exists patreon_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  patreon_user_id text not null default '',
  connected_email text default '',
  refresh_token_encrypted text not null,
  is_pro boolean not null default false,
  connected_at timestamptz default now()
);

alter table patreon_connections enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'patreon_connections' and policyname = 'Users manage their own Patreon connection'
  ) then
    create policy "Users manage their own Patreon connection"
      on patreon_connections for all
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end $$;

-- Used by the webhook to look up which Kairil account a given Patreon
-- member corresponds to, without needing to scan the whole table.
create index if not exists patreon_connections_patreon_user_id_idx
  on patreon_connections(patreon_user_id);
