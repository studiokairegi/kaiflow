-- =============================================================================
-- Payments module: Paystack SANDBOX (test mode) + freelancer payout workflow
-- =============================================================================
-- SANDBOX ONLY. Structural guarantees in this file:
--   * paystack_transactions.environment is CHECK (= 'test'): a live record cannot exist.
--   * freelancer_payout_requests.is_simulated is CHECK (= true): there is no column,
--     status or function that represents a real bank transfer. Payouts are
--     "SIMULATED - NO MONEY TRANSFERRED".
--
-- REUSES (does not duplicate) Finance v2:
--   invoices / invoice_payments / journal_entries  <- money received (finance_settle)
--   expenses                                       <- Paystack fees (existing expense trigger posts the ledger entry)
--   bills / bill_payments / team_members           <- what is owed to freelancers (the obligation)
--   finance_audit_log                              <- audit trail (via finance_audit)
--
-- ADDS only what Finance does not have:
--   paystack_transactions       one row per payment ATTEMPT (gateway facts, fees, settlement, reconciliation)
--   paystack_webhook_events     de-duplicated event log with processing status
--   freelancer_payout_requests  payment ATTEMPTS against a bill; failure never erases the bill
--
-- ACCOUNTING ASSUMPTIONS (also in the delivery report)
--   1. A verified charge posts GROSS to the invoice (Dr bank/cash, Cr A/R) through finance_settle.
--   2. The ACTUAL fee reported by Paystack is recorded once, as an expense in the category
--      'Payment processing fees' (ledger account 6900 Other Operating Expenses), credited to the
--      same bank/cash account. Net receipt = gross - fee. Gross is never labelled net income.
--   3. A full refund voids the invoice payment (invoice becomes unpaid again). The fee expense is
--      kept because Paystack does not return fees on refunds. A partial refund is recorded on the
--      transaction and flagged for manual adjustment.
--   4. Simulated payouts never post to the ledger and never reduce what is owed. What is owed is
--      always the bill's outstanding balance in Finance.
--
-- Idempotent: safe to re-run.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table if not exists paystack_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  environment text not null default 'test' check (environment = 'test'),
  reference text not null unique,
  invoice_id uuid references invoices(id) on delete set null,
  invoice_number text not null default '',
  project_id uuid references projects(id) on delete set null,
  client_name text not null default '',
  customer_email text not null default '',
  amount numeric not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'initialized'
    check (status in ('initialized','pending','success','failed','abandoned','refunded','partially_refunded')),
  authorization_url text,
  access_code text,
  paystack_id text,
  channel text not null default '',
  fee_actual numeric check (fee_actual is null or fee_actual >= 0),
  fee_estimated numeric check (fee_estimated is null or fee_estimated >= 0),  -- never filled by this module; kept separate on purpose
  net_amount numeric,
  gateway_response text not null default '',
  paid_at timestamptz,
  verified_at timestamptz,
  settlement_status text not null default 'unknown' check (settlement_status in ('unknown','pending','settled')),
  settlement_reference text,
  refunded_amount numeric not null default 0 check (refunded_amount >= 0),
  refund_refs text[] not null default '{}',
  invoice_payment_id uuid references invoice_payments(id) on delete set null,
  fee_expense_id uuid references expenses(id) on delete set null,
  apply_status text not null default 'none' check (apply_status in ('none','applied','failed')),
  apply_error text not null default '',
  reconciliation_status text not null default 'unreconciled' check (reconciliation_status in ('unreconciled','matched','needs_review')),
  reconciled_at timestamptz,
  reconciliation_note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists paystack_tx_user_created_idx on paystack_transactions(user_id, created_at desc);
create index if not exists paystack_tx_invoice_idx on paystack_transactions(invoice_id);
-- A ledger payment can belong to at most one gateway transaction: this is the hard stop on double counting.
create unique index if not exists paystack_tx_invoice_payment_uidx on paystack_transactions(invoice_payment_id) where invoice_payment_id is not null;
create unique index if not exists paystack_tx_fee_expense_uidx on paystack_transactions(fee_expense_id) where fee_expense_id is not null;

