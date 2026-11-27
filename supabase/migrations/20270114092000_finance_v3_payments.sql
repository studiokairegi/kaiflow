-- Finance V3, Phase 3 (migration 3 of 6): payments, receipts, refunds, payment links, payment intents, provider events.
--
-- Rules implemented here (docs/finance-v3/FINANCE_V3_PAYSTACK_INTEGRATION_SPEC.md):
--   * A payment row counts as money received ONLY when verification_status = 'verified' and its ledger entry exists; both are
--     created in one transaction (record_payment_core). Unverified manual payments have no ledger or balance effect.
--   * Provider payments are settled by fin3svc_settle_payment (service role) after the Edge Function has verified the transaction
--     with the provider. The database re-validates amount, currency, environment, organization and invoice state. The provider
--     never supplies journal lines; this file builds them from system accounts.
--   * Idempotency layers: unique (provider, event_key), unique provider references, unique provider transaction ids, event keys
--     through post_event, row locks (organization -> receivable -> intent, always in this order).
--   * Phase 3 limitation (documented in the handoff): payments are recorded in the invoice currency; there is no cross-currency
--     checkout or realized-FX posting on settlement.
-- Rollback: supabase/rollback/20270114092000_finance_v3_payments.rollback.sql
--
-- NOT EXECUTED: written in a sandbox without PostgreSQL; statically checked only. See PHASE_3_HANDOFF.md.

begin;

insert into finance_v3.schema_version (version, notes)
values ('20270114092000', 'phase 3 migration 3: payments, receipts, refunds, links, intents, provider events')
on conflict (version) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists finance_v3.payments (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references finance_v3.org_settings(organization_id) on delete restrict,
  invoice_id              uuid not null,
  client_id               uuid not null,
  method                  text not null check (method in ('card', 'apple_pay', 'bank_transfer', 'cash', 'other')),
  provider                text check (provider is null or provider ~ '^[a-z][a-z0-9_]{1,30}$'),
  provider_reference      text check (provider_reference is null or char_length(provider_reference) between 1 and 200),
  provider_transaction_id text check (provider_transaction_id is null or char_length(provider_transaction_id) between 1 and 100),
  environment             text not null default 'live' check (environment in ('test', 'live')),
  amount                  numeric(19,4) not null check (amount > 0),
  currency                text not null references finance_v3.currencies(code),
  received_at             timestamptz not null,
  accounting_date         date not null,
  cash_account_id         uuid not null,
  fee_amount              numeric(19,4) check (fee_amount is null or fee_amount >= 0),
  verification_status     text not null check (verification_status in ('verified', 'pending_verification', 'rejected')),
  verified_at             timestamptz,
  verified_by             uuid,
  ledger_entry_id         uuid,
  fee_entry_id            uuid,
  reversal_entry_id       uuid,
  status                  text not null default 'recorded' check (status in ('recorded', 'partially_refunded', 'refunded', 'reversed')),
  refunded_amount         numeric(19,4) not null default 0 check (refunded_amount >= 0),
  reference               text check (reference is null or char_length(reference) <= 120),
  notes                   text check (notes is null or char_length(notes) <= 1000),
  evidence                jsonb not null default '[]'::jsonb,
  created_by              uuid,
  idempotency_key         text not null check (char_length(idempotency_key) between 1 and 200 and idempotency_key ~ '^[A-Za-z0-9_.:-]+$'),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint uq_payments_org_id unique (organization_id, id),
  constraint uq_payments_key unique (organization_id, idempotency_key),
  constraint fk_pay_invoice foreign key (organization_id, invoice_id) references finance_v3.receivables (organization_id, id) on delete restrict,
  constraint fk_pay_cash foreign key (organization_id, cash_account_id) references finance_v3.accounts (organization_id, id) on delete restrict,
  constraint fk_pay_entry foreign key (organization_id, ledger_entry_id) references finance_v3.journal_entries (organization_id, id) on delete restrict,
  constraint ck_pay_verified_posted check (verification_status <> 'verified' or ledger_entry_id is not null),
  constraint ck_pay_pending_clean check (verification_status = 'verified' or ledger_entry_id is null),
  constraint ck_pay_refunded check (refunded_amount <= amount),
  constraint ck_pay_provider_pair check ((provider is null) = (provider_reference is null))
);
create unique index if not exists uq_pay_provider_ref on finance_v3.payments (organization_id, provider, provider_reference) where provider is not null;
create unique index if not exists uq_pay_provider_txn on finance_v3.payments (organization_id, provider, provider_transaction_id) where provider_transaction_id is not null;
create index if not exists ix_pay_invoice on finance_v3.payments (organization_id, invoice_id);
create index if not exists ix_pay_org_status on finance_v3.payments (organization_id, verification_status, received_at desc);

create table if not exists finance_v3.receipts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references finance_v3.org_settings(organization_id) on delete restrict,
  payment_id      uuid not null,
  invoice_id      uuid not null,
  receipt_no      text not null,
  status          text not null default 'issued' check (status in ('issued', 'void')),
  issued_at       timestamptz not null default now(),
  snapshot        jsonb not null,
  constraint uq_receipts_payment unique (organization_id, payment_id),
  constraint uq_receipts_no unique (organization_id, receipt_no),
  constraint uq_receipts_org_id unique (organization_id, id),
  constraint fk_rct_payment foreign key (organization_id, payment_id) references finance_v3.payments (organization_id, id) on delete restrict
);

create table if not exists finance_v3.refunds (
  id                        uuid primary key default gen_random_uuid(),
  organization_id           uuid not null references finance_v3.org_settings(organization_id) on delete restrict,
  payment_id                uuid not null,
  invoice_id                uuid not null,
  refund_no                 text not null,
  amount                    numeric(19,4) not null check (amount > 0),
  currency                  text not null references finance_v3.currencies(code),
  reason                    text not null check (char_length(btrim(reason)) between 1 and 500),
  status                    text not null default 'requested' check (status in ('requested', 'approved', 'processing', 'processed', 'failed', 'rejected')),
  provider                  text,
  provider_refund_reference text,
  requested_by              uuid,
  approved_by               uuid,
  processed_by              uuid,
  processed_at              timestamptz,
  ledger_entry_id           uuid,
  idempotency_key           text not null check (char_length(idempotency_key) between 1 and 200 and idempotency_key ~ '^[A-Za-z0-9_.:-]+$'),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint uq_refunds_org_id unique (organization_id, id),
  constraint uq_refunds_no unique (organization_id, refund_no),
  constraint uq_refunds_key unique (organization_id, idempotency_key),
  constraint fk_ref_payment foreign key (organization_id, payment_id) references finance_v3.payments (organization_id, id) on delete restrict,
  constraint ck_ref_processed check (status <> 'processed' or (ledger_entry_id is not null and processed_at is not null))
);
create unique index if not exists uq_ref_provider on finance_v3.refunds (organization_id, provider, provider_refund_reference) where provider_refund_reference is not null;
create index if not exists ix_ref_payment on finance_v3.refunds (organization_id, payment_id);

create table if not exists finance_v3.public_links (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references finance_v3.org_settings(organization_id) on delete restrict,
  invoice_id      uuid not null,
  kind            text not null check (kind in ('view', 'pay')),
  token_hash      text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  amount          numeric(19,4) check (amount is null or amount > 0),
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  constraint uq_links_org_id unique (organization_id, id),
  constraint fk_link_invoice foreign key (organization_id, invoice_id) references finance_v3.receivables (organization_id, id) on delete restrict,
  constraint ck_link_amount_pay check (amount is null or kind = 'pay')
);
create index if not exists ix_links_invoice on finance_v3.public_links (organization_id, invoice_id, kind);

