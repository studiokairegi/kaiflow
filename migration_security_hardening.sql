-- Security hardening from the full-codebase audit. Two independent issues,
-- both closed here:
--
-- 1. CRITICAL: user_settings' RLS policy is row-level ("for all using
--    (auth.uid() = user_id)"), not column-level, so any signed-in user
--    could previously call the client directly and set their own
--    is_admin/plan to true/'pro' - a real privilege escalation (is_admin
--    also grants read access to every user's support messages), not just
--    a Pro-feature unlock.
--
-- 2. HIGH: the free-plan limits (3 active projects, 3 budget planners)
--    were only enforced in the React UI. Anyone could insert past them
--    directly via the Supabase client. This makes the limits real.
--
-- Both are additive (new functions/triggers only) and safe to run
-- alongside the existing schema. Run once, in the Supabase SQL Editor.

-- =========================================================================
-- 1. Stop self-escalation of is_admin / plan on user_settings
-- =========================================================================
-- auth.role() is a built-in Supabase helper returning the caller's JWT
-- role claim ('anon' | 'authenticated' | 'service_role'). Edge Functions
-- that use the service-role key (Patreon webhook syncing `plan`, the
-- admin-downgrade protection already in patreon-callback) run as
-- 'service_role' and bypass RLS entirely already - this trigger lets
-- them through unchanged. Everyone else (i.e. a normal user hitting the
-- table with their own session, which is exactly the attack this closes)
-- gets is_admin/plan silently pinned to what they already had, on both
-- insert and update. Silent rather than an error, since the app's normal
-- settings save sends the whole row including these two fields unchanged
-- - erroring the whole save on an untouched field would break legitimate
-- saves for no reason.
create or replace function public.protect_privileged_user_settings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() = 'service_role' then
    return new;
  end if;
  if TG_OP = 'INSERT' then
    new.is_admin := false;
    new.plan := 'free';
  else
    new.is_admin := old.is_admin;
    new.plan := old.plan;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_protect_privileged_user_settings on user_settings;
create trigger trg_protect_privileged_user_settings
before insert or update on user_settings
for each row execute function public.protect_privileged_user_settings();

-- =========================================================================
-- 2. Enforce the free-plan project / budget-planner caps server-side
-- =========================================================================
create or replace function public.user_has_pro_access(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(is_admin, false) or coalesce(plan, 'free') = 'pro'
  from user_settings
  where user_id = p_user_id;
$$;

revoke all on function public.user_has_pro_access(uuid) from public;
grant execute on function public.user_has_pro_access(uuid) to authenticated;

-- New active project, free plan: block past 3.
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
    if (select count(*) from projects where user_id = new.user_id and archived is not true) >= 3 then
      raise exception 'Free plan is limited to 3 active projects. Archive one or upgrade to Pro.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_project_limit on projects;
create trigger trg_enforce_project_limit
before insert on projects
for each row execute function public.enforce_project_limit();

-- Un-archiving a project back to active is the same cap, so it needs the
-- same guard - otherwise archive/restore is a free way around the limit.
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
    if (select count(*) from projects where user_id = new.user_id and archived is not true and id <> new.id) >= 3 then
      raise exception 'Free plan is limited to 3 active projects. Archive one or upgrade to Pro.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_project_unarchive_limit on projects;
create trigger trg_enforce_project_unarchive_limit
before update on projects
for each row execute function public.enforce_project_unarchive_limit();

-- New budget planner, free plan: block past 3 (matches FREE_BUDGET_PLANNER_LIMIT
-- client-side, which counts every planner regardless of status).
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
    if (select count(*) from budget_planners where user_id = new.user_id) >= 3 then
      raise exception 'Free plan is limited to 3 budget plans. Delete one or upgrade to Pro.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_budget_planner_limit on budget_planners;
create trigger trg_enforce_budget_planner_limit
before insert on budget_planners
for each row execute function public.enforce_budget_planner_limit();
