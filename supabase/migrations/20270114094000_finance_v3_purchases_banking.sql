-- Finance V3, Phase 3 (migration 5 of 6): purchases and payables, expenses, banking, transfers, reconciliation.
--
-- Everything posts through finance_v3.post_event / reverse_entry (kinds bill_approved, bill_payment, expense_paid, bank_transfer).
-- Phase 3 scope notes (see PHASE_3_HANDOFF.md): bills, bill payments and expenses are single-currency (the payment account must
-- accept the document currency); cross-currency transfers need one side in the base currency and a stored rate (V3003 otherwise);
-- bills carry no tax lines; reconciliation only marks ledger lines as cleared and never changes the ledger.
-- Rollback: supabase/rollback/20270114094000_finance_v3_purchases_banking.rollback.sql
--
-- NOT EXECUTED: written in a sandbox without PostgreSQL; statically checked only. See PHASE_3_HANDOFF.md.

begin;

insert into finance_v3.schema_version (version, notes)
values ('20270114094000', 'phase 3 migration 5: payables, expenses, banking, transfers, reconciliation')
on conflict (version) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- Banking
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists finance_v3.bank_accounts (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references finance_v3.org_settings(organization_id) on delete restrict,
  ledger_account_id uuid not null,
  name              text not null check (char_length(btrim(name)) between 1 and 120),
  kind              text not null check (kind in ('bank', 'cash', 'mobile_money')),
  currency          text not null references finance_v3.currencies(code),
  account_last4     text check (account_last4 is null or account_last4 ~ '^[0-9A-Za-z]{2,4}$'),
  is_active         boolean not null default true,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint uq_bank_org_id unique (organization_id, id),
  constraint uq_bank_ledger unique (organization_id, ledger_account_id),
  constraint fk_bank_ledger foreign key (organization_id, ledger_account_id) references finance_v3.accounts (organization_id, id) on delete restrict
);

create table if not exists finance_v3.reconciliations (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references finance_v3.org_settings(organization_id) on delete restrict,
  bank_account_id   uuid not null,
  statement_date    date not null,
  statement_balance numeric(19,4) not null,
  currency          text not null references finance_v3.currencies(code),
  cleared_balance   numeric(19,4),
  difference        numeric(19,4),
  status            text not null default 'open' check (status in ('open', 'completed')),
  difference_reason text check (difference_reason is null or char_length(difference_reason) <= 500),
  created_by        uuid,
  created_at        timestamptz not null default now(),
  completed_by      uuid,
  completed_at      timestamptz,
  constraint uq_recon_org_id unique (organization_id, id),
  constraint fk_recon_bank foreign key (organization_id, bank_account_id) references finance_v3.bank_accounts (organization_id, id) on delete restrict,
  constraint ck_recon_done check (status = 'open' or (completed_at is not null and difference is not null))
);
create unique index if not exists uq_recon_one_open on finance_v3.reconciliations (organization_id, bank_account_id) where status = 'open';

create table if not exists finance_v3.reconciliation_lines (
  id                bigint generated always as identity primary key,
  organization_id   uuid not null,
  reconciliation_id uuid not null,
  line_id           uuid not null,
  constraint uq_recon_line unique (organization_id, line_id),
  constraint fk_rl_recon foreign key (organization_id, reconciliation_id) references finance_v3.reconciliations (organization_id, id) on delete cascade,
  constraint fk_rl_line foreign key (line_id) references finance_v3.journal_lines (id) on delete restrict
);

-- ---------------------------------------------------------------------------------------------------------------
-- Payables (supplier, contractor and freelancer bills)
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists finance_v3.payables (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references finance_v3.org_settings(organization_id) on delete restrict,
  supplier_id      uuid not null,
  bill_type        text not null check (bill_type in ('supplier', 'contractor', 'freelancer')),
  bill_no          text,
  supplier_ref     text check (supplier_ref is null or char_length(supplier_ref) <= 80),
  status           text not null default 'draft' check (status in ('draft', 'approved', 'partially_paid', 'paid', 'void')),
  currency         text not null references finance_v3.currencies(code),
  bill_date        date,
  due_date         date,
  project_id       uuid,
  total            numeric(19,4) not null default 0 check (total >= 0),
  amount_paid      numeric(19,4) not null default 0 check (amount_paid >= 0),
  outstanding      numeric(19,4) generated always as (total - amount_paid) stored,
  notes            text check (notes is null or char_length(notes) <= 1000),
  approved_entry_id uuid,
  void_entry_id    uuid,
  void_reason      text,
  idempotency_key  text check (idempotency_key is null or (char_length(idempotency_key) between 1 and 200 and idempotency_key ~ '^[A-Za-z0-9_.:-]+$')),
  created_by       uuid,
  approved_by      uuid,
  approved_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint uq_payables_org_id unique (organization_id, id),
  constraint fk_pb_supplier foreign key (organization_id, supplier_id) references finance_v3.contacts_v3 (organization_id, id) on delete restrict,
  constraint ck_pb_paid check (amount_paid <= total),
  constraint ck_pb_dates check (due_date is null or bill_date is null or due_date >= bill_date),
  constraint ck_pb_approved check (status in ('draft') or (bill_no is not null and bill_date is not null and due_date is not null and approved_entry_id is not null) or status = 'void')
);
create unique index if not exists uq_pb_no on finance_v3.payables (organization_id, bill_no) where bill_no is not null;
create unique index if not exists uq_pb_idem on finance_v3.payables (organization_id, idempotency_key) where idempotency_key is not null;
create unique index if not exists uq_pb_supplier_ref on finance_v3.payables (organization_id, supplier_id, supplier_ref) where supplier_ref is not null and status <> 'void';
create index if not exists ix_pb_org_status on finance_v3.payables (organization_id, status, due_date);

create table if not exists finance_v3.payable_lines (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  payable_id      uuid not null,
  line_no         smallint not null check (line_no between 1 and 200),
  description     text not null check (char_length(btrim(description)) between 1 and 500),
  amount          numeric(19,4) not null check (amount > 0),
  account_id      uuid not null,
  project_id      uuid,
  constraint uq_pbl unique (payable_id, line_no),
  constraint fk_pbl_payable foreign key (organization_id, payable_id) references finance_v3.payables (organization_id, id) on delete cascade,
  constraint fk_pbl_account foreign key (organization_id, account_id) references finance_v3.accounts (organization_id, id) on delete restrict
);

create table if not exists finance_v3.payable_payments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  payable_id      uuid not null,
  amount          numeric(19,4) not null check (amount > 0),
  currency        text not null references finance_v3.currencies(code),
  paid_on         date not null,
  pay_account_id  uuid not null,
  reference       text check (reference is null or char_length(reference) <= 120),
  entry_id        uuid not null,
  status          text not null default 'recorded' check (status in ('recorded', 'reversed')),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200 and idempotency_key ~ '^[A-Za-z0-9_.:-]+$'),
  created_by      uuid,
  created_at      timestamptz not null default now(),
  constraint uq_pbp_key unique (organization_id, idempotency_key),
  constraint fk_pbp_payable foreign key (organization_id, payable_id) references finance_v3.payables (organization_id, id) on delete restrict,
  constraint fk_pbp_account foreign key (organization_id, pay_account_id) references finance_v3.accounts (organization_id, id) on delete restrict,
  constraint fk_pbp_entry foreign key (organization_id, entry_id) references finance_v3.journal_entries (organization_id, id) on delete restrict
);
create index if not exists ix_pbp_payable on finance_v3.payable_payments (organization_id, payable_id);

-- ---------------------------------------------------------------------------------------------------------------
-- Expenses
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists finance_v3.expense_categories (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references finance_v3.org_settings(organization_id) on delete restrict,
  name            text not null check (char_length(btrim(name)) between 1 and 80),
  account_id      uuid not null,
  is_active       boolean not null default true,
  constraint uq_expcat_org_id unique (organization_id, id),
  constraint uq_expcat_name unique (organization_id, name),
  constraint fk_expcat_account foreign key (organization_id, account_id) references finance_v3.accounts (organization_id, id) on delete restrict
);

create table if not exists finance_v3.expense_records (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references finance_v3.org_settings(organization_id) on delete restrict,
  expense_no      text not null,
  vendor_id       uuid,
  vendor_name     text check (vendor_name is null or char_length(vendor_name) <= 160),
  category_id     uuid not null,
  project_id      uuid,
  description     text not null check (char_length(btrim(description)) between 1 and 500),
  amount          numeric(19,4) not null check (amount > 0),
  currency        text not null references finance_v3.currencies(code),
  expense_date    date not null,
  pay_account_id  uuid not null,
  tax_class       text not null default 'none' check (tax_class in ('none', 'vat_inclusive', 'vat_exempt', 'zero_rated', 'non_deductible')),
  payment_status  text not null default 'paid' check (payment_status in ('paid', 'reversed')),
  reference       text check (reference is null or char_length(reference) <= 120),
  entry_id        uuid not null,
  reversal_entry_id uuid,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200 and idempotency_key ~ '^[A-Za-z0-9_.:-]+$'),
  created_by      uuid,
  created_at      timestamptz not null default now(),
  constraint uq_exp_org_id unique (organization_id, id),
  constraint uq_exp_no unique (organization_id, expense_no),
  constraint uq_exp_key unique (organization_id, idempotency_key),
  constraint fk_exp_vendor foreign key (organization_id, vendor_id) references finance_v3.contacts_v3 (organization_id, id) on delete restrict,
  constraint fk_exp_category foreign key (organization_id, category_id) references finance_v3.expense_categories (organization_id, id) on delete restrict,
  constraint fk_exp_account foreign key (organization_id, pay_account_id) references finance_v3.accounts (organization_id, id) on delete restrict,
  constraint fk_exp_entry foreign key (organization_id, entry_id) references finance_v3.journal_entries (organization_id, id) on delete restrict
);
create index if not exists ix_exp_org_date on finance_v3.expense_records (organization_id, expense_date desc);

