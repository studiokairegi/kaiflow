-- Run against the target Supabase database only AFTER applying the reviewed provider migrations.
-- Read-only acceptance assertions; this script makes no changes.
do $$
declare
  v text;
  r record;
begin
  if to_regclass('public.intel_email_provider_registry') is null
     or to_regclass('public.intel_provider_accounts') is null
     or to_regclass('public.intel_provider_oauth_states') is null
     or to_regclass('public.intel_provider_account_usage') is null
     or to_regclass('public.intel_contact_permissions') is null then
    raise exception 'Phase 2 provider tables are missing';
  end if;

  if to_regprocedure('public.intel_admin_set_provider_sending_enabled(text,boolean)') is not null then
    raise exception 'Unsafe tenant-callable global provider gate RPC still exists';
  end if;

  foreach v in array array['intel_provider_accounts','intel_provider_oauth_states','intel_provider_account_usage','intel_contact_permissions'] loop
    select c.relrowsecurity into r from pg_class c where c.oid = to_regclass('public.' || v);
    if coalesce(r.relrowsecurity, false) is not true then
      raise exception 'RLS is not enabled on public.%', v;
    end if;
  end loop;

  if has_table_privilege('anon','public.intel_provider_accounts','select')
     or has_table_privilege('authenticated','public.intel_provider_accounts','select')
     or has_table_privilege('anon','public.intel_provider_accounts','insert')
     or has_table_privilege('authenticated','public.intel_provider_accounts','insert') then
    raise exception 'Client roles have direct access to provider credentials';
  end if;

  if exists (
    select 1 from public.intel_email_provider_registry
     where provider_key in ('gmail','zoho','smtp') and enabled is not true
  ) then raise exception 'A reviewed adapter is missing or disabled in the catalogue'; end if;

  if exists (
    select 1 from public.intel_email_provider_registry
     where provider_key in ('gmail','zoho','smtp') and sending_enabled is true
  ) then raise exception 'Provider sending gates must remain OFF during acceptance'; end if;

  if exists (select 1 from public.intel_email_provider_registry where provider_key='resend') then
    raise exception 'Resend must not be registered in the prospect provider catalogue';
  end if;

  if exists (
    select 1 from public.intel_provider_accounts
     where (is_enabled is true or send_enabled is true)
       and provider_key in ('gmail','zoho','smtp')
  ) then raise exception 'A provider account is enabled; acceptance requires all accounts paused'; end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='intel_provider_accounts'
       and column_name='credentials_ciphertext'
  ) then raise exception 'Encrypted credential column is missing'; end if;

  raise notice 'Phase 2.8 provider acceptance assertions passed; no credentials or messages were modified.';
end $$;
