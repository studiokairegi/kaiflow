-- =============================================================================
-- Checkout FX quotes, converted-payment settlement, Wise/M-PESA manual payments
-- =============================================================================
-- Builds on 20261025090000 / 20261025110000 (live Paystack checkout).
--
--   1. payment_quotes: a server-made, 15-minute, session-bound quote. The browser never supplies a
--      rate, a converted amount or a currency; it only echoes back a quote id to confirm.
--   2. paystack_transactions keeps `amount`/`currency` = what Paystack CHARGES (so verification and
--      the webhook are unchanged) and gains invoice_amount/invoice_currency = what is SETTLED
--      against the invoice. NULL on historical rows; apply falls back to amount/currency.
--   3. FX source = the existing fx_rates snapshots (same table Finance already uses). No new rate
--      provider. A snapshot older than 36 hours is treated as unavailable and checkout refuses to
--      quote (fail safe) rather than use a stale rate.
--   4. payments_settle_invoice: one settlement path for Paystack AND manual payments. When cash
--      arrives in a different currency from the invoice (e.g. KES for a JPY invoice) cash is
--      posted to the cash currency's account and the invoice is relieved by the quoted invoice
--      amount; the base-currency difference is booked as realized FX gain/loss (same rule as
--      finance_settle). A missing rate raises, which the existing apply-failed -> needs_review
--      path catches, so money is never dropped or double counted.
--   5. Wise/M-PESA: recipient settings live in payment_providers.settings->'manual' (non-secret).
--      payment_manual_payments holds pending/submitted/verified/rejected transfers. Nothing is
--      posted until an administrator verifies.
--
-- Additive and idempotent. No data is dropped. NOT executed against a database in the authoring
-- environment: run supabase/tests/run.sh (Postgres 16) before deploying.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Quotes
-- ---------------------------------------------------------------------------
create table if not exists payment_quotes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  checkout_session_id uuid not null references payment_checkout_sessions(id) on delete cascade,
  invoice_id uuid not null references invoices(id) on delete cascade,
  environment text not null check (environment in ('test', 'live')),
  provider text not null default 'paystack' check (provider in ('paystack')),
  channel text not null check (channel in ('card', 'bank_transfer', 'apple_pay')),
  invoice_currency text not null check (invoice_currency ~ '^[A-Z]{3}$'),
  invoice_outstanding numeric not null check (invoice_outstanding > 0),
  invoice_amount numeric not null check (invoice_amount > 0),            -- paid now, invoice currency
  charge_currency text not null check (charge_currency ~ '^[A-Z]{3}$'),
  converted boolean not null,
  fx_rate numeric check (fx_rate is null or fx_rate > 0),                -- units of charge_currency per 1 invoice_currency
  fx_rate_date date,
  fx_rate_fetched_at timestamptz,
  fx_source text not null default '',
  markup_pct numeric not null default 0 check (markup_pct >= 0),
  fee_amount numeric not null default 0 check (fee_amount >= 0),
  converted_amount numeric not null check (converted_amount > 0),         -- charge currency, before fee
  charge_amount numeric not null check (charge_amount > 0),               -- exactly what Paystack is asked for
  status text not null default 'open' check (status in ('open', 'used', 'superseded')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check (converted or (fx_rate is null and charge_currency = invoice_currency and charge_amount = invoice_amount))
);
create unique index if not exists payment_quotes_one_open_per_session_uidx on payment_quotes(checkout_session_id) where status = 'open';
create index if not exists payment_quotes_session_idx on payment_quotes(checkout_session_id, created_at desc);
alter table payment_quotes enable row level security;
drop policy if exists "Admins read their payment quotes" on payment_quotes;
create policy "Admins read their payment quotes" on payment_quotes for select using (auth.uid() = user_id and public.payments_is_admin());

alter table paystack_transactions add column if not exists quote_id uuid references payment_quotes(id) on delete set null;
alter table paystack_transactions add column if not exists invoice_amount numeric check (invoice_amount is null or invoice_amount > 0);
alter table paystack_transactions add column if not exists invoice_currency text check (invoice_currency is null or invoice_currency ~ '^[A-Z]{3}$');

-- ---------------------------------------------------------------------------
-- 2. FX lookup from the existing snapshots (service use only)
-- ---------------------------------------------------------------------------
create or replace function public.payments_ccy_decimals(p_ccy text)
returns int language sql immutable as $$
  select case upper(coalesce(p_ccy, '')) when 'JPY' then 0 when 'KRW' then 0 when 'UGX' then 0 when 'RWF' then 0 else 2 end
$$;