create table if not exists finance_v3.payment_intents (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references finance_v3.org_settings(organization_id) on delete restrict,
  invoice_id               uuid not null,
  client_id                uuid not null,
  link_id                  uuid,
  provider                 text not null default 'paystack' check (provider ~ '^[a-z][a-z0-9_]{1,30}$'),
  environment              text not null check (environment in ('test', 'live')),
  provider_reference       text not null check (provider_reference ~ '^KRL3-[LT]-[A-Z2-7]{12}-[A-Z2-7]{4}$'),
  invoice_amount           numeric(19,4) not null check (invoice_amount > 0),
  invoice_currency         text not null references finance_v3.currencies(code),
  charge_amount_minor      bigint not null check (charge_amount_minor > 0),
  charge_currency          text not null references finance_v3.currencies(code),
  status                   text not null default 'created'
                             check (status in ('created', 'initialized', 'pending', 'succeeded', 'failed', 'abandoned', 'expired', 'cancelled', 'needs_review')),
  authorization_url        text check (authorization_url is null or char_length(authorization_url) <= 2000),
  link_expires_at          timestamptz,
  verified_amount_minor    bigint,
  verified_currency        text,
  verified_paid_at         timestamptz,
  verified_fee_minor       bigint check (verified_fee_minor is null or verified_fee_minor >= 0),
  verified_channel         text,
  provider_transaction_id  text,
  review_reason            text check (review_reason is null or char_length(review_reason) <= 500),
  payment_id               uuid,
  created_by               uuid,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint uq_intents_org_id unique (organization_id, id),
  constraint uq_intents_ref unique (provider, provider_reference),
  constraint fk_int_invoice foreign key (organization_id, invoice_id) references finance_v3.receivables (organization_id, id) on delete restrict,
  constraint ck_int_same_currency check (invoice_currency = charge_currency)
);
create unique index if not exists uq_intents_open on finance_v3.payment_intents (invoice_id) where status in ('created', 'initialized', 'pending');
create index if not exists ix_intents_org_status on finance_v3.payment_intents (organization_id, status, created_at desc);

create table if not exists finance_v3.provider_events (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid references finance_v3.org_settings(organization_id) on delete restrict,
  provider            text not null check (provider ~ '^[a-z][a-z0-9_]{1,30}$'),
  environment         text not null check (environment in ('test', 'live')),
  event_key           text not null check (char_length(event_key) between 1 and 300),
  event_type          text not null check (char_length(event_type) between 1 and 80),
  provider_reference  text,
  payment_intent_id   uuid,
  status              text not null default 'received'
                        check (status in ('received', 'processing', 'processed', 'ignored', 'failed', 'needs_review', 'exhausted')),
  attempts            integer not null default 1,
  error               text check (error is null or char_length(error) <= 500),
  payload_sanitised   jsonb not null default '{}'::jsonb,
  received_at         timestamptz not null default now(),
  processed_at        timestamptz,
  constraint uq_provider_events_key unique (provider, event_key)
);
create index if not exists ix_provider_events_status on finance_v3.provider_events (status, received_at);
create index if not exists ix_provider_events_org on finance_v3.provider_events (organization_id, received_at desc);

-- Guards: money records are never deleted; receipts and verified facts are protected.
create or replace function finance_v3.tg_guard_payments()
returns trigger language plpgsql set search_path = pg_catalog, finance_v3 as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Payments are never deleted. Reverse or refund them instead.' using errcode = 'V3002';
  end if;
  if new.organization_id <> old.organization_id or new.invoice_id <> old.invoice_id or new.amount <> old.amount
     or new.currency <> old.currency or new.cash_account_id <> old.cash_account_id then
    raise exception 'The core facts of a payment cannot be changed.' using errcode = 'V3002';
  end if;
  if old.verification_status = 'verified' and (new.verification_status <> 'verified' or new.ledger_entry_id is distinct from old.ledger_entry_id) then
    raise exception 'A verified payment cannot be un-verified. Reverse it instead.' using errcode = 'V3002';
  end if;
  if old.verification_status = 'rejected' and new.verification_status <> 'rejected' then
    raise exception 'A rejected payment cannot be revived. Record a new payment.' using errcode = 'V3002';
  end if;
  if old.status = 'reversed' and new.status <> 'reversed' then
    raise exception 'A reversed payment cannot be revived.' using errcode = 'V3002';
  end if;
  return new;
end; $$;
drop trigger if exists tg_guard_payments on finance_v3.payments;
create trigger tg_guard_payments before update or delete on finance_v3.payments for each row execute function finance_v3.tg_guard_payments();
drop trigger if exists tg_no_truncate on finance_v3.payments;
create trigger tg_no_truncate before truncate on finance_v3.payments for each statement execute function finance_v3.tg_no_truncate();

create or replace function finance_v3.tg_guard_receipts()
returns trigger language plpgsql set search_path = pg_catalog, finance_v3 as $$
begin
  if tg_op = 'DELETE' then raise exception 'Receipts are never deleted.' using errcode = 'V3002'; end if;
  if new.snapshot is distinct from old.snapshot or new.receipt_no <> old.receipt_no or new.payment_id <> old.payment_id then
    raise exception 'A receipt keeps its historical contents.' using errcode = 'V3002';
  end if;
  return new;
end; $$;
drop trigger if exists tg_guard_receipts on finance_v3.receipts;
create trigger tg_guard_receipts before update or delete on finance_v3.receipts for each row execute function finance_v3.tg_guard_receipts();

create or replace function finance_v3.tg_guard_provider_events()
returns trigger language plpgsql set search_path = pg_catalog, finance_v3 as $$
begin
  if tg_op = 'DELETE' then raise exception 'Provider events are an audit record and are never deleted.' using errcode = 'V3002'; end if;
  if new.provider <> old.provider or new.event_key <> old.event_key or new.payload_sanitised is distinct from old.payload_sanitised then
    raise exception 'The identity of a provider event cannot change.' using errcode = 'V3002';
  end if;
  return new;
end; $$;
drop trigger if exists tg_guard_provider_events on finance_v3.provider_events;
create trigger tg_guard_provider_events before update or delete on finance_v3.provider_events for each row execute function finance_v3.tg_guard_provider_events();

-- RLS and privileges: SELECT only. Provider events and intents need finance.view_integrations; public_links hold token hashes
-- and are read through RPCs only (no client policy at all).
alter table finance_v3.payments         enable row level security;
alter table finance_v3.receipts         enable row level security;
alter table finance_v3.refunds          enable row level security;
alter table finance_v3.public_links     enable row level security;
alter table finance_v3.payment_intents  enable row level security;
alter table finance_v3.provider_events  enable row level security;

drop policy if exists fin3_select_payments on finance_v3.payments;
create policy fin3_select_payments on finance_v3.payments for select to authenticated using (finance_v3.has_permission(organization_id, 'finance.read'));
drop policy if exists fin3_select_receipts on finance_v3.receipts;
create policy fin3_select_receipts on finance_v3.receipts for select to authenticated using (finance_v3.has_permission(organization_id, 'finance.read'));
drop policy if exists fin3_select_refunds on finance_v3.refunds;
create policy fin3_select_refunds on finance_v3.refunds for select to authenticated using (finance_v3.has_permission(organization_id, 'finance.read'));
drop policy if exists fin3_select_intents on finance_v3.payment_intents;
create policy fin3_select_intents on finance_v3.payment_intents for select to authenticated using (finance_v3.has_permission(organization_id, 'finance.view_integrations'));
drop policy if exists fin3_select_provider_events on finance_v3.provider_events;
create policy fin3_select_provider_events on finance_v3.provider_events for select to authenticated
  using (organization_id is not null and finance_v3.has_permission(organization_id, 'finance.view_integrations'));

revoke all on finance_v3.payments, finance_v3.receipts, finance_v3.refunds, finance_v3.public_links, finance_v3.payment_intents,
  finance_v3.provider_events from public, anon, authenticated, service_role;
grant select on finance_v3.payments, finance_v3.receipts, finance_v3.refunds, finance_v3.payment_intents, finance_v3.provider_events to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- recompute_receivable: the ONLY writer of amount_paid / credit_total / settlement status. Derived from verified payments
-- (net of refunds) and credits, so it is correct by construction and safe to call repeatedly.
-- ---------------------------------------------------------------------------------------------------------------
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
  select coalesce(sum(p.amount - p.refunded_amount), 0) into v_paid
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

-- Payment reference: KRL3-<L|T>-<12 random base32>-<4 checksum>. No fragment of any internal id.
create or replace function finance_v3.new_payment_reference(p_env text)
returns text
language plpgsql volatile
set search_path = pg_catalog, finance_v3
as $$
declare
  c_alpha constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  h       bytea := sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8'));
  v_body  text := '';
  v_base  text;
  v_chk   text := '';
  hc      bytea;
  i       integer;
begin
  for i in 0..11 loop v_body := v_body || substr(c_alpha, (get_byte(h, i) % 32) + 1, 1); end loop;
  v_base := 'KRL3-' || case when p_env = 'live' then 'L' else 'T' end || '-' || v_body;
  hc := sha256(convert_to(v_base, 'UTF8'));
  for i in 0..3 loop v_chk := v_chk || substr(c_alpha, (get_byte(hc, i) % 32) + 1, 1); end loop;
  return v_base || '-' || v_chk;
