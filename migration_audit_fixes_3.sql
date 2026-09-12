-- More fixes from the deeper second-pass review. Run after
-- migration_audit_fixes_2.sql and migration_drive_uploads.sql.

-- =========================================================================
-- 1. Enforce Pro-only Client Portal / Freelancer links at the DB level
-- =========================================================================
-- Both are currently gated only by hiding the toggle/button in React
-- (ProjectEditor's "Client sharing" checkbox, CardEditor's "Generate
-- freelancer link" button) - a free-plan user could enable either
-- directly via the Supabase client, and both create real, externally
-- reachable functionality (a public portal URL), unlike a feature that's
-- merely hidden UI. Same pattern as the project/budget-planner limit
-- triggers: block turning it ON if not Pro, don't force-disable one
-- that's already on (e.g. after a downgrade) since that would silently
-- break a link someone already handed to a client mid-project.
create or replace function public.enforce_client_portal_pro_gate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() = 'service_role' then
    return new;
  end if;
  if new.share_enabled = true
     and (TG_OP = 'INSERT' or old.share_enabled is distinct from true)
     and not public.user_has_pro_access(new.user_id) then
    raise exception 'Client Portal is a Pro feature.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_client_portal_pro_gate on projects;
create trigger trg_enforce_client_portal_pro_gate
before insert or update on projects
for each row execute function public.enforce_client_portal_pro_gate();

create or replace function public.enforce_freelancer_link_pro_gate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() = 'service_role' then
    return new;
  end if;
  if new.share_token is not null
     and (TG_OP = 'INSERT' or old.share_token is null)
     and not public.user_has_pro_access(new.user_id) then
    raise exception 'Freelancer links are a Pro feature.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_freelancer_link_pro_gate on shots;
create trigger trg_enforce_freelancer_link_pro_gate
before insert or update on shots
for each row execute function public.enforce_freelancer_link_pro_gate();

-- =========================================================================
-- 2. stage_changed_at: defensive DB-level backstop
-- =========================================================================
-- Checked the client directly: both handleSaveLead and moveLeadStage
-- (drag-and-drop) already correctly set stage_changed_at whenever stage
-- changes - this isn't fixing a live bug in the editor. Adding it anyway
-- as a backstop against direct API writes, same reasoning as the
-- project/planner limit triggers: the archive job's correctness
-- shouldn't depend on every future write path remembering to set this.
create or replace function public.set_lead_stage_changed_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'INSERT' or old.stage is distinct from new.stage then
    new.stage_changed_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_set_lead_stage_changed_at on leads;
create trigger trg_set_lead_stage_changed_at
before insert or update on leads
for each row execute function public.set_lead_stage_changed_at();

-- =========================================================================
-- 3. Financial sanity constraints
-- =========================================================================
-- Added NOT VALID so this can't fail the migration against whatever's
-- already in a live database - it applies to every new insert/update
-- immediately, but doesn't retroactively require existing rows to pass.
-- Run `validate constraint` yourself once you've confirmed/cleaned up any
-- existing negative values (see the SELECT queries below the constraints).
-- projects.budget is stored as free-text (parsed client-side, supports
-- multiple currencies/formats), not numeric, so it isn't included here -
-- retrofitting a numeric CHECK onto an existing free-text column risks
-- rejecting real historical data with no clean way to validate it first.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'invoices_amount_nonneg') then
    alter table invoices add constraint invoices_amount_nonneg check (amount >= 0) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'invoices_amount_paid_nonneg') then
    alter table invoices add constraint invoices_amount_paid_nonneg check (amount_paid >= 0) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'invoices_paid_not_over_amount') then
    alter table invoices add constraint invoices_paid_not_over_amount check (amount_paid <= amount) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'expenses_amount_nonneg') then
    alter table expenses add constraint expenses_amount_nonneg check (amount >= 0) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'budget_planners_budget_nonneg') then
    alter table budget_planners add constraint budget_planners_budget_nonneg check (budget >= 0) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'budget_planners_profit_pct_range') then
    alter table budget_planners add constraint budget_planners_profit_pct_range check (target_profit_percent between 0 and 100) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'budget_planners_contingency_nonneg') then
    alter table budget_planners add constraint budget_planners_contingency_nonneg check (contingency_percent >= 0) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'team_members_rate_amount_nonneg') then
    alter table team_members add constraint team_members_rate_amount_nonneg check (rate_amount >= 0) not valid;
  end if;
end $$;

-- Run these yourself to see what (if anything) would fail validation:
--   select id, amount, amount_paid from invoices where amount < 0 or amount_paid < 0 or amount_paid > amount;
--   select id, amount from expenses where amount < 0;
--   select id, budget from budget_planners where budget < 0;
--   select id, target_profit_percent from budget_planners where target_profit_percent not between 0 and 100;
--   select id, contingency_percent from budget_planners where contingency_percent < 0;
--   select id, rate_amount from team_members where rate_amount < 0;
-- Once each is empty (or you've fixed the offending rows), validate with e.g.:
--   alter table invoices validate constraint invoices_amount_nonneg;

-- =========================================================================
-- 4. Unique index on patreon_user_id
-- =========================================================================
create unique index if not exists patreon_connections_patreon_user_id_idx
  on patreon_connections(patreon_user_id)
  where patreon_user_id != '';