create table if not exists paystack_webhook_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  event_key text not null unique,
  event text not null,
  reference text,
  transaction_id uuid references paystack_transactions(id) on delete set null,
  status text not null default 'received' check (status in ('received','processed','ignored','failed')),
  attempts int not null default 1,
  error text not null default '',
  payload jsonb,   -- sanitised by the Edge Function: no customer, card or authorization objects
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists paystack_events_user_idx on paystack_webhook_events(user_id, received_at desc);

create table if not exists freelancer_payout_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  team_member_id uuid references team_members(id) on delete set null,
  bill_id uuid not null references bills(id) on delete restrict,
  project_id uuid references projects(id) on delete set null,
  amount numeric not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'pending_approval'
    check (status in ('pending_approval','approved','simulated_initiated','completed_simulated','failed','cancelled')),
  is_simulated boolean not null default true check (is_simulated),   -- no real transfers exist in this module
  note text not null default '',
  request_ref text not null default '',
  simulation_ref text,
  approved_at timestamptz,
  approved_by uuid,
  simulated_at timestamptz,
  completed_at timestamptz,
  failure_reason text not null default '',
  cancelled_reason text not null default '',
  reconciled boolean not null default false,
  reconciled_at timestamptz,
  bill_payment_id uuid references bill_payments(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists payout_req_user_idx on freelancer_payout_requests(user_id, created_at desc);
create index if not exists payout_req_bill_idx on freelancer_payout_requests(bill_id);
create unique index if not exists payout_req_bill_payment_uidx on freelancer_payout_requests(bill_payment_id) where bill_payment_id is not null;

-- ---------------------------------------------------------------------------
-- RLS: owners can READ their rows. All writes go through the functions below.
-- ---------------------------------------------------------------------------
alter table paystack_transactions enable row level security;
alter table paystack_webhook_events enable row level security;
alter table freelancer_payout_requests enable row level security;

drop policy if exists "Users read their own paystack transactions" on paystack_transactions;
create policy "Users read their own paystack transactions" on paystack_transactions for select using (auth.uid() = user_id);
drop policy if exists "Users read their own paystack events" on paystack_webhook_events;
create policy "Users read their own paystack events" on paystack_webhook_events for select using (auth.uid() = user_id);
drop policy if exists "Users read their own payout requests" on freelancer_payout_requests;
create policy "Users read their own payout requests" on freelancer_payout_requests for select using (auth.uid() = user_id);

revoke insert, update, delete, truncate on paystack_transactions from anon, authenticated;
revoke insert, update, delete, truncate on paystack_webhook_events from anon, authenticated;
revoke insert, update, delete, truncate on freelancer_payout_requests from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Incoming: prepare a checkout (called by the user via the Edge Function, with their JWT)
-- The AMOUNT AND CURRENCY ARE DERIVED HERE from the invoice. Nothing is taken from the browser
-- except an optional partial amount, which is only ever validated down, never trusted up.
-- ---------------------------------------------------------------------------
create or replace function public.payments_invoice_outstanding(p_invoice uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select i.amount - coalesce((select sum(p.amount) from invoice_payments p where p.invoice_id = i.id and p.status = 'posted'), 0)
  from invoices i where i.id = p_invoice
$$;

create or replace function public.payments_prepare_charge(p_invoice uuid, p_amount numeric, p_email text)
returns table (transaction_id uuid, reference text, amount numeric, currency text, reused boolean, authorization_url text)
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := finance_require_user();
  inv invoices%rowtype; v_ccy text; v_out numeric; v_amt numeric; v_ref text; v_tx uuid; v_client text; t paystack_transactions%rowtype;
begin
  perform finance_init_user(uid);
  select * into inv from invoices where id = p_invoice for update;
  if not found or inv.user_id <> uid then raise exception 'Invoice not found.' using errcode = 'P0001'; end if;
  if coalesce(inv.doc_type, 'invoice') not in ('invoice', 'proforma') then
    raise exception 'Only invoices and proformas can be paid online.' using errcode = 'P0001';
  end if;
  if exists (select 1 from invoices x where x.converted_from_id = inv.id) then
    raise exception 'This document was superseded by a later invoice or receipt. Pay the latest document instead.' using errcode = 'P0001';
  end if;
  if coalesce(inv.amount, 0) <= 0 then raise exception 'This invoice has no amount to collect.' using errcode = 'P0001'; end if;

  v_ccy := finance_ccy_code(inv.currency);
  if v_ccy not in ('NGN', 'GHS', 'ZAR', 'KES', 'USD') then
    raise exception 'Paystack cannot collect % payments. Supported currencies: NGN, GHS, ZAR, KES, USD.', v_ccy using errcode = 'P0001';
  end if;
  if p_email is null or p_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' or length(p_email) > 254 then
    raise exception 'Enter a valid customer email address for the checkout.' using errcode = 'P0001';
  end if;

  v_out := round(payments_invoice_outstanding(inv.id), 2);
  if v_out <= 0.005 then raise exception 'This invoice has no outstanding balance.' using errcode = 'P0001'; end if;
  v_amt := round(coalesce(p_amount, v_out), 2);
  if v_amt <= 0 then raise exception 'Enter a payment amount greater than zero.' using errcode = 'P0001'; end if;
  if v_amt > v_out + 0.005 then
    raise exception 'The amount % exceeds the outstanding balance of %.', v_amt, v_out using errcode = 'P0001';
  end if;

  -- Same invoice + same amount, started recently and not yet resolved: hand back the same checkout.
  select x.* into t from paystack_transactions x
   where x.invoice_id = inv.id and x.user_id = uid and x.status in ('initialized', 'pending')
     and x.amount = v_amt and x.authorization_url is not null and x.created_at > now() - interval '30 minutes'
   order by x.created_at desc limit 1;
  if found then
    return query select t.id, t.reference, t.amount, t.currency, true, t.authorization_url;
    return;
  end if;

  select coalesce(client, '') into v_client from projects where id = inv.project_id;
  v_ref := 'KRL-' || upper(left(replace(inv.id::text, '-', ''), 8)) || '-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 10));
  insert into paystack_transactions (user_id, reference, invoice_id, invoice_number, project_id, client_name, customer_email, amount, currency)
  values (uid, v_ref, inv.id, inv.invoice_number, inv.project_id, coalesce(v_client, ''), lower(btrim(p_email)), v_amt, v_ccy)
  returning id into v_tx;
  perform finance_audit(uid, 'initiate', 'paystack_transaction', v_tx, null,
    jsonb_build_object('reference', v_ref, 'invoice_id', inv.id, 'amount', v_amt, 'currency', v_ccy, 'environment', 'test'));
  return query select v_tx, v_ref, v_amt, v_ccy, false, null::text;
end
$$;

-- ---------------------------------------------------------------------------
-- Internal: apply a VERIFIED successful charge to the invoice and book the fee.
-- Runs inside payments_apply_verification's row lock. Every step is idempotent.
-- ---------------------------------------------------------------------------
create or replace function public.payments_apply_to_invoice(p_tx uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  t paystack_transactions%rowtype; inv invoices%rowtype; v_ccy text; v_cash record; v_entry uuid; v_pay uuid;
  v_exp uuid; v_date date; v_client text;
begin
  select * into t from paystack_transactions where id = p_tx for update;
  if t.invoice_payment_id is not null then return; end if;                        -- already applied
  if t.environment <> 'test' or t.status <> 'success' then raise exception 'Only a verified sandbox success can be applied.' using errcode = 'P0001'; end if;
  select * into inv from invoices where id = t.invoice_id for update;
  if not found or inv.user_id <> t.user_id then raise exception 'The invoice for this payment no longer exists.' using errcode = 'P0001'; end if;
  v_ccy := finance_ccy_code(inv.currency);
  if v_ccy <> t.currency then raise exception 'Invoice currency % no longer matches the payment currency %.', v_ccy, t.currency using errcode = 'P0001'; end if;
  v_date := coalesce(t.paid_at, now())::date;
  select coalesce(client, '') into v_client from projects where id = inv.project_id;

  select * into v_cash from finance_cash_account_for(t.user_id, v_ccy, null);
  perform finance_post_invoice(inv.id, false);
  -- finance_settle raises when the amount exceeds what is still outstanding: no over-collection.
  v_entry := finance_settle(t.user_id, 'invoice', inv.id, v_ccy, inv.project_id, coalesce(v_client, ''), inv.invoice_number,
                            t.amount, v_date, v_cash.account_id, v_cash.bank_id, false);
  insert into invoice_payments (user_id, invoice_id, invoice_number, amount, currency, paid_date, method, bank_account_id, reference, journal_entry_id)
  values (t.user_id, inv.id, inv.invoice_number, t.amount, v_ccy, v_date, 'Paystack (test mode)', v_cash.bank_id, t.reference, v_entry)
  returning id into v_pay;
  perform finance_sync_invoice_paid(inv.id);

  -- Actual fee only, once. The existing expense trigger posts the ledger entry (Dr fees / Cr the same bank or cash account).
  if coalesce(t.fee_actual, 0) > 0 and t.fee_expense_id is null then
    insert into expenses (user_id, project_id, category, description, amount, currency, date, vendor, bank_account_id, reference, notes)
    values (t.user_id, inv.project_id, 'Payment processing fees', 'Paystack fee (TEST) ' || t.reference, t.fee_actual, v_ccy,
            to_char(v_date, 'YYYY-MM-DD'), 'Paystack', v_cash.bank_id, t.reference,
            'Actual fee reported by Paystack sandbox for ' || coalesce(nullif(inv.invoice_number, ''), 'invoice') || '. Test data, not real money.')
    returning id into v_exp;
  end if;

  update paystack_transactions set
    invoice_payment_id = v_pay, fee_expense_id = coalesce(v_exp, fee_expense_id),
    apply_status = 'applied', apply_error = '', reconciliation_status = 'matched', reconciled_at = now(), updated_at = now()
  where id = t.id;
  perform finance_audit(t.user_id, 'apply', 'paystack_transaction', t.id, null,
    jsonb_build_object('invoice_payment_id', v_pay, 'amount', t.amount, 'fee', t.fee_actual, 'currency', v_ccy, 'environment', 'test'));
end
$$;

-- ---------------------------------------------------------------------------
-- Server-side only: record the outcome of a Paystack verification.
-- Called by the Edge Functions with the service role AFTER they verified the transaction with
-- Paystack's API using the secret key. Safe to call repeatedly (browser refresh, webhook retry,
-- simultaneous callbacks): the row lock serialises callers and a ledger payment is linked once.
-- ---------------------------------------------------------------------------
create or replace function public.payments_apply_verification(
  p_reference text, p_outcome text, p_amount_minor bigint, p_currency text, p_fee_minor bigint,
  p_channel text, p_paystack_id text, p_paid_at timestamptz, p_gateway text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare t paystack_transactions%rowtype; v_amount numeric; v_err text;
begin
  select * into t from paystack_transactions where reference = p_reference for update;
  if not found then raise exception 'Unknown payment reference.' using errcode = 'P0001'; end if;
  if t.environment <> 'test' then raise exception 'Refusing to process a non-test transaction.' using errcode = 'P0001'; end if;

  if p_outcome <> 'success' then
    -- A settled payment is never downgraded by a late "failed"/"pending" answer.
    if t.status in ('success', 'refunded', 'partially_refunded') or t.invoice_payment_id is not null or p_outcome = 'reversed' then
      return jsonb_build_object('status', t.status, 'changed', false, 'applied', t.apply_status = 'applied');
    end if;
    update paystack_transactions set
      status = case p_outcome when 'failed' then 'failed' when 'abandoned' then 'abandoned' else 'pending' end,
      gateway_response = coalesce(p_gateway, ''), verified_at = now(), updated_at = now()
    where id = t.id returning * into t;
    perform finance_audit(t.user_id, 'verify', 'paystack_transaction', t.id, null, jsonb_build_object('outcome', p_outcome, 'environment', 'test'));
    return jsonb_build_object('status', t.status, 'changed', true, 'applied', false);
  end if;

  -- Success: cross-check against OUR stored expectation (the Edge Function checked too).
  v_amount := round(p_amount_minor::numeric / 100, 2);
  if v_amount <> t.amount or upper(coalesce(p_currency, '')) <> t.currency then
    raise exception 'Verified amount/currency does not match the stored transaction.' using errcode = 'P0001';
  end if;
  if t.invoice_payment_id is not null then
    return jsonb_build_object('status', t.status, 'changed', false, 'applied', true, 'duplicate', true);
  end if;

  update paystack_transactions set
    status = 'success', paystack_id = coalesce(nullif(p_paystack_id, ''), paystack_id), channel = coalesce(p_channel, ''),
    fee_actual = case when p_fee_minor is null then null else round(p_fee_minor::numeric / 100, 2) end,
    net_amount = case when p_fee_minor is null then null else t.amount - round(p_fee_minor::numeric / 100, 2) end,
    gateway_response = coalesce(p_gateway, ''), paid_at = coalesce(p_paid_at, paid_at, now()), verified_at = now(), updated_at = now()
  where id = t.id;

  begin
    perform payments_apply_to_invoice(t.id);
  exception when others then
    get stacked diagnostics v_err = message_text;
    -- The gateway says paid but the ledger could not take it (e.g. the invoice was settled another way in the meantime).
    -- Keep the facts, flag it for Reconciliation. Money is never silently dropped or double counted.
    update paystack_transactions set apply_status = 'failed', apply_error = left(coalesce(v_err, ''), 500),
      reconciliation_status = 'needs_review', updated_at = now() where id = t.id;
    perform finance_audit(t.user_id, 'apply_failed', 'paystack_transaction', t.id, null, jsonb_build_object('error', left(coalesce(v_err, ''), 500)));
  end;

  select * into t from paystack_transactions where id = t.id;
  return jsonb_build_object('status', t.status, 'changed', true, 'applied', t.apply_status = 'applied', 'apply_status', t.apply_status, 'apply_error', t.apply_error);
end
$$;

-- User action from Reconciliation: re-attempt applying a verified payment that the ledger rejected earlier.
create or replace function public.payments_retry_apply(p_transaction uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := finance_require_user(); t paystack_transactions%rowtype; v_err text;
begin
  select * into t from paystack_transactions where id = p_transaction and user_id = uid for update;
  if not found then raise exception 'Transaction not found.' using errcode = 'P0001'; end if;
  if t.status <> 'success' or t.invoice_payment_id is not null then
    raise exception 'Only a verified payment that has not been applied can be retried.' using errcode = 'P0001';
  end if;
  begin
    perform payments_apply_to_invoice(t.id);
  exception when others then
    get stacked diagnostics v_err = message_text;
    update paystack_transactions set apply_status = 'failed', apply_error = left(coalesce(v_err, ''), 500),
      reconciliation_status = 'needs_review', updated_at = now() where id = t.id;
    return jsonb_build_object('applied', false, 'error', left(coalesce(v_err, ''), 500));
  end;
  return jsonb_build_object('applied', true);
end
$$;

-- User action from Reconciliation: a person confirms they have dealt with an exception. Audited, with a required note.
create or replace function public.payments_resolve_review(p_transaction uuid, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := finance_require_user(); t paystack_transactions%rowtype;
begin
  if coalesce(btrim(p_note), '') = '' then raise exception 'Add a note explaining how this was resolved.' using errcode = 'P0001'; end if;
  select * into t from paystack_transactions where id = p_transaction and user_id = uid for update;
  if not found then raise exception 'Transaction not found.' using errcode = 'P0001'; end if;
  if t.reconciliation_status = 'matched' then return; end if;
  if t.status not in ('success', 'partially_refunded', 'refunded') then
    raise exception 'Only verified payments can be reconciled.' using errcode = 'P0001';
  end if;
  update paystack_transactions set reconciliation_status = 'matched', reconciled_at = now(),
    reconciliation_note = left(p_note, 500), updated_at = now() where id = t.id;
  perform finance_audit(uid, 'reconcile', 'paystack_transaction', t.id, to_jsonb(t), jsonb_build_object('note', left(p_note, 500)));
end
$$;

-- ---------------------------------------------------------------------------
-- Refund BOOKKEEPING. This records that Paystack reported a refund; it never asks Paystack to refund anything.
-- ---------------------------------------------------------------------------
create or replace function public.payments_apply_refund(
  p_reference text, p_amount_minor bigint, p_currency text, p_event_ref text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare t paystack_transactions%rowtype; ip invoice_payments%rowtype; v_amt numeric; v_total numeric;
begin
  select * into t from paystack_transactions where reference = p_reference for update;
  if not found then raise exception 'Unknown payment reference.' using errcode = 'P0001'; end if;
  if t.environment <> 'test' then raise exception 'Refusing to process a non-test transaction.' using errcode = 'P0001'; end if;
  if p_event_ref is not null and p_event_ref = any (t.refund_refs) then
    return jsonb_build_object('status', t.status, 'duplicate', true);
  end if;
  if t.invoice_payment_id is null or t.status not in ('success', 'partially_refunded') then
    raise exception 'The original charge has not been applied yet; retry the refund event later.' using errcode = 'P0001';
  end if;
  if upper(coalesce(p_currency, '')) <> t.currency then raise exception 'Refund currency mismatch.' using errcode = 'P0001'; end if;
  v_amt := round(p_amount_minor::numeric / 100, 2);
  if v_amt <= 0 then raise exception 'Refund amount must be positive.' using errcode = 'P0001'; end if;
  v_total := t.refunded_amount + v_amt;
  if v_total > t.amount + 0.005 then raise exception 'Refunds exceed the original payment.' using errcode = 'P0001'; end if;

  if v_total >= t.amount - 0.005 then
    select * into ip from invoice_payments where id = t.invoice_payment_id for update;
    if found and ip.status = 'posted' then
      perform finance_void_entry(t.user_id, ip.journal_entry_id, 'Paystack refund (test) ' || t.reference);
      update invoice_payments set status = 'void', void_reason = 'Paystack refund (test) ' || t.reference where id = ip.id;
      if ip.invoice_id is not null then perform finance_sync_invoice_paid(ip.invoice_id); end if;
    end if;
    update paystack_transactions set status = 'refunded', refunded_amount = v_total,
      refund_refs = array_append(refund_refs, p_event_ref), updated_at = now() where id = t.id;
  else
    update paystack_transactions set status = 'partially_refunded', refunded_amount = v_total,
      refund_refs = array_append(refund_refs, p_event_ref), reconciliation_status = 'needs_review',
      reconciliation_note = 'Partial refund reported by Paystack. Adjust the invoice in Finance, then mark this reviewed.', updated_at = now()
    where id = t.id;
  end if;
  perform finance_audit(t.user_id, 'refund', 'paystack_transaction', t.id, null,
    jsonb_build_object('amount', v_amt, 'total_refunded', v_total, 'currency', t.currency, 'environment', 'test'));
  select * into t from paystack_transactions where id = t.id;
  return jsonb_build_object('status', t.status, 'refunded_amount', t.refunded_amount);
end
$$;

-- ---------------------------------------------------------------------------
-- Outgoing: freelancer payout REQUESTS (simulated). The obligation is the bill in Finance.
-- A request is an attempt; failing or cancelling one never changes what is owed.
-- ---------------------------------------------------------------------------
create or replace function public.payments_payout_reserved(p_bill uuid, p_exclude uuid default null)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount), 0) from freelancer_payout_requests
  where bill_id = p_bill and status in ('pending_approval', 'approved', 'simulated_initiated')
    and (p_exclude is null or id <> p_exclude)
$$;

create or replace function public.payments_create_payout_request(p_bill uuid, p_amount numeric, p_note text default '')
returns uuid language plpgsql security definer set search_path = public as $$
declare uid uuid := finance_require_user(); b bills%rowtype; v_out numeric; v_free numeric; v_amt numeric; v_id uuid;
begin
  select * into b from bills where id = p_bill and user_id = uid for update;
  if not found then raise exception 'Bill not found.' using errcode = 'P0001'; end if;
  if b.status not in ('approved', 'partially_paid') then
    raise exception 'Only an approved bill with a balance owing can be paid. Approve it in Finance > Purchases first.' using errcode = 'P0001';
  end if;
  v_out := round(b.amount - b.amount_paid, 2);
  v_free := v_out - payments_payout_reserved(b.id);
  v_amt := round(coalesce(p_amount, v_free), 2);
  if v_amt <= 0 then raise exception 'Enter an amount greater than zero.' using errcode = 'P0001'; end if;
  if v_amt > v_free + 0.005 then
    raise exception 'The amount % exceeds the % still available on this bill (outstanding % minus open requests).', v_amt, v_free, v_out using errcode = 'P0001';
  end if;
  insert into freelancer_payout_requests (user_id, team_member_id, bill_id, project_id, amount, currency, note, request_ref)
  values (uid, b.team_member_id, b.id, b.project_id, v_amt, b.currency, left(coalesce(p_note, ''), 500),
          'PAYREQ-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8)))
  returning id into v_id;
  perform finance_audit(uid, 'request', 'payout_request', v_id, null,
    jsonb_build_object('bill_id', b.id, 'amount', v_amt, 'currency', b.currency, 'simulated', true));
  return v_id;
end
$$;

create or replace function public.payments_approve_payout_request(p_request uuid)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := finance_require_user(); r freelancer_payout_requests%rowtype;
begin
  select * into r from freelancer_payout_requests where id = p_request and user_id = uid for update;
  if not found then raise exception 'Payout request not found.' using errcode = 'P0001'; end if;
  if r.status not in ('pending_approval', 'failed') then raise exception 'Only a pending or failed request can be approved.' using errcode = 'P0001'; end if;
  if r.status = 'failed' and r.amount > (select round(b.amount - b.amount_paid, 2) from bills b where b.id = r.bill_id) - payments_payout_reserved(r.bill_id, r.id) + 0.005 then
    raise exception 'The bill no longer has enough outstanding balance for this request.' using errcode = 'P0001';
  end if;
  update freelancer_payout_requests set status = 'approved', approved_at = now(), approved_by = uid,
    failure_reason = '', updated_at = now() where id = r.id;
  perform finance_audit(uid, 'approve', 'payout_request', r.id, jsonb_build_object('status', r.status), jsonb_build_object('status', 'approved'));
end
$$;

create or replace function public.payments_cancel_payout_request(p_request uuid, p_reason text default '')
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := finance_require_user(); r freelancer_payout_requests%rowtype;
begin
  select * into r from freelancer_payout_requests where id = p_request and user_id = uid for update;
  if not found then raise exception 'Payout request not found.' using errcode = 'P0001'; end if;
  if r.status not in ('pending_approval', 'approved', 'failed') then raise exception 'This request can no longer be cancelled.' using errcode = 'P0001'; end if;
  update freelancer_payout_requests set status = 'cancelled', cancelled_reason = left(coalesce(p_reason, ''), 500), updated_at = now() where id = r.id;
  perform finance_audit(uid, 'cancel', 'payout_request', r.id, jsonb_build_object('status', r.status), jsonb_build_object('status', 'cancelled'));
end
$$;

-- Step 4 of the workflow: a SIMULATED test payment is created. No money moves, nothing is posted to the ledger.
create or replace function public.payments_simulate_payout_start(p_request uuid)
returns text language plpgsql security definer set search_path = public as $$
declare uid uuid := finance_require_user(); r freelancer_payout_requests%rowtype; v_ref text;
begin
  select * into r from freelancer_payout_requests where id = p_request and user_id = uid for update;
  if not found then raise exception 'Payout request not found.' using errcode = 'P0001'; end if;
  if r.status <> 'approved' then raise exception 'Only an approved request can start a simulated payout.' using errcode = 'P0001'; end if;
  v_ref := 'SIM-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 10));
  update freelancer_payout_requests set status = 'simulated_initiated', simulation_ref = v_ref, simulated_at = now(), updated_at = now() where id = r.id;
  perform finance_audit(uid, 'simulate_start', 'payout_request', r.id, null, jsonb_build_object('simulation_ref', v_ref, 'simulated', true, 'money_moved', false));
  return v_ref;
end
$$;

-- Step 5: the simulation finishes (success or failure). A failure leaves the bill's outstanding balance untouched.
create or replace function public.payments_simulate_payout_finish(p_request uuid, p_succeed boolean, p_reason text default '')
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := finance_require_user(); r freelancer_payout_requests%rowtype;
begin
  select * into r from freelancer_payout_requests where id = p_request and user_id = uid for update;
  if not found then raise exception 'Payout request not found.' using errcode = 'P0001'; end if;
  if r.status <> 'simulated_initiated' then raise exception 'Start the simulation first.' using errcode = 'P0001'; end if;
  if p_succeed then
    update freelancer_payout_requests set status = 'completed_simulated', completed_at = now(), updated_at = now() where id = r.id;
  else
    update freelancer_payout_requests set status = 'failed', failure_reason = left(coalesce(nullif(btrim(p_reason), ''), 'Simulated failure'), 500), updated_at = now() where id = r.id;
  end if;
  perform finance_audit(uid, case when p_succeed then 'simulate_complete' else 'simulate_fail' end, 'payout_request', r.id, null,
    jsonb_build_object('simulation_ref', r.simulation_ref, 'simulated', true, 'money_moved', false));
end
$$;

-- Step 7: match a completed simulation to a REAL payment recorded in Finance (bill_payments) for the same bill and amount.
create or replace function public.payments_reconcile_payout(p_request uuid, p_bill_payment uuid)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := finance_require_user(); r freelancer_payout_requests%rowtype; bp bill_payments%rowtype;
begin
  select * into r from freelancer_payout_requests where id = p_request and user_id = uid for update;
  if not found then raise exception 'Payout request not found.' using errcode = 'P0001'; end if;
  if r.status <> 'completed_simulated' or r.reconciled then raise exception 'Only a completed, unreconciled simulation can be reconciled.' using errcode = 'P0001'; end if;
  select * into bp from bill_payments where id = p_bill_payment and user_id = uid;
  if not found or bp.status <> 'posted' then raise exception 'Choose a posted payment recorded in Finance.' using errcode = 'P0001'; end if;
  if bp.bill_id is distinct from r.bill_id then raise exception 'That payment belongs to a different bill.' using errcode = 'P0001'; end if;
  if abs(bp.amount - r.amount) > 0.005 then raise exception 'The payment amount % does not match the request amount %.', bp.amount, r.amount using errcode = 'P0001'; end if;
  update freelancer_payout_requests set reconciled = true, reconciled_at = now(), bill_payment_id = bp.id, updated_at = now() where id = r.id;
  perform finance_audit(uid, 'reconcile', 'payout_request', r.id, null, jsonb_build_object('bill_payment_id', bp.id));
end
$$;

-- ---------------------------------------------------------------------------
-- Privileges. Server-only functions are NOT callable from the browser.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'payments\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
  end loop;
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in (
             'payments_prepare_charge', 'payments_retry_apply', 'payments_resolve_review',
             'payments_create_payout_request', 'payments_approve_payout_request', 'payments_cancel_payout_request',
             'payments_simulate_payout_start', 'payments_simulate_payout_finish', 'payments_reconcile_payout') loop
    execute format('grant execute on function %s to authenticated', r.sig);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname in ('payments_apply_verification', 'payments_apply_refund') loop
      execute format('grant execute on function %s to service_role', r.sig);
    end loop;
  end if;
end
$$;
