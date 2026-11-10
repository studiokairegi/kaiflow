-- Remove the legacy single-mailbox Gmail/Zoho bridge. The provider-account registry
-- (intel_provider_accounts) becomes the only source of truth for Gmail, Zoho Mail and SMTP.
-- Resend is a separate server-side integration and is not touched here.
--
-- Safe to apply once and safe to re-run. Nothing is sent, no provider gate or send flag is
-- changed, and kill_switch / autonomy are not modified by this migration.
begin;

do $$ begin
  if to_regclass('public.intel_provider_accounts') is null then
    raise exception 'Apply the provider-registry migrations first (intel_provider_accounts is missing)';
  end if;
end $$;

-- 1. Final idempotent backfill so no connected legacy credential is lost, then verify it.
do $$
declare v_missing integer;
begin
  if to_regclass('public.intel_mail_account') is null then return; end if;

  execute $q$
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
    on conflict (organization_id, provider_key, mailbox) do nothing
  $q$;

  execute $q$
    select count(*) from public.intel_mail_account a
     where a.provider in ('gmail','zoho') and nullif(btrim(a.mailbox), '') is not null
       and a.refresh_token_enc is not null
       and not exists (select 1 from public.intel_provider_accounts p
                        where p.organization_id = a.organization_id and p.provider_key = a.provider
                          and p.mailbox = lower(btrim(a.mailbox)))
  $q$ into v_missing;
  if v_missing > 0 then
    raise exception 'Refusing to drop legacy mailbox table: % legacy account(s) are not in the provider registry', v_missing;
  end if;
end $$;

-- 2. Stop mirroring the legacy table into the registry.
drop trigger if exists intel_legacy_mail_account_registry_sync on public.intel_mail_account;
drop function if exists public.intel_sync_legacy_mail_account_to_registry();

-- 3. Registry-only mail status.
create or replace function public.intel_admin_mail_status() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.intel_admin_org();
  v_accounts jsonb;
  v_count integer;
begin
  select count(*), coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id, 'provider', a.provider_key, 'provider_key', a.provider_key,
    'mailbox', a.mailbox, 'status', a.status, 'health_status', a.health_status,
    'is_enabled', a.is_enabled, 'send_enabled', a.send_enabled,
    'sending_eligible', coalesce((a.status = 'connected' and a.is_enabled and a.send_enabled
      and r.enabled and r.sending_enabled and a.health_status in ('unknown','healthy')), false),
    'provider_gate_enabled', r.enabled, 'provider_gate_sending_enabled', r.sending_enabled,
    'last_sync_at', a.last_sync_at, 'last_health_check_at', a.last_health_check_at,
    'last_error', a.last_error
  ) order by a.created_at), '[]'::jsonb)
    into v_count, v_accounts
    from public.intel_provider_accounts a
    left join public.intel_email_provider_registry r on r.provider_key = a.provider_key
   where a.organization_id = v_org;

  if v_count = 0 then
    return jsonb_build_object('status', 'disconnected', 'accounts', '[]'::jsonb,
                              'source_of_truth', 'intel_provider_accounts');
  end if;
  return jsonb_build_object(
    'status', case when exists (
      select 1 from public.intel_provider_accounts a
       where a.organization_id = v_org and a.status = 'connected'
    ) then 'connected' else 'disconnected' end,
    'sending_eligible', exists (
      select 1 from public.intel_provider_accounts a
      join public.intel_email_provider_registry r on r.provider_key = a.provider_key
      where a.organization_id = v_org and a.provider_key in ('gmail','zoho','smtp')
        and a.status = 'connected' and a.is_enabled and a.send_enabled
        and r.enabled and r.sending_enabled and a.health_status in ('unknown','healthy')
    ),
    'provider', case when v_count = 1 then v_accounts->0->>'provider_key' else 'multiple' end,
    'mailbox', case when v_count = 1 then v_accounts->0->>'mailbox' else null end,
    'accounts', v_accounts,
    'source_of_truth', 'intel_provider_accounts'
  );
end $$;
revoke all on function public.intel_admin_mail_status() from public, anon;
grant execute on function public.intel_admin_mail_status() to authenticated;

