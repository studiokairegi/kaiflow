-- Finance V3, Phase 5 (migration 1 of 1): read services for the Finance user interface.
--
-- READ-ONLY apart from one preference row. No posting, no change to any ledger or money table. The Simple and Accountant screens call
-- the same functions; the UI computes nothing. Every figure here is derived in SQL from the ledger or from the Phase 3/4 documents.
--   * fin3_get_ui_prefs / fin3_set_ui_prefs   per user and studio: Simple or Accountant Mode (default simple). A preference only.
--   * fin3_overview                           the Simple Mode overview, one call, one currency
--   * fin3_explain_safe_to_spend              safe-to-spend traced to cash accounts and to each commitment behind every deduction
--   * fin3_report_profit_loss / _balance_sheet / _cash_flow / _general_ledger / _tax_summary   Accountant Mode statements
--   * fin3_list_entries / fin3_list_audit / fin3_list_receipts
--   * fin3_preview_invoice_email, and fin3_queue_invoice_email (Phase 3) now accepts optional `subject` and `message` options
-- The reporting functions are the Phase 6 `fin3_report_*` family brought forward because Accountant Mode needs them; Phase 6 extends them.
-- Rollback: supabase/rollback/20270116090000_finance_v3_ui_services.rollback.sql

begin;

insert into finance_v3.schema_version (version, notes)
values ('20270116090000', 'phase 5: UI read services (prefs, overview, safe-to-spend explain, statements, ledger, audit, receipts)')
on conflict (version) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- UI preference (mode only). One row per user and studio. Written only by fin3_set_ui_prefs.
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists finance_v3.ui_prefs (
  organization_id uuid not null references finance_v3.org_settings(organization_id) on delete restrict,
  user_id         uuid not null,
  mode            text not null default 'simple' check (mode in ('simple', 'accountant')),
  updated_at      timestamptz not null default now(),
  primary key (organization_id, user_id)
);
alter table finance_v3.ui_prefs enable row level security;
drop policy if exists fin3_select_ui_prefs on finance_v3.ui_prefs;
create policy fin3_select_ui_prefs on finance_v3.ui_prefs for select to authenticated
  using (user_id = auth.uid() and finance_v3.has_permission(organization_id, 'finance.read'));
revoke all on finance_v3.ui_prefs from public, anon, authenticated, service_role;
grant select on finance_v3.ui_prefs to authenticated;

