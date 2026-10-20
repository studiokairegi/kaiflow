-- Payments module SQL tests. Run via supabase/tests/run.sh (needs a superuser on a scratch DB).
-- Every check prints PASS/FAIL; the script aborts with an error if any check failed.
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
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'a@example.com'), ('00000000-0000-0000-0000-0000000000b1', 'b@example.com');
select _t.put('A', '00000000-0000-0000-0000-0000000000a1'), _t.put('B', '00000000-0000-0000-0000-0000000000b1');
-- Payments is admin-only (20261021090000): both test owners are admins so the existing checks still exercise the module.
insert into user_settings (user_id, is_admin) values ('00000000-0000-0000-0000-0000000000a1', true), ('00000000-0000-0000-0000-0000000000b1', true) on conflict (user_id) do update set is_admin = true;

do $$
declare a uuid := _t.id('A'); b uuid := _t.id('B'); v_bank uuid; v_proj uuid; v_inv uuid; v_pb uuid; v_ib uuid; v_m uuid;
begin
  perform _t.as_user(a);
  v_bank := finance_create_bank_account('Main', 'bank', 'USD', 0);
  insert into projects (name, client, currency) values ('P1', 'Acme', '$') returning id into v_proj;
  insert into invoices (project_id, invoice_number, amount, currency, issue_date, due_date) values (v_proj, 'INV-1', 1000, '$', '2026-10-01', '2026-10-31') returning id into v_inv;
  perform _t.put('bank', v_bank::text); perform _t.put('proj', v_proj::text); perform _t.put('inv1', v_inv::text);
  insert into invoices (project_id, invoice_number, amount, currency, issue_date) values (v_proj, 'INV-EUR', 100, 'EUR', '2026-10-01') returning id into v_inv;
  perform _t.put('invEur', v_inv::text);
  insert into invoices (project_id, invoice_number, doc_type, amount, currency, issue_date) values (v_proj, 'REC-1', 'receipt', 100, '$', '2026-10-01') returning id into v_inv;
  perform _t.put('invReceipt', v_inv::text);
  insert into invoices (project_id, invoice_number, amount, currency, issue_date) values (v_proj, 'INV-2', 100, '$', '2026-10-01') returning id into v_inv;
  perform _t.put('inv2', v_inv::text);
  insert into invoices (project_id, invoice_number, amount, currency, issue_date) values (v_proj, 'INV-3', 500, '$', '2026-10-01') returning id into v_inv;
  perform _t.put('inv3', v_inv::text);
  insert into team_members (name, email) values ('Freelancer Fay', 'fay@example.com') returning id into v_m;
  perform _t.put('member', v_m::text);
  perform _t.as_user(b);
  insert into projects (name, client, currency) values ('PB', 'Other', '$') returning id into v_pb;
  insert into invoices (project_id, invoice_number, amount, currency, issue_date) values (v_pb, 'B-INV', 50, '$', '2026-10-01') returning id into v_ib;
  perform _t.put('invB', v_ib::text);
  perform _t.as_admin();
end $$;