create table if not exists finance_v3.expense_attachments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  expense_id      uuid not null,
  file_name       text not null check (char_length(file_name) between 1 and 200),
  content_type    text not null check (content_type in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp')),
  byte_size       integer not null check (byte_size between 1 and 10485760),
  sha256          text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  storage_path    text not null check (char_length(storage_path) <= 400),
  created_by      uuid,
  created_at      timestamptz not null default now(),
  constraint fk_expatt foreign key (organization_id, expense_id) references finance_v3.expense_records (organization_id, id) on delete restrict
);

-- Money documents are never deleted; posted facts are frozen by the ledger itself. Payables keep their lines once approved.
create or replace function finance_v3.tg_no_delete_money()
returns trigger language plpgsql set search_path = pg_catalog, finance_v3 as $$
begin
  raise exception '% rows are never deleted. Reverse or void them instead.', tg_table_name using errcode = 'V3002';
end; $$;
drop trigger if exists tg_no_delete on finance_v3.payable_payments;
create trigger tg_no_delete before delete on finance_v3.payable_payments for each row execute function finance_v3.tg_no_delete_money();
drop trigger if exists tg_no_delete on finance_v3.expense_records;
create trigger tg_no_delete before delete on finance_v3.expense_records for each row execute function finance_v3.tg_no_delete_money();
drop trigger if exists tg_no_delete on finance_v3.expense_attachments;
create trigger tg_no_delete before delete on finance_v3.expense_attachments for each row execute function finance_v3.tg_no_delete_money();

create or replace function finance_v3.tg_guard_payables()
returns trigger language plpgsql set search_path = pg_catalog, finance_v3 as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then raise exception 'An approved bill cannot be deleted. Void it instead.' using errcode = 'V3002'; end if;
    return old;
  end if;
  if old.status = 'void' then raise exception 'A void bill cannot be changed.' using errcode = 'V3002'; end if;
  if old.status <> 'draft' and (new.supplier_id, new.bill_type, new.bill_no, new.currency, new.bill_date, new.due_date, new.total, new.approved_entry_id)
     is distinct from (old.supplier_id, old.bill_type, old.bill_no, old.currency, old.bill_date, old.due_date, old.total, old.approved_entry_id) then
    raise exception 'An approved bill keeps its historical contents. Void it and enter a new one.' using errcode = 'V3002';
  end if;
  return new;
end; $$;
drop trigger if exists tg_guard_payables on finance_v3.payables;
create trigger tg_guard_payables before update or delete on finance_v3.payables for each row execute function finance_v3.tg_guard_payables();

create or replace function finance_v3.tg_guard_payable_lines()
returns trigger language plpgsql set search_path = pg_catalog, finance_v3 as $$
declare v_status text; v_id uuid := case when tg_op = 'DELETE' then old.payable_id else new.payable_id end;
        v_org uuid := case when tg_op = 'DELETE' then old.organization_id else new.organization_id end;
begin
  select p.status into v_status from finance_v3.payables p where p.organization_id = v_org and p.id = v_id;
  if not found then
    if tg_op = 'DELETE' then return old; end if;
    raise exception 'The bill does not exist.' using errcode = 'V3010';
  end if;
  if v_status <> 'draft' then raise exception 'The lines of a bill can only change while it is a draft.' using errcode = 'V3002'; end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end; $$;
drop trigger if exists tg_guard_payable_lines on finance_v3.payable_lines;
create trigger tg_guard_payable_lines before insert or update or delete on finance_v3.payable_lines for each row execute function finance_v3.tg_guard_payable_lines();

create or replace function finance_v3.tg_guard_reconciliation_lines()
returns trigger language plpgsql set search_path = pg_catalog, finance_v3 as $$
declare v_status text; v_id uuid := case when tg_op = 'DELETE' then old.reconciliation_id else new.reconciliation_id end;
        v_org uuid := case when tg_op = 'DELETE' then old.organization_id else new.organization_id end;
begin
  select r.status into v_status from finance_v3.reconciliations r where r.organization_id = v_org and r.id = v_id;
  if found and v_status = 'completed' then raise exception 'A completed reconciliation cannot be changed.' using errcode = 'V3002'; end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end; $$;
drop trigger if exists tg_guard_reconciliation_lines on finance_v3.reconciliation_lines;
create trigger tg_guard_reconciliation_lines before insert or update or delete on finance_v3.reconciliation_lines for each row execute function finance_v3.tg_guard_reconciliation_lines();

create or replace function finance_v3.tg_guard_reconciliations()
returns trigger language plpgsql set search_path = pg_catalog, finance_v3 as $$
begin
  if tg_op = 'DELETE' then raise exception 'Reconciliations are never deleted.' using errcode = 'V3002'; end if;
  if old.status = 'completed' then raise exception 'A completed reconciliation cannot be changed.' using errcode = 'V3002'; end if;
  return new;
end; $$;
drop trigger if exists tg_guard_reconciliations on finance_v3.reconciliations;
create trigger tg_guard_reconciliations before update or delete on finance_v3.reconciliations for each row execute function finance_v3.tg_guard_reconciliations();

-- RLS (SELECT only) and privileges
alter table finance_v3.bank_accounts         enable row level security;
alter table finance_v3.reconciliations       enable row level security;
alter table finance_v3.reconciliation_lines  enable row level security;
alter table finance_v3.payables              enable row level security;
alter table finance_v3.payable_lines         enable row level security;
alter table finance_v3.payable_payments      enable row level security;
alter table finance_v3.expense_categories    enable row level security;
alter table finance_v3.expense_records       enable row level security;
alter table finance_v3.expense_attachments   enable row level security;

