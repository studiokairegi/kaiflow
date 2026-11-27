-- Finance V3, Phase 3 (migration 2 of 6): sales and accounts receivable.
--
-- Invoice lifecycle: draft -> approved -> issued -> (partially_paid | paid | credited) or void. An issued invoice preserves its
-- historical contents (database guard, V3002): corrections are credit adjustments, voiding (a ledger reversal) or replacement.
-- Money is posted ONLY through finance_v3.post_event / reverse_entry (architecture D-06). Amounts are decimal strings on the wire
-- and exact numeric(19,4) in storage; rounding happens once per line, in the database, to the currency's minor unit.
-- Payment columns (amount_paid) are maintained by finance_v3.recompute_receivable (migration 3), derived from verified payments.
-- Rollback: supabase/rollback/20270114091000_finance_v3_receivables.rollback.sql
--
-- NOT EXECUTED: written in a sandbox without PostgreSQL; statically checked only. See PHASE_3_HANDOFF.md.

begin;

insert into finance_v3.schema_version (version, notes)
values ('20270114091000', 'phase 3 migration 2: receivables (invoices), credits, aging')
on conflict (version) do nothing;

-- Event kinds used by this phase. Reserved kinds are enabled together with the domain RPC that posts them.
insert into finance_v3.event_kinds (kind, description, required_permission, allows_provider, is_enabled, phase_available) values
  ('credit_note',  'Credit adjustment against an issued invoice',               'finance.approve',        false, true, 3),
  ('provider_fee', 'Fee charged by a payment provider for a verified payment',  'finance.verify_payment', true,  true, 3)
on conflict (kind) do nothing;
update finance_v3.event_kinds set is_enabled = true, phase_available = 3
 where kind in ('invoice_issued', 'bill_approved', 'bill_payment', 'expense_paid', 'bank_transfer', 'legacy_import');

-- ---------------------------------------------------------------------------------------------------------------
-- receivables (client invoices)
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists finance_v3.receivables (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references finance_v3.org_settings(organization_id) on delete restrict,
  client_id          uuid not null,
  project_id         uuid,
  invoice_no         text,
  status             text not null default 'draft'
                       check (status in ('draft', 'approved', 'issued', 'partially_paid', 'paid', 'credited', 'void')),
  currency           text not null references finance_v3.currencies(code),
  issue_date         date,
  due_date           date,
  payment_terms_days smallint check (payment_terms_days is null or payment_terms_days between 0 and 365),
  payment_terms_text text check (payment_terms_text is null or char_length(payment_terms_text) <= 200),
  subtotal           numeric(19,4) not null default 0 check (subtotal >= 0),
  discount_total     numeric(19,4) not null default 0 check (discount_total >= 0),
  tax_total          numeric(19,4) not null default 0 check (tax_total >= 0),
  total              numeric(19,4) not null default 0 check (total >= 0),
  amount_paid        numeric(19,4) not null default 0 check (amount_paid >= 0),
  credit_total       numeric(19,4) not null default 0 check (credit_total >= 0),
  outstanding        numeric(19,4) generated always as (total - amount_paid - credit_total) stored,
  notes              text check (notes is null or char_length(notes) <= 2000),
  po_reference       text check (po_reference is null or char_length(po_reference) <= 80),
  revision           integer not null default 1 check (revision >= 1),
  origin             text not null default 'native' check (origin in ('native', 'legacy')),
  ledger_mode        text not null default 'full' check (ledger_mode in ('full', 'opening_balance', 'document_only')),
  snapshot           jsonb,
  issued_entry_id    uuid,
  void_entry_id      uuid,
  void_reason        text check (void_reason is null or char_length(void_reason) <= 500),
  idempotency_key    text check (idempotency_key is null or (char_length(idempotency_key) between 1 and 200 and idempotency_key ~ '^[A-Za-z0-9_.:-]+$')),
  source_legacy_id   text,
  created_by         uuid,
  created_at         timestamptz not null default now(),
  approved_by        uuid,
  approved_at        timestamptz,
  issued_by          uuid,
  issued_at          timestamptz,
  voided_by          uuid,
  voided_at          timestamptz,
  updated_at         timestamptz not null default now(),
  constraint uq_rcv_org_id unique (organization_id, id),
  constraint fk_rcv_client foreign key (organization_id, client_id)
    references finance_v3.contacts_v3 (organization_id, id) on delete restrict,
  constraint fk_rcv_issued_entry foreign key (organization_id, issued_entry_id)
    references finance_v3.journal_entries (organization_id, id) on delete restrict,
  constraint fk_rcv_void_entry foreign key (organization_id, void_entry_id)
    references finance_v3.journal_entries (organization_id, id) on delete restrict,
  constraint ck_rcv_settled check (amount_paid + credit_total <= total),
  constraint ck_rcv_dates check (due_date is null or issue_date is null or due_date >= issue_date),
  constraint ck_rcv_issued_complete check (
    status in ('draft', 'approved')
    or (invoice_no is not null and issue_date is not null and due_date is not null and snapshot is not null)),
  constraint ck_rcv_void check ((status = 'void') = (voided_at is not null)),
  constraint ck_rcv_total check (total = subtotal - discount_total + tax_total)
);
create unique index if not exists uq_rcv_invoice_no on finance_v3.receivables (organization_id, invoice_no) where invoice_no is not null;
create unique index if not exists uq_rcv_idem on finance_v3.receivables (organization_id, idempotency_key) where idempotency_key is not null;
create unique index if not exists uq_rcv_legacy on finance_v3.receivables (organization_id, source_legacy_id) where source_legacy_id is not null;
create index if not exists ix_rcv_org_status_due on finance_v3.receivables (organization_id, status, due_date);
create index if not exists ix_rcv_org_client on finance_v3.receivables (organization_id, client_id);
create index if not exists ix_rcv_org_created on finance_v3.receivables (organization_id, created_at desc, id desc);

