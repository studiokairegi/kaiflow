-- Phase 2 sender-safety follow-up.
-- Keep the browser account payload explicit, require send capability when adding an account,
-- and serialize first-account/default decisions per organization.
begin;

create or replace function public.email_list_accounts() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.email_require_access();
begin
  return coalesce((
    select jsonb_agg(
      (to_jsonb(a) - 'last_connection_error')
      order by a.is_default desc, a.created_at
    )
    from public.email_accounts a
    where a.organization_id = v_org
  ), '[]'::jsonb);
end $$;
revoke all on function public.email_list_accounts() from public, anon;
grant execute on function public.email_list_accounts() to authenticated;

create or replace function public.email_upsert_account(
  p_address text, p_display_name text default '', p_provider text default 'resend'
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.email_require_access();
  v_addr text := lower(btrim(coalesce(p_address, '')));
  v_prov text := lower(btrim(coalesce(p_provider, '')));
  r public.email_accounts;
begin
  -- Prevent concurrent first-account inserts from racing the organization default.
  perform pg_advisory_xact_lock(hashtextextended(v_org::text, 0));

  if v_addr !~ '^[^@\s]+@[^@\s]+\\.[^@\s]+$' then
    raise exception 'Enter a valid email address';
  end if;
  if not exists (
    select 1 from public.email_provider_registry
    where provider_key = v_prov and enabled = true and capabilities ->> 'send' = 'true'
  ) then
    raise exception 'Unknown, disabled, or non-sending email provider';
  end if;

  insert into public.email_accounts (organization_id, provider, address, display_name, is_default)
  values (
    v_org, v_prov, v_addr, left(btrim(coalesce(p_display_name, '')), 120),
    not exists (select 1 from public.email_accounts where organization_id = v_org)
  )
  on conflict (organization_id, provider, address)
  do update set display_name = excluded.display_name
  returning * into r;

  return to_jsonb(r) - 'last_connection_error';
end $$;
revoke all on function public.email_upsert_account(text, text, text) from public, anon;
grant execute on function public.email_upsert_account(text, text, text) to authenticated;

commit;