do $$
declare t text;
begin
  foreach t in array array['bank_accounts', 'reconciliations', 'reconciliation_lines', 'payables', 'payable_lines', 'payable_payments',
                           'expense_categories', 'expense_records', 'expense_attachments'] loop
    execute format('drop policy if exists fin3_select_%s on finance_v3.%I', t, t);
    execute format('create policy fin3_select_%s on finance_v3.%I for select to authenticated using (finance_v3.has_permission(organization_id, %L))', t, t, 'finance.read');
    execute format('revoke all on finance_v3.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on finance_v3.%I to authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------------------------
-- A cash/bank/clearing account that can receive or pay money in a currency.
create or replace function finance_v3.assert_cash_account(p_org uuid, p_account uuid, p_ccy text)
returns finance_v3.accounts
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare a finance_v3.accounts;
begin
  select * into a from finance_v3.accounts x where x.organization_id = p_org and x.id = p_account;
  if not found or a.account_type <> 'asset' or not a.is_active or not a.is_postable
     or coalesce(a.system_key, '') in ('accounts_receivable', 'cash_and_bank')
     or (a.currency is not null and a.currency <> p_ccy) then
    raise exception 'Choose an active bank, cash or clearing account that accepts %.', p_ccy using errcode = 'V3009';
  end if;
  return a;
end;
$$;

create or replace function finance_v3.bank_json(b finance_v3.bank_accounts)
returns jsonb language sql stable set search_path = pg_catalog, finance_v3 as $$
  select jsonb_build_object('id', b.id, 'ledger_account_id', b.ledger_account_id, 'name', b.name, 'kind', b.kind, 'currency', b.currency,
    'account_last4', b.account_last4, 'is_active', b.is_active);
$$;

-- Native ledger balance of an account at a date (debits - credits), exact, in the account's own currency (never mixed).
create or replace function finance_v3.account_native_balance(p_org uuid, p_account uuid, p_ccy text, p_as_of date)
returns numeric
language sql stable security definer
set search_path = pg_catalog, finance_v3
as $$
  select coalesce(sum(case l.side when 'debit' then l.amount_native else -l.amount_native end), 0)
    from finance_v3.journal_lines l join finance_v3.journal_entries e on e.id = l.entry_id
   where l.organization_id = p_org and l.account_id = p_account and l.currency = p_ccy and e.status = 'posted' and e.accounting_date <= p_as_of;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Bank accounts. p_bank: { id?, name, kind, currency, ledger_account_code?, account_last4?, is_active? }
-- Without ledger_account_code a new ledger asset account (codes 1070-1099) is created under Cash and Bank.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fin3_upsert_bank_account(p_org uuid, p_bank jsonb)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid  uuid := finance_v3.assert_permission(p_org, 'finance.admin');
  s      finance_v3.org_settings;
  v_key  text;
  b      finance_v3.bank_accounts;
  a      finance_v3.accounts;
  v_ccy  text;
  v_code text;
  v_parent uuid;
  v_name text;
begin
  s := finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  if p_bank is null or jsonb_typeof(p_bank) <> 'object' then raise exception 'The bank account must be an object.' using errcode = 'V3011'; end if;
  select k into v_key from jsonb_object_keys(p_bank) k where k not in ('id', 'name', 'kind', 'currency', 'ledger_account_code', 'account_last4', 'is_active') limit 1;
  if v_key is not null then raise exception 'Unknown bank account field "%".', v_key using errcode = 'V3011'; end if;
  v_name := btrim(coalesce(p_bank ->> 'name', ''));
  begin
    if nullif(p_bank ->> 'id', '') is not null then
      if not finance_v3.valid_uuid(p_bank ->> 'id') then raise exception 'Invalid bank account id.' using errcode = 'V3011'; end if;
      select * into b from finance_v3.bank_accounts x where x.organization_id = p_org and x.id = (p_bank ->> 'id')::uuid for update;
      if not found then raise exception 'Bank account not found.' using errcode = 'V3010'; end if;
      update finance_v3.bank_accounts x set name = case when p_bank ? 'name' then v_name else x.name end,
             account_last4 = case when p_bank ? 'account_last4' then nullif(p_bank ->> 'account_last4', '') else x.account_last4 end,
             is_active = case when p_bank ? 'is_active' then (p_bank ->> 'is_active')::boolean else x.is_active end, updated_at = now()
       where x.id = b.id returning * into b;
      perform finance_v3.write_audit(p_org, v_uid, 'update_bank_account', 'bank_account', b.id::text, null, finance_v3.bank_json(b), null);
      return finance_v3.bank_json(b);
    end if;
    v_ccy := upper(coalesce(p_bank ->> 'currency', s.base_currency));
    if finance_v3.minor_unit(v_ccy) is null then raise exception 'Unsupported currency.' using errcode = 'V3011'; end if;
    if nullif(p_bank ->> 'ledger_account_code', '') is not null then
      select * into a from finance_v3.accounts x where x.organization_id = p_org and x.code = (p_bank ->> 'ledger_account_code');
      if not found or a.account_type <> 'asset' or not a.is_postable or coalesce(a.system_key, '') in ('accounts_receivable', 'cash_and_bank')
         or (a.currency is not null and a.currency <> v_ccy) then
        raise exception 'That ledger account cannot be used as a bank account in %.', v_ccy using errcode = 'V3009';
      end if;
    else
      select x.id into v_parent from finance_v3.accounts x where x.organization_id = p_org and x.system_key = 'cash_and_bank';
      select coalesce(max(x.code::integer), 1069) + 1 into v_code from finance_v3.accounts x where x.organization_id = p_org and x.code ~ '^10[7-9][0-9]$';
      if v_code::integer > 1099 then raise exception 'No free bank account codes remain (1070-1099).' using errcode = 'V3009'; end if;
      insert into finance_v3.accounts (organization_id, code, name, account_type, description, parent_id, currency, created_by)
      values (p_org, v_code, v_name, 'asset', 'Bank or cash account (' || v_ccy || ')', v_parent, v_ccy, v_uid) returning * into a;
    end if;
    insert into finance_v3.bank_accounts (organization_id, ledger_account_id, name, kind, currency, account_last4, created_by)
    values (p_org, a.id, v_name, p_bank ->> 'kind', v_ccy, nullif(p_bank ->> 'account_last4', ''), v_uid) returning * into b;
  exception when check_violation or invalid_text_representation or not_null_violation then
    raise exception 'One of the bank account values is not valid.' using errcode = 'V3011';
  end;
  perform finance_v3.write_audit(p_org, v_uid, 'create_bank_account', 'bank_account', b.id::text, null, finance_v3.bank_json(b), null);
  return finance_v3.bank_json(b);
end;
$$;

create or replace function public.fin3_list_bank_accounts(p_org uuid, p_as_of date default current_date)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  return coalesce((select jsonb_agg(finance_v3.bank_json(b) || jsonb_build_object('ledger_balance',
      finance_v3.money_text(finance_v3.account_native_balance(p_org, b.ledger_account_id, b.currency, coalesce(p_as_of, current_date)), b.currency))
      order by b.name, b.id) from finance_v3.bank_accounts b where b.organization_id = p_org), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Transfers. Same currency: Dr to / Cr from. Cross-currency (one side must be the base currency): each currency balances
-- through the FX clearing account, and the realized difference against the stored transaction-date rate goes to FX gain/loss.
-- A missing rate refuses the transfer (V3003): it is never converted 1:1 and never at today's rate.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.ensure_fx_clearing(p_org uuid, p_actor uuid)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare v_id uuid; v_parent uuid;
begin
  select a.id into v_id from finance_v3.accounts a where a.organization_id = p_org and a.system_key = 'fx_clearing';
  if v_id is not null then return v_id; end if;
  select a.id into v_parent from finance_v3.accounts a where a.organization_id = p_org and a.system_key = 'cash_and_bank';
  insert into finance_v3.accounts (organization_id, code, name, account_type, description, is_system, system_key, parent_id, created_by)
  values (p_org, '1060', 'Currency Exchange Clearing', 'asset',
          'Offsets each currency leg of a cross-currency transfer. Native balances offset in the base currency.', true, 'fx_clearing', v_parent, p_actor)
  on conflict (organization_id, code) do nothing;
  select a.id into v_id from finance_v3.accounts a where a.organization_id = p_org and a.system_key = 'fx_clearing';
  if v_id is null then raise exception 'Account 1060 is in use; the currency exchange clearing account cannot be created.' using errcode = 'V3009'; end if;
  return v_id;
end;
$$;

create or replace function public.fin3_post_transfer(
  p_org uuid, p_key text, p_from_account uuid, p_to_account uuid, p_from_ccy text, p_to_ccy text,
  p_amount_from text, p_amount_to text, p_date date, p_reference text default null, p_memo text default null)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid   uuid := finance_v3.assert_permission(p_org, 'finance.pay');
  s       finance_v3.org_settings;
  v_from  finance_v3.accounts;
  v_to    finance_v3.accounts;
  v_fc    text := upper(coalesce(p_from_ccy, ''));
  v_tc    text := upper(coalesce(p_to_ccy, ''));
  v_af    numeric;
  v_at    numeric;
  v_for_amt numeric;
  v_base_amt numeric;
  v_foreign text;
  v_rate  numeric;
  v_book  numeric;
  v_diff  numeric;
  v_clear uuid;
  v_lines jsonb;
  v_entry uuid;
  v_no    text;
  v_base_from boolean;
begin
  s := finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  if p_key is null or char_length(p_key) not between 1 and 200 or p_key !~ '^[A-Za-z0-9_.:-]+$' then
    raise exception 'A valid idempotency key is required.' using errcode = 'V3011';
  end if;
  if p_from_account = p_to_account then raise exception 'Choose two different accounts.' using errcode = 'V3011'; end if;
  v_from := finance_v3.assert_cash_account(p_org, p_from_account, v_fc);
  v_to := finance_v3.assert_cash_account(p_org, p_to_account, v_tc);
  v_af := finance_v3.parse_money(p_amount_from, 'Amount sent', v_fc, false);
  if v_fc = v_tc then
    v_at := coalesce(finance_v3.parse_money(p_amount_to, 'Amount received', v_tc, false), v_af);
    if v_at <> v_af then raise exception 'Within one currency the amount sent and received must match.' using errcode = 'V3011'; end if;
    v_lines := jsonb_build_array(
      jsonb_build_object('account_id', v_to.id, 'side', 'debit', 'amount', finance_v3.money_text(v_af, v_fc), 'currency', v_fc),
      jsonb_build_object('account_id', v_from.id, 'side', 'credit', 'amount', finance_v3.money_text(v_af, v_fc), 'currency', v_fc));
  else
    if v_fc <> s.base_currency and v_tc <> s.base_currency then
      raise exception 'Phase 3 supports cross-currency transfers only when one side is the base currency (%).', s.base_currency using errcode = 'V3011';
    end if;
    v_at := finance_v3.parse_money(p_amount_to, 'Amount received', v_tc, false);
    v_base_from := (v_fc = s.base_currency);
    v_foreign := case when v_base_from then v_tc else v_fc end;
    v_for_amt := case when v_base_from then v_at else v_af end;
    v_base_amt := case when v_base_from then v_af else v_at end;
    select r.rate into v_rate from finance_v3.resolve_fx(p_org, v_foreign, s.base_currency, p_date, s.fx_lookback_days) r;
    if v_rate is null then
      raise exception 'No % to % rate is stored for %. Enter the rate before transferring.', v_foreign, s.base_currency, p_date using errcode = 'V3003';
    end if;
    v_book := round(v_for_amt * v_rate, finance_v3.minor_unit(s.base_currency)::integer);
    v_diff := case when v_base_from then v_book - v_base_amt else v_base_amt - v_book end;        -- gain when positive
    v_clear := finance_v3.ensure_fx_clearing(p_org, v_uid);
    if v_base_from then
      v_lines := jsonb_build_array(
        jsonb_build_object('account_id', v_to.id, 'side', 'debit', 'amount', finance_v3.money_text(v_for_amt, v_foreign), 'currency', v_foreign),
        jsonb_build_object('account_id', v_clear, 'side', 'credit', 'amount', finance_v3.money_text(v_for_amt, v_foreign), 'currency', v_foreign),
        jsonb_build_object('account_id', v_clear, 'side', 'debit', 'amount', finance_v3.money_text(v_book, s.base_currency), 'currency', s.base_currency),
        jsonb_build_object('account_id', v_from.id, 'side', 'credit', 'amount', finance_v3.money_text(v_base_amt, s.base_currency), 'currency', s.base_currency));
    else
      v_lines := jsonb_build_array(
        jsonb_build_object('account_id', v_clear, 'side', 'debit', 'amount', finance_v3.money_text(v_for_amt, v_foreign), 'currency', v_foreign),
        jsonb_build_object('account_id', v_from.id, 'side', 'credit', 'amount', finance_v3.money_text(v_for_amt, v_foreign), 'currency', v_foreign),
        jsonb_build_object('account_id', v_to.id, 'side', 'debit', 'amount', finance_v3.money_text(v_base_amt, s.base_currency), 'currency', s.base_currency),
        jsonb_build_object('account_id', v_clear, 'side', 'credit', 'amount', finance_v3.money_text(v_book, s.base_currency), 'currency', s.base_currency));
    end if;
    if v_diff > 0 then
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', finance_v3.system_account(p_org, 'fx_gain'), 'side', 'credit',
                   'amount', finance_v3.money_text(v_diff, s.base_currency), 'currency', s.base_currency));
    elsif v_diff < 0 then
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', finance_v3.system_account(p_org, 'fx_loss'), 'side', 'debit',
                   'amount', finance_v3.money_text(-v_diff, s.base_currency), 'currency', s.base_currency));
    end if;
  end if;
  v_no := finance_v3.next_doc_number(p_org, 'transfer');
  v_entry := finance_v3.post_event(p_org, 'bank_transfer', 'fin3:transfer:' || finance_v3.key_hash(p_key), p_date, v_lines,
    jsonb_strip_nulls(jsonb_build_object('memo', left(coalesce(nullif(btrim(p_memo), ''), 'Transfer ' || v_no), 500),
                                         'reference', coalesce(nullif(btrim(p_reference), ''), v_no))));
  perform finance_v3.write_audit(p_org, v_uid, 'post_transfer', 'journal_entry', v_entry::text, null,
    jsonb_build_object('transfer_no', v_no, 'from', v_from.code, 'to', v_to.code, 'amount_from', finance_v3.money_text(v_af, v_fc), 'currency_from', v_fc), null);
  return jsonb_build_object('entry_id', v_entry, 'transfer_no', v_no);