create table if not exists finance_v3.receivable_lines (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  receivable_id   uuid not null,
  line_no         smallint not null check (line_no between 1 and 200),
  description     text not null check (char_length(btrim(description)) between 1 and 500),
  quantity        numeric(19,4) not null check (quantity > 0),
  unit_price      numeric(19,4) not null check (unit_price >= 0),
  discount_pct    numeric(7,4) not null default 0 check (discount_pct between 0 and 100),
  tax_rate        numeric(7,4) not null default 0 check (tax_rate between 0 and 100),
  gross_amount    numeric(19,4) not null check (gross_amount >= 0),
  discount_amount numeric(19,4) not null check (discount_amount >= 0),
  net_amount      numeric(19,4) not null check (net_amount >= 0),
  tax_amount      numeric(19,4) not null check (tax_amount >= 0),
  line_total      numeric(19,4) not null check (line_total >= 0),
  account_id      uuid not null,
  constraint uq_rl_line unique (receivable_id, line_no),
  constraint fk_rl_receivable foreign key (organization_id, receivable_id)
    references finance_v3.receivables (organization_id, id) on delete cascade,
  constraint fk_rl_account foreign key (organization_id, account_id)
    references finance_v3.accounts (organization_id, id) on delete restrict,
  constraint ck_rl_math check (discount_amount <= gross_amount and net_amount = gross_amount - discount_amount
                               and line_total = net_amount + tax_amount)
);
create index if not exists ix_rl_receivable on finance_v3.receivable_lines (receivable_id);

create table if not exists finance_v3.receivable_credits (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  receivable_id   uuid not null,
  credit_no       text not null,
  amount          numeric(19,4) not null check (amount > 0),
  tax_part        numeric(19,4) not null default 0 check (tax_part >= 0 and tax_part <= amount),
  currency        text not null references finance_v3.currencies(code),
  reason          text not null check (char_length(btrim(reason)) between 1 and 500),
  entry_id        uuid not null,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200 and idempotency_key ~ '^[A-Za-z0-9_.:-]+$'),
  created_by      uuid,
  created_at      timestamptz not null default now(),
  constraint fk_rc_receivable foreign key (organization_id, receivable_id)
    references finance_v3.receivables (organization_id, id) on delete restrict,
  constraint fk_rc_entry foreign key (organization_id, entry_id)
    references finance_v3.journal_entries (organization_id, id) on delete restrict,
  constraint uq_rc_no unique (organization_id, credit_no),
  constraint uq_rc_key unique (organization_id, idempotency_key)
);
create index if not exists ix_rc_receivable on finance_v3.receivable_credits (organization_id, receivable_id);
drop trigger if exists tg_append_only on finance_v3.receivable_credits;
create trigger tg_append_only before update or delete on finance_v3.receivable_credits
  for each row execute function finance_v3.tg_append_only();

-- ---------------------------------------------------------------------------------------------------------------
-- Guards (database-enforced; clients have no DML privilege anyway - defense in depth).
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.tg_guard_receivables()
returns trigger
language plpgsql
set search_path = pg_catalog, finance_v3
as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'Invoice % cannot be deleted. Void it instead.', coalesce(old.invoice_no, old.id::text) using errcode = 'V3002';
    end if;
    return old;
  end if;
  if new.organization_id <> old.organization_id then
    raise exception 'An invoice cannot be moved to another studio.' using errcode = 'V3002';
  end if;
  if old.status = 'void' then
    raise exception 'Invoice % is void and cannot be changed.', old.invoice_no using errcode = 'V3002';
  end if;
  if old.status not in ('draft', 'approved') then
    -- The issued content is frozen. Only status, settlement columns and void facts may move.
    if row(new.client_id, new.project_id, new.invoice_no, new.currency, new.issue_date, new.due_date, new.payment_terms_days,
           new.payment_terms_text, new.subtotal, new.discount_total, new.tax_total, new.total, new.notes, new.po_reference,
           new.snapshot, new.origin, new.ledger_mode, new.issued_entry_id, new.issued_by, new.issued_at, new.created_by,
           new.created_at, new.idempotency_key, new.source_legacy_id)
       is distinct from
       row(old.client_id, old.project_id, old.invoice_no, old.currency, old.issue_date, old.due_date, old.payment_terms_days,
           old.payment_terms_text, old.subtotal, old.discount_total, old.tax_total, old.total, old.notes, old.po_reference,
           old.snapshot, old.origin, old.ledger_mode, old.issued_entry_id, old.issued_by, old.issued_at, old.created_by,
           old.created_at, old.idempotency_key, old.source_legacy_id) then
      raise exception 'An issued invoice keeps its historical contents. Use a credit adjustment, void it, or issue a replacement.'
        using errcode = 'V3002';
    end if;
    if new.status in ('draft', 'approved') then
      raise exception 'An issued invoice cannot go back to draft.' using errcode = 'V3002';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists tg_guard_receivables on finance_v3.receivables;
create trigger tg_guard_receivables before update or delete on finance_v3.receivables
  for each row execute function finance_v3.tg_guard_receivables();
drop trigger if exists tg_no_truncate on finance_v3.receivables;
create trigger tg_no_truncate before truncate on finance_v3.receivables
  for each statement execute function finance_v3.tg_no_truncate();

create or replace function finance_v3.tg_guard_receivable_lines()
returns trigger
language plpgsql
set search_path = pg_catalog, finance_v3
as $$
declare
  v_status text;
  v_id     uuid := case when tg_op = 'DELETE' then old.receivable_id else new.receivable_id end;
  v_org    uuid := case when tg_op = 'DELETE' then old.organization_id else new.organization_id end;
begin
  select r.status into v_status from finance_v3.receivables r where r.organization_id = v_org and r.id = v_id;
  if not found then
    -- Parent already deleted (cascade from deleting a draft): allow.
    if tg_op = 'DELETE' then return old; end if;
    raise exception 'The invoice does not exist.' using errcode = 'V3010';
  end if;
  if v_status <> 'draft' then
    raise exception 'The lines of an invoice can only be changed while it is a draft.' using errcode = 'V3002';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists tg_guard_receivable_lines on finance_v3.receivable_lines;
