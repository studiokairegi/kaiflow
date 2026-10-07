-- =============================================================================
-- Finance v2: double-entry ledger foundation
-- =============================================================================
-- WHAT THIS DOES
--   Turns Finance from "revenue/expense calculations over invoices + expenses"
--   into a ledger-based system:
--     financial events -> balanced journal entries -> reports -> dashboard
--
-- KEY DESIGN RULES
--   1. Journal entries are immutable. Mistakes are fixed by reversal, never by
--      UPDATE/DELETE. Every significant action is written to finance_audit_log.
--   2. Every entry keeps its native amounts, its currency, the FX rate used,
--      the date/source of that rate and the resulting base-currency amounts.
--      Today's FX rate is NEVER applied to a historical entry.
--   3. If no transaction-date rate exists the entry is posted with
--      fx_status = 'missing' and NO base amounts. Reports exclude it from
--      consolidated totals and flag it until the user resolves the rate.
--      A foreign amount is never treated as 1:1 with the base currency.
--   4. The ledger tables can only be written by the SECURITY DEFINER functions
--      below (clients get SELECT only, enforced by RLS + revoked privileges).
--   5. Existing tables (invoices, expenses, team_members, shots) are evolved
--      additively. Legacy rows are backfilled and flagged is_legacy.
--
-- Safe to re-run (idempotent). Existing RLS is untouched.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.finance_ccy_code(p text)
returns text language sql immutable as $$
  select case coalesce(p, '')
    when '$' then 'USD'
    when '¥' then 'JPY'
    when '€' then 'EUR'
    when '£' then 'GBP'
    when 'KSh' then 'KES'
    else case when p ~ '^[A-Za-z]{3}$' then upper(p) else 'USD' end
  end
$$;

create or replace function public.finance_parse_date(p text, p_fallback date)
returns date language plpgsql stable as $$
begin
  if p is null or btrim(p) = '' then return p_fallback; end if;
  return btrim(p)::date;
exception when others then
  return p_fallback;
end
$$;

-- ---------------------------------------------------------------------------
-- Settings (base currency, privacy preference, default bank account)
-- ---------------------------------------------------------------------------
create table if not exists finance_settings (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  base_currency text not null default 'USD' check (base_currency ~ '^[A-Z]{3}$'),
  fiscal_year_start_month int not null default 1 check (fiscal_year_start_month between 1 and 12),
  privacy_mode boolean not null default false,
  default_bank_account_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table finance_settings enable row level security;
drop policy if exists "Users manage their own finance settings" on finance_settings;
create policy "Users manage their own finance settings" on finance_settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Chart of accounts
-- ---------------------------------------------------------------------------
create table if not exists chart_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  code text not null,
  name text not null,
  type text not null check (type in ('asset','liability','equity','revenue','cogs','expense')),
  subtype text not null default '',
  system_key text,
  is_system boolean not null default false,
  is_active boolean not null default true,
  tax_deductible boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, code)
);
create unique index if not exists chart_accounts_system_key_idx
  on chart_accounts(user_id, system_key) where system_key is not null;
alter table chart_accounts enable row level security;
drop policy if exists "Users read their own accounts" on chart_accounts;
drop policy if exists "Users manage their own accounts" on chart_accounts;
create policy "Users read their own accounts" on chart_accounts
  for select using (auth.uid() = user_id);
-- Users may add/rename their own non-system accounts; system accounts are fixed.
create policy "Users manage their own accounts" on chart_accounts
  for all using (auth.uid() = user_id and not is_system)
  with check (auth.uid() = user_id and not is_system);

create or replace function public.finance_seed_accounts(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into chart_accounts (user_id, code, name, type, subtype, system_key, is_system, tax_deductible) values
    (p_user, '1090', 'Legacy Cash (unallocated)',   'asset',     'cash',         'legacy_cash',    true,  false),
    (p_user, '1100', 'Accounts Receivable',         'asset',     'receivable',   'ar',             true,  false),
    (p_user, '1200', 'Equipment',                   'asset',     'fixed_asset',  null,             false, false),
    (p_user, '1300', 'Other Assets',                'asset',     'other',        null,             false, false),
    (p_user, '2100', 'Accounts Payable',            'liability', 'payable',      'ap',             true,  false),
    (p_user, '2200', 'Taxes Payable',               'liability', 'tax_payable',  'tax_payable',    true,  false),
    (p_user, '2300', 'Loans Payable',               'liability', 'loan',         null,             false, false),
    (p_user, '2400', 'Other Liabilities',           'liability', 'other',        null,             false, false),
    (p_user, '3050', 'Opening Balance Equity',      'equity',    'equity',       'opening_equity', true,  false),
    (p_user, '3100', 'Owner Capital',               'equity',    'equity',       null,             false, false),
    (p_user, '3200', 'Owner Drawings',              'equity',    'equity',       null,             false, false),
    (p_user, '3900', 'Retained Earnings',           'equity',    'retained',     'retained_earnings', true, false),
    (p_user, '4100', 'Animation Services',          'revenue',   'sales',        'sales',          true,  false),
    (p_user, '4200', 'Other Income',                'revenue',   'other_income', null,             false, false),
    (p_user, '4950', 'Realized FX Gain / Loss',     'revenue',   'fx',           'fx_gain_loss',   true,  false),
    (p_user, '5100', 'Freelancer / Contractor Costs','cogs',     'direct',       'freelancer_costs', true, true),
    (p_user, '5200', 'Production Costs',            'cogs',      'direct',       null,             false, true),
    (p_user, '5300', 'Other Direct Costs',          'cogs',      'direct',       null,             false, true),
    (p_user, '6100', 'Software',                    'expense',   'operating',    null,             false, true),
    (p_user, '6200', 'Internet',                    'expense',   'operating',    null,             false, true),
    (p_user, '6300', 'Marketing',                   'expense',   'operating',    null,             false, true),
    (p_user, '6400', 'Rent',                        'expense',   'operating',    null,             false, true),
    (p_user, '6500', 'Utilities',                   'expense',   'operating',    null,             false, true),
    (p_user, '6600', 'Office Costs',                'expense',   'operating',    null,             false, true),
    (p_user, '6700', 'Professional Fees',           'expense',   'operating',    null,             false, true),
    (p_user, '6800', 'Hardware',                    'expense',   'operating',    null,             false, true),
    (p_user, '6900', 'Other Operating Expenses',    'expense',   'operating',    'misc_expense',   true,  true)
  on conflict (user_id, code) do nothing;
end
$$;

create or replace function public.finance_sys_account(p_user uuid, p_key text)
returns uuid language sql stable security definer set search_path = public as $$
  select id from chart_accounts where user_id = p_user and system_key = p_key
$$;

-- Maps the app's legacy expense category labels to ledger accounts.
create or replace function public.finance_expense_account(p_user uuid, p_category text)
returns uuid language sql stable security definer set search_path = public as $$
  select id from chart_accounts where user_id = p_user and code = case coalesce(p_category, '')
    when 'Animator Payments' then '5100'
    when 'Background Artist Payments' then '5100'
    when 'Software' then '6100'
    when 'Hardware' then '6800'
    when 'Internet' then '6200'
    when 'Rent' then '6400'
    when 'Utilities' then '6500'
    when 'Marketing' then '6300'
    when 'Office Costs' then '6600'
    else '6900' end
$$;

-- Creates settings + default accounts for a user (idempotent).
create or replace function public.finance_init_user(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into finance_settings (user_id, base_currency)
  values (p_user, coalesce((select finance_ccy_code(us.currency_symbol) from user_settings us where us.user_id = p_user), 'USD'))
  on conflict (user_id) do nothing;
  perform finance_seed_accounts(p_user);
end
$$;

-- ---------------------------------------------------------------------------
-- FX rate snapshots (units of currency per 1 USD, as the app already fetches)
-- ---------------------------------------------------------------------------
create table if not exists fx_rates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  rate_date date not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  per_usd numeric not null check (per_usd > 0),
  source text not null default '',
  created_at timestamptz not null default now(),
  unique (user_id, currency, rate_date)
);
alter table fx_rates enable row level security;
drop policy if exists "Users manage their own fx rates" on fx_rates;
create policy "Users manage their own fx rates" on fx_rates
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Returns (rate, rate_date, source) converting 1 unit of p_currency into the
-- base currency as of p_date, using a stored snapshot from at most 7 days
-- before the transaction. Returns no row when none exists - callers must treat
-- that as "FX missing", never as 1:1.
create or replace function public.finance_fx_to_base(p_user uuid, p_currency text, p_date date)
returns table(rate numeric, rate_date date, source text)
language plpgsql stable security definer set search_path = public as $$
declare
  v_base text;
  v_c_rate numeric; v_c_date date; v_c_src text;
  v_b_rate numeric; v_b_date date;
begin
  select base_currency into v_base from finance_settings where user_id = p_user;
  if v_base is null then return; end if;
  if p_currency = v_base then
    return query select 1::numeric, p_date, 'base currency'::text;
    return;
  end if;
  if p_currency = 'USD' then
    v_c_rate := 1; v_c_date := p_date; v_c_src := 'USD';
  else
    select f.per_usd, f.rate_date, f.source into v_c_rate, v_c_date, v_c_src
    from fx_rates f
    where f.user_id = p_user and f.currency = p_currency
      and f.rate_date <= p_date and f.rate_date >= p_date - 7
    order by f.rate_date desc limit 1;
  end if;
  if v_base = 'USD' then
    v_b_rate := 1; v_b_date := p_date;
  else
    select f.per_usd, f.rate_date into v_b_rate, v_b_date
    from fx_rates f
    where f.user_id = p_user and f.currency = v_base
      and f.rate_date <= p_date and f.rate_date >= p_date - 7
    order by f.rate_date desc limit 1;
  end if;
  if v_c_rate is null or v_b_rate is null or v_c_rate = 0 then return; end if;
  return query select round(v_b_rate / v_c_rate, 8),
                      least(coalesce(v_c_date, p_date), coalesce(v_b_date, p_date)),
                      ('stored rate ' || coalesce(v_c_src, ''))::text;
end
$$;

-- ---------------------------------------------------------------------------
-- Journal
-- ---------------------------------------------------------------------------
create table if not exists journal_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  entry_no bigint not null,
  entry_date date not null,
  memo text not null default '',
  reference text not null default '',
  source_type text not null default 'manual',
  source_id uuid,
  project_id uuid references projects(id) on delete set null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  base_currency text not null check (base_currency ~ '^[A-Z]{3}$'),
  fx_rate numeric,
  fx_rate_date date,
  fx_source text not null default '',
  fx_status text not null default 'ok' check (fx_status in ('ok','missing')),
  reverses_entry_id uuid references journal_entries(id),
  voided_by_entry_id uuid references journal_entries(id),
  is_legacy boolean not null default false,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (user_id, entry_no)
);
create index if not exists journal_entries_user_date_idx on journal_entries(user_id, entry_date);
create index if not exists journal_entries_source_idx on journal_entries(user_id, source_id);

create table if not exists journal_lines (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references journal_entries(id),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  line_no int not null default 1,
  account_id uuid not null references chart_accounts(id),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  debit numeric not null default 0 check (debit >= 0),
  credit numeric not null default 0 check (credit >= 0),
  base_debit numeric check (base_debit is null or base_debit >= 0),
  base_credit numeric check (base_credit is null or base_credit >= 0),
  project_id uuid references projects(id) on delete set null,
  bank_account_id uuid,
  counterparty text not null default '',
  memo text not null default '',
  reconciled_at timestamptz,
  reconciliation_id uuid,
  constraint journal_lines_one_side check (not (debit > 0 and credit > 0)),
  constraint journal_lines_base_side check (not (coalesce(base_debit,0) > 0 and coalesce(base_credit,0) > 0))
);
create index if not exists journal_lines_entry_idx on journal_lines(entry_id);
create index if not exists journal_lines_account_idx on journal_lines(user_id, account_id);
create index if not exists journal_lines_bank_idx on journal_lines(user_id, bank_account_id);

