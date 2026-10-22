-- Notification centre: per-user read / snooze state for existing activity_log rows.
--
-- This stores STATE ONLY (which activity ids a user has seen, snoozed or been reminded about).
-- The activity payload itself stays in activity_log and is never copied, so no private comment,
-- project name or file link is duplicated here.
--
-- Security model (mirrors activity_log, whose rows are owned by user_id):
--   * Both tables have RLS: a user can only SELECT their own rows.
--   * Authenticated users have NO direct INSERT/UPDATE/DELETE. All writes go through the
--     SECURITY DEFINER functions below, which use auth.uid() (never a client-supplied user id) and
--     only touch activity rows whose user_id = auth.uid().
--   * activity_id is text so this does not depend on activity_log.id's column type.
--
-- Rollout: run after the existing migrations. Idempotent (safe to re-run).
-- Rollback: drop the four functions and the two tables (see bottom).

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table if not exists public.notification_settings (
  user_id     uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  -- First-run cut-off: only activity created AFTER this moment is a notification, so turning the
  -- feature on does not flood the user with the whole history. Set once, on first use.
  baseline_at timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create table if not exists public.notification_state (
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  activity_id    text not null,
  read_at        timestamptz,   -- set when the notification centre is opened with it visible
  opened_at      timestamptz,   -- time of the latest click-through on the item itself
  snoozed_until  timestamptz,   -- server time + 5 minutes when snoozed
  reminded_until timestamptz,   -- = snoozed_until once the reminder for that snooze was shown
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (user_id, activity_id)   -- one row per recipient per event: idempotent
);

create index if not exists notification_state_user_snooze_idx
  on public.notification_state (user_id, snoozed_until) where snoozed_until is not null;

-- Supports the bounded, newest-first feed query (user + time). Harmless if an equivalent exists.
create index if not exists activity_log_user_created_idx
  on public.activity_log (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 2. RLS: read own rows only; no direct writes
-- ---------------------------------------------------------------------------
alter table public.notification_settings enable row level security;
alter table public.notification_state    enable row level security;

revoke all on public.notification_settings, public.notification_state from anon, authenticated;
grant select on public.notification_settings, public.notification_state to authenticated;

drop policy if exists "Owner reads notification_settings" on public.notification_settings;
create policy "Owner reads notification_settings" on public.notification_settings
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "Owner reads notification_state" on public.notification_state;
create policy "Owner reads notification_state" on public.notification_state
  for select to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 3. Functions (the only write path)
-- ---------------------------------------------------------------------------

-- Creates the user's first-run baseline if missing and returns it.
create or replace function public.notification_init()
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_baseline timestamptz;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  insert into notification_settings (user_id) values (v_uid) on conflict (user_id) do nothing;
  select baseline_at into v_baseline from notification_settings where user_id = v_uid;
  return v_baseline;
end;
$$;

-- Marks the given activity ids as seen. p_opened = true also records a click-through on the item.
-- Only ids that belong to the caller's own activity are accepted; anything else is ignored.
-- read_at: first acknowledgement wins. opened_at: latest click-through wins, so a re-snoozed item
-- is only considered handled by a click made after the new snooze began.
create or replace function public.ack_notifications(p_activity_ids text[], p_opened boolean default false)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_count integer;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if p_activity_ids is null or cardinality(p_activity_ids) = 0 then return 0; end if;
  if cardinality(p_activity_ids) > 200 then raise exception 'too_many_ids' using errcode = 'P0001'; end if;

  insert into notification_state (user_id, activity_id, read_at, opened_at)
  select v_uid, a.id::text, now(), case when p_opened then now() else null end
    from activity_log a
   where a.user_id = v_uid and a.id::text = any(p_activity_ids)
  on conflict (user_id, activity_id) do update
    set read_at    = coalesce(notification_state.read_at, now()),
        opened_at  = case when p_opened then now() else notification_state.opened_at end,
        updated_at = now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Snoozes one notification for five minutes (fixed, server clock, so client clock skew can't
-- shorten or lengthen it). Does not touch read_at / opened_at. Returns the new snoozed_until,
-- or null if the activity is not the caller's.
create or replace function public.snooze_notification(p_activity_id text)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_until timestamptz := now() + interval '5 minutes';
  v_rows integer;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  insert into notification_state (user_id, activity_id, snoozed_until)
  select v_uid, a.id::text, v_until from activity_log a
   where a.user_id = v_uid and a.id::text = p_activity_id
  on conflict (user_id, activity_id) do update
    set snoozed_until = v_until, updated_at = now();
  get diagnostics v_rows = row_count;
  if v_rows = 0 then return null; end if;
  return v_until;
end;
$$;

-- Records that the reminder for the current (expired) snooze was shown, so other tabs/sessions
-- don't show it again. Does nothing for a snooze that hasn't expired yet.
create or replace function public.mark_notifications_reminded(p_activity_ids text[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_count integer;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if p_activity_ids is null or cardinality(p_activity_ids) = 0 then return 0; end if;
  if cardinality(p_activity_ids) > 200 then raise exception 'too_many_ids' using errcode = 'P0001'; end if;
  update notification_state
     set reminded_until = snoozed_until, updated_at = now()
   where user_id = v_uid
     and activity_id = any(p_activity_ids)
     and snoozed_until is not null and snoozed_until <= now()
     and reminded_until is distinct from snoozed_until;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.notification_init() from public, anon;
revoke all on function public.ack_notifications(text[], boolean) from public, anon;
revoke all on function public.snooze_notification(text) from public, anon;
revoke all on function public.mark_notifications_reminded(text[]) from public, anon;
grant execute on function public.notification_init() to authenticated;
grant execute on function public.ack_notifications(text[], boolean) to authenticated;
grant execute on function public.snooze_notification(text) to authenticated;
grant execute on function public.mark_notifications_reminded(text[]) to authenticated;

-- Rollback (manual):
--   drop function if exists public.mark_notifications_reminded(text[]);
--   drop function if exists public.snooze_notification(text);
--   drop function if exists public.ack_notifications(text[], boolean);
--   drop function if exists public.notification_init();
--   drop table if exists public.notification_state;
--   drop table if exists public.notification_settings;