create trigger tg_guard_receivable_lines before insert or update or delete on finance_v3.receivable_lines
  for each row execute function finance_v3.tg_guard_receivable_lines();

-- ---------------------------------------------------------------------------------------------------------------
-- Row level security (SELECT only, finance.read) and privileges
-- ---------------------------------------------------------------------------------------------------------------
alter table finance_v3.receivables        enable row level security;
alter table finance_v3.receivable_lines   enable row level security;
alter table finance_v3.receivable_credits enable row level security;

drop policy if exists fin3_select_receivables on finance_v3.receivables;
create policy fin3_select_receivables on finance_v3.receivables for select to authenticated
  using (finance_v3.has_permission(organization_id, 'finance.read'));
drop policy if exists fin3_select_receivable_lines on finance_v3.receivable_lines;
create policy fin3_select_receivable_lines on finance_v3.receivable_lines for select to authenticated
  using (finance_v3.has_permission(organization_id, 'finance.read'));
drop policy if exists fin3_select_receivable_credits on finance_v3.receivable_credits;
create policy fin3_select_receivable_credits on finance_v3.receivable_credits for select to authenticated
  using (finance_v3.has_permission(organization_id, 'finance.read'));

revoke all on finance_v3.receivables, finance_v3.receivable_lines, finance_v3.receivable_credits
  from public, anon, authenticated, service_role;
grant select on finance_v3.receivables, finance_v3.receivable_lines, finance_v3.receivable_credits to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- JSON shaping
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.invoice_json(r finance_v3.receivables, p_with_lines boolean default true)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_client jsonb;
  v_lines  jsonb := '[]'::jsonb;
  v_overdue boolean := r.status in ('issued', 'partially_paid') and r.due_date is not null and r.due_date < current_date;
begin
  select jsonb_build_object('id', c.id, 'name', c.name, 'email', c.email) into v_client
    from finance_v3.contacts_v3 c where c.organization_id = r.organization_id and c.id = r.client_id;
  if p_with_lines then
    select coalesce(jsonb_agg(jsonb_build_object(
             'line_no', l.line_no, 'description', l.description, 'quantity', l.quantity::text, 'unit_price', l.unit_price::text,
             'discount_pct', l.discount_pct::text, 'tax_rate', l.tax_rate::text,
             'gross_amount', finance_v3.money_text(l.gross_amount, r.currency),
             'discount_amount', finance_v3.money_text(l.discount_amount, r.currency),
             'net_amount', finance_v3.money_text(l.net_amount, r.currency),
             'tax_amount', finance_v3.money_text(l.tax_amount, r.currency),
             'line_total', finance_v3.money_text(l.line_total, r.currency), 'account_id', l.account_id) order by l.line_no), '[]'::jsonb)
      into v_lines from finance_v3.receivable_lines l where l.organization_id = r.organization_id and l.receivable_id = r.id;
  end if;
  return jsonb_build_object(
    'id', r.id, 'invoice_no', r.invoice_no, 'status', r.status, 'client', v_client, 'project_id', r.project_id,
    'currency', r.currency, 'issue_date', r.issue_date, 'due_date', r.due_date,
    'payment_terms_days', r.payment_terms_days, 'payment_terms_text', r.payment_terms_text,
    'subtotal', finance_v3.money_text(r.subtotal, r.currency), 'discount_total', finance_v3.money_text(r.discount_total, r.currency),
    'tax_total', finance_v3.money_text(r.tax_total, r.currency), 'total', finance_v3.money_text(r.total, r.currency),
    'amount_paid', finance_v3.money_text(r.amount_paid, r.currency), 'credit_total', finance_v3.money_text(r.credit_total, r.currency),
    'outstanding', finance_v3.money_text(r.outstanding, r.currency),
    'is_overdue', v_overdue, 'days_overdue', case when v_overdue then current_date - r.due_date else 0 end,
    'notes', r.notes, 'po_reference', r.po_reference, 'revision', r.revision, 'origin', r.origin, 'ledger_mode', r.ledger_mode,
    'issued_entry_id', r.issued_entry_id, 'void_entry_id', r.void_entry_id, 'void_reason', r.void_reason,
    'created_at', r.created_at, 'approved_at', r.approved_at, 'issued_at', r.issued_at, 'voided_at', r.voided_at,
    'lines', v_lines);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- fin3_save_invoice_draft: create (p_invoice null, idempotent by p_key) or replace the content of a DRAFT invoice.
-- p_lines element: { description, quantity:"2", unit_price:"100.00", discount_pct?:"10", tax_rate?:"16", account_code? }
-- Line arithmetic (exact, in the database): gross = round(qty x price), discount = round(gross x pct / 100),
-- net = gross - discount, tax = round(net x rate / 100), total = net + tax. Rounding: half away from zero, currency minor unit.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fin3_save_invoice_draft(
  p_org uuid, p_key text, p_invoice uuid, p_client uuid, p_currency text, p_issue_date date, p_due_date date,
  p_terms_days integer, p_notes text, p_po text, p_project uuid, p_lines jsonb)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid    uuid := finance_v3.assert_permission(p_org, 'finance.post');
  s        finance_v3.org_settings;
  r        finance_v3.receivables;
  v_client finance_v3.contacts_v3;
  v_minor  integer;
  e        jsonb;
  ord      bigint;
  v_k      text;
  v_desc   text;
  v_qty    numeric;
  v_price  numeric;
  v_dpct   numeric;
  v_trate  numeric;
  v_gross  numeric;
  v_disc   numeric;
  v_net    numeric;
  v_tax    numeric;
  v_acct   uuid;
  v_sub    numeric := 0;
  v_dtot   numeric := 0;
  v_ttot   numeric := 0;
  v_before jsonb;
