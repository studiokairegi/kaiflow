-- Force KES-only Paystack initialization for this merchant.
-- Keeps original invoice currency/amount in the quote and settlement records; only the charge is KES.
-- Safe to apply after 20261026090000_checkout_quotes_wise_manual.sql.

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
  -- This merchant's Paystack account is KES-only. Never trust a stale/local currency
  -- capability setting to send EUR, GBP, JPY or USD to Paystack.
  if not ((v_ps.settings -> 'currencies') ? 'KES') then
    raise exception 'Paystack is configured for KSh collection. Enable KES in the Paystack provider settings, then retry.' using errcode = 'P0001';
  end if;
  v_charge_ccy := 'KES';
  v_conv := v_ccy <> 'KES';

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
  -- Charge this Paystack merchant in KES only, regardless of stale invoice-currency flags.
  if not ((v_ps.settings -> 'currencies') ? 'KES') then
    raise exception 'Paystack is configured for KSh collection. Enable KES in the Paystack provider settings, then retry.' using errcode = 'P0001';
  end if;
  v_need_conv := v_ccy <> 'KES';
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

-- Keep the quote and checkout preparation RPCs callable only by the server-side service role.
revoke all on function public.payments_quote_create(text, text) from public, anon, authenticated;
revoke all on function public.payments_checkout_prepare(text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.payments_quote_create(text, text) to service_role;
grant execute on function public.payments_checkout_prepare(text, text, text, text, uuid) to service_role;
