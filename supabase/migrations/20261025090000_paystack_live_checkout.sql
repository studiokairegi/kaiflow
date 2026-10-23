-- =============================================================================
-- Paystack LIVE checkout (replaces the sandbox-only guard)
-- =============================================================================
-- Builds on 20261018090000 (paystack_transactions, apply/verify/refund) and
-- 20261021090000 (payment_checkout_sessions, payment_providers).
--
-- What changes
--   1. paystack_transactions.environment may be 'test' OR 'live'. Every row, event and checkout
--      session is tagged, and every function refuses to mix environments.
--   2. A checkout session (the Pay Now link) carries its environment. A link created in test mode
--      cannot start a live charge and vice versa.
--   3. HARD duplicate-charge guard: at most ONE open (initialized/pending) session-linked attempt
--      per invoice and environment, enforced by a partial unique index, and payments_checkout_prepare
--      serialises concurrent callers with row locks on the session and the invoice.
--   4. Service-role-only RPCs used by the public checkout Edge Function:
--        payments_checkout_prepare(token, email, environment, channel)
--        payments_checkout_status(token, reference)
--   5. payments_apply_verification now takes the environment the verification was made in and
--      refuses a mismatch. A settled payment is still never downgraded.
--   6. Paystack channel/currency availability is configuration (payment_providers.settings),
--      never assumed in code.
--
-- Nothing here stores a secret key. Idempotent: safe to re-run.
-- NOTE: this file has not been executed against a database in the authoring environment.
-- Run supabase/tests/run.sh (needs Postgres 16) before deploying.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Environment on attempts, events and sessions
-- ---------------------------------------------------------------------------
alter table paystack_transactions drop constraint if exists paystack_transactions_environment_check;
alter table paystack_transactions add constraint paystack_transactions_environment_check
  check (environment in ('test', 'live'));

alter table paystack_transactions add column if not exists checkout_session_id uuid references payment_checkout_sessions(id) on delete set null;
alter table paystack_transactions add column if not exists requested_channel text not null default 'card'
  check (requested_channel in ('card', 'bank_transfer'));
create index if not exists paystack_tx_session_idx on paystack_transactions(checkout_session_id);

alter table paystack_webhook_events add column if not exists environment text not null default 'test'
  check (environment in ('test', 'live'));

alter table payment_checkout_sessions add column if not exists environment text not null default 'test'
  check (environment in ('test', 'live'));

-- The duplicate-charge stop: one open attempt per invoice and environment for checkout links.
create unique index if not exists paystack_tx_one_open_per_invoice_uidx
  on paystack_transactions(invoice_id, environment)
  where checkout_session_id is not null and status in ('initialized', 'pending');

