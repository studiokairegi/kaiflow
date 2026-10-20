-- =============================================================================
-- Payments v2: provider-neutral architecture + ADMIN-ONLY enforcement
-- =============================================================================
-- NO LIVE PROVIDER INTEGRATION IS IMPLEMENTED HERE. This migration only adds:
--   1. payments_is_admin() / payments_require_admin()  -> backend admin gate
--   2. Admin gate on EVERYTHING that already exists in the Paystack sandbox module
--      (RLS on its tables + every browser-callable payments_* RPC)
--   3. Provider-neutral tables:
--        payment_providers          which providers exist / are enabled / primary
--        payment_checkout_sessions  the public /pay/{token} link for an invoice
--        payment_transactions       one row per payment attempt, any provider
--        payment_events             de-duplicated provider event log, any provider
--   4. Admin RPCs to manage providers and checkout sessions
--   5. ONE anonymous RPC, payments_public_checkout(token), returning a minimal,
--      non-sensitive view for the public checkout page
--
-- Flow:  Invoice -> Checkout Session -> Provider -> Payment Transaction
--                -> Invoice Payment (finance_settle, later) -> Ledger
--
-- The legacy paystack_* tables are LEFT IN PLACE and keep working (admin only). They are
-- the Paystack provider's sandbox history; a later step can backfill payment_transactions.
--
-- Security notes
--   * Checkout tokens are 244 random bits (two gen_random_uuid()). Only the SHA-256 hash is
--     stored; the plaintext token is returned once, at creation. A leaked table cannot
--     reveal working links.
--   * Provider credentials are NEVER stored in these tables. They live in server secrets.
--   * Idempotent: safe to re-run.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Admin gate
-- ---------------------------------------------------------------------------
create or replace function public.payments_is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select s.is_admin from user_settings s where s.user_id = auth.uid()), false)
$$;

create or replace function public.payments_require_admin()
returns uuid language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if not payments_is_admin() then
    raise exception 'Payments is currently available to administrators only.' using errcode = '42501';
  end if;
  return uid;
end
$$;

revoke all on function public.payments_is_admin() from public, anon;
revoke all on function public.payments_require_admin() from public, anon;
grant execute on function public.payments_is_admin() to authenticated;
grant execute on function public.payments_require_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Admin gate on the existing Paystack sandbox module
-- ---------------------------------------------------------------------------
-- 2a. RLS: owner AND admin.
drop policy if exists "Users read their own paystack transactions" on paystack_transactions;
drop policy if exists "Admins read their own paystack transactions" on paystack_transactions;
create policy "Admins read their own paystack transactions" on paystack_transactions
  for select using (auth.uid() = user_id and public.payments_is_admin());

drop policy if exists "Users read their own paystack events" on paystack_webhook_events;
drop policy if exists "Admins read their own paystack events" on paystack_webhook_events;
create policy "Admins read their own paystack events" on paystack_webhook_events
  for select using (auth.uid() = user_id and public.payments_is_admin());

drop policy if exists "Users read their own payout requests" on freelancer_payout_requests;
drop policy if exists "Admins read their own payout requests" on freelancer_payout_requests;
create policy "Admins read their own payout requests" on freelancer_payout_requests
  for select using (auth.uid() = user_id and public.payments_is_admin());

