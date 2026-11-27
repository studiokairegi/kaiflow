-- Finance V3, Phase 2 (migration 2 of 3): posting engine and database-enforced invariants.
--
-- Invariants enforced here (architecture 3.4):
--   1. A posted entry balances: per currency in native amounts, and in base amounts when all lines have them.
--      Enforced by DEFERRED constraint triggers, so even raw SQL cannot commit an unbalanced posted entry.
--   2. Posted entries and their lines cannot be updated or deleted by any role (V3002). Corrections are reversals.
--   3. events, fx_rates and audit_log are append-only.
--   4. Accounts that have postings cannot change code/type or be deleted; system accounts are protected.
--   5. Posting is only possible through finance_v3.post_event / finalize_entry, which are not granted to any client role.
-- Rollback: supabase/rollback/20270113091000_finance_v3_posting_engine.rollback.sql

begin;

insert into finance_v3.schema_version (version, notes)
values ('20270113091000', 'phase 2 migration 2: posting engine, balancing and immutability triggers')
on conflict (version) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- Small helpers
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.write_audit(
  p_org uuid, p_actor uuid, p_action text, p_object_type text, p_object_id text,
  p_before jsonb, p_after jsonb, p_reason text)
returns void
language sql security definer
set search_path = pg_catalog, finance_v3
as $$
  insert into finance_v3.audit_log (organization_id, actor, action, object_type, object_id, before, after, reason)
  values (p_org, p_actor, p_action, p_object_type, p_object_id, p_before, p_after, p_reason);
$$;

-- Projects are legacy records without a foreign key (V3 adds no coupling to legacy tables, D-07). A project belongs
-- to an organization when its owner is mapped to that organization in studio_data_owners.
create or replace function finance_v3.project_in_org(p_org uuid, p_project uuid)
returns boolean
language sql stable security definer
set search_path = pg_catalog, finance_v3
as $$
  select exists (
    select 1 from public.projects p
      join public.studio_data_owners o on o.user_id = p.user_id
     where p.id = p_project and o.organization_id = p_org);
$$;

create or replace function finance_v3.assert_org_ready(p_org uuid)
returns finance_v3.org_settings
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare s finance_v3.org_settings;
begin
  select * into s from finance_v3.org_settings where organization_id = p_org;
  if not found then
    raise exception 'Finance has not been set up for this studio yet.' using errcode = 'V3022';
  end if;
  return s;
end;
$$;

