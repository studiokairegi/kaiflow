-- Finance V3, Phase 7 (migration 1 of 1): fix legacy invoice validation crashing on ordinary bad data.
--
-- DEFECT (found by the Phase 7 migration rehearsal, not by earlier suites): finance_v3.legacy_validate built its error list with
-- `v_err := v_err || 'some message'`. For a text[] variable PostgreSQL reads the bare string literal as an ARRAY literal, so every
-- message written as a plain literal (missing client name, amount not a decimal, amount not above zero, bad dates, amount_paid larger than
-- amount, unknown status ...) raised "malformed array literal" and aborted fin3_migration_validate for the WHOLE run, instead of marking
-- that one record invalid. Only the message built by concatenation (unsupported currency) worked, which is the one case the earlier test covered.
-- FIX: every append uses array_append(v_err, <text>). Behaviour for valid records and for messages that already worked is unchanged.
-- No data is changed. CREATE OR REPLACE keeps the function's existing grants (internal: not executable by anon, authenticated or service_role).
-- Rollback: supabase/rollback/20270118090000_finance_v3_phase7_fixes.rollback.sql (restores the previous, defective body).

begin;

insert into finance_v3.schema_version (version, notes)
values ('20270118090000', 'phase 7: legacy_validate error list fix')
on conflict (version) do nothing;

create or replace function finance_v3.legacy_validate(p_org uuid, p jsonb)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_err    text[] := '{}';
  v_ccy    text := upper(btrim(coalesce(p ->> 'currency', '')));
  v_minor  smallint;
  v_amt    numeric;
  v_paid   numeric := 0;
  v_issue  date;
  v_due    date;
  v_status text := lower(btrim(coalesce(p ->> 'status', '')));
  v_mode   text;
  v_sid    text := btrim(coalesce(p ->> 'source_id', ''));
  v_no     text := btrim(coalesce(p ->> 'invoice_number', ''));
begin
  if v_sid = '' or char_length(v_sid) > 100 then v_err := array_append(v_err, 'source_id is missing or too long'::text); end if;
  if v_no = '' or char_length(v_no) > 50 then v_err := array_append(v_err, 'invoice_number is missing or longer than 50 characters'::text); end if;
  if char_length(btrim(coalesce(p ->> 'client_name', ''))) not between 1 and 160 then v_err := array_append(v_err, 'client_name is missing'::text); end if;
  if nullif(btrim(coalesce(p ->> 'client_email', '')), '') is not null and not finance_v3.valid_email(lower(btrim(p ->> 'client_email'))) then
    v_err := array_append(v_err, 'client_email is not a valid address'::text);
  end if;
  v_minor := finance_v3.minor_unit(v_ccy);
  if v_minor is null then v_err := array_append(v_err, ('currency "' || v_ccy || '" is not an ISO code supported by Finance V3 (legacy symbols must be mapped first)')); end if;
  if coalesce(p ->> 'amount', '') !~ '^(0|[1-9][0-9]{0,14})(\.[0-9]{1,4})?$' then
    v_err := array_append(v_err, 'amount is not a valid decimal'::text);
  elsif v_minor is not null and length(split_part(p ->> 'amount', '.', 2)) > v_minor then
    v_err := array_append(v_err, 'amount has more decimals than the currency allows'::text);
  else
    v_amt := (p ->> 'amount')::numeric;
    if v_amt <= 0 then v_err := array_append(v_err, 'amount must be above zero'::text); end if;
  end if;
  if nullif(btrim(coalesce(p ->> 'amount_paid', '')), '') is not null then
    if (p ->> 'amount_paid') !~ '^(0|[1-9][0-9]{0,14})(\.[0-9]{1,4})?$' then v_err := array_append(v_err, 'amount_paid is not a valid decimal'::text);
    else v_paid := (p ->> 'amount_paid')::numeric; end if;
  end if;
  if v_amt is not null and v_paid > v_amt then v_err := array_append(v_err, 'amount_paid is larger than amount'::text); end if;
  begin
    if coalesce(p ->> 'issue_date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' then raise exception 'x'; end if;
    v_issue := left(p ->> 'issue_date', 10)::date;
  exception when others then v_err := array_append(v_err, 'issue_date is not a valid date (YYYY-MM-DD)'::text); v_issue := null; end;
  begin
    if coalesce(p ->> 'due_date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' then raise exception 'x'; end if;
    v_due := left(p ->> 'due_date', 10)::date;
  exception when others then v_err := array_append(v_err, 'due_date is not a valid date (YYYY-MM-DD)'::text); v_due := null; end;
  if v_issue is not null and v_due is not null and v_due < v_issue then v_err := array_append(v_err, 'due_date is before issue_date'::text); end if;

  if v_status in ('draft', 'cancelled', 'canceled', 'void', 'voided') then
    return jsonb_build_object('status', 'skipped', 'mode', null, 'errors', jsonb_build_array('not eligible: legacy status is ' || v_status));
  elsif v_status = 'paid' then
    v_mode := 'document_only';
    if v_amt is not null and v_paid < v_amt then v_err := array_append(v_err, 'marked paid but amount_paid is lower than amount (needs manual review)'::text); end if;
  elsif v_status in ('sent', 'unpaid', 'overdue', 'partial', 'partially_paid', 'issued', 'pending', 'open') then
    v_mode := 'opening_balance';
    if v_amt is not null and v_paid >= v_amt then v_err := array_append(v_err, 'open invoice is already fully paid (needs manual review)'::text); end if;
  else
    v_err := array_append(v_err, ('unknown legacy status "' || v_status || '"'));
  end if;

  if coalesce(array_length(v_err, 1), 0) > 0 then
    return jsonb_build_object('status', 'invalid', 'mode', null, 'errors', to_jsonb(v_err));
  end if;
  if exists (select 1 from finance_v3.receivables r where r.organization_id = p_org and (r.source_legacy_id = v_sid or r.invoice_no = v_no)) then
    return jsonb_build_object('status', 'duplicate', 'mode', v_mode, 'errors', jsonb_build_array('already present in Finance V3 (same source id or invoice number)'));
  end if;
  return jsonb_build_object('status', 'valid', 'mode', v_mode, 'errors', '[]'::jsonb);
end;
$$;

commit;
