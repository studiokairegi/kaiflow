-- Finance V3, Phase 3 (migration 6 of 6): controlled legacy (Finance V2) invoice migration tooling.
--
-- This is TOOLING, not a cutover. Nothing here runs automatically and nothing is imported without an explicit admin call per run.
-- The only contact with V2 is one READ-ONLY extraction function (select only; it never writes, locks or alters a V2 table).
-- Records are staged, validated, imported one by one (a failing record never blocks the others; failures are kept and retryable),
-- and reconciled. Missing history is never fabricated:
--   * an OPEN legacy invoice is imported as an invoice plus an opening-balance entry for its OUTSTANDING amount only
--     (Dr Accounts Receivable / Cr Opening Balance Equity, kind legacy_import);
--   * a fully PAID legacy invoice is imported as a historical document with NO ledger entry (its revenue and cash history belong
--     to the legacy books; reconstructing them would be inventing data).
-- Rollback: supabase/rollback/20270114095000_finance_v3_migration_tools.rollback.sql
--
-- NOT EXECUTED: written in a sandbox without PostgreSQL; statically checked only. See PHASE_3_HANDOFF.md.

begin;

insert into finance_v3.schema_version (version, notes)
values ('20270114095000', 'phase 3 migration 6: legacy invoice migration tooling (stage, validate, import, reconcile)')
on conflict (version) do nothing;

update finance_v3.event_kinds set is_enabled = true, phase_available = 3 where kind = 'legacy_import';

-- Historical amount already paid before the invoice reached V3 (no ledger effect). recompute_receivable adds it to verified payments.
alter table finance_v3.receivables
  add column if not exists opening_paid numeric(19,4) not null default 0 check (opening_paid >= 0);

create or replace function finance_v3.recompute_receivable(p_org uuid, p_invoice uuid)
returns finance_v3.receivables
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  r        finance_v3.receivables;
  v_paid   numeric;
  v_credit numeric;
  v_status text;
begin
  select * into r from finance_v3.receivables x where x.organization_id = p_org and x.id = p_invoice for update;
  if not found then raise exception 'Invoice not found.' using errcode = 'V3010'; end if;
  if r.status in ('draft', 'approved', 'void') then return r; end if;
  select r.opening_paid + coalesce(sum(p.amount - p.refunded_amount), 0) into v_paid
    from finance_v3.payments p
   where p.organization_id = p_org and p.invoice_id = p_invoice and p.verification_status = 'verified'
     and p.status in ('recorded', 'partially_refunded');
  select coalesce(sum(c.amount), 0) into v_credit
    from finance_v3.receivable_credits c where c.organization_id = p_org and c.receivable_id = p_invoice;
  v_status := case
    when v_paid + v_credit >= r.total then case when v_credit >= r.total then 'credited' else 'paid' end
    when v_paid > 0 then 'partially_paid'
    else 'issued' end;
  update finance_v3.receivables x set amount_paid = v_paid, credit_total = v_credit, status = v_status, updated_at = now()
   where x.organization_id = p_org and x.id = p_invoice returning * into r;
  return r;
end;
$$;

create table if not exists finance_v3.migration_runs (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references finance_v3.org_settings(organization_id) on delete restrict,
  kind            text not null default 'legacy_invoices' check (kind = 'legacy_invoices'),
  status          text not null default 'staged' check (status in ('staged', 'validated', 'imported')),
  cutoff_date     date not null,
  note            text check (note is null or char_length(note) <= 500),
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint uq_migration_runs_org_id unique (organization_id, id)
);

create table if not exists finance_v3.migration_records (
  id              bigint generated always as identity primary key,
  organization_id uuid not null,
  run_id          uuid not null,
  source_id       text not null check (char_length(source_id) between 1 and 100),
  payload         jsonb not null,
  status          text not null default 'staged' check (status in ('staged', 'valid', 'invalid', 'duplicate', 'skipped', 'imported', 'failed')),
  mode            text check (mode is null or mode in ('opening_balance', 'document_only')),
  errors          jsonb not null default '[]'::jsonb,
  target_id       uuid,
  attempts        integer not null default 0,
  updated_at      timestamptz not null default now(),
  constraint uq_migration_record unique (run_id, source_id),
  constraint fk_migration_record_run foreign key (organization_id, run_id) references finance_v3.migration_runs (organization_id, id) on delete restrict
);
create index if not exists ix_migration_records_status on finance_v3.migration_records (run_id, status);