-- 2b. Browser-callable RPCs: rename each original to *_impl (no browser access) and put an
-- admin-checking wrapper under the original name. Callers (browser, Edge Functions acting as
-- the user) keep using the same names and signatures.
do $$
begin
  if to_regprocedure('public.payments_prepare_charge_impl(uuid,numeric,text)') is null
     and to_regprocedure('public.payments_prepare_charge(uuid,numeric,text)') is not null then
    alter function public.payments_prepare_charge(uuid, numeric, text) rename to payments_prepare_charge_impl;
  end if;
  if to_regprocedure('public.payments_retry_apply_impl(uuid)') is null
     and to_regprocedure('public.payments_retry_apply(uuid)') is not null then
    alter function public.payments_retry_apply(uuid) rename to payments_retry_apply_impl;
  end if;
  if to_regprocedure('public.payments_resolve_review_impl(uuid,text)') is null
     and to_regprocedure('public.payments_resolve_review(uuid,text)') is not null then
    alter function public.payments_resolve_review(uuid, text) rename to payments_resolve_review_impl;
  end if;
  if to_regprocedure('public.payments_create_payout_request_impl(uuid,numeric,text)') is null
     and to_regprocedure('public.payments_create_payout_request(uuid,numeric,text)') is not null then
    alter function public.payments_create_payout_request(uuid, numeric, text) rename to payments_create_payout_request_impl;
  end if;
  if to_regprocedure('public.payments_approve_payout_request_impl(uuid)') is null
     and to_regprocedure('public.payments_approve_payout_request(uuid)') is not null then
    alter function public.payments_approve_payout_request(uuid) rename to payments_approve_payout_request_impl;
  end if;
  if to_regprocedure('public.payments_cancel_payout_request_impl(uuid,text)') is null
     and to_regprocedure('public.payments_cancel_payout_request(uuid,text)') is not null then
    alter function public.payments_cancel_payout_request(uuid, text) rename to payments_cancel_payout_request_impl;
  end if;
  if to_regprocedure('public.payments_simulate_payout_start_impl(uuid)') is null
     and to_regprocedure('public.payments_simulate_payout_start(uuid)') is not null then
    alter function public.payments_simulate_payout_start(uuid) rename to payments_simulate_payout_start_impl;
  end if;
  if to_regprocedure('public.payments_simulate_payout_finish_impl(uuid,boolean,text)') is null
     and to_regprocedure('public.payments_simulate_payout_finish(uuid,boolean,text)') is not null then
    alter function public.payments_simulate_payout_finish(uuid, boolean, text) rename to payments_simulate_payout_finish_impl;
  end if;
  if to_regprocedure('public.payments_reconcile_payout_impl(uuid,uuid)') is null
     and to_regprocedure('public.payments_reconcile_payout(uuid,uuid)') is not null then
    alter function public.payments_reconcile_payout(uuid, uuid) rename to payments_reconcile_payout_impl;
  end if;
end
$$;

create or replace function public.payments_prepare_charge(p_invoice uuid, p_amount numeric, p_email text)
returns table (transaction_id uuid, reference text, amount numeric, currency text, reused boolean, authorization_url text)
language plpgsql security definer set search_path = public as $$
begin
  perform payments_require_admin();
  return query select * from payments_prepare_charge_impl(p_invoice, p_amount, p_email);
end
$$;

