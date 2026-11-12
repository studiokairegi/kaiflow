-- Shared Intelligence mailbox identity for the central Inbox.
-- Additive, forward-only: no mailbox credentials or message history are copied or deleted.
-- The UUID in email_accounts is deliberately the UUID from intel_provider_accounts.
begin;

do $$
begin
  if to_regclass('public.intel_provider_accounts') is null
     or to_regclass('public.intel_email_provider_registry') is null
     or to_regclass('public.email_accounts') is null
     or to_regclass('public.email_provider_registry') is null then
    raise exception 'Apply Intelligence provider-account and Email Inbox migrations before shared-account integration';
  end if;
end $$;

-- A single Intelligence account identity is projected into the Inbox's existing FK surface.
-- No OAuth state, token or password is copied into email_provider_credentials.
alter table public.email_accounts
  add column if not exists source_provider_account_id uuid;

do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.email_accounts'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%provider%'
  loop
    execute format('alter table public.email_accounts drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.email_accounts
  drop constraint if exists email_accounts_provider_shared_check;
alter table public.email_accounts
  add constraint email_accounts_provider_shared_check
  check (provider in ('resend','gmail','zoho','smtp'));

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.email_accounts'::regclass
       and conname = 'email_accounts_source_provider_account_fk'
  ) then
    alter table public.email_accounts
      add constraint email_accounts_source_provider_account_fk
      foreign key (organization_id, source_provider_account_id)
      references public.intel_provider_accounts(organization_id, id) on delete restrict;
  end if;
end $$;

create unique index if not exists email_accounts_source_provider_account_uidx
  on public.email_accounts(source_provider_account_id)
  where source_provider_account_id is not null;

-- Registry identities are present for FK integrity and account discovery, but are deliberately
-- disabled until a reviewed Inbox adapter/gateway is deployed. Capabilities remain false.
insert into public.email_provider_registry (
  provider_key, adapter_key, display_name, capabilities, enabled, sort_order, note
) values
  ('gmail', 'gmail', 'Gmail',
   jsonb_build_object('send',false,'remote_sync',false,'remote_search',false,'remote_folders',false,'oauth',false),
   false, 20, 'Shared Intelligence account identity; Inbox adapter gateway not yet enabled.'),
  ('zoho', 'zoho', 'Zoho Mail',
   jsonb_build_object('send',false,'remote_sync',false,'remote_search',false,'remote_folders',false,'oauth',false),
   false, 30, 'Manual correspondence only; Inbox adapter gateway not yet enabled.'),
  ('smtp', 'smtp', 'SMTP / IMAP',
   jsonb_build_object('send',false,'remote_sync',false,'remote_search',false,'remote_folders',false,'oauth',false),
   false, 40, 'SMTP submission exists in Intelligence; IMAP receiving and Inbox gateway are not yet enabled.')
on conflict (provider_key) do update set
  adapter_key = excluded.adapter_key,
  display_name = excluded.display_name,
  capabilities = excluded.capabilities,
  enabled = false,
  note = excluded.note,
  updated_at = now();

-- Do not silently merge distinct mailbox IDs if an older Inbox account already owns the address.
do $$
begin
  if exists (
    select 1
      from public.intel_provider_accounts i
      join public.email_accounts e
        on e.organization_id = i.organization_id
       and e.provider = i.provider_key
       and lower(e.address) = lower(i.mailbox)
       and e.id <> i.id
     where i.provider_key in ('gmail','zoho','smtp')
  ) then
    raise exception 'Shared mailbox migration blocked: an Intelligence mailbox address already exists under a different Inbox account ID. Reconcile that mailbox history before retrying.';
  end if;
end $$;

create or replace function public.email_project_intelligence_account()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_connection text;
  v_status text;
begin
  if new.provider_key not in ('gmail','zoho','smtp') then
    return new;
  end if;

  v_connection := case
    when new.status = 'connected' then 'connected'
    when new.status in ('revoked','disconnected') then 'disconnected'
    when new.status = 'error' then 'reauthorization_required'
    else 'not_connected'
  end;
  v_status := case when v_connection = 'connected' then 'active' else 'paused' end;

  insert into public.email_accounts (
    id, organization_id, provider, address, display_name, status,
    connection_status, connected_at, last_validated_at, last_connection_error,
    source_provider_account_id
  ) values (
    new.id, new.organization_id, new.provider_key, lower(btrim(new.mailbox)),
    coalesce(nullif(new.display_name,''), new.mailbox), v_status,
    v_connection, new.connected_at, new.last_health_check_at,
    coalesce(new.last_error,''), new.id
  )
  on conflict (id) do update set
    organization_id = excluded.organization_id,
    provider = excluded.provider,
    address = excluded.address,
    display_name = excluded.display_name,
    status = excluded.status,
    connection_status = excluded.connection_status,
    connected_at = excluded.connected_at,
    last_validated_at = excluded.last_validated_at,
    last_connection_error = excluded.last_connection_error,
    source_provider_account_id = excluded.source_provider_account_id;

  return new;
