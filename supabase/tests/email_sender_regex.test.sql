-- Run after 20261224100000_email_crm_confirmed_production_bugfixes.sql.
-- Verifies the latest email_upsert_account RPC accepts an ordinary dotted domain under
-- PostgreSQL standard_conforming_strings=on (the Supabase default).
begin;
do $$
declare
  v_result jsonb;
  v_id uuid;
begin
  perform ti.as_user('00000000-0000-0000-0000-0000000000e1');
  v_result := public.email_upsert_account('Found-A@StudioKairegi.com', 'Regex regression');
  v_id := (v_result ->> 'id')::uuid;
  if v_result ->> 'address' <> 'found-a@studiokairegi.com' then
    raise exception 'FAIL: valid sender address was not normalized and accepted: %', v_result ->> 'address';
  end if;
  raise notice 'PASS: latest sender account RPC accepts a valid address with a dotted domain';
  perform ti.as_super();
  delete from public.email_accounts where id = v_id;
end $$;
rollback;
