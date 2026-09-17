-- Fix-set audit, round 10. Run after every other migration, including
-- migration_audit_fixes_9.sql.
--
-- Covers the two DB-side changes in this pass:
--   1. leads.outcome_reason - a reason field kept separate from lead
--      stage, so "No budget" / "Not a fit" / etc. never get mixed into
--      pipeline-status logic again.
--   2. user_settings.notifications_enabled - the in-app on/off switch
--      for desktop notifications, independent of the browser's own
--      Notification permission.
--
-- Everything else in this pass (PiP sizing/content, timer right-side
-- layout, Active Days/Week explanation, Pipeline Breakdown typography)
-- is application-side only.

-- =========================================================================
-- 1. Lead outcome reason (replaces lost_reason as the field going forward)
-- =========================================================================
-- lost_reason only ever covered the "lost" stage, and had grown to include
-- things like "No response" that are really a *stage* (No Response),
-- not a reason. outcome_reason is the general field: it's meaningful on
-- lost, disqualified, closed and no_response, and its vocabulary depends
-- on which of those the lead is in (see DISQUALIFY_REASONS/LOST_REASONS
-- in App.jsx).
--
-- lost_reason is NOT dropped. The app writes both columns in lockstep on
-- every save and reads outcome_reason with a fallback to lost_reason, so
-- existing "lost" leads keep their recorded reason without a backfill,
-- and nothing reads a stale value out of the old column. Drop lost_reason
-- in a later pass once outcome_reason has been the only column written
-- for a while.
alter table leads
  add column if not exists outcome_reason text default '';

-- One-time backfill so already-lost leads show their reason under the new
-- column immediately, instead of waiting for their next save.
update leads
  set outcome_reason = lost_reason
  where (outcome_reason is null or outcome_reason = '')
    and lost_reason is not null
    and lost_reason <> '';

-- =========================================================================
-- 2. In-app notifications on/off
-- =========================================================================
-- Notification.permission (browser-granted/denied/default) is device-level
-- and was already handled without a DB column - see the comment on
-- notificationsSupported() in App.jsx. This is different: it's an
-- account-level preference ("don't notify me at all"), so it belongs
-- alongside the other user_settings toggles, not in browser storage.
alter table user_settings
  add column if not exists notifications_enabled boolean not null default true;