-- 4. Disconnect now acts on the registry: every account is disconnected and send-disabled,
--    and the emergency stop is switched ON. Stored credentials are left in place.
create or replace function public.intel_admin_disconnect_mail() returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_admin_org();
begin
  update public.intel_provider_accounts
     set status = 'disconnected', is_enabled = false, send_enabled = false,
         disconnected_at = now(), updated_at = now(), last_error = ''
   where organization_id = v_org and provider_key in ('gmail','zoho','smtp');
  update public.intel_settings set kill_switch = true, updated_at = now(), updated_by = auth.uid() where organization_id = v_org;
  perform public._intel_log(v_org, 'admin', 'disconnect_mail', 'mail', v_org::text, '{}'::jsonb);
  return jsonb_build_object('status', 'disconnected', 'kill_switch', true);
end $$;
revoke all on function public.intel_admin_disconnect_mail() from public, anon;
grant execute on function public.intel_admin_disconnect_mail() to authenticated;

-- 5. Provider assignment: registry accounts only. No singleton fallback.
create or replace function public.intel_agent_assign_provider_account(p_message_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_org uuid:=public.intel_agent_org(); m public.intel_messages; a public.intel_provider_accounts;
  v_purpose text; v_provider text; v_now timestamptz:=clock_timestamp();
  v_daily int; v_hourly int; v_minute int;
begin
  select * into m from public.intel_messages where organization_id=v_org and id=p_message_id for update;
  if not found then return public._intel_deny('not_found'); end if;
  if m.state <> 'reserved' then return public._intel_deny('not_reserved'); end if;

  v_purpose:=case when m.kind in ('initial','followup') then 'consented_prospecting' else 'business_correspondence' end;
  if v_purpose='consented_prospecting' and not exists (
    select 1 from public.intel_contact_permissions cp
     where cp.organization_id=v_org and cp.email=public.intel_norm_email(m.to_email)
       and cp.purpose=v_purpose and cp.status='granted' and cp.revoked_at is null
       and cp.granted_at <= v_now
  ) then return public._intel_deny('prospecting_consent_required'); end if;
  if v_purpose='business_correspondence' and not exists (
    select 1 from public.intel_messages inbound
     where inbound.organization_id=v_org and inbound.direction='inbound'
       and public.intel_norm_email(inbound.from_email)=public.intel_norm_email(m.to_email)
  ) then return public._intel_deny('business_correspondence_context_required'); end if;

  if m.provider_account_id is not null then
    select * into a from public.intel_provider_accounts
     where organization_id=v_org and id=m.provider_account_id for update;
    if not found or a.status <> 'connected' or not a.is_enabled or not a.send_enabled
       or not (v_purpose = any(a.allowed_message_purposes))
       or not exists(select 1 from public.intel_email_provider_registry pr where pr.provider_key=a.provider_key and pr.enabled and pr.sending_enabled and coalesce(pr.manifest->'message_purposes','[]'::jsonb) ? v_purpose)
       or not public.email_provider_enabled(a.provider_key) then return public._intel_deny('assigned_account_disabled'); end if;
    if a.provider_key='zoho' and v_purpose='consented_prospecting' and m.auto_sent then
      update public.intel_messages set state='pending_approval',send_day=null,reserved_at=null,error='Zoho outreach requires explicit human approval' where id=m.id and state='reserved';
      update public.intel_settings set send_slot_message_id=null,send_slot_until=null where organization_id=v_org and send_slot_message_id=m.id;
      return jsonb_build_object('ok',false,'reason','zoho_human_approval_required');
    end if;
  else
    -- Deterministic load-aware choice: least recently used, then lowest rolling daily usage, then UUID.
    select pa.* into a
      from public.intel_provider_accounts pa
      join public.intel_email_provider_registry pr on pr.provider_key=pa.provider_key
     where pa.organization_id=v_org and pa.status='connected' and pa.is_enabled and pa.send_enabled
       and pr.enabled and pr.sending_enabled
       and coalesce((pr.manifest->>'supports_multiple_accounts')::boolean,false) is true
       and v_purpose = any(pa.allowed_message_purposes)
       and coalesce(pr.manifest->'message_purposes','[]'::jsonb) ? v_purpose
       and public.email_provider_enabled(pa.provider_key)
       and (pa.daily_send_limit is null or (select count(*) from public.intel_provider_account_usage u where u.organization_id=v_org and u.provider_account_id=pa.id and u.reserved_at>=v_now-interval '24 hours') < pa.daily_send_limit)
       and (pa.hourly_send_limit is null or (select count(*) from public.intel_provider_account_usage u where u.organization_id=v_org and u.provider_account_id=pa.id and u.reserved_at>=v_now-interval '1 hour') < pa.hourly_send_limit)
       and (pa.minute_send_limit is null or (select count(*) from public.intel_provider_account_usage u where u.organization_id=v_org and u.provider_account_id=pa.id and u.reserved_at>=v_now-interval '1 minute') < pa.minute_send_limit)
     order by coalesce((select max(u.reserved_at) from public.intel_provider_account_usage u
                         where u.organization_id=v_org and u.provider_account_id=pa.id),'epoch'::timestamptz),
              coalesce((select count(*) from public.intel_provider_account_usage u
                         where u.organization_id=v_org and u.provider_account_id=pa.id and u.reserved_at >= v_now-interval '24 hours'),0),
              pa.id
     limit 1 for update of pa skip locked;
    if not found then
      if exists(select 1 from public.intel_provider_accounts pa
        join public.intel_email_provider_registry pr on pr.provider_key=pa.provider_key
        where pa.organization_id=v_org and pa.status='connected' and pa.is_enabled and pa.send_enabled
          and pr.enabled and pr.sending_enabled
          and coalesce((pr.manifest->>'supports_multiple_accounts')::boolean,false) is true
          and v_purpose=any(pa.allowed_message_purposes)
          and coalesce(pr.manifest->'message_purposes','[]'::jsonb) ? v_purpose
          and public.email_provider_enabled(pa.provider_key)) then
        return jsonb_build_object('ok',false,'reason','provider_account_quota','retry_after',60);
      end if;
      return public._intel_deny('no_eligible_provider_account');
    else
      if a.provider_key='zoho' and v_purpose='consented_prospecting' and m.auto_sent then
        update public.intel_messages set state='pending_approval',send_day=null,reserved_at=null,error='Zoho outreach requires explicit human approval' where id=m.id and state='reserved';
        update public.intel_settings set send_slot_message_id=null,send_slot_until=null where organization_id=v_org and send_slot_message_id=m.id;
        return jsonb_build_object('ok',false,'reason','zoho_human_approval_required');
      end if;
      insert into public.intel_provider_account_usage(organization_id,provider_account_id,message_id,reserved_at)
      values(v_org,a.id,m.id,v_now) on conflict do nothing;
      select count(*) into v_daily from public.intel_provider_account_usage where organization_id=v_org and provider_account_id=a.id and reserved_at >= v_now-interval '24 hours';
      select count(*) into v_hourly from public.intel_provider_account_usage where organization_id=v_org and provider_account_id=a.id and reserved_at >= v_now-interval '1 hour';
      select count(*) into v_minute from public.intel_provider_account_usage where organization_id=v_org and provider_account_id=a.id and reserved_at >= v_now-interval '1 minute';
      if (a.daily_send_limit is not null and v_daily>a.daily_send_limit)
         or (a.hourly_send_limit is not null and v_hourly>a.hourly_send_limit)
         or (a.minute_send_limit is not null and v_minute>a.minute_send_limit) then
        delete from public.intel_provider_account_usage where organization_id=v_org and provider_account_id=a.id and message_id=m.id;
        return jsonb_build_object('ok',false,'reason','provider_account_quota','retry_after',60);
      end if;
      update public.intel_messages set provider_account_id=a.id,provider_key=a.provider_key,from_email=a.mailbox
       where organization_id=v_org and id=m.id returning * into m;
    end if;
  end if;

  return jsonb_build_object('ok',true,'legacy',false,'purpose',v_purpose,
    'account',jsonb_build_object('id',a.id,'provider_key',a.provider_key,'mailbox',a.mailbox),
    'message',to_jsonb(m));
end $$;
revoke all on function public.intel_agent_assign_provider_account(uuid) from public,anon;
grant execute on function public.intel_agent_assign_provider_account(uuid) to authenticated;

-- 6. The legacy single-mailbox sync cursor RPC (the worker now syncs per account).
drop function if exists public.intel_agent_sync_state(jsonb);

-- 7. Legacy tables (single mailbox row and its one-time OAuth states).
drop table if exists public.intel_oauth_states;
drop table if exists public.intel_mail_account;

commit;
