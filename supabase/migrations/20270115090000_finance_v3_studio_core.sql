-- Finance V3, Phase 4 (migration 1 of 2): studio financial intelligence and money protection, core.
--
-- What this adds (all in schema finance_v3, nothing outside it is altered; V2 and legacy tables are untouched):
--   * project finance (contract value, budgets), animator assignments, animator work items and payments (approved work
--     becomes a liability on 2100 Animator and Freelancer Payables), protected fund allocations, business reserves,
--     owner compensation, protection settings and protection events.
--   * ONE authoritative safe-to-spend service (finance_v3.safe_to_spend_parts) and ONE enforcement point
--     (finance_v3.enforce_protection). Both the new RPCs (migration 2) and the three Phase 3 spending RPCs that were
--     replaced at the end of this file call them, so a guided spend cannot skip the rules.
--   * enables the event kinds reserved for Phase 4 and adds owner_paid_expense.
--
-- Principles (roadmap Phase 4):
--   * Allocations, reserves and scheduled payments are LOGICAL: they never create ledger entries and never change a bank balance.
--   * Unpaid client invoices, pending manual payments and money still in Online Payments Clearing are NOT available cash.
--   * Money is computed per currency in exact native amounts. Nothing is converted 1:1 and nothing mixes currencies.
--   * Email and provider events cannot reach any function here: only authorized Finance RPCs post, and only through post_event.
-- Rollback: supabase/rollback/20270115090000_finance_v3_studio_core.rollback.sql (refuses while Phase 4 data exists).

begin;

insert into finance_v3.schema_version (version, notes)
values ('20270115090000', 'phase 4 migration 1: studio core tables, safe-to-spend, protection engine, protected spending RPCs')
on conflict (version) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- Event kinds. The Phase 2 kinds reserved for this phase are switched on. owner_paid_expense is new: a business cost the
-- owner paid personally (Dr expense / Cr 2500 Owner Payable).
-- ---------------------------------------------------------------------------------------------------------------
insert into finance_v3.event_kinds (kind, description, required_permission, allows_provider, is_enabled, phase_available) values
  ('owner_paid_expense', 'Business cost paid personally by the owner (owed back to the owner)', 'finance.owner_pay', false, true, 4)
on conflict (kind) do nothing;
update finance_v3.event_kinds set is_enabled = true
 where kind in ('owner_contribution', 'owner_draw', 'owner_salary', 'owner_reimbursement', 'animator_obligation', 'animator_payment');

-- ---------------------------------------------------------------------------------------------------------------
-- Protection settings (one row per studio, created lazily with safe defaults).
--   mode 'block' refuses an unsafe spend unless an authorized override with a reason is supplied; 'warn' lets it through and
--   records a protection event. There is deliberately no 'off'.
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists finance_v3.protection_settings (
  organization_id        uuid primary key references finance_v3.org_settings(organization_id) on delete restrict,
  mode                   text not null default 'block' check (mode in ('block', 'warn')),
  commitment_horizon_days smallint not null default 30 check (commitment_horizon_days between 0 and 365),
  updated_by             uuid,
  updated_at             timestamptz not null default now()
);

-- Every time a rule fired but the spend went ahead (warn mode or an authorized override). Blocked attempts raise an error and
-- therefore leave no row (the transaction is rolled back); the override is the audit trail for crossing a line.
create table if not exists finance_v3.protection_events (
  id              bigint generated always as identity primary key,
  organization_id uuid not null references finance_v3.org_settings(organization_id) on delete restrict,
  rule            text not null check (rule in ('insufficient_cash', 'exceeds_safe_to_spend', 'reserve_below_minimum')),
  outcome         text not null check (outcome in ('warned', 'overridden')),
  check_kind      text not null check (check_kind in ('commitment_payment', 'spend', 'reserve_contribution', 'reserve_withdrawal')),
  subject_type    text not null check (char_length(subject_type) between 1 and 40),
  subject_id      text check (subject_id is null or char_length(subject_id) <= 80),
  amount          numeric(19,4) not null check (amount > 0),
  currency        text not null references finance_v3.currencies(code),
  available       numeric(19,4) not null,
  shortfall       numeric(19,4) not null check (shortfall >= 0),
  reason          text check (reason is null or char_length(reason) between 10 and 500),
  actor           uuid,
  at              timestamptz not null default now(),
  constraint ck_pe_override_reason check (outcome <> 'overridden' or reason is not null)
);
create index if not exists ix_pe_org_at on finance_v3.protection_events (organization_id, at desc, id desc);

-- ---------------------------------------------------------------------------------------------------------------
-- Project finance. The project itself is a legacy record (no foreign key, D-07); membership is proven with project_in_org.
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists finance_v3.project_finance (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references finance_v3.org_settings(organization_id) on delete restrict,
  project_id        uuid not null,
  client_id         uuid,
  currency          text not null references finance_v3.currencies(code),
  contract_value    numeric(19,4) not null default 0 check (contract_value >= 0),
  budget_total      numeric(19,4) not null default 0 check (budget_total >= 0),
  animator_budget   numeric(19,4) not null default 0 check (animator_budget >= 0),
  production_budget numeric(19,4) not null default 0 check (production_budget >= 0),
  is_active         boolean not null default true,
  notes             text check (notes is null or char_length(notes) <= 1000),
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint uq_pf_org_id unique (organization_id, id),
  constraint uq_pf_project unique (organization_id, project_id),
  constraint fk_pf_client foreign key (organization_id, client_id) references finance_v3.contacts_v3 (organization_id, id) on delete restrict,
  constraint ck_pf_budget_parts check (animator_budget <= budget_total and production_budget <= budget_total)
);