-- Units of p_to per 1 p_from, derived from the stored per-USD snapshots. Returns NO ROW when either
-- side has no snapshot fetched in the last 36 hours: callers must treat that as "no reliable rate".
create or replace function public.payments_fx_quote_rate(p_user uuid, p_from text, p_to text)
returns table (rate numeric, rate_date date, fetched_at timestamptz, source text)
language plpgsql stable security definer set search_path = public as $$
declare f fx_rates%rowtype; t fx_rates%rowtype; v_f numeric; v_t numeric; v_fd date; v_td date; v_ff timestamptz; v_tf timestamptz; v_src text;
begin
  if p_from = p_to then return; end if;
  if p_from = 'USD' then v_f := 1; v_fd := current_date; v_ff := now(); v_src := 'USD';
  else
    select * into f from fx_rates where user_id = p_user and currency = p_from and created_at >= now() - interval '36 hours'
     order by rate_date desc, created_at desc limit 1;
    if not found then return; end if;
    v_f := f.per_usd; v_fd := f.rate_date; v_ff := f.created_at; v_src := f.source;
  end if;
  if p_to = 'USD' then v_t := 1; v_td := current_date; v_tf := now();
  else
    select * into t from fx_rates where user_id = p_user and currency = p_to and created_at >= now() - interval '36 hours'
     order by rate_date desc, created_at desc limit 1;
    if not found then return; end if;
    v_t := t.per_usd; v_td := t.rate_date; v_tf := t.created_at;
  end if;
  if v_f is null or v_t is null or v_f <= 0 or v_t <= 0 then return; end if;
  return query select round(v_t / v_f, 10), least(v_fd, v_td), least(v_ff, v_tf), coalesce(nullif(v_src, ''), 'stored rate');
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Quote creation (service role, called by the paystack-checkout Edge Function)
-- ---------------------------------------------------------------------------
create or replace function public.payments_quote_create(p_token text, p_channel text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s payment_checkout_sessions%rowtype; inv invoices%rowtype; v_ps payment_providers%rowtype; v_ccy text; v_out numeric;
  v_charge_ccy text; v_conv boolean := false; r record; v_rate numeric; v_converted numeric; v_id uuid; v_exp timestamptz := now() + interval '15 minutes';
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then raise exception 'This payment link is not valid.' using errcode = 'P0001'; end if;
  if p_channel not in ('card', 'bank_transfer', 'apple_pay') then raise exception 'Choose a payment method.' using errcode = 'P0001'; end if;
  select * into s from payment_checkout_sessions where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex') for update;
  if not found or s.environment <> 'live' then raise exception 'This payment link is not valid.' using errcode = 'P0001'; end if;
  if s.status <> 'open' then raise exception 'This payment link is no longer open.' using errcode = 'P0001'; end if;
  if s.expires_at <= now() then raise exception 'This payment link has expired.' using errcode = 'P0001'; end if;
  select * into inv from invoices where id = s.invoice_id for update;
  if not found then raise exception 'This payment link is not valid.' using errcode = 'P0001'; end if;
  if exists (select 1 from invoices x where x.converted_from_id = inv.id) then raise exception 'This invoice was replaced by a newer document. Please ask for a new payment link.' using errcode = 'P0001'; end if;
  v_ccy := finance_ccy_code(inv.currency);
  if v_ccy <> s.currency then raise exception 'This invoice changed after the link was created. Please ask for a new payment link.' using errcode = 'P0001'; end if;
  v_out := round(payments_invoice_outstanding(inv.id), 2);
  if v_out <= 0.005 then raise exception 'This invoice has already been paid.' using errcode = 'P0001'; end if;
  if s.amount > v_out + 0.005 then raise exception 'The balance on this invoice changed. Please ask for a new payment link.' using errcode = 'P0001'; end if;

  select * into v_ps from payment_providers where user_id = s.user_id and provider = 'paystack' and is_enabled and status = 'connected' and environment = 'live';
  if not found or not ((v_ps.settings -> 'channels') ? p_channel) then raise exception 'That payment method is not available.' using errcode = 'P0001'; end if;
  if (v_ps.settings -> 'currencies') ? v_ccy then
    v_charge_ccy := v_ccy;
  elsif (v_ps.settings -> 'currencies') ? 'KES' then
    v_charge_ccy := 'KES'; v_conv := true;
  else
    raise exception 'Online payment is not available for this invoice.' using errcode = 'P0001';
  end if;

  update payment_quotes set status = 'superseded' where checkout_session_id = s.id and status = 'open';

  if not v_conv then
    insert into payment_quotes (user_id, checkout_session_id, invoice_id, environment, channel, invoice_currency, invoice_outstanding, invoice_amount,
                                charge_currency, converted, converted_amount, charge_amount, expires_at)
    values (s.user_id, s.id, inv.id, 'live', p_channel, v_ccy, v_out, s.amount, v_ccy, false, s.amount, s.amount, v_exp)
    returning id into v_id;
    return jsonb_build_object('quote_id', v_id, 'converted', false, 'invoice_currency', v_ccy, 'invoice_amount', s.amount, 'invoice_outstanding', v_out,
                              'charge_currency', v_ccy, 'charge_amount', s.amount, 'expires_at', v_exp, 'channel', p_channel);
  end if;

  select * into r from payments_fx_quote_rate(s.user_id, v_ccy, v_charge_ccy);
  if r.rate is null then
    raise exception 'We can’t show a reliable currency conversion right now. Please try again later or contact Studio Kairegi.' using errcode = 'P0001', detail = 'fx_unavailable';
  end if;
  v_rate := r.rate;
  v_converted := round(s.amount * v_rate, payments_ccy_decimals(v_charge_ccy));
  if v_converted <= 0 then raise exception 'This amount is too small to convert.' using errcode = 'P0001'; end if;

  insert into payment_quotes (user_id, checkout_session_id, invoice_id, environment, channel, invoice_currency, invoice_outstanding, invoice_amount,
                              charge_currency, converted, fx_rate, fx_rate_date, fx_rate_fetched_at, fx_source, markup_pct, fee_amount, converted_amount, charge_amount, expires_at)
  values (s.user_id, s.id, inv.id, 'live', p_channel, v_ccy, v_out, s.amount, v_charge_ccy, true, v_rate, r.rate_date, r.fetched_at, r.source, 0, 0, v_converted, v_converted, v_exp)
  returning id into v_id;
  perform finance_audit(s.user_id, 'quote', 'payment_quote', v_id, null,
    jsonb_build_object('invoice_id', inv.id, 'invoice_amount', s.amount, 'invoice_currency', v_ccy, 'charge_amount', v_converted, 'charge_currency', v_charge_ccy, 'rate', v_rate));
  return jsonb_build_object('quote_id', v_id, 'converted', true, 'invoice_currency', v_ccy, 'invoice_amount', s.amount, 'invoice_outstanding', v_out,
    'charge_currency', v_charge_ccy, 'fx_rate', v_rate, 'fx_base', v_ccy, 'fx_quote', v_charge_ccy, 'fx_rate_date', r.rate_date, 'fx_rate_fetched_at', r.fetched_at,
    'fx_source', r.source, 'markup_pct', 0, 'fee_amount', 0, 'converted_amount', v_converted, 'charge_amount', v_converted, 'expires_at', v_exp, 'channel', p_channel);
end
$$;

-- ---------------------------------------------------------------------------
-- 4. Prepare: now quote-aware. The old 4-argument form is replaced (only the Edge Function calls it).
--    amount/currency returned = the Paystack CHARGE. A quote is required whenever conversion applies.
-- ---------------------------------------------------------------------------
drop function if exists public.payments_checkout_prepare(text, text, text, text);

create or replace function public.payments_checkout_prepare(p_token text, p_email text, p_environment text, p_channel text, p_quote uuid default null)
returns table (action text, transaction_id uuid, reference text, amount numeric, currency text, authorization_url text, invoice_number text,
               invoice_amount numeric, invoice_currency text, quote_id uuid)
language plpgsql security definer set search_path = public as $$
declare
  s payment_checkout_sessions%rowtype; inv invoices%rowtype; v_ccy text; v_out numeric; v_ref text; v_tx uuid; v_client text;
  t paystack_transactions%rowtype; v_ps payment_providers%rowtype; q payment_quotes%rowtype; v_need_conv boolean;
  v_charge numeric; v_charge_ccy text;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then raise exception 'This payment link is not valid.' using errcode = 'P0001'; end if;
  if p_environment <> 'live' then raise exception 'This payment link is not valid.' using errcode = 'P0001'; end if;
  if p_channel not in ('card', 'bank_transfer', 'apple_pay') then raise exception 'Choose a payment method.' using errcode = 'P0001'; end if;

  select * into s from payment_checkout_sessions where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex') for update;
  if not found or s.environment <> 'live' then raise exception 'This payment link is not valid.' using errcode = 'P0001'; end if;
  if s.status <> 'open' then raise exception 'This payment link is no longer open.' using errcode = 'P0001'; end if;
  if s.expires_at <= now() then raise exception 'This payment link has expired.' using errcode = 'P0001'; end if;

  select * into inv from invoices where id = s.invoice_id for update;
  if not found then raise exception 'This payment link is not valid.' using errcode = 'P0001'; end if;
  if exists (select 1 from invoices x where x.converted_from_id = inv.id) then raise exception 'This invoice was replaced by a newer document. Please ask for a new payment link.' using errcode = 'P0001'; end if;
  v_ccy := finance_ccy_code(inv.currency);
  if v_ccy <> s.currency then raise exception 'This invoice changed after the link was created. Please ask for a new payment link.' using errcode = 'P0001'; end if;

  v_out := round(payments_invoice_outstanding(inv.id), 2);
  if v_out <= 0.005 then raise exception 'This invoice has already been paid.' using errcode = 'P0001'; end if;
  if s.amount > v_out + 0.005 then raise exception 'The balance on this invoice changed. Please ask for a new payment link.' using errcode = 'P0001'; end if;

  select * into v_ps from payment_providers
   where user_id = s.user_id and provider = 'paystack' and is_enabled and status = 'connected' and environment = 'live';
  if not found then raise exception 'Online payment is not available for this invoice right now.' using errcode = 'P0001'; end if;
  v_need_conv := not ((v_ps.settings -> 'currencies') ? s.currency);
  if v_need_conv and not ((v_ps.settings -> 'currencies') ? 'KES') then raise exception 'Online payment in % is not available for this invoice.', s.currency using errcode = 'P0001'; end if;
  if not ((v_ps.settings -> 'channels') ? p_channel) then raise exception 'That payment method is not available.' using errcode = 'P0001'; end if;
  if p_email is null or p_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' or length(p_email) > 254 then raise exception 'Enter a valid email address for your payment receipt.' using errcode = 'P0001'; end if;

  -- Existing open attempt: resume it only if it was made from the very quote being confirmed now.
  select x.* into t from paystack_transactions x
   where x.invoice_id = inv.id and x.environment = 'live' and x.status in ('initialized', 'pending')
   order by x.created_at desc limit 1;
  if found then
    if t.authorization_url is not null and t.requested_channel = p_channel and t.created_at > now() - interval '30 minutes' and t.checkout_session_id = s.id
       and t.quote_id is not distinct from p_quote then
      return query select 'reuse'::text, t.id, t.reference, t.amount, t.currency, t.authorization_url, inv.invoice_number, t.invoice_amount, t.invoice_currency, t.quote_id;
    else
      return query select 'verify_first'::text, t.id, t.reference, t.amount, t.currency, null::text, inv.invoice_number, t.invoice_amount, t.invoice_currency, t.quote_id;
    end if;
    return;
  end if;

  if p_quote is null then
    if v_need_conv then raise exception 'Please review the amount and confirm before paying.' using errcode = 'P0001', detail = 'quote_required'; end if;
    v_charge := s.amount; v_charge_ccy := v_ccy;
  else
    select * into q from payment_quotes where id = p_quote for update;
    if not found or q.checkout_session_id <> s.id or q.invoice_id <> inv.id or q.environment <> 'live' then
      raise exception 'This quote does not belong to this payment link. Please review the amount and confirm again.' using errcode = 'P0001', detail = 'quote_invalid';
    end if;
    if q.status = 'superseded' then raise exception 'A newer quote replaced this one. Please review the updated amount and confirm again.' using errcode = 'P0001', detail = 'quote_superseded'; end if;
    if q.status <> 'open' then raise exception 'This quote was already used. Please review the amount and confirm again.' using errcode = 'P0001', detail = 'quote_used'; end if;
    if q.expires_at <= now() then raise exception 'This quote has expired. Please review the updated amount and confirm again.' using errcode = 'P0001', detail = 'quote_expired'; end if;
    if q.channel <> p_channel or q.invoice_currency <> v_ccy or q.invoice_amount <> s.amount or q.invoice_amount > v_out + 0.005
       or q.converted <> v_need_conv or (not q.converted and q.charge_currency <> v_ccy)
       or (q.converted and q.charge_currency <> 'KES') then
      raise exception 'The amount changed. Please review the updated amount and confirm again.' using errcode = 'P0001', detail = 'quote_invalid';
    end if;
    v_charge := q.charge_amount; v_charge_ccy := q.charge_currency;
  end if;

  select coalesce(client, '') into v_client from projects where id = inv.project_id;
  v_ref := 'KRL-L-' || upper(left(replace(inv.id::text, '-', ''), 8)) || '-' || upper(substr(md5(random()::text || clock_timestamp()::text || s.id::text), 1, 10));
  insert into paystack_transactions (user_id, environment, reference, invoice_id, invoice_number, project_id, client_name, customer_email,
                                     amount, currency, checkout_session_id, requested_channel, quote_id, invoice_amount, invoice_currency)
  values (s.user_id, 'live', v_ref, inv.id, inv.invoice_number, inv.project_id, coalesce(v_client, ''), lower(btrim(p_email)),
          v_charge, v_charge_ccy, s.id, p_channel, p_quote, s.amount, v_ccy)
  returning id into v_tx;
  if p_quote is not null then update payment_quotes set status = 'used' where id = p_quote; end if;
  update payment_checkout_sessions set selected_provider = 'paystack', updated_at = now() where id = s.id;
  perform finance_audit(s.user_id, 'initiate', 'paystack_transaction', v_tx, null,
    jsonb_build_object('reference', v_ref, 'invoice_id', inv.id, 'charge_amount', v_charge, 'charge_currency', v_charge_ccy,
                       'invoice_amount', s.amount, 'invoice_currency', v_ccy, 'quote_id', p_quote, 'environment', 'live', 'channel', p_channel));
  return query select 'new'::text, v_tx, v_ref, v_charge, v_charge_ccy, null::text, inv.invoice_number, s.amount, v_ccy, p_quote;
end
$$;

-- ---------------------------------------------------------------------------
-- 5. One settlement path (Paystack + manual). Same-currency = exactly the previous behaviour.
-- ---------------------------------------------------------------------------
create or replace function public.payments_settle_invoice(
  p_user uuid, p_invoice uuid, p_inv_amount numeric, p_cash_ccy text, p_cash_amount numeric, p_date date, p_method text, p_ref text
) returns table (invoice_payment_id uuid, bank_id uuid)
language plpgsql security definer set search_path = public as $$
declare
  inv invoices%rowtype; v_ccy text; v_cash record; v_entry uuid; v_pay uuid; v_client text; v_base text;
  v_ctrl uuid; v_fx uuid; v_pos record; v_open_native numeric; v_open_base numeric; r_inv record; r_cash record;
  v_bank_base numeric; v_release numeric; v_diff numeric; v_lines jsonb;
begin
  select * into inv from invoices where id = p_invoice for update;
  if not found or inv.user_id <> p_user then raise exception 'The invoice for this payment no longer exists.' using errcode = 'P0001'; end if;
  v_ccy := finance_ccy_code(inv.currency);
  select coalesce(client, '') into v_client from projects where id = inv.project_id;
  select * into v_cash from finance_cash_account_for(p_user, p_cash_ccy, null);
  perform finance_post_invoice(inv.id, false);

  if p_cash_ccy = v_ccy then
    v_entry := finance_settle(p_user, 'invoice', inv.id, v_ccy, inv.project_id, coalesce(v_client, ''), inv.invoice_number,
                              p_inv_amount, p_date, v_cash.account_id, v_cash.bank_id, false);
  else
    if round(p_cash_amount, 2) <> p_cash_amount or p_cash_amount <= 0 then raise exception 'Invalid received amount.' using errcode = 'P0001'; end if;
    select base_currency into v_base from finance_settings where user_id = p_user;
    v_ctrl := finance_sys_account(p_user, 'ar'); v_fx := finance_sys_account(p_user, 'fx_gain_loss');
    select * into v_pos from finance_doc_position(p_user, v_ctrl, inv.id);
    v_open_native := v_pos.native; v_open_base := v_pos.base;
    if p_inv_amount > v_open_native + 0.005 then
      raise exception 'Payment of % exceeds the outstanding balance of %.', round(p_inv_amount, 2), round(v_open_native, 2) using errcode = 'P0001';
    end if;
    select * into r_inv from finance_fx_to_base(p_user, v_ccy, p_date) f limit 1;
    select * into r_cash from finance_fx_to_base(p_user, p_cash_ccy, p_date) f limit 1;
    if v_pos.any_missing or r_inv.rate is null or r_cash.rate is null then
      raise exception 'No exchange rate is stored to book a % payment against a % invoice. Add the rate under Settings > FX, then retry.', p_cash_ccy, v_ccy using errcode = 'P0001';
    end if;
    v_bank_base := round(p_cash_amount * r_cash.rate, 2);
    v_release := case when abs(p_inv_amount - v_open_native) <= 0.005 then v_open_base else round(v_open_base * p_inv_amount / v_open_native, 2) end;
    v_diff := v_bank_base - v_release;
    v_lines := jsonb_build_array(
      jsonb_build_object('account_id', v_cash.account_id, 'currency', p_cash_ccy, 'debit', p_cash_amount, 'base_debit', v_bank_base, 'bank_account_id', v_cash.bank_id, 'counterparty', coalesce(v_client, '')),
      jsonb_build_object('account_id', v_ctrl, 'currency', v_ccy, 'credit', p_inv_amount, 'base_credit', v_release, 'counterparty', coalesce(v_client, '')));
    if v_diff > 0 then v_lines := v_lines || jsonb_build_object('account_id', v_fx, 'currency', v_base, 'base_credit', v_diff, 'memo', 'Realized FX gain');
    elsif v_diff < 0 then v_lines := v_lines || jsonb_build_object('account_id', v_fx, 'currency', v_base, 'base_debit', -v_diff, 'memo', 'Realized FX loss'); end if;
    v_entry := finance_post_entry(p_user, p_date, 'Payment received - ' || p_ref, p_ref, 'invoice_payment', inv.id, v_ccy, r_inv.rate, r_inv.rate_date, r_inv.source,
                                  inv.project_id, v_lines, false, false);
  end if;

  insert into invoice_payments (user_id, invoice_id, invoice_number, amount, currency, paid_date, method, bank_account_id, reference, journal_entry_id)
  values (p_user, inv.id, inv.invoice_number, p_inv_amount, v_ccy, p_date, p_method, v_cash.bank_id, p_ref, v_entry)
  returning id into v_pay;
  perform finance_sync_invoice_paid(inv.id);
  return query select v_pay, v_cash.bank_id;
end
$$;

create or replace function public.payments_apply_to_invoice(p_tx uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  t paystack_transactions%rowtype; inv invoices%rowtype; v_ccy text; v_inv_amt numeric; v_inv_ccy text; v_set record; v_exp uuid; v_date date; v_label text;
begin
  select * into t from paystack_transactions where id = p_tx for update;
  if t.invoice_payment_id is not null then return; end if;                        -- already applied
  if t.status <> 'success' then raise exception 'Only a verified successful payment can be applied.' using errcode = 'P0001'; end if;
  v_label := case t.environment when 'live' then 'Paystack' else 'Paystack (test mode)' end;
  select * into inv from invoices where id = t.invoice_id for update;
  if not found or inv.user_id <> t.user_id then raise exception 'The invoice for this payment no longer exists.' using errcode = 'P0001'; end if;
  v_ccy := finance_ccy_code(inv.currency);
  v_inv_amt := coalesce(t.invoice_amount, t.amount);
  v_inv_ccy := coalesce(t.invoice_currency, t.currency);
  if v_ccy <> v_inv_ccy then raise exception 'Invoice currency % no longer matches the payment currency %.', v_ccy, v_inv_ccy using errcode = 'P0001'; end if;
  v_date := coalesce(t.paid_at, now())::date;

  select * into v_set from payments_settle_invoice(t.user_id, inv.id, v_inv_amt, t.currency, t.amount, v_date, v_label, t.reference);

  -- Actual fee only, once, in the currency Paystack charged (the cash currency).
  if coalesce(t.fee_actual, 0) > 0 and t.fee_expense_id is null then
    insert into expenses (user_id, project_id, category, description, amount, currency, date, vendor, bank_account_id, reference, notes)
    values (t.user_id, inv.project_id, 'Payment processing fees',
            'Paystack fee ' || case t.environment when 'live' then '' else '(TEST) ' end || t.reference,
            t.fee_actual, t.currency, to_char(v_date, 'YYYY-MM-DD'), 'Paystack', v_set.bank_id, t.reference,
            'Actual fee reported by Paystack for ' || coalesce(nullif(inv.invoice_number, ''), 'invoice')
              || case t.environment when 'live' then '.' else '. Test data, not real money.' end)
    returning id into v_exp;
  end if;

  update paystack_transactions set
    invoice_payment_id = v_set.invoice_payment_id, fee_expense_id = coalesce(v_exp, fee_expense_id),
    apply_status = 'applied', apply_error = '', reconciliation_status = 'matched', reconciled_at = now(), updated_at = now()
  where id = t.id;
  if t.checkout_session_id is not null then
    update payment_checkout_sessions set status = 'paid', paid_at = coalesce(t.paid_at, now()), updated_at = now()
     where id = t.checkout_session_id and status = 'open';       -- same as before: the link that produced this payment closes
  end if;
  perform finance_audit(t.user_id, 'apply', 'paystack_transaction', t.id, null,
    jsonb_build_object('invoice_payment_id', v_set.invoice_payment_id, 'invoice_amount', v_inv_amt, 'invoice_currency', v_ccy,
                       'charge_amount', t.amount, 'charge_currency', t.currency, 'fee', t.fee_actual, 'environment', t.environment));
end
$$;

-- ---------------------------------------------------------------------------
-- 6. Wise / M-PESA recipient settings (admin) -- non-secret, stored in payment_providers.settings.manual
-- ---------------------------------------------------------------------------
create or replace function public.payments_normalize_phone(p_code text, p_phone text)
returns text language plpgsql immutable as $$
declare v_code text := regexp_replace(coalesce(p_code, ''), '[\s-]', '', 'g'); v_raw text := regexp_replace(coalesce(p_phone, ''), '[\s().-]', '', 'g'); v_out text;
begin
  if v_code !~ '^\+[1-9][0-9]{0,3}$' then return null; end if;
  if v_raw ~ '^\+' then v_out := v_raw;
  elsif v_raw ~ '^00' then v_out := '+' || substr(v_raw, 3);
  elsif v_raw ~ '^0' then v_out := v_code || substr(v_raw, 2);
  elsif v_raw ~ '^[0-9]+$' and left(v_raw, length(v_code) - 1) = substr(v_code, 2) then v_out := '+' || v_raw;   -- already includes the code, no "+"
  elsif v_raw ~ '^[0-9]+$' then v_out := v_code || v_raw;
  else return null; end if;
  if v_out !~ '^\+[1-9][0-9]{7,14}$' then return null; end if;
  if left(v_out, 4) = '+254' and v_out !~ '^\+254[17][0-9]{8}$' then return null; end if;   -- Kenyan mobile numbers only
  return v_out;
end
$$;

create or replace function public.payments_set_wise_manual(p_settings jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid uuid := payments_require_admin(); v_name text := btrim(coalesce(p_settings ->> 'recipient_name', '')); v_country text := btrim(coalesce(p_settings ->> 'country', ''));
  v_mobile text := btrim(coalesce(p_settings ->> 'mobile_provider', '')); v_code text := btrim(coalesce(p_settings ->> 'calling_code', '+254'));
  v_phone text; v_enabled boolean := coalesce((p_settings ->> 'enabled')::boolean, false); v_instr text := left(btrim(coalesce(p_settings ->> 'instructions', '')), 1000);
  v_support text := left(btrim(coalesce(p_settings ->> 'support_contact', '')), 200); v_complete boolean; v_manual jsonb;
begin
  v_phone := payments_normalize_phone(v_code, p_settings ->> 'phone');
  if coalesce(p_settings ->> 'phone', '') <> '' and v_phone is null then raise exception 'That is not a valid mobile number for the country code %.', v_code using errcode = 'P0001'; end if;
  if length(v_name) > 120 or length(v_country) > 80 or length(v_mobile) > 60 then raise exception 'One of the fields is too long.' using errcode = 'P0001'; end if;
  v_complete := v_name <> '' and v_country <> '' and v_mobile <> '' and v_phone is not null;
  if v_enabled and not v_complete then raise exception 'Fill in the recipient name, country, mobile provider and a valid number before enabling Wise.' using errcode = 'P0001'; end if;
  v_manual := jsonb_build_object('enabled', v_enabled, 'complete', v_complete, 'recipient_name', v_name, 'country', v_country, 'mobile_provider', v_mobile,
                                 'calling_code', v_code, 'phone', v_phone, 'instructions', v_instr, 'support_contact', v_support);
  insert into payment_providers (user_id, provider, display_name, integration_model, status, is_enabled, is_primary, settings)
  values (uid, 'wise', 'Wise', 'manual_mpesa', 'not_connected', false, false, jsonb_build_object('manual', v_manual))
  on conflict (user_id, provider) do update set settings = payment_providers.settings || jsonb_build_object('manual', v_manual), updated_at = now();
  perform finance_audit(uid, 'configure', 'payment_provider', null, null, jsonb_build_object('provider', 'wise', 'enabled', v_enabled, 'complete', v_complete));
  return v_manual;
end
$$;

-- ---------------------------------------------------------------------------
-- 7. Manual (Wise) payments. Pending -> submitted -> verified | rejected. Nothing posts until verified.
-- ---------------------------------------------------------------------------
create table if not exists payment_manual_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  checkout_session_id uuid not null references payment_checkout_sessions(id) on delete cascade,
  invoice_id uuid not null references invoices(id) on delete cascade,
  provider text not null default 'wise' check (provider in ('wise')),
  reference text not null unique,
  amount numeric not null check (amount > 0),                                   -- invoice currency, as requested
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'pending' check (status in ('pending', 'submitted', 'verified', 'rejected', 'cancelled')),
  payer_email text not null default '',
  payer_name text not null default '',
  transfer_reference text,
  payer_note text not null default '',
  submitted_at timestamptz,
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  review_note text not null default '',
  credited_amount numeric check (credited_amount is null or credited_amount > 0),   -- invoice currency actually credited
  received_amount numeric check (received_amount is null or received_amount > 0),
  received_currency text check (received_currency is null or received_currency ~ '^[A-Z]{3}$'),
  invoice_payment_id uuid references invoice_payments(id) on delete set null,
  apply_status text not null default 'none' check (apply_status in ('none', 'applied', 'failed')),
  apply_error text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists manual_one_open_per_session_uidx on payment_manual_payments(checkout_session_id) where status in ('pending', 'submitted');
create unique index if not exists manual_transfer_ref_uidx on payment_manual_payments(user_id, lower(transfer_reference)) where transfer_reference is not null and status in ('submitted', 'verified');
create unique index if not exists manual_invoice_payment_uidx on payment_manual_payments(invoice_payment_id) where invoice_payment_id is not null;
create index if not exists manual_user_idx on payment_manual_payments(user_id, created_at desc);
alter table payment_manual_payments enable row level security;
drop policy if exists "Admins read their manual payments" on payment_manual_payments;
create policy "Admins read their manual payments" on payment_manual_payments for select using (auth.uid() = user_id and public.payments_is_admin());

-- Public/service: client chooses Wise. Idempotent per session: returns the same open record.
create or replace function public.payments_manual_start(p_token text, p_email text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s payment_checkout_sessions%rowtype; inv invoices%rowtype; v_ccy text; v_out numeric; v_w payment_providers%rowtype; m jsonb; mp payment_manual_payments%rowtype; v_ref text;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then raise exception 'This payment link is not valid.' using errcode = 'P0001'; end if;
  select * into s from payment_checkout_sessions where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex') for update;
  if not found or s.environment <> 'live' then raise exception 'This payment link is not valid.' using errcode = 'P0001'; end if;
  if s.status <> 'open' then raise exception 'This payment link is no longer open.' using errcode = 'P0001'; end if;
  if s.expires_at <= now() then raise exception 'This payment link has expired.' using errcode = 'P0001'; end if;
  select * into inv from invoices where id = s.invoice_id for update;
  if not found or exists (select 1 from invoices x where x.converted_from_id = inv.id) then raise exception 'This payment link is not valid.' using errcode = 'P0001'; end if;
  v_ccy := finance_ccy_code(inv.currency);
  if v_ccy <> s.currency then raise exception 'This invoice changed after the link was created. Please ask for a new payment link.' using errcode = 'P0001'; end if;
  v_out := round(payments_invoice_outstanding(inv.id), 2);
  if v_out <= 0.005 then raise exception 'This invoice has already been paid.' using errcode = 'P0001'; end if;
  if s.amount > v_out + 0.005 then raise exception 'The balance on this invoice changed. Please ask for a new payment link.' using errcode = 'P0001'; end if;

  select * into v_w from payment_providers where user_id = s.user_id and provider = 'wise';
  m := v_w.settings -> 'manual';
  if not found or m is null or coalesce((m ->> 'enabled')::boolean, false) is not true or coalesce((m ->> 'complete')::boolean, false) is not true then
    raise exception 'Wise transfers are not available for this invoice.' using errcode = 'P0001';
  end if;
  if p_email is not null and p_email <> '' and (p_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' or length(p_email) > 254) then raise exception 'Enter a valid email address.' using errcode = 'P0001'; end if;

  select * into mp from payment_manual_payments where checkout_session_id = s.id and status in ('pending', 'submitted');
  if not found then
    v_ref := 'KRL-W-' || upper(left(replace(inv.id::text, '-', ''), 8)) || '-' || upper(substr(md5(random()::text || clock_timestamp()::text || s.id::text), 1, 10));
    insert into payment_manual_payments (user_id, checkout_session_id, invoice_id, reference, amount, currency, payer_email)
    values (s.user_id, s.id, inv.id, v_ref, s.amount, v_ccy, lower(btrim(coalesce(p_email, ''))))
    returning * into mp;
    update payment_checkout_sessions set selected_provider = 'wise', updated_at = now() where id = s.id;
    perform finance_audit(s.user_id, 'initiate', 'manual_payment', mp.id, null, jsonb_build_object('reference', v_ref, 'invoice_id', inv.id, 'amount', s.amount, 'currency', v_ccy));
  end if;
  return jsonb_build_object('reference', mp.reference, 'status', mp.status, 'amount', mp.amount, 'currency', mp.currency, 'invoice_number', inv.invoice_number,
    'invoice_outstanding', v_out, 'original_amount', inv.amount,
    'recipient_name', m ->> 'recipient_name', 'country', m ->> 'country', 'mobile_provider', m ->> 'mobile_provider', 'phone', m ->> 'phone',
    'instructions', coalesce(m ->> 'instructions', ''), 'support_contact', coalesce(m ->> 'support_contact', ''), 'transfer_reference', mp.transfer_reference);
end
$$;

-- Public/service: the client says "I sent it". Evidence only; the invoice is untouched.
create or replace function public.payments_manual_submit(p_token text, p_reference text, p_transfer_ref text, p_payer_name text, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s payment_checkout_sessions%rowtype; mp payment_manual_payments%rowtype; v_tr text := btrim(coalesce(p_transfer_ref, ''));
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then raise exception 'This payment link is not valid.' using errcode = 'P0001'; end if;
  if v_tr = '' or length(v_tr) < 4 or length(v_tr) > 80 then raise exception 'Enter the transfer reference from Wise (4–80 characters).' using errcode = 'P0001'; end if;
  select * into s from payment_checkout_sessions where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found then raise exception 'This payment link is not valid.' using errcode = 'P0001'; end if;
  select * into mp from payment_manual_payments where reference = p_reference and checkout_session_id = s.id for update;
  if not found then raise exception 'We could not find that transfer. Please start again from the payment page.' using errcode = 'P0001'; end if;
  if mp.status = 'verified' then return jsonb_build_object('status', 'verified'); end if;
  if mp.status not in ('pending', 'submitted') then raise exception 'This transfer is no longer open.' using errcode = 'P0001'; end if;
  if exists (select 1 from payment_manual_payments x where x.user_id = mp.user_id and lower(x.transfer_reference) = lower(v_tr) and x.status in ('submitted', 'verified') and x.id <> mp.id) then
    raise exception 'That transfer reference has already been submitted.' using errcode = 'P0001';
  end if;
  update payment_manual_payments set status = 'submitted', transfer_reference = v_tr, payer_name = left(btrim(coalesce(p_payer_name, '')), 120),
    payer_note = left(btrim(coalesce(p_note, '')), 500), submitted_at = coalesce(submitted_at, now()), updated_at = now() where id = mp.id;
  perform finance_audit(mp.user_id, 'submit', 'manual_payment', mp.id, null, jsonb_build_object('reference', mp.reference));
  return jsonb_build_object('status', 'submitted', 'reference', mp.reference);
end
$$;

-- Admin: verify (funds actually arrived) or reject. Verified payments apply EXACTLY once.
create or replace function public.payments_manual_review(p_id uuid, p_decision text, p_credited_amount numeric default null,
  p_received_amount numeric default null, p_received_currency text default null, p_note text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid uuid := payments_require_admin(); mp payment_manual_payments%rowtype; inv invoices%rowtype; v_cred numeric; v_rcv numeric; v_rccy text; v_set record; v_err text;
begin
  select * into mp from payment_manual_payments where id = p_id for update;
  if not found or mp.user_id <> uid then raise exception 'Transfer not found.' using errcode = 'P0001'; end if;
  if p_decision not in ('verify', 'reject') then raise exception 'Choose verify or reject.' using errcode = 'P0001'; end if;
  if mp.status = 'verified' then
    if p_decision = 'verify' then return jsonb_build_object('status', 'verified', 'duplicate', true); end if;
    raise exception 'A verified transfer cannot be rejected. Reverse the invoice payment instead.' using errcode = 'P0001';
  end if;
  if mp.status not in ('pending', 'submitted') then raise exception 'This transfer is already closed.' using errcode = 'P0001'; end if;

  if p_decision = 'reject' then
    update payment_manual_payments set status = 'rejected', reviewed_by = uid, reviewed_at = now(), review_note = left(coalesce(p_note, ''), 500), updated_at = now() where id = mp.id;
    perform finance_audit(uid, 'reject', 'manual_payment', mp.id, null, jsonb_build_object('reference', mp.reference));
    return jsonb_build_object('status', 'rejected');
  end if;

  if mp.status <> 'submitted' then raise exception 'Verify a transfer only after the client has submitted it.' using errcode = 'P0001'; end if;
  v_cred := round(coalesce(p_credited_amount, mp.amount), 2);
  if v_cred <= 0 or v_cred > mp.amount + 0.005 then raise exception 'The credited amount must be between 0 and %.', mp.amount using errcode = 'P0001'; end if;
  v_rccy := upper(coalesce(nullif(p_received_currency, ''), mp.currency));
  if v_rccy !~ '^[A-Z]{3}$' then raise exception 'Enter the currency that arrived.' using errcode = 'P0001'; end if;
  v_rcv := round(coalesce(p_received_amount, case when v_rccy = mp.currency then v_cred end), 2);
  if v_rcv is null or v_rcv <= 0 then raise exception 'Enter the amount that actually arrived.' using errcode = 'P0001'; end if;
  select * into inv from invoices where id = mp.invoice_id for update;
  if not found or inv.user_id <> uid then raise exception 'The invoice for this transfer no longer exists.' using errcode = 'P0001'; end if;
  if v_rccy = mp.currency and v_rcv <> v_cred then raise exception 'When the transfer arrives in the invoice currency the received and credited amounts must match.' using errcode = 'P0001'; end if;

  begin
    select * into v_set from payments_settle_invoice(uid, inv.id, v_cred, v_rccy, v_rcv, current_date, 'Wise to M-PESA', mp.reference);
  exception when others then
    get stacked diagnostics v_err = message_text;
    raise exception 'Could not record this payment: %', v_err using errcode = 'P0001';   -- whole statement rolls back; the transfer stays "submitted"
  end;
  update payment_manual_payments set status = 'verified', reviewed_by = uid, reviewed_at = now(), review_note = left(coalesce(p_note, ''), 500),
    credited_amount = v_cred, received_amount = v_rcv, received_currency = v_rccy, invoice_payment_id = v_set.invoice_payment_id, apply_status = 'applied', updated_at = now()
   where id = mp.id;
  update payment_checkout_sessions set status = 'paid', paid_at = now(), updated_at = now()
   where id = mp.checkout_session_id and status = 'open';
  perform finance_audit(uid, 'verify', 'manual_payment', mp.id, null,
    jsonb_build_object('reference', mp.reference, 'credited', v_cred, 'invoice_currency', mp.currency, 'received', v_rcv, 'received_currency', v_rccy, 'invoice_payment_id', v_set.invoice_payment_id));
  return jsonb_build_object('status', 'verified', 'invoice_payment_id', v_set.invoice_payment_id);
end
$$;

-- ---------------------------------------------------------------------------
-- 8. Public checkout view: conversion flags + Wise (last). Replaces the previous definition.
-- ---------------------------------------------------------------------------
create or replace function public.payments_public_checkout(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  s payment_checkout_sessions%rowtype; inv invoices%rowtype; v_client text; v_status text; v_methods jsonb := '[]'::jsonb;
  v_ps payment_providers%rowtype; v_w payment_providers%rowtype; v_open boolean; v_ccy text; v_charge text; v_conv boolean; v_out numeric; m jsonb;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return jsonb_build_object('found', false); end if;
  select * into s from payment_checkout_sessions where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found or s.environment <> 'live' then return jsonb_build_object('found', false); end if;
  select * into inv from invoices where id = s.invoice_id;
  if not found then return jsonb_build_object('found', false); end if;
  select coalesce(client, '') into v_client from projects where id = inv.project_id;
  v_ccy := finance_ccy_code(inv.currency);
  v_out := round(payments_invoice_outstanding(inv.id), 2);

  v_status := s.status;
  if v_status = 'open' and s.expires_at <= now() then v_status := 'expired'; end if;
  if v_status = 'open' and v_ccy <> s.currency then v_status := 'expired'; end if;
  if v_status = 'open' and v_out <= 0.005 then v_status := 'paid'; end if;
  select exists (select 1 from paystack_transactions x where x.invoice_id = inv.id and x.environment = 'live'
                  and x.status in ('initialized', 'pending') and x.checkout_session_id is not null) into v_open;
  if v_status = 'open' and v_open then v_status := 'pending'; end if;

  select * into v_ps from payment_providers
   where user_id = s.user_id and provider = 'paystack' and is_enabled and status = 'connected' and environment = 'live';
  if found then
    v_conv := not ((v_ps.settings -> 'currencies') ? s.currency);
    v_charge := case when not v_conv then s.currency when (v_ps.settings -> 'currencies') ? 'KES' then 'KES' else null end;
    if v_charge is not null then
      if (v_ps.settings -> 'channels') ? 'card' then
        v_methods := v_methods || jsonb_build_array(jsonb_build_object('provider', 'paystack', 'channel', 'card', 'name', 'Card', 'enabled', true, 'converted', v_conv, 'charge_currency', v_charge));
      end if;
      if (v_ps.settings -> 'channels') ? 'bank_transfer' then
        v_methods := v_methods || jsonb_build_array(jsonb_build_object('provider', 'paystack', 'channel', 'bank_transfer', 'name', 'Bank transfer', 'enabled', true, 'converted', v_conv, 'charge_currency', v_charge));
      end if;
      if (v_ps.settings -> 'channels') ? 'apple_pay' then
        v_methods := v_methods || jsonb_build_array(jsonb_build_object('provider', 'paystack', 'channel', 'apple_pay', 'name', 'Apple Pay', 'enabled', true, 'converted', v_conv, 'charge_currency', v_charge));
      end if;
    end if;
  end if;
  -- Wise is ALWAYS last, and only when explicitly enabled with complete, valid recipient details.
  select * into v_w from payment_providers where user_id = s.user_id and provider = 'wise';
  m := v_w.settings -> 'manual';
  if found and m is not null and coalesce((m ->> 'enabled')::boolean, false) and coalesce((m ->> 'complete')::boolean, false) then
    v_methods := v_methods || jsonb_build_array(jsonb_build_object('provider', 'wise', 'channel', 'wise', 'name', 'Wise', 'enabled', true, 'manual', true));
  end if;

  return jsonb_build_object(
    'found', true, 'status', v_status, 'invoice_number', inv.invoice_number, 'client_name', coalesce(v_client, ''),
    'amount', s.amount, 'currency', s.currency, 'expires_at', s.expires_at,
    'original_amount', inv.amount, 'outstanding', v_out,
    'methods', case when v_status in ('open', 'pending') then v_methods else '[]'::jsonb end
  );
end
$$;

-- ---------------------------------------------------------------------------
-- 9. Grants. Quote / manual-start / manual-submit / prepare are service-role only (Edge Function);
--    review and settings are admin RPCs (they re-check admin inside).
-- ---------------------------------------------------------------------------
revoke all on function public.payments_fx_quote_rate(uuid, text, text) from public, anon, authenticated;
revoke all on function public.payments_quote_create(text, text) from public, anon, authenticated;
revoke all on function public.payments_checkout_prepare(text, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.payments_settle_invoice(uuid, uuid, numeric, text, numeric, date, text, text) from public, anon, authenticated;
revoke all on function public.payments_manual_start(text, text) from public, anon, authenticated;
revoke all on function public.payments_manual_submit(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.payments_apply_to_invoice(uuid) from public, anon, authenticated;
revoke all on function public.payments_manual_review(uuid, text, numeric, numeric, text, text) from public, anon;
grant execute on function public.payments_manual_review(uuid, text, numeric, numeric, text, text) to authenticated;
revoke all on function public.payments_set_wise_manual(jsonb) from public, anon;
grant execute on function public.payments_set_wise_manual(jsonb) to authenticated;
grant execute on function public.payments_normalize_phone(text, text) to authenticated;
revoke all on function public.payments_public_checkout(text) from public;
grant execute on function public.payments_public_checkout(text) to anon, authenticated;

-- Service-only functions are granted explicitly to service_role (same convention as 20261025090000).
do $$
declare r record;
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname in (
               'payments_fx_quote_rate', 'payments_quote_create', 'payments_checkout_prepare', 'payments_manual_start', 'payments_manual_submit') loop
      execute format('grant execute on function %s to service_role', r.sig);
    end loop;
  end if;
end
$$;