end;
$$;

create or replace function finance_v3.payment_json(p finance_v3.payments)
returns jsonb
language sql stable
set search_path = pg_catalog, finance_v3
as $$
  select jsonb_build_object('id', p.id, 'invoice_id', p.invoice_id, 'method', p.method, 'provider', p.provider,
    'provider_reference', p.provider_reference, 'environment', p.environment, 'amount', finance_v3.money_text(p.amount, p.currency),
    'currency', p.currency, 'received_at', p.received_at, 'accounting_date', p.accounting_date,
    'fee_amount', case when p.fee_amount is null then null else finance_v3.money_text(p.fee_amount, p.currency) end,
    'verification_status', p.verification_status, 'status', p.status,
    'refunded_amount', finance_v3.money_text(p.refunded_amount, p.currency), 'reference', p.reference, 'ledger_entry_id', p.ledger_entry_id);
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- record_payment_core: the single place a payment becomes money received. Posts Dr cash account / Cr Accounts Receivable
-- (kind client_payment), the provider fee when known (kind provider_fee), creates the receipt, and recomputes the invoice.
-- The caller holds lock_org. p_payment may be an existing pending_verification row (manual flow) or null (provider flow).
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.record_payment_core(
  p_org uuid, p_invoice uuid, p_payment uuid, p_event_key text, p_method text, p_provider text, p_provider_ref text,
  p_provider_txn text, p_env text, p_amount numeric, p_ccy text, p_received_at timestamptz, p_cash_account uuid,
  p_fee numeric, p_reference text, p_notes text, p_actor uuid, p_idem text, p_evidence jsonb)
returns finance_v3.payments
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  r         finance_v3.receivables;
  pay       finance_v3.payments;
  v_ar      uuid;
  v_fee_acc uuid;
  v_date    date := (p_received_at at time zone 'UTC')::date;
  v_entry   uuid;
  v_fee_entry uuid;
  v_prev    numeric;
  v_rno     text;
  v_snap    jsonb;
  v_pid     uuid := coalesce(p_payment, gen_random_uuid());
begin
  select * into r from finance_v3.receivables x where x.organization_id = p_org and x.id = p_invoice for update;
  if not found then raise exception 'Invoice not found.' using errcode = 'V3010'; end if;
  if r.status not in ('issued', 'partially_paid') or r.ledger_mode = 'document_only' then
    raise exception 'Invoice % cannot receive payments in its current state (%).', coalesce(r.invoice_no, r.id::text), r.status using errcode = 'V3017';
  end if;
  if r.currency <> p_ccy then
    raise exception 'The payment currency (%) differs from the invoice currency (%). Phase 3 records payments in the invoice currency.', p_ccy, r.currency using errcode = 'V3014';
  end if;
  if p_amount <= 0 or p_amount > r.outstanding then
    raise exception 'The payment (%) is more than the outstanding balance (%).', finance_v3.money_text(p_amount, r.currency),
      finance_v3.money_text(r.outstanding, r.currency) using errcode = 'V3012';
  end if;
  v_ar := finance_v3.system_account(p_org, 'accounts_receivable');
  v_prev := r.amount_paid;

  v_entry := finance_v3.post_event(p_org, 'client_payment', p_event_key, v_date,
    jsonb_build_array(
      jsonb_build_object('account_id', p_cash_account, 'side', 'debit', 'amount', finance_v3.money_text(p_amount, r.currency), 'currency', r.currency),
      jsonb_build_object('account_id', v_ar, 'side', 'credit', 'amount', finance_v3.money_text(p_amount, r.currency), 'currency', r.currency)),
    jsonb_strip_nulls(jsonb_build_object('memo', left('Payment for invoice ' || r.invoice_no, 500), 'reference', r.invoice_no,
                                         'project_id', r.project_id, 'provider', p_provider, 'provider_ref', p_provider_ref)));

  if p_fee is not null and p_fee > 0 then
    v_fee_acc := finance_v3.system_account(p_org, 'bank_fees');
    v_fee_entry := finance_v3.post_event(p_org, 'provider_fee', p_event_key || ':fee', v_date,
      jsonb_build_array(
        jsonb_build_object('account_id', v_fee_acc, 'side', 'debit', 'amount', finance_v3.money_text(p_fee, r.currency), 'currency', r.currency),
        jsonb_build_object('account_id', p_cash_account, 'side', 'credit', 'amount', finance_v3.money_text(p_fee, r.currency), 'currency', r.currency)),
      jsonb_strip_nulls(jsonb_build_object('memo', left('Payment provider fee for invoice ' || r.invoice_no, 500), 'reference', r.invoice_no,
                                           'project_id', r.project_id, 'provider', p_provider, 'provider_ref', p_provider_ref)));
  end if;

  if p_payment is null then
    insert into finance_v3.payments (id, organization_id, invoice_id, client_id, method, provider, provider_reference, provider_transaction_id,
      environment, amount, currency, received_at, accounting_date, cash_account_id, fee_amount, verification_status, verified_at, verified_by,
      ledger_entry_id, fee_entry_id, reference, notes, evidence, created_by, idempotency_key)
    values (v_pid, p_org, r.id, r.client_id, p_method, p_provider, p_provider_ref, p_provider_txn, p_env, p_amount, r.currency, p_received_at,
      v_date, p_cash_account, p_fee, 'verified', now(), p_actor, v_entry, v_fee_entry, p_reference, p_notes, coalesce(p_evidence, '[]'::jsonb), p_actor, p_idem)
    returning * into pay;
  else
    update finance_v3.payments x set verification_status = 'verified', verified_at = now(), verified_by = p_actor, ledger_entry_id = v_entry,
           accounting_date = v_date, updated_at = now()
     where x.organization_id = p_org and x.id = p_payment returning * into pay;
  end if;

  v_rno := finance_v3.next_doc_number(p_org, 'receipt');
  v_snap := jsonb_build_object(
    'receipt_no', v_rno, 'issued_at', now(), 'studio', coalesce(r.snapshot -> 'studio', '{}'::jsonb), 'client', coalesce(r.snapshot -> 'client', '{}'::jsonb),
    'invoice_no', r.invoice_no, 'currency', r.currency, 'invoice_total', finance_v3.money_text(r.total, r.currency),
    'payment_amount', finance_v3.money_text(p_amount, r.currency), 'payment_date', v_date, 'payment_method', pay.method,
    'provider', pay.provider, 'payment_reference', coalesce(pay.provider_reference, pay.reference),
    'previously_paid', finance_v3.money_text(v_prev, r.currency),
    'remaining_balance', finance_v3.money_text(r.outstanding - p_amount, r.currency),
    'invoice_fully_paid', (r.outstanding - p_amount) <= 0);
  insert into finance_v3.receipts (organization_id, payment_id, invoice_id, receipt_no, snapshot) values (p_org, pay.id, r.id, v_rno, v_snap);

  perform finance_v3.recompute_receivable(p_org, r.id);
  perform finance_v3.write_audit(p_org, p_actor, 'record_payment', 'payment', pay.id::text, null,
    jsonb_build_object('invoice_no', r.invoice_no, 'amount', finance_v3.money_text(p_amount, r.currency), 'method', pay.method,
                       'provider', pay.provider, 'entry_id', v_entry, 'receipt_no', v_rno), null);
  return pay;
end;
$$;