-- ------------------------------------------------- checkout preparation
do $$
declare a uuid := _t.id('A'); b uuid := _t.id('B'); r record; r2 record; v_tx paystack_transactions%rowtype;
begin
  perform _t.as_user(a);
  select * into r from payments_prepare_charge(_t.id('inv1'), null, 'Client@Example.com');
  perform _t.chk('checkout uses the invoice outstanding balance and currency (not client input)', r.amount = 1000 and r.currency = 'USD' and not r.reused);
  perform _t.chk('reference is generated server-side', r.reference like 'KRL-%');
  perform _t.put('tx_full', r.transaction_id::text);
  perform _t.as_service();
  update paystack_transactions set authorization_url = 'https://checkout.paystack.com/test123' where id = r.transaction_id;
  perform _t.as_user(a);
  select * into r2 from payments_prepare_charge(_t.id('inv1'), null, 'client@example.com');
  perform _t.chk('repeating the request returns the same checkout (no duplicate transaction)', r2.reused and r2.reference = r.reference);
  perform _t.chk('only one transaction row exists for the invoice', (select count(*) from paystack_transactions where invoice_id = _t.id('inv1')) = 1);

  perform _t.chk('amount above the outstanding balance is rejected', _t.err(format('select * from payments_prepare_charge(%L, 1000.01, %L)', _t.id('inv1'), 'c@example.com')) like '%exceeds the outstanding%');
  perform _t.chk('zero amount is rejected', _t.err(format('select * from payments_prepare_charge(%L, 0, %L)', _t.id('inv1'), 'c@example.com')) like '%greater than zero%');
  perform _t.chk('negative amount is rejected', _t.err(format('select * from payments_prepare_charge(%L, -5, %L)', _t.id('inv1'), 'c@example.com')) like '%greater than zero%');
  perform _t.chk('invalid email is rejected', _t.err(format('select * from payments_prepare_charge(%L, null, %L)', _t.id('inv1'), 'not-an-email')) like '%valid customer email%');
  perform _t.chk('unsupported currency (EUR) is rejected', _t.err(format('select * from payments_prepare_charge(%L, null, %L)', _t.id('invEur'), 'c@example.com')) like '%cannot collect EUR%');
  perform _t.chk('receipts cannot be paid online', _t.err(format('select * from payments_prepare_charge(%L, null, %L)', _t.id('invReceipt'), 'c@example.com')) like '%Only invoices and proformas%');
  perform _t.chk('unknown invoice is rejected', _t.err(format('select * from payments_prepare_charge(%L, null, %L)', gen_random_uuid(), 'c@example.com')) like '%Invoice not found%');

  perform _t.as_user(b);
  perform _t.chk('another user cannot start a checkout for my invoice', _t.err(format('select * from payments_prepare_charge(%L, null, %L)', _t.id('inv1'), 'c@example.com')) like '%Invoice not found%');
  perform _t.as_anon();
  perform _t.chk('anonymous caller cannot prepare a checkout', _t.err(format('select * from payments_prepare_charge(%L, null, %L)', _t.id('inv1'), 'c@example.com')) like '%permission denied%');
  perform _t.as_admin();
end $$;

-- ------------------------------------------------- privileges / RLS / constraints
do $$
declare a uuid := _t.id('A'); b uuid := _t.id('B');
begin
  perform _t.as_user(a);
  perform _t.chk('browser cannot call payments_apply_verification', _t.err($q$select payments_apply_verification('x','success',100,'USD',1,'card','1',now(),'ok')$q$) like '%permission denied%');
  perform _t.chk('browser cannot call payments_apply_refund', _t.err($q$select payments_apply_refund('x',100,'USD','e1')$q$) like '%permission denied%');
  perform _t.chk('browser cannot insert transactions directly', _t.err($q$insert into paystack_transactions (reference, amount, currency) values ('FAKE', 1, 'USD')$q$) like '%permission denied%');
  perform _t.chk('browser cannot mark a transaction successful', _t.err(format($q$update paystack_transactions set status = 'success' where id = %L$q$, _t.id('tx_full'))) like '%permission denied%');
  perform _t.chk('browser cannot write payout requests directly', _t.err($q$insert into freelancer_payout_requests (bill_id, amount, currency) values (gen_random_uuid(), 1, 'USD')$q$) like '%permission denied%');
  perform _t.chk('owner can read their transaction', (select count(*) from paystack_transactions) = 1);
  perform _t.as_user(b);
  perform _t.chk('RLS: another user sees none of my transactions', (select count(*) from paystack_transactions) = 0);
  perform _t.as_admin();
  perform _t.chk('live environment rows are impossible (CHECK)', _t.err($q$insert into paystack_transactions (user_id, environment, reference, amount, currency) values ('00000000-0000-0000-0000-0000000000a1', 'live', 'LIVE1', 1, 'USD')$q$) like '%environment%');
  perform _t.chk('non-simulated payout rows are impossible (CHECK)', _t.err($q$insert into freelancer_payout_requests (user_id, bill_id, amount, currency, is_simulated) values ('00000000-0000-0000-0000-0000000000a1', gen_random_uuid(), 1, 'USD', false)$q$) like '%is_simulated%');
