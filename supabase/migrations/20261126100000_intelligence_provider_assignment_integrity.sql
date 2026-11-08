-- Phase 2.8.2: make durable provider assignments internally consistent.
-- Legacy messages are valid only when BOTH assignment fields are null.
-- Corrupt historical rows are deliberately not auto-routed; the trigger fails
-- closed if an attempt is made to update or send one.
begin;

create or replace function public.intel_enforce_provider_assignment_integrity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if (new.provider_account_id is null) <> (new.provider_key is null) then
    raise exception 'incomplete provider account assignment' using errcode = '23514';
  end if;

  if new.provider_account_id is not null and not exists (
    select 1
      from public.intel_provider_accounts a
     where a.id = new.provider_account_id
       and a.organization_id = new.organization_id
       and a.provider_key = new.provider_key
  ) then
    raise exception 'provider account assignment does not match organization and provider' using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.intel_enforce_provider_assignment_integrity() from public, anon, authenticated;

drop trigger if exists intel_messages_provider_assignment_integrity on public.intel_messages;
create trigger intel_messages_provider_assignment_integrity
before insert or update on public.intel_messages
for each row execute function public.intel_enforce_provider_assignment_integrity();

commit;
