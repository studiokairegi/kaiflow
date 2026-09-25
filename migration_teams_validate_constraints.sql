-- =========================================================================
-- Teams Module — validate the §28 constraint audit against live data
-- =========================================================================
-- migration_teams_constraints_audit.sql added its new CHECK constraints
-- as NOT VALID specifically because that session had no way to inspect
-- production data, and a plain ADD CONSTRAINT would have scanned and
-- potentially failed the whole migration over a single legacy violation.
--
-- That data has since actually been checked directly against the live
-- database and confirmed clean. This migration makes the guarantee
-- retroactive: VALIDATE CONSTRAINT scans existing rows now, under a
-- lighter lock than a fresh ADD CONSTRAINT would take, and does not block
-- concurrent reads. If any row unexpectedly fails validation despite the
-- earlier check, this migration fails loudly rather than silently - which
-- is what should happen; it means something changed and needs a decision,
-- not an automatic fix (brief §31: never silently rewrite production
-- data).
--
-- Idempotent: VALIDATE CONSTRAINT on an already-valid constraint is a
-- cheap no-op, so this is safe to run more than once.
-- =========================================================================

alter table team_members validate constraint team_members_availability_valid;
alter table team_members validate constraint team_members_rate_type_valid;
alter table team_members validate constraint team_members_capacity_unit_valid;
alter table team_members validate constraint team_members_capacity_value_nonneg;
alter table team_members validate constraint team_members_default_speed_value_nonneg;
alter table team_members validate constraint team_members_rate_amount_nonneg;
alter table team_members validate constraint team_members_availability_dates_ordered;

alter table team_member_rate_history validate constraint team_member_rate_history_rate_type_valid;
alter table team_member_rate_history validate constraint team_member_rate_history_amount_positive;