end $$;

-- ------------------------------------------------- partial payment, fee, net
do $$
declare a uuid := _t.id('A'); r record; res jsonb; v_inv invoices%rowtype; v_tx paystack_transactions%rowtype; v_exp expenses%rowtype;
begin
  perform _t.as_user(a);
  -- the 1000 checkout is superseded by a 400 partial attempt
  select * into r from payments_prepare_charge(_t.id('inv1'), 400, 'client@example.com');
  perform _t.chk('partial checkout is created for the requested amount', r.amount = 400 and not r.reused);
  perform _t.put('tx_p1', r.transaction_id::text); perform _t.put('ref_p1', r.reference);
  perform _t.as_service();
  res := payments_apply_verification(r.reference, 'success', 40000, 'USD', 600, 'card', '99001', now(), 'Successful');
  perform _t.chk('verified success is applied', (res->>'applied')::boolean);
  select * into v_inv from invoices where id = _t.id('inv1');
  perform _t.chk('invoice paid amount follows the verified payment (400)', v_inv.amount_paid = 400 and v_inv.status = 'unpaid');
  select * into v_tx from paystack_transactions where id = _t.id('tx_p1');
  perform _t.chk('actual fee and net are recorded separately', v_tx.fee_actual = 6.00 and v_tx.net_amount = 394.00 and v_tx.fee_estimated is null);
  perform _t.chk('transaction is linked to its ledger payment and matched', v_tx.invoice_payment_id is not null and v_tx.reconciliation_status = 'matched' and v_tx.apply_status = 'applied');
  select * into v_exp from expenses where reference = v_tx.reference;
  perform _t.chk('fee is booked once as an expense in the ledger', v_exp.amount = 6.00 and v_exp.category = 'Payment processing fees' and v_exp.journal_entry_id is not null and v_tx.fee_expense_id = v_exp.id);

  -- replays: browser refresh, webhook retry, simultaneous callbacks
  res := payments_apply_verification(v_tx.reference, 'success', 40000, 'USD', 600, 'card', '99001', now(), 'Successful');
  res := payments_apply_verification(v_tx.reference, 'success', 40000, 'USD', 600, 'card', '99001', now(), 'Successful');
  perform _t.chk('replayed verification is a no-op', (res->>'duplicate')::boolean);
  perform _t.chk('still exactly one invoice payment for the reference', (select count(*) from invoice_payments where reference = v_tx.reference) = 1);
  perform _t.chk('still exactly one fee expense for the reference', (select count(*) from expenses where reference = v_tx.reference) = 1);
  perform _t.chk('invoice paid amount unchanged after replays', (select amount_paid from invoices where id = _t.id('inv1')) = 400);

  perform _t.chk('mismatched amount is rejected', _t.err(format($q$select payments_apply_verification(%L,'success',99999,'USD',600,'card','1',now(),'ok')$q$, v_tx.reference)) like '%does not match%');
  perform _t.chk('unknown reference is rejected', _t.err($q$select payments_apply_verification('NOPE','success',100,'USD',1,'card','1',now(),'ok')$q$) like '%Unknown payment reference%');
  perform _t.as_admin();
end $$;

