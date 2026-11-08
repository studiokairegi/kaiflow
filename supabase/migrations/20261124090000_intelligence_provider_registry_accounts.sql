-- KairFlow Intelligence Phase 2.1/2.2: dynamic adapter catalogue and multi-account storage.
-- Additive only. Existing singleton intel_mail_account rows and credentials are preserved.
-- Newly connected accounts default to disabled for sending; activation belongs to the later
-- dispatcher/control-plane phase. This migration does not send mail or change the kill switch.
begin;

do $$ begin
  if to_regclass('public.intel_settings') is null
     or to_regclass('public.intel_messages') is null
     or to_regclass('public.studio_organizations') is null then
    raise exception 'Apply the existing Intelligence migrations before Phase 2 provider foundation';
  end if;
end $$;

create table if not exists public.intel_email_provider_registry (
  provider_key text primary key check (provider_key ~ '^[a-z][a-z0-9_-]{0,63}$'),
  adapter_key text not null check (adapter_key ~ '^[a-z][a-z0-9_.-]{0,95}$'),
  display_name text not null,
  adapter_version text not null default '1.0.0',
  manifest jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  sending_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.intel_provider_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  provider_key text not null references public.intel_email_provider_registry(provider_key),
  external_account_id text not null default '',
  mailbox text not null check (mailbox = lower(btrim(mailbox)) and char_length(mailbox) between 3 and 320),
  display_name text not null default '',
  auth_method text not null,
  scopes text not null default '',
  data_center text not null default '',
  credentials_ciphertext text not null,
  credential_version smallint not null default 1 check (credential_version > 0),
  status text not null default 'connected' check (status in ('pending','connected','error','disconnected','revoked')),
  health_status text not null default 'unknown' check (health_status in ('unknown','healthy','degraded','unhealthy')),
  is_enabled boolean not null default false,
  send_enabled boolean not null default false,
  allowed_message_purposes text[] not null default array['business_correspondence']::text[],
  daily_send_limit integer check (daily_send_limit is null or daily_send_limit > 0),
  hourly_send_limit integer check (hourly_send_limit is null or hourly_send_limit > 0),
  minute_send_limit integer check (minute_send_limit is null or minute_send_limit > 0),
  sync_cursor jsonb not null default '{}'::jsonb,
  last_sync_at timestamptz,
  last_health_check_at timestamptz,
  last_error text not null default '',
  connected_by uuid references auth.users(id) on delete set null,
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider_key, mailbox),
  unique (organization_id, id)
);

create index if not exists intel_provider_accounts_org_provider_idx
  on public.intel_provider_accounts(organization_id, provider_key, status, is_enabled);
create index if not exists intel_provider_accounts_health_idx
  on public.intel_provider_accounts(organization_id, health_status, updated_at desc);

create table if not exists public.intel_provider_oauth_states (
  state uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider_key text not null references public.intel_email_provider_registry(provider_key),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  used_at timestamptz
);
create index if not exists intel_provider_oauth_states_expiry_idx
  on public.intel_provider_oauth_states(expires_at) where used_at is null;

alter table public.intel_messages
  add column if not exists provider_account_id uuid,
  add column if not exists provider_key text,
  add column if not exists provider_message_id text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'intel_messages_provider_account_fk') then
    alter table public.intel_messages add constraint intel_messages_provider_account_fk
      foreign key (organization_id, provider_account_id)
      references public.intel_provider_accounts(organization_id, id) on delete restrict;
  end if;
end $$;
create index if not exists intel_messages_provider_account_idx
  on public.intel_messages(organization_id, provider_account_id, created_at desc)
  where provider_account_id is not null;
drop index if exists public.intel_messages_provider_uidx;
create unique index if not exists intel_messages_provider_account_message_uidx
  on public.intel_messages(organization_id, provider_key, provider_account_id, provider_message_id)
  where provider_key is not null and provider_account_id is not null and provider_message_id is not null;

-- Only adapters with reviewed server-side code are registered. The database manifest is descriptive,
-- never executable. Resend is intentionally excluded from the prospect communication catalogue.
insert into public.intel_email_provider_registry(provider_key, adapter_key, display_name, adapter_version, manifest, enabled, sending_enabled)
values
  ('gmail', 'gmail', 'Gmail', '1.0.0',
   '{"capabilities":["send","receive","threading","sent-reconciliation","connection-test"],"auth_methods":["oauth2"],"supports_multiple_accounts":true,"message_purposes":["business_correspondence","consented_prospecting"]}'::jsonb, true, false),
  ('zoho', 'zoho', 'Zoho Mail', '1.0.0',
   '{"capabilities":["send","receive","threading","sent-reconciliation","connection-test"],"auth_methods":["oauth2"],"supports_multiple_accounts":false,"message_purposes":["business_correspondence"]}'::jsonb, true, false)
on conflict (provider_key) do update set
  adapter_key = excluded.adapter_key,
  display_name = excluded.display_name,
  adapter_version = excluded.adapter_version,
  manifest = excluded.manifest,
  enabled = excluded.enabled,
  updated_at = now();

