-- ROLLBACK for 20270111090000_invoice_client_language.sql.
-- Restores the previous function definitions (3-argument payment link creation, public checkout view without
-- language, milestone RPC without language) and then removes the language columns.
-- DATA LOSS: invoice / payment-link languages and the Japanese payment instructions / footer note are discarded.
-- Roll the frontend back FIRST (or at the same time): the new frontend sends p_language and the language column.
-- Safe to re-run.

begin;

drop function if exists public.payments_create_checkout_session(uuid, numeric, int, text);
drop function if exists public.payments_create_checkout_session(uuid, numeric, int);

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

revoke all on function public.payments_create_checkout_session(uuid, numeric, int) from public, anon;
grant execute on function public.payments_create_checkout_session(uuid, numeric, int) to authenticated;

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

revoke all on function public.payments_public_checkout(text) from public;
grant execute on function public.payments_public_checkout(text) to anon, authenticated;

create or replace function public.create_milestone_invoices(p_rows jsonb)
returns setof invoices
language plpgsql
set search_path = public
as $$
begin
  return query
    insert into invoices (user_id, project_id, invoice_number, description, amount, amount_paid, currency, issue_date, due_date, status, paid_date)
    select
      auth.uid(),
      (r->>'projectId')::uuid,
      coalesce(r->>'invoiceNumber', ''),
      coalesce(r->>'description', ''),
      coalesce(nullif(r->>'amount', '')::numeric, 0),
      coalesce(nullif(r->>'amountPaid', '')::numeric, 0),
      coalesce(r->>'currency', '$'),
      coalesce(r->>'issueDate', ''),
      coalesce(r->>'dueDate', ''),
      coalesce(nullif(r->>'status', ''), 'unpaid'),
      coalesce(r->>'paidDate', '')
    from jsonb_array_elements(p_rows) as r
    returning *;
end;
$$;

revoke all on function public.create_milestone_invoices(jsonb) from public;
grant execute on function public.create_milestone_invoices(jsonb) to authenticated;

alter table public.invoices drop constraint if exists invoices_language_check;
alter table public.payment_checkout_sessions drop constraint if exists payment_sessions_language_check;
alter table public.invoices drop column if exists language;
alter table public.payment_checkout_sessions drop column if exists language;
alter table public.user_settings drop column if exists invoice_payment_instructions_ja;
alter table public.user_settings drop column if exists invoice_footer_note_ja;

commit;