-- ---------------------------------------------------------------------------------------------------------------
-- Animators. An animator is a freelancer contact. An assignment fixes the agreed rate for one project and one unit of work.
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists finance_v3.animator_assignments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references finance_v3.org_settings(organization_id) on delete restrict,
  project_id      uuid not null,
  animator_id     uuid not null,
  rate_unit       text not null check (rate_unit in ('shot', 'second', 'minute', 'hour', 'day', 'fixed', 'unit')),
  agreed_rate     numeric(19,4) not null check (agreed_rate > 0),
  currency        text not null references finance_v3.currencies(code),
  role_label      text check (role_label is null or char_length(role_label) <= 80),
  status          text not null default 'active' check (status in ('active', 'ended')),
  legacy_ref      text check (legacy_ref is null or char_length(legacy_ref) <= 120),
  notes           text check (notes is null or char_length(notes) <= 1000),
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint uq_aa_org_id unique (organization_id, id),
  constraint fk_aa_animator foreign key (organization_id, animator_id) references finance_v3.contacts_v3 (organization_id, id) on delete restrict
);
create unique index if not exists uq_aa_active on finance_v3.animator_assignments (organization_id, project_id, animator_id, rate_unit) where status = 'active';
create index if not exists ix_aa_project on finance_v3.animator_assignments (organization_id, project_id);
create index if not exists ix_aa_animator on finance_v3.animator_assignments (organization_id, animator_id);

-- A work item is one claim of work. quantity x rate is frozen when it is submitted; approval fixes the approved quantity and
-- amount and creates the obligation (liability). Paying reduces the outstanding amount.
create table if not exists finance_v3.animator_work_items (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references finance_v3.org_settings(organization_id) on delete restrict,
  assignment_id      uuid not null,
  work_ref           text not null check (char_length(btrim(work_ref)) between 1 and 80),
  description        text not null check (char_length(btrim(description)) between 1 and 500),
  currency           text not null references finance_v3.currencies(code),
  rate               numeric(19,4) not null check (rate > 0),
  submitted_quantity numeric(19,4) not null check (submitted_quantity > 0),
  submitted_amount   numeric(19,4) not null check (submitted_amount > 0),
  status             text not null default 'submitted' check (status in ('submitted', 'approved', 'rejected', 'void')),
  approved_quantity  numeric(19,4) check (approved_quantity is null or approved_quantity > 0),
  approved_amount    numeric(19,4) check (approved_amount is null or approved_amount > 0),
  amount_paid        numeric(19,4) not null default 0 check (amount_paid >= 0),
  outstanding        numeric(19,4) generated always as (case when status = 'approved' then approved_amount - amount_paid else 0 end) stored,
  payment_status     text generated always as (
                       case when status <> 'approved' then 'not_applicable'
                            when amount_paid = 0 then 'unpaid'
                            when amount_paid >= approved_amount then 'paid'
                            else 'partially_paid' end) stored,
  due_date           date,
  submitted_on       date not null default current_date,
  approved_entry_id  uuid,
  void_entry_id      uuid,
  decision_reason    text check (decision_reason is null or char_length(decision_reason) <= 500),
  idempotency_key    text not null check (char_length(idempotency_key) between 1 and 200 and idempotency_key ~ '^[A-Za-z0-9_.:-]+$'),
  created_by         uuid,
  created_at         timestamptz not null default now(),
  approved_by        uuid,
  approved_at        timestamptz,
  updated_at         timestamptz not null default now(),
  constraint uq_awi_org_id unique (organization_id, id),
  constraint uq_awi_key unique (organization_id, idempotency_key),
  constraint fk_awi_assignment foreign key (organization_id, assignment_id) references finance_v3.animator_assignments (organization_id, id) on delete restrict,
  constraint fk_awi_entry foreign key (organization_id, approved_entry_id) references finance_v3.journal_entries (organization_id, id) on delete restrict,
  constraint ck_awi_paid check (amount_paid <= coalesce(approved_amount, 0)),
  constraint ck_awi_approved check ((status = 'approved') = (approved_amount is not null and approved_quantity is not null and approved_entry_id is not null) or status = 'void'),
  constraint ck_awi_approved_cap check (approved_quantity is null or approved_quantity <= submitted_quantity)
);
-- One obligation per piece of work: the same work reference cannot be live twice for one assignment.
create unique index if not exists uq_awi_live_ref on finance_v3.animator_work_items (organization_id, assignment_id, lower(btrim(work_ref))) where status in ('submitted', 'approved');
create index if not exists ix_awi_status on finance_v3.animator_work_items (organization_id, status, due_date);

create table if not exists finance_v3.animator_payments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  work_item_id    uuid not null,
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
  constraint uq_ap_org_id unique (organization_id, id),
  constraint uq_ap_key unique (organization_id, idempotency_key),
  constraint fk_ap_work foreign key (organization_id, work_item_id) references finance_v3.animator_work_items (organization_id, id) on delete restrict,
  constraint fk_ap_account foreign key (organization_id, pay_account_id) references finance_v3.accounts (organization_id, id) on delete restrict,
  constraint fk_ap_entry foreign key (organization_id, entry_id) references finance_v3.journal_entries (organization_id, id) on delete restrict
);
create index if not exists ix_ap_work on finance_v3.animator_payments (organization_id, work_item_id);

-- ---------------------------------------------------------------------------------------------------------------
-- Fund allocations: a protected set-aside of a project's money. Logical only, never a ledger entry.
--   remaining = amount - amount_used (spent by an expense against the project) - amount_released (freed by a person).
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists finance_v3.fund_allocations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references finance_v3.org_settings(organization_id) on delete restrict,
  project_id      uuid not null,
  purpose         text not null check (purpose in ('production', 'operations')),
  currency        text not null references finance_v3.currencies(code),
  amount          numeric(19,4) not null check (amount > 0),
  amount_used     numeric(19,4) not null default 0 check (amount_used >= 0),
  amount_released numeric(19,4) not null default 0 check (amount_released >= 0),
  remaining       numeric(19,4) generated always as (amount - amount_used - amount_released) stored,
  note            text check (note is null or char_length(note) <= 500),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200 and idempotency_key ~ '^[A-Za-z0-9_.:-]+$'),
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint uq_fa_org_id unique (organization_id, id),
  constraint uq_fa_key unique (organization_id, idempotency_key),
  constraint ck_fa_parts check (amount_used + amount_released <= amount)
);
create index if not exists ix_fa_project on finance_v3.fund_allocations (organization_id, project_id, purpose);

