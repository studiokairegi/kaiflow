-- =========================================================================
-- Teams Module — Phase 6: database constraint audit (brief §28)
-- =========================================================================
-- Reviews and strengthens constraints on Team data that earlier Teams
-- migrations left unvalidated. Additive/idempotent - every constraint is
-- guarded with an existence check, so this is safe to run repeatedly and
-- alongside the other migration_teams_*.sql files.
--
-- What was already covered by earlier migrations (not duplicated here):
--   - team_members_status_valid, team_members_member_type_valid,
--     team_members_upwork_rating_valid, team_members_upwork_review_count_valid
--     (migration_teams_phase1_safety.sql / migration_teams_freelancer_payments_ratehistory.sql)
--   - team_members_skill_level_range, team_members_dependability_range
--     (migration_teams_crew_allocation.sql)
--   - team_member_reviews_rating_valid (migration_teams_portfolio_reviews.sql)
--   - cross-user ownership + Pro entitlement (triggers, multiple files)
--
-- What this migration adds: the remaining fields the brief calls out by
-- name - rate type, availability, capacity unit, capacity >= 0, speed >=
-- 0, availability date ordering, currency, foreign keys - that had a
-- default but no actual validation.
-- =========================================================================

do $$
begin
  -- Availability: the app only ever writes 'available' | 'busy' |
  -- 'unavailable' (AVAILABILITY_OPTIONS in App.jsx), but nothing stopped
  -- a direct client write from setting anything else, which would then
  -- fail to match any AVAILABILITY_LABELS entry and render as a raw,
  -- unrecognized string in the UI.
  if not exists (select 1 from pg_constraint where conname = 'team_members_availability_valid') then
    alter table team_members
      add constraint team_members_availability_valid
      check (availability in ('available', 'busy', 'unavailable')) not valid;
  end if;

  -- Rate type: must match RATE_TYPE_OPTIONS (App.jsx) - an unrecognized
  -- value would silently break formatMemberRate()'s suffix lookup and
  -- the crew-allocation rate-type mapping used by the Planner.
  if not exists (select 1 from pg_constraint where conname = 'team_members_rate_type_valid') then
    alter table team_members
      add constraint team_members_rate_type_valid
      check (rate_type in ('hour', 'day', 'shot', 'second', 'fixed')) not valid;
  end if;

  -- Capacity unit: must match CAPACITY_UNIT_OPTIONS (App.jsx).
  if not exists (select 1 from pg_constraint where conname = 'team_members_capacity_unit_valid') then
    alter table team_members
      add constraint team_members_capacity_unit_valid
      check (capacity_unit in ('hours/week', 'days/week', 'shots/week')) not valid;
  end if;

  -- Capacity/speed/rate amounts: negative numbers here would silently
  -- corrupt Planner fit-scoring and cost math (which assumes non-negative
  -- inputs throughout) without ever raising an error.
  if not exists (select 1 from pg_constraint where conname = 'team_members_capacity_value_nonneg') then
    alter table team_members add constraint team_members_capacity_value_nonneg check (capacity_value >= 0) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'team_members_default_speed_value_nonneg') then
    alter table team_members add constraint team_members_default_speed_value_nonneg check (default_speed_value >= 0) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'team_members_rate_amount_nonneg') then
    alter table team_members add constraint team_members_rate_amount_nonneg check (rate_amount >= 0) not valid;
  end if;

  -- Availability window ordering: an end date before the start date is
  -- always a data-entry mistake, never a legitimate state, and would
  -- otherwise silently confuse any Planner logic that reads the window.
  if not exists (select 1 from pg_constraint where conname = 'team_members_availability_dates_ordered') then
    alter table team_members
      add constraint team_members_availability_dates_ordered
      check (available_start_date is null or available_end_date is null or available_start_date <= available_end_date) not valid;
  end if;
end $$;

-- Rate history rows are written only by the server-side trigger (never
-- directly by the client - see migration_teams_freelancer_payments_ratehistory.sql),
-- but the same validation is worth having here too: it protects against a
-- future trigger change accidentally inserting bad data, at negligible cost.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'team_member_rate_history_rate_type_valid') then
    alter table team_member_rate_history
      add constraint team_member_rate_history_rate_type_valid
      check (rate_type in ('hour', 'day', 'shot', 'second', 'fixed')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'team_member_rate_history_amount_positive') then
    alter table team_member_rate_history
      add constraint team_member_rate_history_amount_positive
      check (rate_amount > 0) not valid;
  end if;
end $$;

-- payment_method is deliberately left unconstrained at the database
-- level: brief §13 makes it a per-studio configurable list
-- (user_settings.payment_method_options), so a fixed database CHECK
-- would contradict that configurability. It's validated against the
-- studio's own list client-side, where that list is actually known -
-- see "Do not duplicate conflicting validation between frontend and
-- database unnecessarily" (§28).

-- Currency fields (rate_currency, payment_currency, projects.currency,
-- etc.) are also left unconstrained: this app already accepts either a
-- symbol ("$", "€") or a code ("USD") depending on where it's entered
-- (see DEFAULT_SETTINGS/currency handling elsewhere in the app), so a
-- fixed enum or ISO-4217 format check would reject values the rest of
-- the app already treats as valid.

-- team_members foreign key (user_id -> auth.users) and every new table's
-- team_member_id -> team_members FK already exist from the CREATE TABLE
-- statements that introduced them; nothing to add here. Ownership
-- (a row's user_id actually matching its parent's) is enforced by the
-- trigger functions in the other migration_teams_*.sql files, since a
-- plain FK can't express "same owner as," only "exists somewhere."

-- -------------------------------------------------------------------------
-- Why NOT VALID
-- -------------------------------------------------------------------------
-- Every constraint added above uses NOT VALID: it's enforced for every
-- new insert/update from the moment this migration runs, but Postgres
-- does NOT retroactively scan and validate existing rows against it. A
-- plain ADD CONSTRAINT would do that scan as part of the migration
-- itself, and fail the whole statement (and, depending on how the
-- migration is run, potentially everything after it) if even one
-- existing row violates the new rule - e.g. a team member with a
-- capacity_unit value that predates CAPACITY_UNIT_OPTIONS being fixed to
-- exactly three choices. This session has no way to inspect the studio's
-- actual production data, so NOT VALID is the only version of "safe and
-- additive" (per brief §30/§31) that can be guaranteed without that
-- visibility.
--
-- Recommended follow-up, once someone with real database access can
-- check for violations:
--   1. Find any existing rows that would fail each constraint, e.g.:
--        select id, availability from team_members
--        where availability not in ('available', 'busy', 'unavailable');
--   2. Fix or intentionally leave those rows (a manual decision, not an
--      automatic one - see brief §31, never silently rewrite production
--      data).
--   3. Once clean, run VALIDATE CONSTRAINT for each one to make the
--      guarantee retroactive, e.g.:
--        alter table team_members validate constraint team_members_availability_valid;
--      (VALIDATE CONSTRAINT takes a lighter lock than adding the
--      constraint fresh would, and doesn't block concurrent reads.)
--
-- UPDATE: this was done. Live data was checked directly and found clean
-- against every constraint above - see migration_teams_validate_constraints.sql,
-- which runs step 3 for all nine constraints added here.