begin
  s := finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);

  v_minor := finance_v3.minor_unit(upper(coalesce(p_currency, '')))::integer;
  if v_minor is null then raise exception 'Choose a supported invoice currency.' using errcode = 'V3011'; end if;
  select * into v_client from finance_v3.contacts_v3 c where c.organization_id = p_org and c.id = p_client;
  if not found or v_client.kind <> 'client' then raise exception 'Choose a client of this studio.' using errcode = 'V3010'; end if;
  if not v_client.is_active then raise exception 'This client is inactive.' using errcode = 'V3011'; end if;
  if p_project is not null and not finance_v3.project_in_org(p_org, p_project) then
    raise exception 'The project is not part of this studio.' using errcode = 'V3011';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) > 200 then
    raise exception 'Invoice lines must be a list of at most 200 lines.' using errcode = 'V3011';
  end if;

  if p_invoice is null then
    if p_key is null or char_length(p_key) not between 1 and 200 or p_key !~ '^[A-Za-z0-9_.:-]+$' then
      raise exception 'A valid idempotency key is required to create an invoice.' using errcode = 'V3011';
    end if;
    select * into r from finance_v3.receivables x where x.organization_id = p_org and x.idempotency_key = p_key;
    if found then return finance_v3.invoice_json(r, true); end if;   -- replay: the original draft
    begin
      insert into finance_v3.receivables (organization_id, client_id, currency, idempotency_key, created_by)
      values (p_org, p_client, upper(p_currency), p_key, v_uid) returning * into r;
    exception when check_violation then
      raise exception 'One of the invoice values is not valid.' using errcode = 'V3011';
    end;
    v_before := null;
  else
    select * into r from finance_v3.receivables x where x.organization_id = p_org and x.id = p_invoice for update;
    if not found then raise exception 'Invoice not found.' using errcode = 'V3010'; end if;
    if r.status <> 'draft' then
      raise exception 'Only a draft invoice can be edited. Return an approved invoice to draft first; an issued invoice changes only by credit adjustment, voiding or replacement.'
        using errcode = 'V3017';
    end if;
    v_before := finance_v3.invoice_json(r, false);
  end if;

  delete from finance_v3.receivable_lines l where l.organization_id = p_org and l.receivable_id = r.id;
  for e, ord in select value, ordinality from jsonb_array_elements(p_lines) with ordinality loop
    if jsonb_typeof(e) <> 'object' then raise exception 'Line % is not an object.', ord using errcode = 'V3011'; end if;
    select k into v_k from jsonb_object_keys(e) k
     where k not in ('description', 'quantity', 'unit_price', 'discount_pct', 'tax_rate', 'account_code') limit 1;
    if v_k is not null then raise exception 'Line % has an unknown field "%".', ord, v_k using errcode = 'V3011'; end if;
    v_desc := btrim(coalesce(e ->> 'description', ''));
    if char_length(v_desc) not between 1 and 500 then
      raise exception 'Line % needs a description of 1 to 500 characters.', ord using errcode = 'V3011';
    end if;
    v_qty   := finance_v3.parse_decimal(e -> 'quantity', format('Line %s quantity', ord), 4, 0.0001, 999999999, null);
    v_price := finance_v3.parse_decimal(e -> 'unit_price', format('Line %s unit price', ord), 4, 0, 999999999999, null);
    v_dpct  := finance_v3.parse_decimal(e -> 'discount_pct', format('Line %s discount', ord), 4, 0, 100, 0);
    v_trate := finance_v3.parse_decimal(e -> 'tax_rate', format('Line %s tax rate', ord), 4, 0, 100, 0);
    if nullif(e ->> 'account_code', '') is null then
      v_acct := finance_v3.system_account(p_org, 'revenue_animation');
    else
      select a.id into v_acct from finance_v3.accounts a
       where a.organization_id = p_org and a.code = (e ->> 'account_code') and a.is_active and a.is_postable
         and a.account_type in ('revenue', 'other_income');
      if v_acct is null then
        raise exception 'Line % uses an account that is not an active revenue account of this studio.', ord using errcode = 'V3009';
      end if;
    end if;
    v_gross := round(v_qty * v_price, v_minor);
    v_disc  := round(v_gross * v_dpct / 100, v_minor);
    v_net   := v_gross - v_disc;
    v_tax   := round(v_net * v_trate / 100, v_minor);
    if v_gross > 999999999999 then raise exception 'Line % amount is too large.', ord using errcode = 'V3011'; end if;
    insert into finance_v3.receivable_lines (organization_id, receivable_id, line_no, description, quantity, unit_price,
      discount_pct, tax_rate, gross_amount, discount_amount, net_amount, tax_amount, line_total, account_id)
    values (p_org, r.id, ord, v_desc, v_qty, v_price, v_dpct, v_trate, v_gross, v_disc, v_net, v_tax, v_net + v_tax, v_acct);
    v_sub := v_sub + v_gross; v_dtot := v_dtot + v_disc; v_ttot := v_ttot + v_tax;
  end loop;

  begin
    update finance_v3.receivables x set
      client_id = p_client, currency = upper(p_currency), project_id = p_project, issue_date = p_issue_date, due_date = p_due_date,
      payment_terms_days = p_terms_days, notes = nullif(btrim(p_notes), ''), po_reference = nullif(btrim(p_po), ''),
      subtotal = v_sub, discount_total = v_dtot, tax_total = v_ttot, total = v_sub - v_dtot + v_ttot, updated_at = now()
     where x.organization_id = p_org and x.id = r.id
     returning * into r;
  exception when check_violation or numeric_value_out_of_range then
    raise exception 'One of the invoice values is not valid (check the dates, terms and amounts).' using errcode = 'V3011';
  end;
  perform finance_v3.write_audit(p_org, v_uid, case when v_before is null then 'create_invoice_draft' else 'update_invoice_draft' end,
    'receivable', r.id::text, v_before, finance_v3.invoice_json(r, false), null);
  return finance_v3.invoice_json(r, true);
end;
$$;