-- Serializes all posting for one organization and, with the counter row, gives gapless entry numbers.
create or replace function finance_v3.lock_org(p_org uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  perform 1 from finance_v3.org_settings where organization_id = p_org for update;
  if not found then
    raise exception 'Finance has not been set up for this studio yet.' using errcode = 'V3022';
  end if;
end;
$$;

-- Rate lookup: newest version of the rate for the exact date, or (when the organization allows a lookback) the most
-- recent earlier date inside the window. Returns no row when nothing qualifies: the caller flags 'missing'.
create or replace function finance_v3.resolve_fx(p_org uuid, p_from text, p_to text, p_date date, p_lookback integer)
returns table (rate numeric, rate_date date, source text)
language sql stable security definer
set search_path = pg_catalog, finance_v3
as $$
  select r.rate, r.rate_date, r.source
    from finance_v3.fx_rates r
   where r.organization_id = p_org and r.from_currency = p_from and r.to_currency = p_to
     and r.rate_date <= p_date and r.rate_date >= p_date - p_lookback
     and r.version = (select max(v.version) from finance_v3.fx_rates v
                       where v.organization_id = r.organization_id and v.from_currency = r.from_currency
                         and v.to_currency = r.to_currency and v.rate_date = r.rate_date)
   order by r.rate_date desc
   limit 1;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Line validation and normalization. Amounts MUST be decimal strings (never JSON numbers, never floats).
-- Returns a jsonb array of {line_no, account_id, side, amount, currency, project_id, memo} with canonical amounts.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.normalize_lines(p_org uuid, p_lines jsonb, p_min_lines integer)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  e        jsonb;
  ord      bigint;
  v_out    jsonb := '[]'::jsonb;
  v_acct   finance_v3.accounts;
  v_key    text;
  v_amt    text;
  v_ccy    text;
  v_minor  smallint;
  v_side   text;
  v_proj   uuid;
  v_memo   text;
  v_count  integer;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Lines must be a list.' using errcode = 'V3011';
  end if;
  v_count := jsonb_array_length(p_lines);
  if v_count > 500 then raise exception 'An entry can have at most 500 lines.' using errcode = 'V3011'; end if;
  if v_count < p_min_lines then
    raise exception 'An entry needs at least % lines.', p_min_lines using errcode = 'V3011';
  end if;

  for e, ord in select value, ordinality from jsonb_array_elements(p_lines) with ordinality loop
    if jsonb_typeof(e) <> 'object' then
      raise exception 'Line % is not an object.', ord using errcode = 'V3011';
    end if;
    select k into v_key from jsonb_object_keys(e) k
     where k not in ('account_id', 'account_code', 'side', 'amount', 'currency', 'project_id', 'memo') limit 1;
    if v_key is not null then
      raise exception 'Line % has an unknown field "%".', ord, v_key using errcode = 'V3011';
    end if;

    -- account
    if (e ? 'account_id') = (e ? 'account_code') then
      raise exception 'Line % needs exactly one of account_id or account_code.', ord using errcode = 'V3011';
    end if;
    if e ? 'account_id' then
      if jsonb_typeof(e -> 'account_id') <> 'string'
         or (e ->> 'account_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'Line % has an invalid account_id.', ord using errcode = 'V3009';
      end if;
      select * into v_acct from finance_v3.accounts a
       where a.organization_id = p_org and a.id = (e ->> 'account_id')::uuid;
    else
      select * into v_acct from finance_v3.accounts a
       where a.organization_id = p_org and a.code = (e ->> 'account_code');
    end if;
    if v_acct.id is null then
      raise exception 'Line % uses an account that does not exist in this studio.', ord using errcode = 'V3009';
    end if;
    if not v_acct.is_active then
      raise exception 'Line % uses the inactive account % %.', ord, v_acct.code, v_acct.name using errcode = 'V3009';
    end if;
    if not v_acct.is_postable then
      raise exception 'Line % uses account % %, which is a heading and cannot be posted to.', ord, v_acct.code, v_acct.name
        using errcode = 'V3009';
    end if;

    -- side
    v_side := e ->> 'side';
    if v_side is null or v_side not in ('debit', 'credit') then
      raise exception 'Line % needs a side of debit or credit.', ord using errcode = 'V3011';
    end if;

    -- currency and amount (a decimal string, at most the currency''s minor-unit decimals)
    if jsonb_typeof(e -> 'currency') is distinct from 'string' then
      raise exception 'Line % needs a currency code.', ord using errcode = 'V3011';
    end if;
    v_ccy := e ->> 'currency';
    select c.minor_unit into v_minor from finance_v3.currencies c where c.code = v_ccy and c.is_active;
    if v_minor is null then
      raise exception 'Line % uses an unsupported currency "%".', ord, v_ccy using errcode = 'V3011';
    end if;
    if v_acct.currency is not null and v_acct.currency <> v_ccy then
      raise exception 'Line %: account % only accepts %, not %.', ord, v_acct.code, v_acct.currency, v_ccy using errcode = 'V3008';
    end if;
    if jsonb_typeof(e -> 'amount') is distinct from 'string' then
      raise exception 'Line % amount must be a decimal string such as "1234.50".', ord using errcode = 'V3011';
    end if;
    v_amt := e ->> 'amount';
    if v_amt !~ '^(0|[1-9][0-9]{0,14})(\.[0-9]{1,4})?$' then
      raise exception 'Line % has an invalid amount.', ord using errcode = 'V3011';
    end if;
    if v_amt::numeric <= 0 then
      raise exception 'Line % amount must be greater than zero.', ord using errcode = 'V3011';
    end if;
    if length(split_part(v_amt, '.', 2)) > v_minor then
      raise exception 'Line %: % allows at most % decimal places.', ord, v_ccy, v_minor using errcode = 'V3011';
    end if;

    -- optional project and memo
    v_proj := null;
    if e ? 'project_id' and jsonb_typeof(e -> 'project_id') <> 'null' then
      if jsonb_typeof(e -> 'project_id') <> 'string'
         or (e ->> 'project_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'Line % has an invalid project_id.', ord using errcode = 'V3011';
      end if;
      v_proj := (e ->> 'project_id')::uuid;
      if not finance_v3.project_in_org(p_org, v_proj) then
        raise exception 'Line % refers to a project that is not part of this studio.', ord using errcode = 'V3011';
      end if;
    end if;
    v_memo := null;
    if e ? 'memo' and jsonb_typeof(e -> 'memo') <> 'null' then
      if jsonb_typeof(e -> 'memo') <> 'string' or char_length(e ->> 'memo') > 200 then
        raise exception 'Line % memo must be text of at most 200 characters.', ord using errcode = 'V3011';
      end if;
      v_memo := e ->> 'memo';
    end if;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'line_no', ord, 'account_id', v_acct.id, 'side', v_side,
      'amount', (v_amt::numeric(19,4))::text, 'currency', v_ccy,
      'project_id', v_proj, 'memo', v_memo));
    v_acct := null;
  end loop;
  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Guard triggers
-- ---------------------------------------------------------------------------------------------------------------

-- Accounts: protect system accounts and accounts that already have postings.
create or replace function finance_v3.tg_guard_accounts()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_used   boolean;
  v_parent finance_v3.accounts;
  v_cursor uuid;
  v_depth  integer := 0;
begin
  if tg_op = 'DELETE' then
    if old.is_system then
      raise exception 'System account % cannot be deleted.', old.code using errcode = 'V3009';
    end if;
    if exists (select 1 from finance_v3.journal_lines l where l.organization_id = old.organization_id and l.account_id = old.id) then
      raise exception 'Account % has postings and cannot be deleted. Deactivate it instead.', old.code using errcode = 'V3009';
    end if;
    return old;
  end if;

  if new.parent_id is not null then
    if tg_op = 'UPDATE' and new.parent_id = new.id then
      raise exception 'An account cannot be its own parent.' using errcode = 'V3009';
    end if;
    select * into v_parent from finance_v3.accounts p where p.organization_id = new.organization_id and p.id = new.parent_id;
    if v_parent.account_type is distinct from new.account_type then
      raise exception 'A parent account must have the same type as its child.' using errcode = 'V3009';
    end if;
    if tg_op = 'UPDATE' then
      v_cursor := new.parent_id;
      while v_cursor is not null and v_depth < 50 loop
        if v_cursor = new.id then
          raise exception 'Account hierarchy cannot contain a cycle.' using errcode = 'V3009';
        end if;
        select p.parent_id into v_cursor from finance_v3.accounts p where p.organization_id = new.organization_id and p.id = v_cursor;
        v_depth := v_depth + 1;
      end loop;
    end if;
  end if;

  if tg_op = 'UPDATE' then
    if new.id <> old.id or new.organization_id <> old.organization_id then
      raise exception 'An account cannot be moved to another studio.' using errcode = 'V3009';
    end if;
    if old.is_system then
      if new.code <> old.code or new.account_type <> old.account_type
         or new.system_key is distinct from old.system_key or new.is_system <> old.is_system then
        raise exception 'System account % cannot change its code, type or role.', old.code using errcode = 'V3009';
      end if;
      if not new.is_active then
        raise exception 'System account % cannot be deactivated.', old.code using errcode = 'V3009';
      end if;
    end if;
    if new.code <> old.code or new.account_type <> old.account_type
       or new.currency is distinct from old.currency or (old.is_postable and not new.is_postable) then
      select exists (select 1 from finance_v3.journal_lines l
                      where l.organization_id = old.organization_id and l.account_id = old.id) into v_used;
      if v_used then
        raise exception 'Account % has postings; its code, type, currency and posting status can no longer change.', old.code
          using errcode = 'V3009';
      end if;
    end if;
    new.updated_at := now();
  end if;
  return new;
end;
$$;
drop trigger if exists tg_guard_accounts on finance_v3.accounts;
create trigger tg_guard_accounts before insert or update or delete on finance_v3.accounts
  for each row execute function finance_v3.tg_guard_accounts();

-- Organization settings: the entry counter only moves forward; base currency is fixed once the ledger has real entries.
create or replace function finance_v3.tg_guard_org_settings()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  if new.organization_id <> old.organization_id then
    raise exception 'Finance settings cannot be moved to another studio.' using errcode = 'V3011';
  end if;
  if new.last_entry_no < old.last_entry_no then
    raise exception 'The entry counter cannot move backwards.' using errcode = 'V3002';
  end if;
  if new.base_currency <> old.base_currency and exists (
       select 1 from finance_v3.journal_entries je
         left join finance_v3.events ev on ev.id = je.event_id
        where je.organization_id = old.organization_id and je.status = 'posted' and ev.kind is distinct from 'legacy_import') then
    raise exception 'The base currency cannot change after entries have been posted.' using errcode = 'V3024';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists tg_guard_org_settings on finance_v3.org_settings;
create trigger tg_guard_org_settings before update on finance_v3.org_settings
  for each row execute function finance_v3.tg_guard_org_settings();

-- Journal entries: a posted entry is frozen forever (V3002).
create or replace function finance_v3.tg_guard_entries()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  if old.status = 'posted' then
    raise exception 'Posted entry % cannot be changed or deleted. Reverse it instead.', old.entry_no using errcode = 'V3002';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if new.id <> old.id or new.organization_id <> old.organization_id then
    raise exception 'An entry cannot be moved to another studio.' using errcode = 'V3002';
  end if;
  return new;
end;
$$;
drop trigger if exists tg_guard_entries on finance_v3.journal_entries;
create trigger tg_guard_entries before update or delete on finance_v3.journal_entries
  for each row execute function finance_v3.tg_guard_entries();

-- Journal lines: lines may only be inserted, changed or removed while their entry is still a draft.
create or replace function finance_v3.tg_guard_lines()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_status text;
  v_entry  uuid := case when tg_op = 'INSERT' then new.entry_id else old.entry_id end;
begin
  select je.status into v_status from finance_v3.journal_entries je where je.id = v_entry;
  -- v_status is null only while the parent draft is being deleted (cascade); that is allowed.
  if v_status = 'posted' then
    raise exception 'Lines of a posted entry cannot be added, changed or deleted. Reverse the entry instead.' using errcode = 'V3002';
  end if;
  if tg_op = 'UPDATE' and (new.entry_id <> old.entry_id or new.organization_id <> old.organization_id) then
    raise exception 'A line cannot be moved to another entry.' using errcode = 'V3002';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists tg_guard_lines on finance_v3.journal_lines;
create trigger tg_guard_lines before insert or update or delete on finance_v3.journal_lines
  for each row execute function finance_v3.tg_guard_lines();

-- Append-only tables.
create or replace function finance_v3.tg_append_only()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  raise exception '% is append-only; rows cannot be updated or deleted.', tg_table_name using errcode = 'V3002';
end;
$$;
drop trigger if exists tg_append_only on finance_v3.events;
create trigger tg_append_only before update or delete on finance_v3.events
  for each row execute function finance_v3.tg_append_only();
drop trigger if exists tg_append_only on finance_v3.fx_rates;
create trigger tg_append_only before update or delete on finance_v3.fx_rates
  for each row execute function finance_v3.tg_append_only();
drop trigger if exists tg_append_only on finance_v3.audit_log;
create trigger tg_append_only before update or delete on finance_v3.audit_log
  for each row execute function finance_v3.tg_append_only();

create or replace function finance_v3.tg_no_truncate()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  raise exception 'TRUNCATE is not allowed on %.', tg_table_name using errcode = 'V3002';
end;
$$;
do $$
declare t text;
begin
  foreach t in array array['journal_entries', 'journal_lines', 'events', 'fx_rates', 'audit_log'] loop
    execute format('drop trigger if exists tg_no_truncate on finance_v3.%I', t);
    execute format('create trigger tg_no_truncate before truncate on finance_v3.%I for each statement execute function finance_v3.tg_no_truncate()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Deferred integrity check (invariants 1, 6 and the FX shape rules). Runs at COMMIT for every posted entry touched.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.assert_entry_integrity(p_entry uuid)
returns void
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  h        finance_v3.journal_entries;
  n        integer;
  n_null   integer;
  n_nobase integer;
  v_bad    text;
  d        numeric;
  c        numeric;
  v_derived text;
begin
  select * into h from finance_v3.journal_entries je where je.id = p_entry;
  if not found or h.status <> 'posted' then return; end if;

  select count(*), count(*) filter (where fx_status is null), count(*) filter (where amount_base is null)
    into n, n_null, n_nobase
    from finance_v3.journal_lines l where l.entry_id = p_entry;
  if n < 2 then
    raise exception 'A posted entry needs at least two lines.' using errcode = 'V3001';
  end if;
  if n_null > 0 then
    raise exception 'A posted entry cannot have lines without a currency conversion status.' using errcode = 'V3001';
  end if;

  select l.currency into v_bad
    from finance_v3.journal_lines l where l.entry_id = p_entry
   group by l.currency
  having sum(case when l.side = 'debit' then l.amount_native else -l.amount_native end) <> 0
   limit 1;
  if v_bad is not null then
    raise exception 'Total debits and total credits are not equal in %.', v_bad using errcode = 'V3001';
  end if;

  if exists (select 1 from finance_v3.journal_lines l
              where l.entry_id = p_entry and (l.fx_status = 'native') is distinct from (l.currency = h.base_currency)) then
    raise exception 'Currency conversion status does not match the base currency.' using errcode = 'V3001';
  end if;

  select case when bool_or(fx_status = 'missing') then 'missing'
              when bool_or(fx_status = 'estimate') then 'estimate'
              when bool_or(fx_status = 'converted') then 'converted'
              else 'native' end
    into v_derived from finance_v3.journal_lines l where l.entry_id = p_entry;
  if v_derived is distinct from h.fx_status then
    raise exception 'Entry currency status (%) does not match its lines (%).', h.fx_status, v_derived using errcode = 'V3001';
  end if;

  if n_nobase = 0 then
    select coalesce(sum(amount_base) filter (where side = 'debit'), 0), coalesce(sum(amount_base) filter (where side = 'credit'), 0)
      into d, c from finance_v3.journal_lines l where l.entry_id = p_entry;
    if d <> c then
      raise exception 'Total debits and total credits are not equal in the base currency (% vs %).', d, c using errcode = 'V3001';
    end if;
  end if;
end;
$$;

create or replace function finance_v3.tg_check_entry_integrity()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare v_entry uuid;
begin
  if tg_table_name = 'journal_entries' then
    v_entry := coalesce(new.id, old.id);
  else
    v_entry := coalesce(new.entry_id, old.entry_id);
  end if;
  perform finance_v3.assert_entry_integrity(v_entry);
  return null;
end;
$$;
drop trigger if exists tg_check_integrity_entries on finance_v3.journal_entries;
create constraint trigger tg_check_integrity_entries after insert or update on finance_v3.journal_entries
  deferrable initially deferred for each row execute function finance_v3.tg_check_entry_integrity();
drop trigger if exists tg_check_integrity_lines on finance_v3.journal_lines;
create constraint trigger tg_check_integrity_lines after insert or update or delete on finance_v3.journal_lines
  deferrable initially deferred for each row execute function finance_v3.tg_check_entry_integrity();

-- ---------------------------------------------------------------------------------------------------------------
-- Authorization for posting a kind of event
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.authorize_event_kind(p_org uuid, p_kind text, p_has_provider boolean)
returns uuid
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  k      finance_v3.event_kinds;
  v_uid  uuid := auth.uid();
begin
  select * into k from finance_v3.event_kinds ek where ek.kind = p_kind;
  if not found or not k.is_enabled then
    raise exception 'Event kind "%" is not available.', p_kind using errcode = 'V3011';
  end if;
  if v_uid is null then
    -- System context: only a verified external event for a provider-capable kind. A provider can never create
    -- arbitrary journal entries; the internal Finance operation that calls this decides the lines.
    if not (k.allows_provider and p_has_provider) then
      raise exception 'Only a verified external event may be posted without a signed-in user.' using errcode = 'V3005';
    end if;
    return null;
  end if;
  if not finance_v3.has_permission_for(v_uid, p_org, k.required_permission) then
    raise exception 'You are not allowed to post this kind of entry in this studio.' using errcode = 'V3005';
  end if;
  return v_uid;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- finalize_entry: turns a DRAFT entry into a POSTED one. Resolves FX, derives base amounts with rounding, checks the
-- period lock and balance, assigns the gapless entry number. The caller must hold lock_org(org).
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.finalize_entry(p_entry uuid, p_event uuid, p_actor uuid)
returns bigint
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  h        finance_v3.journal_entries;
  s        finance_v3.org_settings;
  v_minor  smallint;
  v_ccy    text;
  fx       record;
  n        integer;
  v_bad    text;
  d        numeric;
  c        numeric;
  r        numeric;
  v_line   uuid;
  v_adj    numeric;
  v_side   text;
  v_no     bigint;
  v_status text;
  v_any_missing boolean;
begin
  select * into h from finance_v3.journal_entries je where je.id = p_entry for update;
  if not found then raise exception 'Entry not found.' using errcode = 'V3010'; end if;
  if h.status <> 'draft' then
    raise exception 'Entry is not a draft and cannot be posted again.' using errcode = 'V3023';
  end if;
  select * into s from finance_v3.org_settings os where os.organization_id = h.organization_id;

  if s.period_lock_date is not null and h.accounting_date <= s.period_lock_date then
    raise exception 'The period up to % is locked. Choose a later accounting date.', s.period_lock_date using errcode = 'V3006';
  end if;

  select count(*) into n from finance_v3.journal_lines l where l.entry_id = p_entry;
  if n < 2 then raise exception 'An entry needs at least two lines.' using errcode = 'V3001'; end if;
  select l.currency into v_bad
    from finance_v3.journal_lines l where l.entry_id = p_entry
   group by l.currency
  having sum(case when l.side = 'debit' then l.amount_native else -l.amount_native end) <> 0
   limit 1;
  if v_bad is not null then
    raise exception 'Total debits and total credits are not equal in %. Every currency must balance by itself; record a foreign amount against a clearing or account of its own currency.', v_bad using errcode = 'V3001';
  end if;

  -- A draft may have been saved before one of its accounts was deactivated or turned into a heading.
  select a.code into v_bad from finance_v3.journal_lines l
    join finance_v3.accounts a on a.organization_id = l.organization_id and a.id = l.account_id
   where l.entry_id = p_entry and (not a.is_active or not a.is_postable) limit 1;
  if v_bad is not null then
    raise exception 'Account % can no longer be posted to (inactive or a heading). Edit the draft to use another account.', v_bad
      using errcode = 'V3009';
  end if;

  select cu.minor_unit into v_minor from finance_v3.currencies cu where cu.code = s.base_currency;

  -- Lines in the base currency are exact.
  update finance_v3.journal_lines l
     set fx_status = 'native', fx_rate = 1, fx_rate_date = null, fx_source = null,
         amount_base = l.amount_native, base_rounding_adjustment = 0
   where l.entry_id = p_entry and l.currency = s.base_currency;

  -- Foreign lines use the stored rate for the accounting date; a missing rate is flagged, never guessed.
  for v_ccy in select distinct l.currency from finance_v3.journal_lines l
                where l.entry_id = p_entry and l.currency <> s.base_currency loop
    select * into fx from finance_v3.resolve_fx(h.organization_id, v_ccy, s.base_currency, h.accounting_date, s.fx_lookback_days);
    if fx.rate is null then
      update finance_v3.journal_lines l
         set fx_status = 'missing', fx_rate = null, fx_rate_date = null, fx_source = null,
             amount_base = null, base_rounding_adjustment = 0
       where l.entry_id = p_entry and l.currency = v_ccy;
    else
      if exists (select 1 from finance_v3.journal_lines l
                  where l.entry_id = p_entry and l.currency = v_ccy and abs(l.amount_native * fx.rate) >= 1000000000000000::numeric) then
        raise exception 'An amount is too large to convert from % to % at the rate for this date.', v_ccy, s.base_currency
          using errcode = 'V3011';
      end if;
      update finance_v3.journal_lines l
         set fx_status = 'converted', fx_rate = fx.rate, fx_rate_date = fx.rate_date, fx_source = fx.source,
             amount_base = round(l.amount_native * fx.rate, v_minor), base_rounding_adjustment = 0
       where l.entry_id = p_entry and l.currency = v_ccy;
    end if;
  end loop;

  select bool_or(l.fx_status = 'missing') into v_any_missing from finance_v3.journal_lines l where l.entry_id = p_entry;

  -- Independent per-line rounding can leave a residue of a few minor units between base debits and credits.
  -- Put it on the largest converted line (recorded in base_rounding_adjustment) so the entry balances in base too.
  if not v_any_missing then
    select coalesce(sum(l.amount_base) filter (where l.side = 'debit'), 0),
           coalesce(sum(l.amount_base) filter (where l.side = 'credit'), 0)
      into d, c from finance_v3.journal_lines l where l.entry_id = p_entry;
    if d <> c then
      r := d - c;
      if abs(r) > n * 0.5 * power(10::numeric, -v_minor) + 0.0000001 then
        raise exception 'Currency conversion does not balance (difference %).', r using errcode = 'V3001';
      end if;
      v_side := case when r > 0 then 'credit' else 'debit' end;
      v_adj := abs(r);
      select l.id into v_line from finance_v3.journal_lines l
       where l.entry_id = p_entry and l.fx_status = 'converted' and l.side = v_side
       order by l.amount_base desc, l.line_no limit 1;
      if v_line is null then
        v_adj := -abs(r);
        select l.id into v_line from finance_v3.journal_lines l
         where l.entry_id = p_entry and l.fx_status = 'converted' and l.side <> v_side
         order by l.amount_base desc, l.line_no limit 1;
      end if;
      if v_line is null then
        raise exception 'Total debits and total credits are not equal in the base currency.' using errcode = 'V3001';
      end if;
      update finance_v3.journal_lines l
         set amount_base = l.amount_base + v_adj, base_rounding_adjustment = v_adj
       where l.id = v_line;
    end if;
  end if;

  select case when bool_or(l.fx_status = 'missing') then 'missing'
              when bool_or(l.fx_status = 'estimate') then 'estimate'
              when bool_or(l.fx_status = 'converted') then 'converted'
              else 'native' end
    into v_status from finance_v3.journal_lines l where l.entry_id = p_entry;

  update finance_v3.org_settings os set last_entry_no = os.last_entry_no + 1
   where os.organization_id = h.organization_id returning os.last_entry_no into v_no;

  update finance_v3.journal_entries je
     set status = 'posted', entry_no = v_no, event_id = p_event, base_currency = s.base_currency,
         fx_status = v_status, posted_by = p_actor, posted_at = now(), updated_at = now()
   where je.id = p_entry;
  return v_no;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- post_event: THE single posting entry point (D-06). Not granted to any client role; public.fin3_* RPCs and trusted
-- internal Finance operations call it. Atomic: event + entry + lines + audit commit together or not at all.
-- p_meta keys: memo, reference, project_id, provider, provider_ref.
-- Idempotent: the same (organization, key) with the same content returns the original entry; with different content it
-- raises V3021. The same (provider, provider_ref, kind) can never yield a second entry.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.post_event(
  p_org uuid, p_kind text, p_event_key text, p_accounting_date date, p_lines jsonb, p_meta jsonb default '{}'::jsonb)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_actor    uuid;
  v_meta     jsonb := coalesce(p_meta, '{}'::jsonb);
  v_key      text;
  v_memo     text;
  v_ref      text;
  v_proj     uuid;
  v_provider text;
  v_pref     text;
  v_norm     jsonb;
  v_payload  jsonb;
  v_hash     text;
  v_event    finance_v3.events;
  v_event_id uuid;
  v_entry    uuid;
  v_no       bigint;
begin
  if p_org is null or p_kind is null or p_event_key is null or p_accounting_date is null then
    raise exception 'Organization, kind, key and accounting date are required.' using errcode = 'V3011';
  end if;
  if jsonb_typeof(v_meta) <> 'object' then
    raise exception 'Meta must be an object.' using errcode = 'V3011';
  end if;
  select k into v_key from jsonb_object_keys(v_meta) k
   where k not in ('memo', 'reference', 'project_id', 'provider', 'provider_ref') limit 1;
  if v_key is not null then
    raise exception 'Unknown meta field "%".', v_key using errcode = 'V3011';
  end if;
  if char_length(p_event_key) not between 1 and 200 or p_event_key !~ '^[A-Za-z0-9_.:-]+$' then
    raise exception 'Invalid idempotency key.' using errcode = 'V3011';
  end if;
  if p_accounting_date not between date '1990-01-01' and current_date + 366 then
    raise exception 'The accounting date is out of range.' using errcode = 'V3011';
  end if;
  v_memo := nullif(btrim(v_meta ->> 'memo'), '');
  v_ref  := nullif(btrim(v_meta ->> 'reference'), '');
  v_provider := nullif(v_meta ->> 'provider', '');
  v_pref := nullif(v_meta ->> 'provider_ref', '');
  if (v_provider is null) <> (v_pref is null) then
    raise exception 'provider and provider_ref must be supplied together.' using errcode = 'V3011';
  end if;
  if char_length(v_memo) > 500 or char_length(v_ref) > 120 then
    raise exception 'Memo or reference is too long.' using errcode = 'V3011';
  end if;
  if nullif(v_meta ->> 'project_id', '') is not null then
    if (v_meta ->> 'project_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Invalid project_id.' using errcode = 'V3011';
    end if;
    v_proj := (v_meta ->> 'project_id')::uuid;
  end if;

  v_actor := finance_v3.authorize_event_kind(p_org, p_kind, v_provider is not null);
  perform finance_v3.lock_org(p_org);   -- serializes posting for this organization

  -- The request hash covers the request exactly as supplied (including provider and provider_ref), NOT the validated
  -- form: a retry of an already-processed request must return the original even if the chart of accounts or a project
  -- changed since (an account deactivated after the first call must not break an idempotent replay).
  v_hash := encode(sha256(convert_to(jsonb_build_object('kind', p_kind, 'accounting_date', p_accounting_date,
              'memo', v_memo, 'reference', v_ref, 'project_id', v_proj, 'provider', v_provider,
              'provider_ref', v_pref, 'lines', p_lines)::text, 'UTF8')), 'hex');

  -- Replay by idempotency key, then by provider reference.
  select * into v_event from finance_v3.events ev where ev.organization_id = p_org and ev.idempotency_key = p_event_key;
  if not found and v_provider is not null then
    select * into v_event from finance_v3.events ev
     where ev.organization_id = p_org and ev.provider = v_provider and ev.provider_ref = v_pref and ev.kind = p_kind;
  end if;
  if found then
    if v_event.request_hash <> v_hash or v_event.kind <> p_kind then
      raise exception 'This idempotency key or provider reference was already used for a different request.' using errcode = 'V3021';
    end if;
    select je.id into v_entry from finance_v3.journal_entries je where je.event_id = v_event.id;
    return v_entry;
  end if;

  if v_proj is not null and not finance_v3.project_in_org(p_org, v_proj) then
    raise exception 'The project is not part of this studio.' using errcode = 'V3011';
  end if;
  v_norm := finance_v3.normalize_lines(p_org, p_lines, 2);
  v_payload := jsonb_build_object('kind', p_kind, 'accounting_date', p_accounting_date, 'memo', v_memo,
                                  'reference', v_ref, 'project_id', v_proj, 'provider', v_provider,
                                  'provider_ref', v_pref, 'lines', v_norm);

  insert into finance_v3.events (organization_id, kind, idempotency_key, request_hash, accounting_date,
                                 provider, provider_ref, actor, payload)
  values (p_org, p_kind, p_event_key, v_hash, p_accounting_date, v_provider, v_pref, v_actor, v_payload)
  returning id into v_event_id;

  insert into finance_v3.journal_entries (organization_id, accounting_date, memo, reference, project_id, created_by)
  values (p_org, p_accounting_date, v_memo, v_ref, v_proj, v_actor)
  returning id into v_entry;

  insert into finance_v3.journal_lines (organization_id, entry_id, line_no, account_id, side, amount_native, currency, project_id, memo)
  select p_org, v_entry, x.line_no, x.account_id, x.side, x.amount::numeric, x.currency, x.project_id, x.memo
    from jsonb_to_recordset(v_norm) as x(line_no integer, account_id uuid, side text, amount text, currency text, project_id uuid, memo text);

  v_no := finance_v3.finalize_entry(v_entry, v_event_id, v_actor);

  perform finance_v3.write_audit(p_org, v_actor, 'post_entry', 'journal_entry', v_entry::text, null,
    jsonb_build_object('entry_no', v_no, 'kind', p_kind, 'accounting_date', p_accounting_date,
                       'event_id', v_event_id, 'provider', v_provider, 'provider_ref', v_pref), null);
  return v_entry;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- reverse_entry: posts a mirror of a posted entry (same accounts and native amounts, sides swapped, ORIGINAL base
-- amounts and FX facts; history is never re-rated). The original is not touched; "reversed" is derived from the link.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.reverse_entry(
  p_org uuid, p_entry uuid, p_key text, p_reason text, p_date date default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_actor   uuid;
  o         finance_v3.journal_entries;
  s         finance_v3.org_settings;
  v_date    date;
  v_reason  text := nullif(btrim(p_reason), '');
  v_hash    text;
  v_payload jsonb;
  v_event   finance_v3.events;
  v_event_id uuid;
  v_new     uuid;
  v_no      bigint;
begin
  if p_org is null or p_entry is null or p_key is null then
    raise exception 'Organization, entry and key are required.' using errcode = 'V3011';
  end if;
  if char_length(p_key) not between 1 and 200 or p_key !~ '^[A-Za-z0-9_.:-]+$' then
    raise exception 'Invalid idempotency key.' using errcode = 'V3011';
  end if;
  if v_reason is null or char_length(v_reason) > 500 then
    raise exception 'A reason (up to 500 characters) is required to reverse an entry.' using errcode = 'V3011';
  end if;
  v_actor := finance_v3.authorize_event_kind(p_org, 'reversal', false);
  perform finance_v3.lock_org(p_org);

  select * into o from finance_v3.journal_entries je where je.organization_id = p_org and je.id = p_entry;
  if not found then raise exception 'Entry not found.' using errcode = 'V3010'; end if;
  select * into s from finance_v3.org_settings os where os.organization_id = p_org;

  v_date := coalesce(p_date, greatest(current_date, o.accounting_date));
  v_payload := jsonb_build_object('kind', 'reversal', 'reverses_entry_id', p_entry, 'accounting_date', v_date, 'reason', v_reason);
  v_hash := encode(sha256(convert_to(v_payload::text, 'UTF8')), 'hex');

  select * into v_event from finance_v3.events ev where ev.organization_id = p_org and ev.idempotency_key = p_key;
  if found then
    if v_event.request_hash <> v_hash then
      raise exception 'This idempotency key was already used for a different request.' using errcode = 'V3021';
    end if;
    select je.id into v_new from finance_v3.journal_entries je where je.event_id = v_event.id;
    return v_new;
  end if;

  if o.status <> 'posted' then
    raise exception 'Only a posted entry can be reversed. Discard a draft instead.' using errcode = 'V3023';
  end if;
  if o.reverses_entry_id is not null then
    raise exception 'A reversal entry cannot itself be reversed. Post a new entry instead.' using errcode = 'V3011';
  end if;
  if exists (select 1 from finance_v3.journal_entries je where je.organization_id = p_org and je.reverses_entry_id = p_entry) then
    raise exception 'Entry % has already been reversed.', o.entry_no using errcode = 'V3020';
  end if;
  if v_date < o.accounting_date or v_date > current_date + 366 then
    raise exception 'The reversal date cannot be before the original entry date.' using errcode = 'V3011';
  end if;

  insert into finance_v3.events (organization_id, kind, idempotency_key, request_hash, accounting_date, actor, payload)
  values (p_org, 'reversal', p_key, v_hash, v_date, v_actor, v_payload)
  returning id into v_event_id;

  insert into finance_v3.journal_entries (organization_id, accounting_date, memo, reference, project_id,
                                          reverses_entry_id, reversal_reason, created_by)
  values (p_org, v_date, left('Reversal of entry ' || o.entry_no || ': ' || v_reason, 500), o.reference, o.project_id,
          p_entry, v_reason, v_actor)
  returning id into v_new;

  -- Mirror lines: sides swapped; native amounts, accounts and ORIGINAL base amounts / FX facts copied.
  insert into finance_v3.journal_lines (organization_id, entry_id, line_no, account_id, side, amount_native, currency,
                                        fx_status, fx_rate, fx_rate_date, fx_source, amount_base,
                                        base_rounding_adjustment, project_id, memo)
  select l.organization_id, v_new, l.line_no, l.account_id,
         case l.side when 'debit' then 'credit' else 'debit' end, l.amount_native, l.currency,
         l.fx_status, l.fx_rate, l.fx_rate_date, l.fx_source, l.amount_base,
         l.base_rounding_adjustment, l.project_id, l.memo
    from finance_v3.journal_lines l where l.entry_id = p_entry;

  if s.period_lock_date is not null and v_date <= s.period_lock_date then
    raise exception 'The period up to % is locked. Choose a later reversal date.', s.period_lock_date using errcode = 'V3006';
  end if;

  -- The mirrored lines already carry their FX facts, so finalize is replaced by a direct, checked transition.
  update finance_v3.org_settings os set last_entry_no = os.last_entry_no + 1
   where os.organization_id = p_org returning os.last_entry_no into v_no;
  update finance_v3.journal_entries je
     set status = 'posted', entry_no = v_no, event_id = v_event_id, base_currency = o.base_currency,
         fx_status = o.fx_status, posted_by = v_actor, posted_at = now(), updated_at = now()
   where je.id = v_new;

  perform finance_v3.write_audit(p_org, v_actor, 'reverse_entry', 'journal_entry', v_new::text,
    jsonb_build_object('reversed_entry_id', p_entry, 'reversed_entry_no', o.entry_no),
    jsonb_build_object('entry_no', v_no, 'accounting_date', v_date), v_reason);
  return v_new;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Privileges: no internal function is executable by any client role. (has_permission is re-granted for RLS.)
-- ---------------------------------------------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'finance_v3' loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', r.sig);
  end loop;
end $$;
grant execute on function finance_v3.has_permission(uuid, text) to authenticated;

commit;
