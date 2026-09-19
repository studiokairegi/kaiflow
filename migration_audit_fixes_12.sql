-- =========================================================================
-- Audit fixes batch 12: free-plan-limit race + server-side Pro currency gate
-- =========================================================================
-- Two related "the UI enforces this, the database only mostly does" gaps,
-- both flagged across the audit passes:
--
-- 1. enforce_project_limit() / enforce_project_unarchive_limit() (from
--    migration_security_hardening.sql) do `select count(*) ... >= 3` then
--    let the INSERT/UPDATE proceed. Two concurrent requests for the same
--    user (two tabs, a retry racing the original) can both run that count
--    before either commits, both see e.g. 2, and both proceed - landing at
--    4 active projects instead of 3. A Postgres row lock doesn't help here
--    because there's no existing row to lock: the count is over rows that
--    may not exist yet from either transaction's point of view.
--
-- 2. The project currency selector is hidden behind hasProAccess in the
--    React editor, but nothing stopped a free-plan user from writing a
--    non-default currency directly via the Supabase client - same class of
--    issue migration_security_hardening.sql already closed for is_admin/
--    plan and the project/budget-planner counts, just not extended to this
--    one field.

-- =========================================================================
-- 1. Serialize the free-plan project-limit check per user
-- =========================================================================
-- pg_advisory_xact_lock is a session/transaction-scoped lock keyed on an
-- arbitrary bigint - here, a hash of the user's id. It's held until the
-- transaction commits or rolls back, so two concurrent inserts for the
-- same user now queue behind each other at this line instead of both
-- reading the same stale count: the second transaction's count(*) can't
-- run until the first has either committed (and its new row is visible)
-- or rolled back. Different users hash to different keys (in practice;
-- hashtext collisions are possible but only ever cost an unrelated user a
-- moment's serialization, never a wrong count), so this doesn't serialize
-- unrelated users against each other.
create or replace function public.enforce_project_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() = 'service_role' then
    return new;
  end if;
  if new.archived is distinct from true and not public.user_has_pro_access(new.user_id) then
    perform pg_advisory_xact_lock(hashtext('project_limit:' || new.user_id::text));
    if (select count(*) from projects where user_id = new.user_id and archived is not true) >= 3 then
      raise exception 'Free plan is limited to 3 active projects. Archive one or upgrade to Pro.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.enforce_project_unarchive_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() = 'service_role' then
    return new;
  end if;
  if old.archived is true and new.archived is distinct from true and not public.user_has_pro_access(new.user_id) then
    perform pg_advisory_xact_lock(hashtext('project_limit:' || new.user_id::text));
    if (select count(*) from projects where user_id = new.user_id and archived is not true and id <> new.id) >= 3 then
      raise exception 'Free plan is limited to 3 active projects. Archive one or upgrade to Pro.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

-- Same fix for the budget-planner cap, which has the identical race.
create or replace function public.enforce_budget_planner_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() = 'service_role' then
    return new;
  end if;
  if not public.user_has_pro_access(new.user_id) then
    perform pg_advisory_xact_lock(hashtext('budget_planner_limit:' || new.user_id::text));
    if (select count(*) from budget_planners where user_id = new.user_id) >= 3 then
      raise exception 'Free plan is limited to 3 budget plans. Delete one or upgrade to Pro.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

-- =========================================================================
-- 2. Server-side enforcement of the Pro-only project currency
-- =========================================================================
-- Free-plan projects should always stay on the studio's default currency
-- (user_settings.currency_symbol) - the React editor already only shows
-- that value with no selector for free users. This makes it a real rule:
-- a free-plan user setting projects.currency to anything else, however
-- they do it, gets rejected with the same message the UI already shows.
create or replace function public.enforce_project_currency_plan()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_studio_currency text;
begin
  if auth.role() = 'service_role' then
    return new;
  end if;
  if public.user_has_pro_access(new.user_id) then
    return new;
  end if;
  select currency_symbol into v_studio_currency from user_settings where user_id = new.user_id;
  if v_studio_currency is null then
    v_studio_currency := '$';
  end if;
  if new.currency is distinct from v_studio_currency then
    raise exception 'Multiple currencies are a Pro feature. Upgrade to Pro to use a different currency.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_project_currency_plan on projects;
create trigger trg_enforce_project_currency_plan
before insert or update on projects
for each row execute function public.enforce_project_currency_plan();