create or replace function public.fin3_discard_invoice_draft(p_org uuid, p_invoice uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.post');
  r     finance_v3.receivables;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  select * into r from finance_v3.receivables x where x.organization_id = p_org and x.id = p_invoice for update;
  if not found then raise exception 'Invoice not found.' using errcode = 'V3010'; end if;
  if r.status <> 'draft' then
    raise exception 'Only a draft can be discarded. Void an issued invoice instead.' using errcode = 'V3017';
  end if;
  delete from finance_v3.receivables x where x.organization_id = p_org and x.id = r.id;
  perform finance_v3.write_audit(p_org, v_uid, 'discard_invoice_draft', 'receivable', r.id::text,
    finance_v3.invoice_json(r, false), null, nullif(btrim(p_reason), ''));
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Approval
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fin3_approve_invoice(p_org uuid, p_invoice uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.approve');
  r     finance_v3.receivables;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  select * into r from finance_v3.receivables x where x.organization_id = p_org and x.id = p_invoice for update;
  if not found then raise exception 'Invoice not found.' using errcode = 'V3010'; end if;
  if r.status = 'approved' then return finance_v3.invoice_json(r, true); end if;   -- idempotent
  if r.status <> 'draft' then raise exception 'Only a draft invoice can be approved.' using errcode = 'V3017'; end if;
  if r.total <= 0 or not exists (select 1 from finance_v3.receivable_lines l where l.organization_id = p_org and l.receivable_id = r.id) then
    raise exception 'An invoice needs at least one line and a total above zero before approval.' using errcode = 'V3017';
  end if;
  update finance_v3.receivables x set status = 'approved', approved_by = v_uid, approved_at = now(), updated_at = now()
   where x.organization_id = p_org and x.id = r.id returning * into r;
  perform finance_v3.write_audit(p_org, v_uid, 'approve_invoice', 'receivable', r.id::text, null, finance_v3.invoice_json(r, false), null);
  return finance_v3.invoice_json(r, true);
end;
$$;

create or replace function public.fin3_return_invoice_to_draft(p_org uuid, p_invoice uuid, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.approve');
  r     finance_v3.receivables;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  select * into r from finance_v3.receivables x where x.organization_id = p_org and x.id = p_invoice for update;
  if not found then raise exception 'Invoice not found.' using errcode = 'V3010'; end if;
  if r.status = 'draft' then return finance_v3.invoice_json(r, true); end if;
  if r.status <> 'approved' then raise exception 'Only an approved invoice can go back to draft.' using errcode = 'V3017'; end if;
  update finance_v3.receivables x set status = 'draft', approved_by = null, approved_at = null, updated_at = now()
   where x.organization_id = p_org and x.id = r.id returning * into r;
  perform finance_v3.write_audit(p_org, v_uid, 'return_invoice_to_draft', 'receivable', r.id::text, null,
    finance_v3.invoice_json(r, false), nullif(btrim(p_reason), ''));
  return finance_v3.invoice_json(r, true);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Issuance (internal, shared with the "issue and send" RPC in the email migration).
-- Validates, numbers, snapshots and posts: Dr Accounts Receivable (total) / Cr Revenue (net per account) / Cr Tax Payable.
-- Idempotent: an already issued invoice is returned unchanged.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.issue_invoice_internal(p_org uuid, p_invoice uuid, p_actor uuid)
returns finance_v3.receivables
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  s        finance_v3.org_settings;
  r        finance_v3.receivables;
  c        finance_v3.contacts_v3;
  v_lines  jsonb := '[]'::jsonb;
  v_snap   jsonb;
  v_no     text;
  v_issue  date;
  v_due    date;
  v_terms  smallint;
  v_entry  uuid;
  v_ar     uuid;
  v_tax    uuid;
  rev      record;
begin
  perform finance_v3.lock_org(p_org);
  select * into s from finance_v3.org_settings where organization_id = p_org;
  select * into r from finance_v3.receivables x where x.organization_id = p_org and x.id = p_invoice for update;
  if not found then raise exception 'Invoice not found.' using errcode = 'V3010'; end if;
  if r.status not in ('draft', 'approved') then
    if r.status = 'void' then raise exception 'A void invoice cannot be issued.' using errcode = 'V3017'; end if;
    return r;                                                    -- already issued: idempotent
  end if;
  if r.status = 'draft' and s.invoice_approval_required then
    raise exception 'This studio requires approval before an invoice is issued.' using errcode = 'V3017';
  end if;
  if r.total <= 0 or not exists (select 1 from finance_v3.receivable_lines l where l.organization_id = p_org and l.receivable_id = r.id) then
    raise exception 'An invoice needs at least one line and a total above zero.' using errcode = 'V3017';
  end if;
  select * into c from finance_v3.contacts_v3 x where x.organization_id = p_org and x.id = r.client_id;
  if not c.is_active then raise exception 'The client of this invoice is inactive.' using errcode = 'V3017'; end if;

  v_issue := coalesce(r.issue_date, current_date);
  v_terms := coalesce(r.payment_terms_days, s.default_payment_terms_days);
  v_due   := coalesce(r.due_date, v_issue + v_terms);
  if v_due < v_issue then raise exception 'The due date cannot be before the issue date.' using errcode = 'V3011'; end if;

  v_no := finance_v3.next_doc_number(p_org, 'invoice');
  select coalesce(jsonb_agg(jsonb_build_object(
           'line_no', l.line_no, 'description', l.description, 'quantity', l.quantity::text, 'unit_price', l.unit_price::text,
           'discount_pct', l.discount_pct::text, 'tax_rate', l.tax_rate::text,
           'gross_amount', finance_v3.money_text(l.gross_amount, r.currency), 'discount_amount', finance_v3.money_text(l.discount_amount, r.currency),
           'net_amount', finance_v3.money_text(l.net_amount, r.currency), 'tax_amount', finance_v3.money_text(l.tax_amount, r.currency),
           'line_total', finance_v3.money_text(l.line_total, r.currency)) order by l.line_no), '[]'::jsonb)
    into v_lines from finance_v3.receivable_lines l where l.organization_id = p_org and l.receivable_id = r.id;

  -- The snapshot is the frozen, human-facing content of the invoice (PDF and email render from it).
  v_snap := jsonb_build_object(
    'invoice_no', v_no, 'currency', r.currency, 'issue_date', v_issue, 'due_date', v_due, 'payment_terms_days', v_terms,
    'studio', jsonb_build_object('name', coalesce(s.studio_name, ''), 'address', s.studio_address, 'email', s.studio_email,
                                 'phone', s.studio_phone, 'tax_id', s.studio_tax_id, 'brand_color', s.brand_color),
    'client', jsonb_build_object('name', c.name, 'email', c.email, 'address', c.address, 'tax_id', c.tax_id),
    'lines', v_lines,
    'subtotal', finance_v3.money_text(r.subtotal, r.currency), 'discount_total', finance_v3.money_text(r.discount_total, r.currency),
    'tax_total', finance_v3.money_text(r.tax_total, r.currency), 'total', finance_v3.money_text(r.total, r.currency),
    'notes', r.notes, 'po_reference', r.po_reference, 'payment_instructions', s.payment_instructions, 'revision', r.revision);

  v_ar := finance_v3.system_account(p_org, 'accounts_receivable');
  v_lines := jsonb_build_array(jsonb_build_object('account_id', v_ar, 'side', 'debit',
                                                  'amount', finance_v3.money_text(r.total, r.currency), 'currency', r.currency));
  for rev in
    select l.account_id, sum(l.net_amount) as net
      from finance_v3.receivable_lines l where l.organization_id = p_org and l.receivable_id = r.id
     group by l.account_id having sum(l.net_amount) > 0 order by l.account_id
  loop
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', rev.account_id, 'side', 'credit',
                                            'amount', finance_v3.money_text(rev.net, r.currency), 'currency', r.currency));
  end loop;
  if r.tax_total > 0 then
    v_tax := finance_v3.system_account(p_org, 'tax_payable');
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', v_tax, 'side', 'credit',
                                            'amount', finance_v3.money_text(r.tax_total, r.currency), 'currency', r.currency));
  end if;

  v_entry := finance_v3.post_event(p_org, 'invoice_issued', 'fin3:invoice:' || r.id::text || ':issue', v_issue, v_lines,
    jsonb_strip_nulls(jsonb_build_object('memo', left('Invoice ' || v_no || ' - ' || c.name, 500), 'reference', v_no, 'project_id', r.project_id)));

  update finance_v3.receivables x set
    status = 'issued', invoice_no = v_no, issue_date = v_issue, due_date = v_due, payment_terms_days = v_terms,
    snapshot = v_snap, issued_entry_id = v_entry, issued_by = p_actor, issued_at = now(), updated_at = now(),
    approved_by = coalesce(x.approved_by, p_actor), approved_at = coalesce(x.approved_at, now())
   where x.organization_id = p_org and x.id = r.id returning * into r;
  perform finance_v3.write_audit(p_org, p_actor, 'issue_invoice', 'receivable', r.id::text, null,
    jsonb_build_object('invoice_no', v_no, 'total', finance_v3.money_text(r.total, r.currency), 'currency', r.currency, 'entry_id', v_entry), null);
  return r;
