-- Fixes from a 3-AI audit of the previous delivery. Run this after every
-- other migration, including migration_audit_fixes_2/3/4.sql - it corrects
-- a real mistake in migration_audit_fixes_2.sql (see #1) and closes a
-- genuine privilege-escalation path on patreon_connections (see #2/#3)
-- that mirrors the one already fixed on user_settings.

-- =========================================================================
-- 1. Actually-correct final get_shared_shot() - my earlier "final" version
--    in migration_audit_fixes_2.sql was wrong and needs to be superseded.
-- =========================================================================
-- migration_audit_fixes_2.sql's get_shared_shot() returned id/title/status/
-- reference_url/project_client - none of which are real: shots has no
-- `status` or `reference_url` column (it has `stage` and `review_status`),
-- and there's no `shots.share_enabled` column either (only `share_token`;
-- `share_enabled` exists on projects, not shots) - so that "final" version
-- would error with "column does not exist" on every single call, breaking
-- every freelancer share link outright. It never should have shipped.
--
-- migration_activity_uploads.sql's version was actually correct and
-- matched SharedViews.jsx (shot_title, project_name, studio_name, stage,
-- review_status, notes, assigned_to, attachments, deliverables) - this
-- restores exactly that shape as the true final, authoritative version.
create or replace function get_shared_shot(p_token text)
returns table (
  shot_title text,
  project_name text,
  studio_name text,
  stage text,
  review_status text,
  notes text,
  assigned_to text,
  attachments jsonb,
  deliverables jsonb
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
    s.attachments,
    s.deliverables
  from shots s
  join projects p on p.id = s.project_id
  left join user_settings us on us.user_id = s.user_id
  where s.share_token = p_token;
$$;

grant execute on function get_shared_shot(text) to anon, authenticated;

-- =========================================================================
-- 2. Lock down patreon_connections - it should never have been client-
--    writable at all.
-- =========================================================================
-- Same class of bug as the user_settings privilege-escalation fix, applied
-- to a table I missed at the time. The existing policy is
-- `for all using (auth.uid() = user_id) with check (auth.uid() = user_id)`,
-- which lets any signed-in user directly UPDATE their own row's
-- patreon_user_id, is_pro, refresh_token_encrypted, and connected_email.
-- The app never writes this table from the client (only patreon-callback/
-- patreon-webhook do, via the service-role key, which bypasses RLS
-- entirely) - so there was never a reason for this to be more than
-- read-only for normal users.
--
-- The real risk isn't just "a user sets their own is_pro=true" (that alone
-- grants nothing - hasProAccess reads user_settings.plan/is_admin, which
-- is already locked down). The actual path is worse: a user rewrites
-- their own row's patreon_user_id to match a *different*, real patron's
-- Patreon id. The next time that real patron's Patreon activity fires a
-- webhook, patreon-webhook looks up patreon_connections by patreon_user_id,
-- finds the attacker's row (since they just pointed it at that id), and
-- grants the attacker - not the real patron - the Pro upgrade via the
-- webhook's service-role write.
drop policy if exists "Users manage their own Patreon connection" on patreon_connections;

create policy "Users can view their own Patreon connection"
  on patreon_connections for select
  using (auth.uid() = user_id);

-- Deliberately no insert/update/delete policy for authenticated/anon:
-- only the service role (patreon-callback, patreon-webhook) can write
-- this table now, which matches how the app has always actually used it.

-- =========================================================================
-- 3. Make the patreon_user_id index actually unique
-- =========================================================================
-- migration_patreon.sql created a plain (non-unique) index named
-- patreon_connections_patreon_user_id_idx. migration_audit_fixes_3.sql
-- later tried `create unique index if not exists` with that *same name* -
-- but IF NOT EXISTS matches on name only, so since an index with that name
-- already existed (just not a unique one), it silently did nothing. The
-- non-unique index has been sitting there the whole time; two Kairil
-- accounts could still both link the same Patreon account, which is
-- exactly the case the earlier fix was supposed to prevent.
drop index if exists patreon_connections_patreon_user_id_idx;

create unique index if not exists patreon_connections_patreon_user_id_unique_idx
  on patreon_connections(patreon_user_id)
  where patreon_user_id != '';

-- Run this first if you want to check for existing duplicates before
-- this index would block them going forward (it won't fail retroactively -
-- CREATE UNIQUE INDEX only rejects duplicates encountered on future writes
-- once the previous index sharing its name is gone; if duplicates already
-- exist in the table today, this command itself will fail until they're
-- resolved):
--   select patreon_user_id, count(*) from patreon_connections
--   where patreon_user_id != '' group by patreon_user_id having count(*) > 1;