-- Queue the receipt email without ever letting an email problem undo a legitimate payment (the email migration defines
-- finance_v3.queue_receipt_email; a missing or failing queue leaves the receipt unsent and visible, never the payment undone).
create or replace function finance_v3.try_queue_receipt_email(p_org uuid, p_payment uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  begin
    perform finance_v3.queue_receipt_email(p_org, p_payment);
  exception when others then
    perform finance_v3.write_audit(p_org, null, 'receipt_email_queue_failed', 'payment', p_payment::text, null,
      jsonb_build_object('sqlstate', sqlstate), left(sqlerrm, 300));
  end;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Manual payments (bank transfer, cash, other). Recorded as pending_verification: NO ledger effect, NO balance effect.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fin3_record_manual_payment(
  p_org uuid, p_key text, p_invoice uuid, p_amount text, p_currency text, p_received_on date, p_method text,
  p_reference text, p_cash_account uuid, p_notes text default null, p_evidence jsonb default '[]'::jsonb)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid    uuid := finance_v3.assert_permission(p_org, 'finance.collect');
  r        finance_v3.receivables;
  a        finance_v3.accounts;
  v_amount numeric;
  pay      finance_v3.payments;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  if p_key is null or char_length(p_key) not between 1 and 200 or p_key !~ '^[A-Za-z0-9_.:-]+$' then
    raise exception 'A valid idempotency key is required.' using errcode = 'V3011';
  end if;
  select * into pay from finance_v3.payments x where x.organization_id = p_org and x.idempotency_key = p_key;
  if found then return finance_v3.payment_json(pay); end if;       -- replay
  if p_method not in ('bank_transfer', 'cash', 'other') then
    raise exception 'Manual payments are bank transfer, cash or other. Card payments arrive through the payment provider.' using errcode = 'V3011';
  end if;
  if p_received_on is null or p_received_on > current_date + 1 or p_received_on < date '1990-01-01' then
    raise exception 'The payment date is not valid.' using errcode = 'V3011';
  end if;
  if p_evidence is null or jsonb_typeof(p_evidence) <> 'array' or jsonb_array_length(p_evidence) > 10 then
    raise exception 'Supporting documents must be a list of at most 10 items.' using errcode = 'V3011';
  end if;
  select * into r from finance_v3.receivables x where x.organization_id = p_org and x.id = p_invoice for update;
  if not found then raise exception 'Invoice not found.' using errcode = 'V3010'; end if;
  if r.status not in ('issued', 'partially_paid') then
    raise exception 'Invoice % cannot receive payments in its current state (%).', coalesce(r.invoice_no, r.id::text), r.status using errcode = 'V3017';
  end if;
  if upper(coalesce(p_currency, '')) <> r.currency then
    raise exception 'The payment currency must match the invoice currency (%).', r.currency using errcode = 'V3014';
  end if;
  v_amount := finance_v3.parse_money(p_amount, 'Payment amount', r.currency, false);
  if v_amount > r.outstanding then
    raise exception 'The payment (%) is more than the outstanding balance (%).', finance_v3.money_text(v_amount, r.currency),
      finance_v3.money_text(r.outstanding, r.currency) using errcode = 'V3012';
  end if;
  select * into a from finance_v3.accounts x where x.organization_id = p_org and x.id = p_cash_account;
  if not found or a.account_type <> 'asset' or not a.is_active or not a.is_postable or a.system_key in ('accounts_receivable', 'cash_and_bank')
     or (a.currency is not null and a.currency <> r.currency) then
    raise exception 'Choose an active bank, cash or clearing account that accepts %.', r.currency using errcode = 'V3009';
  end if;
  begin
    insert into finance_v3.payments (organization_id, invoice_id, client_id, method, environment, amount, currency, received_at, accounting_date,
      cash_account_id, verification_status, reference, notes, evidence, created_by, idempotency_key)
    values (p_org, r.id, r.client_id, p_method, 'live', v_amount, r.currency, p_received_on::timestamp at time zone 'UTC', p_received_on,
      p_cash_account, 'pending_verification', nullif(btrim(p_reference), ''), nullif(btrim(p_notes), ''), p_evidence, v_uid, p_key)
    returning * into pay;
  exception when check_violation then
    raise exception 'One of the payment values is not valid.' using errcode = 'V3011';
  end;
  perform finance_v3.write_audit(p_org, v_uid, 'record_manual_payment', 'payment', pay.id::text, null, finance_v3.payment_json(pay), null);
  return finance_v3.payment_json(pay);
end;
$$;

create or replace function public.fin3_verify_manual_payment(p_org uuid, p_payment uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.verify_payment');
  s     finance_v3.org_settings;
  pay   finance_v3.payments;
begin
  s := finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  select * into pay from finance_v3.payments x where x.organization_id = p_org and x.id = p_payment for update;
  if not found then raise exception 'Payment not found.' using errcode = 'V3010'; end if;
  if pay.verification_status = 'verified' then return finance_v3.payment_json(pay); end if;          -- idempotent
  if pay.verification_status <> 'pending_verification' or pay.provider is not null then
    raise exception 'Only a pending manual payment can be verified.' using errcode = 'V3015';
  end if;
  if s.four_eyes_payments and pay.created_by = v_uid then
    raise exception 'This studio requires a different person to verify the payment.' using errcode = 'V3005';
  end if;
  pay := finance_v3.record_payment_core(p_org, pay.invoice_id, pay.id, 'fin3:pay:manual:' || pay.id::text, pay.method, null, null, null,
    pay.environment, pay.amount, pay.currency, pay.received_at, pay.cash_account_id, null, pay.reference, pay.notes, v_uid, pay.idempotency_key, pay.evidence);
  perform finance_v3.try_queue_receipt_email(p_org, pay.id);
  return finance_v3.payment_json(pay);
end;
$$;

create or replace function public.fin3_reject_manual_payment(p_org uuid, p_payment uuid, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.verify_payment');
  pay   finance_v3.payments;
  v_reason text := nullif(btrim(p_reason), '');
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  if v_reason is null or char_length(v_reason) > 500 then raise exception 'A reason is required to reject a payment.' using errcode = 'V3011'; end if;
  select * into pay from finance_v3.payments x where x.organization_id = p_org and x.id = p_payment for update;
  if not found then raise exception 'Payment not found.' using errcode = 'V3010'; end if;
  if pay.verification_status = 'rejected' then return finance_v3.payment_json(pay); end if;
  if pay.verification_status <> 'pending_verification' then raise exception 'Only a pending payment can be rejected.' using errcode = 'V3015'; end if;
  update finance_v3.payments x set verification_status = 'rejected', notes = left(coalesce(x.notes || E'\n', '') || 'Rejected: ' || v_reason, 1000), updated_at = now()
   where x.organization_id = p_org and x.id = pay.id returning * into pay;
  perform finance_v3.write_audit(p_org, v_uid, 'reject_manual_payment', 'payment', pay.id::text, null, finance_v3.payment_json(pay), v_reason);
  return finance_v3.payment_json(pay);
end;
$$;

-- Reverse a recorded payment (for example a bounced transfer). The original entry is reversed, never edited or deleted.
create or replace function public.fin3_reverse_payment(p_org uuid, p_payment uuid, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.approve');
  pay   finance_v3.payments;
  v_reason text := nullif(btrim(p_reason), '');
  v_rev uuid;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  if v_reason is null or char_length(v_reason) > 500 then raise exception 'A reason is required to reverse a payment.' using errcode = 'V3011'; end if;
  select * into pay from finance_v3.payments x where x.organization_id = p_org and x.id = p_payment for update;
  if not found then raise exception 'Payment not found.' using errcode = 'V3010'; end if;
  if pay.status = 'reversed' then return finance_v3.payment_json(pay); end if;
  if pay.verification_status <> 'verified' or pay.status <> 'recorded' or pay.refunded_amount > 0
     or exists (select 1 from finance_v3.refunds f where f.organization_id = p_org and f.payment_id = pay.id and f.status in ('requested', 'approved', 'processing', 'processed')) then
    raise exception 'Only a recorded payment with no refunds can be reversed.' using errcode = 'V3017';
  end if;
  perform 1 from finance_v3.receivables x where x.organization_id = p_org and x.id = pay.invoice_id for update;
  v_rev := finance_v3.reverse_entry(p_org, pay.ledger_entry_id, 'fin3:pay:' || pay.id::text || ':reverse', v_reason, null);
  if pay.fee_entry_id is not null then
    perform finance_v3.reverse_entry(p_org, pay.fee_entry_id, 'fin3:pay:' || pay.id::text || ':reverse-fee', v_reason, null);
  end if;
  update finance_v3.payments x set status = 'reversed', reversal_entry_id = v_rev, updated_at = now()
   where x.organization_id = p_org and x.id = pay.id returning * into pay;
  update finance_v3.receipts rc set status = 'void' where rc.organization_id = p_org and rc.payment_id = pay.id;
  perform finance_v3.recompute_receivable(p_org, pay.invoice_id);
  perform finance_v3.write_audit(p_org, v_uid, 'reverse_payment', 'payment', pay.id::text, null,
    jsonb_build_object('reversal_entry_id', v_rev), v_reason);
  return finance_v3.payment_json(pay);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Payment links (opaque 256-bit tokens, stored as sha256; the plaintext is returned once). An optional fixed amount lets an
-- authorized user request a deposit or instalment; the amount is still capped by the live outstanding balance at use time.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fin3_create_payment_link(
  p_org uuid, p_invoice uuid, p_link_kind text default 'pay', p_amount text default null, p_expires_days integer default 30)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid   uuid := finance_v3.assert_permission(p_org, 'finance.collect');
  r       finance_v3.receivables;
  v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_amt   numeric;
  v_exp   timestamptz;
  l       finance_v3.public_links;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  if p_link_kind not in ('view', 'pay') then raise exception 'A link is either a view link or a pay link.' using errcode = 'V3011'; end if;
  if p_expires_days is null or p_expires_days not between 1 and 365 then raise exception 'Links expire after 1 to 365 days.' using errcode = 'V3011'; end if;
  select * into r from finance_v3.receivables x where x.organization_id = p_org and x.id = p_invoice for update;
  if not found then raise exception 'Invoice not found.' using errcode = 'V3010'; end if;
  if r.status not in ('issued', 'partially_paid', 'paid', 'credited') then
    raise exception 'Links exist only for issued invoices.' using errcode = 'V3017';
  end if;
  if p_link_kind = 'pay' then
    if r.status not in ('issued', 'partially_paid') then raise exception 'This invoice has nothing left to pay.' using errcode = 'V3017'; end if;
    if p_amount is not null then
      v_amt := finance_v3.parse_money(p_amount, 'Link amount', r.currency, false);
      if v_amt > r.outstanding then
        raise exception 'The link amount is more than the outstanding balance.' using errcode = 'V3012';
      end if;
    end if;
  elsif p_amount is not null then
    raise exception 'A view link has no amount.' using errcode = 'V3011';
  end if;
  update finance_v3.public_links x set revoked_at = now()
   where x.organization_id = p_org and x.invoice_id = r.id and x.kind = p_link_kind and x.revoked_at is null;
  v_exp := now() + make_interval(days => p_expires_days);
  insert into finance_v3.public_links (organization_id, invoice_id, kind, token_hash, amount, expires_at, created_by)
  values (p_org, r.id, p_link_kind, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), v_amt, v_exp, v_uid)
  returning * into l;
  perform finance_v3.write_audit(p_org, v_uid, 'create_' || p_link_kind || '_link', 'receivable', r.id::text, null,
    jsonb_build_object('link_id', l.id, 'expires_at', v_exp), null);
  return jsonb_build_object('link_id', l.id, 'kind', p_link_kind, 'token', v_token, 'expires_at', v_exp);
end;
$$;

create or replace function public.fin3_revoke_links(p_org uuid, p_invoice uuid)
returns integer
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.collect');
  n integer;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  update finance_v3.public_links x set revoked_at = now() where x.organization_id = p_org and x.invoice_id = p_invoice and x.revoked_at is null;
  get diagnostics n = row_count;
  perform finance_v3.write_audit(p_org, v_uid, 'revoke_links', 'receivable', p_invoice::text, null, jsonb_build_object('revoked', n), null);
  return n;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- SERVICE: resolve a public link (view page) and prepare a payment intent (pay link). The token hash is the only credential.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fin3svc_resolve_link(p_token_hash text)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  l finance_v3.public_links;
  r finance_v3.receivables;
begin
  select * into l from finance_v3.public_links x where x.token_hash = p_token_hash;
  if not found or l.revoked_at is not null or l.expires_at <= now() then return null; end if;
  select * into r from finance_v3.receivables x where x.organization_id = l.organization_id and x.id = l.invoice_id;
  if r.status = 'void' then return null; end if;
  return jsonb_build_object('kind', l.kind, 'organization_id', l.organization_id, 'invoice_id', r.id, 'invoice_no', r.invoice_no,
    'status', r.status, 'currency', r.currency, 'total', finance_v3.money_text(r.total, r.currency),
    'outstanding', finance_v3.money_text(r.outstanding, r.currency), 'due_date', r.due_date, 'snapshot', r.snapshot,
    'payable', r.status in ('issued', 'partially_paid') and r.outstanding > 0);
end;
$$;

create or replace function public.fin3svc_prepare_intent(p_token_hash text, p_environment text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  l       finance_v3.public_links;
  r       finance_v3.receivables;
  s       finance_v3.org_settings;
  c       finance_v3.contacts_v3;
  i       finance_v3.payment_intents;
  v_amt   numeric;
  v_minor integer;
  v_ref   text;
  v_try   integer := 0;
begin
  if p_environment not in ('test', 'live') then raise exception 'Unknown payment environment.' using errcode = 'V3011'; end if;
  select * into l from finance_v3.public_links x where x.token_hash = p_token_hash;
  if not found or l.kind <> 'pay' or l.revoked_at is not null or l.expires_at <= now() then
    raise exception 'This payment link is not valid or has expired.' using errcode = 'V3010';
  end if;
  perform finance_v3.lock_org(l.organization_id);
  select * into s from finance_v3.org_settings where organization_id = l.organization_id;
  select * into r from finance_v3.receivables x where x.organization_id = l.organization_id and x.id = l.invoice_id for update;
  if r.status not in ('issued', 'partially_paid') or r.outstanding <= 0 then
    raise exception 'This invoice has nothing left to pay.' using errcode = 'V3017';
  end if;
  if p_environment = 'test' and not s.is_sandbox then
    raise exception 'Test payments are not allowed for this studio.' using errcode = 'V3019';
  end if;
  if not (r.currency = any (s.collect_currencies)) then
    raise exception 'Online payment is not enabled for %.', r.currency using errcode = 'V3011';
  end if;
  select * into c from finance_v3.contacts_v3 x where x.organization_id = r.organization_id and x.id = r.client_id;
  if c.email is null then raise exception 'The client has no email address for the payment provider.' using errcode = 'V3018'; end if;
  v_amt := least(coalesce(l.amount, r.outstanding), r.outstanding);
  v_minor := finance_v3.minor_unit(r.currency)::integer;

  select * into i from finance_v3.payment_intents x where x.invoice_id = r.id and x.status in ('created', 'initialized', 'pending') for update;
  if found then
    if i.environment = p_environment and i.invoice_amount = v_amt and (i.link_expires_at is null or i.link_expires_at > now()) then
      return jsonb_build_object('intent_id', i.id, 'organization_id', i.organization_id, 'reference', i.provider_reference,
        'charge_amount_minor', i.charge_amount_minor::text, 'currency', i.charge_currency, 'customer_email', c.email,
        'environment', i.environment, 'status', i.status, 'authorization_url', i.authorization_url, 'reused', true);
    end if;
    update finance_v3.payment_intents x set status = 'cancelled', updated_at = now() where x.id = i.id;
  end if;

  loop
    v_ref := finance_v3.new_payment_reference(p_environment);
    exit when not exists (select 1 from finance_v3.payment_intents x where x.provider = 'paystack' and x.provider_reference = v_ref);
    v_try := v_try + 1;
    if v_try > 5 then raise exception 'Could not generate a unique payment reference.' using errcode = 'V3011'; end if;
  end loop;
  insert into finance_v3.payment_intents (organization_id, invoice_id, client_id, link_id, provider, environment, provider_reference,
    invoice_amount, invoice_currency, charge_amount_minor, charge_currency, link_expires_at, created_by)
  values (r.organization_id, r.id, r.client_id, l.id, 'paystack', p_environment, v_ref, v_amt, r.currency,
    round(v_amt * power(10, v_minor))::bigint, r.currency, now() + interval '24 hours', null)
  returning * into i;
  perform finance_v3.write_audit(i.organization_id, null, 'create_payment_intent', 'payment_intent', i.id::text, null,
    jsonb_build_object('invoice_id', r.id, 'amount', finance_v3.money_text(v_amt, r.currency), 'reference', v_ref, 'environment', p_environment), null);
  return jsonb_build_object('intent_id', i.id, 'organization_id', i.organization_id, 'reference', v_ref,
    'charge_amount_minor', i.charge_amount_minor::text, 'currency', i.charge_currency, 'customer_email', c.email,
    'environment', p_environment, 'status', i.status, 'authorization_url', null, 'reused', false);
end;
$$;

create or replace function public.fin3svc_intent_initialized(p_intent uuid, p_authorization_url text)
returns void
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  if p_authorization_url is null or p_authorization_url !~ '^https://' then
    raise exception 'The provider checkout address is not valid.' using errcode = 'V3011';
  end if;
  update finance_v3.payment_intents i set status = 'initialized', authorization_url = p_authorization_url, updated_at = now()
   where i.id = p_intent and i.status in ('created', 'initialized');
end;
$$;

-- Authorized user: create (or reuse) a payment intent for an invoice directly (the Edge Function then initializes it).
create or replace function public.fin3_get_intent_for_invoice(p_org uuid, p_invoice uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  perform finance_v3.assert_permission(p_org, 'finance.view_integrations');
  perform finance_v3.assert_org_ready(p_org);
  return coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'reference', i.provider_reference, 'status', i.status,
      'environment', i.environment, 'amount', finance_v3.money_text(i.invoice_amount, i.invoice_currency), 'currency', i.invoice_currency,
      'review_reason', i.review_reason, 'payment_id', i.payment_id, 'created_at', i.created_at) order by i.created_at desc)
    from finance_v3.payment_intents i where i.organization_id = p_org and i.invoice_id = p_invoice), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- SERVICE: provider event intake (idempotency point) and intent lookup for the webhook handler
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fin3svc_record_provider_event(
  p_provider text, p_environment text, p_event_key text, p_event_type text, p_reference text, p_payload jsonb)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  e finance_v3.provider_events;
  i finance_v3.payment_intents;
begin
  select * into i from finance_v3.payment_intents x where x.provider = p_provider and x.provider_reference = p_reference;
  insert into finance_v3.provider_events (organization_id, provider, environment, event_key, event_type, provider_reference, payment_intent_id, payload_sanitised)
  values (i.organization_id, p_provider, p_environment, p_event_key, p_event_type, p_reference, i.id, coalesce(p_payload, '{}'::jsonb))
  on conflict (provider, event_key) do nothing
  returning * into e;
  if e.id is not null then
    return jsonb_build_object('id', e.id, 'status', e.status, 'duplicate', false, 'attempts', 1);
  end if;
  update finance_v3.provider_events x set attempts = x.attempts + 1
   where x.provider = p_provider and x.event_key = p_event_key returning * into e;
  return jsonb_build_object('id', e.id, 'status', e.status, 'attempts', e.attempts,
    'duplicate', e.status in ('processed', 'ignored', 'needs_review'));
end;
$$;

create or replace function public.fin3svc_finish_provider_event(p_event uuid, p_status text, p_error text)
returns void
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  if p_status not in ('processing', 'processed', 'ignored', 'failed', 'needs_review', 'exhausted') then
    raise exception 'Unknown event status.' using errcode = 'V3011';
  end if;
  update finance_v3.provider_events e set status = p_status, error = left(p_error, 500), processed_at = now()
   where e.id = p_event and e.status not in ('processed');
end;
$$;

create or replace function public.fin3svc_get_intent(p_provider text, p_reference text)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare i finance_v3.payment_intents;
begin
  select * into i from finance_v3.payment_intents x where x.provider = p_provider and x.provider_reference = p_reference;
  if not found then return null; end if;
  return jsonb_build_object('intent_id', i.id, 'organization_id', i.organization_id, 'invoice_id', i.invoice_id, 'status', i.status,
    'environment', i.environment, 'charge_amount_minor', i.charge_amount_minor::text, 'currency', i.charge_currency, 'payment_id', i.payment_id);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- settle_intent: turns VERIFIED provider facts stored on an intent into a recorded payment. Never raises for permanent
-- business conditions (they become needs_review with the facts kept, so the customer never pays twice); re-raises everything
-- that is not a V3xxx business error (deadlocks etc.) so the caller can retry.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.settle_intent(p_intent uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  i       finance_v3.payment_intents;
  s       finance_v3.org_settings;
  r       finance_v3.receivables;
  pay     finance_v3.payments;
  v_reason text;
  v_method text;
  v_fee   numeric;
  v_minor integer;
  v_clear uuid;
begin
  select * into i from finance_v3.payment_intents x where x.id = p_intent;
  if not found then raise exception 'Payment attempt not found.' using errcode = 'V3010'; end if;
  perform finance_v3.lock_org(i.organization_id);
  select * into r from finance_v3.receivables x where x.organization_id = i.organization_id and x.id = i.invoice_id for update;
  select * into i from finance_v3.payment_intents x where x.id = p_intent for update;
  select * into s from finance_v3.org_settings where organization_id = i.organization_id;

  if i.status = 'succeeded' then
    return jsonb_build_object('outcome', 'duplicate', 'payment_id', i.payment_id);
  end if;
  select * into pay from finance_v3.payments x where x.organization_id = i.organization_id and x.provider = i.provider and x.provider_reference = i.provider_reference;
  if found then
    update finance_v3.payment_intents x set status = 'succeeded', payment_id = pay.id, updated_at = now() where x.id = i.id;
    return jsonb_build_object('outcome', 'duplicate', 'payment_id', pay.id);
  end if;

  v_minor := finance_v3.minor_unit(i.charge_currency)::integer;
  if i.verified_amount_minor is null or i.verified_currency is null then
    v_reason := 'Verified provider facts are missing.';
  elsif i.environment = 'test' and not s.is_sandbox then
    v_reason := 'A test payment cannot be settled for a live studio.';
  elsif i.verified_amount_minor <> i.charge_amount_minor or i.verified_currency <> i.charge_currency then
    v_reason := 'The verified amount or currency differs from the payment attempt.';
  elsif r.status = 'void' then
    v_reason := 'The invoice was voided before the payment arrived. The money must be refunded.';
  elsif r.status not in ('issued', 'partially_paid') then
    v_reason := 'The invoice is already settled (' || r.status || '). The payment may be an overpayment.';
  elsif i.invoice_amount > r.outstanding then
    v_reason := 'The payment is larger than the invoice balance now outstanding (overpayment).';
  end if;

  if v_reason is null then
    begin
      v_clear := finance_v3.system_account(i.organization_id, 'payment_clearing');
      v_method := case when i.verified_channel in ('card', 'apple_pay') then i.verified_channel else 'other' end;
      v_fee := case when i.verified_fee_minor is null then null else i.verified_fee_minor::numeric / power(10, v_minor) end;
      pay := finance_v3.record_payment_core(i.organization_id, i.invoice_id, null, 'fin3:pay:' || i.provider || ':' || i.provider_reference,
        v_method, i.provider, i.provider_reference, i.provider_transaction_id, i.environment, i.invoice_amount, i.invoice_currency,
        coalesce(i.verified_paid_at, now()), v_clear, v_fee, null, null, null, 'fin3:pay:' || i.provider || ':' || i.provider_reference, '[]'::jsonb);
    exception when others then
      if sqlstate !~ '^V3' then raise; end if;
      v_reason := 'The ledger could not post the payment: ' || sqlerrm;
    end;
  end if;

  if v_reason is not null then
    update finance_v3.payment_intents x set status = 'needs_review', review_reason = left(v_reason, 500), updated_at = now() where x.id = i.id;
    perform finance_v3.write_audit(i.organization_id, null, 'payment_needs_review', 'payment_intent', i.id::text, null,
      jsonb_build_object('reference', i.provider_reference), left(v_reason, 500));
    return jsonb_build_object('outcome', 'needs_review', 'reason', v_reason);
  end if;

  update finance_v3.payment_intents x set status = 'succeeded', payment_id = pay.id, review_reason = null, updated_at = now() where x.id = i.id;
  perform finance_v3.try_queue_receipt_email(i.organization_id, pay.id);
  return jsonb_build_object('outcome', 'recorded', 'payment_id', pay.id);
end;
$$;

-- SERVICE: the Edge Function has verified the transaction with the provider and passes only the verified facts.
create or replace function public.fin3svc_settle_payment(
  p_provider text, p_reference text, p_provider_txn text, p_amount_minor bigint, p_currency text, p_environment text,
  p_paid_at timestamptz, p_fee_minor bigint, p_channel text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare i finance_v3.payment_intents;
begin
  select * into i from finance_v3.payment_intents x where x.provider = p_provider and x.provider_reference = p_reference;
  if not found then
    return jsonb_build_object('outcome', 'unknown_reference');
  end if;
  if i.environment <> p_environment then
    return jsonb_build_object('outcome', 'needs_review', 'reason', 'The event environment differs from the payment attempt.');
  end if;
  update finance_v3.payment_intents x set verified_amount_minor = p_amount_minor, verified_currency = upper(p_currency),
         provider_transaction_id = p_provider_txn, verified_paid_at = p_paid_at, verified_fee_minor = p_fee_minor,
         verified_channel = p_channel, updated_at = now()
   where x.id = i.id and x.status <> 'succeeded';
  return finance_v3.settle_intent(i.id);
end;
$$;

-- SERVICE: non-success outcomes. Never downgrades a settled payment.
create or replace function public.fin3svc_apply_payment_status(p_provider text, p_reference text, p_outcome text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  i finance_v3.payment_intents;
  v_status text;
begin
  v_status := case p_outcome when 'failed' then 'failed' when 'abandoned' then 'abandoned' when 'pending' then 'pending' when 'reversed' then 'failed' else null end;
  if v_status is null then raise exception 'Unknown outcome.' using errcode = 'V3011'; end if;
  select * into i from finance_v3.payment_intents x where x.provider = p_provider and x.provider_reference = p_reference;
  if not found then return jsonb_build_object('outcome', 'unknown_reference'); end if;
  perform finance_v3.lock_org(i.organization_id);
  update finance_v3.payment_intents x set status = v_status, updated_at = now()
   where x.id = i.id and x.status in ('created', 'initialized', 'pending');
  return jsonb_build_object('outcome', 'updated', 'status', v_status);
end;
$$;

-- Authorized retry of a verified-but-unposted payment (needs_review with facts kept). The customer is never asked to pay again.
create or replace function public.fin3_retry_intent_posting(p_org uuid, p_intent uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.verify_payment');
  i finance_v3.payment_intents;
begin
  perform finance_v3.assert_org_ready(p_org);
  select * into i from finance_v3.payment_intents x where x.organization_id = p_org and x.id = p_intent;
  if not found then raise exception 'Payment attempt not found.' using errcode = 'V3010'; end if;
  if i.status <> 'needs_review' or i.verified_amount_minor is null then
    raise exception 'Only a verified payment that needs review can be retried.' using errcode = 'V3015';
  end if;
  update finance_v3.payment_intents x set status = 'pending', updated_at = now() where x.id = i.id;
  perform finance_v3.write_audit(p_org, v_uid, 'retry_intent_posting', 'payment_intent', i.id::text, null, null, null);
  return finance_v3.settle_intent(i.id);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Refunds: a separate financial event with its own audit trail. Dr Accounts Receivable (the invoice balance is reinstated)
-- / Cr the account that received the money. The original payment is never voided or deleted.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.refund_json(f finance_v3.refunds)
returns jsonb
language sql stable
set search_path = pg_catalog, finance_v3
as $$
  select jsonb_build_object('id', f.id, 'refund_no', f.refund_no, 'payment_id', f.payment_id, 'invoice_id', f.invoice_id,
    'amount', finance_v3.money_text(f.amount, f.currency), 'currency', f.currency, 'reason', f.reason, 'status', f.status,
    'provider', f.provider, 'provider_refund_reference', f.provider_refund_reference, 'processed_at', f.processed_at, 'ledger_entry_id', f.ledger_entry_id);
$$;

create or replace function public.fin3_request_refund(p_org uuid, p_key text, p_payment uuid, p_amount text, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.collect');
  pay   finance_v3.payments;
  f     finance_v3.refunds;
  v_amt numeric;
  v_open numeric;
  v_reason text := nullif(btrim(p_reason), '');
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  if p_key is null or char_length(p_key) not between 1 and 200 or p_key !~ '^[A-Za-z0-9_.:-]+$' then raise exception 'A valid idempotency key is required.' using errcode = 'V3011'; end if;
  select * into f from finance_v3.refunds x where x.organization_id = p_org and x.idempotency_key = p_key;
  if found then return finance_v3.refund_json(f); end if;
  if v_reason is null or char_length(v_reason) > 500 then raise exception 'A reason is required for a refund.' using errcode = 'V3011'; end if;
  select * into pay from finance_v3.payments x where x.organization_id = p_org and x.id = p_payment for update;
  if not found then raise exception 'Payment not found.' using errcode = 'V3010'; end if;
  if pay.verification_status <> 'verified' or pay.status not in ('recorded', 'partially_refunded') then
    raise exception 'Only a recorded payment can be refunded.' using errcode = 'V3017';
  end if;
  v_amt := finance_v3.parse_money(p_amount, 'Refund amount', pay.currency, false);
  select coalesce(sum(x.amount), 0) into v_open from finance_v3.refunds x
   where x.organization_id = p_org and x.payment_id = pay.id and x.status in ('requested', 'approved', 'processing');
  if v_amt > pay.amount - pay.refunded_amount - v_open then
    raise exception 'The refund is more than what can still be refunded on this payment.' using errcode = 'V3012';
  end if;
  insert into finance_v3.refunds (organization_id, payment_id, invoice_id, refund_no, amount, currency, reason, requested_by, idempotency_key, provider)
  values (p_org, pay.id, pay.invoice_id, finance_v3.next_doc_number(p_org, 'refund'), v_amt, pay.currency, v_reason, v_uid, p_key, pay.provider)
  returning * into f;
  perform finance_v3.write_audit(p_org, v_uid, 'request_refund', 'refund', f.id::text, null, finance_v3.refund_json(f), v_reason);
  return finance_v3.refund_json(f);
end;
$$;

create or replace function public.fin3_approve_refund(p_org uuid, p_refund uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.refund');
  s     finance_v3.org_settings;
  f     finance_v3.refunds;
begin
  s := finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  select * into f from finance_v3.refunds x where x.organization_id = p_org and x.id = p_refund for update;
  if not found then raise exception 'Refund not found.' using errcode = 'V3010'; end if;
  if f.status = 'approved' then return finance_v3.refund_json(f); end if;
  if f.status <> 'requested' then raise exception 'Only a requested refund can be approved.' using errcode = 'V3017'; end if;
  if s.four_eyes_payments and f.requested_by = v_uid then
    raise exception 'This studio requires a different person to approve the refund.' using errcode = 'V3005';
  end if;
  update finance_v3.refunds x set status = 'approved', approved_by = v_uid, updated_at = now() where x.id = f.id returning * into f;
  perform finance_v3.write_audit(p_org, v_uid, 'approve_refund', 'refund', f.id::text, null, finance_v3.refund_json(f), null);
  return finance_v3.refund_json(f);
end;
$$;

create or replace function public.fin3_reject_refund(p_org uuid, p_refund uuid, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.refund');
  f     finance_v3.refunds;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  select * into f from finance_v3.refunds x where x.organization_id = p_org and x.id = p_refund for update;
  if not found then raise exception 'Refund not found.' using errcode = 'V3010'; end if;
  if f.status = 'rejected' then return finance_v3.refund_json(f); end if;
  if f.status not in ('requested', 'approved') then raise exception 'Only an open refund can be rejected.' using errcode = 'V3017'; end if;
  update finance_v3.refunds x set status = 'rejected', updated_at = now() where x.id = f.id returning * into f;
  perform finance_v3.write_audit(p_org, v_uid, 'reject_refund', 'refund', f.id::text, null, finance_v3.refund_json(f), nullif(btrim(p_reason), ''));
  return finance_v3.refund_json(f);
end;
$$;

-- Shared by the manual "record refund" RPC and the provider refund event: posts the refund and updates the payment and invoice.
create or replace function finance_v3.finalize_refund(p_refund uuid, p_actor uuid, p_provider text, p_provider_ref text, p_date date)
returns finance_v3.refunds
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  f      finance_v3.refunds;
  pay    finance_v3.payments;
  r      finance_v3.receivables;
  v_entry uuid;
  v_ar   uuid;
  v_key  text;
begin
  select * into f from finance_v3.refunds x where x.id = p_refund for update;
  if f.status = 'processed' then return f; end if;
  select * into r from finance_v3.receivables x where x.organization_id = f.organization_id and x.id = f.invoice_id for update;
  select * into pay from finance_v3.payments x where x.organization_id = f.organization_id and x.id = f.payment_id for update;
  if pay.amount - pay.refunded_amount < f.amount then
    raise exception 'The refund is more than what remains refundable on the payment.' using errcode = 'V3012';
  end if;
  v_ar := finance_v3.system_account(f.organization_id, 'accounts_receivable');
  v_key := 'fin3:refund:' || f.id::text;
  v_entry := finance_v3.post_event(f.organization_id, 'refund_issued', v_key, p_date,
    jsonb_build_array(
      jsonb_build_object('account_id', v_ar, 'side', 'debit', 'amount', finance_v3.money_text(f.amount, f.currency), 'currency', f.currency),
      jsonb_build_object('account_id', pay.cash_account_id, 'side', 'credit', 'amount', finance_v3.money_text(f.amount, f.currency), 'currency', f.currency)),
    jsonb_strip_nulls(jsonb_build_object('memo', left('Refund ' || f.refund_no || ' for invoice ' || r.invoice_no, 500), 'reference', f.refund_no,
                                         'project_id', r.project_id, 'provider', p_provider, 'provider_ref', p_provider_ref)));
  update finance_v3.refunds x set status = 'processed', processed_by = p_actor, processed_at = now(), ledger_entry_id = v_entry, updated_at = now()
   where x.id = f.id returning * into f;
  update finance_v3.payments x set refunded_amount = x.refunded_amount + f.amount,
         status = case when x.refunded_amount + f.amount >= x.amount then 'refunded' else 'partially_refunded' end, updated_at = now()
   where x.organization_id = f.organization_id and x.id = f.payment_id;
  perform finance_v3.recompute_receivable(f.organization_id, f.invoice_id);
  perform finance_v3.write_audit(f.organization_id, p_actor, 'record_refund', 'refund', f.id::text, null,
    jsonb_build_object('refund_no', f.refund_no, 'entry_id', v_entry), null);
  return f;
end;
$$;

-- Record a refund that was made outside the system (bank transfer back, provider dashboard). Nothing here moves money.
create or replace function public.fin3_record_refund(p_org uuid, p_refund uuid, p_date date, p_reference text default null)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.refund');
  f     finance_v3.refunds;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  select * into f from finance_v3.refunds x where x.organization_id = p_org and x.id = p_refund for update;
  if not found then raise exception 'Refund not found.' using errcode = 'V3010'; end if;
  if f.status = 'processed' then return finance_v3.refund_json(f); end if;
  if f.status <> 'approved' then raise exception 'A refund must be approved before it is recorded.' using errcode = 'V3017'; end if;
  if p_date is null then raise exception 'The refund date is required.' using errcode = 'V3011'; end if;
  f := finance_v3.finalize_refund(f.id, v_uid, null, null, p_date);
  begin
    perform finance_v3.queue_refund_email(p_org, f.id);
  exception when others then
    perform finance_v3.write_audit(p_org, v_uid, 'refund_email_queue_failed', 'refund', f.id::text, null, jsonb_build_object('sqlstate', sqlstate), left(sqlerrm, 300));
  end;
  return finance_v3.refund_json(f);
end;
$$;

-- SERVICE: Paystack refund.* events for a V3 reference. Returns outcome 'retry' when the charge has not been settled yet.
create or replace function public.fin3svc_apply_refund_event(
  p_provider text, p_reference text, p_refund_ref text, p_amount_minor bigint, p_currency text, p_status text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  pay   finance_v3.payments;
  f     finance_v3.refunds;
  v_amt numeric;
  v_minor integer;
begin
  if p_status not in ('pending', 'processing', 'processed', 'failed') then raise exception 'Unknown refund status.' using errcode = 'V3011'; end if;
  select * into pay from finance_v3.payments x where x.provider = p_provider and x.provider_reference = p_reference;
  if not found then return jsonb_build_object('outcome', 'retry'); end if;
  perform finance_v3.lock_org(pay.organization_id);
  if upper(p_currency) <> pay.currency then
    return jsonb_build_object('outcome', 'needs_review', 'reason', 'Refund currency differs from the payment.');
  end if;
  v_minor := finance_v3.minor_unit(pay.currency)::integer;
  v_amt := p_amount_minor::numeric / power(10, v_minor);
  select * into f from finance_v3.refunds x where x.organization_id = pay.organization_id and x.provider = p_provider and x.provider_refund_reference = p_refund_ref;
  if not found then
    if v_amt <= 0 or v_amt > pay.amount - pay.refunded_amount then
      return jsonb_build_object('outcome', 'needs_review', 'reason', 'The refund amount is not valid for this payment.');
    end if;
    insert into finance_v3.refunds (organization_id, payment_id, invoice_id, refund_no, amount, currency, reason, status, provider,
      provider_refund_reference, idempotency_key)
    values (pay.organization_id, pay.id, pay.invoice_id, finance_v3.next_doc_number(pay.organization_id, 'refund'), v_amt, pay.currency,
      'Refund reported by the payment provider', 'processing', p_provider, p_refund_ref, 'fin3:refund:' || p_provider || ':' || p_refund_ref)
    returning * into f;
  end if;
  if f.status = 'processed' then return jsonb_build_object('outcome', 'duplicate', 'refund_id', f.id); end if;
  if p_status = 'failed' then
    update finance_v3.refunds x set status = 'failed', updated_at = now() where x.id = f.id;
    return jsonb_build_object('outcome', 'updated', 'status', 'failed');
  elsif p_status in ('pending', 'processing') then
    update finance_v3.refunds x set status = 'processing', updated_at = now() where x.id = f.id and x.status in ('requested', 'approved', 'processing');
    return jsonb_build_object('outcome', 'updated', 'status', 'processing');
  end if;
  if v_amt <> f.amount then
    return jsonb_build_object('outcome', 'needs_review', 'reason', 'The processed refund amount differs from the recorded refund.');
  end if;
  f := finance_v3.finalize_refund(f.id, null, p_provider, p_refund_ref, current_date);
  begin
    perform finance_v3.queue_refund_email(pay.organization_id, f.id);
  exception when others then
    perform finance_v3.write_audit(pay.organization_id, null, 'refund_email_queue_failed', 'refund', f.id::text, null, jsonb_build_object('sqlstate', sqlstate), left(sqlerrm, 300));
  end;
  return jsonb_build_object('outcome', 'recorded', 'refund_id', f.id);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------------------------------------------
-- SERVICE: the frozen, human-facing snapshot used to render PDFs (invoice: receivables.snapshot; receipt: receipts.snapshot).
create or replace function public.fin3svc_get_snapshot(p_org uuid, p_kind text, p_entity uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare v jsonb;
begin
  if p_kind = 'invoice' then
    select r.snapshot into v from finance_v3.receivables r where r.organization_id = p_org and r.id = p_entity and r.status not in ('draft', 'approved');
  elsif p_kind = 'receipt' then
    select x.snapshot into v from finance_v3.receipts x where x.organization_id = p_org and x.id = p_entity;
  else
    raise exception 'Unknown snapshot kind.' using errcode = 'V3011';
  end if;
  return v;
end;
$$;

create or replace function public.fin3_get_receipt(p_org uuid, p_receipt uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare x finance_v3.receipts;
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  select * into x from finance_v3.receipts r where r.organization_id = p_org and r.id = p_receipt;
  if not found then raise exception 'Receipt not found.' using errcode = 'V3010'; end if;
  return jsonb_build_object('id', x.id, 'payment_id', x.payment_id, 'invoice_id', x.invoice_id, 'receipt_no', x.receipt_no,
    'status', x.status, 'issued_at', x.issued_at, 'snapshot', x.snapshot);
end;
$$;

create or replace function public.fin3_list_payments(p_org uuid, p_status text default null, p_limit integer default 100)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  return coalesce((select jsonb_agg(finance_v3.payment_json(p) order by p.received_at desc, p.id desc)
    from (select * from finance_v3.payments x where x.organization_id = p_org and (p_status is null or x.verification_status = p_status)
           order by x.received_at desc, x.id desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) p), '[]'::jsonb);
end;
$$;

create or replace function public.fin3_list_refunds(p_org uuid, p_payment uuid default null)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  return coalesce((select jsonb_agg(finance_v3.refund_json(f) order by f.created_at desc, f.id desc)
    from finance_v3.refunds f where f.organization_id = p_org and (p_payment is null or f.payment_id = p_payment)), '[]'::jsonb);
end;
$$;

create or replace function public.fin3_list_provider_events(p_org uuid, p_status text default null, p_limit integer default 100)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  perform finance_v3.assert_permission(p_org, 'finance.view_integrations');
  perform finance_v3.assert_org_ready(p_org);
  return coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'provider', e.provider, 'environment', e.environment,
      'event_type', e.event_type, 'reference', e.provider_reference, 'status', e.status, 'attempts', e.attempts, 'error', e.error,
      'received_at', e.received_at, 'processed_at', e.processed_at) order by e.received_at desc, e.id desc)
    from (select * from finance_v3.provider_events x where x.organization_id = p_org and (p_status is null or x.status = p_status)
           order by x.received_at desc, x.id desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) e), '[]'::jsonb);
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