alter table journal_entries enable row level security;
alter table journal_lines enable row level security;
drop policy if exists "Users read their own journal entries" on journal_entries;
drop policy if exists "Users read their own journal lines" on journal_lines;
create policy "Users read their own journal entries" on journal_entries for select using (auth.uid() = user_id);
create policy "Users read their own journal lines" on journal_lines for select using (auth.uid() = user_id);
-- No insert/update/delete policies: writes happen only inside SECURITY DEFINER functions.
revoke insert, update, delete, truncate on journal_entries from anon, authenticated;
revoke insert, update, delete, truncate on journal_lines from anon, authenticated;

-- Immutability. Only reconciliation marks, void links and (when explicitly
-- allowed by the FX-resolution function) FX fields may ever change.
-- A ledger may only disappear when its owner account is deleted, or during the
-- explicit legacy rebuild (finance_set_base_currency) which sets finance.allow_purge.
create or replace function public.finance_may_purge(p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(current_setting('finance.allow_purge', true), '') = '1'
      or not exists (select 1 from auth.users where id = p_user)
$$;

create or replace function public.finance_guard_entries()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if finance_may_purge(old.user_id) then return old; end if;
    raise exception 'Journal entries cannot be deleted. Void the entry instead.' using errcode = 'P0001';
  end if;
  if coalesce(current_setting('finance.allow_edit', true), '') = '1' then return new; end if;
  if (new.user_id, new.entry_no, new.entry_date, new.memo, new.reference, new.source_type, new.source_id,
      new.currency, new.base_currency, new.fx_rate, new.fx_rate_date, new.fx_source, new.fx_status,
      new.reverses_entry_id, new.is_legacy)
     is distinct from
     (old.user_id, old.entry_no, old.entry_date, old.memo, old.reference, old.source_type, old.source_id,
      old.currency, old.base_currency, old.fx_rate, old.fx_rate_date, old.fx_source, old.fx_status,
      old.reverses_entry_id, old.is_legacy) then
    raise exception 'Posted journal entries are immutable. Void and re-post instead.' using errcode = 'P0001';
  end if;
  return new;
end
$$;
drop trigger if exists trg_finance_guard_entries on journal_entries;
create trigger trg_finance_guard_entries before update or delete on journal_entries
  for each row execute function public.finance_guard_entries();

-- project_id / bank_account_id are intentionally not compared: they are nulled by
-- ON DELETE SET NULL when a project is deleted and that must keep working.
create or replace function public.finance_guard_lines()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if finance_may_purge(old.user_id) then return old; end if;
    raise exception 'Journal lines cannot be deleted.' using errcode = 'P0001';
  end if;
  if coalesce(current_setting('finance.allow_edit', true), '') = '1' then return new; end if;
  if (new.entry_id, new.account_id, new.currency, new.debit, new.credit, new.base_debit, new.base_credit,
      new.counterparty, new.memo)
     is distinct from
     (old.entry_id, old.account_id, old.currency, old.debit, old.credit, old.base_debit, old.base_credit,
      old.counterparty, old.memo) then
    raise exception 'Posted journal lines are immutable.' using errcode = 'P0001';
  end if;
  return new;
end
$$;
drop trigger if exists trg_finance_guard_lines on journal_lines;
create trigger trg_finance_guard_lines before update or delete on journal_lines
  for each row execute function public.finance_guard_lines();

-- Debits must equal credits. Checked in native currency when an entry is in a
-- single currency, and always in base currency when base amounts exist.
create or replace function public.finance_assert_entry_balanced(p_entry uuid)
returns void language plpgsql stable security definer set search_path = public as $$
declare
  v_ccy_count int; v_native numeric; v_bd numeric; v_bc numeric; v_nulls int;
begin
  select count(distinct currency) into v_ccy_count from journal_lines
   where entry_id = p_entry and (debit <> 0 or credit <> 0);
  if v_ccy_count <= 1 then
    select coalesce(sum(debit) - sum(credit), 0) into v_native from journal_lines where entry_id = p_entry;
    if abs(v_native) > 0.005 then
      raise exception 'Unbalanced journal entry: debits and credits differ by %', round(v_native, 2) using errcode = 'P0001';
    end if;
  end if;
  select coalesce(sum(base_debit), 0), coalesce(sum(base_credit), 0),
         count(*) filter (where base_debit is null and base_credit is null)
    into v_bd, v_bc, v_nulls
  from journal_lines where entry_id = p_entry;
  if v_nulls = 0 and abs(v_bd - v_bc) > 0.005 then
    raise exception 'Unbalanced journal entry in base currency: difference %', round(v_bd - v_bc, 2) using errcode = 'P0001';
  end if;
end
$$;

create or replace function public.finance_check_balance_trigger()
returns trigger language plpgsql as $$
begin
  perform public.finance_assert_entry_balanced(coalesce(new.entry_id, old.entry_id));
  return null;
end
$$;
drop trigger if exists trg_finance_balance on journal_lines;
create constraint trigger trg_finance_balance after insert or update or delete on journal_lines
  deferrable initially deferred for each row execute function public.finance_check_balance_trigger();

-- ---------------------------------------------------------------------------
-- Audit log (append-only)
-- ---------------------------------------------------------------------------
create table if not exists finance_audit_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  actor uuid,
  at timestamptz not null default now(),
  action text not null,
  object_type text not null,
  object_id uuid,
  old_values jsonb,
  new_values jsonb
);
create index if not exists finance_audit_user_at_idx on finance_audit_log(user_id, at desc);
alter table finance_audit_log enable row level security;
drop policy if exists "Users read their own audit log" on finance_audit_log;
create policy "Users read their own audit log" on finance_audit_log for select using (auth.uid() = user_id);
revoke insert, update, delete, truncate on finance_audit_log from anon, authenticated;

create or replace function public.finance_guard_audit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from auth.users where id = old.user_id) then return old; end if;
  raise exception 'The audit log is append-only.' using errcode = 'P0001';
end
$$;
drop trigger if exists trg_finance_guard_audit on finance_audit_log;
create trigger trg_finance_guard_audit before update or delete on finance_audit_log
  for each row execute function public.finance_guard_audit();

create or replace function public.finance_audit(
  p_user uuid, p_action text, p_type text, p_id uuid, p_old jsonb, p_new jsonb
) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into finance_audit_log (user_id, actor, action, object_type, object_id, old_values, new_values)
  values (p_user, auth.uid(), p_action, p_type, p_id, p_old, p_new);
end
$$;