create or replace function public.payments_retry_apply(p_transaction uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin perform payments_require_admin(); return payments_retry_apply_impl(p_transaction); end
$$;

create or replace function public.payments_resolve_review(p_transaction uuid, p_note text)
returns void language plpgsql security definer set search_path = public as $$
begin perform payments_require_admin(); perform payments_resolve_review_impl(p_transaction, p_note); end
$$;

create or replace function public.payments_create_payout_request(p_bill uuid, p_amount numeric, p_note text default '')
returns uuid language plpgsql security definer set search_path = public as $$
begin perform payments_require_admin(); return payments_create_payout_request_impl(p_bill, p_amount, p_note); end
$$;

create or replace function public.payments_approve_payout_request(p_request uuid)
returns void language plpgsql security definer set search_path = public as $$
begin perform payments_require_admin(); perform payments_approve_payout_request_impl(p_request); end
$$;

create or replace function public.payments_cancel_payout_request(p_request uuid, p_reason text default '')
returns void language plpgsql security definer set search_path = public as $$
begin perform payments_require_admin(); perform payments_cancel_payout_request_impl(p_request, p_reason); end
$$;

create or replace function public.payments_simulate_payout_start(p_request uuid)
returns text language plpgsql security definer set search_path = public as $$
begin perform payments_require_admin(); return payments_simulate_payout_start_impl(p_request); end
$$;

create or replace function public.payments_simulate_payout_finish(p_request uuid, p_succeed boolean, p_reason text default '')
returns void language plpgsql security definer set search_path = public as $$
begin perform payments_require_admin(); perform payments_simulate_payout_finish_impl(p_request, p_succeed, p_reason); end
$$;

create or replace function public.payments_reconcile_payout(p_request uuid, p_bill_payment uuid)
returns void language plpgsql security definer set search_path = public as $$
begin perform payments_require_admin(); perform payments_reconcile_payout_impl(p_request, p_bill_payment); end
$$;

do $$
declare r record;
begin
  -- *_impl functions are internal: only reachable through the admin-checking wrappers.
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'payments\_%\_impl' loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
  end loop;
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in (
             'payments_prepare_charge', 'payments_retry_apply', 'payments_resolve_review',
             'payments_create_payout_request', 'payments_approve_payout_request', 'payments_cancel_payout_request',
             'payments_simulate_payout_start', 'payments_simulate_payout_finish', 'payments_reconcile_payout') loop
    execute format('revoke all on function %s from public, anon', r.sig);
    execute format('grant execute on function %s to authenticated', r.sig);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Provider-neutral tables
-- ---------------------------------------------------------------------------
create table if not exists payment_providers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  provider text not null check (provider in ('wise', 'paystack', 'paypal', 'payoneer', 'mpesa')),
  display_name text not null,
  integration_model text not null default '',             -- e.g. 'embedded' for Wise Embedded Solutions
  status text not null default 'not_connected'
    check (status in ('coming_soon', 'not_connected', 'connected', 'error')),
  is_enabled boolean not null default false,
  is_primary boolean not null default false,
  environment text not null default 'none' check (environment in ('none', 'sandbox', 'live')),
  settings jsonb not null default '{}'::jsonb,            -- NON-secret configuration only. Credentials live in server secrets.
  connected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider),
  check (not (is_enabled and status = 'coming_soon')),
  check (not is_primary or is_enabled)
);
create unique index if not exists payment_providers_one_primary_uidx on payment_providers(user_id) where is_primary;

create table if not exists payment_checkout_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  invoice_id uuid not null references invoices(id) on delete cascade,
  token_hash text not null unique,                        -- sha256 hex of the public token; the token itself is never stored
  token_hint text not null default '',                    -- last 4 characters, so an admin can tell links apart
  amount numeric not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'open' check (status in ('open', 'paid', 'expired', 'cancelled', 'failed')),
  selected_provider text check (selected_provider is null or selected_provider in ('wise', 'paystack', 'paypal', 'payoneer', 'mpesa')),
  expires_at timestamptz not null default now() + interval '14 days',
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists payment_sessions_user_idx on payment_checkout_sessions(user_id, created_at desc);
create index if not exists payment_sessions_invoice_idx on payment_checkout_sessions(invoice_id);

create table if not exists payment_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  checkout_session_id uuid references payment_checkout_sessions(id) on delete set null,
  invoice_id uuid references invoices(id) on delete set null,
  provider text not null check (provider in ('wise', 'paystack', 'paypal', 'payoneer', 'mpesa')),
  provider_reference text,                                -- the provider's own id/reference; unique per provider
  status text not null default 'initiated'
    check (status in ('initiated', 'pending', 'succeeded', 'failed', 'cancelled', 'refunded', 'partially_refunded')),
  amount numeric not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  fee_amount numeric check (fee_amount is null or fee_amount >= 0),
  net_amount numeric,
  refunded_amount numeric not null default 0 check (refunded_amount >= 0),
  provider_data jsonb not null default '{}'::jsonb,       -- sanitised provider facts; no card data, no secrets
  paid_at timestamptz,
  verified_at timestamptz,
  invoice_payment_id uuid references invoice_payments(id) on delete set null,
  apply_status text not null default 'none' check (apply_status in ('none', 'applied', 'failed')),
  apply_error text not null default '',
  reconciliation_status text not null default 'unreconciled' check (reconciliation_status in ('unreconciled', 'matched', 'needs_review')),
  reconciled_at timestamptz,
  reconciliation_note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists payment_tx_user_idx on payment_transactions(user_id, created_at desc);