end;
$$;

create or replace function public.fin3_issue_invoice(p_org uuid, p_invoice uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.post');
  r     finance_v3.receivables;
begin
  perform finance_v3.assert_org_ready(p_org);
  r := finance_v3.issue_invoice_internal(p_org, p_invoice, v_uid);
  return finance_v3.invoice_json(r, true);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Voiding an issued invoice: reverses its ledger entry (the original entry is never edited), revokes payment links and
-- cancels open payment attempts. Refused while money is recorded against it: reverse or refund the payments first.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fin3_void_invoice(p_org uuid, p_invoice uuid, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid    uuid := finance_v3.assert_permission(p_org, 'finance.approve');
  r        finance_v3.receivables;
  v_reason text := nullif(btrim(p_reason), '');
  v_rev    uuid;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  if v_reason is null or char_length(v_reason) > 500 then
    raise exception 'A reason (up to 500 characters) is required to void an invoice.' using errcode = 'V3011';
  end if;
  select * into r from finance_v3.receivables x where x.organization_id = p_org and x.id = p_invoice for update;
  if not found then raise exception 'Invoice not found.' using errcode = 'V3010'; end if;
  if r.status = 'void' then return finance_v3.invoice_json(r, true); end if;      -- idempotent
  if r.status in ('draft', 'approved') then
    raise exception 'A draft invoice is discarded, not voided.' using errcode = 'V3017';
  end if;
  if r.amount_paid > 0 or r.credit_total > 0
     or exists (select 1 from finance_v3.payments p where p.organization_id = p_org and p.invoice_id = r.id
                 and p.status in ('recorded', 'partially_refunded') and p.verification_status in ('verified', 'pending_verification')) then
    raise exception 'This invoice has payments or credits recorded. Reverse or refund the payments first.' using errcode = 'V3017';
  end if;
  if r.ledger_mode = 'full' or r.ledger_mode = 'opening_balance' then
    v_rev := finance_v3.reverse_entry(p_org, r.issued_entry_id, 'fin3:invoice:' || r.id::text || ':void', v_reason, null);
  end if;
  update finance_v3.public_links l set revoked_at = now() where l.organization_id = p_org and l.invoice_id = r.id and l.revoked_at is null;
  update finance_v3.payment_intents i set status = 'cancelled', updated_at = now()
   where i.organization_id = p_org and i.invoice_id = r.id and i.status in ('created', 'initialized', 'pending');
  update finance_v3.receivables x set status = 'void', void_entry_id = v_rev, void_reason = v_reason, voided_by = v_uid,
         voided_at = now(), updated_at = now()
   where x.organization_id = p_org and x.id = r.id returning * into r;
  perform finance_v3.write_audit(p_org, v_uid, 'void_invoice', 'receivable', r.id::text, null,
    jsonb_build_object('invoice_no', r.invoice_no, 'reversal_entry_id', v_rev), v_reason);
  return finance_v3.invoice_json(r, true);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Credit adjustment against an issued invoice (a separate financial event; the invoice itself is not edited).
-- Dr Revenue (net part) + Dr Tax Payable (tax part, pro rata to the invoice) / Cr Accounts Receivable (amount).
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fin3_credit_invoice(
  p_org uuid, p_key text, p_invoice uuid, p_amount text, p_reason text, p_account_code text default null)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid     uuid := finance_v3.assert_permission(p_org, 'finance.approve');
  r         finance_v3.receivables;
  v_amount  numeric;
  v_tax     numeric;
  v_net     numeric;
  v_reason  text := nullif(btrim(p_reason), '');
  v_rev     uuid;
  v_lines   jsonb;
  v_entry   uuid;
  v_no      text;
  v_credit  finance_v3.receivable_credits;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  if p_key is null or char_length(p_key) not between 1 and 200 or p_key !~ '^[A-Za-z0-9_.:-]+$' then
    raise exception 'A valid idempotency key is required.' using errcode = 'V3011';
  end if;
  select * into v_credit from finance_v3.receivable_credits c where c.organization_id = p_org and c.idempotency_key = p_key;
  if found then
    select * into r from finance_v3.receivables x where x.organization_id = p_org and x.id = v_credit.receivable_id;
    return finance_v3.invoice_json(r, true);                                         -- replay
  end if;
  if v_reason is null or char_length(v_reason) > 500 then
    raise exception 'A reason (up to 500 characters) is required for a credit adjustment.' using errcode = 'V3011';
  end if;
  select * into r from finance_v3.receivables x where x.organization_id = p_org and x.id = p_invoice for update;
  if not found then raise exception 'Invoice not found.' using errcode = 'V3010'; end if;
  if r.status not in ('issued', 'partially_paid') or r.ledger_mode = 'document_only' then
    raise exception 'A credit adjustment needs an issued invoice with an open balance.' using errcode = 'V3017';
  end if;
  v_amount := finance_v3.parse_money(p_amount, 'Credit amount', r.currency, false);
  if v_amount > r.outstanding then
    raise exception 'The credit (%) is more than the outstanding balance (%).', finance_v3.money_text(v_amount, r.currency),
      finance_v3.money_text(r.outstanding, r.currency) using errcode = 'V3012';
  end if;
  v_tax := case when r.total > 0 then round(v_amount * r.tax_total / r.total, finance_v3.minor_unit(r.currency)::integer) else 0 end;
  v_net := v_amount - v_tax;
  if nullif(p_account_code, '') is null then
    v_rev := finance_v3.system_account(p_org, 'revenue_animation');
  else
    select a.id into v_rev from finance_v3.accounts a
     where a.organization_id = p_org and a.code = p_account_code and a.is_active and a.is_postable and a.account_type in ('revenue', 'other_income');
    if v_rev is null then raise exception 'Choose an active revenue account.' using errcode = 'V3009'; end if;
  end if;
  v_lines := jsonb_build_array(
    jsonb_build_object('account_id', finance_v3.system_account(p_org, 'accounts_receivable'), 'side', 'credit',
                       'amount', finance_v3.money_text(v_amount, r.currency), 'currency', r.currency));
  if v_net > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', v_rev, 'side', 'debit',
                         'amount', finance_v3.money_text(v_net, r.currency), 'currency', r.currency));
  end if;
  if v_tax > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', finance_v3.system_account(p_org, 'tax_payable'), 'side', 'debit',
                         'amount', finance_v3.money_text(v_tax, r.currency), 'currency', r.currency));
  end if;
  v_no := finance_v3.next_doc_number(p_org, 'credit');
  v_entry := finance_v3.post_event(p_org, 'credit_note', 'fin3:invoice:' || r.id::text || ':credit:' || finance_v3.key_hash(p_key), current_date, v_lines,
    jsonb_strip_nulls(jsonb_build_object('memo', left('Credit ' || v_no || ' against invoice ' || r.invoice_no, 500),
                                         'reference', v_no, 'project_id', r.project_id)));
  insert into finance_v3.receivable_credits (organization_id, receivable_id, credit_no, amount, tax_part, currency, reason, entry_id,
                                             idempotency_key, created_by)
  values (p_org, r.id, v_no, v_amount, v_tax, r.currency, v_reason, v_entry, p_key, v_uid);
  r := finance_v3.recompute_receivable(p_org, r.id);
  perform finance_v3.write_audit(p_org, v_uid, 'credit_invoice', 'receivable', r.id::text, null,
    jsonb_build_object('credit_no', v_no, 'amount', finance_v3.money_text(v_amount, r.currency), 'entry_id', v_entry), v_reason);
  return finance_v3.invoice_json(r, true);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fin3_get_invoice(p_org uuid, p_invoice uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  r finance_v3.receivables;
  v jsonb;
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  select * into r from finance_v3.receivables x where x.organization_id = p_org and x.id = p_invoice;
  if not found then raise exception 'Invoice not found.' using errcode = 'V3010'; end if;
  v := finance_v3.invoice_json(r, true);
  v := v || jsonb_build_object(
    'credits', coalesce((select jsonb_agg(jsonb_build_object('credit_no', c.credit_no, 'amount', finance_v3.money_text(c.amount, c.currency),
               'reason', c.reason, 'entry_id', c.entry_id, 'created_at', c.created_at) order by c.created_at, c.id)
               from finance_v3.receivable_credits c where c.organization_id = p_org and c.receivable_id = r.id), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'method', p.method, 'amount', finance_v3.money_text(p.amount, p.currency),
               'refunded_amount', finance_v3.money_text(p.refunded_amount, p.currency), 'status', p.status,
               'verification_status', p.verification_status, 'received_at', p.received_at, 'reference', coalesce(p.provider_reference, p.reference))
               order by p.received_at, p.id)
               from finance_v3.payments p where p.organization_id = p_org and p.invoice_id = r.id), '[]'::jsonb));
  return v;
