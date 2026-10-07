-- =============================================================================
-- Finance v2 database tests. Run AFTER migration_finance_v2.sql, in the Supabase
-- SQL editor (as postgres). Everything runs inside a transaction that is rolled
-- back, using a throwaway user, so it leaves no data behind.
--
-- NOT EXECUTED BY THE AUTHOR: written without access to a Postgres instance.
-- If a step fails, the error names the scenario. Fix forward, don't skip.
-- =============================================================================
begin;

do $$
declare
  u1 uuid := gen_random_uuid(); u2 uuid := gen_random_uuid();
  proj uuid; inv uuid; bill uuid; usd uuid; usd2 uuid; eur uuid; pay uuid; entry uuid;
  n numeric; r record; ok boolean;
begin
  -- throwaway users (auth.users needs only an id and email here; adjust if your project requires more)
  insert into auth.users (id, email, aud, role) values (u1, 'fin-test-1@example.invalid', 'authenticated', 'authenticated');
  insert into auth.users (id, email, aud, role) values (u2, 'fin-test-2@example.invalid', 'authenticated', 'authenticated');
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', u1::text, true);

  perform finance_init();
  if (select base_currency from finance_settings where user_id = u1) <> 'USD' then
    raise exception 'TEST SETUP: expected default base USD for a fresh user';
  end if;

  insert into projects (user_id, name) values (u1, 'Test project') returning id into proj;
  -- stored transaction-date rates (units per 1 USD): 1 EUR = 1.08 USD  =>  per_usd = 1/1.08
  insert into fx_rates (user_id, rate_date, currency, per_usd, source) values
    (u1, current_date, 'EUR', round(1/1.08, 8), 'test'),
    (u1, current_date - 200, 'EUR', round(1/1.08, 8), 'test');

  usd  := finance_create_bank_account('Bank A USD', 'bank', 'USD', 5000, current_date - 300);
  usd2 := finance_create_bank_account('Bank B USD', 'bank', 'USD', 0, current_date - 300);
  eur  := finance_create_bank_account('Wise EUR', 'bank', 'EUR', 0, current_date - 300);

  -- ---------------------------------------------------------------- A: USD invoice, partial payment
  insert into invoices (user_id, project_id, invoice_number, amount, currency, issue_date, due_date, status, amount_paid)
    values (u1, proj, 'T-A', 1000, '$', to_char(current_date, 'YYYY-MM-DD'), to_char(current_date + 14, 'YYYY-MM-DD'), 'unpaid', 0) returning id into inv;
  select count(*) into n from journal_entries where user_id = u1 and source_id = inv and source_type = 'invoice';
  if n <> 1 then raise exception 'A: invoice should post exactly one issuance entry, got %', n; end if;
  perform finance_record_invoice_payment(inv, 400, current_date, usd, 'Bank transfer', 'ref');
  select amount_paid into n from invoices where id = inv;
  if n <> 400 then raise exception 'A: invoices.amount_paid should follow payments, got %', n; end if;
  select native into n from finance_doc_position(u1, finance_sys_account(u1, 'ar'), inv);
  if n <> 600 then raise exception 'A: A/R should be 600, got %', n; end if;
  ok := false;
  begin
    update invoices set amount_paid = 1000, status = 'paid' where id = inv;
  exception when sqlstate 'P0001' then ok := true; end;
  if not ok then raise exception 'A: direct edit of paid amount should have been rejected'; end if;
  ok := false;
  begin perform finance_record_invoice_payment(inv, 700, current_date, usd, '', '');
  exception when sqlstate 'P0001' then ok := true; end;
  if not ok then raise exception 'A: overpayment should have been rejected'; end if;

  -- ---------------------------------------------------------------- B: EUR invoice keeps its base value
  insert into invoices (user_id, project_id, invoice_number, amount, currency, issue_date, due_date, status, amount_paid)
    values (u1, proj, 'T-B', 1000, '€', to_char(current_date - 200, 'YYYY-MM-DD'), to_char(current_date - 180, 'YYYY-MM-DD'), 'unpaid', 0) returning id into inv;
  select base into n from finance_doc_position(u1, finance_sys_account(u1, 'ar'), inv);
  if n <> 1080 then raise exception 'B: EUR 1000 at 1.08 should be 1080 base, got %', n; end if;
  -- rates change drastically afterwards; the posted entry must not move
  insert into fx_rates (user_id, rate_date, currency, per_usd, source) values (u1, current_date - 1, 'EUR', round(1/1.30, 8), 'test');
  select base into n from finance_doc_position(u1, finance_sys_account(u1, 'ar'), inv);
  if n <> 1080 then raise exception 'B: later FX rate rewrote a historical entry (got %)', n; end if;
  perform finance_record_invoice_payment(inv, 1000, current_date, eur, 'Wise', '');   -- pays at ~1.08 (today's stored rate)
  select native into n from finance_doc_position(u1, finance_sys_account(u1, 'ar'), inv);
  if n <> 0 then raise exception 'B: A/R should clear natively, got %', n; end if;

  -- missing FX is flagged, never 1:1
  insert into invoices (user_id, project_id, invoice_number, amount, currency, issue_date, due_date, status, amount_paid)
    values (u1, proj, 'T-B2', 500, '£', to_char(current_date - 400, 'YYYY-MM-DD'), '', 'unpaid', 0) returning id into inv;
  select fx_status into r from journal_entries where user_id = u1 and source_id = inv and source_type = 'invoice';
  if r.fx_status <> 'missing' then raise exception 'B: GBP invoice with no stored rate must be fx_status=missing, got %', r.fx_status; end if;
  select base_credit into r from journal_lines l join journal_entries e on e.id = l.entry_id where e.source_id = inv and l.credit > 0;
  if r.base_credit is not null then raise exception 'B: missing-FX entry must have NULL base amounts, got %', r.base_credit; end if;

  -- ---------------------------------------------------------------- C/D: freelancer bill then payment
  bill := finance_save_bill(jsonb_build_object('vendor_name', 'John', 'currency', 'EUR', 'amount', 250, 'project_id', proj,
            'issue_date', current_date, 'due_date', current_date + 10, 'approve', true));
  select native into n from finance_doc_position(u1, finance_sys_account(u1, 'ap'), bill);
  if n <> -250 then raise exception 'C: A/P should hold 250 (credit), got %', n; end if;
  select coalesce(sum(debit - credit), 0) into n from journal_lines l join chart_accounts a on a.id = l.account_id where a.id = (select account_id from bank_accounts where id = eur) and l.user_id = u1;
  -- cash must be unchanged by billing (only the EUR receipt from scenario B is in the EUR account)
  if n <> 1000 then raise exception 'C: billing must not move cash, EUR account is %', n; end if;
  perform finance_record_bill_payment(bill, 100, current_date, eur, 'Wise', '');
  select native into n from finance_doc_position(u1, finance_sys_account(u1, 'ap'), bill);
  if n <> -150 then raise exception 'D: A/P should fall to 150, got %', n; end if;
  select sum(debit) into n from journal_lines l join chart_accounts a on a.id = l.account_id where a.system_key = 'freelancer_costs' and l.user_id = u1;
  if n <> 250 then raise exception 'D: freelancer cost must be recognised once (250), got %', n; end if;
  ok := false;
  begin perform finance_record_bill_payment(bill, 100, current_date, usd, '', '');
  exception when sqlstate 'P0001' then ok := true; end;
  if not ok then raise exception 'D: paying a EUR bill from a USD account should be rejected'; end if;

  -- ---------------------------------------------------------------- E: transfer is neither revenue nor expense
  select coalesce(sum(credit), 0) into n from journal_lines l join chart_accounts a on a.id = l.account_id where a.type = 'revenue' and l.user_id = u1 and a.system_key = 'sales';
  perform finance_record_transfer(usd, usd2, 500, 500, current_date, 'xfer');
  -- Bank B started at 0
  if (select coalesce(sum(debit - credit), 0) from journal_lines where account_id = (select account_id from bank_accounts where id = usd2)) <> 500 then
    raise exception 'E: Bank B should hold 500';
  end if;
  if (select coalesce(sum(credit), 0) from journal_lines l join chart_accounts a on a.id = l.account_id where a.system_key = 'sales' and l.user_id = u1) <> n then
    raise exception 'E: a transfer must not change revenue';
  end if;

  -- ---------------------------------------------------------------- Integrity: every entry balances; ledger is immutable
  for r in select e.id, e.entry_no, sum(l.debit) - sum(l.credit) as d from journal_entries e join journal_lines l on l.entry_id = e.id
           where e.user_id = u1 and e.fx_status = 'ok' group by e.id, e.entry_no having abs(sum(l.debit) - sum(l.credit)) > 0.005 and count(distinct l.currency) = 1 loop
    raise exception 'INTEGRITY: entry #% is unbalanced natively by %', r.entry_no, r.d;
  end loop;
  for r in select e.entry_no, sum(l.base_debit) - sum(l.base_credit) as d from journal_entries e join journal_lines l on l.entry_id = e.id
           where e.user_id = u1 and e.fx_status = 'ok' group by e.id, e.entry_no having abs(sum(l.base_debit) - sum(l.base_credit)) > 0.005 loop
    raise exception 'INTEGRITY: entry #% is unbalanced in base by %', r.entry_no, r.d;
  end loop;
  ok := false;
  begin update journal_lines set debit = debit + 1 where user_id = u1 and id = (select id from journal_lines where user_id = u1 limit 1);
  exception when sqlstate 'P0001' then ok := true; end;
  if not ok then raise exception 'INTEGRITY: editing a posted line should be rejected'; end if;
  ok := false;
  begin delete from journal_entries where user_id = u1;
  exception when sqlstate 'P0001' then ok := true; end;
  if not ok then raise exception 'INTEGRITY: deleting entries should be rejected'; end if;
  ok := false;
  begin perform finance_post_entry(u1, current_date, 'bad', '', 'manual', null, 'USD', null, null, null, null,
          jsonb_build_array(jsonb_build_object('account_id', finance_sys_account(u1, 'ar'), 'debit', 10),
                            jsonb_build_object('account_id', finance_sys_account(u1, 'sales'), 'credit', 9)));
  exception when sqlstate 'P0001' then ok := true; end;
  if not ok then raise exception 'INTEGRITY: unbalanced entry should be rejected'; end if;
  -- void = reversal, original stays
  select id into entry from journal_entries where user_id = u1 and source_type = 'transfer' limit 1;
  perform finance_void_manual_entry(entry, 'test');
  if not exists (select 1 from journal_entries where id = entry and voided_by_entry_id is not null) then raise exception 'INTEGRITY: original must be marked voided'; end if;
  if not exists (select 1 from journal_entries where reverses_entry_id = entry) then raise exception 'INTEGRITY: reversal entry missing'; end if;

  -- ---------------------------------------------------------------- Security: a second user sees nothing of the first
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', u2::text, true);
  set local role authenticated;
  select count(*) into n from journal_lines;
  if n <> 0 then raise exception 'RLS: user 2 can see % of user 1''s journal lines', n; end if;
  select count(*) into n from bills;
  if n <> 0 then raise exception 'RLS: user 2 can see user 1''s bills'; end if;
  ok := false;
  begin perform finance_record_invoice_payment(inv, 1, current_date, usd, '', '');
  exception when sqlstate 'P0001' then ok := true; end;
  if not ok then raise exception 'RLS: user 2 must not be able to pay user 1''s invoice'; end if;
  ok := false;
  begin insert into journal_entries (user_id, entry_no, entry_date, currency, base_currency) values (u2, 1, current_date, 'USD', 'USD');
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'RLS: clients must not be able to insert journal entries directly'; end if;
  reset role;

  raise notice 'FINANCE V2 DB TESTS PASSED (rolling back)';
end
$$;

rollback;
