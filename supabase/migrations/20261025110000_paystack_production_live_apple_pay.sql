-- =============================================================================
-- Paystack production hardening: LIVE-only public checkout + Apple Pay channel
-- =============================================================================
-- Forward-only migration. Historical test/sandbox rows remain untouched and auditable,
-- but no new production checkout session can be created for the test environment.
-- Apple Pay is opt-in merchant configuration; it is never assumed to be enabled.
-- =============================================================================

alter table paystack_transactions drop constraint if exists paystack_transactions_requested_channel_check;
alter table paystack_transactions add constraint paystack_transactions_requested_channel_check
  check (requested_channel in ('card', 'bank_transfer', 'apple_pay'));

create or replace function public.payments_set_paystack_options(p_channels text[], p_currencies text[])
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := payments_require_admin(); c text;
begin
  if p_channels is null or cardinality(p_channels) = 0 then raise exception 'Choose at least one payment channel.' using errcode = 'P0001'; end if;
  foreach c in array p_channels loop
    if c not in ('card', 'bank_transfer', 'apple_pay') then raise exception 'Unsupported channel %.', c using errcode = 'P0001'; end if;
  end loop;
  if p_currencies is null or cardinality(p_currencies) = 0 then raise exception 'Choose at least one currency.' using errcode = 'P0001'; end if;
  foreach c in array p_currencies loop
    if c not in ('KES', 'USD', 'NGN', 'GHS', 'ZAR') then raise exception 'Paystack cannot collect %.', c using errcode = 'P0001'; end if;
  end loop;
  update payment_providers
     set settings = settings || jsonb_build_object('channels', to_jsonb(p_channels), 'currencies', to_jsonb(p_currencies)),
         updated_at = now()
   where user_id = uid and provider = 'paystack';
  if not found then raise exception 'Connect Paystack first.' using errcode = 'P0001'; end if;
  perform finance_audit(uid, 'configure', 'payment_provider', null, null,
    jsonb_build_object('provider', 'paystack', 'channels', p_channels, 'currencies', p_currencies));
end
$$;

-- New payment links are production-only. Existing sandbox links remain stored for audit/history.
create or replace function public.payments_create_checkout_session(p_invoice uuid, p_amount numeric default null, p_expires_days int default 14)
returns table (session_id uuid, token text, amount numeric, currency text, expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := payments_require_admin();
  inv invoices%rowtype; v_ccy text; v_out numeric; v_amt numeric; v_token text; v_id uuid; v_exp timestamptz;
  v_ps payment_providers%rowtype;
begin
  perform finance_init_user(uid);
  select * into inv from invoices where id = p_invoice for update;
  if not found or inv.user_id <> uid then raise exception 'Invoice not found.' using errcode = 'P0001'; end if;
  if coalesce(inv.doc_type, 'invoice') not in ('invoice', 'proforma') then raise exception 'Only invoices and proformas can have a payment link.' using errcode = 'P0001'; end if;
  if exists (select 1 from invoices x where x.converted_from_id = inv.id) then raise exception 'This document was superseded by a later invoice or receipt. Use the latest document.' using errcode = 'P0001'; end if;
  if coalesce(inv.amount, 0) <= 0 then raise exception 'This invoice has no amount to collect.' using errcode = 'P0001'; end if;

  v_ccy := finance_ccy_code(inv.currency);
  v_out := round(payments_invoice_outstanding(inv.id), 2);
  if v_out <= 0.005 then raise exception 'This invoice has no outstanding balance.' using errcode = 'P0001'; end if;
  v_amt := round(coalesce(p_amount, v_out), 2);
  if v_amt <= 0 then raise exception 'Enter an amount greater than zero.' using errcode = 'P0001'; end if;
  if v_amt > v_out + 0.005 then raise exception 'The amount % exceeds the outstanding balance of %.', v_amt, v_out using errcode = 'P0001'; end if;
  if p_expires_days is null or p_expires_days < 1 or p_expires_days > 90 then raise exception 'Link expiry must be between 1 and 90 days.' using errcode = 'P0001'; end if;
  v_exp := now() + make_interval(days => p_expires_days);

  select * into v_ps from payment_providers
   where user_id = uid and provider = 'paystack' and is_enabled and status = 'connected' and environment = 'live';
  if not found then raise exception 'Connect Paystack Live before creating a client payment link.' using errcode = 'P0001'; end if;

  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into payment_checkout_sessions (user_id, invoice_id, token_hash, token_hint, amount, currency, expires_at, environment)
  values (uid, inv.id, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), right(v_token, 4), v_amt, v_ccy, v_exp, 'live')
  returning id into v_id;
  perform finance_audit(uid, 'create', 'payment_checkout_session', v_id, null,
    jsonb_build_object('invoice_id', inv.id, 'amount', v_amt, 'currency', v_ccy, 'expires_at', v_exp, 'environment', 'live'));
  return query select v_id, v_token, v_amt, v_ccy, v_exp;
end
$$;