end;
$$;

create or replace function public.fin3_list_invoices(
  p_org uuid, p_status text default null, p_client uuid default null, p_overdue_only boolean default false,
  p_limit integer default 50, p_cursor jsonb default null)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_limit  integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_ts     timestamptz;
  v_id     uuid;
  v_rows   jsonb;
  v_count  integer;
  v_next   jsonb := null;
  v_last   record;
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  if p_status is not null and p_status not in ('draft', 'approved', 'issued', 'partially_paid', 'paid', 'credited', 'void') then
    raise exception 'Unknown invoice status.' using errcode = 'V3011';
  end if;
  if p_cursor is not null then
    if jsonb_typeof(p_cursor) <> 'object' or not finance_v3.valid_uuid(p_cursor ->> 'id') then
      raise exception 'Invalid cursor.' using errcode = 'V3011';
    end if;
    begin
      v_ts := (p_cursor ->> 'created_at')::timestamptz;
    exception when others then
      raise exception 'Invalid cursor.' using errcode = 'V3011';
    end;
    v_id := (p_cursor ->> 'id')::uuid;
  end if;
  with page as (
    select r.* from finance_v3.receivables r
     where r.organization_id = p_org
       and (p_status is null or r.status = p_status)
       and (p_client is null or r.client_id = p_client)
       and (not coalesce(p_overdue_only, false) or (r.status in ('issued', 'partially_paid') and r.due_date < current_date))
       and (v_ts is null or (r.created_at, r.id) < (v_ts, v_id))
     order by r.created_at desc, r.id desc
     limit v_limit + 1)
  select coalesce(jsonb_agg(finance_v3.invoice_json(p, false) order by p.created_at desc, p.id desc), '[]'::jsonb), count(*)
    into v_rows, v_count from page p;
  if v_count > v_limit then
    -- Drop the probe row and hand back a cursor positioned at the last row that is returned.
    v_rows := v_rows - v_limit;
    select (v_rows -> (v_limit - 1)) ->> 'created_at' as created_at, (v_rows -> (v_limit - 1)) ->> 'id' as id into v_last;
    v_next := jsonb_build_object('created_at', v_last.created_at, 'id', v_last.id);
  end if;
  return jsonb_build_object('items', v_rows, 'next_cursor', v_next);
