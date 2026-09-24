-- =========================================================================
-- Teams Module — Phase 1 safety/correctness fixes
-- =========================================================================
-- Implements, from the Teams implementation brief:
--   P0.1  Team feature entitlement must be enforced server-side, not just
--         hidden in the UI.
--   P0.2  shots.assigned_member_id must never reference another user's
--         team_member row.
--   §3    Archive instead of destructive delete for team_members.
--
-- Safe to run alongside the existing schema. Additive only — no existing
-- column is dropped or renamed, and no existing row is modified.
-- Run this after migration_security_hardening.sql (it reuses
-- public.user_has_pro_access(), defined there).
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. Archive model for team_members
-- -------------------------------------------------------------------------
alter table team_members add column if not exists status text not null default 'active';
alter table team_members add column if not exists archived_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'team_members_status_valid'
  ) then
    alter table team_members
      add constraint team_members_status_valid check (status in ('active', 'archived'));
  end if;
end $$;

create index if not exists team_members_status_idx on team_members(status);

-- Keep archived_at consistent with status regardless of which client wrote
-- the row, so a stray direct update can't leave status='archived' with a
-- null archived_at (or vice versa).
create or replace function public.sync_team_member_archived_at()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'archived' and new.archived_at is null then
    new.archived_at := now();
  elsif new.status = 'active' then
    new.archived_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_team_member_archived_at on team_members;
create trigger trg_sync_team_member_archived_at
before insert or update on team_members
for each row execute function public.sync_team_member_archived_at();

-- -------------------------------------------------------------------------
-- 2. P0.2 — cross-user team-member ownership
-- -------------------------------------------------------------------------
-- The existing FK on shots.assigned_member_id only guarantees the row
-- exists somewhere in team_members, not that it belongs to the same user
-- as the shot. RLS on shots only checks shots.user_id = auth.uid(), so a
-- signed-in user could otherwise point assigned_member_id at another
-- user's roster row (e.g. via a direct API call bypassing the UI's
-- <select>). Enforce ownership at the database boundary.
create or replace function public.enforce_shot_member_ownership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  member_owner uuid;
begin
  if auth.role() = 'service_role' then
    return new;
  end if;
  if new.assigned_member_id is not null then
    select user_id into member_owner from team_members where id = new.assigned_member_id;
    if member_owner is null then
      raise exception 'assigned_member_id does not reference an existing team member';
    end if;
    if member_owner <> new.user_id then
      raise exception 'assigned_member_id must reference a team member owned by the same user';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_shot_member_ownership on shots;
create trigger trg_enforce_shot_member_ownership
before insert or update of assigned_member_id, user_id on shots
for each row execute function public.enforce_shot_member_ownership();

-- -------------------------------------------------------------------------
-- 3. P0.1 — Teams/assignment/payment entitlement, enforced server-side
-- -------------------------------------------------------------------------
-- settings.plan is already protected against client self-escalation (see
-- migration_security_hardening.sql's protect_privileged_user_settings()
-- trigger), so it can be trusted here. What was missing is any check that
-- the *feature* itself — creating team_members rows, or assigning
-- pay/a roster member to a shot — actually requires Pro. Previously that
-- was only decided by which React component rendered, so a free-plan user
-- with a valid session could call the Supabase client directly and use
-- Teams/assignment/payment regardless of plan.
create or replace function public.enforce_team_member_entitlement()
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
    raise exception 'Teams is a Pro feature. Upgrade to manage team members.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_team_member_entitlement on team_members;
create trigger trg_enforce_team_member_entitlement
before insert or update on team_members
for each row execute function public.enforce_team_member_entitlement();

-- Shot assignment/payment fields are also Pro-gated. Block them from being
-- set to a non-default value unless the owning user has Pro access, without
-- blocking ordinary (non-Teams) shot writes for free users.
create or replace function public.enforce_shot_assignment_entitlement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() = 'service_role' then
    return new;
  end if;
  if (new.assigned_member_id is not null or coalesce(new.assigned_pay, 0) <> 0)
     and not public.user_has_pro_access(new.user_id) then
    raise exception 'Shot assignment and payment is a Pro feature. Upgrade to assign crew and pay.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_shot_assignment_entitlement on shots;
create trigger trg_enforce_shot_assignment_entitlement
before insert or update of assigned_member_id, assigned_pay on shots
for each row execute function public.enforce_shot_assignment_entitlement();

-- -------------------------------------------------------------------------
-- Notes
-- -------------------------------------------------------------------------
-- * A user who already has Teams data / shot assignments from when they
--   held Pro, and later loses Pro, is NOT retroactively broken: these
--   triggers only fire on INSERT or on UPDATE that touches the gated
--   columns, so existing rows are left alone (they just can't be
--   *changed* further, or new ones created, until Pro is restored). This
--   matches "do not break existing non-Teams functionality" / do not
--   destroy data.
-- * Both triggers early-return for auth.role() = 'service_role', matching
--   the pattern already used by enforce_project_limit() in
--   migration_security_hardening.sql, so trusted server-side jobs
--   (migrations, admin backfills) are never blocked by this check.