create index if not exists payment_tx_invoice_idx on payment_transactions(invoice_id);
create unique index if not exists payment_tx_provider_ref_uidx on payment_transactions(provider, provider_reference) where provider_reference is not null;
-- A ledger payment belongs to at most one transaction: the hard stop on double counting.
create unique index if not exists payment_tx_invoice_payment_uidx on payment_transactions(invoice_payment_id) where invoice_payment_id is not null;

create table if not exists payment_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  provider text not null check (provider in ('wise', 'paystack', 'paypal', 'payoneer', 'mpesa')),
  event_key text not null,
  event_type text not null,
  transaction_id uuid references payment_transactions(id) on delete set null,
  status text not null default 'received' check (status in ('received', 'processed', 'ignored', 'failed')),
  attempts int not null default 1,
  error text not null default '',
  payload jsonb,                                          -- sanitised by the provider adapter
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, event_key)
);
create index if not exists payment_events_user_idx on payment_events(user_id, received_at desc);

-- RLS: admins read their own rows. Every write goes through the functions below or service role.
alter table payment_providers enable row level security;
alter table payment_checkout_sessions enable row level security;
alter table payment_transactions enable row level security;
alter table payment_events enable row level security;

drop policy if exists "Admins read their payment providers" on payment_providers;
create policy "Admins read their payment providers" on payment_providers for select using (auth.uid() = user_id and public.payments_is_admin());
drop policy if exists "Admins read their checkout sessions" on payment_checkout_sessions;
create policy "Admins read their checkout sessions" on payment_checkout_sessions for select using (auth.uid() = user_id and public.payments_is_admin());
drop policy if exists "Admins read their payment transactions" on payment_transactions;
create policy "Admins read their payment transactions" on payment_transactions for select using (auth.uid() = user_id and public.payments_is_admin());
drop policy if exists "Admins read their payment events" on payment_events;
create policy "Admins read their payment events" on payment_events for select using (auth.uid() = user_id and public.payments_is_admin());

revoke insert, update, delete, truncate on payment_providers from anon, authenticated;
revoke insert, update, delete, truncate on payment_checkout_sessions from anon, authenticated;
revoke insert, update, delete, truncate on payment_transactions from anon, authenticated;
revoke insert, update, delete, truncate on payment_events from anon, authenticated;
revoke all on payment_providers, payment_checkout_sessions, payment_transactions, payment_events from anon;

-- ---------------------------------------------------------------------------
-- 4. Admin RPCs: providers
-- ---------------------------------------------------------------------------
-- Seeds the provider catalogue for the admin (idempotent) and returns it. Wise is enabled and
-- primary from day one but NOT connected: it is only offered to clients once status = 'connected'.
create or replace function public.payments_list_providers()
returns setof payment_providers language plpgsql security definer set search_path = public as $$
declare uid uuid := payments_require_admin();
begin
  insert into payment_providers (user_id, provider, display_name, integration_model, status, is_enabled, is_primary)
  values (uid, 'wise', 'Wise', 'Embedded Solutions', 'not_connected', true, true)
  on conflict (user_id, provider) do nothing;
  insert into payment_providers (user_id, provider, display_name, integration_model, status)
  values (uid, 'paystack', 'Paystack', '', 'coming_soon'),
         (uid, 'paypal', 'PayPal', '', 'coming_soon'),
         (uid, 'payoneer', 'Payoneer', '', 'coming_soon'),
         (uid, 'mpesa', 'M-Pesa', '', 'coming_soon')
  on conflict (user_id, provider) do nothing;
  return query select * from payment_providers where user_id = uid
    order by is_primary desc, (status = 'coming_soon'), provider;
