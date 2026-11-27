-- Finance V3, Phase 2 (migration 3 of 3): the public RPC surface (public.fin3_*).
--
-- These are the ONLY entry points for clients (D-01). Every function:
--   * is SECURITY DEFINER with a pinned search_path (D-16),
--   * requires a signed-in user and checks membership + the specific Finance permission (never trusts the payload),
--   * writes an audit row for every mutation,
--   * is granted to `authenticated` only (revoked from PUBLIC, anon and service_role).
-- No function here accepts a provider (Paystack/Resend) identity or posts an arbitrary provider-originated entry;
-- provider events reach the ledger only through finance_v3.post_event, called by an internal Finance operation (Phase 3).
-- Rollback: supabase/rollback/20270113092000_finance_v3_rpc_surface.rollback.sql

begin;

insert into finance_v3.schema_version (version, notes)
values ('20270113092000', 'phase 2 migration 3: public fin3_* RPC surface')
on conflict (version) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- JSON shaping helpers (amounts are always decimal strings)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.account_json(a finance_v3.accounts)
returns jsonb
language sql immutable
set search_path = pg_catalog, finance_v3
as $$
  select jsonb_build_object(
    'id', a.id, 'code', a.code, 'name', a.name, 'account_type', a.account_type,
    'normal_balance', a.normal_balance, 'description', a.description, 'parent_id', a.parent_id,
    'is_system', a.is_system, 'system_key', a.system_key, 'is_active', a.is_active,
    'is_postable', a.is_postable, 'currency', a.currency);
$$;

create or replace function finance_v3.settings_json(s finance_v3.org_settings)
returns jsonb
language sql immutable
set search_path = pg_catalog, finance_v3
as $$
  select jsonb_build_object(
    'organization_id', s.organization_id, 'base_currency', s.base_currency,
    'period_lock_date', s.period_lock_date, 'engine', s.engine, 'default_ui_mode', s.default_ui_mode,
    'fx_lookback_days', s.fx_lookback_days, 'last_entry_no', s.last_entry_no);
$$;