create or replace function public.fin3_get_ui_prefs(p_org uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare v_uid uuid; v_mode text;
begin
  v_uid := finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  select x.mode into v_mode from finance_v3.ui_prefs x where x.organization_id = p_org and x.user_id = v_uid;
  return jsonb_build_object('mode', coalesce(v_mode, 'simple'), 'is_default', v_mode is null);
end;
$$;

create or replace function public.fin3_set_ui_prefs(p_org uuid, p_prefs jsonb)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare v_uid uuid; v_mode text; k text;
begin
  v_uid := finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  if p_prefs is null or jsonb_typeof(p_prefs) <> 'object' then raise exception 'Preferences must be an object.' using errcode = 'V3011'; end if;
  for k in select jsonb_object_keys(p_prefs) loop
    if k <> 'mode' then raise exception 'Unknown preference "%".', left(k, 40) using errcode = 'V3011'; end if;
  end loop;
  if jsonb_typeof(p_prefs -> 'mode') is distinct from 'string' then raise exception 'Mode must be simple or accountant.' using errcode = 'V3011'; end if;
  v_mode := p_prefs ->> 'mode';
  if v_mode not in ('simple', 'accountant') then raise exception 'Mode must be simple or accountant.' using errcode = 'V3011'; end if;
  insert into finance_v3.ui_prefs (organization_id, user_id, mode) values (p_org, v_uid, v_mode)
  on conflict (organization_id, user_id) do update set mode = excluded.mode, updated_at = now();
  return jsonb_build_object('mode', v_mode, 'is_default', false);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Reporting helper: per-account debit/credit totals for a date range.
--   currency = base (or null): BASE basis (amount_base, entries with a missing FX rate are excluded and counted by the caller)
--   any other currency:        NATIVE basis (exact, lines in that currency only)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.rpt_totals(p_org uuid, p_from date, p_to date, p_ccy text, p_base text)
returns table (account_id uuid, debit numeric, credit numeric)
language sql stable security definer
set search_path = pg_catalog, finance_v3
as $$
  select l.account_id,
         coalesce(sum(case when p_ccy = p_base then l.amount_base else l.amount_native end) filter (where l.side = 'debit'), 0),
         coalesce(sum(case when p_ccy = p_base then l.amount_base else l.amount_native end) filter (where l.side = 'credit'), 0)
    from finance_v3.journal_lines l join finance_v3.journal_entries e on e.id = l.entry_id
   where l.organization_id = p_org and e.status = 'posted'
     and (p_from is null or e.accounting_date >= p_from) and e.accounting_date <= p_to
     and ((p_ccy = p_base and l.amount_base is not null) or (p_ccy <> p_base and l.currency = p_ccy))
   group by l.account_id
$$;

create or replace function finance_v3.rpt_ccy(p_org uuid, p_currency text)
returns text
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare s finance_v3.org_settings; v text := upper(nullif(btrim(p_currency), ''));
begin
  s := finance_v3.assert_org_ready(p_org);
  if v is null then return s.base_currency; end if;
  if not exists (select 1 from finance_v3.currencies c where c.code = v) then raise exception 'Unknown currency "%".', left(v, 10) using errcode = 'V3011'; end if;
  return v;
end;
$$;

create or replace function finance_v3.rpt_missing_fx(p_org uuid, p_from date, p_to date)
returns integer
language sql stable security definer
set search_path = pg_catalog, finance_v3
as $$
  select count(*)::integer from finance_v3.journal_entries e
   where e.organization_id = p_org and e.status = 'posted' and e.fx_status = 'missing'
     and (p_from is null or e.accounting_date >= p_from) and e.accounting_date <= p_to
$$;

-- section rows for one set of account types, signed in the account's normal direction
create or replace function finance_v3.rpt_section(p_org uuid, p_from date, p_to date, p_ccy text, p_base text, p_types text[])
returns table (rows_json jsonb, total numeric)
language sql stable security definer
set search_path = pg_catalog, finance_v3
as $$
  with t as (
    select a.id, a.code, a.name, a.account_type,
           case when a.normal_balance = 'debit' then r.debit - r.credit else r.credit - r.debit end as amt
      from finance_v3.rpt_totals(p_org, p_from, p_to, p_ccy, p_base) r
      join finance_v3.accounts a on a.organization_id = p_org and a.id = r.account_id
     where a.account_type = any (p_types))
  select coalesce(jsonb_agg(jsonb_build_object('account_id', id, 'code', code, 'name', name, 'account_type', account_type,
                                               'amount', finance_v3.money_text(amt, p_ccy)) order by code) filter (where amt <> 0), '[]'::jsonb),
         coalesce(sum(amt), 0)
    from t
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Profit and loss
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fin3_report_profit_loss(p_org uuid, p_from date, p_to date, p_currency text default null)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_ccy text; s finance_v3.org_settings;
  rev record; cos record; opx record; oin record; oex record;
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  s := finance_v3.assert_org_ready(p_org);
  if p_from is null or p_to is null or p_from > p_to then raise exception 'Choose a valid period (from must not be after to).' using errcode = 'V3011'; end if;
  v_ccy := finance_v3.rpt_ccy(p_org, p_currency);
  select * into rev from finance_v3.rpt_section(p_org, p_from, p_to, v_ccy, s.base_currency, array['revenue']);
  select * into cos from finance_v3.rpt_section(p_org, p_from, p_to, v_ccy, s.base_currency, array['cost_of_sales']);
  select * into opx from finance_v3.rpt_section(p_org, p_from, p_to, v_ccy, s.base_currency, array['operating_expense']);
  select * into oin from finance_v3.rpt_section(p_org, p_from, p_to, v_ccy, s.base_currency, array['other_income']);
  select * into oex from finance_v3.rpt_section(p_org, p_from, p_to, v_ccy, s.base_currency, array['other_expense']);
  return jsonb_build_object('currency', v_ccy, 'basis', case when v_ccy = s.base_currency then 'base' else 'native' end,
    'from', p_from, 'to', p_to,
    'revenue', jsonb_build_object('rows', rev.rows_json, 'total', finance_v3.money_text(rev.total, v_ccy)),
    'cost_of_sales', jsonb_build_object('rows', cos.rows_json, 'total', finance_v3.money_text(cos.total, v_ccy)),
    'gross_profit', finance_v3.money_text(rev.total - cos.total, v_ccy),
    'operating_expenses', jsonb_build_object('rows', opx.rows_json, 'total', finance_v3.money_text(opx.total, v_ccy)),
    'operating_profit', finance_v3.money_text(rev.total - cos.total - opx.total, v_ccy),
    'other_income', jsonb_build_object('rows', oin.rows_json, 'total', finance_v3.money_text(oin.total, v_ccy)),
    'other_expenses', jsonb_build_object('rows', oex.rows_json, 'total', finance_v3.money_text(oex.total, v_ccy)),
    'net_profit', finance_v3.money_text(rev.total - cos.total - opx.total + oin.total - oex.total, v_ccy),
    'excluded_entries_missing_fx', case when v_ccy = s.base_currency then finance_v3.rpt_missing_fx(p_org, p_from, p_to) else 0 end);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Balance sheet. There are no closing entries, so profit to date is shown as its own equity line ("current earnings").
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fin3_report_balance_sheet(p_org uuid, p_as_of date default null, p_currency text default null)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_ccy text; s finance_v3.org_settings; v_asof date := coalesce(p_as_of, current_date);
  a record; l record; e record; pl record; v_earn numeric; v_tle numeric;
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  s := finance_v3.assert_org_ready(p_org);
  v_ccy := finance_v3.rpt_ccy(p_org, p_currency);
  select * into a from finance_v3.rpt_section(p_org, null, v_asof, v_ccy, s.base_currency, array['asset']);
  select * into l from finance_v3.rpt_section(p_org, null, v_asof, v_ccy, s.base_currency, array['liability']);
  select * into e from finance_v3.rpt_section(p_org, null, v_asof, v_ccy, s.base_currency, array['equity']);
  select coalesce(sum(case when t.account_type in ('revenue', 'other_income') then t.amt else -t.amt end), 0) into v_earn from (
    select x.account_type, case when x.normal_balance = 'debit' then r.debit - r.credit else r.credit - r.debit end as amt
      from finance_v3.rpt_totals(p_org, null, v_asof, v_ccy, s.base_currency) r
      join finance_v3.accounts x on x.organization_id = p_org and x.id = r.account_id
     where x.account_type in ('revenue', 'cost_of_sales', 'operating_expense', 'other_income', 'other_expense')) t;
  v_tle := l.total + e.total + v_earn;
  return jsonb_build_object('currency', v_ccy, 'basis', case when v_ccy = s.base_currency then 'base' else 'native' end, 'as_of', v_asof,
    'assets', jsonb_build_object('rows', a.rows_json, 'total', finance_v3.money_text(a.total, v_ccy)),
    'liabilities', jsonb_build_object('rows', l.rows_json, 'total', finance_v3.money_text(l.total, v_ccy)),
    'equity', jsonb_build_object('rows', e.rows_json, 'current_earnings', finance_v3.money_text(v_earn, v_ccy),
                                 'total', finance_v3.money_text(e.total + v_earn, v_ccy)),
    'total_liabilities_and_equity', finance_v3.money_text(v_tle, v_ccy),
    'balanced', a.total = v_tle,
    'difference', finance_v3.money_text(a.total - v_tle, v_ccy),
    'excluded_entries_missing_fx', case when v_ccy = s.base_currency then finance_v3.rpt_missing_fx(p_org, null, v_asof) else 0 end);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Cash flow (direct method) over the same cash accounts safe-to-spend uses. Grouped by the kind of financial event that moved the money.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fin3_report_cash_flow(p_org uuid, p_from date, p_to date, p_currency text default null)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_ccy text; s finance_v3.org_settings; v_open numeric; v_close numeric; v_rows jsonb; v_net numeric;
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  s := finance_v3.assert_org_ready(p_org);
  if p_from is null or p_to is null or p_from > p_to then raise exception 'Choose a valid period (from must not be after to).' using errcode = 'V3011'; end if;
  v_ccy := finance_v3.rpt_ccy(p_org, p_currency);
  select coalesce(sum(r.debit - r.credit), 0) into v_open from finance_v3.rpt_totals(p_org, null, p_from - 1, v_ccy, s.base_currency) r
   where r.account_id in (select c.account_id from finance_v3.cash_account_ids(p_org) c);
  select coalesce(sum(r.debit - r.credit), 0) into v_close from finance_v3.rpt_totals(p_org, null, p_to, v_ccy, s.base_currency) r
   where r.account_id in (select c.account_id from finance_v3.cash_account_ids(p_org) c);
  with m as (
    select coalesce(ev.kind, 'manual_journal') as kind,
           coalesce(sum(case when v_ccy = s.base_currency then l.amount_base else l.amount_native end) filter (where l.side = 'debit'), 0) as inflow,
           coalesce(sum(case when v_ccy = s.base_currency then l.amount_base else l.amount_native end) filter (where l.side = 'credit'), 0) as outflow
      from finance_v3.journal_lines l
      join finance_v3.journal_entries e on e.id = l.entry_id
      left join finance_v3.events ev on ev.id = e.event_id
     where l.organization_id = p_org and e.status = 'posted' and e.accounting_date between p_from and p_to
       and l.account_id in (select c.account_id from finance_v3.cash_account_ids(p_org) c)
       and ((v_ccy = s.base_currency and l.amount_base is not null) or (v_ccy <> s.base_currency and l.currency = v_ccy))
     group by 1)
  select coalesce(jsonb_agg(jsonb_build_object('kind', kind,
           'class', case when kind in ('owner_contribution', 'owner_draw') then 'financing' when kind = 'bank_transfer' then 'internal' else 'operating' end,
           'inflow', finance_v3.money_text(inflow, v_ccy), 'outflow', finance_v3.money_text(outflow, v_ccy),
           'net', finance_v3.money_text(inflow - outflow, v_ccy)) order by kind), '[]'::jsonb),
         coalesce(sum(inflow - outflow), 0)
    into v_rows, v_net from m;
  return jsonb_build_object('currency', v_ccy, 'basis', case when v_ccy = s.base_currency then 'base' else 'native' end, 'from', p_from, 'to', p_to,
    'opening_cash', finance_v3.money_text(v_open, v_ccy), 'rows', v_rows, 'net_change', finance_v3.money_text(v_net, v_ccy),
    'closing_cash', finance_v3.money_text(v_close, v_ccy), 'reconciles', v_open + v_net = v_close,
    'note', 'Cash accounts are those counted by safe-to-spend: active accounts under Cash and Bank, excluding Online Payments Clearing and account reserves.');
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- General ledger for one account: opening balance, lines with a running balance, closing balance. Paginated.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fin3_report_general_ledger(p_org uuid, p_account uuid, p_from date default null, p_to date default null,
                                                              p_currency text default null, p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_ccy text; s finance_v3.org_settings; ac finance_v3.accounts; v_to date := coalesce(p_to, current_date);
  v_open numeric := 0; v_sign integer; v_rows jsonb; v_total integer; v_close numeric;
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  s := finance_v3.assert_org_ready(p_org);
  v_ccy := finance_v3.rpt_ccy(p_org, p_currency);
  select * into ac from finance_v3.accounts x where x.organization_id = p_org and x.id = p_account;
  if not found then raise exception 'Account not found.' using errcode = 'V3010'; end if;
  if p_from is not null and p_from > v_to then raise exception 'Choose a valid period.' using errcode = 'V3011'; end if;
  v_sign := case when ac.normal_balance = 'debit' then 1 else -1 end;
  if p_from is not null then
    select coalesce(sum(r.debit - r.credit), 0) * v_sign into v_open from finance_v3.rpt_totals(p_org, null, p_from - 1, v_ccy, s.base_currency) r where r.account_id = p_account;
  end if;
  with ln as (
    select e.accounting_date, e.id as entry_id, e.entry_no, e.reference, e.memo as entry_memo, l.line_no, l.memo as line_memo, l.side, l.currency,
           case when v_ccy = s.base_currency then l.amount_base else l.amount_native end as amt
      from finance_v3.journal_lines l join finance_v3.journal_entries e on e.id = l.entry_id
     where l.organization_id = p_org and l.account_id = p_account and e.status = 'posted'
       and (p_from is null or e.accounting_date >= p_from) and e.accounting_date <= v_to
       and ((v_ccy = s.base_currency and l.amount_base is not null) or (v_ccy <> s.base_currency and l.currency = v_ccy))),
  run as (
    select ln.*, v_open + sum(case when side = 'debit' then amt else -amt end * v_sign) over (order by accounting_date, entry_no, line_no
                                                                                           rows between unbounded preceding and current row) as bal,
           count(*) over () as n
      from ln),
  pg as (select * from run order by accounting_date, entry_no, line_no limit finance_v3.clamp_limit(p_limit) offset finance_v3.clamp_offset(p_offset))
  select coalesce(jsonb_agg(jsonb_build_object('date', accounting_date, 'entry_id', entry_id, 'entry_no', entry_no, 'reference', reference,
           'memo', coalesce(line_memo, entry_memo), 'debit', case when side = 'debit' then finance_v3.money_text(amt, v_ccy) end,
           'credit', case when side = 'credit' then finance_v3.money_text(amt, v_ccy) end, 'balance', finance_v3.money_text(bal, v_ccy)) order by accounting_date, entry_no, line_no), '[]'::jsonb),
         coalesce(max(n), 0)
    into v_rows, v_total from pg;
  select v_open + coalesce(sum(case when side = 'debit' then amt else -amt end), 0) * v_sign into v_close from (
    select l.side, case when v_ccy = s.base_currency then l.amount_base else l.amount_native end as amt
      from finance_v3.journal_lines l join finance_v3.journal_entries e on e.id = l.entry_id
     where l.organization_id = p_org and l.account_id = p_account and e.status = 'posted'
       and (p_from is null or e.accounting_date >= p_from) and e.accounting_date <= v_to
       and ((v_ccy = s.base_currency and l.amount_base is not null) or (v_ccy <> s.base_currency and l.currency = v_ccy))) q;
  return jsonb_build_object('account', jsonb_build_object('id', ac.id, 'code', ac.code, 'name', ac.name, 'account_type', ac.account_type, 'normal_balance', ac.normal_balance),
    'currency', v_ccy, 'basis', case when v_ccy = s.base_currency then 'base' else 'native' end, 'from', p_from, 'to', v_to,
    'opening_balance', finance_v3.money_text(v_open, v_ccy), 'closing_balance', finance_v3.money_text(v_close, v_ccy),
    'total_lines', v_total, 'limit', finance_v3.clamp_limit(p_limit), 'offset', finance_v3.clamp_offset(p_offset), 'lines', v_rows);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Journal entries list (with the lines of each), audit history, receipts list, tax summary
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fin3_list_entries(p_org uuid, p_from date default null, p_to date default null, p_search text default null,
                                                    p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare v_search text := nullif(btrim(p_search), ''); v_total integer; v_items jsonb;
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  if v_search is not null and char_length(v_search) > 100 then raise exception 'Search text is too long.' using errcode = 'V3011'; end if;
  select count(*) into v_total from finance_v3.journal_entries e
   where e.organization_id = p_org and e.status = 'posted' and (p_from is null or e.accounting_date >= p_from) and (p_to is null or e.accounting_date <= p_to)
     and (v_search is null or e.memo ilike '%' || replace(replace(v_search, '%', ''), '_', '') || '%' or e.reference ilike '%' || replace(replace(v_search, '%', ''), '_', '') || '%' or e.entry_no::text = v_search);
  select coalesce(jsonb_agg(x.item order by x.d desc, x.no desc), '[]'::jsonb) into v_items from (
    select e.accounting_date as d, e.entry_no as no, jsonb_build_object('id', e.id, 'entry_no', e.entry_no, 'date', e.accounting_date, 'memo', e.memo, 'reference', e.reference,
             'kind', ev.kind, 'fx_status', e.fx_status, 'reverses_entry_id', e.reverses_entry_id, 'reversal_reason', e.reversal_reason,
             'reversed', exists (select 1 from finance_v3.journal_entries r where r.organization_id = p_org and r.reverses_entry_id = e.id),
             'lines', (select coalesce(jsonb_agg(jsonb_build_object('line_no', l.line_no, 'account_code', a.code, 'account_name', a.name, 'side', l.side,
                         'amount', finance_v3.money_text(l.amount_native, l.currency), 'currency', l.currency,
                         'amount_base', case when l.amount_base is null then null else finance_v3.money_text(l.amount_base, e.base_currency) end,
                         'memo', l.memo) order by l.line_no), '[]'::jsonb)
                         from finance_v3.journal_lines l join finance_v3.accounts a on a.organization_id = l.organization_id and a.id = l.account_id where l.entry_id = e.id)) as item
      from finance_v3.journal_entries e left join finance_v3.events ev on ev.id = e.event_id
     where e.organization_id = p_org and e.status = 'posted' and (p_from is null or e.accounting_date >= p_from) and (p_to is null or e.accounting_date <= p_to)
       and (v_search is null or e.memo ilike '%' || replace(replace(v_search, '%', ''), '_', '') || '%' or e.reference ilike '%' || replace(replace(v_search, '%', ''), '_', '') || '%' or e.entry_no::text = v_search)
     order by e.accounting_date desc, e.entry_no desc limit finance_v3.clamp_limit(p_limit) offset finance_v3.clamp_offset(p_offset)) x;
  return jsonb_build_object('total', v_total, 'limit', finance_v3.clamp_limit(p_limit), 'offset', finance_v3.clamp_offset(p_offset), 'items', v_items);
end;
$$;

create or replace function public.fin3_list_audit(p_org uuid, p_object_type text default null, p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare v_total integer; v_items jsonb; v_type text := nullif(btrim(p_object_type), '');
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  select count(*) into v_total from finance_v3.audit_log a where a.organization_id = p_org and (v_type is null or a.object_type = v_type);
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'at', x.at, 'actor', x.actor, 'action', x.action, 'object_type', x.object_type, 'object_id', x.object_id,
           'reason', x.reason) order by x.at desc, x.id desc), '[]'::jsonb) into v_items from (
    select * from finance_v3.audit_log a where a.organization_id = p_org and (v_type is null or a.object_type = v_type)
     order by a.at desc, a.id desc limit finance_v3.clamp_limit(p_limit) offset finance_v3.clamp_offset(p_offset)) x;
  return jsonb_build_object('total', v_total, 'limit', finance_v3.clamp_limit(p_limit), 'offset', finance_v3.clamp_offset(p_offset), 'items', v_items);
end;
$$;

create or replace function public.fin3_list_receipts(p_org uuid, p_invoice uuid default null, p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare v_total integer; v_items jsonb;
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  select count(*) into v_total from finance_v3.receipts r where r.organization_id = p_org and (p_invoice is null or r.invoice_id = p_invoice);
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'receipt_no', x.receipt_no, 'status', x.status, 'issued_at', x.issued_at, 'invoice_id', x.invoice_id,
           'invoice_no', x.invoice_no, 'payment_id', x.payment_id, 'amount', finance_v3.money_text(x.amount, x.currency), 'currency', x.currency,
           'email_status', x.email_status) order by x.issued_at desc, x.id desc), '[]'::jsonb) into v_items from (
    select r.id, r.receipt_no, r.status, r.issued_at, r.invoice_id, i.invoice_no, r.payment_id, p.amount, p.currency,
           (select m.status from finance_v3.email_messages m where m.organization_id = p_org and m.receipt_id = r.id order by m.created_at desc limit 1) as email_status
      from finance_v3.receipts r
      join finance_v3.payments p on p.organization_id = r.organization_id and p.id = r.payment_id
      join finance_v3.receivables i on i.organization_id = r.organization_id and i.id = r.invoice_id
     where r.organization_id = p_org and (p_invoice is null or r.invoice_id = p_invoice)
     order by r.issued_at desc, r.id desc limit finance_v3.clamp_limit(p_limit) offset finance_v3.clamp_offset(p_offset)) x;
  return jsonb_build_object('total', v_total, 'limit', finance_v3.clamp_limit(p_limit), 'offset', finance_v3.clamp_offset(p_offset), 'items', v_items);