do $$
declare a uuid := _t.id('A'); r record; res jsonb; v_tx paystack_transactions%rowtype; v_bal numeric;
begin
  perform _t.as_user(a);
  select * into r from payments_prepare_charge(_t.id('inv1'), null, 'client@example.com');
  perform _t.chk('remaining balance (600) is offered after a partial payment', r.amount = 600);
  perform _t.put('tx_p2', r.transaction_id::text); perform _t.put('ref_p2', r.reference);
  perform _t.as_service();
  -- amount that disagrees with our stored row is refused and nothing is applied
  perform _t.chk('amount mismatch is refused', _t.err(format($q$select payments_apply_verification(%L,'success',50000,'USD',600,'card','1',now(),'ok')$q$, r.reference)) like '%does not match%');
  perform _t.chk('currency mismatch is refused', _t.err(format($q$select payments_apply_verification(%L,'success',60000,'GHS',600,'card','1',now(),'ok')$q$, r.reference)) like '%does not match%');
  perform _t.chk('refused verification applied nothing', (select count(*) from invoice_payments where reference = r.reference) = 0);
  res := payments_apply_verification(r.reference, 'success', 60000, 'USD', 900, 'card', '99002', now(), 'Successful');
  perform _t.chk('second payment settles the invoice', (select status from invoices where id = _t.id('inv1')) = 'paid' and (select amount_paid from invoices where id = _t.id('inv1')) = 1000);
  perform _t.as_admin();
  perform _t.chk('paid invoice has no outstanding balance', payments_invoice_outstanding(_t.id('inv1')) = 0);
  perform _t.as_user(a);
  perform _t.chk('paid invoice cannot be checked out again', _t.err(format('select * from payments_prepare_charge(%L, null, %L)', _t.id('inv1'), 'c@example.com')) like '%no outstanding balance%');
  perform _t.as_admin();
  select coalesce(sum(l.debit - l.credit), 0) into v_bal from journal_lines l join journal_entries e on e.id = l.entry_id
    where l.bank_account_id = _t.id('bank') and e.voided_by_entry_id is null and e.reverses_entry_id is null;
  perform _t.chk('bank account holds gross receipts less actual fees (1000 - 6 - 9 = 985)', v_bal = 985);
  perform _t.chk('ledger is balanced for every entry', not exists (select 1 from journal_lines group by entry_id having sum(debit) <> sum(credit)));
  perform _t.chk('Paystack tx totals reconcile to invoice payments', (select sum(amount) from paystack_transactions where status = 'success') = (select sum(amount) from invoice_payments where method = 'Paystack (test mode)' and status = 'posted'));
end $$;

-- ------------------------------------------------- failed / abandoned / pending
do $$
declare a uuid := _t.id('A'); r record; res jsonb; v_tx paystack_transactions%rowtype;
begin
  perform _t.as_user(a);
  select * into r from payments_prepare_charge(_t.id('inv2'), null, 'client@example.com');
  perform _t.as_service();
  res := payments_apply_verification(r.reference, 'pending', null, null, null, null, null, null, 'Waiting for OTP');
  perform _t.chk('pending payment is recorded as pending, not received', (select status from paystack_transactions where id = r.transaction_id) = 'pending' and (select amount_paid from invoices where id = _t.id('inv2')) = 0);
  res := payments_apply_verification(r.reference, 'abandoned', null, null, null, null, null, null, '');
  perform _t.chk('abandoned payment is recorded', (select status from paystack_transactions where id = r.transaction_id) = 'abandoned');
  res := payments_apply_verification(r.reference, 'failed', null, null, null, null, null, null, 'Declined');
  perform _t.chk('failed payment is recorded and nothing is posted', (select status from paystack_transactions where id = r.transaction_id) = 'failed'
     and not exists (select 1 from invoice_payments where reference = r.reference) and (select status from invoices where id = _t.id('inv2')) = 'unpaid');
  res := payments_apply_verification(r.reference, 'success', 10000, 'USD', 150, 'card', '99003', now(), 'Successful');
  perform _t.chk('a later verified success still applies after a failure', (select status from invoices where id = _t.id('inv2')) = 'paid');
  res := payments_apply_verification(r.reference, 'failed', null, null, null, null, null, null, 'late');
  perform _t.chk('a late "failed" never downgrades a settled payment', (select status from paystack_transactions where id = r.transaction_id) = 'success' and (select status from invoices where id = _t.id('inv2')) = 'paid');
  perform _t.as_admin();
end $$;

