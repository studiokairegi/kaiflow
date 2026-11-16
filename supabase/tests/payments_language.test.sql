-- Client language SQL tests (migration 20270111090000). Run via supabase/tests/run.sh (needs a superuser on a scratch DB).
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
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000d1', 'd@example.com');
insert into user_settings (user_id, is_admin) values ('00000000-0000-0000-0000-0000000000d1', true) on conflict (user_id) do update set is_admin = true;
select _t.put('D', '00000000-0000-0000-0000-0000000000d1');

do $$
declare d uuid := _t.id('D'); v_proj uuid; v_inv uuid; s record;
begin
  perform _t.as_user(d);
  perform finance_create_bank_account('JPY Main', 'bank', 'JPY', 0);
  insert into projects (name, client, currency) values ('Lang P', '株式会社テスト', 'JPY') returning id into v_proj;
  insert into invoices (project_id, invoice_number, amount, currency, issue_date, due_date) values (v_proj, 'LANG-1', 50000, 'JPY', '2026-11-01', '2026-11-30') returning id into v_inv;
  perform _t.put('inv', v_inv::text);
  insert into invoices (project_id, invoice_number, amount, currency, issue_date, due_date, language) values (v_proj, 'LANG-2', 30000, 'JPY', '2026-11-01', '2026-11-30', 'ja') returning id into v_inv;
  perform _t.put('invJa', v_inv::text);
  perform payments_list_providers();
  perform _t.as_service();
  perform payments_connect_paystack(d, 'live');
  perform _t.as_user(d);
  perform _t.put('proj', v_proj::text);
  perform _t.as_admin();
end $$;

-- ------------------------------------------------------------------ defaults and constraints
do $$
declare d uuid := _t.id('D');
begin
  perform _t.chk('invoice language defaults to en', (select language = 'en' from invoices where id = _t.id('inv')));
  perform _t.chk('invoice created as ja keeps ja', (select language = 'ja' from invoices where id = _t.id('invJa')));
  perform _t.as_user(d);
  perform _t.chk('an unsupported invoice language is refused by the database', _t.err(format('update invoices set language = %L where id = %L', 'fr', _t.id('inv'))) ilike '%invoices_language_check%');
  perform _t.chk('user_settings has empty Japanese instruction columns by default', (select invoice_payment_instructions_ja = '' and invoice_footer_note_ja = '' from user_settings where user_id = d));
  perform _t.as_admin();
end $$;

-- ------------------------------------------------------------------ payment links
do $$
declare d uuid := _t.id('D'); s record; v jsonb;
begin
  perform _t.as_user(d);
  select * into s from payments_create_checkout_session(_t.id('inv'), null, 14);                     -- 3 arguments: old callers keep working
  perform _t.put('tokEn', s.token); perform _t.put('sessEn', s.session_id::text);
  perform _t.chk('3-argument call still works and returns en for an en invoice', s.language = 'en');
  select * into s from payments_create_checkout_session(_t.id('invJa'), null, 14);
  perform _t.put('tokJa', s.token);
  perform _t.chk('a link inherits the invoice language (ja)', s.language = 'ja' and (select language from payment_checkout_sessions where id = s.session_id) = 'ja');
  select * into s from payments_create_checkout_session(_t.id('invJa'), null, 14, 'en');
  perform _t.chk('an explicit language overrides the invoice language', s.language = 'en');
  select * into s from payments_create_checkout_session(_t.id('inv'), null, 14, ' JA ');
  perform _t.chk('explicit language is trimmed and case-insensitive', s.language = 'ja');
  perform _t.chk('an unsupported link language is refused', _t.err(format('select * from payments_create_checkout_session(%L, null, 14, %L)', _t.id('inv'), 'fr')) ilike '%Unsupported%');
  perform _t.chk('an empty link language falls back to the invoice language', (select language = 'ja' from payments_create_checkout_session(_t.id('invJa'), null, 14, '')));

  perform _t.as_anon();
  v := payments_public_checkout(_t.get('tokJa'));
  perform _t.chk('public view returns the link language (ja)', v->>'language' = 'ja' and v->>'found' = 'true');
  v := payments_public_checkout(_t.get('tokEn'));
  perform _t.chk('public view returns the link language (en)', v->>'language' = 'en');
  perform _t.chk('anonymous callers cannot create links', _t.err(format('select * from payments_create_checkout_session(%L, null, 14, %L)', _t.id('inv'), 'ja')) ilike '%permission denied%');
  perform _t.as_user(d);

  -- the link keeps the language it was sent in, even if the invoice changes later
  update invoices set language = 'ja' where id = _t.id('inv');
  perform _t.chk('changing the invoice language later leaves existing links alone', (select language = 'en' from payment_checkout_sessions where id = _t.id('sessEn')));
  perform _t.chk('changing only the language does not trip the ledger guard or re-post the invoice', (select language = 'ja' from invoices where id = _t.id('inv')));
  perform _t.as_admin();
end $$;

-- ------------------------------------------------------------------ milestone invoices
do $$
declare d uuid := _t.id('D'); n int;
begin
  perform _t.as_user(d);
  select count(*) into n from create_milestone_invoices(jsonb_build_array(
    jsonb_build_object('projectId', _t.get('proj'), 'invoiceNumber', 'M-1', 'amount', '100', 'currency', 'JPY', 'issueDate', '2026-11-01', 'dueDate', '', 'status', 'unpaid', 'language', 'ja'),
    jsonb_build_object('projectId', _t.get('proj'), 'invoiceNumber', 'M-2', 'amount', '100', 'currency', 'JPY', 'issueDate', '2026-11-01', 'dueDate', '', 'status', 'unpaid'),
    jsonb_build_object('projectId', _t.get('proj'), 'invoiceNumber', 'M-3', 'amount', '100', 'currency', 'JPY', 'issueDate', '2026-11-01', 'dueDate', '', 'status', 'unpaid', 'language', 'xx')));
  perform _t.chk('milestone RPC creates all rows', n = 3);
  perform _t.chk('milestone RPC carries ja, defaults to en, and ignores junk', (select language from invoices where invoice_number = 'M-1') = 'ja'
    and (select language from invoices where invoice_number = 'M-2') = 'en' and (select language from invoices where invoice_number = 'M-3') = 'en');
  perform _t.as_admin();
end $$;

-- ------------------------------------------------------------------ summary
do $$
declare v_fail int;
begin
  select count(*) into v_fail from _t.results where not ok;
  raise notice 'SUMMARY: % checks, % failed', (select count(*) from _t.results), v_fail;
  if v_fail > 0 then raise exception 'FAILED CHECKS: %', v_fail; end if;
end $$;