-- Public checkout exposes only live sessions. Test records remain in the database but are not a
-- production payment surface.
create or replace function public.payments_public_checkout(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  s payment_checkout_sessions%rowtype; inv invoices%rowtype; v_client text; v_status text; v_methods jsonb := '[]'::jsonb;
  v_ps payment_providers%rowtype; v_open boolean; v_ccy text;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return jsonb_build_object('found', false); end if;
  select * into s from payment_checkout_sessions where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found or s.environment <> 'live' then return jsonb_build_object('found', false); end if;
  select * into inv from invoices where id = s.invoice_id;
  if not found then return jsonb_build_object('found', false); end if;
  select coalesce(client, '') into v_client from projects where id = inv.project_id;
  v_ccy := finance_ccy_code(inv.currency);

  v_status := s.status;
  if v_status = 'open' and s.expires_at <= now() then v_status := 'expired'; end if;
  if v_status = 'open' and v_ccy <> s.currency then v_status := 'expired'; end if;
  if v_status = 'open' and round(payments_invoice_outstanding(inv.id), 2) <= 0.005 then v_status := 'paid'; end if;
  select exists (select 1 from paystack_transactions x where x.invoice_id = inv.id and x.environment = 'live'
                  and x.status in ('initialized', 'pending') and x.checkout_session_id is not null) into v_open;
  if v_status = 'open' and v_open then v_status := 'pending'; end if;

  select * into v_ps from payment_providers
   where user_id = s.user_id and provider = 'paystack' and is_enabled and status = 'connected' and environment = 'live';
  if found and (v_ps.settings -> 'currencies') ? s.currency then
    if (v_ps.settings -> 'channels') ? 'card' then
      v_methods := v_methods || jsonb_build_array(jsonb_build_object('provider', 'paystack', 'channel', 'card', 'name', 'Card', 'enabled', true));
    end if;
    if (v_ps.settings -> 'channels') ? 'bank_transfer' then
      v_methods := v_methods || jsonb_build_array(jsonb_build_object('provider', 'paystack', 'channel', 'bank_transfer', 'name', 'Bank transfer', 'enabled', true));
    end if;
    if (v_ps.settings -> 'channels') ? 'apple_pay' then
      v_methods := v_methods || jsonb_build_array(jsonb_build_object('provider', 'paystack', 'channel', 'apple_pay', 'name', 'Apple Pay', 'enabled', true));
    end if;
  end if;

  return jsonb_build_object(
    'found', true, 'status', v_status, 'invoice_number', inv.invoice_number, 'client_name', coalesce(v_client, ''),
    'amount', s.amount, 'currency', s.currency, 'expires_at', s.expires_at,
    'methods', case when v_status in ('open', 'pending') then v_methods else '[]'::jsonb end
  );
end
$$;

create or replace function public.payments_checkout_prepare(p_token text, p_email text, p_environment text, p_channel text)
returns table (action text, transaction_id uuid, reference text, amount numeric, currency text, authorization_url text, invoice_number text)
language plpgsql security definer set search_path = public as $$
declare
  s payment_checkout_sessions%rowtype; inv invoices%rowtype; v_ccy text; v_out numeric; v_ref text; v_tx uuid; v_client text;
  t paystack_transactions%rowtype; v_ps payment_providers%rowtype;
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
  if not ((v_ps.settings -> 'currencies') ? s.currency) then raise exception 'Online payment in % is not available for this invoice.', s.currency using errcode = 'P0001'; end if;
  if not ((v_ps.settings -> 'channels') ? p_channel) then raise exception 'That payment method is not available.' using errcode = 'P0001'; end if;
  if p_email is null or p_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' or length(p_email) > 254 then raise exception 'Enter a valid email address for your payment receipt.' using errcode = 'P0001'; end if;

  select x.* into t from paystack_transactions x
   where x.invoice_id = inv.id and x.environment = 'live' and x.status in ('initialized', 'pending')
   order by x.created_at desc limit 1;
  if found then
    if t.authorization_url is not null and t.requested_channel = p_channel and t.created_at > now() - interval '30 minutes' and t.checkout_session_id = s.id then
      return query select 'reuse'::text, t.id, t.reference, t.amount, t.currency, t.authorization_url, inv.invoice_number;
    else
      return query select 'verify_first'::text, t.id, t.reference, t.amount, t.currency, null::text, inv.invoice_number;
    end if;
    return;
  end if;

  select coalesce(client, '') into v_client from projects where id = inv.project_id;
  v_ref := 'KRL-L-' || upper(left(replace(inv.id::text, '-', ''), 8)) || '-' || upper(substr(md5(random()::text || clock_timestamp()::text || s.id::text), 1, 10));
  insert into paystack_transactions (user_id, environment, reference, invoice_id, invoice_number, project_id, client_name, customer_email,
                                     amount, currency, checkout_session_id, requested_channel)
  values (s.user_id, 'live', v_ref, inv.id, inv.invoice_number, inv.project_id, coalesce(v_client, ''), lower(btrim(p_email)),
          s.amount, v_ccy, s.id, p_channel)
  returning id into v_tx;
  update payment_checkout_sessions set selected_provider = 'paystack', updated_at = now() where id = s.id;
  perform finance_audit(s.user_id, 'initiate', 'paystack_transaction', v_tx, null,
    jsonb_build_object('reference', v_ref, 'invoice_id', inv.id, 'amount', s.amount, 'currency', v_ccy, 'environment', 'live', 'channel', p_channel));
  return query select 'new'::text, v_tx, v_ref, s.amount, v_ccy, null::text, inv.invoice_number;
end
$$;

-- Production clients may execute only the anonymous checkout view; internal service RPCs stay locked down.
revoke all on function public.payments_public_checkout(text) from public;
grant execute on function public.payments_public_checkout(text) to anon, authenticated;
revoke all on function public.payments_set_paystack_options(text[], text[]) from public, anon;
grant execute on function public.payments_set_paystack_options(text[], text[]) to authenticated;
revoke all on function public.payments_create_checkout_session(uuid, numeric, int) from public, anon;
grant execute on function public.payments_create_checkout_session(uuid, numeric, int) to authenticated;