alter table finance_v3.migration_runs    enable row level security;
alter table finance_v3.migration_records enable row level security;
drop policy if exists fin3_select_migration_runs on finance_v3.migration_runs;
create policy fin3_select_migration_runs on finance_v3.migration_runs for select to authenticated using (finance_v3.has_permission(organization_id, 'finance.admin'));
drop policy if exists fin3_select_migration_records on finance_v3.migration_records;
create policy fin3_select_migration_records on finance_v3.migration_records for select to authenticated using (finance_v3.has_permission(organization_id, 'finance.admin'));
revoke all on finance_v3.migration_runs, finance_v3.migration_records from public, anon, authenticated, service_role;
grant select on finance_v3.migration_runs, finance_v3.migration_records to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- READ-ONLY extraction from the legacy tables. Uses to_jsonb so it does not depend on exact V2 column names; the mapping below
-- is tolerant and anything it cannot map becomes a validation error rather than a guess. Returns normalized records.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fin3_migration_extract_legacy_invoices(p_org uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  perform finance_v3.assert_permission(p_org, 'finance.admin');
  perform finance_v3.assert_org_ready(p_org);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'source_id', to_jsonb(i) ->> 'id',
      'invoice_number', to_jsonb(i) ->> 'invoice_number',
      'client_name', coalesce(to_jsonb(p) ->> 'client', to_jsonb(p) ->> 'client_name'),
      'client_email', coalesce(to_jsonb(p) ->> 'client_email', to_jsonb(p) ->> 'email'),
      'project_id', to_jsonb(i) ->> 'project_id',
      'currency', to_jsonb(i) ->> 'currency',
      'amount', to_jsonb(i) ->> 'amount',
      'amount_paid', to_jsonb(i) ->> 'amount_paid',
      'issue_date', to_jsonb(i) ->> 'issue_date',
      'due_date', to_jsonb(i) ->> 'due_date',
      'status', to_jsonb(i) ->> 'status',
      'description', to_jsonb(i) ->> 'description') order by to_jsonb(i) ->> 'id')
    from public.invoices i
    join public.studio_data_owners o on o.user_id = i.user_id and o.organization_id = p_org
    left join public.projects p on p.id = i.project_id), '[]'::jsonb);
end;
$$;

create or replace function public.fin3_migration_start_run(p_org uuid, p_cutoff_date date default current_date, p_note text default null)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.admin');
  x finance_v3.migration_runs;
begin
  perform finance_v3.assert_org_ready(p_org);
  if p_cutoff_date is null or p_cutoff_date > current_date + 1 or p_cutoff_date < date '1990-01-01' then
    raise exception 'The opening-balance date is not valid.' using errcode = 'V3011';
  end if;
  insert into finance_v3.migration_runs (organization_id, cutoff_date, note, created_by)
  values (p_org, p_cutoff_date, nullif(btrim(p_note), ''), v_uid) returning * into x;
  perform finance_v3.write_audit(p_org, v_uid, 'migration_start_run', 'migration_run', x.id::text, null, jsonb_build_object('cutoff_date', p_cutoff_date), null);
  return jsonb_build_object('run_id', x.id, 'status', x.status, 'cutoff_date', x.cutoff_date);
end;
$$;

create or replace function public.fin3_migration_stage(p_org uuid, p_run uuid, p_records jsonb)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.admin');
  x finance_v3.migration_runs;
  e jsonb;
  v_n integer := 0;
  v_sid text;
begin
  perform finance_v3.assert_org_ready(p_org);
  select * into x from finance_v3.migration_runs r where r.organization_id = p_org and r.id = p_run for update;
  if not found then raise exception 'Migration run not found.' using errcode = 'V3010'; end if;
  if p_records is null or jsonb_typeof(p_records) <> 'array' or jsonb_array_length(p_records) > 1000 then
    raise exception 'Stage at most 1000 records per call.' using errcode = 'V3011';
  end if;
  for e in select value from jsonb_array_elements(p_records) loop
    if jsonb_typeof(e) <> 'object' then raise exception 'Each record must be an object.' using errcode = 'V3011'; end if;
    v_sid := btrim(coalesce(e ->> 'source_id', ''));
    if v_sid = '' or char_length(v_sid) > 100 then raise exception 'Every record needs a source_id of up to 100 characters.' using errcode = 'V3011'; end if;
    insert into finance_v3.migration_records (organization_id, run_id, source_id, payload)
    values (p_org, p_run, v_sid, e)
    on conflict (run_id, source_id) do update set payload = excluded.payload, status = 'staged', errors = '[]'::jsonb, mode = null, updated_at = now()
     where finance_v3.migration_records.status not in ('imported');
    v_n := v_n + 1;
  end loop;
  update finance_v3.migration_runs r set updated_at = now() where r.id = x.id;
  perform finance_v3.write_audit(p_org, v_uid, 'migration_stage', 'migration_run', p_run::text, null, jsonb_build_object('records', v_n), null);
  return jsonb_build_object('staged', v_n);