-- ---------------------------------------------------------------------------------------------------------------
-- Business reserves. A reserve is either LOGICAL (a protected portion of ordinary cash, moved by contributions and
-- withdrawals recorded here) or ACCOUNT (a real ledger cash account whose balance is the reserve; move money with transfers).
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists finance_v3.reserves (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references finance_v3.org_settings(organization_id) on delete restrict,
  name              text not null check (char_length(btrim(name)) between 1 and 80),
  purpose           text check (purpose is null or char_length(purpose) <= 300),
  currency          text not null references finance_v3.currencies(code),
  mode              text not null check (mode in ('logical', 'account')),
  ledger_account_id uuid,
  target_amount     numeric(19,4) not null default 0 check (target_amount >= 0),
  minimum_amount    numeric(19,4) not null default 0 check (minimum_amount >= 0),
  is_active         boolean not null default true,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint uq_res_org_id unique (organization_id, id),
  constraint uq_res_name unique (organization_id, name),
  constraint fk_res_account foreign key (organization_id, ledger_account_id) references finance_v3.accounts (organization_id, id) on delete restrict,
  constraint ck_res_mode check ((mode = 'account') = (ledger_account_id is not null)),
  constraint ck_res_min check (minimum_amount <= target_amount)
);
create unique index if not exists uq_res_account on finance_v3.reserves (organization_id, ledger_account_id) where ledger_account_id is not null;

create table if not exists finance_v3.reserve_movements (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  reserve_id      uuid not null,
  kind            text not null check (kind in ('contribution', 'withdrawal')),
  amount          numeric(19,4) not null check (amount > 0),
  currency        text not null references finance_v3.currencies(code),
  moved_on        date not null,
  note            text check (note is null or char_length(note) <= 500),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200 and idempotency_key ~ '^[A-Za-z0-9_.:-]+$'),
  created_by      uuid,
  created_at      timestamptz not null default now(),
  constraint uq_rm_key unique (organization_id, idempotency_key),
  constraint fk_rm_reserve foreign key (organization_id, reserve_id) references finance_v3.reserves (organization_id, id) on delete restrict
);
create index if not exists ix_rm_reserve on finance_v3.reserve_movements (organization_id, reserve_id, moved_on desc);

-- ---------------------------------------------------------------------------------------------------------------
-- Owner compensation. salary is a business expense; draw and personal_withdrawal are equity (never an expense);
-- contribution is equity in; reimbursement settles Owner Payable; owner_paid_expense creates Owner Payable.
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists finance_v3.owner_payments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references finance_v3.org_settings(organization_id) on delete restrict,
  kind            text not null check (kind in ('salary', 'draw', 'personal_withdrawal', 'contribution', 'reimbursement', 'owner_paid_expense')),
  classification  text generated always as (
                    case kind when 'salary' then 'business_expense'
                              when 'draw' then 'owner_equity'
                              when 'personal_withdrawal' then 'personal'
                              when 'contribution' then 'owner_equity'
                              when 'reimbursement' then 'owner_payable'
                              else 'business_expense' end) stored,
  status          text not null check (status in ('scheduled', 'recorded', 'cancelled', 'reversed')),
  amount          numeric(19,4) not null check (amount > 0),
  currency        text not null references finance_v3.currencies(code),
  scheduled_for   date,
  paid_on         date,
  account_id      uuid,
  category_id     uuid,
  project_id      uuid,
  note            text check (note is null or char_length(note) <= 500),
  entry_id        uuid,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200 and idempotency_key ~ '^[A-Za-z0-9_.:-]+$'),
  created_by      uuid,
  created_at      timestamptz not null default now(),
  executed_by     uuid,
  updated_at      timestamptz not null default now(),
  constraint uq_op_org_id unique (organization_id, id),
  constraint uq_op_key unique (organization_id, idempotency_key),
  constraint fk_op_account foreign key (organization_id, account_id) references finance_v3.accounts (organization_id, id) on delete restrict,
  constraint fk_op_entry foreign key (organization_id, entry_id) references finance_v3.journal_entries (organization_id, id) on delete restrict,
  constraint ck_op_recorded check (status not in ('recorded', 'reversed') or (entry_id is not null and paid_on is not null)),
  constraint ck_op_scheduled check (status <> 'scheduled' or (scheduled_for is not null and entry_id is null)),
  constraint ck_op_cash check (kind = 'owner_paid_expense' or status = 'scheduled' or status = 'cancelled' or account_id is not null)
);
create index if not exists ix_op_status on finance_v3.owner_payments (organization_id, status, scheduled_for);

-- ---------------------------------------------------------------------------------------------------------------
-- Guards. Money documents are never deleted; frozen facts cannot be edited; logs are append-only.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.tg_guard_work_items()
returns trigger language plpgsql set search_path = pg_catalog, finance_v3 as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'animator_work_items rows are never deleted. Void them instead.' using errcode = 'V3002';
  end if;
  if row(new.organization_id, new.assignment_id, new.work_ref, new.currency, new.rate, new.submitted_quantity, new.submitted_amount,
         new.idempotency_key, new.created_by, new.created_at)
     is distinct from
     row(old.organization_id, old.assignment_id, old.work_ref, old.currency, old.rate, old.submitted_quantity, old.submitted_amount,
         old.idempotency_key, old.created_by, old.created_at) then
    raise exception 'The submitted facts of a work item cannot be changed.' using errcode = 'V3002';
  end if;
  if old.status in ('rejected', 'void') then
    raise exception 'A % work item is final.', old.status using errcode = 'V3002';
  end if;
  if old.status = 'approved' then
    if new.status not in ('approved', 'void') or new.approved_quantity is distinct from old.approved_quantity
       or new.approved_amount is distinct from old.approved_amount or new.approved_entry_id is distinct from old.approved_entry_id then
      raise exception 'Approved work cannot be changed. Void it (which reverses the obligation).' using errcode = 'V3002';
    end if;
  end if;
  return new;
end; $$;
drop trigger if exists tg_guard on finance_v3.animator_work_items;
create trigger tg_guard before update or delete on finance_v3.animator_work_items for each row execute function finance_v3.tg_guard_work_items();

create or replace function finance_v3.tg_guard_animator_payments()
returns trigger language plpgsql set search_path = pg_catalog, finance_v3 as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'animator_payments rows are never deleted. Reverse them instead.' using errcode = 'V3002';
  end if;
  if row(new.organization_id, new.work_item_id, new.amount, new.currency, new.paid_on, new.pay_account_id, new.entry_id, new.idempotency_key)
     is distinct from
     row(old.organization_id, old.work_item_id, old.amount, old.currency, old.paid_on, old.pay_account_id, old.entry_id, old.idempotency_key)
     or old.status = 'reversed' or (old.status = 'recorded' and new.status not in ('recorded', 'reversed')) then
    raise exception 'A recorded animator payment can only be reversed, never edited.' using errcode = 'V3002';
  end if;
  return new;