end;
$$;

drop trigger if exists intel_provider_account_email_projection on public.intel_provider_accounts;
create trigger intel_provider_account_email_projection
after insert or update of organization_id, provider_key, mailbox, display_name, status,
  last_error, connected_at, last_health_check_at
on public.intel_provider_accounts
for each row execute function public.email_project_intelligence_account();

-- Backfill account identity only. Credentials remain solely in intel_provider_accounts.
insert into public.email_accounts (
  id, organization_id, provider, address, display_name, status,
  connection_status, connected_at, last_validated_at, last_connection_error,
  source_provider_account_id
)
select
  i.id, i.organization_id, i.provider_key, lower(btrim(i.mailbox)),
  coalesce(nullif(i.display_name,''), i.mailbox),
  case when i.status = 'connected' then 'active' else 'paused' end,
  case
    when i.status = 'connected' then 'connected'
    when i.status in ('revoked','disconnected') then 'disconnected'
    when i.status = 'error' then 'reauthorization_required'
    else 'not_connected'
  end,
  i.connected_at, i.last_health_check_at, coalesce(i.last_error,''), i.id
from public.intel_provider_accounts i
where i.provider_key in ('gmail','zoho','smtp')
on conflict (id) do update set
  organization_id = excluded.organization_id,
  provider = excluded.provider,
  address = excluded.address,
  display_name = excluded.display_name,
  status = excluded.status,
  connection_status = excluded.connection_status,
  connected_at = excluded.connected_at,
  last_validated_at = excluded.last_validated_at,
  last_connection_error = excluded.last_connection_error,
  source_provider_account_id = excluded.source_provider_account_id;

-- Resend is not an Inbox provider. Keep its registry row and historical messages for referential
-- integrity, but disable its Inbox capabilities and sending flag. Intelligence transactional
-- Resend endpoints use their separate service and are not changed here.
update public.email_provider_registry
   set enabled = false,
       capabilities = jsonb_build_object(
         'send', false, 'inbound_webhook', false, 'delivery_events', false,
         'attachments_send', false, 'attachments_receive', false,
         'threading_headers', false, 'drafts_local', false,
         'remote_sync', false, 'remote_search', false, 'remote_folders', false,
         'remote_drafts', false, 'oauth', false
       ),
       note = 'Excluded from central Inbox. Transactional Resend integrations remain separate.',
       updated_at = now()
 where provider_key = 'resend';

update public.email_provider_flags set enabled = false, note = 'Excluded from central Inbox; transactional Resend is separate.', updated_at = now()
 where provider = 'resend';

-- Zoho is a manual-correspondence provider only. This is enforced by the authoritative DB
-- capability manifest and each account's allowed-purpose list, not merely by the UI.
update public.intel_email_provider_registry
   set manifest = jsonb_set(
     coalesce(manifest, '{}'::jsonb),
     '{message_purposes}',
     '["business_correspondence"]'::jsonb,
     true
   ),
   updated_at = now()
 where provider_key = 'zoho';

update public.intel_provider_accounts
   set allowed_message_purposes = array['business_correspondence']::text[],
       updated_at = now()
 where provider_key = 'zoho'
   and allowed_message_purposes is distinct from array['business_correspondence']::text[];

-- The old Inbox-only account creation RPC is no longer a valid connection path.
-- Settings/Intelligence remains the only place that can create or authorize mailbox accounts.
create or replace function public.email_upsert_account(
  p_address text, p_display_name text default '', p_provider text default 'resend'
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.email_require_access();
begin
  -- Retain explicit caller-organization scope even though this legacy endpoint is now denied.
  perform 1 from public.email_accounts where organization_id = v_org limit 1;
  raise exception 'Mailbox accounts must be connected in Settings → Intelligence. The Inbox cannot create a separate account.';
end;
$$;
revoke all on function public.email_upsert_account(text,text,text) from public, anon, authenticated;

commit;
