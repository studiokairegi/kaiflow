-- KairFlow Intelligence: core tables. ADDITIVE ONLY (new tables, no changes to existing ones).
-- Requires 20261109090000_intelligence_authorization.sql. Safe to run more than once.
--
-- Access model for EVERY table here:
--   * RLS on; anon/authenticated have no write grants at all.
--   * authenticated users may SELECT only when public.intel_is_authorized(organization_id)
--     (admin AND active Master User of that studio).
--   * All writes go through SECURITY DEFINER RPCs (next migrations): intel_admin_* for the
--     administrator, intel_agent_* for the worker's separate identity.
--   * intel_mail_account holds the encrypted Zoho refresh token: NO client grants at all.
begin;

do $$ begin
  if to_regprocedure('public.intel_is_authorized(uuid)') is null then
    raise exception 'Apply 20261109090000_intelligence_authorization.sql first';
  end if;
end $$;

-- Per-studio settings. One row per organization. Outbound email starts DISABLED (kill_switch)
-- and in shadow mode (every message needs administrator approval).
create table if not exists public.intel_settings (
  organization_id uuid primary key references public.studio_organizations(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete restrict, -- data owner: owns AI leads, receives notifications
  agent_user_id uuid references auth.users(id) on delete set null,          -- the worker's separate identity
  kill_switch boolean not null default true,
  autonomy text not null default 'shadow' check (autonomy in ('shadow','assisted','autonomous')),
  daily_initial_cap int not null default 30 check (daily_initial_cap between 0 and 30),
  daily_followup_cap int not null default 15 check (daily_followup_cap between 0 and 100),
  allow_cap_shift boolean not null default true,
  followup_business_days int not null default 7 check (followup_business_days between 1 and 60),
  max_followups int not null default 1 check (max_followups between 0 and 3),
  warmup_enabled boolean not null default true,
  warmup_started_on date,
  timezone text not null default 'UTC',
  sender_name text not null default '',
  sender_email text not null default '',
  physical_address text not null default '',
  opt_out_text text not null default 'If you would rather not hear from us, reply "unsubscribe" and we will not contact you again.',
  max_auto_replies_per_thread int not null default 2 check (max_auto_replies_per_thread between 0 and 5),
  send_start_hour int not null default 8 check (send_start_hour between 0 and 23),    -- introductions and follow-ups go out only inside this window,
  send_end_hour int not null default 18 check (send_end_hour between 1 and 24),       -- in the studio time zone (end hour is exclusive)
  send_weekdays_only boolean not null default true,
  check (send_start_hour < send_end_hour),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

create table if not exists public.intel_campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  type text not null check (type in ('indie_game_developer','animation_studio_support')),
  name text not null,
  status text not null default 'paused' check (status in ('paused','active')),
  daily_cap int not null default 15 check (daily_cap between 0 and 30),
  criteria jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, type)
);

create table if not exists public.intel_prospects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  campaign_id uuid references public.intel_campaigns(id) on delete set null,
  type text not null check (type in ('indie_game_developer','animation_studio_support')),
  canonical_key text not null,
  name text not null,
  website text not null default '',
  domain text not null default '',
  contact_name text not null default '',
  contact_email text not null default '',
  contact_source_url text not null default '',
  country text not null default '',
  language text not null default 'en',
  status text not null default 'discovered' check (status in
    ('discovered','researched','qualified','needs_review','rejected','lead_linked','contacted','replied','closed','suppressed')),
  score int check (score between 0 and 100),
  score_breakdown jsonb not null default '{}'::jsonb,
  facts jsonb not null default '{}'::jsonb,        -- {verified: {...}, estimates: {...}}: never mixed
  review_reason text not null default '',
  lead_id uuid references public.leads(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, canonical_key)
);
create index if not exists intel_prospects_status_idx on public.intel_prospects(organization_id, status, type);
create index if not exists intel_prospects_lead_idx on public.intel_prospects(lead_id) where lead_id is not null;

create table if not exists public.intel_evidence (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  prospect_id uuid not null references public.intel_prospects(id) on delete cascade,
  source text not null,
  url text not null default '',
  fact_type text not null,
  snippet text not null default '' check (char_length(snippet) <= 2000),
  content_hash text not null default '',
  verified boolean not null default false,        -- true only when the snippet was found verbatim in fetched text
  fetched_at timestamptz not null default now(),
  unique (prospect_id, fact_type, content_hash)
);
create index if not exists intel_evidence_prospect_idx on public.intel_evidence(prospect_id);

create table if not exists public.intel_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  kind text not null check (kind in ('discover','research','qualify','resolve','draft','send','sync_mail','classify','reconcile','followup_scan','retention')),
  payload jsonb not null default '{}'::jsonb,
  state text not null default 'queued' check (state in ('queued','running','succeeded','failed','dead','cancelled')),
  priority int not null default 0,
  run_after timestamptz not null default now(),
  attempts int not null default 0,
  max_attempts int not null default 5,
  lease_until timestamptz,
  locked_by text,
  last_error text,
  result jsonb,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (organization_id, idempotency_key)
);
create index if not exists intel_jobs_claim_idx on public.intel_jobs(organization_id, state, run_after);