end;
$$;

-- Tax classifications: sales tax by rate from issued invoices. Supplier bills do not carry a tax split in V3 yet, and the result says so.
create or replace function public.fin3_report_tax_summary(p_org uuid, p_from date, p_to date, p_currency text default null)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare v_ccy text; v_rows jsonb; v_net numeric; v_tax numeric;
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  if p_from is null or p_to is null or p_from > p_to then raise exception 'Choose a valid period (from must not be after to).' using errcode = 'V3011'; end if;
  v_ccy := finance_v3.rpt_ccy(p_org, p_currency);
  select coalesce(jsonb_agg(jsonb_build_object('tax_rate', rate::text, 'classification', case when rate = 0 then 'zero_rated_or_exempt' else 'standard' end,
           'taxable_net', finance_v3.money_text(net, v_ccy), 'tax', finance_v3.money_text(tax, v_ccy), 'invoices', n) order by rate), '[]'::jsonb),
         coalesce(sum(net), 0), coalesce(sum(tax), 0)
    into v_rows, v_net, v_tax from (
    select l.tax_rate as rate, sum(l.net_amount) as net, sum(l.tax_amount) as tax, count(distinct r.id) as n
      from finance_v3.receivable_lines l join finance_v3.receivables r on r.organization_id = l.organization_id and r.id = l.receivable_id
     where r.organization_id = p_org and r.currency = v_ccy and r.status in ('issued', 'partially_paid', 'paid', 'credited')
       and r.issue_date between p_from and p_to
     group by l.tax_rate) t;
  return jsonb_build_object('currency', v_ccy, 'from', p_from, 'to', p_to,
    'sales', jsonb_build_object('rows', v_rows, 'taxable_net', finance_v3.money_text(v_net, v_ccy), 'tax', finance_v3.money_text(v_tax, v_ccy)),
    'purchases', jsonb_build_object('tracked', false, 'note', 'Supplier bills do not carry a tax split in Finance V3 yet.'),
    'basis', 'invoice documents in their own currency (not converted)');
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Safe-to-spend explanation: the Phase 4 breakdown plus the commitments behind every deduction and the ledger accounts behind the cash.
-- The headline numbers are read from the SAME function as fin3_safe_to_spend, so the two can never disagree.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fin3_explain_safe_to_spend(p_org uuid, p_currency text default null)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  s finance_v3.org_settings; v_ccy text; v_h smallint; v_base jsonb; v_items jsonb;
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  s := finance_v3.assert_org_ready(p_org);
  v_ccy := finance_v3.rpt_ccy(p_org, p_currency);
  select coalesce(max(ps.commitment_horizon_days), 30) into v_h from finance_v3.protection_settings ps where ps.organization_id = p_org;
  v_base := finance_v3.safe_to_spend_json(p_org, v_ccy);
  v_items := jsonb_build_object(
    'animator_obligations', (select coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'ref', w.work_ref, 'description', w.description, 'outstanding', finance_v3.money_text(w.outstanding, v_ccy),
        'ledger_account', '2100 Animator Payables') order by w.created_at), '[]'::jsonb)
        from (select * from finance_v3.animator_work_items x where x.organization_id = p_org and x.currency = v_ccy and x.status = 'approved' and x.outstanding > 0 order by x.created_at limit 100) w),
    'approved_bills', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'bill_no', b.bill_no, 'due_date', b.due_date, 'outstanding', finance_v3.money_text(b.outstanding, v_ccy),
        'ledger_account', '2000 Accounts Payable') order by b.due_date nulls last), '[]'::jsonb)
        from (select * from finance_v3.payables x where x.organization_id = p_org and x.currency = v_ccy and x.status in ('approved', 'partially_paid') order by x.due_date nulls last limit 100) b),
    'scheduled_owner_payments', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'kind', o.kind, 'scheduled_for', o.scheduled_for, 'amount', finance_v3.money_text(o.amount, v_ccy)) order by o.scheduled_for), '[]'::jsonb)
        from (select * from finance_v3.owner_payments x where x.organization_id = p_org and x.currency = v_ccy and x.status = 'scheduled'
                 and x.kind in ('salary', 'draw', 'personal_withdrawal', 'reimbursement') and x.scheduled_for <= current_date + v_h order by x.scheduled_for limit 100) o),
    'allocations', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'project_id', a.project_id, 'purpose', a.purpose, 'remaining', finance_v3.money_text(a.remaining, v_ccy)) order by a.created_at), '[]'::jsonb)
        from (select * from finance_v3.fund_allocations x where x.organization_id = p_org and x.currency = v_ccy and x.remaining > 0 order by x.created_at limit 100) a));
  return v_base || jsonb_build_object('commitment_horizon_days', v_h, 'items', v_items,
    'how_it_is_worked_out', 'Available cash, minus every deduction listed, gives the raw figure. Safe to spend is the raw figure, never below zero.');
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Simple Mode overview: one currency, one call. Money figures come from the ledger and the Phase 3/4 documents; warnings are rules, not guesses.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fin3_overview(p_org uuid, p_currency text default null)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  s finance_v3.org_settings; v_ccy text; p record; j jsonb;
  v_acct_res numeric; v_recv numeric; v_overdue numeric; v_overdue_n integer; v_recv_30 numeric; v_failed integer; v_pending integer; v_review integer;
  v_below integer; v_warn jsonb := '[]'::jsonb; v_mode text;
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  s := finance_v3.assert_org_ready(p_org);
  v_ccy := finance_v3.rpt_ccy(p_org, p_currency);
  select * into p from finance_v3.safe_to_spend_parts(p_org, v_ccy);
  j := finance_v3.safe_to_spend_json(p_org, v_ccy);
  select coalesce(sum(finance_v3.reserve_balance(p_org, r.id)), 0) into v_acct_res from finance_v3.reserves r
   where r.organization_id = p_org and r.currency = v_ccy and r.is_active and r.mode = 'account';
  select coalesce(sum(r.outstanding), 0), coalesce(sum(r.outstanding) filter (where r.due_date < current_date), 0), count(*) filter (where r.due_date < current_date)
    into v_recv, v_overdue, v_overdue_n
    from finance_v3.receivables r where r.organization_id = p_org and r.currency = v_ccy and r.status in ('issued', 'partially_paid');
  select coalesce(sum(x.amount), 0) into v_recv_30 from finance_v3.payments x
   where x.organization_id = p_org and x.currency = v_ccy and x.verification_status = 'verified' and x.status in ('recorded', 'partially_refunded') and x.received_at >= now() - interval '30 days';
  select count(*) into v_failed from finance_v3.email_messages m where m.organization_id = p_org and m.status in ('failed', 'bounced') and m.created_at >= now() - interval '30 days';
  select count(*) into v_pending from finance_v3.payments x where x.organization_id = p_org and x.currency = v_ccy and x.verification_status = 'pending_verification';
  select count(*) into v_review from finance_v3.payment_intents i where i.organization_id = p_org and i.status = 'needs_review';
  select count(*) into v_below from finance_v3.reserves r where r.organization_id = p_org and r.currency = v_ccy and r.is_active and r.minimum_amount > 0 and finance_v3.reserve_balance(p_org, r.id) < r.minimum_amount;
  select coalesce(max(ps.mode), 'block') into v_mode from finance_v3.protection_settings ps where ps.organization_id = p_org;

  if p.raw < 0 then v_warn := v_warn || jsonb_build_array(jsonb_build_object('code', 'cash_shortfall', 'severity', 'critical',
      'message', 'Your commitments are higher than the cash you have. Do not spend until money comes in.', 'amount', finance_v3.money_text(-p.raw, v_ccy))); end if;
  if v_overdue_n > 0 then v_warn := v_warn || jsonb_build_array(jsonb_build_object('code', 'overdue_invoices', 'severity', 'warning',
      'message', v_overdue_n || ' invoice(s) are past their due date.', 'amount', finance_v3.money_text(v_overdue, v_ccy), 'count', v_overdue_n)); end if;
  if v_below > 0 then v_warn := v_warn || jsonb_build_array(jsonb_build_object('code', 'reserve_below_minimum', 'severity', 'warning',
      'message', v_below || ' reserve(s) are below the minimum you set.', 'count', v_below)); end if;
  if v_pending > 0 then v_warn := v_warn || jsonb_build_array(jsonb_build_object('code', 'payments_awaiting_verification', 'severity', 'info',
      'message', v_pending || ' payment(s) are waiting for you to check them. They are not counted as cash yet.', 'count', v_pending)); end if;
  if v_review > 0 then v_warn := v_warn || jsonb_build_array(jsonb_build_object('code', 'payments_need_review', 'severity', 'warning',
      'message', v_review || ' online payment(s) need a review before they can be counted.', 'count', v_review)); end if;
  if v_failed > 0 then v_warn := v_warn || jsonb_build_array(jsonb_build_object('code', 'emails_failed', 'severity', 'warning',
      'message', v_failed || ' invoice or receipt email(s) did not reach the client in the last 30 days.', 'count', v_failed)); end if;
  if v_mode = 'warn' then v_warn := v_warn || jsonb_build_array(jsonb_build_object('code', 'protection_warn_mode', 'severity', 'info',
      'message', 'Spending protection is in warn-only mode: unsafe spending is recorded but not stopped.')); end if;

  return jsonb_build_object('currency', v_ccy, 'base_currency', s.base_currency,
    'money_in_bank', finance_v3.money_text(p.cash + v_acct_res, v_ccy),
    'money_received_last_30_days', finance_v3.money_text(v_recv_30, v_ccy),
    'clients_owe_you', finance_v3.money_text(v_recv, v_ccy),
    'clients_overdue', finance_v3.money_text(v_overdue, v_ccy),
    'owed_to_animators', finance_v3.money_text(p.animators, v_ccy),
    'other_bills_outstanding', finance_v3.money_text(p.bills, v_ccy),
    'business_reserve', finance_v3.money_text(p.reserves + v_acct_res, v_ccy),
    'safe_to_spend', j ->> 'safe_to_spend', 'shortfall', j ->> 'shortfall', 'available_cash', j ->> 'available_cash',
    'warnings', v_warn,
    'recent_payments', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'invoice_id', x.invoice_id, 'invoice_no', x.invoice_no, 'amount', finance_v3.money_text(x.amount, x.currency),
        'currency', x.currency, 'received_at', x.received_at, 'verification_status', x.verification_status, 'method', x.method) order by x.received_at desc), '[]'::jsonb)
        from (select p2.*, i.invoice_no from finance_v3.payments p2 join finance_v3.receivables i on i.organization_id = p2.organization_id and i.id = p2.invoice_id
               where p2.organization_id = p_org and p2.currency = v_ccy order by p2.received_at desc limit 5) x),
    'recent_invoices', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'invoice_no', x.invoice_no, 'client_name', x.client_name, 'status', x.status, 'total', finance_v3.money_text(x.total, x.currency),
        'outstanding', finance_v3.money_text(x.outstanding, x.currency), 'currency', x.currency, 'due_date', x.due_date) order by x.created_at desc), '[]'::jsonb)
        from (select r.*, c.name as client_name from finance_v3.receivables r left join finance_v3.contacts_v3 c on c.organization_id = r.organization_id and c.id = r.client_id
               where r.organization_id = p_org and r.currency = v_ccy order by r.created_at desc limit 5) x),
    'recent_activity', (select coalesce(jsonb_agg(jsonb_build_object('at', a.at, 'action', a.action, 'object_type', a.object_type, 'object_id', a.object_id) order by a.at desc, a.id desc), '[]'::jsonb)
        from (select * from finance_v3.audit_log x where x.organization_id = p_org order by x.at desc, x.id desc limit 8) a));
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Invoice email composition (Phase 5 section D): preview, and controlled editing of the subject and an added message.
-- The invoice, its snapshot and its amounts are never edited here: only two text fields travel with the queued email.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.email_edit_options(p_options jsonb)
returns jsonb
language plpgsql immutable
set search_path = pg_catalog
as $$
declare v_subject text; v_message text; v_out jsonb := '{}'::jsonb;
begin
  if p_options is null then return v_out; end if;
  if jsonb_typeof(p_options) <> 'object' then raise exception 'Options must be an object.' using errcode = 'V3011'; end if;
  if p_options ? 'subject' and jsonb_typeof(p_options -> 'subject') <> 'null' then
    if jsonb_typeof(p_options -> 'subject') <> 'string' then raise exception 'The subject must be text.' using errcode = 'V3011'; end if;
    v_subject := btrim(p_options ->> 'subject');
    if v_subject = '' then null;
    elsif char_length(v_subject) > 150 then raise exception 'The subject can be at most 150 characters.' using errcode = 'V3011';
    elsif v_subject ~ '[[:cntrl:]]' then raise exception 'The subject must be a single line.' using errcode = 'V3011';
    else v_out := v_out || jsonb_build_object('custom_subject', v_subject); end if;
  end if;
  if p_options ? 'message' and jsonb_typeof(p_options -> 'message') <> 'null' then
    if jsonb_typeof(p_options -> 'message') <> 'string' then raise exception 'The message must be text.' using errcode = 'V3011'; end if;
    v_message := btrim(replace(p_options ->> 'message', E'\r', ''));
    if v_message = '' then null;
    elsif char_length(v_message) > 2000 then raise exception 'The message can be at most 2000 characters.' using errcode = 'V3011';
    elsif v_message ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' then raise exception 'The message contains characters that cannot be sent.' using errcode = 'V3011';
    else v_out := v_out || jsonb_build_object('custom_message', v_message); end if;
  end if;
  return v_out;