-- Default animation-studio chart of accounts for one organization. Idempotent; never overwrites edits.
create or replace function finance_v3.seed_chart(p_org uuid, p_base text, p_actor uuid)
returns integer
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare n1 integer; n2 integer;
begin
  insert into finance_v3.accounts (organization_id, code, name, account_type, description, is_system, system_key,
                                   is_postable, currency, created_by)
  select p_org, d.code, d.name, d.account_type, d.description, d.system_key is not null, d.system_key,
         d.is_postable, case when d.currency_is_base then p_base end, p_actor
    from finance_v3.default_chart d where d.parent_code is null order by d.sort_order
  on conflict (organization_id, code) do nothing;
  get diagnostics n1 = row_count;
  insert into finance_v3.accounts (organization_id, code, name, account_type, description, is_system, system_key,
                                   is_postable, currency, parent_id, created_by)
  select p_org, d.code, d.name, d.account_type, d.description, d.system_key is not null, d.system_key,
         d.is_postable, case when d.currency_is_base then p_base end,
         (select a.id from finance_v3.accounts a where a.organization_id = p_org and a.code = d.parent_code), p_actor
    from finance_v3.default_chart d where d.parent_code is not null order by d.sort_order
  on conflict (organization_id, code) do nothing;
  get diagnostics n2 = row_count;
  return n1 + n2;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Organization setup and settings
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fin3_init_organization(p_org uuid, p_base_currency text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid  uuid := finance_v3.assert_permission(p_org, 'finance.admin');
  v_ccy  text := upper(btrim(p_base_currency));
  s      finance_v3.org_settings;
  v_new  boolean := false;
  v_seeded integer := 0;
begin
  -- The base currency must be chosen explicitly (architecture 5.3): no silent default.
  if v_ccy is null or not exists (select 1 from finance_v3.currencies c where c.code = v_ccy and c.is_active) then
    raise exception 'Choose a supported base currency (for example KES, USD, EUR or GBP).' using errcode = 'V3011';
  end if;
  insert into finance_v3.org_settings (organization_id, base_currency, created_by)
  values (p_org, v_ccy, v_uid)
  on conflict (organization_id) do nothing
  returning * into s;
  v_new := found;
  if not v_new then
    select * into s from finance_v3.org_settings os where os.organization_id = p_org;
    if s.base_currency <> v_ccy then
      raise exception 'Finance is already set up with base currency %. Use fin3_set_base_currency to change it while the ledger is empty.', s.base_currency
        using errcode = 'V3011';
    end if;
  end if;
  v_seeded := finance_v3.seed_chart(p_org, s.base_currency, v_uid);
  if v_new then
    perform finance_v3.write_audit(p_org, v_uid, 'init_organization', 'org_settings', p_org::text, null,
      jsonb_build_object('base_currency', s.base_currency, 'accounts_seeded', v_seeded), null);
  end if;
  return finance_v3.settings_json(s) || jsonb_build_object('created', v_new, 'accounts_seeded', v_seeded);
end;
$$;

create or replace function public.fin3_get_org_settings(p_org uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare s finance_v3.org_settings;
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  s := finance_v3.assert_org_ready(p_org);
  return finance_v3.settings_json(s);
end;
$$;

create or replace function public.fin3_set_base_currency(p_org uuid, p_currency text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.admin');
  v_ccy text := upper(btrim(p_currency));
  s     finance_v3.org_settings;
  v_old text;
begin
  s := finance_v3.assert_org_ready(p_org);
  if v_ccy is null or not exists (select 1 from finance_v3.currencies c where c.code = v_ccy and c.is_active) then
    raise exception 'Choose a supported base currency.' using errcode = 'V3011';
  end if;
  perform finance_v3.lock_org(p_org);
  v_old := s.base_currency;
  if v_ccy = v_old then return finance_v3.settings_json(s); end if;
  if exists (select 1 from finance_v3.journal_entries je where je.organization_id = p_org and je.status = 'draft') then
    raise exception 'Discard or post the draft entries before changing the base currency.' using errcode = 'V3024';
  end if;
  -- The guard trigger raises V3024 if the ledger already contains real entries.
  update finance_v3.org_settings os set base_currency = v_ccy where os.organization_id = p_org returning * into s;
  update finance_v3.accounts a set currency = v_ccy
   where a.organization_id = p_org and a.currency = v_old
     and a.code in (select d.code from finance_v3.default_chart d where d.currency_is_base);
  perform finance_v3.write_audit(p_org, v_uid, 'set_base_currency', 'org_settings', p_org::text,
    jsonb_build_object('base_currency', v_old), jsonb_build_object('base_currency', v_ccy), null);
  return finance_v3.settings_json(s);
end;
$$;

create or replace function public.fin3_set_period_lock(p_org uuid, p_date date, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.admin');
  s     finance_v3.org_settings;
  v_old date;
  v_reason text := nullif(btrim(p_reason), '');
begin
  s := finance_v3.assert_org_ready(p_org);
  if v_reason is null then
    raise exception 'A reason is required to change the period lock.' using errcode = 'V3011';
  end if;
  if p_date is not null and p_date not between date '1990-01-01' and current_date + 366 then
    raise exception 'The lock date is out of range.' using errcode = 'V3011';
  end if;
  perform finance_v3.lock_org(p_org);
  v_old := s.period_lock_date;
  update finance_v3.org_settings os set period_lock_date = p_date where os.organization_id = p_org returning * into s;
  perform finance_v3.write_audit(p_org, v_uid, 'set_period_lock', 'org_settings', p_org::text,
    jsonb_build_object('period_lock_date', v_old), jsonb_build_object('period_lock_date', p_date), v_reason);
  return finance_v3.settings_json(s);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Chart of accounts
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fin3_list_accounts(p_org uuid, p_include_inactive boolean default false)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  return coalesce((select jsonb_agg(finance_v3.account_json(a) order by a.code)
                     from finance_v3.accounts a
                    where a.organization_id = p_org and (p_include_inactive or a.is_active)), '[]'::jsonb);
end;
$$;

-- p_account keys: id, code, name, account_type, description, parent_code, is_active, is_postable, currency.
-- Creates when no account matches id/code; otherwise updates the keys supplied. The guard trigger forbids deleting,
-- retyping or recoding accounts that have postings and protects system accounts.
create or replace function public.fin3_upsert_account(p_org uuid, p_account jsonb)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid  uuid := finance_v3.assert_permission(p_org, 'finance.admin');
  a      finance_v3.accounts;
  v_before jsonb;
  v_key  text;
  v_parent uuid;
  v_ccy  text;
begin
  perform finance_v3.assert_org_ready(p_org);
  if p_account is null or jsonb_typeof(p_account) <> 'object' then
    raise exception 'Account must be an object.' using errcode = 'V3011';
  end if;
  select k into v_key from jsonb_object_keys(p_account) k
   where k not in ('id','code','name','account_type','description','parent_code','is_active','is_postable','currency') limit 1;
  if v_key is not null then raise exception 'Unknown account field "%".', v_key using errcode = 'V3011'; end if;
  perform finance_v3.lock_org(p_org);

  if p_account ? 'id' then
    select * into a from finance_v3.accounts x where x.organization_id = p_org and x.id = (p_account ->> 'id')::uuid;
  elsif p_account ? 'code' then
    select * into a from finance_v3.accounts x where x.organization_id = p_org and x.code = (p_account ->> 'code');
  end if;

  if p_account ? 'parent_code' then
    if jsonb_typeof(p_account -> 'parent_code') = 'null' then v_parent := null;
    else
      select x.id into v_parent from finance_v3.accounts x where x.organization_id = p_org and x.code = (p_account ->> 'parent_code');
      if v_parent is null then raise exception 'Parent account not found.' using errcode = 'V3009'; end if;
    end if;
  end if;
  v_ccy := case when p_account ? 'currency' and jsonb_typeof(p_account -> 'currency') <> 'null'
                then upper(p_account ->> 'currency') end;
  if v_ccy is not null and not exists (select 1 from finance_v3.currencies c where c.code = v_ccy and c.is_active) then
    raise exception 'Unsupported currency "%".', v_ccy using errcode = 'V3011';
  end if;

  if a.id is null then
    if not (p_account ? 'code' and p_account ? 'name' and p_account ? 'account_type') then
      raise exception 'A new account needs code, name and account_type.' using errcode = 'V3011';
    end if;
    insert into finance_v3.accounts (organization_id, code, name, account_type, description, parent_id,
                                     is_active, is_postable, currency, created_by)
    values (p_org, p_account ->> 'code', btrim(p_account ->> 'name'), p_account ->> 'account_type',
            coalesce(p_account ->> 'description', ''), v_parent,
            coalesce((p_account ->> 'is_active')::boolean, true), coalesce((p_account ->> 'is_postable')::boolean, true), v_ccy, v_uid)
    returning * into a;
    perform finance_v3.write_audit(p_org, v_uid, 'create_account', 'account', a.id::text, null, finance_v3.account_json(a), null);
  else
    v_before := finance_v3.account_json(a);
    update finance_v3.accounts x set
        code        = coalesce(p_account ->> 'code', x.code),
        name        = coalesce(btrim(p_account ->> 'name'), x.name),
        account_type = coalesce(p_account ->> 'account_type', x.account_type),
        description = coalesce(p_account ->> 'description', x.description),
        parent_id   = case when p_account ? 'parent_code' then v_parent else x.parent_id end,
        is_active   = coalesce((p_account ->> 'is_active')::boolean, x.is_active),
        is_postable = coalesce((p_account ->> 'is_postable')::boolean, x.is_postable),
        currency    = case when p_account ? 'currency' then v_ccy else x.currency end
     where x.id = a.id returning * into a;
    perform finance_v3.write_audit(p_org, v_uid, 'update_account', 'account', a.id::text, v_before, finance_v3.account_json(a), null);
  end if;
  return finance_v3.account_json(a);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- FX rates (append-only versions). rate = base units per 1 unit of p_from.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fin3_set_fx_rate(
  p_org uuid, p_from text, p_to text, p_date date, p_rate text, p_source text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid  uuid := finance_v3.assert_permission(p_org, 'finance.post');
  s      finance_v3.org_settings;
  v_from text := upper(btrim(p_from));
  v_to   text := upper(btrim(p_to));
  v_rate numeric;
  v_last finance_v3.fx_rates;
  v_row  finance_v3.fx_rates;
begin
  s := finance_v3.assert_org_ready(p_org);
  if v_to is distinct from s.base_currency then
    raise exception 'Rates are stored from a foreign currency into the base currency (%).', s.base_currency using errcode = 'V3008';
  end if;
  if v_from is null or v_from = s.base_currency
     or not exists (select 1 from finance_v3.currencies c where c.code = v_from and c.is_active) then
    raise exception 'Choose a supported foreign currency.' using errcode = 'V3011';
  end if;
  if p_date is null or p_date not between date '1990-01-01' and current_date + 366 then
    raise exception 'The rate date is out of range.' using errcode = 'V3011';
  end if;
  if p_rate is null or p_rate !~ '^[0-9]{1,10}(\.[0-9]{1,10})?$' or p_rate::numeric <= 0 then
    raise exception 'The rate must be a positive decimal string with at most 10 decimals.' using errcode = 'V3011';
  end if;
  if p_source is null or p_source not in ('manual', 'provider', 'import') then
    raise exception 'The source must be manual, provider or import.' using errcode = 'V3011';
  end if;
  v_rate := p_rate::numeric(20,10);
  perform finance_v3.lock_org(p_org);

  select * into v_last from finance_v3.fx_rates r
   where r.organization_id = p_org and r.from_currency = v_from and r.to_currency = v_to and r.rate_date = p_date
   order by r.version desc limit 1;
  if found and v_last.rate = v_rate and v_last.source = p_source then
    return jsonb_build_object('id', v_last.id, 'version', v_last.version, 'rate', v_last.rate::text, 'created', false);
  end if;
  insert into finance_v3.fx_rates (organization_id, from_currency, to_currency, rate_date, version, rate, source, entered_by)
  values (p_org, v_from, v_to, p_date, coalesce(v_last.version, 0) + 1, v_rate, p_source, v_uid)
  returning * into v_row;
  perform finance_v3.write_audit(p_org, v_uid, 'set_fx_rate', 'fx_rate', v_row.id::text,
    case when v_last.id is null then null else jsonb_build_object('version', v_last.version, 'rate', v_last.rate::text) end,
    jsonb_build_object('from', v_from, 'to', v_to, 'date', p_date, 'version', v_row.version, 'rate', v_row.rate::text, 'source', p_source), null);
  return jsonb_build_object('id', v_row.id, 'version', v_row.version, 'rate', v_row.rate::text, 'created', true);
end;
$$;

create or replace function public.fin3_get_fx_rate(p_org uuid, p_from text, p_date date)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare s finance_v3.org_settings; fx record;
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  s := finance_v3.assert_org_ready(p_org);
  select * into fx from finance_v3.resolve_fx(p_org, upper(btrim(p_from)), s.base_currency, p_date, s.fx_lookback_days);
  if fx.rate is null then
    return jsonb_build_object('found', false, 'from', upper(btrim(p_from)), 'to', s.base_currency, 'date', p_date);
  end if;
  return jsonb_build_object('found', true, 'from', upper(btrim(p_from)), 'to', s.base_currency, 'date', p_date,
                            'rate', fx.rate::text, 'rate_date', fx.rate_date, 'source', fx.source);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Journal posting
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fin3_post_journal(
  p_org uuid, p_key text, p_date date, p_memo text, p_reference text, p_lines jsonb, p_project uuid default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  perform finance_v3.assert_permission(p_org, 'finance.post');
  perform finance_v3.assert_org_ready(p_org);
  return finance_v3.post_event(p_org, 'manual_journal', p_key, p_date, p_lines,
           jsonb_strip_nulls(jsonb_build_object('memo', p_memo, 'reference', p_reference, 'project_id', p_project)));
end;
$$;

create or replace function public.fin3_reverse_entry(
  p_org uuid, p_entry uuid, p_key text, p_reason text, p_date date default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  perform finance_v3.assert_permission(p_org, 'finance.approve');
  perform finance_v3.assert_org_ready(p_org);
  return finance_v3.reverse_entry(p_org, p_entry, p_key, p_reason, p_date);
end;
$$;

-- Draft lifecycle. Drafts are editable by their creator (or a finance admin) until posted. They hold native amounts only;
-- FX conversion and the entry number are assigned when the draft is posted.
create or replace function public.fin3_save_draft_entry(
  p_org uuid, p_entry uuid, p_date date, p_memo text, p_reference text, p_lines jsonb, p_project uuid default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid   uuid := finance_v3.assert_permission(p_org, 'finance.post');
  v_norm  jsonb;
  h       finance_v3.journal_entries;
  v_id    uuid;
  v_memo  text := nullif(btrim(p_memo), '');
  v_ref   text := nullif(btrim(p_reference), '');
begin
  perform finance_v3.assert_org_ready(p_org);
  if p_date is null or p_date not between date '1990-01-01' and current_date + 366 then
    raise exception 'The accounting date is out of range.' using errcode = 'V3011';
  end if;
  if char_length(v_memo) > 500 or char_length(v_ref) > 120 then
    raise exception 'Memo or reference is too long.' using errcode = 'V3011';
  end if;
  if p_project is not null and not finance_v3.project_in_org(p_org, p_project) then
    raise exception 'The project is not part of this studio.' using errcode = 'V3011';
  end if;
  v_norm := finance_v3.normalize_lines(p_org, p_lines, 1);

  if p_entry is null then
    insert into finance_v3.journal_entries (organization_id, accounting_date, memo, reference, project_id, created_by)
    values (p_org, p_date, v_memo, v_ref, p_project, v_uid) returning id into v_id;
  else
    select * into h from finance_v3.journal_entries je where je.organization_id = p_org and je.id = p_entry for update;
    if not found then raise exception 'Draft not found.' using errcode = 'V3010'; end if;
    if h.status <> 'draft' then
      raise exception 'Entry % is posted and cannot be edited. Reverse it instead.', h.entry_no using errcode = 'V3002';
    end if;
    if h.created_by is distinct from v_uid and not finance_v3.has_permission_for(v_uid, p_org, 'finance.admin') then
      raise exception 'Only the author of a draft (or a finance admin) can edit it.' using errcode = 'V3005';
    end if;
    update finance_v3.journal_entries je
       set accounting_date = p_date, memo = v_memo, reference = v_ref, project_id = p_project, updated_at = now()
     where je.id = p_entry;
    delete from finance_v3.journal_lines l where l.entry_id = p_entry;
    v_id := p_entry;
  end if;
  insert into finance_v3.journal_lines (organization_id, entry_id, line_no, account_id, side, amount_native, currency, project_id, memo)
  select p_org, v_id, x.line_no, x.account_id, x.side, x.amount::numeric, x.currency, x.project_id, x.memo
    from jsonb_to_recordset(v_norm) as x(line_no integer, account_id uuid, side text, amount text, currency text, project_id uuid, memo text);
  perform finance_v3.write_audit(p_org, v_uid, case when p_entry is null then 'create_draft' else 'update_draft' end,
    'journal_entry', v_id::text, null, jsonb_build_object('accounting_date', p_date, 'lines', jsonb_array_length(v_norm)), null);
  return v_id;
end;
$$;

create or replace function public.fin3_post_draft_entry(p_org uuid, p_entry uuid, p_key text)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_actor   uuid;
  h         finance_v3.journal_entries;
  v_payload jsonb;
  v_hash    text;
  v_event   finance_v3.events;
  v_event_id uuid;
  v_no      bigint;
begin
  perform finance_v3.assert_permission(p_org, 'finance.post');
  perform finance_v3.assert_org_ready(p_org);
  if p_key is null or char_length(p_key) not between 1 and 200 or p_key !~ '^[A-Za-z0-9_.:-]+$' then
    raise exception 'Invalid idempotency key.' using errcode = 'V3011';
  end if;
  v_actor := finance_v3.authorize_event_kind(p_org, 'manual_journal', false);
  perform finance_v3.lock_org(p_org);

  v_payload := jsonb_build_object('kind', 'manual_journal', 'draft_entry_id', p_entry);
  v_hash := encode(sha256(convert_to(v_payload::text, 'UTF8')), 'hex');
  select * into v_event from finance_v3.events ev where ev.organization_id = p_org and ev.idempotency_key = p_key;
  if found then
    if v_event.request_hash <> v_hash then
      raise exception 'This idempotency key was already used for a different request.' using errcode = 'V3021';
    end if;
    return (select je.id from finance_v3.journal_entries je where je.event_id = v_event.id);
  end if;

  select * into h from finance_v3.journal_entries je where je.organization_id = p_org and je.id = p_entry for update;
  if not found then raise exception 'Draft not found.' using errcode = 'V3010'; end if;
  if h.status <> 'draft' then
    raise exception 'Entry is already posted.' using errcode = 'V3023';
  end if;

  insert into finance_v3.events (organization_id, kind, idempotency_key, request_hash, accounting_date, actor, payload)
  values (p_org, 'manual_journal', p_key, v_hash, h.accounting_date, v_actor, v_payload)
  returning id into v_event_id;
  v_no := finance_v3.finalize_entry(p_entry, v_event_id, v_actor);
  perform finance_v3.write_audit(p_org, v_actor, 'post_entry', 'journal_entry', p_entry::text, null,
    jsonb_build_object('entry_no', v_no, 'kind', 'manual_journal', 'from_draft', true, 'event_id', v_event_id), null);
  return p_entry;
end;
$$;

create or replace function public.fin3_discard_draft_entry(p_org uuid, p_entry uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.post');
  h     finance_v3.journal_entries;
  v_lines jsonb;
  v_reason text := nullif(btrim(p_reason), '');
begin
  perform finance_v3.assert_org_ready(p_org);
  if v_reason is null then raise exception 'A reason is required to discard a draft.' using errcode = 'V3011'; end if;
  select * into h from finance_v3.journal_entries je where je.organization_id = p_org and je.id = p_entry for update;
  if not found then raise exception 'Draft not found.' using errcode = 'V3010'; end if;
  if h.status <> 'draft' then
    raise exception 'Posted entries cannot be discarded. Reverse the entry instead.' using errcode = 'V3002';
  end if;
  if h.created_by is distinct from v_uid and not finance_v3.has_permission_for(v_uid, p_org, 'finance.admin') then
    raise exception 'Only the author of a draft (or a finance admin) can discard it.' using errcode = 'V3005';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('line_no', l.line_no, 'account_id', l.account_id, 'side', l.side,
           'amount', l.amount_native::text, 'currency', l.currency) order by l.line_no), '[]'::jsonb)
    into v_lines from finance_v3.journal_lines l where l.entry_id = p_entry;
  delete from finance_v3.journal_entries je where je.id = p_entry;
  perform finance_v3.write_audit(p_org, v_uid, 'discard_draft', 'journal_entry', p_entry::text,
    jsonb_build_object('accounting_date', h.accounting_date, 'memo', h.memo, 'lines', v_lines), null, v_reason);
end;
$$;

create or replace function public.fin3_get_entry(p_org uuid, p_entry uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare h finance_v3.journal_entries; v_rev uuid;
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  select * into h from finance_v3.journal_entries je where je.organization_id = p_org and je.id = p_entry;
  if not found then raise exception 'Entry not found.' using errcode = 'V3010'; end if;
  select je.id into v_rev from finance_v3.journal_entries je where je.organization_id = p_org and je.reverses_entry_id = p_entry;
  return jsonb_build_object(
    'id', h.id, 'entry_no', h.entry_no, 'status', h.status, 'accounting_date', h.accounting_date,
    'memo', h.memo, 'reference', h.reference, 'project_id', h.project_id, 'base_currency', h.base_currency,
    'fx_status', h.fx_status, 'reverses_entry_id', h.reverses_entry_id, 'reversal_reason', h.reversal_reason,
    'reversed_by_entry_id', v_rev, 'is_reversed', v_rev is not null, 'event_id', h.event_id,
    'posted_at', h.posted_at,
    'lines', coalesce((select jsonb_agg(jsonb_build_object(
        'line_no', l.line_no, 'account_id', l.account_id, 'account_code', a.code, 'side', l.side,
        'amount', l.amount_native::text, 'currency', l.currency, 'fx_status', l.fx_status,
        'fx_rate', l.fx_rate::text, 'fx_rate_date', l.fx_rate_date, 'fx_source', l.fx_source,
        'amount_base', l.amount_base::text, 'base_rounding_adjustment', l.base_rounding_adjustment::text,
        'project_id', l.project_id, 'memo', l.memo) order by l.line_no)
       from finance_v3.journal_lines l join finance_v3.accounts a on a.organization_id = l.organization_id and a.id = l.account_id
      where l.entry_id = h.id), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Trial balance: the minimum read that proves the ledger balances (full reporting is Phase 6).
--   p_currency null or = base currency: BASE basis (amount_base). Entries whose conversion is 'missing' are excluded
--     from the totals and counted in excluded_entries; they are never converted at a guessed rate.
--   p_currency = another currency: NATIVE basis for that currency (exact; includes every posted entry).
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fin3_trial_balance(p_org uuid, p_as_of date default null, p_currency text default null)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  s        finance_v3.org_settings;
  v_asof   date := coalesce(p_as_of, current_date);
  v_ccy    text := upper(nullif(btrim(p_currency), ''));
  v_basis  text;
  v_rows   jsonb;
  v_td     numeric;
  v_tc     numeric;
  v_excl   integer := 0;
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  s := finance_v3.assert_org_ready(p_org);
  if v_ccy is not null and not exists (select 1 from finance_v3.currencies c where c.code = v_ccy) then
    raise exception 'Unknown currency "%".', v_ccy using errcode = 'V3011';
  end if;
  if v_ccy is null or v_ccy = s.base_currency then
    v_basis := 'base'; v_ccy := s.base_currency;
    select count(*) into v_excl from finance_v3.journal_entries je
     where je.organization_id = p_org and je.status = 'posted' and je.accounting_date <= v_asof and je.fx_status = 'missing';
    with agg as (
      select a.id, a.code, a.name, a.account_type, a.normal_balance,
             coalesce(sum(l.amount_base) filter (where l.side = 'debit'), 0) as debit,
             coalesce(sum(l.amount_base) filter (where l.side = 'credit'), 0) as credit
        from finance_v3.accounts a
        join finance_v3.journal_lines l on l.organization_id = a.organization_id and l.account_id = a.id
        join finance_v3.journal_entries je on je.id = l.entry_id
       where a.organization_id = p_org and je.status = 'posted' and je.accounting_date <= v_asof and je.fx_status <> 'missing'
       group by a.id, a.code, a.name, a.account_type, a.normal_balance)
    select coalesce(jsonb_agg(jsonb_build_object('account_id', id, 'code', code, 'name', name, 'account_type', account_type,
             'debit', debit::text, 'credit', credit::text,
             'balance', (case when normal_balance = 'debit' then debit - credit else credit - debit end)::text,
             'balance_side', normal_balance) order by code), '[]'::jsonb),
           coalesce(sum(debit), 0), coalesce(sum(credit), 0)
      into v_rows, v_td, v_tc from agg;
  else
    v_basis := 'native';
    with agg as (
      select a.id, a.code, a.name, a.account_type, a.normal_balance,
             coalesce(sum(l.amount_native) filter (where l.side = 'debit'), 0) as debit,
             coalesce(sum(l.amount_native) filter (where l.side = 'credit'), 0) as credit
        from finance_v3.accounts a
        join finance_v3.journal_lines l on l.organization_id = a.organization_id and l.account_id = a.id
        join finance_v3.journal_entries je on je.id = l.entry_id
       where a.organization_id = p_org and je.status = 'posted' and je.accounting_date <= v_asof and l.currency = v_ccy
       group by a.id, a.code, a.name, a.account_type, a.normal_balance)
    select coalesce(jsonb_agg(jsonb_build_object('account_id', id, 'code', code, 'name', name, 'account_type', account_type,
             'debit', debit::text, 'credit', credit::text,
             'balance', (case when normal_balance = 'debit' then debit - credit else credit - debit end)::text,
             'balance_side', normal_balance) order by code), '[]'::jsonb),
           coalesce(sum(debit), 0), coalesce(sum(credit), 0)
      into v_rows, v_td, v_tc from agg;
  end if;
  return jsonb_build_object('as_of', v_asof, 'currency', v_ccy, 'basis', v_basis, 'base_currency', s.base_currency,
    'accounts', v_rows, 'total_debits', v_td::text, 'total_credits', v_tc::text,
    'balanced', v_td = v_tc, 'excluded_entries', v_excl);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Permission grants (explicit, per user, on top of role defaults)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fin3_grant_permission(p_org uuid, p_user uuid, p_permission text)
returns void
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid  uuid := finance_v3.assert_permission(p_org, 'finance.admin');
  v_role text;
  v_status text;
begin
  perform finance_v3.assert_org_ready(p_org);
  if not exists (select 1 from finance_v3.permissions p where p.key = p_permission) then
    raise exception 'Unknown permission.' using errcode = 'V3011';
  end if;
  -- Powerful permissions can only be handed out by the Master User.
  if p_permission in ('finance.admin', 'finance.override', 'finance.owner_pay', 'finance.refund')
     and not exists (select 1 from public.studio_memberships m
                      where m.organization_id = p_org and m.user_id = v_uid and m.role = 'master_user' and m.status = 'active') then
    raise exception 'Only the Master User can grant this permission.' using errcode = 'V3005';
  end if;
  -- Separation of duties: only the Master User may extend their own access.
  if p_user = v_uid
     and not exists (select 1 from public.studio_memberships m
                      where m.organization_id = p_org and m.user_id = v_uid and m.role = 'master_user' and m.status = 'active') then
    raise exception 'You cannot grant Finance permissions to yourself. Ask the Master User.' using errcode = 'V3005';
  end if;
  select m.role, m.status into v_role, v_status from public.studio_memberships m
   where m.organization_id = p_org and m.user_id = p_user;
  if not found or v_status <> 'active' or v_role in ('freelancer', 'client') then
    raise exception 'Finance permissions can only be granted to active studio staff.' using errcode = 'V3011';
  end if;
  insert into finance_v3.user_permission_grants (organization_id, user_id, permission_key, granted_by)
  values (p_org, p_user, p_permission, v_uid) on conflict do nothing;
  if found then
    perform finance_v3.write_audit(p_org, v_uid, 'grant_permission', 'user', p_user::text, null,
      jsonb_build_object('permission', p_permission), null);
  end if;
end;
$$;

create or replace function public.fin3_revoke_permission(p_org uuid, p_user uuid, p_permission text)
returns void
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare v_uid uuid := finance_v3.assert_permission(p_org, 'finance.admin');
begin
  perform finance_v3.assert_org_ready(p_org);
  if p_permission in ('finance.admin', 'finance.override', 'finance.owner_pay', 'finance.refund')
     and not exists (select 1 from public.studio_memberships m
                      where m.organization_id = p_org and m.user_id = v_uid and m.role = 'master_user' and m.status = 'active') then
    raise exception 'Only the Master User can revoke this permission.' using errcode = 'V3005';
  end if;
  delete from finance_v3.user_permission_grants g
   where g.organization_id = p_org and g.user_id = p_user and g.permission_key = p_permission;
  if found then
    perform finance_v3.write_audit(p_org, v_uid, 'revoke_permission', 'user', p_user::text,
      jsonb_build_object('permission', p_permission), null, null);
  end if;
end;
$$;

create or replace function public.fin3_list_permissions(p_org uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  perform finance_v3.assert_permission(p_org, 'finance.admin');
  return coalesce((select jsonb_agg(jsonb_build_object('user_id', g.user_id, 'permission', g.permission_key,
           'granted_by', g.granted_by, 'granted_at', g.granted_at) order by g.user_id, g.permission_key)
           from finance_v3.user_permission_grants g where g.organization_id = p_org), '[]'::jsonb);
end;
$$;

create or replace function public.fin3_my_permissions(p_org uuid)
returns jsonb
language sql stable security definer
set search_path = pg_catalog, finance_v3
as $$
  select coalesce(jsonb_agg(p.key order by p.key), '[]'::jsonb)
    from finance_v3.permissions p where finance_v3.has_permission_for(auth.uid(), p_org, p.key);
$$;

-- Existing organizations seeded before payment_clearing became multi-currency: lift the base-currency restriction when
-- the account has no lines yet (the guard trigger forbids changing it afterwards).
update finance_v3.accounts a set currency = null
 where a.system_key = 'payment_clearing' and a.currency is not null
   and not exists (select 1 from finance_v3.journal_lines l where l.organization_id = a.organization_id and l.account_id = a.id);

-- ---------------------------------------------------------------------------------------------------------------
-- Privileges: authenticated only. (PostgreSQL grants EXECUTE to PUBLIC by default; Supabase also grants anon and
-- service_role through default privileges. All are removed explicitly.)
-- ---------------------------------------------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig, p.proname from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'fin3\_%' loop
    execute format('revoke all on function %s from public, anon, service_role', r.sig);
    execute format('grant execute on function %s to authenticated', r.sig);
  end loop;
  for r in select p.oid::regprocedure as sig from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'finance_v3' loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', r.sig);
  end loop;
end $$;
grant execute on function finance_v3.has_permission(uuid, text) to authenticated;

commit;