end; $$;
drop trigger if exists tg_guard on finance_v3.animator_payments;
create trigger tg_guard before update or delete on finance_v3.animator_payments for each row execute function finance_v3.tg_guard_animator_payments();

create or replace function finance_v3.tg_guard_allocations()
returns trigger language plpgsql set search_path = pg_catalog, finance_v3 as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'fund_allocations rows are never deleted. Release them instead.' using errcode = 'V3002';
  end if;
  if row(new.organization_id, new.project_id, new.purpose, new.currency, new.amount, new.idempotency_key)
     is distinct from row(old.organization_id, old.project_id, old.purpose, old.currency, old.amount, old.idempotency_key)
     or new.amount_used < old.amount_used or new.amount_released < old.amount_released then
    raise exception 'An allocation can only be used or released further, never edited.' using errcode = 'V3002';
  end if;
  return new;
end; $$;
drop trigger if exists tg_guard on finance_v3.fund_allocations;
create trigger tg_guard before update or delete on finance_v3.fund_allocations for each row execute function finance_v3.tg_guard_allocations();

create or replace function finance_v3.tg_guard_owner_payments()
returns trigger language plpgsql set search_path = pg_catalog, finance_v3 as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'owner_payments rows are never deleted. Cancel or reverse them instead.' using errcode = 'V3002';
  end if;
  if row(new.organization_id, new.kind, new.currency, new.idempotency_key, new.created_by, new.created_at)
     is distinct from row(old.organization_id, old.kind, old.currency, old.idempotency_key, old.created_by, old.created_at) then
    raise exception 'The kind and currency of an owner payment cannot be changed.' using errcode = 'V3002';
  end if;
  if old.status in ('cancelled', 'reversed') then
    raise exception 'A % owner payment is final.', old.status using errcode = 'V3002';
  end if;
  if old.status = 'recorded' and (new.status not in ('recorded', 'reversed') or new.amount <> old.amount
     or new.entry_id is distinct from old.entry_id or new.account_id is distinct from old.account_id or new.paid_on is distinct from old.paid_on) then
    raise exception 'A recorded owner payment can only be reversed, never edited.' using errcode = 'V3002';
  end if;
  return new;
end; $$;
drop trigger if exists tg_guard on finance_v3.owner_payments;
create trigger tg_guard before update or delete on finance_v3.owner_payments for each row execute function finance_v3.tg_guard_owner_payments();

create or replace function finance_v3.tg_guard_reserves()
returns trigger language plpgsql set search_path = pg_catalog, finance_v3 as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'reserves rows are never deleted. Deactivate them instead.' using errcode = 'V3002';
  end if;
  if row(new.organization_id, new.currency, new.mode, new.ledger_account_id)
     is distinct from row(old.organization_id, old.currency, old.mode, old.ledger_account_id) then
    raise exception 'A reserve keeps its currency and type. Create a new reserve instead.' using errcode = 'V3002';
  end if;
  return new;
end; $$;
drop trigger if exists tg_guard on finance_v3.reserves;
create trigger tg_guard before update or delete on finance_v3.reserves for each row execute function finance_v3.tg_guard_reserves();

drop trigger if exists tg_no_delete on finance_v3.project_finance;
create trigger tg_no_delete before delete on finance_v3.project_finance for each row execute function finance_v3.tg_no_delete_money();
drop trigger if exists tg_no_delete on finance_v3.animator_assignments;
create trigger tg_no_delete before delete on finance_v3.animator_assignments for each row execute function finance_v3.tg_no_delete_money();
drop trigger if exists tg_append_only on finance_v3.reserve_movements;
create trigger tg_append_only before update or delete on finance_v3.reserve_movements for each row execute function finance_v3.tg_append_only();
drop trigger if exists tg_append_only on finance_v3.protection_events;
create trigger tg_append_only before update or delete on finance_v3.protection_events for each row execute function finance_v3.tg_append_only();