-- Absorbs sub-5-cent base-currency rounding drift; anything larger is a bug.
create or replace function public.finance_fix_base_rounding(p_entry uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_bd numeric; v_bc numeric; v_diff numeric; v_fix uuid;
begin
  select coalesce(sum(base_debit), 0), coalesce(sum(base_credit), 0) into v_bd, v_bc
  from journal_lines where entry_id = p_entry;
  v_diff := round(v_bd - v_bc, 2);
  if v_diff = 0 then return; end if;
  if abs(v_diff) > 0.05 then
    raise exception 'Base-currency amounts do not balance (off by %).', v_diff using errcode = 'P0001';
  end if;
  perform set_config('finance.allow_edit', '1', true);
  if v_diff > 0 then
    select id into v_fix from journal_lines where entry_id = p_entry and base_credit > 0 order by base_credit desc limit 1;
    update journal_lines set base_credit = base_credit + v_diff where id = v_fix;
  else
    select id into v_fix from journal_lines where entry_id = p_entry and base_debit > 0 order by base_debit desc limit 1;
    update journal_lines set base_debit = base_debit - v_diff where id = v_fix;
  end if;
  perform set_config('finance.allow_edit', '0', true);
end
$$;

-- ---------------------------------------------------------------------------
-- Core posting function (internal - not callable by clients)
-- p_lines: jsonb array of
--   { account_id, debit?, credit?, currency?, base_debit?, base_credit?,
--     project_id?, bank_account_id?, counterparty?, memo? }
-- Explicit base_* values are used for lines that carry an earlier base value
-- (settlements) or that live in another currency. Other lines are converted
-- at the entry's transaction-date rate.
-- ---------------------------------------------------------------------------
create or replace function public.finance_post_entry(
  p_user uuid, p_date date, p_memo text, p_reference text,
  p_source_type text, p_source_id uuid,
  p_currency text, p_fx_rate numeric, p_fx_rate_date date, p_fx_source text,
  p_project_id uuid, p_lines jsonb,
  p_is_legacy boolean default false,
  p_force_missing boolean default false
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_base text; v_entry uuid; v_no bigint;
  v_rate numeric; v_rate_date date; v_src text; v_status text := 'ok';
  v_line jsonb; v_n int := 0;
  v_deb numeric; v_cre numeric; v_lccy text; v_bd numeric; v_bc numeric;
begin
  perform pg_advisory_xact_lock(hashtext('finance:' || p_user::text));
  select base_currency into v_base from finance_settings where user_id = p_user;
  if v_base is null then
    raise exception 'Finance has not been initialised for this account.' using errcode = 'P0001';
  end if;
  if p_lines is null or jsonb_array_length(p_lines) < 2 then
    raise exception 'A journal entry needs at least two lines.' using errcode = 'P0001';
  end if;

  if p_force_missing and p_currency <> v_base then
    v_status := 'missing'; v_src := '';
  elsif p_currency = v_base then
    v_rate := 1; v_rate_date := p_date; v_src := 'base currency';
  elsif p_fx_rate is not null and p_fx_rate > 0 then
    v_rate := p_fx_rate; v_rate_date := coalesce(p_fx_rate_date, p_date); v_src := coalesce(nullif(p_fx_source, ''), 'manual');
  else
    select f.rate, f.rate_date, f.source into v_rate, v_rate_date, v_src
    from finance_fx_to_base(p_user, p_currency, p_date) f limit 1;
    if v_rate is null then v_status := 'missing'; v_src := ''; end if;
  end if;

  select coalesce(max(entry_no), 0) + 1 into v_no from journal_entries where user_id = p_user;
  insert into journal_entries (user_id, entry_no, entry_date, memo, reference, source_type, source_id, project_id,
                               currency, base_currency, fx_rate, fx_rate_date, fx_source, fx_status, is_legacy)
  values (p_user, v_no, p_date, coalesce(p_memo, ''), coalesce(p_reference, ''), p_source_type, p_source_id, p_project_id,
          p_currency, v_base, v_rate, v_rate_date, coalesce(v_src, ''), v_status, p_is_legacy)
  returning id into v_entry;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_n := v_n + 1;
    v_deb := round(coalesce((v_line->>'debit')::numeric, 0), 2);
    v_cre := round(coalesce((v_line->>'credit')::numeric, 0), 2);
    v_lccy := coalesce(nullif(v_line->>'currency', ''), p_currency);
    if v_status = 'missing' then
      v_bd := null; v_bc := null;
    elsif v_line ? 'base_debit' or v_line ? 'base_credit' then
      v_bd := round(coalesce((v_line->>'base_debit')::numeric, 0), 2);
      v_bc := round(coalesce((v_line->>'base_credit')::numeric, 0), 2);
    elsif v_lccy = p_currency then
      v_bd := round(v_deb * v_rate, 2); v_bc := round(v_cre * v_rate, 2);
    elsif v_lccy = v_base then
      v_bd := v_deb; v_bc := v_cre;
    else
      raise exception 'Line % is in % and needs an explicit base amount.', v_n, v_lccy using errcode = 'P0001';
    end if;
    if not exists (select 1 from chart_accounts where id = (v_line->>'account_id')::uuid and user_id = p_user) then
      raise exception 'Unknown account on line %.', v_n using errcode = 'P0001';
    end if;
    insert into journal_lines (entry_id, user_id, line_no, account_id, currency, debit, credit, base_debit, base_credit,
                               project_id, bank_account_id, counterparty, memo)
    values (v_entry, p_user, v_n, (v_line->>'account_id')::uuid, v_lccy, v_deb, v_cre, v_bd, v_bc,
            coalesce(nullif(v_line->>'project_id', '')::uuid, p_project_id),
            nullif(v_line->>'bank_account_id', '')::uuid,
            coalesce(v_line->>'counterparty', ''), coalesce(v_line->>'memo', ''));
  end loop;

  if v_status = 'ok' then perform finance_fix_base_rounding(v_entry); end if;

  perform finance_assert_entry_balanced(v_entry);
  perform finance_audit(p_user, 'post', 'journal_entry', v_entry, null,
    jsonb_build_object('entry_no', v_no, 'source_type', p_source_type, 'currency', p_currency, 'fx_status', v_status));
  return v_entry;
end
$$;

-- Reverses an entry (never edits it). Returns the reversal entry id.
create or replace function public.finance_void_entry(p_user uuid, p_entry uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  e journal_entries%rowtype; v_rev uuid; v_no bigint;
begin
  perform pg_advisory_xact_lock(hashtext('finance:' || p_user::text));
  select * into e from journal_entries where id = p_entry and user_id = p_user for update;
  if not found then raise exception 'Journal entry not found.' using errcode = 'P0001'; end if;
  if e.voided_by_entry_id is not null then return e.voided_by_entry_id; end if;
  if e.reverses_entry_id is not null then
    raise exception 'A reversal entry cannot be voided.' using errcode = 'P0001';
  end if;
  select coalesce(max(entry_no), 0) + 1 into v_no from journal_entries where user_id = p_user;
  insert into journal_entries (user_id, entry_no, entry_date, memo, reference, source_type, source_id, project_id,
                               currency, base_currency, fx_rate, fx_rate_date, fx_source, fx_status,
                               reverses_entry_id, is_legacy)
  values (p_user, v_no, current_date, 'Reversal of #' || e.entry_no || coalesce(': ' || nullif(p_reason, ''), ''),
          e.reference, e.source_type, e.source_id, e.project_id, e.currency, e.base_currency,
          e.fx_rate, e.fx_rate_date, e.fx_source, e.fx_status, e.id, e.is_legacy)
  returning id into v_rev;
  insert into journal_lines (entry_id, user_id, line_no, account_id, currency, debit, credit, base_debit, base_credit,
                             project_id, bank_account_id, counterparty, memo)
  select v_rev, user_id, line_no, account_id, currency, credit, debit, base_credit, base_debit,
         project_id, bank_account_id, counterparty, memo
  from journal_lines where entry_id = e.id;
  perform set_config('finance.allow_edit', '1', true);
  update journal_entries set voided_by_entry_id = v_rev where id = e.id;
  perform set_config('finance.allow_edit', '0', true);
  perform finance_audit(p_user, 'void', 'journal_entry', e.id,
    jsonb_build_object('entry_no', e.entry_no), jsonb_build_object('reversal_entry_id', v_rev, 'reason', p_reason));
  return v_rev;
end
$$;

-- Open position of a document (invoice / bill) in a control account:
-- signed native (debit - credit) and base, plus whether any base value is unresolved.
create or replace function public.finance_doc_position(
  p_user uuid, p_account uuid, p_doc uuid, p_before_no bigint default null
) returns table(native numeric, base numeric, any_missing boolean)
language sql stable security definer set search_path = public as $$
  select coalesce(sum(l.debit - l.credit), 0),
         coalesce(sum(coalesce(l.base_debit, 0) - coalesce(l.base_credit, 0)), 0),
         coalesce(bool_or(l.base_debit is null and l.base_credit is null and (l.debit <> 0 or l.credit <> 0)), false)
  from journal_lines l join journal_entries e on e.id = l.entry_id
  where e.user_id = p_user and e.source_id = p_doc and l.account_id = p_account
    and (p_before_no is null or e.entry_no < p_before_no)
$$;

-- =============================================================================
-- PART B: contacts, banking, payments, bills, expenses
-- =============================================================================

create table if not exists finance_contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null default 'vendor' check (kind in ('customer','vendor','both')),
  name text not null,
  email text not null default '',
  team_member_id uuid references team_members(id) on delete set null,
  notes text not null default '',
  archived boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists finance_contacts_member_idx on finance_contacts(user_id, team_member_id) where team_member_id is not null;
alter table finance_contacts enable row level security;
drop policy if exists "Users manage their own finance contacts" on finance_contacts;
create policy "Users manage their own finance contacts" on finance_contacts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Each bank/cash account is backed by its own ledger account (codes 1001-1089).
create table if not exists bank_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  kind text not null default 'bank' check (kind in ('bank','cash','wallet')),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  account_id uuid not null references chart_accounts(id),
  opened_on date,
  reconciled_through date,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);
alter table bank_accounts enable row level security;
drop policy if exists "Users read their own bank accounts" on bank_accounts;
create policy "Users read their own bank accounts" on bank_accounts for select using (auth.uid() = user_id);
revoke insert, update, delete, truncate on bank_accounts from anon, authenticated;

create table if not exists bank_reconciliations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  bank_account_id uuid not null references bank_accounts(id),
  statement_date date not null,
  statement_balance numeric not null,
  book_balance numeric not null,
  difference numeric not null,
  line_count int not null default 0,
  created_at timestamptz not null default now()
);
alter table bank_reconciliations enable row level security;
drop policy if exists "Users read their own reconciliations" on bank_reconciliations;
create policy "Users read their own reconciliations" on bank_reconciliations for select using (auth.uid() = user_id);
revoke insert, update, delete, truncate on bank_reconciliations from anon, authenticated;

-- Payments received against invoices (replaces amount_paid as the source of truth).
create table if not exists invoice_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  invoice_id uuid references invoices(id) on delete set null,
  invoice_number text not null default '',
  amount numeric not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  paid_date date not null,
  method text not null default '',
  bank_account_id uuid references bank_accounts(id),
  reference text not null default '',
  journal_entry_id uuid references journal_entries(id),
  status text not null default 'posted' check (status in ('posted','void')),
  void_reason text not null default '',
  is_legacy boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists invoice_payments_invoice_idx on invoice_payments(invoice_id);
alter table invoice_payments enable row level security;
drop policy if exists "Users read their own invoice payments" on invoice_payments;
create policy "Users read their own invoice payments" on invoice_payments for select using (auth.uid() = user_id);
revoke insert, update, delete, truncate on invoice_payments from anon, authenticated;

-- Bills (money the studio owes), including freelancer bills.
create table if not exists bills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  contact_id uuid references finance_contacts(id) on delete set null,
  team_member_id uuid references team_members(id) on delete set null,
  vendor_name text not null default '',
  project_id uuid references projects(id) on delete set null,
  bill_number text not null default '',
  description text not null default '',
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  amount numeric not null check (amount > 0),
  amount_paid numeric not null default 0,
  issue_date date not null default current_date,
  due_date date,
  account_id uuid references chart_accounts(id),
  status text not null default 'draft' check (status in ('draft','approved','partially_paid','paid','void')),
  journal_entry_id uuid references journal_entries(id),
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists bills_user_status_idx on bills(user_id, status);
alter table bills enable row level security;
drop policy if exists "Users read their own bills" on bills;
create policy "Users read their own bills" on bills for select using (auth.uid() = user_id);
revoke insert, update, delete, truncate on bills from anon, authenticated;

-- A shot can be on at most one bill: this is the replacement for the old
-- expenses.shot_id uniqueness that stopped freelancers being paid twice.
create table if not exists bill_shots (
  bill_id uuid not null references bills(id) on delete cascade,
  shot_id uuid not null references shots(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  amount numeric not null default 0,
  primary key (bill_id, shot_id)
);
create unique index if not exists bill_shots_shot_unique_idx on bill_shots(shot_id);
alter table bill_shots enable row level security;
drop policy if exists "Users read their own bill shots" on bill_shots;
create policy "Users read their own bill shots" on bill_shots for select using (auth.uid() = user_id);
revoke insert, update, delete, truncate on bill_shots from anon, authenticated;

create table if not exists bill_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  bill_id uuid references bills(id) on delete set null,
  bill_number text not null default '',
  vendor_name text not null default '',
  amount numeric not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  paid_date date not null,
  method text not null default '',
  bank_account_id uuid references bank_accounts(id),
  reference text not null default '',
  journal_entry_id uuid references journal_entries(id),
  status text not null default 'posted' check (status in ('posted','void')),
  void_reason text not null default '',
  is_legacy boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists bill_payments_bill_idx on bill_payments(bill_id);
alter table bill_payments enable row level security;
drop policy if exists "Users read their own bill payments" on bill_payments;
create policy "Users read their own bill payments" on bill_payments for select using (auth.uid() = user_id);
revoke insert, update, delete, truncate on bill_payments from anon, authenticated;

-- Existing expenses table evolves additively; the app keeps using it as the
-- source document for "paid immediately" expenses. The ledger is the truth.
alter table expenses add column if not exists vendor text not null default '';
alter table expenses add column if not exists account_id uuid references chart_accounts(id) on delete set null;
alter table expenses add column if not exists bank_account_id uuid references bank_accounts(id) on delete set null;
alter table expenses add column if not exists reference text not null default '';
alter table expenses add column if not exists notes text not null default '';
alter table expenses add column if not exists journal_entry_id uuid references journal_entries(id);
alter table expenses add column if not exists bill_id uuid references bills(id) on delete set null;
alter table expenses add column if not exists is_legacy boolean not null default false;

-- ---------------------------------------------------------------------------
-- Settlement: one routine for "money received against an invoice" and
-- "money paid against a bill". Carries the document's ORIGINAL base value
-- out of A/R or A/P and books the difference as realized FX gain/loss, so
-- a liability or receivable can never be revalued at today's rate.
-- ---------------------------------------------------------------------------
create or replace function public.finance_settle(
  p_user uuid, p_kind text, p_doc uuid, p_ccy text, p_project uuid, p_counterparty text, p_ref text,
  p_amount numeric, p_date date, p_cash_account uuid, p_bank_id uuid, p_legacy boolean
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_base text; v_ctrl uuid; v_fx uuid; v_pos record;
  v_open_native numeric; v_open_base numeric; v_rate numeric; v_rdate date; v_rsrc text;
  v_ok boolean; v_bank_base numeric; v_release numeric; v_diff numeric; v_lines jsonb;
  v_label text;
begin
  select base_currency into v_base from finance_settings where user_id = p_user;
  v_ctrl := finance_sys_account(p_user, case when p_kind = 'invoice' then 'ar' else 'ap' end);
  v_fx := finance_sys_account(p_user, 'fx_gain_loss');
  select * into v_pos from finance_doc_position(p_user, v_ctrl, p_doc);
  v_open_native := case when p_kind = 'invoice' then v_pos.native else -v_pos.native end;
  v_open_base := case when p_kind = 'invoice' then v_pos.base else -v_pos.base end;
  if p_amount > v_open_native + 0.005 then
    raise exception 'Payment of % exceeds the outstanding balance of %.', round(p_amount, 2), round(v_open_native, 2) using errcode = 'P0001';
  end if;

  if p_ccy = v_base then
    v_ok := true; v_rate := 1; v_rdate := p_date; v_rsrc := 'base currency';
    v_bank_base := p_amount; v_release := p_amount;
  else
    select f.rate, f.rate_date, f.source into v_rate, v_rdate, v_rsrc from finance_fx_to_base(p_user, p_ccy, p_date) f limit 1;
    v_ok := v_rate is not null and not v_pos.any_missing;
    if v_ok then
      v_bank_base := round(p_amount * v_rate, 2);
      v_release := case when abs(p_amount - v_open_native) <= 0.005 then v_open_base
                        else round(v_open_base * p_amount / v_open_native, 2) end;
    end if;
  end if;

  v_label := case when p_kind = 'invoice' then 'Payment received' else 'Payment made' end;
  if v_ok then
    v_diff := v_bank_base - v_release;
    if p_kind = 'invoice' then
      v_lines := jsonb_build_array(
        jsonb_build_object('account_id', p_cash_account, 'debit', p_amount, 'base_debit', v_bank_base, 'bank_account_id', p_bank_id, 'counterparty', p_counterparty),
        jsonb_build_object('account_id', v_ctrl, 'credit', p_amount, 'base_credit', v_release, 'counterparty', p_counterparty));
      if v_diff > 0 then v_lines := v_lines || jsonb_build_object('account_id', v_fx, 'base_credit', v_diff, 'memo', 'Realized FX gain');
      elsif v_diff < 0 then v_lines := v_lines || jsonb_build_object('account_id', v_fx, 'base_debit', -v_diff, 'memo', 'Realized FX loss'); end if;
    else
      v_lines := jsonb_build_array(
        jsonb_build_object('account_id', v_ctrl, 'debit', p_amount, 'base_debit', v_release, 'counterparty', p_counterparty),
        jsonb_build_object('account_id', p_cash_account, 'credit', p_amount, 'base_credit', v_bank_base, 'bank_account_id', p_bank_id, 'counterparty', p_counterparty));
      if v_diff > 0 then v_lines := v_lines || jsonb_build_object('account_id', v_fx, 'base_debit', v_diff, 'memo', 'Realized FX loss');
      elsif v_diff < 0 then v_lines := v_lines || jsonb_build_object('account_id', v_fx, 'base_credit', -v_diff, 'memo', 'Realized FX gain'); end if;
    end if;
  else
    -- No usable rate (or the document itself is unresolved): post natively, flag as FX missing.
    if p_kind = 'invoice' then
      v_lines := jsonb_build_array(
        jsonb_build_object('account_id', p_cash_account, 'debit', p_amount, 'bank_account_id', p_bank_id, 'counterparty', p_counterparty),
        jsonb_build_object('account_id', v_ctrl, 'credit', p_amount, 'counterparty', p_counterparty));
    else
      v_lines := jsonb_build_array(
        jsonb_build_object('account_id', v_ctrl, 'debit', p_amount, 'counterparty', p_counterparty),
        jsonb_build_object('account_id', p_cash_account, 'credit', p_amount, 'bank_account_id', p_bank_id, 'counterparty', p_counterparty));
    end if;
  end if;

  return finance_post_entry(
    p_user, p_date, v_label || ' - ' || p_ref, p_ref,
    case when p_kind = 'invoice' then 'invoice_payment' else 'bill_payment' end, p_doc,
    p_ccy, case when v_ok then v_rate end, case when v_ok then v_rdate end, case when v_ok then v_rsrc end,
    p_project, v_lines, p_legacy, not v_ok and p_ccy <> v_base);
end
$$;

create or replace function public.finance_cash_account_for(p_user uuid, p_ccy text, p_bank uuid, p_legacy boolean default false)
returns table(account_id uuid, bank_id uuid) language plpgsql stable security definer set search_path = public as $$
declare v_bank bank_accounts%rowtype; v_default uuid;
begin
  if p_legacy then
    return query select finance_sys_account(p_user, 'legacy_cash'), null::uuid;
    return;
  end if;
  if p_bank is not null then
    select * into v_bank from bank_accounts where id = p_bank and user_id = p_user;
  else
    select default_bank_account_id into v_default from finance_settings where user_id = p_user;
    if v_default is not null then
      select * into v_bank from bank_accounts where id = v_default and user_id = p_user and currency = p_ccy and not archived;
    end if;
  end if;
  if v_bank.id is not null then
    return query select v_bank.account_id, v_bank.id;
  else
    return query select finance_sys_account(p_user, 'legacy_cash'), null::uuid;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Invoices: ledger posting + payment sync
-- ---------------------------------------------------------------------------
create or replace function public.finance_active_entries(p_user uuid, p_doc uuid, p_type text)
returns setof uuid language sql stable security definer set search_path = public as $$
  select id from journal_entries
  where user_id = p_user and source_id = p_doc and source_type = p_type
    and reverses_entry_id is null and voided_by_entry_id is null
$$;

create or replace function public.finance_post_invoice(p_invoice uuid, p_legacy boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare inv invoices%rowtype; v_ccy text; v_date date; v_client text; v_existing uuid; v_entry uuid;
begin
  select * into inv from invoices where id = p_invoice;
  if not found or inv.amount is null or inv.amount <= 0 then return null; end if;
  select id into v_existing from finance_active_entries(inv.user_id, inv.id, 'invoice') id limit 1;
  if v_existing is not null then return v_existing; end if;
  v_ccy := finance_ccy_code(inv.currency);
  v_date := finance_parse_date(inv.issue_date, inv.created_at::date);
  select coalesce(client, '') into v_client from projects where id = inv.project_id;
  v_entry := finance_post_entry(inv.user_id, v_date,
    initcap(coalesce(inv.doc_type, 'invoice')) || ' ' || inv.invoice_number, inv.invoice_number, 'invoice', inv.id,
    v_ccy, null, null, null, inv.project_id,
    jsonb_build_array(
      jsonb_build_object('account_id', finance_sys_account(inv.user_id, 'ar'), 'debit', inv.amount, 'counterparty', v_client),
      jsonb_build_object('account_id', finance_sys_account(inv.user_id, 'sales'), 'credit', inv.amount, 'counterparty', v_client)),
    p_legacy);
  return v_entry;
end
$$;

create or replace function public.finance_sync_invoice_paid(p_invoice uuid)
returns void language plpgsql security definer set search_path = public as $$
declare inv invoices%rowtype; v_paid numeric; v_last date;
begin
  select * into inv from invoices where id = p_invoice for update;
  if not found then return; end if;
  select coalesce(sum(amount), 0), max(paid_date) into v_paid, v_last
  from invoice_payments where invoice_id = p_invoice and status = 'posted';
  perform set_config('finance.rpc', '1', true);
  update invoices set
    amount_paid = v_paid,
    status = case when v_paid >= amount - 0.005 and amount > 0 then 'paid' else 'unpaid' end,
    paid_date = case when v_paid >= amount - 0.005 and amount > 0 then to_char(v_last, 'YYYY-MM-DD') else '' end
  where id = p_invoice;
  perform set_config('finance.rpc', '0', true);
end
$$;

-- Turns an invoice row's own amount_paid (set by older UI flows, receipts and
-- milestone RPCs) into a real payment record + journal entry.
create or replace function public.finance_post_row_payment(p_invoice uuid, p_legacy boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare inv invoices%rowtype; v_ccy text; v_date date; v_amt numeric; v_cash record; v_entry uuid; v_have numeric;
begin
  select * into inv from invoices where id = p_invoice;
  if not found or coalesce(inv.amount_paid, 0) <= 0 or coalesce(inv.amount, 0) <= 0 then return; end if;
  select coalesce(sum(amount), 0) into v_have from invoice_payments where invoice_id = inv.id and status = 'posted';
  v_amt := least(inv.amount_paid, inv.amount) - v_have;
  if v_amt <= 0.005 then return; end if;
  v_ccy := finance_ccy_code(inv.currency);
  v_date := finance_parse_date(inv.paid_date, finance_parse_date(inv.issue_date, inv.created_at::date));
  select * into v_cash from finance_cash_account_for(inv.user_id, v_ccy, null, p_legacy);
  v_entry := finance_settle(inv.user_id, 'invoice', inv.id, v_ccy, inv.project_id,
    coalesce((select client from projects where id = inv.project_id), ''), inv.invoice_number,
    v_amt, v_date, v_cash.account_id, v_cash.bank_id, p_legacy);
  insert into invoice_payments (user_id, invoice_id, invoice_number, amount, currency, paid_date, method,
                                bank_account_id, reference, journal_entry_id, is_legacy)
  values (inv.user_id, inv.id, inv.invoice_number, v_amt, v_ccy, v_date, case when p_legacy then 'Legacy' else 'Recorded on invoice' end,
          v_cash.bank_id, inv.invoice_number, v_entry, p_legacy);
end
$$;

create or replace function public.finance_invoice_after_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare r uuid;
begin
  perform finance_init_user(new.user_id);
  if new.converted_from_id is not null then
    -- A receipt/final invoice generated from an earlier document replaces it
    -- (the app has always counted only the latest document in a chain).
    for r in select id from journal_entries
             where user_id = new.user_id and source_id = new.converted_from_id
               and reverses_entry_id is null and voided_by_entry_id is null loop
      perform finance_void_entry(new.user_id, r, 'Superseded by ' || new.invoice_number);
    end loop;
    update invoice_payments set status = 'void', void_reason = 'superseded by ' || new.invoice_number
      where invoice_id = new.converted_from_id and status = 'posted';
  end if;
  perform finance_post_invoice(new.id, false);
  perform finance_post_row_payment(new.id, false);
  return null;
end
$$;

create or replace function public.finance_invoice_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_posted boolean; v_has_pay boolean;
begin
  if coalesce(current_setting('finance.rpc', true), '') = '1' then return new; end if;
  select exists (select 1 from journal_entries where user_id = old.user_id and source_id = old.id
                 and reverses_entry_id is null and voided_by_entry_id is null) into v_posted;
  if not v_posted then return new; end if;
  if new.amount_paid is distinct from old.amount_paid
     or new.status is distinct from old.status
     or coalesce(new.paid_date, '') is distinct from coalesce(old.paid_date, '') then
    raise exception 'This invoice is in the ledger. Record or void payments from Finance > Sales instead of editing the paid amount.' using errcode = 'P0001';
  end if;
  if new.amount is distinct from old.amount or new.currency is distinct from old.currency
     or new.project_id is distinct from old.project_id
     or coalesce(new.issue_date, '') is distinct from coalesce(old.issue_date, '') then
    select exists (select 1 from invoice_payments where invoice_id = old.id and status = 'posted') into v_has_pay;
    if v_has_pay then
      raise exception 'This invoice has payments. Void the payments before changing its amount, currency, project or issue date.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end
$$;

create or replace function public.finance_invoice_after_update()
returns trigger language plpgsql security definer set search_path = public as $$
declare r uuid;
begin
  if coalesce(current_setting('finance.rpc', true), '') = '1' then return null; end if;
  if new.amount is distinct from old.amount or new.currency is distinct from old.currency
     or new.project_id is distinct from old.project_id
     or coalesce(new.issue_date, '') is distinct from coalesce(old.issue_date, '') then
    for r in select * from finance_active_entries(new.user_id, new.id, 'invoice') loop
      perform finance_void_entry(new.user_id, r, 'Invoice revised');
    end loop;
    perform finance_post_invoice(new.id, false);
  end if;
  return null;
end
$$;

create or replace function public.finance_invoice_before_delete()
returns trigger language plpgsql security definer set search_path = public as $$
declare r uuid;
begin
  if exists (select 1 from invoice_payments where invoice_id = old.id and status = 'posted') then
    raise exception 'This invoice has recorded payments and cannot be deleted. Void the payments first, or archive the project.' using errcode = 'P0001';
  end if;
  for r in select * from finance_active_entries(old.user_id, old.id, 'invoice') loop
    perform finance_void_entry(old.user_id, r, 'Invoice deleted');
  end loop;
  return old;
end
$$;

-- ---------------------------------------------------------------------------
-- Expenses: ledger posting (paid immediately: Dr expense / Cr bank or cash)
-- ---------------------------------------------------------------------------
create or replace function public.finance_post_expense(p_expense uuid, p_legacy boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare e expenses%rowtype; v_ccy text; v_date date; v_debit uuid; v_cash record; v_entry uuid; v_bank bank_accounts%rowtype;
begin
  select * into e from expenses where id = p_expense;
  if not found or coalesce(e.amount, 0) <= 0 or e.bill_id is not null then return null; end if;
  v_ccy := finance_ccy_code(e.currency);
  v_date := finance_parse_date(e.date, e.created_at::date);
  v_debit := coalesce(e.account_id, finance_expense_account(e.user_id, e.category));
  if e.bank_account_id is not null then
    select * into v_bank from bank_accounts where id = e.bank_account_id and user_id = e.user_id;
    if v_bank.id is null then raise exception 'Payment account not found.' using errcode = 'P0001'; end if;
    if v_bank.currency <> v_ccy then
      raise exception 'This expense is in % but the payment account is in %.', v_ccy, v_bank.currency using errcode = 'P0001';
    end if;
    select * into v_cash from finance_cash_account_for(e.user_id, v_ccy, e.bank_account_id);
  else
    select * into v_cash from finance_cash_account_for(e.user_id, v_ccy, null, p_legacy);
  end if;
  v_entry := finance_post_entry(e.user_id, v_date,
    coalesce(nullif(e.description, ''), e.category), coalesce(nullif(e.reference, ''), ''), 'expense', e.id,
    v_ccy, null, null, null, e.project_id,
    jsonb_build_array(
      jsonb_build_object('account_id', v_debit, 'debit', e.amount, 'counterparty', e.vendor, 'memo', e.category),
      jsonb_build_object('account_id', v_cash.account_id, 'credit', e.amount, 'bank_account_id', v_cash.bank_id, 'counterparty', e.vendor)),
    p_legacy);
  perform set_config('finance.rpc', '1', true);
  update expenses set journal_entry_id = v_entry where id = e.id;
  perform set_config('finance.rpc', '0', true);
  return v_entry;
end
$$;

create or replace function public.finance_expense_after_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform finance_init_user(new.user_id);
  perform finance_post_expense(new.id, false);
  return null;
end
$$;

create or replace function public.finance_expense_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('finance.rpc', true), '') = '1' then return new; end if;
  if old.bill_id is not null and (
       new.amount is distinct from old.amount or new.currency is distinct from old.currency
       or new.date is distinct from old.date or new.category is distinct from old.category) then
    raise exception 'This payment is part of a freelancer bill. Void the bill payment from Finance > Purchases instead of editing it.' using errcode = 'P0001';
  end if;
  return new;
end
$$;

create or replace function public.finance_expense_after_update()
returns trigger language plpgsql security definer set search_path = public as $$
declare r uuid;
begin
  if coalesce(current_setting('finance.rpc', true), '') = '1' then return null; end if;
  if new.bill_id is not null then return null; end if;
  if new.amount is distinct from old.amount or new.currency is distinct from old.currency
     or new.date is distinct from old.date or new.project_id is distinct from old.project_id
     or new.category is distinct from old.category or new.account_id is distinct from old.account_id
     or new.bank_account_id is distinct from old.bank_account_id then
    for r in select * from finance_active_entries(new.user_id, new.id, 'expense') loop
      perform finance_void_entry(new.user_id, r, 'Expense revised');
    end loop;
    perform finance_post_expense(new.id, false);
  end if;
  return null;
end
$$;

create or replace function public.finance_expense_before_delete()
returns trigger language plpgsql security definer set search_path = public as $$
declare r uuid;
begin
  if old.bill_id is not null then
    raise exception 'This payment belongs to a freelancer bill. Void the bill payment from Finance > Purchases instead.' using errcode = 'P0001';
  end if;
  for r in select * from finance_active_entries(old.user_id, old.id, 'expense') loop
    perform finance_void_entry(old.user_id, r, 'Expense deleted');
  end loop;
  return old;
end
$$;

-- ---------------------------------------------------------------------------
-- Bills
-- ---------------------------------------------------------------------------
create or replace function public.finance_post_bill(p_bill uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare b bills%rowtype; v_entry uuid; v_acct uuid;
begin
  select * into b from bills where id = p_bill for update;
  if not found then raise exception 'Bill not found.' using errcode = 'P0001'; end if;
  if b.journal_entry_id is not null then return b.journal_entry_id; end if;
  v_acct := coalesce(b.account_id, finance_sys_account(b.user_id, 'freelancer_costs'));
  v_entry := finance_post_entry(b.user_id, b.issue_date,
    'Bill ' || coalesce(nullif(b.bill_number, ''), left(b.id::text, 8)) || ' - ' || b.vendor_name,
    b.bill_number, 'bill', b.id, b.currency, null, null, null, b.project_id,
    jsonb_build_array(
      jsonb_build_object('account_id', v_acct, 'debit', b.amount, 'counterparty', b.vendor_name, 'memo', b.description),
      jsonb_build_object('account_id', finance_sys_account(b.user_id, 'ap'), 'credit', b.amount, 'counterparty', b.vendor_name)));
  update bills set journal_entry_id = v_entry, status = 'approved', updated_at = now() where id = b.id;
  return v_entry;
end
$$;

create or replace function public.finance_sync_bill_paid(p_bill uuid)
returns void language plpgsql security definer set search_path = public as $$
declare b bills%rowtype; v_paid numeric;
begin
  select * into b from bills where id = p_bill for update;
  if not found or b.status in ('draft', 'void') then return; end if;
  select coalesce(sum(amount), 0) into v_paid from bill_payments where bill_id = p_bill and status = 'posted';
  update bills set amount_paid = v_paid, updated_at = now(),
    status = case when v_paid >= amount - 0.005 then 'paid' when v_paid > 0 then 'partially_paid' else 'approved' end
  where id = p_bill;
end
$$;

create or replace function public.finance_pay_bill_internal(
  p_user uuid, p_bill uuid, p_amount numeric, p_date date, p_bank uuid, p_method text, p_ref text, p_legacy boolean
) returns uuid language plpgsql security definer set search_path = public as $$
declare b bills%rowtype; v_cash record; v_bank bank_accounts%rowtype; v_entry uuid; v_pay uuid;
begin
  select * into b from bills where id = p_bill and user_id = p_user for update;
  if not found then raise exception 'Bill not found.' using errcode = 'P0001'; end if;
  if b.status in ('draft', 'void') then raise exception 'Approve the bill before paying it.' using errcode = 'P0001'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter a payment amount.' using errcode = 'P0001'; end if;
  if p_bank is not null then
    select * into v_bank from bank_accounts where id = p_bank and user_id = p_user and not archived;
    if v_bank.id is null then raise exception 'Payment account not found.' using errcode = 'P0001'; end if;
    if v_bank.currency <> b.currency then
      raise exception 'This bill is in % but the account is in %. Pay from a % account.', b.currency, v_bank.currency, b.currency using errcode = 'P0001';
    end if;
  end if;
  select * into v_cash from finance_cash_account_for(p_user, b.currency, p_bank);
  v_entry := finance_settle(p_user, 'bill', b.id, b.currency, b.project_id, b.vendor_name,
    coalesce(nullif(b.bill_number, ''), left(b.id::text, 8)), p_amount, coalesce(p_date, current_date),
    v_cash.account_id, v_cash.bank_id, p_legacy);
  insert into bill_payments (user_id, bill_id, bill_number, vendor_name, amount, currency, paid_date, method,
                             bank_account_id, reference, journal_entry_id, is_legacy)
  values (p_user, b.id, b.bill_number, b.vendor_name, p_amount, b.currency, coalesce(p_date, current_date),
          coalesce(p_method, ''), v_cash.bank_id, coalesce(p_ref, ''), v_entry, p_legacy)
  returning id into v_pay;
  perform finance_sync_bill_paid(b.id);
  perform finance_audit(p_user, 'pay', 'bill_payment', v_pay, null,
    jsonb_build_object('bill_id', b.id, 'amount', p_amount, 'currency', b.currency));
  return v_pay;
end
$$;

-- ---------------------------------------------------------------------------
-- Legacy shot payments: keep the exact same signature/return so Teams is
-- unchanged, but a payment now produces bill -> payment -> ledger atomically.
-- Duplicate protection: shots row lock + assigned_paid + bill_shots/expenses unique indexes.
-- ---------------------------------------------------------------------------
create or replace function public.log_shot_payment(
  p_shot_id uuid, p_project_id uuid, p_category text, p_description text,
  p_amount numeric, p_currency text, p_date text
)
returns table (expense_id uuid, already_paid boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_shot_owner uuid; v_shot_already_paid boolean; v_member uuid; v_assigned_to text;
  v_expense_id uuid; v_bill uuid; v_ccy text; v_vendor text; v_date date;
  v_contact uuid;
begin
  select user_id, assigned_paid, assigned_member_id, assigned_to
    into v_shot_owner, v_shot_already_paid, v_member, v_assigned_to
  from shots where id = p_shot_id for update;
  if v_shot_owner is null then raise exception 'Shot not found'; end if;
  if v_shot_owner <> v_user_id then raise exception 'Not authorized to log payment for this shot'; end if;
  if p_project_id is not null and not exists (select 1 from projects where id = p_project_id and user_id = v_user_id) then
    raise exception 'Not authorized to use this project';
  end if;
  if v_shot_already_paid then
    select id into v_expense_id from expenses where shot_id = p_shot_id;
    return query select v_expense_id, true;
    return;
  end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Payment amount must be greater than zero'; end if;

  perform finance_init_user(v_user_id);
  v_ccy := finance_ccy_code(p_currency);
  v_date := finance_parse_date(p_date, current_date);
  select coalesce(nullif(name, ''), 'Freelancer') into v_vendor from team_members where id = v_member;
  v_vendor := coalesce(v_vendor, nullif(v_assigned_to, ''), 'Freelancer');

  select bill_id into v_bill from bill_shots where shot_id = p_shot_id;
  if v_bill is null then
    if v_member is not null then
      insert into finance_contacts (user_id, kind, name, team_member_id)
      values (v_user_id, 'vendor', v_vendor, v_member)
      on conflict (user_id, team_member_id) where team_member_id is not null do update set name = excluded.name
      returning id into v_contact;
    end if;
    insert into bills (user_id, contact_id, team_member_id, vendor_name, project_id, bill_number, description,
                       currency, amount, issue_date, due_date, status)
    values (v_user_id, v_contact, v_member, v_vendor, p_project_id, 'SHOT-' || left(p_shot_id::text, 8),
            coalesce(p_description, ''), v_ccy, p_amount, v_date, v_date, 'draft')
    returning id into v_bill;
    insert into bill_shots (bill_id, shot_id, user_id, amount) values (v_bill, p_shot_id, v_user_id, p_amount);
    perform finance_post_bill(v_bill);
  end if;
  perform finance_pay_bill_internal(v_user_id, v_bill, p_amount, v_date, null, 'Shot payment', p_description, false);

  -- Display record for project expense lists; posting is skipped (bill_id set),
  -- the bill/payment entries above are the accounting.
  insert into expenses (user_id, project_id, shot_id, category, description, amount, currency, date, vendor, bill_id)
  values (v_user_id, p_project_id, p_shot_id, p_category, p_description, p_amount, p_currency, p_date, v_vendor, v_bill)
  on conflict (shot_id) where shot_id is not null do nothing
  returning id into v_expense_id;
  if v_expense_id is null then
    select id into v_expense_id from expenses where shot_id = p_shot_id;
    return query select v_expense_id, true;
    return;
  end if;
  update shots set assigned_paid = true where id = p_shot_id;
  return query select v_expense_id, false;
end
$$;
revoke all on function public.log_shot_payment(uuid, uuid, text, text, numeric, text, text) from public;
grant execute on function public.log_shot_payment(uuid, uuid, text, text, numeric, text, text) to authenticated;

-- =============================================================================
-- PART C: client-callable RPCs, legacy backfill, triggers, privileges
-- Every RPC derives the user from auth.uid(); none accepts a user id.
-- =============================================================================

alter table finance_settings drop constraint if exists finance_settings_default_bank_fk;
alter table finance_settings add constraint finance_settings_default_bank_fk
  foreign key (default_bank_account_id) references bank_accounts(id) on delete set null;

-- Base currency is locked once new-style (non-legacy) transactions exist.
create or replace function public.finance_settings_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.base_currency is distinct from old.base_currency then
    if exists (select 1 from journal_entries where user_id = old.user_id limit 1) then
      raise exception 'Base currency cannot be changed once transactions are in the ledger. Use Finance > Settings > Change base currency (only possible before new-style transactions are posted).' using errcode = 'P0001';
    end if;
  end if;
  new.updated_at := now();
  return new;
end
$$;
drop trigger if exists trg_finance_settings_guard on finance_settings;
create trigger trg_finance_settings_guard before update on finance_settings
  for each row execute function public.finance_settings_guard();

create or replace function public.finance_require_user()
returns uuid language plpgsql stable as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  return uid;
end
$$;

create or replace function public.finance_init()
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := finance_require_user(); s finance_settings%rowtype;
begin
  perform finance_init_user(uid);
  select * into s from finance_settings where user_id = uid;
  return to_jsonb(s);
end
$$;

-- ---------------------------------------------------------------------------
-- Banking
-- ---------------------------------------------------------------------------
create or replace function public.finance_create_bank_account(
  p_name text, p_kind text, p_currency text, p_opening_balance numeric default 0, p_opened_on date default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  uid uuid := finance_require_user(); v_ccy text := upper(coalesce(p_currency, ''));
  v_code int; v_acct uuid; v_bank uuid; v_entry uuid; v_date date := coalesce(p_opened_on, current_date);
  v_eq uuid; v_open numeric := round(coalesce(p_opening_balance, 0), 2);
begin
  perform finance_init_user(uid);
  if btrim(coalesce(p_name, '')) = '' then raise exception 'Give the account a name.' using errcode = 'P0001'; end if;
  if v_ccy !~ '^[A-Z]{3}$' then raise exception 'Choose a currency for the account.' using errcode = 'P0001'; end if;
  if p_kind not in ('bank', 'cash', 'wallet') then raise exception 'Unknown account kind.' using errcode = 'P0001'; end if;
  select coalesce(max(code::int), 1000) + 1 into v_code from chart_accounts where user_id = uid and code ~ '^10[0-8][0-9]$';
  if v_code > 1089 then raise exception 'Too many bank accounts.' using errcode = 'P0001'; end if;
  insert into chart_accounts (user_id, code, name, type, subtype, is_system, tax_deductible)
  values (uid, v_code::text, btrim(p_name), 'asset', case when p_kind = 'cash' then 'cash' else 'bank' end, true, false)
  returning id into v_acct;
  insert into bank_accounts (user_id, name, kind, currency, account_id, opened_on)
  values (uid, btrim(p_name), p_kind, v_ccy, v_acct, v_date) returning id into v_bank;
  update finance_settings set default_bank_account_id = coalesce(default_bank_account_id, v_bank) where user_id = uid;
  if v_open <> 0 then
    v_eq := finance_sys_account(uid, 'opening_equity');
    v_entry := finance_post_entry(uid, v_date, 'Opening balance - ' || btrim(p_name), 'OPENING', 'opening', v_bank,
      v_ccy, null, null, null, null,
      jsonb_build_array(
        jsonb_build_object('account_id', v_acct, 'bank_account_id', v_bank,
                           'debit', greatest(v_open, 0), 'credit', greatest(-v_open, 0)),
        jsonb_build_object('account_id', v_eq,
                           'debit', greatest(-v_open, 0), 'credit', greatest(v_open, 0))));
    update journal_lines set reconciled_at = now() where entry_id = v_entry and account_id = v_acct;
  end if;
  perform finance_audit(uid, 'create', 'bank_account', v_bank, null,
    jsonb_build_object('name', p_name, 'currency', v_ccy, 'opening_balance', v_open));
  return v_bank;
end
$$;

create or replace function public.finance_update_bank_account(p_id uuid, p_name text, p_archived boolean, p_make_default boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := finance_require_user(); b bank_accounts%rowtype;
begin
  select * into b from bank_accounts where id = p_id and user_id = uid for update;
  if not found then raise exception 'Account not found.' using errcode = 'P0001'; end if;
  update bank_accounts set name = coalesce(nullif(btrim(p_name), ''), name), archived = coalesce(p_archived, archived) where id = p_id;
  update chart_accounts set name = coalesce(nullif(btrim(p_name), ''), name) where id = b.account_id;
  if p_make_default then update finance_settings set default_bank_account_id = p_id where user_id = uid; end if;
  perform finance_audit(uid, 'update', 'bank_account', p_id, to_jsonb(b), jsonb_build_object('name', p_name, 'archived', p_archived));
end
$$;

create or replace function public.finance_record_transfer(
  p_from uuid, p_to uuid, p_amount_from numeric, p_amount_to numeric, p_date date, p_reference text default ''
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  uid uuid := finance_require_user(); f bank_accounts%rowtype; t bank_accounts%rowtype;
  v_date date := coalesce(p_date, current_date); v_fx uuid := null;
  r_from record; r_to record; v_from_base numeric; v_to_base numeric; v_diff numeric; v_lines jsonb; v_entry uuid;
begin
  perform finance_init_user(uid);
  select * into f from bank_accounts where id = p_from and user_id = uid;
  select * into t from bank_accounts where id = p_to and user_id = uid;
  if f.id is null or t.id is null then raise exception 'Choose both accounts.' using errcode = 'P0001'; end if;
  if f.id = t.id then raise exception 'Choose two different accounts.' using errcode = 'P0001'; end if;
  if p_amount_from is null or p_amount_from <= 0 then raise exception 'Enter an amount.' using errcode = 'P0001'; end if;
  if f.currency = t.currency then
    if p_amount_to is not null and abs(p_amount_to - p_amount_from) > 0.005 then
      raise exception 'Transfers between accounts in the same currency must be the same amount.' using errcode = 'P0001';
    end if;
    v_lines := jsonb_build_array(
      jsonb_build_object('account_id', t.account_id, 'bank_account_id', t.id, 'debit', p_amount_from),
      jsonb_build_object('account_id', f.account_id, 'bank_account_id', f.id, 'credit', p_amount_from));
    v_entry := finance_post_entry(uid, v_date, 'Transfer ' || f.name || ' to ' || t.name, coalesce(p_reference, ''),
      'transfer', null, f.currency, null, null, null, null, v_lines);
  else
    if p_amount_to is null or p_amount_to <= 0 then
      raise exception 'Enter the amount received in %.', t.currency using errcode = 'P0001';
    end if;
    select * into r_from from finance_fx_to_base(uid, f.currency, v_date) limit 1;
    select * into r_to from finance_fx_to_base(uid, t.currency, v_date) limit 1;
    if r_from.rate is null or r_to.rate is null then
      raise exception 'An FX rate is missing for this date. Add the rate in Finance > Settings before recording a cross-currency transfer.' using errcode = 'P0001';
    end if;
    v_from_base := round(p_amount_from * r_from.rate, 2);
    v_to_base := round(p_amount_to * r_to.rate, 2);
    v_diff := v_to_base - v_from_base;
    v_lines := jsonb_build_array(
      jsonb_build_object('account_id', t.account_id, 'bank_account_id', t.id, 'currency', t.currency, 'debit', p_amount_to, 'base_debit', v_to_base),
      jsonb_build_object('account_id', f.account_id, 'bank_account_id', f.id, 'currency', f.currency, 'credit', p_amount_from, 'base_credit', v_from_base));
    v_fx := finance_sys_account(uid, 'fx_gain_loss');
    -- received more base value than was sent = FX gain (credit); less = loss (debit)
    if v_diff > 0 then v_lines := v_lines || jsonb_build_object('account_id', v_fx, 'base_credit', v_diff, 'memo', 'Realized FX gain on conversion');
    elsif v_diff < 0 then v_lines := v_lines || jsonb_build_object('account_id', v_fx, 'base_debit', -v_diff, 'memo', 'Realized FX loss on conversion'); end if;
    v_entry := finance_post_entry(uid, v_date, 'Conversion ' || f.name || ' to ' || t.name, coalesce(p_reference, ''),
      'transfer', null, f.currency, r_from.rate, r_from.rate_date, r_from.source, null, v_lines);
  end if;
  return v_entry;
end
$$;

-- Reconciliation: marks the selected bank-ledger lines as cleared and checks that
-- (cleared book balance) = (statement balance). Refuses to save a mismatch.
create or replace function public.finance_reconcile(
  p_bank uuid, p_statement_date date, p_statement_balance numeric, p_line_ids uuid[]
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  uid uuid := finance_require_user(); b bank_accounts%rowtype; v_cleared numeric; v_diff numeric; v_rec uuid; v_n int;
begin
  select * into b from bank_accounts where id = p_bank and user_id = uid for update;
  if not found then raise exception 'Account not found.' using errcode = 'P0001'; end if;
  select count(*) into v_n from journal_lines
   where id = any(coalesce(p_line_ids, '{}')) and user_id = uid and account_id = b.account_id and reconciled_at is null;
  if v_n <> coalesce(array_length(p_line_ids, 1), 0) then
    raise exception 'Some selected transactions are not available to reconcile.' using errcode = 'P0001';
  end if;
  select coalesce(sum(debit - credit), 0) into v_cleared from journal_lines
   where user_id = uid and account_id = b.account_id and (reconciled_at is not null or id = any(coalesce(p_line_ids, '{}')));
  v_diff := round(p_statement_balance - v_cleared, 2);
  if abs(v_diff) > 0.005 then
    raise exception 'Statement balance differs from cleared book balance by % %. Adjust the selection or record the missing transaction.', b.currency, v_diff using errcode = 'P0001';
  end if;
  insert into bank_reconciliations (user_id, bank_account_id, statement_date, statement_balance, book_balance, difference, line_count)
  values (uid, b.id, p_statement_date, p_statement_balance, v_cleared, v_diff, v_n) returning id into v_rec;
  update journal_lines set reconciled_at = now(), reconciliation_id = v_rec
   where id = any(coalesce(p_line_ids, '{}')) and user_id = uid;
  update bank_accounts set reconciled_through = p_statement_date where id = b.id;
  perform finance_audit(uid, 'reconcile', 'bank_account', b.id, null,
    jsonb_build_object('statement_date', p_statement_date, 'statement_balance', p_statement_balance, 'lines', v_n));
  return v_rec;
end
$$;

-- ---------------------------------------------------------------------------
-- Invoice payments
-- ---------------------------------------------------------------------------
create or replace function public.finance_record_invoice_payment(
  p_invoice uuid, p_amount numeric, p_date date, p_bank_account uuid, p_method text default '', p_reference text default ''
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  uid uuid := finance_require_user(); inv invoices%rowtype; v_ccy text; v_bank bank_accounts%rowtype;
  v_entry uuid; v_pay uuid; v_date date := coalesce(p_date, current_date);
begin
  perform finance_init_user(uid);
  select * into inv from invoices where id = p_invoice for update;
  if not found or inv.user_id <> uid then raise exception 'Invoice not found.' using errcode = 'P0001'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter a payment amount.' using errcode = 'P0001'; end if;
  v_ccy := finance_ccy_code(inv.currency);
  select * into v_bank from bank_accounts where id = p_bank_account and user_id = uid and not archived;
  if v_bank.id is null then raise exception 'Choose the bank or cash account that received the payment.' using errcode = 'P0001'; end if;
  if v_bank.currency <> v_ccy then
    raise exception 'This invoice is in % but the account is in %. Receive the payment into a % account.', v_ccy, v_bank.currency, v_ccy using errcode = 'P0001';
  end if;
  perform finance_post_invoice(inv.id, false);
  v_entry := finance_settle(uid, 'invoice', inv.id, v_ccy, inv.project_id,
    coalesce((select client from projects where id = inv.project_id), ''), inv.invoice_number,
    p_amount, v_date, v_bank.account_id, v_bank.id, false);
  insert into invoice_payments (user_id, invoice_id, invoice_number, amount, currency, paid_date, method,
                                bank_account_id, reference, journal_entry_id)
  values (uid, inv.id, inv.invoice_number, p_amount, v_ccy, v_date, coalesce(p_method, ''), v_bank.id,
          coalesce(p_reference, ''), v_entry) returning id into v_pay;
  perform finance_sync_invoice_paid(inv.id);
  perform finance_audit(uid, 'pay', 'invoice_payment', v_pay, null,
    jsonb_build_object('invoice_id', inv.id, 'amount', p_amount, 'currency', v_ccy));
  return v_pay;
end
$$;

create or replace function public.finance_void_invoice_payment(p_payment uuid, p_reason text default '')
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := finance_require_user(); p invoice_payments%rowtype;
begin
  select * into p from invoice_payments where id = p_payment and user_id = uid for update;
  if not found then raise exception 'Payment not found.' using errcode = 'P0001'; end if;
  if p.status = 'void' then return; end if;
  perform finance_void_entry(uid, p.journal_entry_id, p_reason);
  update invoice_payments set status = 'void', void_reason = coalesce(p_reason, '') where id = p.id;
  if p.invoice_id is not null then perform finance_sync_invoice_paid(p.invoice_id); end if;
  perform finance_audit(uid, 'void', 'invoice_payment', p.id, to_jsonb(p), jsonb_build_object('reason', p_reason));
end
$$;

-- ---------------------------------------------------------------------------
-- Bills & payables
-- ---------------------------------------------------------------------------
create or replace function public.finance_save_bill(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  uid uuid := finance_require_user(); v_id uuid := nullif(p->>'id', '')::uuid;
  v_ccy text := upper(coalesce(p->>'currency', '')); v_amount numeric := round(coalesce((p->>'amount')::numeric, 0), 2);
  v_member uuid := nullif(p->>'team_member_id', '')::uuid; v_contact uuid := nullif(p->>'contact_id', '')::uuid;
  v_project uuid := nullif(p->>'project_id', '')::uuid; v_acct uuid := nullif(p->>'account_id', '')::uuid;
  v_vendor text := btrim(coalesce(p->>'vendor_name', '')); v_status text;
begin
  perform finance_init_user(uid);
  if v_ccy !~ '^[A-Z]{3}$' then raise exception 'Choose a currency.' using errcode = 'P0001'; end if;
  if v_amount <= 0 then raise exception 'Enter the bill amount.' using errcode = 'P0001'; end if;
  if v_member is not null then
    if not exists (select 1 from team_members where id = v_member and user_id = uid) then raise exception 'Team member not found.' using errcode = 'P0001'; end if;
    if v_vendor = '' then select name into v_vendor from team_members where id = v_member; end if;
    if v_contact is null then
      insert into finance_contacts (user_id, kind, name, team_member_id) values (uid, 'vendor', v_vendor, v_member)
      on conflict (user_id, team_member_id) where team_member_id is not null do update set name = excluded.name
      returning id into v_contact;
    end if;
  end if;
  if v_vendor = '' then raise exception 'Who is this bill from?' using errcode = 'P0001'; end if;
  if v_project is not null and not exists (select 1 from projects where id = v_project and user_id = uid) then raise exception 'Project not found.' using errcode = 'P0001'; end if;
  if v_acct is not null and not exists (select 1 from chart_accounts where id = v_acct and user_id = uid and type in ('cogs', 'expense')) then
    raise exception 'Choose a cost or expense account.' using errcode = 'P0001';
  end if;
  if v_contact is not null and not exists (select 1 from finance_contacts where id = v_contact and user_id = uid) then raise exception 'Contact not found.' using errcode = 'P0001'; end if;

  if v_id is null then
    insert into bills (user_id, contact_id, team_member_id, vendor_name, project_id, bill_number, description, currency,
                       amount, issue_date, due_date, account_id, notes)
    values (uid, v_contact, v_member, v_vendor, v_project, coalesce(p->>'bill_number', ''), coalesce(p->>'description', ''), v_ccy,
            v_amount, coalesce(nullif(p->>'issue_date', '')::date, current_date), nullif(p->>'due_date', '')::date, v_acct, coalesce(p->>'notes', ''))
    returning id into v_id;
  else
    select status into v_status from bills where id = v_id and user_id = uid for update;
    if v_status is null then raise exception 'Bill not found.' using errcode = 'P0001'; end if;
    if v_status <> 'draft' then raise exception 'Only draft bills can be edited. Void it and create a new one.' using errcode = 'P0001'; end if;
    update bills set contact_id = v_contact, team_member_id = v_member, vendor_name = v_vendor, project_id = v_project,
      bill_number = coalesce(p->>'bill_number', ''), description = coalesce(p->>'description', ''), currency = v_ccy,
      amount = v_amount, issue_date = coalesce(nullif(p->>'issue_date', '')::date, current_date),
      due_date = nullif(p->>'due_date', '')::date, account_id = v_acct, notes = coalesce(p->>'notes', ''), updated_at = now()
    where id = v_id;
  end if;
  if coalesce((p->>'approve')::boolean, false) then perform finance_post_bill(v_id); end if;
  perform finance_audit(uid, 'save', 'bill', v_id, null, p);
  return v_id;
end
$$;

create or replace function public.finance_approve_bill(p_bill uuid)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := finance_require_user();
begin
  if not exists (select 1 from bills where id = p_bill and user_id = uid) then raise exception 'Bill not found.' using errcode = 'P0001'; end if;
  perform finance_post_bill(p_bill);
  perform finance_audit(uid, 'approve', 'bill', p_bill, null, null);
end
$$;

create or replace function public.finance_record_bill_payment(
  p_bill uuid, p_amount numeric, p_date date, p_bank_account uuid, p_method text default '', p_reference text default ''
) returns uuid language plpgsql security definer set search_path = public as $$
declare uid uuid := finance_require_user();
begin
  if p_bank_account is null then raise exception 'Choose the account the payment is made from.' using errcode = 'P0001'; end if;
  return finance_pay_bill_internal(uid, p_bill, p_amount, p_date, p_bank_account, p_method, p_reference, false);
end
$$;

create or replace function public.finance_void_bill_payment(p_payment uuid, p_reason text default '')
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := finance_require_user(); p bill_payments%rowtype;
begin
  select * into p from bill_payments where id = p_payment and user_id = uid for update;
  if not found then raise exception 'Payment not found.' using errcode = 'P0001'; end if;
  if p.status = 'void' then return; end if;
  perform finance_void_entry(uid, p.journal_entry_id, p_reason);
  update bill_payments set status = 'void', void_reason = coalesce(p_reason, '') where id = p.id;
  if p.bill_id is not null then perform finance_sync_bill_paid(p.bill_id); end if;
  perform finance_audit(uid, 'void', 'bill_payment', p.id, to_jsonb(p), jsonb_build_object('reason', p_reason));
end
$$;

create or replace function public.finance_void_bill(p_bill uuid, p_reason text default '')
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := finance_require_user(); b bills%rowtype;
begin
  select * into b from bills where id = p_bill and user_id = uid for update;
  if not found then raise exception 'Bill not found.' using errcode = 'P0001'; end if;
  if b.status = 'void' then return; end if;
  if exists (select 1 from bill_payments where bill_id = b.id and status = 'posted') then
    raise exception 'This bill has payments. Void the payments first.' using errcode = 'P0001';
  end if;
  if b.journal_entry_id is not null then perform finance_void_entry(uid, b.journal_entry_id, p_reason); end if;
  update bills set status = 'void', updated_at = now() where id = b.id;
  delete from bill_shots where bill_id = b.id; -- frees the shots to be billed again
  perform finance_audit(uid, 'void', 'bill', b.id, to_jsonb(b), jsonb_build_object('reason', p_reason));
end
$$;

-- Creates approved bills (one per currency) for assigned-but-unbilled shots.
-- Does NOT mark the shots paid: that still happens through Teams / payment.
create or replace function public.finance_bill_pending_shots(
  p_shot_ids uuid[], p_issue date default null, p_due date default null
) returns setof uuid language plpgsql security definer set search_path = public as $$
declare
  uid uuid := finance_require_user(); r record; v_bill uuid; v_member uuid; v_vendor text; v_contact uuid;
  v_issue date := coalesce(p_issue, current_date);
begin
  perform finance_init_user(uid);
  perform 1 from shots where id = any(p_shot_ids) and user_id = uid for update;
  for r in
    select finance_ccy_code(p.currency) as ccy, s.assigned_member_id as member, max(s.assigned_to) as assigned_to,
           sum(s.assigned_pay) as total, count(distinct s.project_id) as projects, min(s.project_id::text)::uuid as project_id,
           array_agg(s.id) as shot_ids, array_agg(s.assigned_pay) as pays
    from shots s join projects p on p.id = s.project_id
    where s.id = any(p_shot_ids) and s.user_id = uid and not s.assigned_paid and s.assigned_pay > 0
      and not exists (select 1 from bill_shots bs where bs.shot_id = s.id)
    group by finance_ccy_code(p.currency), s.assigned_member_id
  loop
    v_member := r.member;
    select coalesce(nullif(name, ''), r.assigned_to, 'Freelancer') into v_vendor from team_members where id = v_member;
    v_vendor := coalesce(v_vendor, nullif(r.assigned_to, ''), 'Freelancer');
    v_contact := null;
    if v_member is not null then
      insert into finance_contacts (user_id, kind, name, team_member_id) values (uid, 'vendor', v_vendor, v_member)
      on conflict (user_id, team_member_id) where team_member_id is not null do update set name = excluded.name
      returning id into v_contact;
    end if;
    insert into bills (user_id, contact_id, team_member_id, vendor_name, project_id, bill_number, description, currency,
                       amount, issue_date, due_date)
    values (uid, v_contact, v_member, v_vendor, case when r.projects = 1 then r.project_id end,
            'FB-' || to_char(v_issue, 'YYMMDD') || '-' || left(gen_random_uuid()::text, 4),
            array_length(r.shot_ids, 1) || ' assigned shot(s)', r.ccy, r.total, v_issue, p_due)
    returning id into v_bill;
    insert into bill_shots (bill_id, shot_id, user_id, amount)
      select v_bill, x.sid, uid, x.pay from unnest(r.shot_ids, r.pays) as x(sid, pay);
    perform finance_post_bill(v_bill);
    perform finance_audit(uid, 'create', 'bill', v_bill, null, jsonb_build_object('shots', r.shot_ids));
    return next v_bill;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Manual journals and FX resolution
-- ---------------------------------------------------------------------------
create or replace function public.finance_post_manual_entry(
  p_date date, p_memo text, p_reference text, p_currency text, p_fx_rate numeric, p_lines jsonb
) returns uuid language plpgsql security definer set search_path = public as $$
declare uid uuid := finance_require_user(); v_ccy text := upper(coalesce(p_currency, ''));
begin
  perform finance_init_user(uid);
  if v_ccy !~ '^[A-Z]{3}$' then raise exception 'Choose a currency.' using errcode = 'P0001'; end if;
  return finance_post_entry(uid, coalesce(p_date, current_date), coalesce(p_memo, ''), coalesce(p_reference, ''),
    'manual', null, v_ccy, p_fx_rate, case when p_fx_rate is not null then coalesce(p_date, current_date) end,
    case when p_fx_rate is not null then 'manual' end, null, p_lines);
end
$$;

create or replace function public.finance_void_manual_entry(p_entry uuid, p_reason text default '')
returns uuid language plpgsql security definer set search_path = public as $$
declare uid uuid := finance_require_user(); e journal_entries%rowtype;
begin
  select * into e from journal_entries where id = p_entry and user_id = uid;
  if not found then raise exception 'Entry not found.' using errcode = 'P0001'; end if;
  if e.source_type not in ('manual', 'transfer', 'opening') then
    raise exception 'Void this from the invoice, bill, payment or expense it came from.' using errcode = 'P0001';
  end if;
  return finance_void_entry(uid, p_entry, p_reason);
end
$$;

-- Supplies a transaction-date rate for an entry that was posted without one.
-- The rate is stamped with its source so the audit trail shows it was entered later.
create or replace function public.finance_set_entry_fx(p_entry uuid, p_rate numeric, p_rate_date date, p_source text)
returns void language plpgsql security definer set search_path = public as $$
declare
  uid uuid := finance_require_user(); e journal_entries%rowtype; v_ctrl uuid; v_fx uuid; v_pos record;
  v_open_native numeric; v_open_base numeric; v_amt numeric; v_release numeric; v_bank_base numeric; v_diff numeric;
  v_ctrl_line uuid; v_cash_line uuid; v_is_ar boolean; v_next int;
begin
  select * into e from journal_entries where id = p_entry and user_id = uid for update;
  if not found then raise exception 'Entry not found.' using errcode = 'P0001'; end if;
  if e.fx_status <> 'missing' then raise exception 'This entry already has an exchange rate.' using errcode = 'P0001'; end if;
  if p_rate is null or p_rate <= 0 then raise exception 'Enter a valid exchange rate (base currency per 1 %).', e.currency using errcode = 'P0001'; end if;
  perform set_config('finance.allow_edit', '1', true);
  if e.source_type in ('invoice_payment', 'bill_payment') then
    v_is_ar := e.source_type = 'invoice_payment';
    v_ctrl := finance_sys_account(uid, case when v_is_ar then 'ar' else 'ap' end);
    v_fx := finance_sys_account(uid, 'fx_gain_loss');
    select * into v_pos from finance_doc_position(uid, v_ctrl, e.source_id, e.entry_no);
    if v_pos.any_missing then
      raise exception 'Resolve the exchange rate on the earlier entries of this invoice/bill first.' using errcode = 'P0001';
    end if;
    v_open_native := case when v_is_ar then v_pos.native else -v_pos.native end;
    v_open_base := case when v_is_ar then v_pos.base else -v_pos.base end;
    select id, debit + credit into v_ctrl_line, v_amt from journal_lines where entry_id = e.id and account_id = v_ctrl limit 1;
    select id into v_cash_line from journal_lines where entry_id = e.id and account_id <> v_ctrl and (debit <> 0 or credit <> 0) limit 1;
    v_bank_base := round(v_amt * p_rate, 2);
    v_release := case when v_open_native <= 0.005 then v_bank_base
                      when abs(v_amt - v_open_native) <= 0.005 then v_open_base
                      else round(v_open_base * v_amt / v_open_native, 2) end;
    update journal_lines set base_debit = case when debit > 0 then v_release else 0 end,
                             base_credit = case when credit > 0 then v_release else 0 end where id = v_ctrl_line;
    update journal_lines set base_debit = case when debit > 0 then v_bank_base else 0 end,
                             base_credit = case when credit > 0 then v_bank_base else 0 end where id = v_cash_line;
    v_diff := v_bank_base - v_release;
    if v_diff <> 0 then
      select coalesce(max(line_no), 0) + 1 into v_next from journal_lines where entry_id = e.id;
      insert into journal_lines (entry_id, user_id, line_no, account_id, currency, debit, credit, base_debit, base_credit, memo)
      values (e.id, uid, v_next, v_fx, e.currency, 0, 0,
              case when (v_is_ar and v_diff < 0) or (not v_is_ar and v_diff > 0) then abs(v_diff) else 0 end,
              case when (v_is_ar and v_diff > 0) or (not v_is_ar and v_diff < 0) then abs(v_diff) else 0 end,
              'Realized FX gain/loss');
    end if;
  else
    update journal_lines set base_debit = round(debit * p_rate, 2), base_credit = round(credit * p_rate, 2) where entry_id = e.id;
  end if;
  update journal_entries set fx_rate = p_rate, fx_rate_date = coalesce(p_rate_date, e.entry_date),
    fx_source = coalesce(nullif(p_source, ''), 'manual (entered later)'), fx_status = 'ok' where id = e.id;
  perform set_config('finance.allow_edit', '0', true);
  perform finance_fix_base_rounding(e.id);
  perform finance_assert_entry_balanced(e.id);
  perform finance_audit(uid, 'fx_resolved', 'journal_entry', e.id, jsonb_build_object('fx_status', 'missing'),
    jsonb_build_object('rate', p_rate, 'rate_date', p_rate_date, 'source', p_source));
end
$$;

-- ---------------------------------------------------------------------------
-- Legacy backfill
-- ---------------------------------------------------------------------------
create or replace function public.finance_backfill_user(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare inv record; ex record;
begin
  perform finance_init_user(p_user);
  -- Only the latest document of a chain counts (matches how the app always reported revenue).
  for inv in
    select i.id from invoices i
    where i.user_id = p_user
      and not exists (select 1 from invoices x where x.converted_from_id = i.id)
      and not exists (select 1 from journal_entries e where e.user_id = p_user and e.source_id = i.id and e.source_type = 'invoice')
    order by i.created_at
  loop
    perform finance_post_invoice(inv.id, true);
    perform finance_post_row_payment(inv.id, true);
  end loop;
  for ex in
    select id from expenses where user_id = p_user and journal_entry_id is null and bill_id is null order by created_at
  loop
    perform finance_post_expense(ex.id, true);
    perform set_config('finance.rpc', '1', true);
    update expenses set is_legacy = true where id = ex.id;
    perform set_config('finance.rpc', '0', true);
  end loop;
end
$$;

-- Only possible while the ledger holds nothing but legacy-derived entries:
-- it throws those away and rebuilds them from the source invoices/expenses in the new base.
create or replace function public.finance_set_base_currency(p_new text)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := finance_require_user(); v_new text := upper(coalesce(p_new, ''));
begin
  perform finance_init_user(uid);
  if v_new !~ '^[A-Z]{3}$' then raise exception 'Enter a 3-letter currency code.' using errcode = 'P0001'; end if;
  if exists (select 1 from journal_entries where user_id = uid and not is_legacy) then
    raise exception 'The base currency can no longer be changed: new-style transactions are already in the ledger.' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtext('finance:' || uid::text));
  perform set_config('finance.allow_purge', '1', true);
  update expenses set journal_entry_id = null where user_id = uid;
  delete from invoice_payments where user_id = uid;
  delete from journal_lines where user_id = uid;
  delete from journal_entries where user_id = uid;
  perform set_config('finance.allow_purge', '0', true);
  update finance_settings set base_currency = v_new where user_id = uid;
  perform finance_backfill_user(uid);
  perform finance_audit(uid, 'set_base_currency', 'finance_settings', null, null, jsonb_build_object('base_currency', v_new));
end
$$;

-- ---------------------------------------------------------------------------
-- Triggers on existing tables (created after the table changes above)
-- ---------------------------------------------------------------------------
drop trigger if exists trg_finance_invoice_after_insert on invoices;
create trigger trg_finance_invoice_after_insert after insert on invoices
  for each row execute function public.finance_invoice_after_insert();
drop trigger if exists trg_finance_invoice_guard on invoices;
create trigger trg_finance_invoice_guard before update on invoices
  for each row execute function public.finance_invoice_guard();
drop trigger if exists trg_finance_invoice_after_update on invoices;
create trigger trg_finance_invoice_after_update after update on invoices
  for each row execute function public.finance_invoice_after_update();
drop trigger if exists trg_finance_invoice_before_delete on invoices;
create trigger trg_finance_invoice_before_delete before delete on invoices
  for each row execute function public.finance_invoice_before_delete();

drop trigger if exists trg_finance_expense_after_insert on expenses;
create trigger trg_finance_expense_after_insert after insert on expenses
  for each row execute function public.finance_expense_after_insert();
drop trigger if exists trg_finance_expense_guard on expenses;
create trigger trg_finance_expense_guard before update on expenses
  for each row execute function public.finance_expense_guard();
drop trigger if exists trg_finance_expense_after_update on expenses;
create trigger trg_finance_expense_after_update after update on expenses
  for each row execute function public.finance_expense_after_update();
drop trigger if exists trg_finance_expense_before_delete on expenses;
create trigger trg_finance_expense_before_delete before delete on expenses
  for each row execute function public.finance_expense_before_delete();

-- ---------------------------------------------------------------------------
-- One-time backfill for every user who already has invoices or expenses.
-- Nothing is deleted. Entries are flagged is_legacy; foreign-currency legacy
-- amounts get fx_status = 'missing' (no historical rates exist to justify one).
-- ---------------------------------------------------------------------------
do $$
declare u uuid;
begin
  for u in select user_id from invoices union select user_id from expenses loop
    perform finance_backfill_user(u);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Privileges: internal functions are not callable by clients.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'finance\_%'
      and p.proname not in (
        'finance_init', 'finance_create_bank_account', 'finance_update_bank_account', 'finance_record_transfer',
        'finance_reconcile', 'finance_record_invoice_payment', 'finance_void_invoice_payment', 'finance_save_bill',
        'finance_approve_bill', 'finance_record_bill_payment', 'finance_void_bill_payment', 'finance_void_bill',
        'finance_bill_pending_shots', 'finance_post_manual_entry', 'finance_void_manual_entry',
        'finance_set_entry_fx', 'finance_set_base_currency')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
  end loop;
  for r in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
        'finance_init', 'finance_create_bank_account', 'finance_update_bank_account', 'finance_record_transfer',
        'finance_reconcile', 'finance_record_invoice_payment', 'finance_void_invoice_payment', 'finance_save_bill',
        'finance_approve_bill', 'finance_record_bill_payment', 'finance_void_bill_payment', 'finance_void_bill',
        'finance_bill_pending_shots', 'finance_post_manual_entry', 'finance_void_manual_entry',
        'finance_set_entry_fx', 'finance_set_base_currency')
  loop
    execute format('revoke all on function %s from public, anon', r.sig);
    execute format('grant execute on function %s to authenticated', r.sig);
  end loop;
end
$$;
