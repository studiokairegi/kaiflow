-- Paystack LIVE checkout SQL tests (migration 20261025090000). Run via supabase/tests/run.sh (needs a superuser on a scratch DB).
-- Every check prints PASS/FAIL; the script aborts with an error if any check failed.
drop schema if exists _t cascade;
create schema _t;
grant usage on schema _t to public;
create table _t.results (name text, ok boolean);
create table _t.ctx (k text primary key, v text);
grant all on _t.results, _t.ctx to public;

create function _t.chk(p_name text, p_ok boolean) returns void language plpgsql as $$
begin
  insert into _t.results values (p_name, coalesce(p_ok, false));
  raise notice '%: %', case when coalesce(p_ok, false) then 'PASS' else 'FAIL' end, p_name;
end $$;
create function _t.put(p_k text, p_v text) returns void language sql as $$
  insert into _t.ctx values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create function _t.get(p_k text) returns text language sql stable as $$ select v from _t.ctx where k = p_k $$;
create function _t.id(p_k text) returns uuid language sql stable as $$ select v::uuid from _t.ctx where k = p_k $$;
-- Runs SQL and returns the error message (null when it succeeds).
create function _t.err(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null; exception when others then return sqlerrm; end $$;
create function _t.as_user(u uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', coalesce(u::text, ''), false); execute 'reset role'; execute 'set role authenticated'; end $$;
create function _t.as_anon() returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', '', false); execute 'reset role'; execute 'set role anon'; end $$;
create function _t.as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', '', false); execute 'reset role'; execute 'set role service_role'; end $$;
create function _t.as_admin() returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', '', false); execute 'reset role'; end $$;

-- ------------------------------------------------------------------ setup
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000c1', 'c@example.com');
insert into user_settings (user_id, is_admin) values ('00000000-0000-0000-0000-0000000000c1', true) on conflict (user_id) do update set is_admin = true;
select _t.put('C', '00000000-0000-0000-0000-0000000000c1');

do $$
declare c uuid := _t.id('C'); v_proj uuid; v_inv uuid; s record;
begin
  perform _t.as_user(c);
  perform finance_create_bank_account('KES Main', 'bank', 'KES', 0);
  insert into projects (name, client, currency) values ('Live P', 'Acme Kenya', 'KES') returning id into v_proj;
  insert into invoices (project_id, invoice_number, amount, currency, issue_date, due_date) values (v_proj, 'LIVE-1', 1500.50, 'KES', '2026-10-01', '2026-10-31') returning id into v_inv;
  perform _t.put('inv', v_inv::text);
  insert into invoices (project_id, invoice_number, amount, currency, issue_date, due_date) values (v_proj, 'LIVE-2', 800, 'KES', '2026-10-01', '2026-10-31') returning id into v_inv;
  perform _t.put('inv2', v_inv::text);
  perform payments_list_providers();                    -- seeds provider rows
  perform _t.as_service();
  perform payments_connect_paystack(c, 'live');
  perform _t.as_user(c);
  select * into s from payments_create_checkout_session(_t.id('inv'), null, 14);
  perform _t.put('token', s.token); perform _t.put('session', s.session_id::text);
  select * into s from payments_create_checkout_session(_t.id('inv2'), null, 14);
  perform _t.put('token2', s.token);
  perform _t.as_admin();
end $$;

-- ------------------------------------------------------------------ provider + session environment
do $$
declare v jsonb; m jsonb;
begin
  perform _t.chk('Paystack is connected, enabled and primary after connect', (select status = 'connected' and is_enabled and is_primary and environment = 'live' from payment_providers where provider = 'paystack'));
  perform _t.chk('session inherits the live environment', (select environment = 'live' from payment_checkout_sessions where id = _t.id('session')));
  perform _t.chk('amount and currency on the session come from the invoice', (select amount = 1500.50 and currency = 'KES' from payment_checkout_sessions where id = _t.id('session')));
  perform _t.as_anon();
  v := payments_public_checkout(_t.get('token'));
  perform _t.chk('public view: open, correct invoice number, amount, currency', v->>'status' = 'open' and v->>'invoice_number' = 'LIVE-1' and (v->>'amount')::numeric = 1500.50 and v->>'currency' = 'KES');
  perform _t.chk('public view: card offered; bank transfer NOT offered until the admin enables it', exists (select 1 from jsonb_array_elements(v->'methods') e where e->>'channel' = 'card' and (e->>'enabled')::boolean)
    and not exists (select 1 from jsonb_array_elements(v->'methods') e where e->>'channel' = 'bank_transfer'));
  perform _t.chk('public view: PayPal and Payoneer present but disabled', (select count(*) from jsonb_array_elements(v->'methods') e where e->>'channel' in ('paypal', 'payoneer') and not (e->>'enabled')::boolean and e->>'note' like 'Coming soon%') = 2);
  perform _t.chk('public view exposes no internal ids', v::text not like '%user_id%' and v::text not like '%invoice_id%');
  perform _t.chk('public view: unknown token looks like any bad token', payments_public_checkout(repeat('0', 64)) = '{"found": false}'::jsonb);
  perform _t.as_admin();
end $$;

-- ------------------------------------------------------------------ privileges
do $$
begin
  perform _t.as_anon();
  perform _t.chk('anon cannot prepare a charge', _t.err(format($q$select * from payments_checkout_prepare(%L, 'a@b.co', 'live', 'card')$q$, _t.get('token'))) like '%permission denied%');
  perform _t.chk('anon cannot read checkout status', _t.err(format($q$select payments_checkout_status(%L)$q$, _t.get('token'))) like '%permission denied%');
  perform _t.chk('anon cannot connect a provider', _t.err($q$select payments_connect_paystack('00000000-0000-0000-0000-0000000000c1', 'live')$q$) like '%permission denied%');
  perform _t.chk('anon cannot apply a verification', _t.err($q$select payments_apply_verification('x', 'live', 'success', 1, 'KES', 0, 'card', '1', now(), 'ok')$q$) like '%permission denied%');
  perform _t.as_user(_t.id('C'));
  perform _t.chk('even a signed-in admin cannot call the service-only functions from the browser', _t.err(format($q$select * from payments_checkout_prepare(%L, 'a@b.co', 'live', 'card')$q$, _t.get('token'))) like '%permission denied%');
  perform _t.chk('admin can enable bank transfer and Apple Pay', _t.err($q$select payments_set_paystack_options(array['card','bank_transfer','apple_pay'], array['KES'])$q$) is null);
  perform _t.chk('unsupported channel / currency are refused', _t.err($q$select payments_set_paystack_options(array['paypal'], array['KES'])$q$) like '%Unsupported channel%'
     and _t.err($q$select payments_set_paystack_options(array['card'], array['EUR'])$q$) like '%cannot collect%'
     and _t.err($q$select payments_set_paystack_options(array['apple_pay'], array['KES'])$q$) is null);
  perform _t.as_admin();
end $$;

-- ------------------------------------------------------------------ prepare: environment, rules, duplicates
do $$
declare r record; v jsonb;
begin
  perform _t.as_service();
  perform _t.chk('a test-mode request cannot use a live link', _t.err(format($q$select * from payments_checkout_prepare(%L, 'a@b.co', 'test', 'card')$q$, _t.get('token'))) like '%not valid%');
  perform _t.chk('invalid email is refused', _t.err(format($q$select * from payments_checkout_prepare(%L, 'nope', 'live', 'card')$q$, _t.get('token'))) like '%valid email%');
  perform _t.chk('unknown channel is refused', _t.err(format($q$select * from payments_checkout_prepare(%L, 'a@b.co', 'live', 'paypal')$q$, _t.get('token'))) like '%Choose a payment method%');
  perform _t.chk('malformed token is refused', _t.err($q$select * from payments_checkout_prepare('abc', 'a@b.co', 'live', 'card')$q$) like '%not valid%');

  select * into r from payments_checkout_prepare(_t.get('token'), 'Pay@Example.com', 'live', 'card');
  perform _t.put('ref', r.reference); perform _t.put('tx', r.transaction_id::text);
  perform _t.chk('first prepare creates a live attempt with the DB amount', r.action = 'new' and r.amount = 1500.50 and r.currency = 'KES' and r.reference like 'KRL-L-%');
  perform _t.chk('attempt row is live, session-linked, email lower-cased', (select environment = 'live' and checkout_session_id = _t.id('session') and customer_email = 'pay@example.com' and status = 'initialized' from paystack_transactions where reference = r.reference));

  select * into r from payments_checkout_prepare(_t.get('token'), 'pay@example.com', 'live', 'card');
  perform _t.chk('repeat before the checkout URL exists -> verify_first, NOT a new charge', r.action = 'verify_first' and r.reference = _t.get('ref'));
  update paystack_transactions set authorization_url = 'https://checkout.paystack.com/x' where reference = _t.get('ref');
  select * into r from payments_checkout_prepare(_t.get('token'), 'pay@example.com', 'live', 'card');
  perform _t.chk('refresh / second tab, same channel -> reuse the same checkout', r.action = 'reuse' and r.reference = _t.get('ref') and r.authorization_url like 'https://checkout.paystack.com/%');
  select * into r from payments_checkout_prepare(_t.get('token'), 'pay@example.com', 'live', 'bank_transfer');
  perform _t.chk('different channel while one is open -> verify_first, not a second charge', r.action = 'verify_first');
  select * into r from payments_checkout_prepare(_t.get('token2'), 'pay@example.com', 'live', 'card');
  perform _t.chk('a DIFFERENT link for the same invoice also cannot start a second attempt', r.action = 'verify_first' and r.reference = _t.get('ref'));
  perform _t.chk('exactly one open attempt exists for the invoice', (select count(*) from paystack_transactions where invoice_id = _t.id('inv') and status in ('initialized', 'pending')) = 1);
  perform _t.chk('the database itself refuses a second open attempt (unique index)', _t.err(format($q$insert into paystack_transactions (user_id, environment, reference, invoice_id, amount, currency, checkout_session_id)
     values (%L, 'live', 'KRL-L-DUPE', %L, 1500.50, 'KES', %L)$q$, _t.id('C'), _t.id('inv'), _t.id('session'))) like '%paystack_tx_one_open_per_invoice_uidx%');
  perform _t.as_admin();
end $$;

-- ------------------------------------------------------------------ verification and ledger
do $$
declare res jsonb; ref text := _t.get('ref');
begin
  perform _t.as_service();
  perform _t.chk('a TEST verification cannot settle a LIVE attempt', _t.err(format($q$select payments_apply_verification(%L, 'test', 'success', 150050, 'KES', 2300, 'card', '1', now(), 'ok')$q$, ref)) like '%Environment mismatch%');
  perform _t.chk('wrong amount is rejected', _t.err(format($q$select payments_apply_verification(%L, 'live', 'success', 150049, 'KES', 2300, 'card', '1', now(), 'ok')$q$, ref)) like '%does not match%');
  perform _t.chk('wrong currency is rejected', _t.err(format($q$select payments_apply_verification(%L, 'live', 'success', 150050, 'USD', 2300, 'card', '1', now(), 'ok')$q$, ref)) like '%does not match%');
  perform _t.chk('nothing was recorded by the rejected attempts', (select count(*) from invoice_payments where invoice_id = _t.id('inv')) = 0 and (select status from paystack_transactions where reference = ref) = 'initialized');
  res := payments_apply_verification(ref, 'live', 'pending', null, null, null, null, null, null, 'Awaiting transfer');
  perform _t.chk('pending outcome keeps the attempt open and the invoice unpaid', res->>'status' = 'pending' and (select status from invoices where id = _t.id('inv')) is distinct from 'paid');

  res := payments_apply_verification(ref, 'live', 'success', 150050, 'KES', 2300, 'card', '99100', now(), 'Successful');
  perform _t.chk('verified success applies to the invoice', (res->>'applied')::boolean);
  res := payments_apply_verification(ref, 'live', 'success', 150050, 'KES', 2300, 'card', '99100', now(), 'Successful');   -- webhook retry
  res := payments_apply_verification(ref, 'live', 'success', 150050, 'KES', 2300, 'card', '99100', now(), 'Successful');   -- browser refresh
  perform _t.chk('repeated verification is a duplicate, not a second payment', (res->>'duplicate')::boolean);
  perform _t.chk('exactly one ledger payment, labelled live, for the full amount', (select count(*) from invoice_payments where invoice_id = _t.id('inv') and status = 'posted') = 1
     and (select amount = 1500.50 and method = 'Paystack' and reference = ref from invoice_payments where invoice_id = _t.id('inv')));
  perform _t.chk('invoice is paid and the original amount and currency are untouched', (select status = 'paid' and amount = 1500.50 and currency = 'KES' from invoices where id = _t.id('inv')));
  perform _t.chk('actual fee booked once and kept separate from the invoice amount', (select count(*) from expenses where reference = ref) = 1 and (select amount = 23.00 from expenses where reference = ref));
  perform _t.chk('attempt shows live provider facts', (select fee_actual = 23.00 and net_amount = 1477.50 and apply_status = 'applied' and reconciliation_status = 'matched' and environment = 'live' from paystack_transactions where reference = ref));
  perform _t.chk('the link that produced the payment is closed', (select status = 'paid' from payment_checkout_sessions where id = _t.id('session')));
  res := payments_apply_verification(ref, 'live', 'failed', null, null, null, null, null, null, 'late failure');
  perform _t.chk('a late "failed" never downgrades a settled payment', (select status = 'success' from paystack_transactions where reference = ref) and (select count(*) from invoice_payments where invoice_id = _t.id('inv') and status = 'posted') = 1);

  perform _t.chk('paid invoice: prepare is refused on both links', _t.err(format($q$select * from payments_checkout_prepare(%L, 'a@b.co', 'live', 'card')$q$, _t.get('token'))) like '%no longer open%'
     and _t.err(format($q$select * from payments_checkout_prepare(%L, 'a@b.co', 'live', 'card')$q$, _t.get('token2'))) like '%already been paid%');
  res := payments_checkout_status(_t.get('token'), ref);
  perform _t.chk('status for the return page: paid and applied', (res->>'invoice_paid')::boolean and (res->>'applied')::boolean and res->>'transaction_status' = 'success');
  perform _t.chk('status ignores a reference that is not on this link', (payments_checkout_status(_t.get('token'), 'SOME-OTHER-REF')->>'reference') is null);
  perform _t.as_anon();
  perform _t.chk('public view after payment says paid and offers no methods', payments_public_checkout(_t.get('token'))->>'status' = 'paid' and jsonb_array_length(payments_public_checkout(_t.get('token'))->'methods') = 0);
  perform _t.as_admin();
end $$;

-- ------------------------------------------------------------------ failure paths and refunds
do $$
declare r record; res jsonb; ref2 text;
begin
  perform _t.as_service();
  -- invoice 2: a declined payment leaves the invoice payable and unpaid, then a retry works
  select * into r from payments_checkout_prepare(_t.get('token2'), 'x@y.co', 'live', 'card');
  res := payments_apply_verification(r.reference, 'live', 'failed', null, null, null, null, null, null, 'Declined');
  perform _t.chk('declined attempt is failed and the invoice is not paid', (select status = 'failed' from paystack_transactions where reference = r.reference) and (select status is distinct from 'paid' from invoices where id = _t.id('inv2')));
  select * into r from payments_checkout_prepare(_t.get('token2'), 'x@y.co', 'live', 'card');
  ref2 := r.reference;
  perform _t.chk('after a definite failure a fresh attempt may start', r.action = 'new' and (select count(*) from paystack_transactions where invoice_id = _t.id('inv2')) = 2);
  res := payments_apply_verification(ref2, 'live', 'success', 80000, 'KES', null, 'bank_transfer', '99200', now(), 'Successful');
  perform _t.chk('payment without a reported fee books no fee (never invented)', (res->>'applied')::boolean and (select count(*) from expenses where reference = ref2) = 0);
  res := payments_apply_refund(ref2, 80000, 'KES', 'refund-1');
  res := payments_apply_refund(ref2, 80000, 'KES', 'refund-1');
  perform _t.chk('full refund voids the payment once and re-opens the invoice; replay is a no-op', (select status = 'refunded' from paystack_transactions where reference = ref2)
     and (select count(*) from invoice_payments where invoice_id = _t.id('inv2') and status = 'void') = 1 and (select status is distinct from 'paid' from invoices where id = _t.id('inv2')));
  perform _t.as_admin();
end $$;

-- ------------------------------------------------------------------ isolation + summary
do $$
declare v_fail int;
begin
  perform _t.chk('this suite created live attempts only (test and live never mixed)', exists (select 1 from paystack_transactions where environment = 'live')
     and not exists (select 1 from paystack_transactions where environment = 'test'));
  select count(*) into v_fail from _t.results where not ok;
  raise notice 'SUMMARY: % checks, % failed', (select count(*) from _t.results), v_fail;
  if v_fail > 0 then raise exception 'FAILED CHECKS: %', v_fail; end if;
end $$;
