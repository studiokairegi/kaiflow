-- Client language for invoices and payment links (English / Japanese).
--
--  * invoices.language              what the client receives: the PDF and, through the payment link, the checkout.
--  * payment_checkout_sessions.language
--                                   copied onto each link when it is created (explicit choice, else the invoice's
--                                   language), so a link keeps the language it was sent in even if the invoice
--                                   is switched later. The public checkout view returns it.
--
-- Safe to re-run. Existing invoices and links become 'en', exactly how they behaved before.
-- Only the database, not the browser, decides which language a link carries: an unknown value is refused.

alter table public.invoices
  add column if not exists language text not null default 'en';
alter table public.payment_checkout_sessions
  add column if not exists language text not null default 'en';

-- Japanese versions of the studio's invoice payment instructions / footer note (printed on Japanese invoices;
-- when empty the English text is printed).
alter table public.user_settings add column if not exists invoice_payment_instructions_ja text not null default '';
alter table public.user_settings add column if not exists invoice_footer_note_ja text not null default '';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'invoices_language_check') then
    alter table public.invoices add constraint invoices_language_check check (language in ('en', 'ja'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'payment_sessions_language_check') then
    alter table public.payment_checkout_sessions add constraint payment_sessions_language_check check (language in ('en', 'ja'));
  end if;
end
$$;

-- The return type gains a column, so the old 3-argument function is replaced rather than overloaded
-- (an overload would make named-argument RPC calls ambiguous). Calls with 3 arguments still work: p_language defaults.
drop function if exists public.payments_create_checkout_session(uuid, numeric, int);

create or replace function public.payments_create_checkout_session(p_invoice uuid, p_amount numeric default null, p_expires_days int default 14, p_language text default null)
returns table (session_id uuid, token text, amount numeric, currency text, expires_at timestamptz, language text)
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := payments_require_admin();
  inv invoices%rowtype; v_ccy text; v_out numeric; v_amt numeric; v_token text; v_id uuid; v_exp timestamptz;
  v_ps payment_providers%rowtype; v_lang text;
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

  -- The link's language: explicit choice, else the invoice's own language, else English.
  v_lang := lower(coalesce(nullif(btrim(p_language), ''), inv.language, 'en'));
  if v_lang not in ('en', 'ja') then raise exception 'Unsupported client language.' using errcode = 'P0001'; end if;

  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into payment_checkout_sessions (user_id, invoice_id, token_hash, token_hint, amount, currency, expires_at, environment, language)
  values (uid, inv.id, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), right(v_token, 4), v_amt, v_ccy, v_exp, 'live', v_lang)
  returning id into v_id;
  perform finance_audit(uid, 'create', 'payment_checkout_session', v_id, null,
    jsonb_build_object('invoice_id', inv.id, 'amount', v_amt, 'currency', v_ccy, 'expires_at', v_exp, 'environment', 'live', 'language', v_lang));
  return query select v_id, v_token, v_amt, v_ccy, v_exp, v_lang;
end
$$;

revoke all on function public.payments_create_checkout_session(uuid, numeric, int, text) from public, anon;
grant execute on function public.payments_create_checkout_session(uuid, numeric, int, text) to authenticated;

-- Public checkout view: identical to 20261026090000 plus the link's language.
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
    'amount', s.amount, 'currency', s.currency, 'expires_at', s.expires_at, 'language', s.language,
    'original_amount', inv.amount, 'outstanding', v_out,
    'methods', case when v_status in ('open', 'pending') then v_methods else '[]'::jsonb end
  );
end
$$;

revoke all on function public.payments_public_checkout(text) from public;
grant execute on function public.payments_public_checkout(text) to anon, authenticated;

-- Milestone invoices are created through this RPC with a fixed column list; carry the language through.
-- Same body and privileges as migration_audit_fixes_8.sql (SECURITY INVOKER, rows owned by auth.uid()), plus language.
create or replace function public.create_milestone_invoices(p_rows jsonb)
returns setof invoices
language plpgsql
set search_path = public
as $$
begin
  return query
    insert into invoices (user_id, project_id, invoice_number, description, amount, amount_paid, currency, issue_date, due_date, status, paid_date, language)
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
      coalesce(r->>'paidDate', ''),
      case when lower(coalesce(r->>'language', '')) = 'ja' then 'ja' else 'en' end
    from jsonb_array_elements(p_rows) as r
    returning *;
end;
$$;

revoke all on function public.create_milestone_invoices(jsonb) from public;
grant execute on function public.create_milestone_invoices(jsonb) to authenticated;