end
$$;

create or replace function public.payments_set_provider_enabled(p_provider text, p_enabled boolean)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := payments_require_admin(); r payment_providers%rowtype;
begin
  select * into r from payment_providers where user_id = uid and provider = p_provider for update;
  if not found then raise exception 'Unknown provider.' using errcode = 'P0001'; end if;
  if r.status = 'coming_soon' then raise exception '% is not available yet.', r.display_name using errcode = 'P0001'; end if;
  update payment_providers set is_enabled = p_enabled,
    is_primary = case when p_enabled then is_primary else false end, updated_at = now() where id = r.id;
  perform finance_audit(uid, case when p_enabled then 'enable' else 'disable' end, 'payment_provider', r.id, null,
    jsonb_build_object('provider', p_provider));
end
$$;

create or replace function public.payments_set_primary_provider(p_provider text)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := payments_require_admin(); r payment_providers%rowtype;
begin
  select * into r from payment_providers where user_id = uid and provider = p_provider for update;
  if not found then raise exception 'Unknown provider.' using errcode = 'P0001'; end if;
  if r.status = 'coming_soon' then raise exception '% is not available yet.', r.display_name using errcode = 'P0001'; end if;
  if not r.is_enabled then raise exception 'Enable % before making it the primary provider.', r.display_name using errcode = 'P0001'; end if;
  update payment_providers set is_primary = false, updated_at = now() where user_id = uid and is_primary and id <> r.id;
  update payment_providers set is_primary = true, updated_at = now() where id = r.id;
  perform finance_audit(uid, 'set_primary', 'payment_provider', r.id, null, jsonb_build_object('provider', p_provider));
end
$$;

-- ---------------------------------------------------------------------------
-- 4b. Admin RPCs: checkout sessions (the /pay/{token} link)
-- Amount and currency are DERIVED from the invoice here. The token is returned once.
-- ---------------------------------------------------------------------------
create or replace function public.payments_create_checkout_session(p_invoice uuid, p_amount numeric default null, p_expires_days int default 14)
returns table (session_id uuid, token text, amount numeric, currency text, expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := payments_require_admin();
  inv invoices%rowtype; v_ccy text; v_out numeric; v_amt numeric; v_token text; v_id uuid; v_exp timestamptz;
begin
  perform finance_init_user(uid);
  select * into inv from invoices where id = p_invoice for update;
  if not found or inv.user_id <> uid then raise exception 'Invoice not found.' using errcode = 'P0001'; end if;
  if coalesce(inv.doc_type, 'invoice') not in ('invoice', 'proforma') then
    raise exception 'Only invoices and proformas can have a payment link.' using errcode = 'P0001';
  end if;
  if exists (select 1 from invoices x where x.converted_from_id = inv.id) then
    raise exception 'This document was superseded by a later invoice or receipt. Use the latest document.' using errcode = 'P0001';
  end if;
  if coalesce(inv.amount, 0) <= 0 then raise exception 'This invoice has no amount to collect.' using errcode = 'P0001'; end if;

  v_ccy := finance_ccy_code(inv.currency);
  v_out := round(payments_invoice_outstanding(inv.id), 2);
  if v_out <= 0.005 then raise exception 'This invoice has no outstanding balance.' using errcode = 'P0001'; end if;
  v_amt := round(coalesce(p_amount, v_out), 2);
  if v_amt <= 0 then raise exception 'Enter an amount greater than zero.' using errcode = 'P0001'; end if;
  if v_amt > v_out + 0.005 then
    raise exception 'The amount % exceeds the outstanding balance of %.', v_amt, v_out using errcode = 'P0001';
  end if;
  if p_expires_days is null or p_expires_days < 1 or p_expires_days > 90 then
    raise exception 'Link expiry must be between 1 and 90 days.' using errcode = 'P0001';
  end if;
  v_exp := now() + make_interval(days => p_expires_days);

  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');   -- 64 hex chars, 244 random bits
  insert into payment_checkout_sessions (user_id, invoice_id, token_hash, token_hint, amount, currency, expires_at)
  values (uid, inv.id, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), right(v_token, 4), v_amt, v_ccy, v_exp)
  returning id into v_id;
  perform finance_audit(uid, 'create', 'payment_checkout_session', v_id, null,
    jsonb_build_object('invoice_id', inv.id, 'amount', v_amt, 'currency', v_ccy, 'expires_at', v_exp));
  return query select v_id, v_token, v_amt, v_ccy, v_exp;