end;
$$;

create or replace function public.fin3_bank_balances(p_org uuid, p_as_of date default current_date)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  return public.fin3_list_bank_accounts(p_org, p_as_of);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Reconciliation: compares a statement balance with the ledger and marks ledger lines as cleared. It NEVER posts or edits
-- anything in the ledger. Signed amounts: debit = +, credit = -, native currency of the bank account.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fin3_start_reconciliation(p_org uuid, p_bank uuid, p_statement_date date, p_statement_balance text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.pay');
  b finance_v3.bank_accounts;
  x finance_v3.reconciliations;
  v_bal numeric;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  select * into b from finance_v3.bank_accounts y where y.organization_id = p_org and y.id = p_bank;
  if not found then raise exception 'Bank account not found.' using errcode = 'V3010'; end if;
  if p_statement_date is null or p_statement_date > current_date then raise exception 'The statement date is not valid.' using errcode = 'V3011'; end if;
  if p_statement_balance is null or p_statement_balance !~ '^-?(0|[1-9][0-9]{0,14})(\.[0-9]{1,4})?$' then
    raise exception 'The statement balance must be a decimal string.' using errcode = 'V3011';
  end if;
  v_bal := p_statement_balance::numeric;
  if length(split_part(p_statement_balance, '.', 2)) > finance_v3.minor_unit(b.currency) then
    raise exception 'The statement balance has too many decimals for %.', b.currency using errcode = 'V3011';
  end if;
  select * into x from finance_v3.reconciliations y where y.organization_id = p_org and y.bank_account_id = b.id and y.status = 'open';
  if found then raise exception 'Finish or discard the open reconciliation for this account first.' using errcode = 'V3017'; end if;
  insert into finance_v3.reconciliations (organization_id, bank_account_id, statement_date, statement_balance, currency, created_by)
  values (p_org, b.id, p_statement_date, v_bal, b.currency, v_uid) returning * into x;
  perform finance_v3.write_audit(p_org, v_uid, 'start_reconciliation', 'reconciliation', x.id::text, null,
    jsonb_build_object('bank_account_id', b.id, 'statement_date', p_statement_date, 'statement_balance', finance_v3.money_text(v_bal, b.currency)), null);
  return jsonb_build_object('id', x.id, 'status', x.status, 'statement_date', x.statement_date, 'statement_balance', finance_v3.money_text(x.statement_balance, x.currency));
end;
$$;

-- Ledger lines of the bank account up to the statement date that no reconciliation has cleared yet ("unmatched").
create or replace function public.fin3_reconciliation_candidates(p_org uuid, p_recon uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare x finance_v3.reconciliations; b finance_v3.bank_accounts;
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  select * into x from finance_v3.reconciliations y where y.organization_id = p_org and y.id = p_recon;
  if not found then raise exception 'Reconciliation not found.' using errcode = 'V3010'; end if;
  select * into b from finance_v3.bank_accounts y where y.organization_id = p_org and y.id = x.bank_account_id;
  return coalesce((select jsonb_agg(jsonb_build_object('line_id', l.id, 'entry_no', e.entry_no, 'accounting_date', e.accounting_date,
      'reference', e.reference, 'memo', e.memo, 'side', l.side, 'amount', finance_v3.money_text(l.amount_native, l.currency),
      'selected', exists (select 1 from finance_v3.reconciliation_lines rl where rl.organization_id = p_org and rl.reconciliation_id = x.id and rl.line_id = l.id))
      order by e.accounting_date, e.entry_no, l.line_no)
    from finance_v3.journal_lines l join finance_v3.journal_entries e on e.id = l.entry_id
   where l.organization_id = p_org and l.account_id = b.ledger_account_id and l.currency = b.currency and e.status = 'posted'
     and e.accounting_date <= x.statement_date
     and not exists (select 1 from finance_v3.reconciliation_lines rl join finance_v3.reconciliations rr on rr.organization_id = rl.organization_id and rr.id = rl.reconciliation_id
                      where rl.organization_id = p_org and rl.line_id = l.id and rr.status = 'completed')), '[]'::jsonb);
end;
$$;

create or replace function public.fin3_set_reconciliation_matches(p_org uuid, p_recon uuid, p_line_ids uuid[])
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.pay');
  x finance_v3.reconciliations;
  b finance_v3.bank_accounts;
  v_n integer;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  select * into x from finance_v3.reconciliations y where y.organization_id = p_org and y.id = p_recon for update;
  if not found then raise exception 'Reconciliation not found.' using errcode = 'V3010'; end if;
  if x.status <> 'open' then raise exception 'This reconciliation is completed.' using errcode = 'V3017'; end if;
  select * into b from finance_v3.bank_accounts y where y.organization_id = p_org and y.id = x.bank_account_id;
  if coalesce(array_length(p_line_ids, 1), 0) > 5000 then raise exception 'Too many lines.' using errcode = 'V3011'; end if;
  if exists (select 1 from unnest(coalesce(p_line_ids, '{}'::uuid[])) i
              where not exists (select 1 from finance_v3.journal_lines l join finance_v3.journal_entries e on e.id = l.entry_id
                                 where l.id = i and l.organization_id = p_org and l.account_id = b.ledger_account_id and l.currency = b.currency
                                   and e.status = 'posted' and e.accounting_date <= x.statement_date)) then
    raise exception 'A selected line does not belong to this bank account or is after the statement date.' using errcode = 'V3011';
  end if;
  if exists (select 1 from unnest(coalesce(p_line_ids, '{}'::uuid[])) i
              where exists (select 1 from finance_v3.reconciliation_lines rl join finance_v3.reconciliations rr on rr.organization_id = rl.organization_id and rr.id = rl.reconciliation_id
                             where rl.organization_id = p_org and rl.line_id = i and rr.status = 'completed')) then
    raise exception 'A selected line was already cleared by an earlier reconciliation.' using errcode = 'V3017';
  end if;
  delete from finance_v3.reconciliation_lines rl where rl.organization_id = p_org and rl.reconciliation_id = x.id;
  insert into finance_v3.reconciliation_lines (organization_id, reconciliation_id, line_id)
  select p_org, x.id, i from (select distinct unnest(coalesce(p_line_ids, '{}'::uuid[])) as i) q;
  get diagnostics v_n = row_count;
  perform finance_v3.write_audit(p_org, v_uid, 'set_reconciliation_matches', 'reconciliation', x.id::text, null, jsonb_build_object('cleared_lines', v_n), null);
  return public.fin3_reconciliation_summary(p_org, x.id);
end;
$$;

create or replace function public.fin3_reconciliation_summary(p_org uuid, p_recon uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  x finance_v3.reconciliations;
  b finance_v3.bank_accounts;
  v_prior numeric;
  v_sel numeric;
  v_cleared numeric;
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  select * into x from finance_v3.reconciliations y where y.organization_id = p_org and y.id = p_recon;
  if not found then raise exception 'Reconciliation not found.' using errcode = 'V3010'; end if;
  select * into b from finance_v3.bank_accounts y where y.organization_id = p_org and y.id = x.bank_account_id;
  select coalesce(sum(case l.side when 'debit' then l.amount_native else -l.amount_native end), 0) into v_prior
    from finance_v3.reconciliation_lines rl join finance_v3.reconciliations rr on rr.organization_id = rl.organization_id and rr.id = rl.reconciliation_id
    join finance_v3.journal_lines l on l.id = rl.line_id
   where rl.organization_id = p_org and rr.bank_account_id = b.id and rr.status = 'completed' and rr.id <> x.id;
  select coalesce(sum(case l.side when 'debit' then l.amount_native else -l.amount_native end), 0) into v_sel
    from finance_v3.reconciliation_lines rl join finance_v3.journal_lines l on l.id = rl.line_id
   where rl.organization_id = p_org and rl.reconciliation_id = x.id;
  v_cleared := case when x.status = 'completed' then x.cleared_balance else v_prior + v_sel end;
  return jsonb_build_object('id', x.id, 'bank_account_id', b.id, 'status', x.status, 'statement_date', x.statement_date,
    'currency', x.currency, 'statement_balance', finance_v3.money_text(x.statement_balance, x.currency),
    'cleared_balance', finance_v3.money_text(v_cleared, x.currency),
    'difference', finance_v3.money_text(x.statement_balance - v_cleared, x.currency),
    'ledger_balance', finance_v3.money_text(finance_v3.account_native_balance(p_org, b.ledger_account_id, b.currency, x.statement_date), x.currency),
    'difference_reason', x.difference_reason);
end;
$$;

create or replace function public.fin3_complete_reconciliation(p_org uuid, p_recon uuid, p_difference_reason text default null)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.pay');
  x finance_v3.reconciliations;
  v_sum jsonb;
  v_diff numeric;
  v_reason text := nullif(btrim(p_difference_reason), '');
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  select * into x from finance_v3.reconciliations y where y.organization_id = p_org and y.id = p_recon for update;
  if not found then raise exception 'Reconciliation not found.' using errcode = 'V3010'; end if;
  if x.status = 'completed' then return public.fin3_reconciliation_summary(p_org, x.id); end if;
  v_sum := public.fin3_reconciliation_summary(p_org, x.id);
  v_diff := (v_sum ->> 'difference')::numeric;
  if v_diff <> 0 and (v_reason is null or char_length(v_reason) > 500) then
    raise exception 'The cleared balance differs from the statement by %. Explain the difference to complete, or keep matching.', v_sum ->> 'difference' using errcode = 'V3011';
  end if;
  update finance_v3.reconciliations y set status = 'completed', cleared_balance = (v_sum ->> 'cleared_balance')::numeric, difference = v_diff,
         difference_reason = v_reason, completed_by = v_uid, completed_at = now() where y.id = x.id;
  perform finance_v3.write_audit(p_org, v_uid, 'complete_reconciliation', 'reconciliation', x.id::text, null,
    jsonb_build_object('difference', v_sum ->> 'difference'), v_reason);
  return public.fin3_reconciliation_summary(p_org, x.id);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Payables
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.bill_json(b finance_v3.payables, p_with_lines boolean default true)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare v_sup jsonb; v_lines jsonb := '[]'::jsonb;
        v_overdue boolean := b.status in ('approved', 'partially_paid') and b.due_date is not null and b.due_date < current_date;
begin
  select jsonb_build_object('id', c.id, 'name', c.name) into v_sup from finance_v3.contacts_v3 c where c.organization_id = b.organization_id and c.id = b.supplier_id;
  if p_with_lines then
    select coalesce(jsonb_agg(jsonb_build_object('line_no', l.line_no, 'description', l.description, 'amount', finance_v3.money_text(l.amount, b.currency),
           'account_id', l.account_id, 'project_id', l.project_id) order by l.line_no), '[]'::jsonb) into v_lines
      from finance_v3.payable_lines l where l.organization_id = b.organization_id and l.payable_id = b.id;
  end if;
  return jsonb_build_object('id', b.id, 'bill_no', b.bill_no, 'supplier', v_sup, 'bill_type', b.bill_type, 'supplier_ref', b.supplier_ref, 'status', b.status,
    'currency', b.currency, 'bill_date', b.bill_date, 'due_date', b.due_date, 'project_id', b.project_id,
    'total', finance_v3.money_text(b.total, b.currency), 'amount_paid', finance_v3.money_text(b.amount_paid, b.currency),
    'outstanding', finance_v3.money_text(b.outstanding, b.currency), 'is_overdue', v_overdue, 'notes', b.notes,
    'approved_entry_id', b.approved_entry_id, 'void_entry_id', b.void_entry_id, 'lines', v_lines);
end;
$$;

-- p_lines element: { description, amount:"120.00", account_code?, project_id? }. Default account: Animator Costs for freelancer
-- bills, Miscellaneous Expenses (6900) otherwise. Accounts must be cost-of-sales, operating or other expense accounts.
create or replace function public.fin3_save_bill_draft(
  p_org uuid, p_key text, p_bill uuid, p_supplier uuid, p_bill_type text, p_currency text, p_supplier_ref text,
  p_bill_date date, p_due_date date, p_project uuid, p_notes text, p_lines jsonb)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.post');
  b finance_v3.payables;
  c finance_v3.contacts_v3;
  e jsonb; ord bigint; v_k text; v_acct uuid; v_amt numeric; v_total numeric := 0; v_ccy text := upper(coalesce(p_currency, '')); v_proj uuid;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  if finance_v3.minor_unit(v_ccy) is null then raise exception 'Choose a supported currency.' using errcode = 'V3011'; end if;
  if p_bill_type not in ('supplier', 'contractor', 'freelancer') then raise exception 'Unknown bill type.' using errcode = 'V3011'; end if;
  select * into c from finance_v3.contacts_v3 x where x.organization_id = p_org and x.id = p_supplier;
  if not found or c.kind not in ('supplier', 'freelancer') or not c.is_active then raise exception 'Choose an active supplier or freelancer.' using errcode = 'V3010'; end if;
  if p_bill_type = 'freelancer' and c.kind <> 'freelancer' then raise exception 'A freelancer bill needs a freelancer contact.' using errcode = 'V3011'; end if;
  if p_project is not null and not finance_v3.project_in_org(p_org, p_project) then raise exception 'The project is not part of this studio.' using errcode = 'V3011'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) not between 1 and 200 then
    raise exception 'A bill needs 1 to 200 lines.' using errcode = 'V3011';
  end if;
  if p_bill is null then
    if p_key is null or char_length(p_key) not between 1 and 200 or p_key !~ '^[A-Za-z0-9_.:-]+$' then raise exception 'A valid idempotency key is required.' using errcode = 'V3011'; end if;
    select * into b from finance_v3.payables x where x.organization_id = p_org and x.idempotency_key = p_key;
    if found then return finance_v3.bill_json(b, true); end if;
    begin
      insert into finance_v3.payables (organization_id, supplier_id, bill_type, currency, idempotency_key, created_by)
      values (p_org, p_supplier, p_bill_type, v_ccy, p_key, v_uid) returning * into b;
    exception when check_violation then raise exception 'One of the bill values is not valid.' using errcode = 'V3011'; end;
  else
    select * into b from finance_v3.payables x where x.organization_id = p_org and x.id = p_bill for update;
    if not found then raise exception 'Bill not found.' using errcode = 'V3010'; end if;
    if b.status <> 'draft' then raise exception 'Only a draft bill can be edited.' using errcode = 'V3017'; end if;
  end if;
  delete from finance_v3.payable_lines l where l.organization_id = p_org and l.payable_id = b.id;
  for e, ord in select value, ordinality from jsonb_array_elements(p_lines) with ordinality loop
    if jsonb_typeof(e) <> 'object' then raise exception 'Line % is not an object.', ord using errcode = 'V3011'; end if;
    select k into v_k from jsonb_object_keys(e) k where k not in ('description', 'amount', 'account_code', 'project_id') limit 1;
    if v_k is not null then raise exception 'Line % has an unknown field "%".', ord, v_k using errcode = 'V3011'; end if;
    v_amt := finance_v3.parse_money(e ->> 'amount', format('Line %s amount', ord), v_ccy, false);
    if nullif(e ->> 'account_code', '') is null then
      if p_bill_type = 'freelancer' then v_acct := finance_v3.system_account(p_org, 'cos_animator');
      else select a.id into v_acct from finance_v3.accounts a where a.organization_id = p_org and a.code = '6900' and a.is_active; end if;
    else
      select a.id into v_acct from finance_v3.accounts a where a.organization_id = p_org and a.code = (e ->> 'account_code') and a.is_active and a.is_postable
         and a.account_type in ('cost_of_sales', 'operating_expense', 'other_expense');
    end if;
    if v_acct is null then raise exception 'Line % needs an active expense account.', ord using errcode = 'V3009'; end if;
    v_proj := null;
    if nullif(e ->> 'project_id', '') is not null then
      if not finance_v3.valid_uuid(e ->> 'project_id') or not finance_v3.project_in_org(p_org, (e ->> 'project_id')::uuid) then
        raise exception 'Line % refers to a project that is not part of this studio.', ord using errcode = 'V3011';
      end if;
      v_proj := (e ->> 'project_id')::uuid;
    end if;
    insert into finance_v3.payable_lines (organization_id, payable_id, line_no, description, amount, account_id, project_id)
    values (p_org, b.id, ord, btrim(coalesce(e ->> 'description', '')), v_amt, v_acct, v_proj);
    v_total := v_total + v_amt;
  end loop;
  begin
    update finance_v3.payables x set supplier_id = p_supplier, bill_type = p_bill_type, currency = v_ccy, supplier_ref = nullif(btrim(p_supplier_ref), ''),
           bill_date = p_bill_date, due_date = p_due_date, project_id = p_project, notes = nullif(btrim(p_notes), ''), total = v_total, updated_at = now()
     where x.organization_id = p_org and x.id = b.id returning * into b;
  exception when check_violation or unique_violation then
    raise exception 'One of the bill values is not valid, or this supplier reference was already entered.' using errcode = 'V3011';
  end;
  perform finance_v3.write_audit(p_org, v_uid, 'save_bill_draft', 'payable', b.id::text, null, finance_v3.bill_json(b, false), null);
  return finance_v3.bill_json(b, true);
end;
$$;

-- Approval posts Dr expense lines / Cr Accounts Payable (kind bill_approved). Dates default to today / +30 days when blank.
create or replace function public.fin3_approve_bill(p_org uuid, p_bill uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.approve');
  b finance_v3.payables;
  rec record;
  v_lines jsonb;
  v_entry uuid;
  v_no text;
  v_date date;
  v_due date;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  select * into b from finance_v3.payables x where x.organization_id = p_org and x.id = p_bill for update;
  if not found then raise exception 'Bill not found.' using errcode = 'V3010'; end if;
  if b.status <> 'draft' then
    if b.status = 'void' then raise exception 'A void bill cannot be approved.' using errcode = 'V3017'; end if;
    return finance_v3.bill_json(b, true);                                                             -- idempotent
  end if;
  if b.total <= 0 then raise exception 'A bill needs lines with a total above zero.' using errcode = 'V3017'; end if;
  v_date := coalesce(b.bill_date, current_date);
  v_due := coalesce(b.due_date, v_date + 30);
  v_lines := jsonb_build_array(jsonb_build_object('account_id', finance_v3.system_account(p_org, 'accounts_payable'), 'side', 'credit',
                                                  'amount', finance_v3.money_text(b.total, b.currency), 'currency', b.currency));
  for rec in select l.account_id, l.project_id, sum(l.amount) as amt from finance_v3.payable_lines l
              where l.organization_id = p_org and l.payable_id = b.id group by l.account_id, l.project_id order by l.account_id, l.project_id nulls first loop
    v_lines := v_lines || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('account_id', rec.account_id, 'side', 'debit',
                 'amount', finance_v3.money_text(rec.amt, b.currency), 'currency', b.currency, 'project_id', rec.project_id)));
  end loop;
  v_no := finance_v3.next_doc_number(p_org, 'bill');
  v_entry := finance_v3.post_event(p_org, 'bill_approved', 'fin3:bill:' || b.id::text || ':approve', v_date, v_lines,
    jsonb_strip_nulls(jsonb_build_object('memo', left('Bill ' || v_no || coalesce(' (' || b.supplier_ref || ')', ''), 500), 'reference', v_no, 'project_id', b.project_id)));
  update finance_v3.payables x set status = 'approved', bill_no = v_no, bill_date = v_date, due_date = v_due, approved_entry_id = v_entry,
         approved_by = v_uid, approved_at = now(), updated_at = now() where x.organization_id = p_org and x.id = b.id returning * into b;
  perform finance_v3.write_audit(p_org, v_uid, 'approve_bill', 'payable', b.id::text, null, jsonb_build_object('bill_no', v_no, 'entry_id', v_entry), null);
  return finance_v3.bill_json(b, true);
end;
$$;

-- Pay (part of) an approved bill: Dr Accounts Payable / Cr payment account (kind bill_payment). Idempotent by key.
create or replace function public.fin3_pay_bill(p_org uuid, p_key text, p_bill uuid, p_amount text, p_paid_on date, p_pay_account uuid, p_reference text default null)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.pay');
  b finance_v3.payables;
  pp finance_v3.payable_payments;
  v_amt numeric;
  v_entry uuid;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  if p_key is null or char_length(p_key) not between 1 and 200 or p_key !~ '^[A-Za-z0-9_.:-]+$' then raise exception 'A valid idempotency key is required.' using errcode = 'V3011'; end if;
  select * into pp from finance_v3.payable_payments x where x.organization_id = p_org and x.idempotency_key = p_key;
  if found then
    select * into b from finance_v3.payables x where x.organization_id = p_org and x.id = pp.payable_id;
    return finance_v3.bill_json(b, false);                                                          -- duplicate submission: original result
  end if;
  select * into b from finance_v3.payables x where x.organization_id = p_org and x.id = p_bill for update;
  if not found then raise exception 'Bill not found.' using errcode = 'V3010'; end if;
  if b.status not in ('approved', 'partially_paid') then raise exception 'Only an approved bill with a balance can be paid.' using errcode = 'V3017'; end if;
  if p_paid_on is null or p_paid_on > current_date + 1 then raise exception 'The payment date is not valid.' using errcode = 'V3011'; end if;
  v_amt := finance_v3.parse_money(p_amount, 'Payment amount', b.currency, false);
  if v_amt > b.outstanding then raise exception 'The payment (%) is more than the outstanding balance (%).', finance_v3.money_text(v_amt, b.currency),
    finance_v3.money_text(b.outstanding, b.currency) using errcode = 'V3012'; end if;
  perform finance_v3.assert_cash_account(p_org, p_pay_account, b.currency);
  v_entry := finance_v3.post_event(p_org, 'bill_payment', 'fin3:bill:' || b.id::text || ':pay:' || finance_v3.key_hash(p_key), p_paid_on,
    jsonb_build_array(
      jsonb_build_object('account_id', finance_v3.system_account(p_org, 'accounts_payable'), 'side', 'debit', 'amount', finance_v3.money_text(v_amt, b.currency), 'currency', b.currency),
      jsonb_build_object('account_id', p_pay_account, 'side', 'credit', 'amount', finance_v3.money_text(v_amt, b.currency), 'currency', b.currency)),
    jsonb_strip_nulls(jsonb_build_object('memo', left('Payment of bill ' || b.bill_no, 500), 'reference', coalesce(nullif(btrim(p_reference), ''), b.bill_no), 'project_id', b.project_id)));
  insert into finance_v3.payable_payments (organization_id, payable_id, amount, currency, paid_on, pay_account_id, reference, entry_id, idempotency_key, created_by)
  values (p_org, b.id, v_amt, b.currency, p_paid_on, p_pay_account, nullif(btrim(p_reference), ''), v_entry, p_key, v_uid);
  update finance_v3.payables x set amount_paid = x.amount_paid + v_amt, status = case when x.amount_paid + v_amt >= x.total then 'paid' else 'partially_paid' end,
         updated_at = now() where x.organization_id = p_org and x.id = b.id returning * into b;
  perform finance_v3.write_audit(p_org, v_uid, 'pay_bill', 'payable', b.id::text, null, jsonb_build_object('amount', finance_v3.money_text(v_amt, b.currency), 'entry_id', v_entry), null);
  return finance_v3.bill_json(b, false);
end;
$$;

-- Void an approved bill that has no recorded payments (reverses its entry). A paid bill needs its payments reversed first.
create or replace function public.fin3_void_bill(p_org uuid, p_bill uuid, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.approve');
  b finance_v3.payables;
  v_reason text := nullif(btrim(p_reason), '');
  v_rev uuid;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  if v_reason is null or char_length(v_reason) > 500 then raise exception 'A reason is required to void a bill.' using errcode = 'V3011'; end if;
  select * into b from finance_v3.payables x where x.organization_id = p_org and x.id = p_bill for update;
  if not found then raise exception 'Bill not found.' using errcode = 'V3010'; end if;
  if b.status = 'void' then return finance_v3.bill_json(b, true); end if;
  if b.status = 'draft' then raise exception 'Discard a draft bill instead of voiding it.' using errcode = 'V3017'; end if;
  if b.amount_paid > 0 then raise exception 'This bill has payments. Reverse them first.' using errcode = 'V3017'; end if;
  v_rev := finance_v3.reverse_entry(p_org, b.approved_entry_id, 'fin3:bill:' || b.id::text || ':void', v_reason, null);
  update finance_v3.payables x set status = 'void', void_entry_id = v_rev, void_reason = v_reason, updated_at = now() where x.organization_id = p_org and x.id = b.id returning * into b;
  perform finance_v3.write_audit(p_org, v_uid, 'void_bill', 'payable', b.id::text, null, jsonb_build_object('reversal_entry_id', v_rev), v_reason);
  return finance_v3.bill_json(b, true);
end;
$$;

-- Reverse one bill payment (for example a returned transfer).
create or replace function public.fin3_reverse_bill_payment(p_org uuid, p_payment uuid, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.approve');
  pp finance_v3.payable_payments;
  b finance_v3.payables;
  v_reason text := nullif(btrim(p_reason), '');
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  if v_reason is null or char_length(v_reason) > 500 then raise exception 'A reason is required.' using errcode = 'V3011'; end if;
  select * into pp from finance_v3.payable_payments x where x.organization_id = p_org and x.id = p_payment for update;
  if not found then raise exception 'Payment not found.' using errcode = 'V3010'; end if;
  select * into b from finance_v3.payables x where x.organization_id = p_org and x.id = pp.payable_id for update;
  if pp.status = 'reversed' then return finance_v3.bill_json(b, false); end if;
  perform finance_v3.reverse_entry(p_org, pp.entry_id, 'fin3:billpay:' || pp.id::text || ':reverse', v_reason, null);
  update finance_v3.payable_payments x set status = 'reversed' where x.id = pp.id;
  update finance_v3.payables x set amount_paid = x.amount_paid - pp.amount,
         status = case when x.amount_paid - pp.amount <= 0 then 'approved' else 'partially_paid' end, updated_at = now()
   where x.organization_id = p_org and x.id = b.id returning * into b;
  perform finance_v3.write_audit(p_org, v_uid, 'reverse_bill_payment', 'payable', b.id::text, null, jsonb_build_object('payment_id', pp.id), v_reason);
  return finance_v3.bill_json(b, false);
end;
$$;

create or replace function public.fin3_get_bill(p_org uuid, p_bill uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare b finance_v3.payables;
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  select * into b from finance_v3.payables x where x.organization_id = p_org and x.id = p_bill;
  if not found then raise exception 'Bill not found.' using errcode = 'V3010'; end if;
  return finance_v3.bill_json(b, true) || jsonb_build_object('payments', coalesce((select jsonb_agg(jsonb_build_object('id', p.id,
    'amount', finance_v3.money_text(p.amount, p.currency), 'paid_on', p.paid_on, 'status', p.status, 'reference', p.reference) order by p.paid_on, p.id)
    from finance_v3.payable_payments p where p.organization_id = p_org and p.payable_id = b.id), '[]'::jsonb));
end;
$$;

create or replace function public.fin3_list_bills(p_org uuid, p_status text default null, p_limit integer default 100)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  return coalesce((select jsonb_agg(finance_v3.bill_json(b, false) order by b.created_at desc, b.id desc)
    from (select * from finance_v3.payables x where x.organization_id = p_org and (p_status is null or x.status = p_status)
           order by x.created_at desc, x.id desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) b), '[]'::jsonb);
end;
$$;

create or replace function public.fin3_payables_aging(p_org uuid, p_as_of date default current_date, p_currency text default null)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare v_out jsonb;
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  with open as (
    select b.supplier_id, b.currency, b.outstanding as amt, (p_as_of - b.due_date) as d
      from finance_v3.payables b where b.organization_id = p_org and b.status in ('approved', 'partially_paid') and b.outstanding > 0
       and b.bill_date <= p_as_of and (p_currency is null or b.currency = p_currency)
  ), tot as (
    select o.currency, sum(o.amt) filter (where o.d <= 0) as cur, sum(o.amt) filter (where o.d between 1 and 30) as b30,
           sum(o.amt) filter (where o.d between 31 and 60) as b60, sum(o.amt) filter (where o.d between 61 and 90) as b90,
           sum(o.amt) filter (where o.d > 90) as b90p, sum(o.amt) as total, count(*) as n from open o group by o.currency
  ), sup as (
    select o.currency, o.supplier_id, sum(o.amt) filter (where o.d <= 0) as cur, sum(o.amt) filter (where o.d between 1 and 30) as b30,
           sum(o.amt) filter (where o.d between 31 and 60) as b60, sum(o.amt) filter (where o.d between 61 and 90) as b90,
           sum(o.amt) filter (where o.d > 90) as b90p, sum(o.amt) as total, count(*) as n from open o group by o.currency, o.supplier_id
  )
  select jsonb_build_object('as_of', p_as_of,
    'totals', coalesce((select jsonb_agg(jsonb_build_object('currency', t.currency, 'current', finance_v3.money_text(coalesce(t.cur, 0), t.currency),
        'days_1_30', finance_v3.money_text(coalesce(t.b30, 0), t.currency), 'days_31_60', finance_v3.money_text(coalesce(t.b60, 0), t.currency),
        'days_61_90', finance_v3.money_text(coalesce(t.b90, 0), t.currency), 'days_over_90', finance_v3.money_text(coalesce(t.b90p, 0), t.currency),
        'total', finance_v3.money_text(t.total, t.currency), 'bill_count', t.n) order by t.currency) from tot t), '[]'::jsonb),
    'suppliers', coalesce((select jsonb_agg(jsonb_build_object('currency', x.currency, 'supplier_id', x.supplier_id, 'supplier_name', c.name,
        'current', finance_v3.money_text(coalesce(x.cur, 0), x.currency), 'days_1_30', finance_v3.money_text(coalesce(x.b30, 0), x.currency),
        'days_31_60', finance_v3.money_text(coalesce(x.b60, 0), x.currency), 'days_61_90', finance_v3.money_text(coalesce(x.b90, 0), x.currency),
        'days_over_90', finance_v3.money_text(coalesce(x.b90p, 0), x.currency), 'total', finance_v3.money_text(x.total, x.currency), 'bill_count', x.n)
        order by x.currency, lower(c.name), x.supplier_id) from sup x join finance_v3.contacts_v3 c on c.organization_id = p_org and c.id = x.supplier_id), '[]'::jsonb))
    into v_out;
  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Expenses
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fin3_init_expense_categories(p_org uuid)
returns integer
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare n integer;
begin
  perform finance_v3.assert_permission(p_org, 'finance.admin');
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  insert into finance_v3.expense_categories (organization_id, name, account_id)
  select p_org, v.name, a.id from (values ('Rent and utilities', '6100'), ('Software subscriptions', '6200'), ('Internet and phone', '6300'),
    ('Marketing', '6400'), ('Professional fees', '6500'), ('Bank and payment fees', '6600'), ('Travel and meals', '6700'),
    ('Equipment and supplies', '6800'), ('Other expenses', '6900')) as v(name, code)
  join finance_v3.accounts a on a.organization_id = p_org and a.code = v.code
  on conflict (organization_id, name) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function public.fin3_upsert_expense_category(p_org uuid, p_name text, p_account_code text, p_is_active boolean default true)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.admin');
  a finance_v3.accounts;
  c finance_v3.expense_categories;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  select * into a from finance_v3.accounts x where x.organization_id = p_org and x.code = p_account_code and x.is_active and x.is_postable
     and x.account_type in ('cost_of_sales', 'operating_expense', 'other_expense');
  if not found then raise exception 'Choose an active expense account.' using errcode = 'V3009'; end if;
  begin
    insert into finance_v3.expense_categories (organization_id, name, account_id, is_active)
    values (p_org, btrim(coalesce(p_name, '')), a.id, coalesce(p_is_active, true))
    on conflict (organization_id, name) do update set account_id = excluded.account_id, is_active = excluded.is_active
    returning * into c;
  exception when check_violation then raise exception 'The category name is not valid.' using errcode = 'V3011'; end;
  perform finance_v3.write_audit(p_org, v_uid, 'upsert_expense_category', 'expense_category', c.id::text, null, jsonb_build_object('name', c.name, 'account', a.code), null);
  return jsonb_build_object('id', c.id, 'name', c.name, 'account_id', c.account_id, 'is_active', c.is_active);
end;
$$;

create or replace function public.fin3_list_expense_categories(p_org uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'account_id', c.account_id, 'account_code', a.code, 'is_active', c.is_active)
    order by lower(c.name)) from finance_v3.expense_categories c join finance_v3.accounts a on a.organization_id = c.organization_id and a.id = c.account_id
    where c.organization_id = p_org), '[]'::jsonb);
end;
$$;

create or replace function finance_v3.expense_json(x finance_v3.expense_records)
returns jsonb language sql stable set search_path = pg_catalog, finance_v3 as $$
  select jsonb_build_object('id', x.id, 'expense_no', x.expense_no, 'vendor_id', x.vendor_id, 'vendor_name', x.vendor_name, 'category_id', x.category_id,
    'project_id', x.project_id, 'description', x.description, 'amount', finance_v3.money_text(x.amount, x.currency), 'currency', x.currency,
    'expense_date', x.expense_date, 'pay_account_id', x.pay_account_id, 'tax_class', x.tax_class, 'payment_status', x.payment_status,
    'reference', x.reference, 'entry_id', x.entry_id);
$$;

-- p_expense: { category_id, description, amount:"45.00", currency, expense_date, pay_account_id, vendor_id?, vendor_name?, project_id?, tax_class?, reference? }
-- An expense is paid when recorded: Dr category expense account / Cr the payment account (kind expense_paid).
create or replace function public.fin3_record_expense(p_org uuid, p_key text, p_expense jsonb)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.pay');
  v_k text; x finance_v3.expense_records; cat finance_v3.expense_categories; v_ccy text; v_amt numeric; v_acc uuid;
  v_date date; v_proj uuid; v_vendor uuid; v_entry uuid; v_no text;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  if p_key is null or char_length(p_key) not between 1 and 200 or p_key !~ '^[A-Za-z0-9_.:-]+$' then raise exception 'A valid idempotency key is required.' using errcode = 'V3011'; end if;
  select * into x from finance_v3.expense_records e where e.organization_id = p_org and e.idempotency_key = p_key;
  if found then return finance_v3.expense_json(x); end if;
  if p_expense is null or jsonb_typeof(p_expense) <> 'object' then raise exception 'The expense must be an object.' using errcode = 'V3011'; end if;
  select k into v_k from jsonb_object_keys(p_expense) k where k not in ('category_id', 'description', 'amount', 'currency', 'expense_date', 'pay_account_id',
    'vendor_id', 'vendor_name', 'project_id', 'tax_class', 'reference') limit 1;
  if v_k is not null then raise exception 'Unknown expense field "%".', v_k using errcode = 'V3011'; end if;
  if not finance_v3.valid_uuid(p_expense ->> 'category_id') or not finance_v3.valid_uuid(p_expense ->> 'pay_account_id') then
    raise exception 'Choose a category and a payment account.' using errcode = 'V3011';
  end if;
  select * into cat from finance_v3.expense_categories c where c.organization_id = p_org and c.id = (p_expense ->> 'category_id')::uuid and c.is_active;
  if not found then raise exception 'Choose an active expense category.' using errcode = 'V3010'; end if;
  v_ccy := upper(coalesce(p_expense ->> 'currency', ''));
  v_amt := finance_v3.parse_money(p_expense ->> 'amount', 'Expense amount', v_ccy, false);
  begin v_date := (p_expense ->> 'expense_date')::date; exception when others then raise exception 'The expense date is not valid.' using errcode = 'V3011'; end;
  if v_date is null or v_date > current_date + 1 then raise exception 'The expense date is not valid.' using errcode = 'V3011'; end if;
  v_acc := (p_expense ->> 'pay_account_id')::uuid;
  perform finance_v3.assert_cash_account(p_org, v_acc, v_ccy);
  if nullif(p_expense ->> 'project_id', '') is not null then
    if not finance_v3.valid_uuid(p_expense ->> 'project_id') or not finance_v3.project_in_org(p_org, (p_expense ->> 'project_id')::uuid) then
      raise exception 'The project is not part of this studio.' using errcode = 'V3011';
    end if;
    v_proj := (p_expense ->> 'project_id')::uuid;
  end if;
  if nullif(p_expense ->> 'vendor_id', '') is not null then
    if not finance_v3.valid_uuid(p_expense ->> 'vendor_id') then raise exception 'Invalid vendor.' using errcode = 'V3011'; end if;
    v_vendor := (p_expense ->> 'vendor_id')::uuid;
    if not exists (select 1 from finance_v3.contacts_v3 c where c.organization_id = p_org and c.id = v_vendor and c.kind in ('supplier', 'freelancer')) then
      raise exception 'Choose a supplier of this studio.' using errcode = 'V3010';
    end if;
  end if;
  v_no := finance_v3.next_doc_number(p_org, 'expense');
  v_entry := finance_v3.post_event(p_org, 'expense_paid', 'fin3:expense:' || finance_v3.key_hash(p_key), v_date,
    jsonb_build_array(
      jsonb_strip_nulls(jsonb_build_object('account_id', cat.account_id, 'side', 'debit', 'amount', finance_v3.money_text(v_amt, v_ccy), 'currency', v_ccy, 'project_id', v_proj)),
      jsonb_build_object('account_id', v_acc, 'side', 'credit', 'amount', finance_v3.money_text(v_amt, v_ccy), 'currency', v_ccy)),
    jsonb_strip_nulls(jsonb_build_object('memo', left(btrim(coalesce(p_expense ->> 'description', 'Expense')), 500), 'reference', v_no, 'project_id', v_proj)));
  begin
    insert into finance_v3.expense_records (organization_id, expense_no, vendor_id, vendor_name, category_id, project_id, description, amount, currency,
      expense_date, pay_account_id, tax_class, reference, entry_id, idempotency_key, created_by)
    values (p_org, v_no, v_vendor, nullif(btrim(p_expense ->> 'vendor_name'), ''), cat.id, v_proj, btrim(coalesce(p_expense ->> 'description', '')), v_amt, v_ccy,
      v_date, v_acc, coalesce(nullif(p_expense ->> 'tax_class', ''), 'none'), nullif(btrim(p_expense ->> 'reference'), ''), v_entry, p_key, v_uid)
    returning * into x;
  exception when check_violation then raise exception 'One of the expense values is not valid.' using errcode = 'V3011'; end;
  perform finance_v3.write_audit(p_org, v_uid, 'record_expense', 'expense', x.id::text, null, finance_v3.expense_json(x), null);
  return finance_v3.expense_json(x);
end;
$$;

create or replace function public.fin3_void_expense(p_org uuid, p_expense uuid, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.approve');
  x finance_v3.expense_records;
  v_reason text := nullif(btrim(p_reason), '');
  v_rev uuid;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  if v_reason is null or char_length(v_reason) > 500 then raise exception 'A reason is required.' using errcode = 'V3011'; end if;
  select * into x from finance_v3.expense_records e where e.organization_id = p_org and e.id = p_expense for update;
  if not found then raise exception 'Expense not found.' using errcode = 'V3010'; end if;
  if x.payment_status = 'reversed' then return finance_v3.expense_json(x); end if;
  v_rev := finance_v3.reverse_entry(p_org, x.entry_id, 'fin3:expense:' || x.id::text || ':void', v_reason, null);
  update finance_v3.expense_records e set payment_status = 'reversed', reversal_entry_id = v_rev where e.id = x.id returning * into x;
  perform finance_v3.write_audit(p_org, v_uid, 'void_expense', 'expense', x.id::text, null, jsonb_build_object('reversal_entry_id', v_rev), v_reason);
  return finance_v3.expense_json(x);
end;
$$;

create or replace function public.fin3_list_expenses(p_org uuid, p_from date default null, p_to date default null, p_limit integer default 200)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  return coalesce((select jsonb_agg(finance_v3.expense_json(x) || jsonb_build_object('attachment_count',
      (select count(*) from finance_v3.expense_attachments a where a.organization_id = p_org and a.expense_id = x.id)) order by x.expense_date desc, x.id desc)
    from (select * from finance_v3.expense_records e where e.organization_id = p_org and (p_from is null or e.expense_date >= p_from) and (p_to is null or e.expense_date <= p_to)
           order by e.expense_date desc, e.id desc limit least(greatest(coalesce(p_limit, 200), 1), 1000)) x), '[]'::jsonb);
end;
$$;

-- Registers metadata for a receipt file the client uploaded to the private bucket "finance-v3-attachments" under <organization_id>/.
create or replace function public.fin3_add_expense_attachment(
  p_org uuid, p_expense uuid, p_file_name text, p_content_type text, p_bytes integer, p_sha256 text, p_storage_path text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.pay');
  a finance_v3.expense_attachments;
begin
  perform finance_v3.assert_org_ready(p_org);
  if not exists (select 1 from finance_v3.expense_records e where e.organization_id = p_org and e.id = p_expense) then
    raise exception 'Expense not found.' using errcode = 'V3010';
  end if;
  if p_storage_path is null or left(p_storage_path, char_length(p_org::text) + 1) <> p_org::text || '/' or p_storage_path ~ '\.\.' then
    raise exception 'The file must be stored under this studio''s folder.' using errcode = 'V3011';
  end if;
  begin
    insert into finance_v3.expense_attachments (organization_id, expense_id, file_name, content_type, byte_size, sha256, storage_path, created_by)
    values (p_org, p_expense, p_file_name, p_content_type, p_bytes, lower(p_sha256), p_storage_path, v_uid) returning * into a;
  exception when check_violation then raise exception 'The attachment details are not valid.' using errcode = 'V3011'; end;
  perform finance_v3.write_audit(p_org, v_uid, 'add_expense_attachment', 'expense', p_expense::text, null, jsonb_build_object('file_name', p_file_name, 'sha256', a.sha256), null);
  return jsonb_build_object('id', a.id, 'file_name', a.file_name, 'byte_size', a.byte_size);
end;
$$;

-- Private storage bucket for receipt files (Supabase only; skipped silently on plain PostgreSQL). Access is by RPC metadata and
-- signed URLs created server-side; no client storage policy is created here.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage')
     and exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    execute 'insert into storage.buckets (id, name, public) values (''finance-v3-attachments'', ''finance-v3-attachments'', false) on conflict (id) do nothing';
  end if;
exception when others then
  raise warning 'finance-v3-attachments bucket was not created (%). Create a private bucket with that name manually.', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Privileges
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
