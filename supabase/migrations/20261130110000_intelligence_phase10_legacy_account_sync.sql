-- Phase 10 corrective migration: keep legacy Gmail/Zoho OAuth callbacks and the
-- authoritative dynamic provider-account registry synchronized. Credentials remain
-- encrypted and account send permissions are never enabled by this bridge.
begin;

create or replace function public.intel_sync_legacy_mail_account_to_registry()
returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_provider text;
  v_mailbox text;
  v_status text;
  v_ciphertext text;
  v_account_id text;
  v_scope text;
  v_dc text;
  v_connected_at timestamptz;
begin
  if tg_op = 'DELETE' then
    update public.intel_provider_accounts
       set status = 'disconnected', disconnected_at = now(), updated_at = now(),
           last_error = 'Legacy mailbox connection was removed.'
     where organization_id = old.organization_id
       and provider_key = old.provider
       and mailbox = lower(btrim(coalesce(old.mailbox, '')));
    return old;
  end if;

  if tg_op = 'UPDATE' and (old.provider is distinct from new.provider
      or lower(btrim(coalesce(old.mailbox, ''))) is distinct from lower(btrim(coalesce(new.mailbox, '')))) then
    update public.intel_provider_accounts
       set status = 'disconnected', disconnected_at = now(), updated_at = now(),
           last_error = 'Legacy mailbox identity was replaced.'
     where organization_id = old.organization_id
       and provider_key = old.provider
       and mailbox = lower(btrim(coalesce(old.mailbox, '')));
  end if;

  v_provider := new.provider;
  v_mailbox := lower(btrim(coalesce(new.mailbox, '')));
  v_ciphertext := new.refresh_token_enc;
  v_status := case when new.status = 'connected' and nullif(v_ciphertext, '') is not null
                   then 'connected' else 'disconnected' end;
  v_account_id := coalesce(new.account_id, '');
  v_scope := coalesce(new.scope, '');
  v_dc := coalesce(new.data_center, '');
  v_connected_at := coalesce(new.connected_at, now());

  if v_provider not in ('gmail','zoho') or v_mailbox = '' or v_ciphertext is null then
    return new;
  end if;

  insert into public.intel_provider_accounts(
    organization_id, provider_key, external_account_id, mailbox, display_name,
    auth_method, scopes, data_center, credentials_ciphertext, status,
    health_status, is_enabled, send_enabled, connected_at, last_error, updated_at
  ) values (
    new.organization_id, v_provider, v_account_id, v_mailbox, '', 'oauth2',
    v_scope, v_dc, v_ciphertext, v_status, 'unknown', false, false,
    v_connected_at, coalesce(new.last_error, ''), now()
  )
  on conflict (organization_id, provider_key, mailbox) do update set
    external_account_id = excluded.external_account_id,
    auth_method = excluded.auth_method,
    scopes = excluded.scopes,
    data_center = excluded.data_center,
    credentials_ciphertext = excluded.credentials_ciphertext,
    status = excluded.status,
    connected_at = excluded.connected_at,
    disconnected_at = case when excluded.status = 'connected' then null else now() end,
    last_error = excluded.last_error,
    updated_at = now();
  -- is_enabled and send_enabled intentionally stay at their existing values on
  -- re-authentication, and default false for newly bridged accounts.
  return new;
end $$;

revoke all on function public.intel_sync_legacy_mail_account_to_registry() from public, anon, authenticated;

drop trigger if exists intel_legacy_mail_account_registry_sync on public.intel_mail_account;
create trigger intel_legacy_mail_account_registry_sync
after insert or update or delete on public.intel_mail_account
for each row execute function public.intel_sync_legacy_mail_account_to_registry();

-- Backfill legacy rows created between the original registry migration and this fix.
insert into public.intel_provider_accounts(
  organization_id, provider_key, external_account_id, mailbox, display_name,
  auth_method, scopes, data_center, credentials_ciphertext, status,
  health_status, is_enabled, send_enabled, connected_at, last_error, updated_at
)
select a.organization_id, a.provider, coalesce(a.account_id, ''), lower(btrim(a.mailbox)), '',
       'oauth2', coalesce(a.scope, ''), coalesce(a.data_center, ''), a.refresh_token_enc,
       case when a.status = 'connected' and a.refresh_token_enc is not null then 'connected' else 'disconnected' end,
       'unknown', false, false, coalesce(a.connected_at, now()), coalesce(a.last_error, ''), now()
from public.intel_mail_account a
where a.provider in ('gmail','zoho') and nullif(btrim(a.mailbox), '') is not null
  and a.refresh_token_enc is not null
on conflict (organization_id, provider_key, mailbox) do update set
  external_account_id = excluded.external_account_id,
  scopes = excluded.scopes,
  data_center = excluded.data_center,
  credentials_ciphertext = excluded.credentials_ciphertext,
  status = excluded.status,
  connected_at = excluded.connected_at,
  disconnected_at = case when excluded.status = 'connected' then null else now() end,
  last_error = excluded.last_error,
  updated_at = now();

commit;