end
$$;

create or replace function public.payments_cancel_checkout_session(p_session uuid)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := payments_require_admin(); s payment_checkout_sessions%rowtype;
begin
  select * into s from payment_checkout_sessions where id = p_session and user_id = uid for update;
  if not found then raise exception 'Payment link not found.' using errcode = 'P0001'; end if;
  if s.status <> 'open' then raise exception 'Only an open payment link can be cancelled.' using errcode = 'P0001'; end if;
  update payment_checkout_sessions set status = 'cancelled', updated_at = now() where id = s.id;
  perform finance_audit(uid, 'cancel', 'payment_checkout_session', s.id, null, jsonb_build_object('invoice_id', s.invoice_id));
end
$$;

-- ---------------------------------------------------------------------------
-- 5. PUBLIC checkout view (anonymous). Returns the minimum the page needs.
-- Never returns: user_id, invoice_id, internal ids, provider settings, other invoices.
-- A bad, expired or unknown token all look the same: {"found": false}.
-- ---------------------------------------------------------------------------
create or replace function public.payments_public_checkout(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s payment_checkout_sessions%rowtype; inv invoices%rowtype; v_client text; v_status text; v_methods jsonb;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return jsonb_build_object('found', false); end if;
  select * into s from payment_checkout_sessions where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found then return jsonb_build_object('found', false); end if;
  select * into inv from invoices where id = s.invoice_id;
  if not found then return jsonb_build_object('found', false); end if;
  select coalesce(client, '') into v_client from projects where id = inv.project_id;

  v_status := s.status;
  if v_status = 'open' and s.expires_at <= now() then v_status := 'expired'; end if;
  if v_status = 'open' and round(payments_invoice_outstanding(inv.id), 2) <= 0.005 then v_status := 'paid'; end if;

  -- Only providers that are enabled AND connected are ever offered to a client.
  select coalesce(jsonb_agg(jsonb_build_object('provider', p.provider, 'name', p.display_name, 'primary', p.is_primary)
                            order by p.is_primary desc, p.provider), '[]'::jsonb)
    into v_methods
  from payment_providers p
  where p.user_id = s.user_id and p.is_enabled and p.status = 'connected';

  return jsonb_build_object(
    'found', true,
    'status', v_status,
    'invoice_number', inv.invoice_number,
    'client_name', coalesce(v_client, ''),
    'amount', s.amount,
    'currency', s.currency,
    'expires_at', s.expires_at,
    'methods', case when v_status = 'open' then v_methods else '[]'::jsonb end
  );
end
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on function public.payments_list_providers() from public, anon;
revoke all on function public.payments_set_provider_enabled(text, boolean) from public, anon;
revoke all on function public.payments_set_primary_provider(text) from public, anon;
revoke all on function public.payments_create_checkout_session(uuid, numeric, int) from public, anon;
revoke all on function public.payments_cancel_checkout_session(uuid) from public, anon;
grant execute on function public.payments_list_providers() to authenticated;
grant execute on function public.payments_set_provider_enabled(text, boolean) to authenticated;
grant execute on function public.payments_set_primary_provider(text) to authenticated;
grant execute on function public.payments_create_checkout_session(uuid, numeric, int) to authenticated;
grant execute on function public.payments_cancel_checkout_session(uuid) to authenticated;

revoke all on function public.payments_public_checkout(text) from public;
grant execute on function public.payments_public_checkout(text) to anon, authenticated;