end;
$$;

-- Authoritative validation of one normalized record. Never raises; returns {status, mode, errors}.
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
  if v_sid = '' or char_length(v_sid) > 100 then v_err := v_err || 'source_id is missing or too long'; end if;
  if v_no = '' or char_length(v_no) > 50 then v_err := v_err || 'invoice_number is missing or longer than 50 characters'; end if;
  if char_length(btrim(coalesce(p ->> 'client_name', ''))) not between 1 and 160 then v_err := v_err || 'client_name is missing'; end if;
  if nullif(btrim(coalesce(p ->> 'client_email', '')), '') is not null and not finance_v3.valid_email(lower(btrim(p ->> 'client_email'))) then
    v_err := v_err || 'client_email is not a valid address';
  end if;
  v_minor := finance_v3.minor_unit(v_ccy);
  if v_minor is null then v_err := v_err || ('currency "' || v_ccy || '" is not an ISO code supported by Finance V3 (legacy symbols must be mapped first)'); end if;
  if coalesce(p ->> 'amount', '') !~ '^(0|[1-9][0-9]{0,14})(\.[0-9]{1,4})?$' then
    v_err := v_err || 'amount is not a valid decimal';
  elsif v_minor is not null and length(split_part(p ->> 'amount', '.', 2)) > v_minor then
    v_err := v_err || 'amount has more decimals than the currency allows';
  else
    v_amt := (p ->> 'amount')::numeric;
    if v_amt <= 0 then v_err := v_err || 'amount must be above zero'; end if;
  end if;
  if nullif(btrim(coalesce(p ->> 'amount_paid', '')), '') is not null then
    if (p ->> 'amount_paid') !~ '^(0|[1-9][0-9]{0,14})(\.[0-9]{1,4})?$' then v_err := v_err || 'amount_paid is not a valid decimal';
    else v_paid := (p ->> 'amount_paid')::numeric; end if;
  end if;
  if v_amt is not null and v_paid > v_amt then v_err := v_err || 'amount_paid is larger than amount'; end if;
  begin
    if coalesce(p ->> 'issue_date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' then raise exception 'x'; end if;
    v_issue := left(p ->> 'issue_date', 10)::date;
  exception when others then v_err := v_err || 'issue_date is not a valid date (YYYY-MM-DD)'; v_issue := null; end;
  begin
    if coalesce(p ->> 'due_date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' then raise exception 'x'; end if;
    v_due := left(p ->> 'due_date', 10)::date;
  exception when others then v_err := v_err || 'due_date is not a valid date (YYYY-MM-DD)'; v_due := null; end;
  if v_issue is not null and v_due is not null and v_due < v_issue then v_err := v_err || 'due_date is before issue_date'; end if;

  if v_status in ('draft', 'cancelled', 'canceled', 'void', 'voided') then
    return jsonb_build_object('status', 'skipped', 'mode', null, 'errors', jsonb_build_array('not eligible: legacy status is ' || v_status));
  elsif v_status = 'paid' then
    v_mode := 'document_only';
    if v_amt is not null and v_paid < v_amt then v_err := v_err || 'marked paid but amount_paid is lower than amount (needs manual review)'; end if;
  elsif v_status in ('sent', 'unpaid', 'overdue', 'partial', 'partially_paid', 'issued', 'pending', 'open') then
    v_mode := 'opening_balance';
    if v_amt is not null and v_paid >= v_amt then v_err := v_err || 'open invoice is already fully paid (needs manual review)'; end if;
  else
    v_err := v_err || ('unknown legacy status "' || v_status || '"');
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

create or replace function public.fin3_migration_validate(p_org uuid, p_run uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.admin');
  rec record;
  v jsonb;
  v_dups integer;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  if not exists (select 1 from finance_v3.migration_runs r where r.organization_id = p_org and r.id = p_run) then
    raise exception 'Migration run not found.' using errcode = 'V3010';
  end if;
  for rec in select m.id, m.payload from finance_v3.migration_records m
              where m.organization_id = p_org and m.run_id = p_run and m.status in ('staged', 'valid', 'invalid', 'duplicate', 'skipped', 'failed') order by m.id loop
    v := finance_v3.legacy_validate(p_org, rec.payload);
    update finance_v3.migration_records m set status = v ->> 'status', mode = v ->> 'mode', errors = v -> 'errors', updated_at = now() where m.id = rec.id;
  end loop;
  -- Two records of the same run with one invoice number cannot both be imported: keep the first, mark the rest duplicate.
  update finance_v3.migration_records m set status = 'duplicate', errors = jsonb_build_array('another record of this run has the same invoice number'), updated_at = now()
   where m.organization_id = p_org and m.run_id = p_run and m.status = 'valid'
     and exists (select 1 from finance_v3.migration_records o where o.run_id = m.run_id and o.status = 'valid' and o.id < m.id
                  and btrim(o.payload ->> 'invoice_number') = btrim(m.payload ->> 'invoice_number'));
  get diagnostics v_dups = row_count;
  update finance_v3.migration_runs r set status = case when r.status = 'imported' then 'imported' else 'validated' end, updated_at = now() where r.id = p_run;
  perform finance_v3.write_audit(p_org, v_uid, 'migration_validate', 'migration_run', p_run::text, null, jsonb_build_object('run_duplicates', v_dups), null);
  return public.fin3_migration_report(p_org, p_run);
end;
$$;

-- Imports ONE validated record. Runs inside the caller's per-record sub-transaction.
create or replace function finance_v3.legacy_import_one(p_org uuid, p_record bigint, p_actor uuid, p_cutoff date)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  m        finance_v3.migration_records;
  s        finance_v3.org_settings;
  p        jsonb;
  c        finance_v3.contacts_v3;
  r        finance_v3.receivables;
  v_ccy    text;
  v_amt    numeric;
  v_paid   numeric;
  v_out    numeric;
  v_name   text;
  v_key    text;
  v_proj   uuid;
  v_acct   uuid;
  v_entry  uuid;
  v_snap   jsonb;
  v_issue  date;
  v_due    date;
  v_no     text;
begin
  select * into m from finance_v3.migration_records x where x.id = p_record and x.organization_id = p_org for update;
  p := m.payload;
  select * into s from finance_v3.org_settings where organization_id = p_org;
  v_ccy := upper(btrim(p ->> 'currency'));
  v_amt := (p ->> 'amount')::numeric;
  v_paid := coalesce(nullif(btrim(p ->> 'amount_paid'), '')::numeric, 0);
  v_out := v_amt - v_paid;
  v_issue := left(p ->> 'issue_date', 10)::date;
  v_due := left(p ->> 'due_date', 10)::date;
  v_no := btrim(p ->> 'invoice_number');
  v_name := btrim(p ->> 'client_name');
  v_key := 'name:' || lower(v_name);

  select * into c from finance_v3.contacts_v3 x where x.organization_id = p_org and x.kind = 'client' and x.source_legacy_id = v_key;
  if not found then
    insert into finance_v3.contacts_v3 (organization_id, kind, name, email, source_legacy_id, created_by)
    values (p_org, 'client', v_name, nullif(lower(btrim(coalesce(p ->> 'client_email', ''))), ''), v_key, p_actor) returning * into c;
  end if;
  if nullif(p ->> 'project_id', '') is not null and finance_v3.valid_uuid(p ->> 'project_id') and finance_v3.project_in_org(p_org, (p ->> 'project_id')::uuid) then
    v_proj := (p ->> 'project_id')::uuid;
  end if;
  v_acct := finance_v3.system_account(p_org, 'revenue_animation');

  insert into finance_v3.receivables (organization_id, client_id, project_id, currency, issue_date, due_date, origin, ledger_mode, source_legacy_id, notes, created_by)
  values (p_org, c.id, v_proj, v_ccy, v_issue, v_due, 'legacy', m.mode, m.source_id, left('Imported from legacy invoice ' || v_no || '.', 2000), p_actor)
  returning * into r;
  insert into finance_v3.receivable_lines (organization_id, receivable_id, line_no, description, quantity, unit_price, gross_amount, discount_amount, net_amount,
                                           tax_amount, line_total, account_id)
  values (p_org, r.id, 1, left(coalesce(nullif(btrim(p ->> 'description'), ''), 'Legacy invoice ' || v_no), 500), 1, v_amt, v_amt, 0, v_amt, 0, v_amt, v_acct);
  update finance_v3.receivables x set subtotal = v_amt, total = v_amt where x.organization_id = p_org and x.id = r.id returning * into r;

  if m.mode = 'opening_balance' then
    v_entry := finance_v3.post_event(p_org, 'legacy_import', 'fin3:legacy:invoice:' || finance_v3.key_hash(m.source_id), p_cutoff,
      jsonb_build_array(
        jsonb_build_object('account_id', finance_v3.system_account(p_org, 'accounts_receivable'), 'side', 'debit', 'amount', finance_v3.money_text(v_out, v_ccy), 'currency', v_ccy),
        jsonb_build_object('account_id', finance_v3.system_account(p_org, 'opening_balance'), 'side', 'credit', 'amount', finance_v3.money_text(v_out, v_ccy), 'currency', v_ccy)),
      jsonb_strip_nulls(jsonb_build_object('memo', left('Opening balance: legacy invoice ' || v_no, 500), 'reference', left(v_no, 120), 'project_id', v_proj)));
  end if;

  v_snap := jsonb_build_object('invoice_no', v_no, 'currency', v_ccy, 'issue_date', v_issue, 'due_date', v_due, 'legacy', true,
    'studio', jsonb_build_object('name', coalesce(s.studio_name, ''), 'address', s.studio_address, 'email', s.studio_email, 'phone', s.studio_phone,
                                 'tax_id', s.studio_tax_id, 'brand_color', s.brand_color),
    'client', jsonb_build_object('name', c.name, 'email', c.email, 'address', c.address, 'tax_id', c.tax_id),
    'lines', jsonb_build_array(jsonb_build_object('line_no', 1, 'description', left(coalesce(nullif(btrim(p ->> 'description'), ''), 'Legacy invoice ' || v_no), 500),
        'quantity', '1', 'unit_price', finance_v3.money_text(v_amt, v_ccy), 'discount_pct', '0', 'tax_rate', '0', 'gross_amount', finance_v3.money_text(v_amt, v_ccy),
        'discount_amount', finance_v3.money_text(0, v_ccy), 'net_amount', finance_v3.money_text(v_amt, v_ccy), 'tax_amount', finance_v3.money_text(0, v_ccy),
        'line_total', finance_v3.money_text(v_amt, v_ccy))),
    'subtotal', finance_v3.money_text(v_amt, v_ccy), 'discount_total', finance_v3.money_text(0, v_ccy), 'tax_total', finance_v3.money_text(0, v_ccy),
    'total', finance_v3.money_text(v_amt, v_ccy), 'notes', r.notes, 'payment_instructions', s.payment_instructions, 'revision', 1);

  update finance_v3.receivables x set status = 'issued', invoice_no = v_no, snapshot = v_snap, issued_entry_id = v_entry, issued_by = p_actor,
         issued_at = now(), opening_paid = v_paid, updated_at = now() where x.organization_id = p_org and x.id = r.id;
  perform finance_v3.recompute_receivable(p_org, r.id);
  perform finance_v3.write_audit(p_org, p_actor, 'migration_import_invoice', 'receivable', r.id::text, null,
    jsonb_build_object('legacy_source_id', m.source_id, 'mode', m.mode, 'outstanding', finance_v3.money_text(v_out, v_ccy), 'entry_id', v_entry), null);
  return r.id;
end;
$$;

create or replace function public.fin3_migration_import(p_org uuid, p_run uuid, p_retry_failed boolean default false)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.admin');
  x finance_v3.migration_runs;
  rec record;
  v_id uuid;
  v_ok integer := 0;
  v_fail integer := 0;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  select * into x from finance_v3.migration_runs r where r.organization_id = p_org and r.id = p_run for update;
  if not found then raise exception 'Migration run not found.' using errcode = 'V3010'; end if;
  if x.status = 'staged' then raise exception 'Validate the run before importing it.' using errcode = 'V3017'; end if;
  for rec in select m.id from finance_v3.migration_records m
              where m.organization_id = p_org and m.run_id = p_run and (m.status = 'valid' or (p_retry_failed and m.status = 'failed')) order by m.id loop
    begin
      v_id := finance_v3.legacy_import_one(p_org, rec.id, v_uid, x.cutoff_date);
      update finance_v3.migration_records m set status = 'imported', target_id = v_id, errors = '[]'::jsonb, attempts = m.attempts + 1, updated_at = now() where m.id = rec.id;
      v_ok := v_ok + 1;
    exception when others then
      if sqlstate !~ '^V3' and sqlstate not in ('23505', '23514', '23503', '22P02', '22003', '22007', '22008') then raise; end if;
      update finance_v3.migration_records m set status = 'failed', errors = jsonb_build_array(left(sqlerrm, 300)), attempts = m.attempts + 1, updated_at = now() where m.id = rec.id;
      v_fail := v_fail + 1;
    end;
  end loop;
  update finance_v3.migration_runs r set status = 'imported', updated_at = now() where r.id = p_run;
  perform finance_v3.write_audit(p_org, v_uid, 'migration_import', 'migration_run', p_run::text, null, jsonb_build_object('imported', v_ok, 'failed', v_fail), null);
  return public.fin3_migration_report(p_org, p_run);
end;
$$;

-- Reconciliation report: counts by status, per-currency legacy open total vs imported open total vs the ledger opening balances,
-- and every problem record with its reason. A non-zero difference after import means something needs a human.
create or replace function public.fin3_migration_report(p_org uuid, p_run uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  x finance_v3.migration_runs;
  v_ar uuid;
begin
  perform finance_v3.assert_permission(p_org, 'finance.admin');
  perform finance_v3.assert_org_ready(p_org);
  select * into x from finance_v3.migration_runs r where r.organization_id = p_org and r.id = p_run;
  if not found then raise exception 'Migration run not found.' using errcode = 'V3010'; end if;
  v_ar := finance_v3.system_account(p_org, 'accounts_receivable');
  return jsonb_build_object(
    'run_id', x.id, 'status', x.status, 'cutoff_date', x.cutoff_date,
    'counts', coalesce((select jsonb_object_agg(t.status, t.n) from (select m.status, count(*) as n from finance_v3.migration_records m where m.run_id = p_run group by m.status) t), '{}'::jsonb),
    'by_currency', coalesce((select jsonb_agg(jsonb_build_object('currency', q.ccy,
        'legacy_open_total', finance_v3.money_text(q.legacy_open, q.ccy),
        'imported_open_total', finance_v3.money_text(coalesce(q.imported_open, 0), q.ccy),
        'ledger_opening_total', finance_v3.money_text(coalesce(q.ledger_open, 0), q.ccy),
        'difference_legacy_vs_imported', finance_v3.money_text(q.legacy_open - coalesce(q.imported_open, 0), q.ccy)) order by q.ccy)
      from (
        select upper(m.payload ->> 'currency') as ccy,
               sum((m.payload ->> 'amount')::numeric - coalesce(nullif(btrim(m.payload ->> 'amount_paid'), '')::numeric, 0)) as legacy_open,
               sum(r.outstanding) filter (where m.status = 'imported') as imported_open,
               sum((select coalesce(sum(l.amount_native), 0) from finance_v3.journal_lines l
                     where l.organization_id = p_org and l.entry_id = r.issued_entry_id and l.account_id = v_ar and l.side = 'debit')) filter (where m.status = 'imported') as ledger_open
          from finance_v3.migration_records m
          left join finance_v3.receivables r on r.organization_id = m.organization_id and r.id = m.target_id
         where m.run_id = p_run and m.mode = 'opening_balance' and m.status in ('valid', 'imported', 'failed')
         group by upper(m.payload ->> 'currency')) q), '[]'::jsonb),
    'problems', coalesce((select jsonb_agg(jsonb_build_object('source_id', m.source_id, 'status', m.status, 'errors', m.errors, 'attempts', m.attempts) order by m.id)
        from finance_v3.migration_records m where m.run_id = p_run and m.status in ('invalid', 'failed', 'duplicate', 'skipped')), '[]'::jsonb));
end;
$$;

do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'fin3\_%' loop
    execute format('revoke all on function %s from public, anon, service_role', r.sig);
    execute format('grant execute on function %s to authenticated', r.sig);
  end loop;
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'fin3svc\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'finance_v3' loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', r.sig);
  end loop;
end $$;
grant execute on function finance_v3.has_permission(uuid, text) to authenticated;

commit;
