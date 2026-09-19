-- =========================================================================
-- Audit fixes batch 11: enum-like columns had no database-level validation
-- =========================================================================
-- The React UI only ever writes a fixed set of values to these columns
-- (shots.stage, shots.priority, shots.review_status, projects.priority,
-- projects.budget_mode, projects.currency, invoices.status,
-- invoices.currency, expenses.currency), but nothing below the UI enforced
-- that. A direct Supabase REST/RPC call - or a future bug in the client -
-- could write an arbitrary string into any of these, and the shot/project
-- would then silently fall out of every place the UI branches on that
-- value (e.g. a shot with stage = 'banana' doesn't appear in any Kanban
-- column, but still exists and still counts toward totals).
--
-- These are added NOT VALID and then validated separately: NOT VALID skips
-- checking existing rows at ALTER time (so this can't fail to apply against
-- a database that already has a stray bad value sitting in it from before
-- this migration), while VALIDATE CONSTRAINT below immediately checks all
-- existing rows anyway and will raise if any of them actually violate it -
-- so this still surfaces pre-existing bad data instead of quietly
-- grandfathering it in, it just does so as a clear, named validation error
-- rather than an opaque ALTER TABLE failure.

-- Each constraint is dropped first so this migration can be re-run safely
-- (this project has no migration-history table to guarantee each file only
-- runs once, so every ALTER here needs to tolerate a second run).

alter table shots drop constraint if exists shots_stage_check;
alter table shots
  add constraint shots_stage_check
  check (stage in (
    'character_design', 'bg_lighting', 'storyboard', 'layout', 'genga',
    'douga', 'backgrounds', 'frametest', 'cleanup', 'compositing',
    'editing', 'delivered'
  )) not valid;
alter table shots validate constraint shots_stage_check;

alter table shots drop constraint if exists shots_priority_check;
alter table shots
  add constraint shots_priority_check
  check (priority in ('low', 'normal', 'rush')) not valid;
alter table shots validate constraint shots_priority_check;

alter table shots drop constraint if exists shots_review_status_check;
alter table shots
  add constraint shots_review_status_check
  check (review_status is null or review_status in ('in_progress', 'waiting', 'approved', 'revisions')) not valid;
alter table shots validate constraint shots_review_status_check;

alter table projects drop constraint if exists projects_priority_check;
alter table projects
  add constraint projects_priority_check
  check (priority in ('low', 'normal', 'rush')) not valid;
alter table projects validate constraint projects_priority_check;

alter table projects drop constraint if exists projects_budget_mode_check;
alter table projects
  add constraint projects_budget_mode_check
  check (budget_mode in ('manual', 'auto')) not valid;
alter table projects validate constraint projects_budget_mode_check;

alter table projects drop constraint if exists projects_currency_check;
alter table projects
  add constraint projects_currency_check
  check (currency in ('$', '¥', '€', '£', 'KSh')) not valid;
alter table projects validate constraint projects_currency_check;

alter table invoices drop constraint if exists invoices_status_check;
alter table invoices
  add constraint invoices_status_check
  check (status in ('unpaid', 'paid')) not valid;
alter table invoices validate constraint invoices_status_check;

alter table invoices drop constraint if exists invoices_currency_check;
alter table invoices
  add constraint invoices_currency_check
  check (currency in ('$', '¥', '€', '£', 'KSh')) not valid;
alter table invoices validate constraint invoices_currency_check;

alter table expenses drop constraint if exists expenses_currency_check;
alter table expenses
  add constraint expenses_currency_check
  check (currency in ('$', '¥', '€', '£', 'KSh')) not valid;
alter table expenses validate constraint expenses_currency_check;

