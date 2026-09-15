-- Fixes from a further round of audits reviewing the previous delivery.
-- Run this after every other migration, including migration_audit_fixes_5.sql.

-- =========================================================================
-- 1. Defensive re-revoke + NULL-safety on user_has_pro_access()
-- =========================================================================
-- migration_security_hardening.sql GRANTs this to `authenticated`, and
-- migration_audit_fixes_2.sql REVOKEs it - two separate files, and every
-- audit of this project has independently flagged that the migration set
-- has no enforced run order. If security_hardening's grant is ever
-- (re-)applied after audit_fixes_2's revoke - a real possibility given
-- there's no guaranteed sequence - the cross-account Pro/admin-status
-- disclosure this was supposed to close reopens silently. Re-stating the
-- revoke here, in the migration meant to run last, makes this correct
-- regardless of what order the older ones were actually run in.
--
-- Also: if a user has no user_settings row yet, the previous version's
-- bare `select ... where user_id = p_user_id` returns NULL rather than an
-- explicit false. Every current caller happens to treat NULL as falsy,
-- so this wasn't causing a live bug - but a function named
-- user_has_pro_access should never return anything but a real boolean.
create or replace function public.user_has_pro_access(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select coalesce(is_admin, false) or coalesce(plan, 'free') = 'pro'
     from user_settings
     where user_id = p_user_id),
    false
  );
$$;

revoke all on function public.user_has_pro_access(uuid) from public;
revoke execute on function public.user_has_pro_access(uuid) from authenticated, anon;

-- =========================================================================
-- 2. Remove the leftover Supabase Storage freelancer-upload policy
-- =========================================================================
-- The app moved to Drive-only uploads (migration_drive_uploads.sql), and
-- add_shot_deliverable()'s execute grant was revoked there - but the
-- underlying storage.objects INSERT policy that let anyone holding a
-- valid shot token upload directly into the public "attachments" bucket
-- was never removed. It's dead code from the app's perspective (nothing
-- calls it anymore) but still live, open attack surface: a share-token
-- holder could still upload arbitrary files into the public bucket
-- through Supabase Storage directly, bypassing the Drive-only design
-- entirely. Not touching the bucket or its existing files/read policy -
-- only closing the write path nothing legitimate uses anymore.
drop policy if exists "Freelancer upload via share token" on storage.objects;
revoke execute on function is_valid_shot_token(text) from anon, authenticated;

-- =========================================================================
-- 3. Enforce Pro-only budget-plan templates server-side
-- =========================================================================
-- Saving a template as a Pro-only feature was only ever checked in React
-- (hasProAccess gating the "Save as Template" button) - RLS on
-- planner_templates enforces ownership, not entitlement, so a free-plan
-- user could insert a template directly via the Supabase client. Same
-- backstop pattern as the Client Portal / Freelancer link triggers.
create or replace function public.enforce_planner_template_pro_gate()
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
    raise exception 'Saving budget-plan templates is a Pro feature.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_planner_template_pro_gate on planner_templates;
create trigger trg_enforce_planner_template_pro_gate
before insert on planner_templates
for each row execute function public.enforce_planner_template_pro_gate();