-- ------------------------------------------------- over-collection race
do $$
declare a uuid := _t.id('A'); r record; res jsonb; v_b uuid;
begin
  perform _t.as_user(a);
  select * into r from payments_prepare_charge(_t.id('inv3'), null, 'client@example.com');
  perform _t.put('tx_a', r.transaction_id::text);
  perform _t.as_admin();
  -- a second 500 checkout for the same invoice, as if started from another tab before the first completed
  insert into paystack_transactions (user_id, reference, invoice_id, invoice_number, amount, currency)
    values (a, 'KRL-RACE-2', _t.id('inv3'), 'INV-3', 500, 'USD') returning id into v_b;
  perform _t.as_service();
  res := payments_apply_verification(r.reference, 'success', 50000, 'USD', 750, 'card', '99004', now(), 'Successful');
  res := payments_apply_verification('KRL-RACE-2', 'success', 50000, 'USD', 750, 'card', '99005', now(), 'Successful');
  perform _t.chk('second payment cannot over-collect the invoice', (select amount_paid from invoices where id = _t.id('inv3')) = 500 and (select count(*) from invoice_payments where invoice_id = _t.id('inv3')) = 1);
  perform _t.chk('over-collected payment is flagged for review, not dropped', (select apply_status from paystack_transactions where reference = 'KRL-RACE-2') = 'failed'
     and (select reconciliation_status from paystack_transactions where reference = 'KRL-RACE-2') = 'needs_review'
     and (select status from paystack_transactions where reference = 'KRL-RACE-2') = 'success');
  perform _t.chk('no fee expense for the unapplied payment', (select fee_expense_id from paystack_transactions where reference = 'KRL-RACE-2') is null);
  perform _t.put('tx_race', v_b::text);
  perform _t.as_user(a);
  res := payments_retry_apply(v_b);
  perform _t.chk('retry cannot force the over-collection through', not (res->>'applied')::boolean);
  perform _t.chk('review requires a note', _t.err(format($q$select payments_resolve_review(%L, '')$q$, v_b)) like '%Add a note%');
  perform payments_resolve_review(v_b, 'Refunded the duplicate in the Paystack dashboard');
  perform _t.chk('a reviewed exception becomes matched and keeps its note', (select reconciliation_status from paystack_transactions where id = v_b) = 'matched'
     and (select reconciliation_note from paystack_transactions where id = v_b) like 'Refunded%');
  perform _t.as_admin();
end $$;

-- ------------------------------------------------- refunds (bookkeeping only)
do $$
declare a uuid := _t.id('A'); res jsonb; v_ref text := _t.get('ref_p1');
begin
  perform _t.as_service();
  perform _t.chk('refund of an unknown payment is rejected', _t.err($q$select payments_apply_refund('NOPE', 100, 'USD', 'r0')$q$) like '%Unknown payment reference%');
  res := payments_apply_refund(v_ref, 10000, 'USD', 'refund:1');
  perform _t.chk('partial refund is recorded and flagged for manual adjustment', (select status from paystack_transactions where reference = v_ref) = 'partially_refunded'
     and (select refunded_amount from paystack_transactions where reference = v_ref) = 100
     and (select reconciliation_status from paystack_transactions where reference = v_ref) = 'needs_review');
  res := payments_apply_refund(v_ref, 10000, 'USD', 'refund:1');
  perform _t.chk('a replayed refund event is ignored', (res->>'duplicate')::boolean and (select refunded_amount from paystack_transactions where reference = v_ref) = 100);
  perform _t.chk('refund currency mismatch is rejected', _t.err(format($q$select payments_apply_refund(%L, 100, 'GHS', 'r2')$q$, v_ref)) like '%currency mismatch%');
  perform _t.chk('refunds above the payment are rejected', _t.err(format($q$select payments_apply_refund(%L, 40000, 'USD', 'r3')$q$, v_ref)) like '%exceed%');
  res := payments_apply_refund(v_ref, 30000, 'USD', 'refund:2');
  perform _t.chk('full refund voids the invoice payment and reopens the balance', (select status from paystack_transactions where reference = v_ref) = 'refunded'
     and (select status from invoice_payments where reference = v_ref) = 'void'
     and (select amount_paid from invoices where id = _t.id('inv1')) = 600 and (select status from invoices where id = _t.id('inv1')) = 'unpaid');
  perform _t.chk('the fee expense is kept after a refund (Paystack keeps fees)', (select count(*) from expenses where reference = v_ref) = 1);
  perform _t.chk('refund before the charge was applied is rejected so the event is retried', _t.err(format($q$select payments_apply_refund(%L, 100, 'USD', 'r9')$q$, 'KRL-RACE-2')) like '%not been applied%');
  perform _t.chk('ledger still balanced after refund reversal', not exists (select 1 from journal_lines group by entry_id having sum(debit) <> sum(credit)));
  perform _t.as_admin();