end;
$$;

-- Same as the Phase 3 function, plus the two optional text fields. Replays (same invoice revision and recipient) still return the
-- message already queued, so editing text can never produce a second email.
create or replace function public.fin3_queue_invoice_email(p_org uuid, p_invoice uuid, p_recipient text default null, p_options jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid  uuid := finance_v3.assert_permission(p_org, 'finance.send_email');
  s      finance_v3.org_settings;
  r      finance_v3.receivables;
  c      finance_v3.contacts_v3;
  m      finance_v3.email_messages;
  v_to   text;
  v_view text;
  v_pay  text;
  v_days integer := coalesce((p_options ->> 'link_expires_days')::integer, 30);
  v_edit jsonb := finance_v3.email_edit_options(p_options);
begin
  s := finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  select * into r from finance_v3.receivables x where x.organization_id = p_org and x.id = p_invoice for update;
  if not found then raise exception 'Invoice not found.' using errcode = 'V3010'; end if;
  if r.status not in ('issued', 'partially_paid') then raise exception 'Only an issued invoice with a balance can be emailed.' using errcode = 'V3017'; end if;
  select * into c from finance_v3.contacts_v3 x where x.organization_id = p_org and x.id = r.client_id;
  v_to := lower(btrim(coalesce(p_recipient, c.email, '')));
  if not finance_v3.valid_email(v_to) then raise exception 'There is no valid recipient email address.' using errcode = 'V3018'; end if;
  select * into m from finance_v3.email_messages x where x.organization_id = p_org and x.idempotency_key =
    'fin3:email:invoice:' || r.id::text || ':' || r.revision::text || ':' || substr(encode(sha256(convert_to(v_to, 'UTF8')), 'hex'), 1, 8);
  if found then return finance_v3.email_json(m); end if;
  v_view := finance_v3.mint_link(p_org, r.id, 'view', v_days, v_uid);
  if coalesce((p_options ->> 'include_payment_link')::boolean, true) and r.currency = any (s.collect_currencies) then
    v_pay := finance_v3.mint_link(p_org, r.id, 'pay', v_days, v_uid);
  end if;
  m := finance_v3.queue_email(p_org, 'invoice', 'invoice', r.id, null, null, null, r.client_id, v_to,
    'fin3:email:invoice:' || r.id::text || ':' || r.revision::text || ':' || substr(encode(sha256(convert_to(v_to, 'UTF8')), 'hex'), 1, 8),
    finance_v3.invoice_email_payload(r, v_view, v_pay) || v_edit, v_uid, null, 'user');
  return finance_v3.email_json(m);
end;
$$;

-- What the email will say, before anything is queued or issued. Never raises for a fixable problem: it reports it (valid=false, problems[]).
create or replace function public.fin3_preview_invoice_email(p_org uuid, p_invoice uuid, p_recipient text default null, p_options jsonb default '{}'::jsonb)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  s finance_v3.org_settings; r finance_v3.receivables; c finance_v3.contacts_v3; m finance_v3.email_messages;
  v_to text; v_edit jsonb; v_studio text; v_default text; v_problems jsonb := '[]'::jsonb; v_key text; v_pay boolean; v_days integer;
begin
  perform finance_v3.assert_permission(p_org, 'finance.send_email');
  s := finance_v3.assert_org_ready(p_org);
  v_edit := finance_v3.email_edit_options(p_options);
  select * into r from finance_v3.receivables x where x.organization_id = p_org and x.id = p_invoice;
  if not found then raise exception 'Invoice not found.' using errcode = 'V3010'; end if;
  select * into c from finance_v3.contacts_v3 x where x.organization_id = p_org and x.id = r.client_id;
  v_to := lower(btrim(coalesce(nullif(btrim(p_recipient), ''), c.email, '')));
  v_studio := coalesce(r.snapshot -> 'studio' ->> 'name', s.studio_name, 'Your studio');
  v_default := 'Invoice ' || coalesce(r.invoice_no, '(number assigned when issued)') || ' from ' || v_studio;
  v_days := coalesce((p_options ->> 'link_expires_days')::integer, 30);
  v_pay := coalesce((p_options ->> 'include_payment_link')::boolean, true) and r.currency = any (s.collect_currencies);
  if r.status in ('draft', 'void', 'paid', 'credited') then
    v_problems := v_problems || jsonb_build_array(case r.status when 'draft' then 'The invoice must be approved first.' when 'void' then 'This invoice was cancelled.' else 'This invoice has nothing left to pay.' end);
  end if;
  if not finance_v3.valid_email(v_to) then v_problems := v_problems || jsonb_build_array('There is no valid recipient email address.'); end if;
  if r.invoice_no is not null and finance_v3.valid_email(v_to) then
    v_key := 'fin3:email:invoice:' || r.id::text || ':' || r.revision::text || ':' || substr(encode(sha256(convert_to(v_to, 'UTF8')), 'hex'), 1, 8);
    select * into m from finance_v3.email_messages x where x.organization_id = p_org and x.idempotency_key = v_key;
  end if;
  return jsonb_build_object(
    'valid', jsonb_array_length(v_problems) = 0, 'problems', v_problems,
    'will_issue_invoice', r.status = 'approved',
    'recipient', nullif(v_to, ''), 'client_name', c.name,
    'default_subject', v_default, 'subject', coalesce(v_edit ->> 'custom_subject', v_default), 'message', v_edit ->> 'custom_message',
    'invoice', jsonb_build_object('id', r.id, 'invoice_no', r.invoice_no, 'status', r.status, 'currency', r.currency,
        'total', finance_v3.money_text(r.total, r.currency), 'outstanding', finance_v3.money_text(r.outstanding, r.currency),
        'issue_date', r.issue_date, 'due_date', r.due_date),
    'payment_link', jsonb_build_object('included', v_pay, 'expires_in_days', v_days,
        'reason', case when v_pay then null when not (r.currency = any (s.collect_currencies)) then 'Online payment is not switched on for ' || r.currency || '.' else 'You chose to leave the payment link out.' end),
    'attachments', jsonb_build_array(jsonb_build_object('kind', 'invoice_pdf', 'filename', coalesce(r.invoice_no, 'invoice') || '.pdf')),
    'already_queued', case when m.id is null then null else jsonb_build_object('id', m.id, 'status', m.status, 'created_at', m.created_at) end);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Privileges (same footer as every Finance V3 migration)
-- ---------------------------------------------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'fin3\_%' loop
    execute format('revoke all on function %s from public, anon, service_role', r.sig);
    execute format('grant execute on function %s to authenticated', r.sig);
  end loop;
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'fin3svc\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'finance_v3' loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', r.sig);
  end loop;
end $$;
grant execute on function finance_v3.has_permission(uuid, text) to authenticated;

commit;