end;
$$;

-- Receivables aging. Native amounts per currency (never summed across currencies). Reflects CURRENT outstanding balances
-- measured against p_as_of; it does not reconstruct historical balances.
create or replace function public.fin3_receivables_aging(p_org uuid, p_as_of date default current_date, p_currency text default null)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare v_out jsonb;
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  if p_as_of is null then raise exception 'An as-of date is required.' using errcode = 'V3011'; end if;
  with open as (
    select r.id, r.client_id, r.currency, r.outstanding as amt, (p_as_of - r.due_date) as d
      from finance_v3.receivables r
     where r.organization_id = p_org and r.status in ('issued', 'partially_paid') and r.outstanding > 0
       and r.issue_date <= p_as_of and (p_currency is null or r.currency = p_currency)
  ), tot as (
    select o.currency,
           sum(o.amt) filter (where o.d <= 0) as cur, sum(o.amt) filter (where o.d between 1 and 30) as b30,
           sum(o.amt) filter (where o.d between 31 and 60) as b60, sum(o.amt) filter (where o.d between 61 and 90) as b90,
           sum(o.amt) filter (where o.d > 90) as b90p, sum(o.amt) as total, count(*) as n
      from open o group by o.currency
  ), cli as (
    select o.currency, o.client_id,
           sum(o.amt) filter (where o.d <= 0) as cur, sum(o.amt) filter (where o.d between 1 and 30) as b30,
           sum(o.amt) filter (where o.d between 31 and 60) as b60, sum(o.amt) filter (where o.d between 61 and 90) as b90,
           sum(o.amt) filter (where o.d > 90) as b90p, sum(o.amt) as total, count(*) as n
      from open o group by o.currency, o.client_id
  )
  select jsonb_build_object('as_of', p_as_of,
    'totals', coalesce((select jsonb_agg(jsonb_build_object('currency', t.currency,
        'current', finance_v3.money_text(coalesce(t.cur, 0), t.currency), 'days_1_30', finance_v3.money_text(coalesce(t.b30, 0), t.currency),
        'days_31_60', finance_v3.money_text(coalesce(t.b60, 0), t.currency), 'days_61_90', finance_v3.money_text(coalesce(t.b90, 0), t.currency),
        'days_over_90', finance_v3.money_text(coalesce(t.b90p, 0), t.currency), 'total', finance_v3.money_text(t.total, t.currency),
        'invoice_count', t.n) order by t.currency) from tot t), '[]'::jsonb),
    'clients', coalesce((select jsonb_agg(jsonb_build_object('currency', x.currency, 'client_id', x.client_id, 'client_name', c.name,
        'current', finance_v3.money_text(coalesce(x.cur, 0), x.currency), 'days_1_30', finance_v3.money_text(coalesce(x.b30, 0), x.currency),
        'days_31_60', finance_v3.money_text(coalesce(x.b60, 0), x.currency), 'days_61_90', finance_v3.money_text(coalesce(x.b90, 0), x.currency),
        'days_over_90', finance_v3.money_text(coalesce(x.b90p, 0), x.currency), 'total', finance_v3.money_text(x.total, x.currency),
        'invoice_count', x.n) order by x.currency, lower(c.name), x.client_id)
        from cli x join finance_v3.contacts_v3 c on c.organization_id = p_org and c.id = x.client_id), '[]'::jsonb))
    into v_out;
  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Privileges (same rule as every Finance V3 migration)
-- ---------------------------------------------------------------------------------------------------------------
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
