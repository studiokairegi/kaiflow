-- Finance V3, Phase 3 (migration 1 of 6): studio profile settings, shared helpers, document numbering, contacts, document store.
--
-- Isolation (architecture D-01, D-07): everything lives in schema finance_v3. This file never alters, drops or writes any
-- Finance V2 / legacy table. Clients reach V3 only through public.fin3_* RPCs; service-only operations are public.fin3svc_*
-- (executable by service_role only, used by Edge Functions).
-- Rollback: supabase/rollback/20270114090000_finance_v3_settings_contacts.rollback.sql
--
-- NOT EXECUTED: this migration was written in a sandbox without PostgreSQL. It has been statically checked only
-- (see docs/finance-v3/PHASE_3_HANDOFF.md). Run supabase/tests/finance_v3/run.sh before applying it anywhere real.

begin;

insert into finance_v3.schema_version (version, notes)
values ('20270114090000', 'phase 3 migration 1: studio profile settings, helpers, numbering, contacts, document store')
on conflict (version) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- Studio profile and Finance configuration (one row per organization, the same row Phase 2 already locks for posting).
-- ---------------------------------------------------------------------------------------------------------------
alter table finance_v3.org_settings
  add column if not exists studio_name text check (studio_name is null or char_length(btrim(studio_name)) between 1 and 120),
  add column if not exists studio_address text check (studio_address is null or char_length(studio_address) <= 400),
  add column if not exists studio_email text check (studio_email is null or (char_length(studio_email) <= 254 and studio_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$')),
  add column if not exists studio_phone text check (studio_phone is null or char_length(studio_phone) <= 40),
  add column if not exists studio_tax_id text check (studio_tax_id is null or char_length(studio_tax_id) <= 60),
  add column if not exists brand_color text not null default '#1F3A5F' check (brand_color ~ '^#[0-9A-Fa-f]{6}$'),
  add column if not exists invoice_prefix text not null default 'INV-' check (invoice_prefix ~ '^[A-Z0-9-]{1,10}$'),
  add column if not exists receipt_prefix text not null default 'RCT-' check (receipt_prefix ~ '^[A-Z0-9-]{1,10}$'),
  add column if not exists default_payment_terms_days smallint not null default 14 check (default_payment_terms_days between 0 and 365),
  add column if not exists invoice_approval_required boolean not null default true,
  add column if not exists four_eyes_payments boolean not null default false,
  add column if not exists is_sandbox boolean not null default false,
  add column if not exists payment_instructions text check (payment_instructions is null or char_length(payment_instructions) <= 1000),
  add column if not exists email_from_name text check (email_from_name is null or char_length(btrim(email_from_name)) between 1 and 80),
  add column if not exists email_from_address text check (email_from_address is null or (char_length(email_from_address) <= 254 and email_from_address ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$')),
  add column if not exists email_reply_to text check (email_reply_to is null or (char_length(email_reply_to) <= 254 and email_reply_to ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$')),
  add column if not exists collect_currencies text[] not null default '{}'::text[];

comment on column finance_v3.org_settings.is_sandbox is
  'Only a sandbox organization may settle Paystack TEST payments (V3019). Live organizations never accept test money.';
comment on column finance_v3.org_settings.collect_currencies is
  'Currencies the owner has enabled for online collection. Phase 3 charges in the invoice currency only (no cross-currency checkout).';

-- ---------------------------------------------------------------------------------------------------------------
-- Small shared helpers (internal; not executable by any client role).
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.minor_unit(p_ccy text)
returns smallint
language sql stable security definer
set search_path = pg_catalog, finance_v3
as $$ select c.minor_unit from finance_v3.currencies c where c.code = p_ccy and c.is_active $$;

-- Canonical decimal string for a money value in a currency (rounded once, half away from zero, to the minor unit).
create or replace function finance_v3.money_text(p_amount numeric, p_ccy text)
returns text
language sql stable security definer
set search_path = pg_catalog, finance_v3
as $$ select round(p_amount, finance_v3.minor_unit(p_ccy)::integer)::text $$;

-- Parses a JSON string into a bounded decimal. Amounts, quantities, percentages and rates are never accepted as JSON numbers.
create or replace function finance_v3.parse_decimal(
  p_value jsonb, p_label text, p_max_scale integer, p_min numeric, p_max numeric, p_default numeric default null)
returns numeric
language plpgsql immutable
set search_path = pg_catalog, finance_v3
as $$
declare
  v_text text;
  v_num  numeric;
begin
  if p_value is null or jsonb_typeof(p_value) = 'null' then
    if p_default is not null then return p_default; end if;
    raise exception '% is required.', p_label using errcode = 'V3011';
  end if;
  if jsonb_typeof(p_value) <> 'string' then
    raise exception '% must be a decimal string such as "12.50".', p_label using errcode = 'V3011';
  end if;
  v_text := p_value #>> '{}';
  if v_text !~ '^(0|[1-9][0-9]{0,14})(\.[0-9]{1,10})?$' then
    raise exception '% is not a valid decimal number.', p_label using errcode = 'V3011';
  end if;
  if length(split_part(v_text, '.', 2)) > p_max_scale then
    raise exception '% allows at most % decimal places.', p_label, p_max_scale using errcode = 'V3011';
  end if;
  v_num := v_text::numeric;
  if v_num < p_min or v_num > p_max then
    raise exception '% must be between % and %.', p_label, p_min, p_max using errcode = 'V3011';
  end if;
  return v_num;
end;
$$;

-- Parses a money amount passed as text. Never more decimals than the currency's minor unit. Zero only when allowed.
create or replace function finance_v3.parse_money(p_text text, p_label text, p_ccy text, p_allow_zero boolean default false)
returns numeric
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_minor smallint := finance_v3.minor_unit(p_ccy);
  v_num   numeric;
begin
  if v_minor is null then
    raise exception 'Unsupported currency "%".', coalesce(p_ccy, '') using errcode = 'V3011';
  end if;
  if p_text is null or p_text !~ '^(0|[1-9][0-9]{0,14})(\.[0-9]{1,4})?$' then
    raise exception '% must be a decimal string such as "1234.50".', p_label using errcode = 'V3011';
  end if;
  if length(split_part(p_text, '.', 2)) > v_minor then
    raise exception '%: % allows at most % decimal places.', p_label, p_ccy, v_minor using errcode = 'V3011';
  end if;
  v_num := p_text::numeric;
  if v_num = 0 and not p_allow_zero then
    raise exception '% must be greater than zero.', p_label using errcode = 'V3011';
  end if;
  return v_num;
end;
$$;

-- Event keys must stay under 200 characters; caller-supplied idempotency keys are hashed into them.
create or replace function finance_v3.key_hash(p_key text)
returns text
language sql immutable
set search_path = pg_catalog, finance_v3
as $$ select substr(encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex'), 1, 40) $$;

create or replace function finance_v3.valid_uuid(p_text text)
returns boolean
language sql immutable
set search_path = pg_catalog, finance_v3
as $$ select p_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' $$;

-- A system account looked up by its stable key (never by a hard-coded code).
create or replace function finance_v3.system_account(p_org uuid, p_key text)
returns uuid
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare v_id uuid;
begin
  select a.id into v_id from finance_v3.accounts a
   where a.organization_id = p_org and a.system_key = p_key and a.is_active;
  if v_id is null then
    raise exception 'The system account "%" is missing or inactive for this studio.', p_key using errcode = 'V3009';
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Document numbering. A counter row per (organization, kind). Atomic and gapless as long as the caller commits in the same
-- transaction that uses the number (a rollback rolls the counter back too).
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists finance_v3.doc_counters (
  organization_id uuid not null references finance_v3.org_settings(organization_id) on delete restrict,
  kind            text not null check (kind in ('invoice', 'receipt', 'refund', 'bill', 'credit', 'transfer', 'expense')),
  last_no         bigint not null default 0 check (last_no >= 0),
  primary key (organization_id, kind)
);

create or replace function finance_v3.next_doc_number(p_org uuid, p_kind text)
returns text
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_n      bigint;
  v_prefix text;
begin
  insert into finance_v3.doc_counters as c (organization_id, kind, last_no)
  values (p_org, p_kind, 1)
  on conflict (organization_id, kind) do update set last_no = c.last_no + 1
  returning c.last_no into v_n;
  select case p_kind
           when 'invoice' then s.invoice_prefix
           when 'receipt' then s.receipt_prefix
           when 'refund'  then 'RFD-'
           when 'bill'    then 'BIL-'
           when 'credit'  then 'CRN-'
           when 'transfer' then 'TRF-'
           else 'EXP-' end
    into v_prefix
    from finance_v3.org_settings s where s.organization_id = p_org;
  return v_prefix || lpad(v_n::text, 6, '0');
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Contacts (clients, suppliers, freelancers). One table so invoices, bills and expenses share one set of parties.
-- Issued documents keep their own snapshot of the party, so editing a contact never rewrites history.
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists finance_v3.contacts_v3 (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references finance_v3.org_settings(organization_id) on delete restrict,
  kind             text not null check (kind in ('client', 'supplier', 'freelancer')),
  name             text not null check (char_length(btrim(name)) between 1 and 160),
  email            text check (email is null or (char_length(email) <= 254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$')),
  phone            text check (phone is null or char_length(phone) <= 40),
  address          text check (address is null or char_length(address) <= 400),
  tax_id           text check (tax_id is null or char_length(tax_id) <= 60),
  default_currency text references finance_v3.currencies(code),
  is_active        boolean not null default true,
  source_legacy_id text,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint uq_contacts_org_id unique (organization_id, id)
);
create unique index if not exists uq_contacts_legacy
  on finance_v3.contacts_v3 (organization_id, kind, source_legacy_id) where source_legacy_id is not null;
create index if not exists ix_contacts_org_kind on finance_v3.contacts_v3 (organization_id, kind, lower(name));

-- ---------------------------------------------------------------------------------------------------------------
-- Generated documents (invoice and receipt PDFs). Written once by the server; never rebuilt differently on retry.
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists finance_v3.documents (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references finance_v3.org_settings(organization_id) on delete restrict,
  kind            text not null check (kind in ('invoice_pdf', 'receipt_pdf')),
  entity_id       uuid not null,
  sha256          text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size       integer not null check (byte_size between 1 and 10485760),
  content         bytea not null,
  created_at      timestamptz not null default now(),
  constraint uq_documents_entity unique (organization_id, kind, entity_id)
);
drop trigger if exists tg_append_only on finance_v3.documents;
create trigger tg_append_only before update or delete on finance_v3.documents
  for each row execute function finance_v3.tg_append_only();
drop trigger if exists tg_no_truncate on finance_v3.documents;
create trigger tg_no_truncate before truncate on finance_v3.documents
  for each statement execute function finance_v3.tg_no_truncate();

-- ---------------------------------------------------------------------------------------------------------------
-- Row level security: SELECT only, by organization and finance.read. documents holds PDF bytes and is read through RPCs only.
-- ---------------------------------------------------------------------------------------------------------------
alter table finance_v3.doc_counters enable row level security;
alter table finance_v3.contacts_v3  enable row level security;
alter table finance_v3.documents    enable row level security;

drop policy if exists fin3_select_contacts on finance_v3.contacts_v3;
create policy fin3_select_contacts on finance_v3.contacts_v3 for select to authenticated
  using (finance_v3.has_permission(organization_id, 'finance.read'));

revoke all on finance_v3.doc_counters, finance_v3.contacts_v3, finance_v3.documents from public, anon, authenticated, service_role;
grant select on finance_v3.contacts_v3 to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- Studio profile RPCs
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.profile_json(s finance_v3.org_settings)
returns jsonb
language sql immutable
set search_path = pg_catalog, finance_v3
as $$
  select jsonb_build_object(
    'organization_id', s.organization_id, 'base_currency', s.base_currency,
    'studio_name', s.studio_name, 'studio_address', s.studio_address, 'studio_email', s.studio_email,
    'studio_phone', s.studio_phone, 'studio_tax_id', s.studio_tax_id, 'brand_color', s.brand_color,
    'invoice_prefix', s.invoice_prefix, 'receipt_prefix', s.receipt_prefix,
    'default_payment_terms_days', s.default_payment_terms_days,
    'invoice_approval_required', s.invoice_approval_required, 'four_eyes_payments', s.four_eyes_payments,
    'is_sandbox', s.is_sandbox, 'payment_instructions', s.payment_instructions,
    'email_from_name', s.email_from_name, 'email_from_address', s.email_from_address,
    'email_reply_to', s.email_reply_to, 'collect_currencies', to_jsonb(s.collect_currencies));
$$;

create or replace function public.fin3_get_org_profile(p_org uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare s finance_v3.org_settings;
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  s := finance_v3.assert_org_ready(p_org);
  return finance_v3.profile_json(s);
end;
$$;

-- Updates only the fields supplied. Unknown fields are refused. Only the Master User may change sandbox mode.
create or replace function public.fin3_update_org_profile(p_org uuid, p_profile jsonb)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid    uuid := finance_v3.assert_permission(p_org, 'finance.admin');
  v_key    text;
  v_before finance_v3.org_settings;
  v_after  finance_v3.org_settings;
  v_ccys   text[];
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  if p_profile is null or jsonb_typeof(p_profile) <> 'object' then
    raise exception 'The profile must be an object.' using errcode = 'V3011';
  end if;
  select k into v_key from jsonb_object_keys(p_profile) k
   where k not in ('studio_name', 'studio_address', 'studio_email', 'studio_phone', 'studio_tax_id', 'brand_color',
                   'invoice_prefix', 'receipt_prefix', 'default_payment_terms_days', 'invoice_approval_required',
                   'four_eyes_payments', 'is_sandbox', 'payment_instructions', 'email_from_name', 'email_from_address',
                   'email_reply_to', 'collect_currencies') limit 1;
  if v_key is not null then
    raise exception 'Unknown profile field "%".', v_key using errcode = 'V3011';
  end if;
  if p_profile ? 'is_sandbox' and not finance_v3.has_permission_for(v_uid, p_org, 'finance.override') then
    raise exception 'Only the Master User may change sandbox mode.' using errcode = 'V3005';
  end if;
  if p_profile ? 'collect_currencies' then
    if jsonb_typeof(p_profile -> 'collect_currencies') <> 'array' then
      raise exception 'collect_currencies must be a list of currency codes.' using errcode = 'V3011';
    end if;
    select coalesce(array_agg(distinct c), '{}'::text[]) into v_ccys from jsonb_array_elements_text(p_profile -> 'collect_currencies') c;
    if exists (select 1 from unnest(v_ccys) c where not exists (select 1 from finance_v3.currencies cu where cu.code = c and cu.is_active)) then
      raise exception 'collect_currencies contains an unsupported currency.' using errcode = 'V3011';
    end if;
  end if;

  select * into v_before from finance_v3.org_settings where organization_id = p_org;
  begin
    update finance_v3.org_settings os set
      studio_name = case when p_profile ? 'studio_name' then nullif(btrim(p_profile ->> 'studio_name'), '') else os.studio_name end,
      studio_address = case when p_profile ? 'studio_address' then nullif(btrim(p_profile ->> 'studio_address'), '') else os.studio_address end,
      studio_email = case when p_profile ? 'studio_email' then nullif(lower(btrim(p_profile ->> 'studio_email')), '') else os.studio_email end,
      studio_phone = case when p_profile ? 'studio_phone' then nullif(btrim(p_profile ->> 'studio_phone'), '') else os.studio_phone end,
      studio_tax_id = case when p_profile ? 'studio_tax_id' then nullif(btrim(p_profile ->> 'studio_tax_id'), '') else os.studio_tax_id end,
      brand_color = case when p_profile ? 'brand_color' then (p_profile ->> 'brand_color') else os.brand_color end,
      invoice_prefix = case when p_profile ? 'invoice_prefix' then (p_profile ->> 'invoice_prefix') else os.invoice_prefix end,
      receipt_prefix = case when p_profile ? 'receipt_prefix' then (p_profile ->> 'receipt_prefix') else os.receipt_prefix end,
      default_payment_terms_days = case when p_profile ? 'default_payment_terms_days' then (p_profile ->> 'default_payment_terms_days')::smallint else os.default_payment_terms_days end,
      invoice_approval_required = case when p_profile ? 'invoice_approval_required' then (p_profile ->> 'invoice_approval_required')::boolean else os.invoice_approval_required end,
      four_eyes_payments = case when p_profile ? 'four_eyes_payments' then (p_profile ->> 'four_eyes_payments')::boolean else os.four_eyes_payments end,
      is_sandbox = case when p_profile ? 'is_sandbox' then (p_profile ->> 'is_sandbox')::boolean else os.is_sandbox end,
      payment_instructions = case when p_profile ? 'payment_instructions' then nullif(btrim(p_profile ->> 'payment_instructions'), '') else os.payment_instructions end,
      email_from_name = case when p_profile ? 'email_from_name' then nullif(btrim(p_profile ->> 'email_from_name'), '') else os.email_from_name end,
      email_from_address = case when p_profile ? 'email_from_address' then nullif(lower(btrim(p_profile ->> 'email_from_address')), '') else os.email_from_address end,
      email_reply_to = case when p_profile ? 'email_reply_to' then nullif(lower(btrim(p_profile ->> 'email_reply_to')), '') else os.email_reply_to end,
      collect_currencies = case when p_profile ? 'collect_currencies' then v_ccys else os.collect_currencies end,
      updated_at = now()
     where os.organization_id = p_org
     returning * into v_after;
  exception when check_violation or invalid_text_representation or numeric_value_out_of_range or not_null_violation then
    raise exception 'One of the profile values is not valid.' using errcode = 'V3011';
  end;
  perform finance_v3.write_audit(p_org, v_uid, 'update_org_profile', 'org_settings', p_org::text,
    finance_v3.profile_json(v_before), finance_v3.profile_json(v_after), null);
  return finance_v3.profile_json(v_after);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Contacts RPCs
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.contact_json(c finance_v3.contacts_v3)
returns jsonb
language sql immutable
set search_path = pg_catalog, finance_v3
as $$
  select jsonb_build_object('id', c.id, 'kind', c.kind, 'name', c.name, 'email', c.email, 'phone', c.phone,
    'address', c.address, 'tax_id', c.tax_id, 'default_currency', c.default_currency, 'is_active', c.is_active,
    'source_legacy_id', c.source_legacy_id);
$$;

-- p_contact: { id?, kind, name, email?, phone?, address?, tax_id?, default_currency?, is_active? }. The kind is fixed at creation.
create or replace function public.fin3_upsert_contact(p_org uuid, p_contact jsonb)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid  uuid := finance_v3.assert_permission(p_org, 'finance.post');
  v_key  text;
  v_id   uuid;
  v_old  finance_v3.contacts_v3;
  v_new  finance_v3.contacts_v3;
  v_kind text;
begin
  perform finance_v3.assert_org_ready(p_org);
  if p_contact is null or jsonb_typeof(p_contact) <> 'object' then
    raise exception 'The contact must be an object.' using errcode = 'V3011';
  end if;
  select k into v_key from jsonb_object_keys(p_contact) k
   where k not in ('id', 'kind', 'name', 'email', 'phone', 'address', 'tax_id', 'default_currency', 'is_active') limit 1;
  if v_key is not null then
    raise exception 'Unknown contact field "%".', v_key using errcode = 'V3011';
  end if;
  if p_contact ? 'default_currency' and nullif(p_contact ->> 'default_currency', '') is not null
     and finance_v3.minor_unit(p_contact ->> 'default_currency') is null then
    raise exception 'Unsupported default currency.' using errcode = 'V3011';
  end if;
  begin
    if nullif(p_contact ->> 'id', '') is null then
      v_kind := p_contact ->> 'kind';
      if v_kind is null or v_kind not in ('client', 'supplier', 'freelancer') then
        raise exception 'A contact needs a kind of client, supplier or freelancer.' using errcode = 'V3011';
      end if;
      insert into finance_v3.contacts_v3 (organization_id, kind, name, email, phone, address, tax_id, default_currency, is_active, created_by)
      values (p_org, v_kind, btrim(coalesce(p_contact ->> 'name', '')), nullif(lower(btrim(p_contact ->> 'email')), ''),
              nullif(btrim(p_contact ->> 'phone'), ''), nullif(btrim(p_contact ->> 'address'), ''),
              nullif(btrim(p_contact ->> 'tax_id'), ''), nullif(p_contact ->> 'default_currency', ''),
              coalesce((p_contact ->> 'is_active')::boolean, true), v_uid)
      returning * into v_new;
      perform finance_v3.write_audit(p_org, v_uid, 'create_contact', 'contact', v_new.id::text, null, finance_v3.contact_json(v_new), null);
    else
      if not finance_v3.valid_uuid(p_contact ->> 'id') then
        raise exception 'Invalid contact id.' using errcode = 'V3011';
      end if;
      v_id := (p_contact ->> 'id')::uuid;
      select * into v_old from finance_v3.contacts_v3 c where c.organization_id = p_org and c.id = v_id for update;
      if not found then raise exception 'Contact not found.' using errcode = 'V3010'; end if;
      if p_contact ? 'kind' and (p_contact ->> 'kind') is distinct from v_old.kind then
        raise exception 'The kind of a contact cannot be changed.' using errcode = 'V3011';
      end if;
      update finance_v3.contacts_v3 c set
        name = case when p_contact ? 'name' then btrim(coalesce(p_contact ->> 'name', '')) else c.name end,
        email = case when p_contact ? 'email' then nullif(lower(btrim(p_contact ->> 'email')), '') else c.email end,
        phone = case when p_contact ? 'phone' then nullif(btrim(p_contact ->> 'phone'), '') else c.phone end,
        address = case when p_contact ? 'address' then nullif(btrim(p_contact ->> 'address'), '') else c.address end,
        tax_id = case when p_contact ? 'tax_id' then nullif(btrim(p_contact ->> 'tax_id'), '') else c.tax_id end,
        default_currency = case when p_contact ? 'default_currency' then nullif(p_contact ->> 'default_currency', '') else c.default_currency end,
        is_active = case when p_contact ? 'is_active' then (p_contact ->> 'is_active')::boolean else c.is_active end,
        updated_at = now()
       where c.organization_id = p_org and c.id = v_id
       returning * into v_new;
      perform finance_v3.write_audit(p_org, v_uid, 'update_contact', 'contact', v_new.id::text,
        finance_v3.contact_json(v_old), finance_v3.contact_json(v_new), null);
    end if;
  exception when check_violation or invalid_text_representation or not_null_violation then
    raise exception 'One of the contact values is not valid.' using errcode = 'V3011';
  end;
  return finance_v3.contact_json(v_new);
end;
$$;

create or replace function public.fin3_list_contacts(p_org uuid, p_contact_kind text default null, p_include_inactive boolean default false)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  return coalesce((
    select jsonb_agg(finance_v3.contact_json(c) order by lower(c.name), c.id)
      from finance_v3.contacts_v3 c
     where c.organization_id = p_org
       and (p_contact_kind is null or c.kind = p_contact_kind)
       and (p_include_inactive or c.is_active)), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Service-only: store and fetch generated PDFs (Edge Functions). First writer wins, so a retry never rebuilds differently.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fin3svc_store_document(p_org uuid, p_kind text, p_entity uuid, p_content_base64 text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_bytes bytea;
  d       finance_v3.documents;
begin
  if p_kind not in ('invoice_pdf', 'receipt_pdf') then
    raise exception 'Unknown document kind.' using errcode = 'V3011';
  end if;
  select * into d from finance_v3.documents x where x.organization_id = p_org and x.kind = p_kind and x.entity_id = p_entity;
  if found then
    return jsonb_build_object('id', d.id, 'sha256', d.sha256, 'bytes', d.byte_size, 'created', false);
  end if;
  begin
    v_bytes := decode(p_content_base64, 'base64');
  exception when others then
    raise exception 'The document is not valid base64.' using errcode = 'V3011';
  end;
  if v_bytes is null or octet_length(v_bytes) = 0 or octet_length(v_bytes) > 10485760 or substring(v_bytes from 1 for 5) <> '\x255044462d'::bytea then
    raise exception 'The document is empty, too large or not a PDF.' using errcode = 'V3011';
  end if;
  insert into finance_v3.documents (organization_id, kind, entity_id, sha256, byte_size, content)
  values (p_org, p_kind, p_entity, encode(sha256(v_bytes), 'hex'), octet_length(v_bytes), v_bytes)
  on conflict (organization_id, kind, entity_id) do nothing
  returning * into d;
  if d.id is null then
    select * into d from finance_v3.documents x where x.organization_id = p_org and x.kind = p_kind and x.entity_id = p_entity;
    return jsonb_build_object('id', d.id, 'sha256', d.sha256, 'bytes', d.byte_size, 'created', false);
  end if;
  return jsonb_build_object('id', d.id, 'sha256', d.sha256, 'bytes', d.byte_size, 'created', true);
end;
$$;

create or replace function public.fin3svc_get_document(p_org uuid, p_kind text, p_entity uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare d finance_v3.documents;
begin
  select * into d from finance_v3.documents x where x.organization_id = p_org and x.kind = p_kind and x.entity_id = p_entity;
  if not found then return null; end if;
  return jsonb_build_object('id', d.id, 'sha256', d.sha256, 'bytes', d.byte_size, 'content_base64', encode(d.content, 'base64'));
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Privileges. User RPCs (fin3_*) -> authenticated only; service RPCs (fin3svc_*) -> service_role only; no finance_v3
-- function is executable by a client role (has_permission is re-granted for the RLS policies).
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