create table if not exists public.intel_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  prospect_id uuid references public.intel_prospects(id) on delete set null,
  lead_id uuid references public.leads(id) on delete set null,
  campaign_type text check (campaign_type in ('indie_game_developer','animation_studio_support')),
  direction text not null check (direction in ('outbound','inbound')),
  kind text not null check (kind in ('initial','followup','reply','inbound')),
  step int not null default 0,
  state text not null check (state in
    ('draft','pending_approval','approved','reserved','sending','sent','failed','unknown','received','discarded')),
  to_email text not null default '',
  from_email text not null default '',
  subject text not null default '',
  body_text text not null default '',
  idempotency_key text not null,
  token text,                                     -- unique per outbound message; also sent as an X- header
  rfc_message_id text,
  in_reply_to text,
  references_ids text,
  zoho_message_id text,
  zoho_thread_id text,
  classification text,
  classification_confidence numeric,
  summary text not null default '',
  escalated boolean not null default false,
  auto_sent boolean not null default false,
  send_day date,
  error text,
  created_at timestamptz not null default now(),
  reserved_at timestamptz,
  sent_at timestamptz,
  received_at timestamptz,
  unique (organization_id, idempotency_key)
);
create unique index if not exists intel_messages_zoho_uidx on public.intel_messages(organization_id, zoho_message_id) where zoho_message_id is not null;
create unique index if not exists intel_messages_rfc_uidx on public.intel_messages(organization_id, rfc_message_id) where rfc_message_id is not null;
create unique index if not exists intel_messages_token_uidx on public.intel_messages(token) where token is not null;
-- One live introduction per prospect, and per recipient address, ever.
create unique index if not exists intel_messages_one_initial_per_prospect_uidx
  on public.intel_messages(prospect_id) where kind = 'initial' and state in ('draft','pending_approval','approved','reserved','sending','sent','unknown');
create unique index if not exists intel_messages_one_initial_per_email_uidx
  on public.intel_messages(organization_id, lower(to_email)) where kind = 'initial' and state in ('reserved','sending','sent','unknown');
create index if not exists intel_messages_prospect_idx on public.intel_messages(prospect_id, created_at);
create index if not exists intel_messages_day_idx on public.intel_messages(organization_id, send_day, kind);

create table if not exists public.intel_suppressions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  kind text not null check (kind in ('email','domain')),
  value text not null check (value = lower(btrim(value)) and char_length(value) between 3 and 320),
  reason text not null default '',
  source text not null default 'admin',
  created_at timestamptz not null default now(),
  unique (organization_id, kind, value)
);

-- Append-only audit trail of everything the agent (or the administrator, through Intelligence) does.
create table if not exists public.intel_actions (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  actor text not null check (actor in ('agent','admin','system')),
  actor_user_id uuid,
  action text not null,
  entity_type text not null default '',
  entity_id text not null default '',
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists intel_actions_org_idx on public.intel_actions(organization_id, id desc);
create or replace function public._intel_actions_immutable() returns trigger language plpgsql as $$
begin raise exception 'intel_actions is append-only' using errcode = '42501'; end $$;
drop trigger if exists intel_actions_no_update on public.intel_actions;
create trigger intel_actions_no_update before update or delete on public.intel_actions
  for each row execute function public._intel_actions_immutable();

-- Knowledge base: the agent may use ONLY rows the administrator approved. Editing text un-approves.
create table if not exists public.intel_kb (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  key text not null check (key ~ '^[a-z0-9][a-z0-9_.-]{0,79}$'),
  kind text not null check (kind in ('studio','service','portfolio','faq','policy','template','pricing_guidance','availability')),
  title text not null default '',
  body text not null default '' check (char_length(body) <= 8000),
  approved boolean not null default false,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  version int not null default 1,
  updated_at timestamptz not null default now(),
  unique (organization_id, key)
);

-- Zoho Mail connection. Refresh token is AES-GCM encrypted by an Edge Function (same scheme as Drive).
create table if not exists public.intel_mail_account (
  organization_id uuid primary key references public.studio_organizations(id) on delete cascade,
  provider text not null default 'zoho' check (provider = 'zoho'),
  data_center text not null default 'com',
  account_id text not null default '',
  mailbox text not null default '',
  scope text not null default '',
  refresh_token_enc text,
  status text not null default 'disconnected' check (status in ('disconnected','connected','error')),
  last_error text not null default '',
  connected_at timestamptz,
  last_sync_at timestamptz,
  sync_cursor jsonb not null default '{}'::jsonb
);

create table if not exists public.intel_worker_heartbeat (
  organization_id uuid primary key references public.studio_organizations(id) on delete cascade,
  worker_id text not null,
  last_seen timestamptz not null default now(),
  info jsonb not null default '{}'::jsonb
);

-- RLS + grants ---------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['intel_settings','intel_campaigns','intel_prospects','intel_evidence','intel_jobs',
                           'intel_messages','intel_suppressions','intel_actions','intel_kb','intel_worker_heartbeat'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists intel_select on public.%I', t);
    execute format('create policy intel_select on public.%I for select to authenticated using (public.intel_is_authorized(organization_id))', t);
  end loop;
end $$;

alter table public.intel_mail_account enable row level security;
revoke all on public.intel_mail_account from public, anon, authenticated;   -- secrets: Edge Functions (service role) and definer RPCs only

commit;
