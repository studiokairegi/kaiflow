-- Finance V3, Phase 2 (migration 1 of 3): core schema, reference data, tables, authorization, RLS.
--
-- Isolation (architecture D-01, D-07, D-12): everything lives in the dedicated schema finance_v3. This file never
-- alters, drops or writes any Finance V2 / legacy table; it only READS the tenant tables public.studio_memberships,
-- public.studio_departments and public.studio_department_memberships (inside functions) and references
-- public.studio_organizations / public.studio_memberships by foreign key.
-- Triggers and the posting engine are in migration 2 (20270113091000); public.fin3_* RPCs are in migration 3.
-- Rollback: supabase/rollback/20270113090000_finance_v3_core_schema.rollback.sql (refuses to run if ledger data exists).
--
-- Conventions: money numeric(19,4); FX rate numeric(20,10); errors use SQLSTATE class V3 (contracts/ERROR_CODES).
-- Every object name is schema-qualified on purpose (the repo's isolation guard greps for unqualified table names).

begin;

create schema if not exists finance_v3;
comment on schema finance_v3 is 'Finance V3 ledger. Not exposed through PostgREST; clients call public.fin3_* RPCs only (architecture D-01).';

-- ---------------------------------------------------------------------------------------------------------------
-- Version marker
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists finance_v3.schema_version (
  version    text primary key,
  applied_at timestamptz not null default now(),
  notes      text not null default ''
);
insert into finance_v3.schema_version (version, notes)
values ('20270113090000', 'phase 2 migration 1: core schema, reference data, tables, authorization, RLS')
on conflict (version) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- Permissions (architecture 5.1). Roles come from the existing studio_memberships / department model; no second
-- identity system. Finance access = master_user, Finance/Accounting department admins, and explicit grants.
-- Freelancer and client memberships never receive Finance access in V3.0.
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists finance_v3.permissions (
  key         text primary key check (key ~ '^finance\.[a-z_]+$'),
  description text not null
);
insert into finance_v3.permissions (key, description) values
  ('finance.read',              'Read ledger, reports and audit history'),
  ('finance.post',              'Post and draft journal entries, record FX rates'),
  ('finance.approve',           'Approve and reverse entries'),
  ('finance.pay',               'Make payments (bills, freelancers, expenses, transfers)'),
  ('finance.owner_pay',         'Record owner salary, draws and withdrawals'),
  ('finance.override',          'Override a financial protection block (reason required)'),
  ('finance.admin',             'Chart of accounts, organization settings, period lock, permission grants'),
  ('finance.send_email',        'Send invoice, reminder, overdue and receipt emails'),
  ('finance.collect',           'Create payment links and record collections'),
  ('finance.verify_payment',    'Verify and translate an external payment into an accounting event'),
  ('finance.refund',            'Approve and record refunds'),
  ('finance.view_integrations', 'View email delivery and payment provider records')
on conflict (key) do nothing;

-- role_permissions maps a pseudo-role to its default permissions. 'master_user' is the studio membership role;
-- 'finance_department_admin' is derived: a department_admin who administers a department named Finance/Accounting.
create table if not exists finance_v3.role_permissions (
  role           text not null check (role in ('master_user', 'finance_department_admin')),
  permission_key text not null references finance_v3.permissions(key),
  primary key (role, permission_key)
);
insert into finance_v3.role_permissions (role, permission_key)
select 'master_user', key from finance_v3.permissions
on conflict do nothing;
insert into finance_v3.role_permissions (role, permission_key)
select 'finance_department_admin', k from unnest(array[
  'finance.read','finance.post','finance.approve','finance.pay',
  'finance.send_email','finance.collect','finance.verify_payment','finance.view_integrations'
]) k
on conflict do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- Currencies (ISO 4217). minor_unit drives rounding and the decimals accepted for native amounts.
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists finance_v3.currencies (
  code       text primary key check (code ~ '^[A-Z]{3}$'),
  name       text not null,
  minor_unit smallint not null check (minor_unit between 0 and 4),
  is_active  boolean not null default true
);
insert into finance_v3.currencies (code, name, minor_unit) values
  ('AED','UAE dirham',2),('AFN','Afghan afghani',2),('ALL','Albanian lek',2),('AMD','Armenian dram',2),
  ('ANG','Netherlands Antillean guilder',2),('AOA','Angolan kwanza',2),('ARS','Argentine peso',2),
  ('AUD','Australian dollar',2),('AWG','Aruban florin',2),('AZN','Azerbaijani manat',2),
  ('BAM','Bosnia-Herzegovina convertible mark',2),('BBD','Barbados dollar',2),('BDT','Bangladeshi taka',2),
  ('BGN','Bulgarian lev',2),('BHD','Bahraini dinar',3),('BIF','Burundian franc',0),('BMD','Bermudian dollar',2),
  ('BND','Brunei dollar',2),('BOB','Boliviano',2),('BRL','Brazilian real',2),('BSD','Bahamian dollar',2),
  ('BTN','Bhutanese ngultrum',2),('BWP','Botswana pula',2),('BYN','Belarusian ruble',2),('BZD','Belize dollar',2),
  ('CAD','Canadian dollar',2),('CDF','Congolese franc',2),('CHF','Swiss franc',2),('CLP','Chilean peso',0),
  ('CNY','Chinese yuan',2),('COP','Colombian peso',2),('CRC','Costa Rican colon',2),('CUP','Cuban peso',2),
  ('CVE','Cape Verde escudo',2),('CZK','Czech koruna',2),('DJF','Djiboutian franc',0),('DKK','Danish krone',2),
  ('DOP','Dominican peso',2),('DZD','Algerian dinar',2),('EGP','Egyptian pound',2),('ERN','Eritrean nakfa',2),
  ('ETB','Ethiopian birr',2),('EUR','Euro',2),('FJD','Fiji dollar',2),('FKP','Falkland Islands pound',2),
  ('GBP','Pound sterling',2),('GEL','Georgian lari',2),('GHS','Ghanaian cedi',2),('GIP','Gibraltar pound',2),
  ('GMD','Gambian dalasi',2),('GNF','Guinean franc',0),('GTQ','Guatemalan quetzal',2),('GYD','Guyanese dollar',2),
  ('HKD','Hong Kong dollar',2),('HNL','Honduran lempira',2),('HTG','Haitian gourde',2),('HUF','Hungarian forint',2),
  ('IDR','Indonesian rupiah',2),('ILS','Israeli new shekel',2),('INR','Indian rupee',2),('IQD','Iraqi dinar',3),
  ('IRR','Iranian rial',2),('ISK','Icelandic krona',0),('JMD','Jamaican dollar',2),('JOD','Jordanian dinar',3),
  ('JPY','Japanese yen',0),('KES','Kenyan shilling',2),('KGS','Kyrgyzstani som',2),('KHR','Cambodian riel',2),
  ('KMF','Comorian franc',0),('KPW','North Korean won',2),('KRW','South Korean won',0),('KWD','Kuwaiti dinar',3),
  ('KYD','Cayman Islands dollar',2),('KZT','Kazakhstani tenge',2),('LAK','Lao kip',2),('LBP','Lebanese pound',2),
  ('LKR','Sri Lankan rupee',2),('LRD','Liberian dollar',2),('LSL','Lesotho loti',2),('LYD','Libyan dinar',3),
  ('MAD','Moroccan dirham',2),('MDL','Moldovan leu',2),('MGA','Malagasy ariary',2),('MKD','Macedonian denar',2),
  ('MMK','Myanmar kyat',2),('MNT','Mongolian togrog',2),('MOP','Macanese pataca',2),('MRU','Mauritanian ouguiya',2),
  ('MUR','Mauritian rupee',2),('MVR','Maldivian rufiyaa',2),('MWK','Malawian kwacha',2),('MXN','Mexican peso',2),
  ('MYR','Malaysian ringgit',2),('MZN','Mozambican metical',2),('NAD','Namibian dollar',2),('NGN','Nigerian naira',2),
  ('NIO','Nicaraguan cordoba',2),('NOK','Norwegian krone',2),('NPR','Nepalese rupee',2),('NZD','New Zealand dollar',2),
  ('OMR','Omani rial',3),('PAB','Panamanian balboa',2),('PEN','Peruvian sol',2),('PGK','Papua New Guinean kina',2),
  ('PHP','Philippine peso',2),('PKR','Pakistani rupee',2),('PLN','Polish zloty',2),('PYG','Paraguayan guarani',0),
  ('QAR','Qatari riyal',2),('RON','Romanian leu',2),('RSD','Serbian dinar',2),('RUB','Russian ruble',2),
  ('RWF','Rwandan franc',0),('SAR','Saudi riyal',2),('SBD','Solomon Islands dollar',2),('SCR','Seychelles rupee',2),
  ('SDG','Sudanese pound',2),('SEK','Swedish krona',2),('SGD','Singapore dollar',2),('SHP','Saint Helena pound',2),
  ('SLE','Sierra Leonean leone',2),('SOS','Somali shilling',2),('SRD','Surinamese dollar',2),
  ('SSP','South Sudanese pound',2),('STN','Sao Tome and Principe dobra',2),('SYP','Syrian pound',2),
  ('SZL','Swazi lilangeni',2),('THB','Thai baht',2),('TJS','Tajikistani somoni',2),('TMT','Turkmenistan manat',2),
  ('TND','Tunisian dinar',3),('TOP','Tongan paanga',2),('TRY','Turkish lira',2),('TTD','Trinidad and Tobago dollar',2),
  ('TWD','New Taiwan dollar',2),('TZS','Tanzanian shilling',2),('UAH','Ukrainian hryvnia',2),('UGX','Ugandan shilling',0),
  ('USD','US dollar',2),('UYU','Uruguayan peso',2),('UZS','Uzbekistani som',2),('VES','Venezuelan bolivar',2),
  ('VND','Vietnamese dong',0),('VUV','Vanuatu vatu',0),('WST','Samoan tala',2),('XAF','CFA franc BEAC',0),
  ('XCD','East Caribbean dollar',2),('XOF','CFA franc BCEAO',0),('XPF','CFP franc',0),('YER','Yemeni rial',2),
  ('ZAR','South African rand',2),('ZMW','Zambian kwacha',2),('ZWL','Zimbabwean dollar',2),
  ('ZWG','Zimbabwe Gold',2),('SVC','Salvadoran colon',2),('XCG','Caribbean guilder',2)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- Financial event kinds (architecture 3.5, roadmap 2.G). A kind says who may post it and whether a verified
-- external (provider) event may be translated into it. A provider NEVER posts arbitrary lines: only an internal
-- Finance operation calls finance_v3.post_event, and only for a kind with allows_provider = true.
-- is_enabled = false kinds are reserved for later phases; post_event refuses them.
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists finance_v3.event_kinds (
  kind                text primary key check (kind ~ '^[a-z][a-z0-9_]{2,40}$'),
  description         text not null,
  required_permission text not null references finance_v3.permissions(key),
  allows_provider     boolean not null default false,
  is_enabled          boolean not null default false,
  phase_available     smallint not null default 2
);
insert into finance_v3.event_kinds (kind, description, required_permission, allows_provider, is_enabled, phase_available) values
  ('manual_journal',     'Journal posted by an authorized user',                    'finance.post',           false, true,  2),
  ('reversal',           'Mirror entry that reverses a posted entry',               'finance.approve',        false, true,  2),
  ('client_payment',     'Verified client payment (manual or provider-confirmed)',  'finance.verify_payment', true,  true,  2),
  ('refund_issued',      'Verified refund of a client payment',                     'finance.refund',         true,  true,  2),
  ('adjustment',         'Controlled adjustment (for example attaching a real FX rate)', 'finance.approve',   false, false, 3),
  ('opening_balance',    'Opening balances',                                        'finance.admin',          false, false, 3),
  ('legacy_import',      'Imported legacy (V2) record',                             'finance.admin',          false, false, 3),
  ('invoice_issued',     'Client invoice issued',                                   'finance.post',           false, false, 3),
  ('bill_approved',      'Supplier or freelancer bill approved',                    'finance.approve',        false, false, 3),
  ('bill_payment',       'Payment of a bill',                                       'finance.pay',            false, false, 3),
  ('expense_paid',       'Expense paid',                                            'finance.pay',            false, false, 3),
  ('bank_transfer',      'Transfer between bank or cash accounts',                  'finance.pay',            false, false, 3),
  ('owner_contribution', 'Owner contribution',                                      'finance.owner_pay',      false, false, 4),
  ('owner_draw',         'Owner draw or personal withdrawal',                       'finance.owner_pay',      false, false, 4),
  ('owner_salary',       'Owner salary',                                            'finance.owner_pay',      false, false, 4),
  ('owner_reimbursement','Reimbursement to owner',                                  'finance.owner_pay',      false, false, 4),
  ('animator_obligation','Animator work approved (liability)',                      'finance.approve',        false, false, 4),
  ('animator_payment',   'Payment of an animator obligation',                       'finance.pay',            false, false, 4)
on conflict (kind) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- Organization settings. One row per studio organization. last_entry_no is the gapless entry counter; its row lock
-- also serializes concurrent postings for the organization.
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists finance_v3.org_settings (
  organization_id  uuid primary key references public.studio_organizations(id) on delete restrict,
  base_currency    text not null references finance_v3.currencies(code),
  period_lock_date date,
  engine           text not null default 'v2' check (engine in ('v2', 'v3')),
  default_ui_mode  text not null default 'simple' check (default_ui_mode in ('simple', 'accountant')),
  fx_lookback_days smallint not null default 0 check (fx_lookback_days between 0 and 7),
  last_entry_no    bigint not null default 0 check (last_entry_no >= 0),
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
comment on column finance_v3.org_settings.engine is
  'Which engine accepts new money events (D-09). Phase 2 only stores it; payment re-pointing happens in Phase 7.';
comment on column finance_v3.org_settings.fx_lookback_days is
  'How many days back a stored rate may be used when no rate exists for the exact accounting date. 0 = exact date only.';

-- Explicit per-user grants on top of role defaults.
create table if not exists finance_v3.user_permission_grants (
  organization_id uuid not null,
  user_id         uuid not null,
  permission_key  text not null references finance_v3.permissions(key),
  granted_by      uuid,
  granted_at      timestamptz not null default now(),
  primary key (organization_id, user_id, permission_key),
  foreign key (organization_id, user_id)
    references public.studio_memberships(organization_id, user_id) on delete cascade
);

-- ---------------------------------------------------------------------------------------------------------------
-- Chart of accounts
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists finance_v3.default_chart (
  code        text primary key,
  name        text not null,
  account_type text not null,
  description text not null default '',
  system_key  text unique,
  parent_code text,
  is_postable boolean not null default true,
  currency_is_base boolean not null default false,
  sort_order  integer not null
);
insert into finance_v3.default_chart (code, name, account_type, description, system_key, parent_code, is_postable, currency_is_base, sort_order) values
  -- Assets
  ('1000','Cash and Bank','asset','Parent of all bank, cash and clearing accounts.','cash_and_bank',null,false,false,100),
  ('1010','Operating Bank Account','asset','Main studio bank account (base currency).',null,'1000',true,true,110),
  ('1020','Cash on Hand','asset','Physical cash.',null,'1000',true,true,120),
  ('1030','Business Reserve Account','asset','Optional physical account for the operating reserve. The reserve itself is a logical allocation, not a ledger account.',null,'1000',true,true,130),
  ('1050','Online Payments Clearing','asset','Money collected by a payment provider and not yet settled to the bank. Provider-neutral. Accepts any currency (each currency balances by itself).','payment_clearing','1000',true,false,150),
  ('1100','Accounts Receivable','asset','Amounts clients owe for issued invoices.','accounts_receivable',null,true,false,200),
  ('1200','Prepaid Expenses and Deposits','asset','',null,null,true,false,210),
  ('1300','Freelancer Advances','asset','Money advanced to freelancers or animators before work is approved.',null,null,true,false,220),
  ('1500','Equipment and Computers','asset','Workstations, tablets, screens and other equipment.',null,null,true,false,300),
  -- Liabilities
  ('2000','Accounts Payable','liability','Supplier and contractor bills approved but unpaid.','accounts_payable',null,true,false,1000),
  ('2100','Animator and Freelancer Payables','liability','Approved animator work not yet paid.','animator_payables',null,true,false,1010),
  ('2200','Client Deposits and Unearned Revenue','liability','Money received before work is delivered.','client_deposits',null,true,false,1020),
  ('2300','Sales Tax / VAT Payable','liability','Tax collected from clients and owed to the tax authority.','tax_payable',null,true,false,1030),
  ('2400','Accrued Expenses','liability','',null,null,true,false,1040),
  ('2500','Owner Payable','liability','Business costs the owner paid personally and is owed back.','owner_payable',null,true,false,1050),
  ('2600','Loans Payable','liability','',null,null,true,false,1060),
  -- Equity
  ('3100','Owner Contributions','equity','Money the owner put into the business.','owner_contributions',null,true,false,2100),
  ('3200','Owner Draws','equity','Money the owner took out of the business.','owner_draws',null,true,false,2200),
  ('3300','Opening Balance Equity','equity','Balancing account for opening balances.','opening_balance',null,true,false,2300),
  ('3900','Retained Earnings','equity','Accumulated profit from closed periods. Current-period profit is computed by reports.','retained_earnings',null,true,false,2900),
  -- Revenue
  ('4000','Animation Services Revenue','revenue','Animation production work invoiced to clients.','revenue_animation',null,true,false,3000),
  ('4100','Pre-production Revenue','revenue','Concept, storyboard and design work.',null,null,true,false,3100),
  ('4200','Post-production Revenue','revenue','Compositing, editing and finishing work.',null,null,true,false,3200),
  ('4300','Licensing and Royalties','revenue','',null,null,true,false,3300),
  -- Cost of sales
  ('5000','Animator Costs','cost_of_sales','Cost of animators working on client projects.','cos_animator',null,true,false,4000),
  ('5100','Freelancer and Contractor Costs','cost_of_sales','',null,null,true,false,4100),
  ('5200','Voice, Music and Sound Costs','cost_of_sales','',null,null,true,false,4200),
  ('5300','Rendering and Production Software Costs','cost_of_sales','',null,null,true,false,4300),
  ('5400','Other Direct Production Costs','cost_of_sales','',null,null,true,false,4400),
  -- Operating expenses
  ('6000','Owner Salary','operating_expense','Salary paid to the owner as an expense.','owner_salary',null,true,false,5000),
  ('6100','Rent and Utilities','operating_expense','',null,null,true,false,5100),
  ('6200','Software Subscriptions','operating_expense','',null,null,true,false,5200),
  ('6300','Internet and Telecommunications','operating_expense','',null,null,true,false,5300),
  ('6400','Marketing and Advertising','operating_expense','',null,null,true,false,5400),
  ('6500','Professional Fees','operating_expense','Accounting, legal and consulting fees.',null,null,true,false,5500),
  ('6600','Bank and Payment Processing Fees','operating_expense','Bank charges, payment provider fees and transfer fees.','bank_fees',null,true,false,5600),
  ('6700','Travel and Meals','operating_expense','',null,null,true,false,5700),
  ('6800','Equipment and Supplies','operating_expense','Small equipment and office supplies.',null,null,true,false,5800),
  ('6900','Miscellaneous Expenses','operating_expense','',null,null,true,false,5900),
  -- Other income
  ('7000','Interest Income','other_income','',null,null,true,false,6000),
  ('7100','Realized Foreign Exchange Gain','other_income','Gain when a foreign-currency amount is settled at a better rate than it was recorded.','fx_gain',null,true,false,6100),
  ('7900','Other Income','other_income','',null,null,true,false,6900),
  -- Other expenses
  ('8000','Interest and Finance Charges','other_expense','',null,null,true,false,7000),
  ('8100','Realized Foreign Exchange Loss','other_expense','Loss when a foreign-currency amount is settled at a worse rate than it was recorded.','fx_loss',null,true,false,7100),
  ('8900','Other Expenses','other_expense','',null,null,true,false,7900)
on conflict (code) do nothing;

create table if not exists finance_v3.accounts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references finance_v3.org_settings(organization_id) on delete restrict,
  code            text not null,
  name            text not null,
  account_type    text not null,
  normal_balance  text generated always as (
                    case when account_type in ('asset', 'cost_of_sales', 'operating_expense', 'other_expense')
                         then 'debit' else 'credit' end) stored,
  description     text not null default '',
  parent_id       uuid,
  is_system       boolean not null default false,
  system_key      text,
  is_active       boolean not null default true,
  is_postable     boolean not null default true,
  currency        text references finance_v3.currencies(code),
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint uq_accounts_org_code unique (organization_id, code),
  constraint uq_accounts_org_id unique (organization_id, id),
  constraint fk_accounts_parent foreign key (organization_id, parent_id)
    references finance_v3.accounts (organization_id, id) on delete restrict,
  constraint ck_accounts_type check (account_type in
    ('asset','liability','equity','revenue','cost_of_sales','operating_expense','other_income','other_expense')),
  constraint ck_accounts_code check (code ~ '^[1-8][0-9]{3,9}$'),
  constraint ck_accounts_code_range check (left(code, 1) = case account_type
    when 'asset' then '1' when 'liability' then '2' when 'equity' then '3' when 'revenue' then '4'
    when 'cost_of_sales' then '5' when 'operating_expense' then '6' when 'other_income' then '7'
    when 'other_expense' then '8' end),
  constraint ck_accounts_name check (char_length(btrim(name)) between 1 and 120),
  constraint ck_accounts_description check (char_length(description) <= 500),
  constraint ck_accounts_system check (is_system = (system_key is not null))
);
create unique index if not exists uq_accounts_system_key on finance_v3.accounts (organization_id, system_key) where system_key is not null;
create index if not exists ix_accounts_org_type on finance_v3.accounts (organization_id, account_type, code);

-- ---------------------------------------------------------------------------------------------------------------
-- FX rates. Append-only: a changed rate for the same pair and date is a NEW version. rate = units of the organization
-- base currency per 1 unit of from_currency (base = native * rate).
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists finance_v3.fx_rates (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references finance_v3.org_settings(organization_id) on delete restrict,
  from_currency   text not null references finance_v3.currencies(code),
  to_currency     text not null references finance_v3.currencies(code),
  rate_date       date not null,
  version         integer not null default 1 check (version >= 1),
  rate            numeric(20,10) not null check (rate > 0),
  source          text not null check (source in ('manual', 'provider', 'import')),
  entered_by      uuid,
  created_at      timestamptz not null default now(),
  constraint ck_fx_rates_pair check (from_currency <> to_currency),
  constraint uq_fx_rates_key unique (organization_id, from_currency, to_currency, rate_date, version)
);

-- ---------------------------------------------------------------------------------------------------------------
-- Financial events. (organization_id, idempotency_key) is unique (D-10); (organization_id, provider, provider_ref,
-- kind) is unique so a provider reference can never produce two events of the same kind.
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists finance_v3.events (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references finance_v3.org_settings(organization_id) on delete restrict,
  kind             text not null references finance_v3.event_kinds(kind),
  idempotency_key  text not null,
  request_hash     text not null,
  accounting_date  date not null,
  provider         text,
  provider_ref     text,
  actor            uuid,
  payload          jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  constraint uq_events_org_key unique (organization_id, idempotency_key),
  constraint uq_events_org_id unique (organization_id, id),
  constraint ck_events_key check (char_length(idempotency_key) between 1 and 200 and idempotency_key ~ '^[A-Za-z0-9_.:-]+$'),
  constraint ck_events_provider check (
    (provider is null and provider_ref is null)
    or (provider ~ '^[a-z][a-z0-9_]{1,30}$' and char_length(provider_ref) between 1 and 200)),
  constraint ck_events_hash check (request_hash ~ '^[0-9a-f]{64}$')
);
create unique index if not exists uq_events_provider_ref
  on finance_v3.events (organization_id, provider, provider_ref, kind) where provider is not null;
create index if not exists ix_events_org_created on finance_v3.events (organization_id, created_at desc);

-- ---------------------------------------------------------------------------------------------------------------
-- Journal entries and lines
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists finance_v3.journal_entries (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references finance_v3.org_settings(organization_id) on delete restrict,
  entry_no         bigint,
  status           text not null default 'draft',
  event_id         uuid,
  accounting_date  date not null,
  memo             text,
  reference        text,
  project_id       uuid,
  base_currency    text references finance_v3.currencies(code),
  fx_status        text,
  reverses_entry_id uuid,
  reversal_reason  text,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  posted_by        uuid,
  posted_at        timestamptz,
  updated_at       timestamptz not null default now(),
  constraint uq_je_org_id unique (organization_id, id),
  constraint fk_je_event foreign key (organization_id, event_id)
    references finance_v3.events (organization_id, id) on delete restrict,
  constraint fk_je_reverses foreign key (organization_id, reverses_entry_id)
    references finance_v3.journal_entries (organization_id, id) on delete restrict,
  constraint ck_je_status check (status in ('draft', 'posted')),
  constraint ck_je_date check (accounting_date between date '1990-01-01' and date '2100-12-31'),
  constraint ck_je_memo check (char_length(memo) <= 500),
  constraint ck_je_reference check (char_length(reference) <= 120),
  constraint ck_je_fx_status check (fx_status is null or fx_status in ('native', 'converted', 'missing', 'estimate')),
  constraint ck_je_posted_complete check (status = 'draft' or (
    entry_no is not null and event_id is not null and base_currency is not null
    and fx_status is not null and posted_at is not null)),
  constraint ck_je_draft_clean check (status = 'posted' or (
    entry_no is null and event_id is null and posted_at is null and fx_status is null)),
  constraint ck_je_reversal check ((reverses_entry_id is null) = (reversal_reason is null)),
  constraint ck_je_reversal_reason check (reversal_reason is null or char_length(btrim(reversal_reason)) between 1 and 500)
);
create unique index if not exists uq_je_entry_no on finance_v3.journal_entries (organization_id, entry_no) where entry_no is not null;
create unique index if not exists uq_je_event on finance_v3.journal_entries (event_id) where event_id is not null;
create unique index if not exists uq_je_reverses on finance_v3.journal_entries (organization_id, reverses_entry_id) where reverses_entry_id is not null;
create index if not exists ix_je_org_date on finance_v3.journal_entries (organization_id, accounting_date, id);
create index if not exists ix_je_org_status on finance_v3.journal_entries (organization_id, status);
create index if not exists ix_je_org_project on finance_v3.journal_entries (organization_id, project_id) where project_id is not null;

create table if not exists finance_v3.journal_lines (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null,
  entry_id                 uuid not null,
  line_no                  smallint not null check (line_no between 1 and 500),
  account_id               uuid not null,
  side                     text not null check (side in ('debit', 'credit')),
  amount_native            numeric(19,4) not null check (amount_native > 0),
  currency                 text not null references finance_v3.currencies(code),
  fx_status                text check (fx_status in ('native', 'converted', 'missing', 'estimate')),
  fx_rate                  numeric(20,10),
  fx_rate_date             date,
  fx_source                text check (fx_source in ('manual', 'provider', 'import')),
  amount_base              numeric(19,4) check (amount_base >= 0),
  base_rounding_adjustment numeric(19,4) not null default 0,
  project_id               uuid,
  memo                     text check (char_length(memo) <= 200),
  constraint uq_jl_entry_line unique (entry_id, line_no),
  constraint fk_jl_entry foreign key (organization_id, entry_id)
    references finance_v3.journal_entries (organization_id, id) on delete cascade,
  constraint fk_jl_account foreign key (organization_id, account_id)
    references finance_v3.accounts (organization_id, id) on delete restrict,
  -- A line either has no FX resolution yet (draft), is in the base currency, is converted with a stored
  -- transaction-date rate, or is explicitly flagged missing. Never "1:1 by default" for a foreign currency.
  constraint ck_jl_fx_shape check (
       (fx_status is null     and fx_rate is null and fx_rate_date is null and fx_source is null and amount_base is null and base_rounding_adjustment = 0)
    or (fx_status = 'native'  and fx_rate = 1 and fx_rate_date is null and fx_source is null and amount_base is not null)
    or (fx_status in ('converted', 'estimate') and fx_rate > 0 and fx_rate_date is not null and fx_source is not null and amount_base is not null)
    or (fx_status = 'missing' and fx_rate is null and fx_rate_date is null and fx_source is null and amount_base is null and base_rounding_adjustment = 0))
);
create index if not exists ix_jl_org_account on finance_v3.journal_lines (organization_id, account_id);
create index if not exists ix_jl_entry on finance_v3.journal_lines (entry_id);
create index if not exists ix_jl_org_project on finance_v3.journal_lines (organization_id, project_id) where project_id is not null;

-- ---------------------------------------------------------------------------------------------------------------
-- Audit log: append-only (guard triggers in migration 2; no UPDATE/DELETE privilege for anyone).
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists finance_v3.audit_log (
  id              bigint generated always as identity primary key,
  organization_id uuid not null references finance_v3.org_settings(organization_id) on delete restrict,
  actor           uuid,
  action          text not null,
  object_type     text not null,
  object_id       text,
  before          jsonb,
  after           jsonb,
  reason          text,
  at              timestamptz not null default now()
);
create index if not exists ix_audit_org_at on finance_v3.audit_log (organization_id, at desc, id desc);
create index if not exists ix_audit_org_object on finance_v3.audit_log (organization_id, object_type, object_id);

-- ---------------------------------------------------------------------------------------------------------------
-- Authorization functions (D-02, D-16). The organization is never taken on trust: membership and permission are
-- resolved from studio_memberships for the calling user.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.has_permission_for(p_user uuid, p_org uuid, p_permission text)
returns boolean
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_role   text;
  v_status text;
begin
  if p_user is null or p_org is null or p_permission is null then return false; end if;
  select m.role, m.status into v_role, v_status
    from public.studio_memberships m
   where m.organization_id = p_org and m.user_id = p_user;
  if not found or v_status <> 'active' then return false; end if;
  -- Freelancers and clients never receive Finance access in V3.0, not even through an explicit grant.
  if v_role in ('freelancer', 'client') then return false; end if;
  if not exists (select 1 from finance_v3.permissions p where p.key = p_permission) then return false; end if;
  if v_role = 'master_user' then return true; end if;
  if exists (select 1 from finance_v3.user_permission_grants g
              where g.organization_id = p_org and g.user_id = p_user and g.permission_key = p_permission) then
    return true;
  end if;
  if v_role = 'department_admin'
     and exists (
       select 1
         from public.studio_department_memberships dm
         join public.studio_departments d on d.organization_id = dm.organization_id and d.id = dm.department_id
        where dm.organization_id = p_org and dm.user_id = p_user and dm.department_role = 'admin'
          and regexp_replace(lower(btrim(d.name)), '[^a-z0-9]+', '', 'g') in ('finance', 'accounting'))
     and exists (select 1 from finance_v3.role_permissions rp
                  where rp.role = 'finance_department_admin' and rp.permission_key = p_permission) then
    return true;
  end if;
  return false;
end;
$$;

create or replace function finance_v3.has_permission(p_org uuid, p_permission text)
returns boolean
language sql stable security definer
set search_path = pg_catalog, finance_v3
as $$ select finance_v3.has_permission_for(auth.uid(), p_org, p_permission) $$;

-- Raises V3005 unless the calling user holds the permission in the organization. Returns the user id.
create or replace function finance_v3.assert_permission(p_org uuid, p_permission text)
returns uuid
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'You must be signed in to use Finance.' using errcode = 'V3005';
  end if;
  if not finance_v3.has_permission_for(v_uid, p_org, p_permission) then
    raise exception 'You are not allowed to do this in Finance for this studio.' using errcode = 'V3005';
  end if;
  return v_uid;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Row level security. Defense in depth: clients have SELECT only, filtered by organization + finance.read; every write
-- goes through SECURITY DEFINER RPCs. No FOR ALL policies, no client INSERT/UPDATE/DELETE privilege at all.
-- ---------------------------------------------------------------------------------------------------------------
alter table finance_v3.org_settings           enable row level security;
alter table finance_v3.user_permission_grants enable row level security;
alter table finance_v3.accounts               enable row level security;
alter table finance_v3.fx_rates               enable row level security;
alter table finance_v3.events                 enable row level security;
alter table finance_v3.journal_entries        enable row level security;
alter table finance_v3.journal_lines          enable row level security;
alter table finance_v3.audit_log              enable row level security;

drop policy if exists fin3_select_org_settings on finance_v3.org_settings;
create policy fin3_select_org_settings on finance_v3.org_settings for select to authenticated
  using (finance_v3.has_permission(organization_id, 'finance.read'));
drop policy if exists fin3_select_grants on finance_v3.user_permission_grants;
create policy fin3_select_grants on finance_v3.user_permission_grants for select to authenticated
  using (finance_v3.has_permission(organization_id, 'finance.admin'));
drop policy if exists fin3_select_accounts on finance_v3.accounts;
create policy fin3_select_accounts on finance_v3.accounts for select to authenticated
  using (finance_v3.has_permission(organization_id, 'finance.read'));
drop policy if exists fin3_select_fx_rates on finance_v3.fx_rates;
create policy fin3_select_fx_rates on finance_v3.fx_rates for select to authenticated
  using (finance_v3.has_permission(organization_id, 'finance.read'));
drop policy if exists fin3_select_events on finance_v3.events;
create policy fin3_select_events on finance_v3.events for select to authenticated
  using (finance_v3.has_permission(organization_id, 'finance.read'));
drop policy if exists fin3_select_entries on finance_v3.journal_entries;
create policy fin3_select_entries on finance_v3.journal_entries for select to authenticated
  using (finance_v3.has_permission(organization_id, 'finance.read'));
drop policy if exists fin3_select_lines on finance_v3.journal_lines;
create policy fin3_select_lines on finance_v3.journal_lines for select to authenticated
  using (finance_v3.has_permission(organization_id, 'finance.read'));
drop policy if exists fin3_select_audit on finance_v3.audit_log;
create policy fin3_select_audit on finance_v3.audit_log for select to authenticated
  using (finance_v3.has_permission(organization_id, 'finance.read'));

-- Privileges. Start from nothing, then grant read-only access to RLS-protected tables and reference data.
revoke all on all tables in schema finance_v3 from public, anon, authenticated, service_role;
revoke all on schema finance_v3 from public, anon, service_role;
grant usage on schema finance_v3 to authenticated;
grant select on finance_v3.org_settings, finance_v3.user_permission_grants, finance_v3.accounts,
  finance_v3.fx_rates, finance_v3.events, finance_v3.journal_entries, finance_v3.journal_lines,
  finance_v3.audit_log, finance_v3.currencies, finance_v3.permissions, finance_v3.role_permissions,
  finance_v3.event_kinds, finance_v3.default_chart to authenticated;

-- Functions: PostgreSQL grants EXECUTE to PUBLIC by default. Remove it, then grant only what policies need.
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