-- Preserve and expose existing single-mailbox connections as account records without deleting or
-- changing the legacy rows. The ciphertext remains encrypted and is never returned by an RPC.
insert into public.intel_provider_accounts(
  organization_id, provider_key, external_account_id, mailbox, auth_method, scopes,
  data_center, credentials_ciphertext, status, health_status, is_enabled, send_enabled,
  connected_at, last_error
)
select a.organization_id, a.provider, coalesce(a.account_id, ''), lower(btrim(a.mailbox)), 'oauth2',
       coalesce(a.scope, ''), coalesce(a.data_center, ''), a.refresh_token_enc,
       case when a.status = 'connected' and a.refresh_token_enc is not null then 'connected' else 'disconnected' end,
       'unknown', false, false, coalesce(a.connected_at, now()), coalesce(a.last_error, '')
  from public.intel_mail_account a
 where a.provider in ('gmail','zoho')
   and nullif(btrim(a.mailbox), '') is not null
   and a.refresh_token_enc is not null
on conflict (organization_id, provider_key, mailbox) do nothing;

alter table public.intel_email_provider_registry enable row level security;
revoke all on public.intel_email_provider_registry from public, anon, authenticated;
grant all on public.intel_email_provider_registry to service_role;

alter table public.intel_provider_accounts enable row level security;
revoke all on public.intel_provider_accounts from public, anon, authenticated;
grant all on public.intel_provider_accounts to service_role;

alter table public.intel_provider_oauth_states enable row level security;
revoke all on public.intel_provider_oauth_states from public, anon, authenticated;
grant all on public.intel_provider_oauth_states to service_role;

create or replace function public.intel_admin_provider_catalog() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_admin_org();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'provider_key', r.provider_key, 'display_name', r.display_name,
      'adapter_version', r.adapter_version, 'manifest', r.manifest, 'enabled', r.enabled, 'sending_enabled', r.sending_enabled
    ) order by r.display_name)
    from public.intel_email_provider_registry r where r.enabled is true
  ), '[]'::jsonb);
end $$;
revoke all on function public.intel_admin_provider_catalog() from public, anon;
grant execute on function public.intel_admin_provider_catalog() to authenticated;

create or replace function public.intel_admin_provider_accounts() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_admin_org();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id, 'provider_key', a.provider_key, 'mailbox', a.mailbox,
      'display_name', a.display_name, 'auth_method', a.auth_method,
      'status', a.status, 'health_status', a.health_status,
      'is_enabled', a.is_enabled, 'send_enabled', a.send_enabled,
      'allowed_message_purposes', a.allowed_message_purposes,
      'daily_send_limit', a.daily_send_limit, 'hourly_send_limit', a.hourly_send_limit,
      'minute_send_limit', a.minute_send_limit, 'last_sync_at', a.last_sync_at,
      'last_health_check_at', a.last_health_check_at, 'last_error', a.last_error,
      'connected_at', a.connected_at, 'updated_at', a.updated_at
    ) order by a.created_at)
    from public.intel_provider_accounts a where a.organization_id = v_org
  ), '[]'::jsonb);
end $$;
revoke all on function public.intel_admin_provider_accounts() from public, anon;
grant execute on function public.intel_admin_provider_accounts() to authenticated;

create or replace function public.intel_agent_provider_accounts() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id, 'provider_key', a.provider_key, 'mailbox', a.mailbox,
      'external_account_id', a.external_account_id, 'status', a.status,
      'health_status', a.health_status, 'is_enabled', a.is_enabled,
      'send_enabled', a.send_enabled, 'allowed_message_purposes', a.allowed_message_purposes,
      'daily_send_limit', a.daily_send_limit, 'hourly_send_limit', a.hourly_send_limit,
      'minute_send_limit', a.minute_send_limit, 'sync_cursor', a.sync_cursor,
      'last_sync_at', a.last_sync_at
    ) order by a.created_at)
    from public.intel_provider_accounts a
    join public.intel_email_provider_registry r on r.provider_key = a.provider_key and r.enabled is true
    where a.organization_id = v_org and a.status = 'connected' and a.is_enabled is true
  ), '[]'::jsonb);
end $$;
revoke all on function public.intel_agent_provider_accounts() from public, anon;
grant execute on function public.intel_agent_provider_accounts() to authenticated;

-- Preserve legacy provider pause flags. Existing Gmail/Zoho/Resend routes continue to obey
-- their current flag exactly as before. For a provider without a legacy flag row, the dynamic
-- registry's sending_enabled value is the fail-closed default.
create or replace function public.email_provider_enabled(p_provider text) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select coalesce(
    (select f.enabled from public.email_provider_flags f where f.provider = p_provider),
    (select r.sending_enabled from public.intel_email_provider_registry r where r.provider_key = p_provider),
    false
  )
$$;
revoke all on function public.email_provider_enabled(text) from public, anon;
grant execute on function public.email_provider_enabled(text) to authenticated, service_role;

commit;