-- ---------------------------------------------------------------------------------------------------------------
-- Row level security: SELECT only, by organization and finance.read. All writes go through SECURITY DEFINER RPCs.
-- ---------------------------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['protection_settings', 'protection_events', 'project_finance', 'animator_assignments', 'animator_work_items',
                           'animator_payments', 'fund_allocations', 'reserves', 'reserve_movements', 'owner_payments'] loop
    execute format('alter table finance_v3.%I enable row level security', t);
    execute format('drop policy if exists fin3_select_%s on finance_v3.%I', t, t);
    execute format('create policy fin3_select_%s on finance_v3.%I for select to authenticated using (finance_v3.has_permission(organization_id, %L))', t, t, 'finance.read');
    execute format('revoke all on finance_v3.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on finance_v3.%I to authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Safe-to-spend. ONE calculation. Everything that decides whether money may leave the business reads it from here.
--
--   available cash   ledger balance (native, this currency) of every active cash/bank account under 1000 Cash and Bank, except
--                    1050 Online Payments Clearing (collected, not yet settled), 1060 FX clearing, and any account that IS a reserve.
--   minus            approved animator work not yet paid
--                    minus approved supplier/contractor/freelancer bills not yet paid
--                    minus owner payments scheduled inside the commitment horizon
--                    minus active production and operations allocations (remaining)
--                    minus logical reserves (their current balance)
--   Not counted as cash: unpaid client invoices, manual payments awaiting verification, money still in clearing.
--
-- Double counting is prevented structurally: animator work items and payables are separate documents with separate liability
-- accounts (2100 and 2000); allocations never include animator obligations (their purposes are production and operations only);
-- an account-type reserve is removed from cash instead of being subtracted again.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.cash_account_ids(p_org uuid)
returns table (account_id uuid)
language sql stable security definer
set search_path = pg_catalog, finance_v3
as $$
  select a.id
    from finance_v3.accounts a
   where a.organization_id = p_org and a.account_type = 'asset' and a.is_active and a.is_postable
     and a.parent_id = (select c.id from finance_v3.accounts c where c.organization_id = p_org and c.system_key = 'cash_and_bank')
     and coalesce(a.system_key, '') not in ('payment_clearing', 'fx_clearing')
     and not exists (select 1 from finance_v3.reserves r
                      where r.organization_id = p_org and r.mode = 'account' and r.is_active and r.ledger_account_id = a.id);
$$;

create or replace function finance_v3.reserve_balance(p_org uuid, p_reserve uuid)
returns numeric
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare r finance_v3.reserves; v numeric;
begin
  select * into r from finance_v3.reserves x where x.organization_id = p_org and x.id = p_reserve;
  if not found then return 0; end if;
  if r.mode = 'account' then
    return finance_v3.account_native_balance(p_org, r.ledger_account_id, r.currency, current_date);
  end if;
  select coalesce(sum(case m.kind when 'contribution' then m.amount else -m.amount end), 0) into v
    from finance_v3.reserve_movements m where m.organization_id = p_org and m.reserve_id = p_reserve;
  return v;
end;
$$;

create or replace function finance_v3.safe_to_spend_parts(p_org uuid, p_ccy text)
returns table (cash numeric, animators numeric, bills numeric, owner_scheduled numeric,
               alloc_production numeric, alloc_operations numeric, reserves numeric, raw numeric)
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_cash numeric; v_anim numeric; v_bills numeric; v_owner numeric; v_prod numeric; v_ops numeric; v_res numeric; v_h smallint;
begin
  select coalesce(max(ps.commitment_horizon_days), 30) into v_h
    from finance_v3.protection_settings ps where ps.organization_id = p_org;
  if v_h is null then v_h := 30; end if;

  select coalesce(sum(case l.side when 'debit' then l.amount_native else -l.amount_native end), 0) into v_cash
    from finance_v3.journal_lines l join finance_v3.journal_entries e on e.id = l.entry_id
   where l.organization_id = p_org and l.currency = p_ccy and e.status = 'posted' and e.accounting_date <= current_date
     and l.account_id in (select ca.account_id from finance_v3.cash_account_ids(p_org) ca);

  select coalesce(sum(w.outstanding), 0) into v_anim
    from finance_v3.animator_work_items w where w.organization_id = p_org and w.currency = p_ccy and w.status = 'approved';
  select coalesce(sum(b.outstanding), 0) into v_bills
    from finance_v3.payables b where b.organization_id = p_org and b.currency = p_ccy and b.status in ('approved', 'partially_paid');
  select coalesce(sum(o.amount), 0) into v_owner
    from finance_v3.owner_payments o
   where o.organization_id = p_org and o.currency = p_ccy and o.status = 'scheduled'
     and o.kind in ('salary', 'draw', 'personal_withdrawal', 'reimbursement') and o.scheduled_for <= current_date + v_h;
  select coalesce(sum(a.remaining) filter (where a.purpose = 'production'), 0), coalesce(sum(a.remaining) filter (where a.purpose = 'operations'), 0)
    into v_prod, v_ops
    from finance_v3.fund_allocations a where a.organization_id = p_org and a.currency = p_ccy;
  select coalesce(sum(finance_v3.reserve_balance(p_org, r.id)), 0) into v_res
    from finance_v3.reserves r where r.organization_id = p_org and r.currency = p_ccy and r.is_active and r.mode = 'logical';

  return query select v_cash, v_anim, v_bills, v_owner, v_prod, v_ops, v_res,
                      v_cash - v_anim - v_bills - v_owner - v_prod - v_ops - v_res;
end;
$$;

-- Transparent breakdown for one currency: every figure, where it comes from, and what is deliberately not counted.
create or replace function finance_v3.safe_to_spend_json(p_org uuid, p_ccy text)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  p record; v_accounts jsonb; v_clearing numeric; v_pending numeric; v_unpaid numeric; v_reserves jsonb; v_clear_id uuid;
begin
  select * into p from finance_v3.safe_to_spend_parts(p_org, p_ccy);
  select coalesce(jsonb_agg(jsonb_build_object('account_id', a.id, 'code', a.code, 'name', a.name,
           'balance', finance_v3.money_text(finance_v3.account_native_balance(p_org, a.id, p_ccy, current_date), p_ccy)) order by a.code), '[]'::jsonb)
    into v_accounts
    from finance_v3.accounts a where a.organization_id = p_org and a.id in (select ca.account_id from finance_v3.cash_account_ids(p_org) ca);
  select a.id into v_clear_id from finance_v3.accounts a where a.organization_id = p_org and a.system_key = 'payment_clearing';
  v_clearing := case when v_clear_id is null then 0 else finance_v3.account_native_balance(p_org, v_clear_id, p_ccy, current_date) end;
  select coalesce(sum(x.amount), 0) into v_pending from finance_v3.payments x
   where x.organization_id = p_org and x.currency = p_ccy and x.verification_status = 'pending_verification';
  select coalesce(sum(r.outstanding), 0) into v_unpaid from finance_v3.receivables r
   where r.organization_id = p_org and r.currency = p_ccy and r.status in ('issued', 'partially_paid');
  select coalesce(jsonb_agg(jsonb_build_object('reserve_id', r.id, 'name', r.name, 'mode', r.mode,
           'balance', finance_v3.money_text(finance_v3.reserve_balance(p_org, r.id), p_ccy),
           'treatment', case r.mode when 'logical' then 'subtracted' else 'excluded from cash' end) order by r.name), '[]'::jsonb)
    into v_reserves from finance_v3.reserves r where r.organization_id = p_org and r.currency = p_ccy and r.is_active;
  return jsonb_build_object(
    'currency', p_ccy,
    'available_cash', finance_v3.money_text(p.cash, p_ccy),
    'cash_accounts', v_accounts,
    'deductions', jsonb_build_array(
      jsonb_build_object('key', 'animator_obligations', 'label', 'Approved animator work not yet paid', 'amount', finance_v3.money_text(p.animators, p_ccy), 'source', 'animator_work_items'),
      jsonb_build_object('key', 'approved_bills', 'label', 'Approved bills not yet paid', 'amount', finance_v3.money_text(p.bills, p_ccy), 'source', 'payables (account 2000)'),
      jsonb_build_object('key', 'scheduled_owner_payments', 'label', 'Owner payments scheduled soon', 'amount', finance_v3.money_text(p.owner_scheduled, p_ccy), 'source', 'owner_payments'),
      jsonb_build_object('key', 'production_allocations', 'label', 'Set aside for production', 'amount', finance_v3.money_text(p.alloc_production, p_ccy), 'source', 'fund_allocations'),
      jsonb_build_object('key', 'operations_allocations', 'label', 'Set aside for business operations', 'amount', finance_v3.money_text(p.alloc_operations, p_ccy), 'source', 'fund_allocations'),
      jsonb_build_object('key', 'reserves', 'label', 'Protected business reserve', 'amount', finance_v3.money_text(p.reserves, p_ccy), 'source', 'reserves (logical)')),
    'reserves', v_reserves,
    'raw', finance_v3.money_text(p.raw, p_ccy),
    'safe_to_spend', finance_v3.money_text(greatest(p.raw, 0), p_ccy),
    'shortfall', finance_v3.money_text(greatest(-p.raw, 0), p_ccy),
    'not_counted_as_cash', jsonb_build_object(
      'unpaid_client_invoices', finance_v3.money_text(v_unpaid, p_ccy),
      'manual_payments_awaiting_verification', finance_v3.money_text(v_pending, p_ccy),
      'online_payments_clearing', finance_v3.money_text(v_clearing, p_ccy)));
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Protection enforcement. The one place a spend is judged. Call it AFTER lock_org (so two concurrent spends cannot both pass).
--
--   p_check  commitment_payment   paying something already counted as a commitment (bill, animator): refused only when the cash is not there
--            spend                money leaving for anything else: refused when it exceeds safe-to-spend (plus p_releases)
--            reserve_contribution setting money aside: refused when it exceeds safe-to-spend
--            reserve_withdrawal   taking money out of a reserve: refused when it would take it below its minimum
--   p_releases  commitments this very spend discharges (a scheduled owner payment, a production allocation being spent)
--   p_override  null, or {"reason": "..."} from a user holding finance.override
-- Returns {outcome: ok|warned|overridden, violations: [...]}; raises V3007 in block mode, V3005 for an unauthorized override.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.protection_violations(
  p_org uuid, p_check text, p_amount numeric, p_ccy text, p_releases numeric, p_reserve uuid default null)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  p record; v_viol jsonb := '[]'::jsonb; v_free numeric; r finance_v3.reserves; v_cur numeric;
begin
  if p_check not in ('commitment_payment', 'spend', 'reserve_contribution', 'reserve_withdrawal') or p_amount is null or p_amount <= 0 then
    raise exception 'Invalid protection check.' using errcode = 'V3011';
  end if;
  select * into p from finance_v3.safe_to_spend_parts(p_org, p_ccy);
  v_free := greatest(p.raw, 0) + greatest(coalesce(p_releases, 0), 0);

  if p_check = 'commitment_payment' then
    if p_amount > p.cash then
      v_viol := v_viol || jsonb_build_array(jsonb_build_object('rule', 'insufficient_cash', 'available', finance_v3.money_text(p.cash, p_ccy),
        'amount', finance_v3.money_text(p_amount, p_ccy), 'shortfall', finance_v3.money_text(p_amount - p.cash, p_ccy),
        'message', format('Only %s %s is available as cash, and this payment is %s %s.', p_ccy, finance_v3.money_text(p.cash, p_ccy), p_ccy, finance_v3.money_text(p_amount, p_ccy))));
    end if;
  elsif p_check in ('spend', 'reserve_contribution') then
    if p_amount > v_free then
      v_viol := v_viol || jsonb_build_array(jsonb_build_object('rule', 'exceeds_safe_to_spend', 'available', finance_v3.money_text(v_free, p_ccy),
        'amount', finance_v3.money_text(p_amount, p_ccy), 'shortfall', finance_v3.money_text(p_amount - v_free, p_ccy),
        'message', format('%s %s is more than the %s %s that is safe to spend. The rest is committed to animators, bills, reserves or set-asides.',
          p_ccy, finance_v3.money_text(p_amount, p_ccy), p_ccy, finance_v3.money_text(v_free, p_ccy))));
    end if;
    if p_check = 'spend' and p_amount > p.cash then
      v_viol := v_viol || jsonb_build_array(jsonb_build_object('rule', 'insufficient_cash', 'available', finance_v3.money_text(p.cash, p_ccy),
        'amount', finance_v3.money_text(p_amount, p_ccy), 'shortfall', finance_v3.money_text(p_amount - p.cash, p_ccy),
        'message', format('Only %s %s is available as cash.', p_ccy, finance_v3.money_text(p.cash, p_ccy))));
    end if;
  else
    select * into r from finance_v3.reserves x where x.organization_id = p_org and x.id = p_reserve;
    if found then
      v_cur := finance_v3.reserve_balance(p_org, r.id);
      if v_cur - p_amount < r.minimum_amount then
        v_viol := v_viol || jsonb_build_array(jsonb_build_object('rule', 'reserve_below_minimum', 'available', finance_v3.money_text(greatest(v_cur - r.minimum_amount, 0), p_ccy),
          'amount', finance_v3.money_text(p_amount, p_ccy), 'shortfall', finance_v3.money_text(r.minimum_amount - (v_cur - p_amount), p_ccy),
          'message', format('This would take the "%s" reserve to %s %s, below its minimum of %s %s.', r.name, p_ccy,
            finance_v3.money_text(v_cur - p_amount, p_ccy), p_ccy, finance_v3.money_text(r.minimum_amount, p_ccy))));
      end if;
    end if;
  end if;

  return v_viol;
end;
$$;

create or replace function finance_v3.enforce_protection(
  p_org uuid, p_actor uuid, p_check text, p_amount numeric, p_ccy text, p_releases numeric,
  p_subject_type text, p_subject_id text, p_override jsonb, p_reserve uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_mode text; v_viol jsonb; v_reason text; v_k text; v_outcome text; v jsonb; v_first text;
begin
  v_viol := finance_v3.protection_violations(p_org, p_check, p_amount, p_ccy, p_releases, p_reserve);
  insert into finance_v3.protection_settings (organization_id) values (p_org) on conflict (organization_id) do nothing;
  select ps.mode into v_mode from finance_v3.protection_settings ps where ps.organization_id = p_org;

  if jsonb_array_length(v_viol) = 0 then
    return jsonb_build_object('outcome', 'ok', 'violations', '[]'::jsonb);
  end if;

  -- An override carries a reason and nothing else.
  if p_override is not null then
    if jsonb_typeof(p_override) <> 'object' then raise exception 'The override must be an object.' using errcode = 'V3011'; end if;
    select k into v_k from jsonb_object_keys(p_override) k where k <> 'reason' limit 1;
    if v_k is not null then raise exception 'Unknown override field "%".', v_k using errcode = 'V3011'; end if;
    v_reason := nullif(btrim(p_override ->> 'reason'), '');
    if v_reason is null or char_length(v_reason) not between 10 and 500 then
      raise exception 'An override needs a reason of 10 to 500 characters.' using errcode = 'V3011';
    end if;
  end if;

  if v_mode = 'block' then
    if p_override is null then
      v_first := v_viol -> 0 ->> 'message';
      raise exception '%', v_first using errcode = 'V3007', detail = v_viol::text,
        hint = 'A user with the finance.override permission can proceed by supplying a reason.';
    end if;
    if not finance_v3.has_permission_for(p_actor, p_org, 'finance.override') then
      raise exception 'You are not allowed to override a financial protection in this studio.' using errcode = 'V3005';
    end if;
    v_outcome := 'overridden';
  else
    v_outcome := case when p_override is not null and finance_v3.has_permission_for(p_actor, p_org, 'finance.override') then 'overridden' else 'warned' end;
    if v_outcome = 'warned' then v_reason := null; end if;
  end if;

  for v in select * from jsonb_array_elements(v_viol) loop
    insert into finance_v3.protection_events (organization_id, rule, outcome, check_kind, subject_type, subject_id, amount, currency,
                                              available, shortfall, reason, actor)
    values (p_org, v ->> 'rule', v_outcome, p_check, p_subject_type, p_subject_id, p_amount, p_ccy,
            (v ->> 'available')::numeric, (v ->> 'shortfall')::numeric, v_reason, p_actor);
  end loop;
  perform finance_v3.write_audit(p_org, p_actor, 'protection_' || v_outcome, p_subject_type, p_subject_id, null,
    jsonb_build_object('check', p_check, 'amount', finance_v3.money_text(p_amount, p_ccy), 'currency', p_ccy, 'violations', v_viol), v_reason);
  return jsonb_build_object('outcome', v_outcome, 'violations', v_viol);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Project fund position (one currency, the project's own): what came in, what went out, what is already claimed.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.project_funds(p_org uuid, p_project uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  pf finance_v3.project_finance; c text;
  v_received numeric; v_anim_paid numeric; v_anim_out numeric; v_exp numeric; v_billpay numeric; v_bill_out numeric;
  v_prod numeric; v_ops numeric; v_cash_out numeric; v_unalloc numeric;
begin
  select * into pf from finance_v3.project_finance x where x.organization_id = p_org and x.project_id = p_project;
  if not found then raise exception 'Set up finance for this project first.' using errcode = 'V3010'; end if;
  c := pf.currency;
  select coalesce(sum(p.amount - p.refunded_amount), 0) into v_received
    from finance_v3.payments p join finance_v3.receivables r on r.organization_id = p.organization_id and r.id = p.invoice_id
   where p.organization_id = p_org and r.project_id = p_project and p.currency = c and p.verification_status = 'verified'
     and p.status in ('recorded', 'partially_refunded', 'refunded');
  select coalesce(sum(w.amount_paid), 0), coalesce(sum(w.outstanding), 0) into v_anim_paid, v_anim_out
    from finance_v3.animator_work_items w join finance_v3.animator_assignments a on a.organization_id = w.organization_id and a.id = w.assignment_id
   where w.organization_id = p_org and a.project_id = p_project and w.currency = c and w.status = 'approved';
  select coalesce(sum(e.amount), 0) into v_exp from finance_v3.expense_records e
   where e.organization_id = p_org and e.project_id = p_project and e.currency = c and e.payment_status = 'paid';
  select coalesce(sum(pp.amount), 0) into v_billpay
    from finance_v3.payable_payments pp join finance_v3.payables b on b.organization_id = pp.organization_id and b.id = pp.payable_id
   where pp.organization_id = p_org and b.project_id = p_project and pp.currency = c and pp.status = 'recorded';
  select coalesce(sum(b.outstanding), 0) into v_bill_out from finance_v3.payables b
   where b.organization_id = p_org and b.project_id = p_project and b.currency = c and b.status in ('approved', 'partially_paid');
  select coalesce(sum(a.remaining) filter (where a.purpose = 'production'), 0), coalesce(sum(a.remaining) filter (where a.purpose = 'operations'), 0)
    into v_prod, v_ops from finance_v3.fund_allocations a where a.organization_id = p_org and a.project_id = p_project and a.currency = c;
  v_cash_out := v_anim_paid + v_exp + v_billpay;
  v_unalloc := v_received - v_cash_out - v_anim_out - v_bill_out - v_prod - v_ops;
  return jsonb_build_object('currency', c,
    'client_money_received', finance_v3.money_text(v_received, c),
    'paid_out', finance_v3.money_text(v_cash_out, c),
    'animator_paid', finance_v3.money_text(v_anim_paid, c), 'expenses_paid', finance_v3.money_text(v_exp, c), 'bills_paid', finance_v3.money_text(v_billpay, c),
    'committed_to_animators', finance_v3.money_text(v_anim_out, c),
    'committed_to_bills', finance_v3.money_text(v_bill_out, c),
    'allocated_to_production', finance_v3.money_text(v_prod, c),
    'allocated_to_operations', finance_v3.money_text(v_ops, c),
    'unallocated', finance_v3.money_text(v_unalloc, c),
    '_unallocated_raw', v_unalloc::text);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- The three Phase 3 spending RPCs are replaced so protection cannot be bypassed through them. Each keeps its Phase 3
-- behaviour and gains an optional trailing p_override. The Phase 3 versions are dropped first: an overload would leave the
-- unprotected signature callable. (Generated from the Phase 3 definitions; see PHASE_4_HANDOFF.md section 3.)
-- ---------------------------------------------------------------------------------------------------------------
drop function if exists public.fin3_pay_bill(uuid, text, uuid, text, date, uuid, text);
drop function if exists public.fin3_record_expense(uuid, text, jsonb);
drop function if exists public.fin3_post_transfer(uuid, text, uuid, uuid, text, text, text, text, date, text, text);

-- Allocation helpers used by fin3_record_expense (and the allocation RPCs of migration 2).
create or replace function finance_v3.releasable_allocation(p_org uuid, p_project uuid, p_ccy text, p_amount numeric)
returns numeric
language sql stable security definer
set search_path = pg_catalog, finance_v3
as $$
  select least(p_amount, coalesce(sum(a.remaining), 0))
    from finance_v3.fund_allocations a
   where a.organization_id = p_org and a.project_id = p_project and a.currency = p_ccy and a.purpose = 'production';
$$;

-- Spends up to p_amount of the project's production set-asides, oldest first. Returns the amount used.
create or replace function finance_v3.consume_allocations(p_org uuid, p_project uuid, p_ccy text, p_amount numeric, p_actor uuid, p_ref text)
returns numeric
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare a finance_v3.fund_allocations; v_left numeric := p_amount; v_take numeric; v_used numeric := 0;
begin
  for a in select * from finance_v3.fund_allocations x
            where x.organization_id = p_org and x.project_id = p_project and x.currency = p_ccy and x.purpose = 'production' and x.remaining > 0
            order by x.created_at, x.id for update loop
    exit when v_left <= 0;
    v_take := least(a.remaining, v_left);
    update finance_v3.fund_allocations x set amount_used = x.amount_used + v_take, updated_at = now() where x.id = a.id;
    perform finance_v3.write_audit(p_org, p_actor, 'use_allocation', 'fund_allocation', a.id::text, null,
      jsonb_build_object('amount', finance_v3.money_text(v_take, p_ccy), 'currency', p_ccy, 'reference', p_ref), null);
    v_left := v_left - v_take; v_used := v_used + v_take;
  end loop;
  return v_used;
end;
$$;

create or replace function public.fin3_pay_bill(p_org uuid, p_key text, p_bill uuid, p_amount text, p_paid_on date, p_pay_account uuid, p_reference text default null, p_override jsonb default null)
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
  v_prot jsonb;
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
  -- Phase 4: paying a bill discharges a commitment that safe-to-spend already holds back; it is refused only when the cash is not there.
  v_prot := finance_v3.enforce_protection(p_org, v_uid, 'commitment_payment', v_amt, b.currency, 0, 'bill', b.id::text, p_override);
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
  return finance_v3.bill_json(b, false) || case when v_prot ->> 'outcome' <> 'ok' then jsonb_build_object('protection', v_prot) else '{}'::jsonb end;
end;
$$;

create or replace function public.fin3_record_expense(p_org uuid, p_key text, p_expense jsonb, p_override jsonb default null)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.pay');
  v_k text; x finance_v3.expense_records; cat finance_v3.expense_categories; v_ccy text; v_amt numeric; v_acc uuid;
  v_date date; v_proj uuid; v_vendor uuid; v_entry uuid; v_no text; v_prot jsonb; v_rel numeric := 0;
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
  -- Phase 4: an expense is spending. It may use money set aside for this project's production; anything beyond that must fit in safe-to-spend.
  if v_proj is not null then v_rel := finance_v3.releasable_allocation(p_org, v_proj, v_ccy, v_amt); end if;
  v_prot := finance_v3.enforce_protection(p_org, v_uid, 'spend', v_amt, v_ccy, v_rel, 'expense', v_no, p_override);
  if v_proj is not null then perform finance_v3.consume_allocations(p_org, v_proj, v_ccy, v_amt, v_uid, v_no); end if;
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
  return finance_v3.expense_json(x) || case when v_prot ->> 'outcome' <> 'ok' then jsonb_build_object('protection', v_prot) else '{}'::jsonb end;
end;
$$;

create or replace function public.fin3_post_transfer(
  p_org uuid, p_key text, p_from_account uuid, p_to_account uuid, p_from_ccy text, p_to_ccy text,
  p_amount_from text, p_amount_to text, p_date date, p_reference text default null, p_memo text default null, p_override jsonb default null)
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
  v_prot jsonb;
  v_res_from uuid;
  v_res_to uuid;
  v_prev_entry uuid;
  v_prev_no text;
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
  -- Phase 3 defect fixed here: a replay of a transfer without an explicit reference was given a NEW document number, so its request
  -- hash differed and it failed with V3021 instead of returning the original. A replay now returns the original transfer.
  select je.id, je.reference into v_prev_entry, v_prev_no
    from finance_v3.events ev join finance_v3.journal_entries je on je.organization_id = ev.organization_id and je.event_id = ev.id
   where ev.organization_id = p_org and ev.idempotency_key = 'fin3:transfer:' || finance_v3.key_hash(p_key);
  if v_prev_entry is not null then
    return jsonb_build_object('entry_id', v_prev_entry, 'transfer_no', v_prev_no);
  end if;
  -- Phase 4: a real reserve account is protected. Taking money out below its minimum, or moving ordinary cash in beyond what is
  -- safe to spend, is judged here.
  if true then
    select r.id into v_res_from from finance_v3.reserves r where r.organization_id = p_org and r.mode = 'account' and r.is_active and r.ledger_account_id = p_from_account;
    select r.id into v_res_to from finance_v3.reserves r where r.organization_id = p_org and r.mode = 'account' and r.is_active and r.ledger_account_id = p_to_account;
    if v_res_from is not null then
      v_prot := finance_v3.enforce_protection(p_org, v_uid, 'reserve_withdrawal', v_af, v_fc, 0, 'transfer', p_key, p_override, v_res_from);
    elsif v_res_to is not null then
      v_prot := finance_v3.enforce_protection(p_org, v_uid, 'reserve_contribution', v_af, v_fc, 0, 'transfer', p_key, p_override);
    end if;
  end if;
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
  return jsonb_build_object('entry_id', v_entry, 'transfer_no', v_no) || case when v_prot ->> 'outcome' in ('warned', 'overridden') then jsonb_build_object('protection', v_prot) else '{}'::jsonb end;
end;
$$;


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