end $$;

-- ------------------------------------------------- freelancer payouts (simulated)
do $$
declare a uuid := _t.id('A'); b uuid := _t.id('B'); v_bill uuid; v_req1 uuid; v_req2 uuid; v_ent int; v_pay uuid; v_ref text; v_bill2 uuid; v_req3 uuid;
begin
  perform _t.as_user(a);
  v_bill := finance_save_bill(jsonb_build_object('team_member_id', _t.get('member'), 'project_id', _t.get('proj'), 'currency', 'USD', 'amount', 300, 'bill_number', 'FB-1', 'approve', true));
  perform _t.put('bill', v_bill::text);
  v_req1 := payments_create_payout_request(v_bill, 100, 'first part');
  perform _t.chk('payout request is created pending approval', (select status from freelancer_payout_requests where id = v_req1) = 'pending_approval');
  perform _t.chk('request amount cannot exceed what is still available', _t.err(format('select payments_create_payout_request(%L, 250, %L)', v_bill, '')) like '%exceeds%');
  v_req2 := payments_create_payout_request(v_bill, 200, 'rest');
  perform _t.as_admin(); perform _t.chk('open requests reserve the bill balance (300)', payments_payout_reserved(v_bill) = 300); perform _t.as_user(a);
  perform _t.chk('a fully reserved bill accepts no further requests', _t.err(format('select payments_create_payout_request(%L, 1, %L)', v_bill, '')) like '%exceeds%');
  perform _t.chk('cannot start a simulation before approval', _t.err(format('select payments_simulate_payout_start(%L)', v_req1)) like '%approved%');
  perform _t.as_user(b);
  perform _t.chk('another user cannot approve my request', _t.err(format('select payments_approve_payout_request(%L)', v_req1)) like '%not found%');
  perform _t.chk('another user sees none of my payout requests', (select count(*) from freelancer_payout_requests) = 0);
  perform _t.as_user(a);
  perform payments_approve_payout_request(v_req1);
  perform _t.chk('approval is recorded with approver and time', (select approved_by from freelancer_payout_requests where id = v_req1) = a and (select approved_at from freelancer_payout_requests where id = v_req1) is not null);
  select count(*) into v_ent from journal_entries where user_id = a;
  v_ref := payments_simulate_payout_start(v_req1);
  perform _t.chk('simulation start returns a SIM- reference and status simulated_initiated', v_ref like 'SIM-%' and (select status from freelancer_payout_requests where id = v_req1) = 'simulated_initiated');
  perform payments_simulate_payout_finish(v_req1, false, 'Simulated bank rejection');
  perform _t.chk('a failed simulation records the reason', (select status from freelancer_payout_requests where id = v_req1) = 'failed' and (select failure_reason from freelancer_payout_requests where id = v_req1) like 'Simulated bank%');
  perform _t.chk('a failed attempt does NOT erase what is owed', (select amount from bills where id = v_bill) = 300 and (select amount_paid from bills where id = v_bill) = 0 and (select status from bills where id = v_bill) = 'approved');
  perform payments_approve_payout_request(v_req1);
  perform _t.chk('a failed request can be re-approved', (select status from freelancer_payout_requests where id = v_req1) = 'approved');
  perform payments_simulate_payout_start(v_req1);
  perform payments_simulate_payout_finish(v_req1, true);
  perform _t.chk('successful simulation completes in sandbox only', (select status from freelancer_payout_requests where id = v_req1) = 'completed_simulated' and (select is_simulated from freelancer_payout_requests where id = v_req1));
  perform _t.chk('simulated payout posts nothing to the ledger', (select count(*) from journal_entries where user_id = a) = v_ent);
  perform _t.chk('simulated payout creates no bill payment', (select count(*) from bill_payments where bill_id = v_bill) = 0);
  perform _t.chk('amount owed is unchanged by a simulated payout', (select amount - amount_paid from bills where id = v_bill) = 300);
  perform _t.chk('cannot reconcile without a real payment', _t.err(format('select payments_reconcile_payout(%L, %L)', v_req1, gen_random_uuid())) like '%posted payment%');
  perform _t.put('req1', v_req1::text); perform _t.put('req2', v_req2::text);
  -- record the REAL payment in Finance (outside the sandbox), then reconcile the simulation to it
  v_pay := finance_record_bill_payment(v_bill, 100, current_date, _t.id('bank'), 'Manual', 'ref-1');
  perform _t.put('billpay1', v_pay::text);
  perform payments_reconcile_payout(v_req1, v_pay);
  perform _t.chk('simulation is reconciled to the real bill payment', (select reconciled from freelancer_payout_requests where id = v_req1) and (select bill_payment_id from freelancer_payout_requests where id = v_req1) = v_pay);
  perform _t.chk('a bill payment cannot be matched twice', _t.err(format('select payments_reconcile_payout(%L, %L)', v_req1, v_pay)) like '%unreconciled%');
  perform payments_approve_payout_request(v_req2); perform payments_simulate_payout_start(v_req2); perform payments_simulate_payout_finish(v_req2, true);
  perform _t.chk('amount mismatch blocks reconciliation', _t.err(format('select payments_reconcile_payout(%L, %L)', v_req2, v_pay)) like '%does not match the request amount%');
  v_bill2 := finance_save_bill(jsonb_build_object('team_member_id', _t.get('member'), 'currency', 'USD', 'amount', 50, 'bill_number', 'FB-2', 'approve', true));
  v_req3 := payments_create_payout_request(v_bill2, 50, '');
  perform payments_cancel_payout_request(v_req3, 'no longer needed');
  perform _t.chk('cancelled request is marked cancelled', (select status from freelancer_payout_requests where id = v_req3) = 'cancelled');
  perform _t.chk('cancelled request releases its reservation (bill accepts the full amount again)', payments_create_payout_request(v_bill2, 50, '') is not null);
  perform _t.chk('cancelled request cannot be approved', _t.err(format('select payments_approve_payout_request(%L)', v_req3)) like '%pending or failed%');
  perform _t.as_admin();
  perform _t.chk('payout workflow is audited', (select count(*) from finance_audit_log where object_type = 'payout_request') >= 8);
  perform _t.chk('payment workflow is audited', (select count(*) from finance_audit_log where object_type = 'paystack_transaction' and action in ('initiate','apply','refund')) >= 5);
end $$;

do $$
declare a uuid := _t.id('A'); v_draft uuid;
begin
  perform _t.as_user(a);
  v_draft := finance_save_bill(jsonb_build_object('team_member_id', _t.get('member'), 'currency', 'USD', 'amount', 50, 'bill_number', 'FB-DRAFT'));
  perform _t.chk('a draft (unapproved) bill cannot be paid out', _t.err(format('select payments_create_payout_request(%L, 10, %L)', v_draft, '')) like '%Only an approved bill%');
  perform _t.as_admin();
end $$;

-- ------------------------------------------------- idempotent migration + summary
do $$
declare v_fail int;
begin
  perform _t.chk('Finance data untouched: invoice INV-3 still 500', (select amount from invoices where invoice_number = 'INV-3') = 500);
  select count(*) into v_fail from _t.results where not ok;
  raise notice 'SUMMARY: % checks, % failed', (select count(*) from _t.results), v_fail;
  if v_fail > 0 then raise exception 'FAILED CHECKS: %', v_fail; end if;
end $$;
