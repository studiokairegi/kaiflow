-- FX quotes, converted-payment settlement and Wise/M-PESA manual payments (migration 20261026090000).
-- Run via supabase/tests/run.sh (needs a superuser on a scratch DB). Prints PASS/FAIL; aborts if any check failed.
-- NOT executed in the authoring environment (no Postgres available there).
drop schema if exists _t cascade;
create schema _t;
grant usage on schema _t to public;
create table _t.results (name text, ok boolean);
create table _t.ctx (k text primary key, v text);
grant all on _t.results, _t.ctx to public;
create function _t.chk(p_name text, p_ok boolean) returns void language plpgsql as $$
begin insert into _t.results values (p_name, coalesce(p_ok, false)); raise notice '%: %', case when coalesce(p_ok, false) then 'PASS' else 'FAIL' end, p_name; end $$;
create function _t.put(p_k text, p_v text) returns void language sql as $$ insert into _t.ctx values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create function _t.get(p_k text) returns text language sql stable as $$ select v from _t.ctx where k = p_k $$;
create function _t.id(p_k text) returns uuid language sql stable as $$ select v::uuid from _t.ctx where k = p_k $$;
create function _t.err(p_sql text) returns text language plpgsql as $$ begin execute p_sql; return null; exception when others then return sqlerrm; end $$;
-- Same, but returns the DETAIL (the machine code the Edge Function maps: quote_expired, fx_unavailable, ...).
create function _t.errd(p_sql text) returns text language plpgsql as $$
declare d text; begin execute p_sql; return null; exception when others then get stacked diagnostics d = pg_exception_detail; return coalesce(d, sqlerrm); end $$;
create function _t.as_user(u uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', coalesce(u::text, ''), false); execute 'reset role'; execute 'set role authenticated'; end $$;
create function _t.as_anon() returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', '', false); execute 'reset role'; execute 'set role anon'; end $$;
create function _t.as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', '', false); execute 'reset role'; execute 'set role service_role'; end $$;
create function _t.as_admin() returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', '', false); execute 'reset role'; end $$;

-- ------------------------------------------------------------------ setup: JPY invoices, KES-only Paystack, fresh FX snapshots
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000d1', 'd@example.com'), ('00000000-0000-0000-0000-0000000000d2', 'plain@example.com');
insert into user_settings (user_id, is_admin) values ('00000000-0000-0000-0000-0000000000d1', true), ('00000000-0000-0000-0000-0000000000d2', false)
  on conflict (user_id) do update set is_admin = excluded.is_admin;
select _t.put('D', '00000000-0000-0000-0000-0000000000d1'); select _t.put('N', '00000000-0000-0000-0000-0000000000d2');
do $$
declare d uuid := _t.id('D'); v_proj uuid; v_inv uuid; s record; n text;
begin
  perform _t.as_user(d);
  perform finance_create_bank_account('KES Main', 'bank', 'KES', 0);
  insert into projects (name, client, currency) values ('Tokyo P', 'Anime Co', '¥') returning id into v_proj;
  foreach n in array array['Q1', 'Q2', 'W1', 'W2'] loop
    insert into invoices (project_id, invoice_number, amount, currency, issue_date, due_date) values (v_proj, 'JPY-' || n, 150000, '¥', current_date, current_date + 30) returning id into v_inv;
    perform _t.put('inv' || n, v_inv::text);
  end loop;
  insert into fx_rates (user_id, rate_date, currency, per_usd, source) values (d, current_date, 'JPY', 150, 'test'), (d, current_date, 'KES', 129, 'test');
  perform payments_list_providers();
  perform _t.as_service(); perform payments_connect_paystack(d, 'live');
  perform _t.as_user(d); perform payments_set_paystack_options(array['card'], array['KES']);
  foreach n in array array['Q1', 'Q2', 'W1', 'W2'] loop
    select * into s from payments_create_checkout_session(_t.id('inv' || n), null, 14);
    perform _t.put('tok' || n, s.token); perform _t.put('ses' || n, s.session_id::text);
  end loop;
  perform _t.as_admin();
end $$;

-- ------------------------------------------------------------------ quotes
do $$
declare q jsonb; v jsonb; r record;
begin
  perform _t.as_anon();
  v := payments_public_checkout(_t.get('tokQ1'));
  perform _t.chk('public view: JPY invoice offers Paystack card flagged as converted to KES', exists (select 1 from jsonb_array_elements(v->'methods') e where e->>'channel' = 'card' and (e->>'converted')::boolean and e->>'charge_currency' = 'KES'));
  perform _t.chk('public view shows original amount and remaining balance', (v->>'original_amount')::numeric = 150000 and (v->>'outstanding')::numeric = 150000);
  perform _t.chk('anon cannot create quotes directly', _t.err(format('select payments_quote_create(%L, ''card'')', _t.get('tokQ1'))) is not null);
  perform _t.as_service();
  q := payments_quote_create(_t.get('tokQ1'), 'card');
  perform _t.put('quoteQ1', q->>'quote_id');
  perform _t.chk('quote: JPY->KES, rate = KES per 1 JPY (129/150 = 0.86), direction stated', (q->>'converted')::boolean and (q->>'fx_rate')::numeric = 0.86 and q->>'fx_base' = 'JPY' and q->>'fx_quote' = 'KES');
  perform _t.chk('quote: charge = amount paid now x rate, KES minor units (150000 x 0.86 = 129000.00)', (q->>'charge_amount')::numeric = 129000.00 and q->>'charge_currency' = 'KES' and (q->>'invoice_amount')::numeric = 150000);
  perform _t.chk('quote: 15-minute validity, fee and markup disclosed as zero', (select expires_at - created_at = interval '15 minutes' and fee_amount = 0 and markup_pct = 0 from payment_quotes where id = (q->>'quote_id')::uuid));
  perform _t.chk('quote: stores FX provenance (date, fetched-at, source)', (select fx_rate_date is not null and fx_rate_fetched_at is not null and fx_source = 'test' from payment_quotes where id = (q->>'quote_id')::uuid));
  perform _t.chk('quote: new quote supersedes the old one (one open quote per session)', (select count(*) from payment_quotes where checkout_session_id = _t.id('sesQ1') and status = 'open') = 1);
  perform _t.as_admin();
  update fx_rates set created_at = now() - interval '48 hours';
  perform _t.as_service();
  perform _t.chk('stale FX snapshot -> no quote, fx_unavailable', _t.errd(format('select payments_quote_create(%L, ''card'')', _t.get('tokQ1'))) = 'fx_unavailable');
  perform _t.as_admin();
  update fx_rates set created_at = now();
  delete from fx_rates where currency = 'KES';
  perform _t.as_service();
  perform _t.chk('missing FX rate -> no quote, fx_unavailable', _t.errd(format('select payments_quote_create(%L, ''card'')', _t.get('tokQ1'))) = 'fx_unavailable');
  perform _t.as_admin();
  insert into fx_rates (user_id, rate_date, currency, per_usd, source) values (_t.id('D'), current_date, 'KES', 129, 'test');
end $$;

-- ------------------------------------------------------------------ confirmation: prepare validates the quote
do $$
declare q1 uuid := _t.id('quoteQ1'); q2 jsonb; r record; qa uuid; qb uuid; tok text := _t.get('tokQ1');
begin
  perform _t.as_service();
  q2 := payments_quote_create(_t.get('tokQ1'), 'card');             -- supersedes q1
  perform _t.chk('superseded quote cannot be used', _t.errd(format('select * from payments_checkout_prepare(%L, ''a@b.co'', ''live'', ''card'', %L)', tok, q1)) = 'quote_superseded');
  perform _t.chk('converted invoice without a quote is refused', _t.errd(format('select * from payments_checkout_prepare(%L, ''a@b.co'', ''live'', ''card'', null)', tok)) = 'quote_required');
  perform _t.chk('a quote from another invoice/session is refused', _t.errd(format('select * from payments_checkout_prepare(%L, ''a@b.co'', ''live'', ''card'', %L)', tok,
     (payments_quote_create(_t.get('tokQ2'), 'card'))->>'quote_id')) = 'quote_invalid');
  qb := (q2->>'quote_id')::uuid;
  perform _t.as_admin();
  update payment_quotes set expires_at = now() - interval '1 second' where id = qb;
  perform _t.as_service();
  perform _t.chk('expired quote is refused and nothing is created', _t.errd(format('select * from payments_checkout_prepare(%L, ''a@b.co'', ''live'', ''card'', %L)', tok, qb)) = 'quote_expired'
     and not exists (select 1 from paystack_transactions where invoice_id = _t.id('invQ1')));
  q2 := payments_quote_create(_t.get('tokQ1'), 'card'); qb := (q2->>'quote_id')::uuid;
  select * into r from payments_checkout_prepare(tok, 'a@b.co', 'live', 'card', qb);
  perform _t.put('refQ1', r.reference);
  perform _t.chk('confirmed quote: attempt charges the QUOTED KES amount, settles the JPY invoice amount', r.action = 'new' and r.amount = 129000.00 and r.currency = 'KES' and r.invoice_amount = 150000 and r.invoice_currency = 'JPY');
  perform _t.chk('quote is consumed (used) and bound to the attempt', (select status = 'used' from payment_quotes where id = qb) and (select quote_id = qb and amount = 129000.00 from paystack_transactions where reference = r.reference));
  perform _t.chk('second confirmation of the same quote cannot start another attempt (verify-first, one open attempt)', (select action from payments_checkout_prepare(tok, 'a@b.co', 'live', 'card', qb)) = 'verify_first'
     and (select count(*) from paystack_transactions where invoice_id = _t.id('invQ1') and status in ('initialized', 'pending')) = 1);
end $$;

-- ------------------------------------------------------------------ verified payment applies exactly once (cash KES, invoice relieved in JPY)
do $$
declare ref text := _t.get('refQ1'); res jsonb; n1 int; n2 int;
begin
  perform _t.as_service();
  res := payments_apply_verification(ref, 'live', 'success', 12900000, 'KES', 100000, 'card', 'ps_1', now(), 'Successful');
  perform _t.as_admin();
  perform _t.chk('verification applied the payment', (res->>'applied')::boolean);
  perform _t.chk('invoice payment is recorded in the INVOICE currency and amount', (select amount = 150000 and currency = 'JPY' from invoice_payments where invoice_id = _t.id('invQ1') and status = 'posted'));
  perform _t.chk('invoice is settled', round(payments_invoice_outstanding(_t.id('invQ1')), 2) = 0);
  perform _t.chk('ledger: cash debited in KES, receivable credited in JPY, entry balanced in base', exists (
     select 1 from journal_lines l join journal_entries e on e.id = l.entry_id where e.source_id = _t.id('invQ1') and e.source_type = 'invoice_payment' and l.currency = 'KES' and l.debit = 129000.00)
     and exists (select 1 from journal_lines l join journal_entries e on e.id = l.entry_id where e.source_id = _t.id('invQ1') and e.source_type = 'invoice_payment' and l.currency = 'JPY' and l.credit = 150000));
  perform _t.chk('Paystack fee is booked once, in the charge currency (KES)', (select count(*) from expenses where reference = ref and category = 'Payment processing fees' and currency = 'KES' and amount = 1000) = 1);
  select count(*) into n1 from invoice_payments where invoice_id = _t.id('invQ1');
  select count(*) into n2 from journal_entries where source_id = _t.id('invQ1') and source_type = 'invoice_payment';
  perform _t.as_service();
  res := payments_apply_verification(ref, 'live', 'success', 12900000, 'KES', 100000, 'card', 'ps_1', now(), 'Successful');   -- duplicate webhook / verify
  perform _t.as_admin();
  perform _t.chk('duplicate verification does not duplicate the payment or the ledger entry', (res->>'duplicate')::boolean and n1 = (select count(*) from invoice_payments where invoice_id = _t.id('invQ1')) and n2 = (select count(*) from journal_entries where source_id = _t.id('invQ1') and source_type = 'invoice_payment'));
  perform _t.as_service();
  perform _t.chk('a verified amount that differs from the stored KES charge is refused', _t.err(format('select payments_apply_verification(%L, ''live'', ''success'', 12900001, ''KES'', 0, ''card'', ''ps_x'', now(), ''x'')', ref)) is not null);
  perform _t.as_admin();
end $$;

-- ------------------------------------------------------------------ Wise settings
do $$
declare d uuid := _t.id('D'); m jsonb; v jsonb;
begin
  perform _t.as_user(d);
  perform _t.chk('Wise cannot be enabled with incomplete recipient details', _t.err('select payments_set_wise_manual(''{"enabled": true, "recipient_name": "", "phone": "0712345678"}''::jsonb)') is not null);
  perform _t.chk('invalid recipient number rejected', _t.err('select payments_set_wise_manual(''{"enabled": false, "recipient_name": "Test Recipient", "country": "Kenya", "mobile_provider": "M-PESA", "calling_code": "+254", "phone": "0612345678"}''::jsonb)') is not null);
  perform _t.as_anon();
  v := payments_public_checkout(_t.get('tokW1'));
  perform _t.chk('Wise hidden before any settings exist', not exists (select 1 from jsonb_array_elements(v->'methods') e where e->>'provider' = 'wise'));
  perform _t.as_user(_t.id('N'));
  perform _t.chk('non-admin cannot change Wise settings', _t.err('select payments_set_wise_manual(''{"enabled": false}''::jsonb)') is not null);
  perform _t.as_user(d);
  m := payments_set_wise_manual('{"enabled": false, "recipient_name": "Test Recipient", "country": "Kenya", "mobile_provider": "M-PESA", "calling_code": "+254", "phone": "0712 345 678"}'::jsonb);
  perform _t.chk('valid settings normalise the number to international format', m->>'phone' = '+254712345678' and (m->>'complete')::boolean);
  perform _t.as_anon();
  v := payments_public_checkout(_t.get('tokW1'));
  perform _t.chk('Wise hidden while disabled (even when complete)', not exists (select 1 from jsonb_array_elements(v->'methods') e where e->>'provider' = 'wise'));
  perform _t.as_user(d);
  perform payments_set_wise_manual('{"enabled": true, "recipient_name": "Test Recipient", "country": "Kenya", "mobile_provider": "M-PESA", "calling_code": "+254", "phone": "0712345678"}'::jsonb);
  perform _t.as_anon();
  v := payments_public_checkout(_t.get('tokW1'));
  perform _t.chk('Wise offered when enabled and complete, and it is the LAST method', v->'methods'->(jsonb_array_length(v->'methods') - 1)->>'provider' = 'wise');
  perform _t.chk('public view never exposes the recipient number', v::text not like '%712345678%');
  perform _t.as_admin();
end $$;

-- ------------------------------------------------------------------ Wise manual workflow
do $$
declare s jsonb; s2 jsonb; ref text; mp uuid; res jsonb; n int;
begin
  perform _t.as_service();
  s := payments_manual_start(_t.get('tokW1'), 'client@example.com');
  ref := s->>'reference'; perform _t.put('wref', ref);
  perform _t.chk('selecting Wise creates ONE pending record with instructions and a unique reference', s->>'status' = 'pending' and s->>'phone' = '+254712345678' and ref like 'KRL-W-%'
     and (payments_manual_start(_t.get('tokW1'), 'client@example.com'))->>'reference' = ref);
  perform _t.as_admin();
  perform _t.chk('no Paystack transaction was created for Wise', not exists (select 1 from paystack_transactions where invoice_id = _t.id('invW1')));
  select id into mp from payment_manual_payments where reference = ref; perform _t.put('mpW1', mp::text);
  perform _t.as_service();
  perform _t.chk('submitting a transfer reference only marks it submitted', (payments_manual_submit(_t.get('tokW1'), ref, 'WISE-998877', 'Client', 'sent'))->>'status' = 'submitted');
  perform _t.as_admin();
  perform _t.chk('submission does NOT touch the invoice', round(payments_invoice_outstanding(_t.id('invW1')), 2) = 150000 and not exists (select 1 from invoice_payments where invoice_id = _t.id('invW1')));
  perform _t.as_service();
  s2 := payments_manual_start(_t.get('tokW2'), 'other@example.com');
  perform _t.chk('the same Wise transfer reference cannot be submitted twice', _t.err(format('select payments_manual_submit(%L, %L, ''wise-998877'', '''', '''')', _t.get('tokW2'), s2->>'reference')) is not null);
  perform _t.chk('a client cannot verify a payment (service/anon/non-admin have no access to review)', _t.err(format('select payments_manual_review(%L, ''verify'', 150000, 129000, ''KES'', '''')', mp)) is not null);
  perform _t.as_anon();
  perform _t.chk('anon cannot review', _t.err(format('select payments_manual_review(%L, ''verify'', 150000, 129000, ''KES'', '''')', mp)) is not null);
  perform _t.as_user(_t.id('N'));
  perform _t.chk('non-admin cannot review', _t.err(format('select payments_manual_review(%L, ''verify'', 150000, 129000, ''KES'', '''')', mp)) is not null);
  perform _t.as_user(_t.id('D'));
  perform _t.chk('cannot verify a transfer that was never submitted', _t.err(format('select payments_manual_review(%L, ''verify'', 150000, 129000, ''KES'', '''')', (select id from payment_manual_payments where reference = s2->>'reference'))) is not null);
  perform _t.chk('cannot credit more than was requested', _t.err(format('select payments_manual_review(%L, ''verify'', 150001, 129000, ''KES'', '''')', mp)) is not null);
  res := payments_manual_review(mp, 'verify', 150000, 129000, 'KES', 'arrived');
  perform _t.chk('admin verification applies the payment through the ledger', res->>'status' = 'verified' and round(payments_invoice_outstanding(_t.id('invW1')), 2) = 0);
  perform _t.chk('invoice payment recorded in invoice currency; cash booked in KES', (select amount = 150000 and currency = 'JPY' and method = 'Wise to M-PESA' from invoice_payments where invoice_id = _t.id('invW1'))
     and exists (select 1 from journal_lines l join journal_entries e on e.id = l.entry_id where e.source_id = _t.id('invW1') and l.currency = 'KES' and l.debit = 129000));
  res := payments_manual_review(mp, 'verify', 150000, 129000, 'KES', 'again');
  select count(*) into n from invoice_payments where invoice_id = _t.id('invW1');
  perform _t.chk('verifying twice applies exactly once', (res->>'duplicate')::boolean and n = 1);
  perform _t.chk('a verified transfer cannot be rejected', _t.err(format('select payments_manual_review(%L, ''reject'', null, null, null, '''')', mp)) is not null);
  perform _t.as_service();
  perform payments_manual_submit(_t.get('tokW2'), s2->>'reference', 'WISE-112233', 'Other', '');
  perform _t.as_user(_t.id('D'));
  res := payments_manual_review((select id from payment_manual_payments where reference = s2->>'reference'), 'reject', null, null, null, 'nothing arrived');
  perform _t.chk('rejected manual payment does not settle the invoice', res->>'status' = 'rejected' and round(payments_invoice_outstanding(_t.id('invW2')), 2) = 150000
     and not exists (select 1 from invoice_payments where invoice_id = _t.id('invW2')));
  perform _t.as_admin();
  perform _t.chk('review and settings are audited', exists (select 1 from finance_audit_log where object_type = 'manual_payment' and action in ('verify', 'reject')));
end $$;

do $$
declare v_fail int;
begin
  select count(*) into v_fail from _t.results where not ok;
  raise notice 'SUMMARY: % checks, % failed', (select count(*) from _t.results), v_fail;
  if v_fail > 0 then raise exception 'FAILED CHECKS: %', v_fail; end if;
end $$;