-- ---------------------------------------------------------------------------
-- 2. Checkout sessions now record their environment (copied from the Paystack provider row).
--    Same rules as before; the token is still returned once and only its hash is stored.
-- ---------------------------------------------------------------------------
create or replace function public.payments_create_checkout_session(p_invoice uuid, p_amount numeric default null, p_expires_days int default 14)
returns table (session_id uuid, token text, amount numeric, currency text, expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := payments_require_admin();
  inv invoices%rowtype; v_ccy text; v_out numeric; v_amt numeric; v_token text; v_id uuid; v_exp timestamptz; v_env text;
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

  -- 'live' only when the Paystack provider has been connected in live mode; anything else is test.
  select case when pp.environment = 'live' then 'live' else 'test' end into v_env
    from payment_providers pp where pp.user_id = uid and pp.provider = 'paystack';
  v_env := coalesce(v_env, 'test');

  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');   -- 64 hex chars, 244 random bits
  insert into payment_checkout_sessions (user_id, invoice_id, token_hash, token_hint, amount, currency, expires_at, environment)
  values (uid, inv.id, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), right(v_token, 4), v_amt, v_ccy, v_exp, v_env)
  returning id into v_id;
  perform finance_audit(uid, 'create', 'payment_checkout_session', v_id, null,
    jsonb_build_object('invoice_id', inv.id, 'amount', v_amt, 'currency', v_ccy, 'expires_at', v_exp, 'environment', v_env));
  return query select v_id, v_token, v_amt, v_ccy, v_exp;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Provider connection (called by the paystack-payments Edge Function with the service role,
--    only after the server confirmed the secret key works against Paystack's API).
--    Channels and currencies are what the admin says the merchant account has enabled.
-- ---------------------------------------------------------------------------
create or replace function public.payments_connect_paystack(p_user uuid, p_environment text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_environment not in ('test', 'live') then raise exception 'Invalid environment.' using errcode = 'P0001'; end if;
  insert into payment_providers (user_id, provider, display_name, status, is_enabled, is_primary, environment, settings, connected_at)
  values (p_user, 'paystack', 'Paystack', 'connected', true, false,
          case p_environment when 'live' then 'live' else 'sandbox' end,
          jsonb_build_object('channels', jsonb_build_array('card'), 'currencies', jsonb_build_array('KES')), now())
  on conflict (user_id, provider) do update set
    status = 'connected', is_enabled = true,
    environment = case p_environment when 'live' then 'live' else 'sandbox' end,
    connected_at = now(), updated_at = now(),
    settings = case when payment_providers.settings ? 'channels' then payment_providers.settings
                    else payment_providers.settings || jsonb_build_object('channels', jsonb_build_array('card'), 'currencies', jsonb_build_array('KES')) end;
  -- Paystack is the default provider; Wise (if present) is demoted, never deleted.
  update payment_providers set is_primary = false, updated_at = now() where user_id = p_user and is_primary and provider <> 'paystack';
  update payment_providers set is_primary = true, updated_at = now() where user_id = p_user and provider = 'paystack';
  perform finance_audit(p_user, 'connect', 'payment_provider', null, null,
    jsonb_build_object('provider', 'paystack', 'environment', p_environment));
end
$$;

-- Admin sets which channels/currencies the Paystack merchant account actually has enabled.
create or replace function public.payments_set_paystack_options(p_channels text[], p_currencies text[])
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := payments_require_admin(); c text;
begin
  if p_channels is null or cardinality(p_channels) = 0 then raise exception 'Choose at least one payment channel.' using errcode = 'P0001'; end if;
  foreach c in array p_channels loop
    if c not in ('card', 'bank_transfer') then raise exception 'Unsupported channel %.', c using errcode = 'P0001'; end if;
  end loop;
  if p_currencies is null or cardinality(p_currencies) = 0 then raise exception 'Choose at least one currency.' using errcode = 'P0001'; end if;
  foreach c in array p_currencies loop
    if c not in ('KES', 'USD', 'NGN', 'GHS', 'ZAR') then raise exception 'Paystack cannot collect %.', c using errcode = 'P0001'; end if;
  end loop;
  update payment_providers set settings = settings || jsonb_build_object('channels', to_jsonb(p_channels), 'currencies', to_jsonb(p_currencies)), updated_at = now()
   where user_id = uid and provider = 'paystack';
  if not found then raise exception 'Connect Paystack first.' using errcode = 'P0001'; end if;
  perform finance_audit(uid, 'configure', 'payment_provider', null, null,
    jsonb_build_object('provider', 'paystack', 'channels', p_channels, 'currencies', p_currencies));
end
$$;

-- ---------------------------------------------------------------------------
-- 4. PUBLIC checkout view (anonymous). Adds: pending state, offered Paystack channels for THIS
--    invoice currency, and PayPal/Payoneer as visible-but-disabled entries.
-- ---------------------------------------------------------------------------
create or replace function public.payments_public_checkout(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  s payment_checkout_sessions%rowtype; inv invoices%rowtype; v_client text; v_status text; v_methods jsonb := '[]'::jsonb;
  v_ps payment_providers%rowtype; v_open boolean; v_ccy text;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return jsonb_build_object('found', false); end if;
  select * into s from payment_checkout_sessions where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found then return jsonb_build_object('found', false); end if;
  select * into inv from invoices where id = s.invoice_id;
  if not found then return jsonb_build_object('found', false); end if;
  select coalesce(client, '') into v_client from projects where id = inv.project_id;
  v_ccy := finance_ccy_code(inv.currency);

  v_status := s.status;
  if v_status = 'open' and s.expires_at <= now() then v_status := 'expired'; end if;
  if v_status = 'open' and v_ccy <> s.currency then v_status := 'expired'; end if;   -- invoice changed since the link was made
  if v_status = 'open' and round(payments_invoice_outstanding(inv.id), 2) <= 0.005 then v_status := 'paid'; end if;
  select exists (select 1 from paystack_transactions x where x.invoice_id = inv.id and x.environment = s.environment
                  and x.status in ('initialized', 'pending') and x.checkout_session_id is not null) into v_open;
  if v_status = 'open' and v_open then v_status := 'pending'; end if;

  select * into v_ps from payment_providers
   where user_id = s.user_id and provider = 'paystack' and is_enabled and status = 'connected'
     and environment = case s.environment when 'live' then 'live' else 'sandbox' end;
  if found and (v_ps.settings -> 'currencies') ? s.currency then
    if (v_ps.settings -> 'channels') ? 'card' then
      v_methods := v_methods || jsonb_build_array(jsonb_build_object('provider', 'paystack', 'channel', 'card', 'name', 'Card', 'enabled', true));
    end if;
    if (v_ps.settings -> 'channels') ? 'bank_transfer' then
      v_methods := v_methods || jsonb_build_array(jsonb_build_object('provider', 'paystack', 'channel', 'bank_transfer', 'name', 'Bank transfer', 'enabled', true));
    end if;
  end if;
  v_methods := v_methods
    || jsonb_build_array(jsonb_build_object('provider', 'paypal', 'channel', 'paypal', 'name', 'PayPal', 'enabled', false, 'note', 'Coming soon — not configured'))
    || jsonb_build_array(jsonb_build_object('provider', 'payoneer', 'channel', 'payoneer', 'name', 'Payoneer', 'enabled', false, 'note', 'Coming soon — not configured'));

  return jsonb_build_object(
    'found', true,
    'status', v_status,
    'invoice_number', inv.invoice_number,
    'client_name', coalesce(v_client, ''),
    'amount', s.amount,
    'currency', s.currency,
    'expires_at', s.expires_at,
    'methods', case when v_status in ('open', 'pending') then v_methods else '[]'::jsonb end
  );
end
$$;

-- ---------------------------------------------------------------------------
-- 5. Prepare a charge from a checkout TOKEN (service role only; called by the public Edge Function).
--    Amount and currency come from the session and the invoice, never from the request.
--    Returns an action so the Edge Function never starts a second charge blindly:
--      'new'          a fresh attempt row was created; initialise it with Paystack
--      'reuse'        a recent open attempt with a checkout URL exists; send the client back to it
--      'verify_first' an open attempt exists whose outcome is unknown; verify it with Paystack
--                     before anything else (a timeout never means "failed")
-- ---------------------------------------------------------------------------
create or replace function public.payments_checkout_prepare(p_token text, p_email text, p_environment text, p_channel text)
returns table (action text, transaction_id uuid, reference text, amount numeric, currency text, authorization_url text, invoice_number text)
language plpgsql security definer set search_path = public as $$
declare
  s payment_checkout_sessions%rowtype; inv invoices%rowtype; v_ccy text; v_out numeric; v_ref text; v_tx uuid; v_client text;
  t paystack_transactions%rowtype; v_ps payment_providers%rowtype;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then raise exception 'This payment link is not valid.' using errcode = 'P0001'; end if;
  if p_environment not in ('test', 'live') then raise exception 'Invalid environment.' using errcode = 'P0001'; end if;
  if p_channel not in ('card', 'bank_transfer') then raise exception 'Choose a payment method.' using errcode = 'P0001'; end if;

  -- Serialise everything for this link and this invoice.
  select * into s from payment_checkout_sessions where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex') for update;
  if not found then raise exception 'This payment link is not valid.' using errcode = 'P0001'; end if;
  if s.environment <> p_environment then raise exception 'This payment link is not valid.' using errcode = 'P0001'; end if;
  if s.status <> 'open' then raise exception 'This payment link is no longer open.' using errcode = 'P0001'; end if;
  if s.expires_at <= now() then raise exception 'This payment link has expired.' using errcode = 'P0001'; end if;

  select * into inv from invoices where id = s.invoice_id for update;
  if not found then raise exception 'This payment link is not valid.' using errcode = 'P0001'; end if;
  if exists (select 1 from invoices x where x.converted_from_id = inv.id) then
    raise exception 'This invoice was replaced by a newer document. Please ask for a new payment link.' using errcode = 'P0001';
  end if;
  v_ccy := finance_ccy_code(inv.currency);
  if v_ccy <> s.currency then raise exception 'This invoice changed after the link was created. Please ask for a new payment link.' using errcode = 'P0001'; end if;

  v_out := round(payments_invoice_outstanding(inv.id), 2);
  if v_out <= 0.005 then raise exception 'This invoice has already been paid.' using errcode = 'P0001'; end if;
  if s.amount > v_out + 0.005 then
    raise exception 'The balance on this invoice changed. Please ask for a new payment link.' using errcode = 'P0001';
  end if;

  select * into v_ps from payment_providers
   where user_id = s.user_id and provider = 'paystack' and is_enabled and status = 'connected'
     and environment = case s.environment when 'live' then 'live' else 'sandbox' end;
  if not found then raise exception 'Online payment is not available for this invoice right now.' using errcode = 'P0001'; end if;
  if not ((v_ps.settings -> 'currencies') ? s.currency) then
    raise exception 'Online payment in % is not available for this invoice.', s.currency using errcode = 'P0001';
  end if;
  if not ((v_ps.settings -> 'channels') ? p_channel) then
    raise exception 'That payment method is not available.' using errcode = 'P0001';
  end if;
  if p_email is null or p_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' or length(p_email) > 254 then
    raise exception 'Enter a valid email address for your payment receipt.' using errcode = 'P0001';
  end if;

  -- An open attempt on this invoice (ANY link, same environment) decides what happens next.
  select x.* into t from paystack_transactions x
   where x.invoice_id = inv.id and x.environment = s.environment and x.status in ('initialized', 'pending')
   order by x.created_at desc limit 1;
  if found then
    if t.authorization_url is not null and t.requested_channel = p_channel and t.created_at > now() - interval '30 minutes'
       and t.checkout_session_id = s.id then
      return query select 'reuse'::text, t.id, t.reference, t.amount, t.currency, t.authorization_url, inv.invoice_number;
    else
      return query select 'verify_first'::text, t.id, t.reference, t.amount, t.currency, null::text, inv.invoice_number;
    end if;
    return;
  end if;

  select coalesce(client, '') into v_client from projects where id = inv.project_id;
  v_ref := case s.environment when 'live' then 'KRL-L-' else 'KRL-T-' end
           || upper(left(replace(inv.id::text, '-', ''), 8)) || '-' || upper(substr(md5(random()::text || clock_timestamp()::text || s.id::text), 1, 10));
  insert into paystack_transactions (user_id, environment, reference, invoice_id, invoice_number, project_id, client_name, customer_email,
                                     amount, currency, checkout_session_id, requested_channel)
  values (s.user_id, s.environment, v_ref, inv.id, inv.invoice_number, inv.project_id, coalesce(v_client, ''), lower(btrim(p_email)),
          s.amount, v_ccy, s.id, p_channel)
  returning id into v_tx;
  update payment_checkout_sessions set selected_provider = 'paystack', updated_at = now() where id = s.id;
  perform finance_audit(s.user_id, 'initiate', 'paystack_transaction', v_tx, null,
    jsonb_build_object('reference', v_ref, 'invoice_id', inv.id, 'amount', s.amount, 'currency', v_ccy, 'environment', s.environment, 'channel', p_channel));
  return query select 'new'::text, v_tx, v_ref, s.amount, v_ccy, null::text, inv.invoice_number;
end
$$;

-- Status for the return page and the "check my payment" button. Token proves access; the reference is
-- optional and only honoured if it belongs to this session's invoice.
create or replace function public.payments_checkout_status(p_token text, p_reference text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s payment_checkout_sessions%rowtype; inv invoices%rowtype; t paystack_transactions%rowtype; v_out numeric;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return jsonb_build_object('found', false); end if;
  select * into s from payment_checkout_sessions where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found then return jsonb_build_object('found', false); end if;
  select * into inv from invoices where id = s.invoice_id;
  if not found then return jsonb_build_object('found', false); end if;
  if p_reference is not null and p_reference <> '' then
    select * into t from paystack_transactions where reference = p_reference and invoice_id = s.invoice_id and checkout_session_id = s.id;
  else
    select * into t from paystack_transactions where invoice_id = s.invoice_id and checkout_session_id = s.id
     order by created_at desc limit 1;
  end if;
  v_out := round(payments_invoice_outstanding(inv.id), 2);
  return jsonb_build_object(
    'found', true,
    'environment', s.environment,
    'session_status', s.status,
    'invoice_number', inv.invoice_number,
    'amount', s.amount,
    'currency', s.currency,
    'invoice_paid', v_out <= 0.005,
    'reference', t.reference,
    'transaction_status', t.status,
    'applied', coalesce(t.apply_status = 'applied', false)
  );
end
$$;

-- ---------------------------------------------------------------------------
-- 6. Environment-aware apply / verify / refund. Same behaviour as the sandbox versions plus:
--    live labels, session closure, and an environment check on every entry point.
-- ---------------------------------------------------------------------------
create or replace function public.payments_apply_to_invoice(p_tx uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  t paystack_transactions%rowtype; inv invoices%rowtype; v_ccy text; v_cash record; v_entry uuid; v_pay uuid;
  v_exp uuid; v_date date; v_client text; v_label text;
begin
  select * into t from paystack_transactions where id = p_tx for update;
  if t.invoice_payment_id is not null then return; end if;                        -- already applied
  if t.status <> 'success' then raise exception 'Only a verified successful payment can be applied.' using errcode = 'P0001'; end if;
  v_label := case t.environment when 'live' then 'Paystack' else 'Paystack (test mode)' end;
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
  values (t.user_id, inv.id, inv.invoice_number, t.amount, v_ccy, v_date, v_label, v_cash.bank_id, t.reference, v_entry)
  returning id into v_pay;
  perform finance_sync_invoice_paid(inv.id);

  -- Actual fee only, once. Separate from the invoice amount; the expense trigger posts the ledger entry.
  if coalesce(t.fee_actual, 0) > 0 and t.fee_expense_id is null then
    insert into expenses (user_id, project_id, category, description, amount, currency, date, vendor, bank_account_id, reference, notes)
    values (t.user_id, inv.project_id, 'Payment processing fees',
            'Paystack fee ' || case t.environment when 'live' then '' else '(TEST) ' end || t.reference,
            t.fee_actual, v_ccy, to_char(v_date, 'YYYY-MM-DD'), 'Paystack', v_cash.bank_id, t.reference,
            'Actual fee reported by Paystack for ' || coalesce(nullif(inv.invoice_number, ''), 'invoice')
              || case t.environment when 'live' then '.' else '. Test data, not real money.' end)
    returning id into v_exp;
  end if;

  update paystack_transactions set
    invoice_payment_id = v_pay, fee_expense_id = coalesce(v_exp, fee_expense_id),
    apply_status = 'applied', apply_error = '', reconciliation_status = 'matched', reconciled_at = now(), updated_at = now()
  where id = t.id;
  -- Close the link that produced this payment.
  if t.checkout_session_id is not null then
    update payment_checkout_sessions set status = 'paid', paid_at = coalesce(t.paid_at, now()), updated_at = now()
     where id = t.checkout_session_id and status = 'open';
  end if;
  perform finance_audit(t.user_id, 'apply', 'paystack_transaction', t.id, null,
    jsonb_build_object('invoice_payment_id', v_pay, 'amount', t.amount, 'fee', t.fee_actual, 'currency', v_ccy, 'environment', t.environment));
end
$$;

-- The old nine-argument signature is replaced (only the Edge Functions call it).
drop function if exists public.payments_apply_verification(text, text, bigint, text, bigint, text, text, timestamptz, text);

create or replace function public.payments_apply_verification(
  p_reference text, p_environment text, p_outcome text, p_amount_minor bigint, p_currency text, p_fee_minor bigint,
  p_channel text, p_paystack_id text, p_paid_at timestamptz, p_gateway text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare t paystack_transactions%rowtype; v_amount numeric; v_err text;
begin
  select * into t from paystack_transactions where reference = p_reference for update;
  if not found then raise exception 'Unknown payment reference.' using errcode = 'P0001'; end if;
  -- A verification made with a test key can never settle a live row, or the reverse.
  if t.environment is distinct from p_environment then
    raise exception 'Environment mismatch: transaction is %, verification was %.', t.environment, p_environment using errcode = 'P0001';
  end if;

  if p_outcome <> 'success' then
    -- A settled payment is never downgraded by a late "failed"/"pending" answer.
    if t.status in ('success', 'refunded', 'partially_refunded') or t.invoice_payment_id is not null or p_outcome = 'reversed' then
      return jsonb_build_object('status', t.status, 'changed', false, 'applied', t.apply_status = 'applied');
    end if;
    update paystack_transactions set
      status = case p_outcome when 'failed' then 'failed' when 'abandoned' then 'abandoned' else 'pending' end,
      gateway_response = coalesce(p_gateway, ''), verified_at = now(), updated_at = now()
    where id = t.id returning * into t;
    perform finance_audit(t.user_id, 'verify', 'paystack_transaction', t.id, null, jsonb_build_object('outcome', p_outcome, 'environment', t.environment));
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
    -- Paystack says paid but the ledger could not take it (e.g. the invoice was settled another way meanwhile).
    -- Keep the facts and flag for Reconciliation: money is never silently dropped or double counted.
    update paystack_transactions set apply_status = 'failed', apply_error = left(coalesce(v_err, ''), 500),
      reconciliation_status = 'needs_review', updated_at = now() where id = t.id;
    perform finance_audit(t.user_id, 'apply_failed', 'paystack_transaction', t.id, null, jsonb_build_object('error', left(coalesce(v_err, ''), 500)));
  end;

  select * into t from paystack_transactions where id = t.id;
  return jsonb_build_object('status', t.status, 'changed', true, 'applied', t.apply_status = 'applied', 'apply_status', t.apply_status, 'apply_error', t.apply_error);
end
$$;

create or replace function public.payments_apply_refund(
  p_reference text, p_amount_minor bigint, p_currency text, p_event_ref text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare t paystack_transactions%rowtype; ip invoice_payments%rowtype; v_amt numeric; v_total numeric; v_note text;
begin
  select * into t from paystack_transactions where reference = p_reference for update;
  if not found then raise exception 'Unknown payment reference.' using errcode = 'P0001'; end if;
  v_note := case t.environment when 'live' then 'Paystack refund ' else 'Paystack refund (test) ' end || t.reference;
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
      perform finance_void_entry(t.user_id, ip.journal_entry_id, v_note);
      update invoice_payments set status = 'void', void_reason = v_note where id = ip.id;
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
    jsonb_build_object('amount', v_amt, 'total_refunded', v_total, 'currency', t.currency, 'environment', t.environment));
  select * into t from paystack_transactions where id = t.id;
  return jsonb_build_object('status', t.status, 'refunded_amount', t.refunded_amount);
end
$$;

-- ---------------------------------------------------------------------------
-- 7. Privileges. Everything new that touches money is service-role only.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in (
             'payments_checkout_prepare', 'payments_checkout_status', 'payments_connect_paystack',
             'payments_apply_verification', 'payments_apply_refund', 'payments_apply_to_invoice') loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname in (
               'payments_checkout_prepare', 'payments_checkout_status', 'payments_connect_paystack',
               'payments_apply_verification', 'payments_apply_refund') loop
      execute format('grant execute on function %s to service_role', r.sig);
    end loop;
  end if;
end
$$;

revoke all on function public.payments_set_paystack_options(text[], text[]) from public, anon;
grant execute on function public.payments_set_paystack_options(text[], text[]) to authenticated;
revoke all on function public.payments_create_checkout_session(uuid, numeric, int) from public, anon;
grant execute on function public.payments_create_checkout_session(uuid, numeric, int) to authenticated;
revoke all on function public.payments_public_checkout(text) from public;
grant execute on function public.payments_public_checkout(text) to anon, authenticated;
