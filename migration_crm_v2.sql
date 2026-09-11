-- Run this in the Supabase SQL Editor to upgrade the Leads/CRM module:
-- priority, needs-follow-up flag, activity history, and archiving.
-- Safe to run alongside your existing schema and the earlier
-- migration_lead_channels.sql; only adds new columns/objects.

alter table leads add column if not exists priority text not null default 'warm';
alter table leads add column if not exists needs_followup boolean not null default false;
alter table leads add column if not exists last_contacted_at timestamptz;
alter table leads add column if not exists activity_log jsonb not null default '[]'::jsonb;
alter table leads add column if not exists archived_at timestamptz;
-- When the lead last changed stage. Used by the archiving job below so
-- "30 days after Won" means 30 days after it *became* Won, not 30 days
-- since the lead was first created.
alter table leads add column if not exists stage_changed_at timestamptz not null default now();

-- One-time data migration: the old "Successful Leads" column doesn't exist
-- in the new lifecycle (New -> Cold Email Sent -> Responded -> Qualified ->
-- Proposal Sent -> Negotiation -> Won, with Lost / No Response /
-- Disqualified / Closed as terminal outcomes). Fold any existing
-- "successful" leads into "qualified", the closest equivalent.
update leads set stage = 'qualified' where stage = 'successful';

-- Backfill stage_changed_at for existing rows so the archiving job doesn't
-- treat every pre-existing lead as having just changed stage.
update leads set stage_changed_at = created_at where stage_changed_at is null or stage_changed_at = created_at;

create index if not exists leads_channel_idx on leads(channel);
create index if not exists leads_archived_at_idx on leads(archived_at);
create index if not exists leads_stage_idx on leads(stage);

alter table user_settings add column if not exists followup_schedule jsonb not null default '[
  {"label":"Initial email","dayOffset":0},
  {"label":"Follow-up #1","dayOffset":3},
  {"label":"Follow-up #2","dayOffset":7},
  {"label":"Follow-up #3","dayOffset":14},
  {"label":"Follow-up #4","dayOffset":21}
]'::jsonb;

-- ---------------------------------------------------------------------
-- Automatic archiving
-- ---------------------------------------------------------------------
-- Archiving is NOT implemented as frontend logic that only runs when
-- someone happens to have the app open — that would silently skip leads
-- for studios that don't open the app every day. Instead this is a real
-- database-side job:
--
--   1. archive_stale_leads() is a plain SQL function that archives (sets
--      archived_at, never deletes) any lead that has sat in a terminal
--      stage (Won/Lost/No Response/Disqualified/Closed) longer than its
--      default grace period. It's SECURITY DEFINER so it can run across
--      every studio's leads in one pass, but it still only ever touches
--      rows -- it goes through no API and bypasses no policy the RLS
--      itself would reject if you ran it as a normal user.
--   2. A pg_cron schedule calls it once a day.
--
-- pg_cron ships with Supabase but is off by default. Enable it once from
-- the Supabase dashboard: Database -> Extensions -> search "pg_cron" ->
-- Enable. (It can also be enabled with `create extension pg_cron;` if
-- you're connected as a superuser, which the SQL Editor's default role
-- usually is not.) After that, run the two statements below once.
--
-- If your project is on a plan without pg_cron, the same function can be
-- called on a schedule from a Supabase Edge Function triggered by an
-- external cron (e.g. GitHub Actions, cron-job.org) hitting a small edge
-- function that does `select archive_stale_leads();` -- ask if you'd like
-- that written out; it's a ~10 line function.

create or replace function public.archive_stale_leads()
returns void
language sql
security definer
set search_path = public
as $$
  update leads
  set archived_at = now()
  where archived_at is null
    and (
      (stage = 'won' and now() - stage_changed_at > interval '30 days') or
      (stage = 'lost' and now() - stage_changed_at > interval '60 days') or
      (stage = 'no_response' and now() - stage_changed_at > interval '60 days') or
      (stage = 'disqualified' and now() - stage_changed_at > interval '30 days') or
      (stage = 'closed' and now() - stage_changed_at > interval '30 days')
    );
$$;

-- Only the function owner (postgres) can execute it directly; regular
-- users still can't call it to archive other studios' leads.
revoke all on function public.archive_stale_leads() from public, anon, authenticated;

-- Run once pg_cron is enabled:
-- select cron.schedule('archive-stale-leads', '0 3 * * *', 'select public.archive_stale_leads();');
--
-- To check it's scheduled: select * from cron.job;
-- To run it by hand right now (e.g. to test): select public.archive_stale_leads();
-- To unschedule later: select cron.unschedule('archive-stale-leads');

-- The archive_days thresholds above (30/60/60/30/30) are the MVP
-- defaults from the spec. Making them configurable per-studio would mean
-- either parameterizing this function with a settings lookup per row, or
-- reading user_settings.archive_days (not yet added) inside the loop --
-- deliberately deferred for now to keep this function simple; ask if
-- you'd like that added.
