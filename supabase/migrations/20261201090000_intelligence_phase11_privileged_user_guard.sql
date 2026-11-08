-- Phase 11: make the privileged user_settings guard part of the ordered migration history.
-- A root-level manual SQL file previously contained this protection, but it was not in
-- supabase/migrations; a normal migration replay therefore could omit the trigger entirely.
-- This migration is deliberately limited to the privilege guard (not unrelated plan caps).

begin;

create or replace function public.protect_privileged_user_settings()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  -- Trusted server-side provisioning/billing functions may set privileged fields.
  -- A caller-supplied JWT role is not sufficient: auth.role() is verified by Supabase.
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.is_admin := false;
    new.plan := 'free';
  else
    new.is_admin := old.is_admin;
    new.plan := old.plan;
  end if;
  return new;
end;
$$;

revoke all on function public.protect_privileged_user_settings() from public, anon, authenticated;

drop trigger if exists trg_protect_privileged_user_settings on public.user_settings;
create trigger trg_protect_privileged_user_settings
before insert or update on public.user_settings
for each row execute function public.protect_privileged_user_settings();

-- Fail the migration if the protection is not actually attached to user_settings.
do $$
begin
  if not exists (
    select 1
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where t.tgname = 'trg_protect_privileged_user_settings'
       and n.nspname = 'public'
       and c.relname = 'user_settings'
       and not t.tgisinternal
       and t.tgenabled in ('O', 'A')
  ) then
    raise exception 'Phase 11 security guard is not enabled on public.user_settings';
  end if;
end;
$$;

commit;
