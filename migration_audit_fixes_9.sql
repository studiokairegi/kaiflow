-- Dashboard module audit fixes. Run after every other migration,
-- including migration_audit_fixes_8.sql.
--
-- NOTE: this is the only DB change the dashboard audit needs. Every other
-- fix in that pass (Active-leads definition, the outreach funnel's switch
-- to activity-log events, the date-range filter, the Today figures, the
-- local-timezone date parsing) is application-side only.

-- =========================================================================
-- 1. Per-channel dashboard visibility
-- =========================================================================
-- Backs the Shown/Hidden toggle on each channel in Settings > Lead
-- channels. Stores which channels are hidden from the Dashboard's "Leads
-- by channel" donut. Mirrors lead_channels' own jsonb-array-on-
-- user_settings pattern (see migration_lead_channels.sql) rather than
-- introducing a new table, since this is a small per-studio display
-- preference and not CRM data.
--
-- Deliberately stores the HIDDEN set, not the visible set, so a newly
-- added channel (via Settings or the lead editor's "+" button) appears on
-- the dashboard by default instead of silently disappearing until it's
-- opted back in.
--
-- Hiding is presentation-only: a channel listed here is still selectable
-- on leads, still works as a filter chip on the CRM board, and is still
-- counted in every other figure on the dashboard.
alter table user_settings
  add column if not exists dashboard_hidden_channels jsonb not null default '[]'::jsonb;
