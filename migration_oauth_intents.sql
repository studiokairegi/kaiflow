-- Replaces the OAuth connect flow's two related weaknesses:
--   1. The studio's Supabase access token was passed as ?token=... in a
--      plain GET URL (google-drive-connect / patreon-connect), which can
--      end up in browser history, proxy logs, or referrer headers - an
--      access token is a real bearer credential, not something that
--      should ever be in a URL.
--   2. The OAuth `state` was just `userId.signature` - proves the state
--      was generated for that user, but nothing stops the same state
--      value being replayed, and it never expires.
--
-- Both are fixed by the same mechanism: a short-lived, single-use,
-- DB-backed "intent" row. The client authenticates normally (Authorization
-- header, not a URL) to mint one via the new oauth-start-intent function,
-- then the browser is redirected using only that intent's opaque id - not
-- the real access token - and that same id becomes the OAuth `state`,
-- consumed exactly once at redirect time and exactly once again at
-- callback time.
create table if not exists oauth_connect_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('google_drive', 'patreon')),
  created_at timestamptz not null default now(),
  redirected_at timestamptz,
  completed_at timestamptz
);

-- Only the service-role Edge Functions ever read/write this table -
-- there's no reason for it to be reachable from the browser at all, so
-- RLS with no policies (deny-all to anon/authenticated) is intentional
-- here, not an oversight.
alter table oauth_connect_intents enable row level security;

-- Old, short-lived rows have no ongoing purpose once they've expired -
-- keeping them around indefinitely is just unbounded table growth for no
-- benefit. Cheap to prune whenever this migration runs.
delete from oauth_connect_intents where created_at < now() - interval '1 day';
