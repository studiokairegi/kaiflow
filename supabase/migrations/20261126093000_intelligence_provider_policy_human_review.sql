-- Phase 2.8.1: enforce provider capability intersection and require human review for Zoho prospecting.
begin;

update public.intel_email_provider_registry
   set manifest = jsonb_set(manifest, '{message_purposes}', '["business_correspondence","consented_prospecting"]'::jsonb, true),
       updated_at=now()
 where provider_key='zoho';

create or replace function public.intel_agent_assign_provider_account(p_message_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_org uuid:=public.intel_agent_org(); m public.intel_messages; a public.intel_provider_accounts;
  v_purpose text; v_provider text; v_legacy boolean:=false; v_now timestamptz:=clock_timestamp();
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
      -- Preserve the pre-registry singleton path for installations not yet switched to account dispatch.
      if exists(select 1 from public.intel_mail_account la where la.organization_id=v_org and la.provider in ('gmail','zoho') and la.status='connected'
        and not exists(select 1 from public.intel_provider_accounts pa where pa.organization_id=la.organization_id and pa.provider_key=la.provider and pa.mailbox=lower(btrim(la.mailbox)))) then
        v_legacy:=true;
      else
        return public._intel_deny('no_eligible_provider_account');
      end if;
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

  if v_legacy then
    if v_purpose='consented_prospecting' and m.auto_sent and exists(
      select 1 from public.intel_mail_account la
       where la.organization_id=v_org and la.provider='zoho' and la.status='connected'
    ) then
      update public.intel_messages set state='pending_approval',send_day=null,reserved_at=null,error='Zoho outreach requires explicit human approval' where id=m.id and state='reserved';
      update public.intel_settings set send_slot_message_id=null,send_slot_until=null where organization_id=v_org and send_slot_message_id=m.id;
      return jsonb_build_object('ok',false,'reason','zoho_human_approval_required');
    end if;
    return jsonb_build_object('ok',true,'legacy',true,'purpose',v_purpose,'message',to_jsonb(m));
  end if;
  return jsonb_build_object('ok',true,'legacy',false,'purpose',v_purpose,
    'account',jsonb_build_object('id',a.id,'provider_key',a.provider_key,'mailbox',a.mailbox),
    'message',to_jsonb(m));
end $$;
create or replace function public.intel_agent_mark_sending(p_message_id uuid)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_org uuid:=public.intel_agent_org(); s public.intel_settings; m public.intel_messages;
begin
  select * into s from public.intel_settings where organization_id=v_org for update;
  if not found then return false; end if;
  select * into m from public.intel_messages where id=p_message_id and organization_id=v_org for update;
  if not found or m.state<>'reserved' then return false; end if;
  if s.kill_switch then
    update public.intel_messages set state='approved',send_day=null,reserved_at=null,error='emergency stop enabled before provider send' where id=m.id and state='reserved';
    update public.intel_settings set send_slot_message_id=null,send_slot_until=null where organization_id=v_org and send_slot_message_id=p_message_id;
    return false;
  end if;
  if m.provider_account_id is not null and not exists(
    select 1 from public.intel_provider_accounts a
    join public.intel_email_provider_registry r on r.provider_key=a.provider_key
    where a.organization_id=v_org and a.id=m.provider_account_id and a.status='connected'
      and a.is_enabled and a.send_enabled and r.enabled and r.sending_enabled
      and public.email_provider_enabled(a.provider_key)
      and (case when m.kind in ('initial','followup') then 'consented_prospecting' else 'business_correspondence' end)=any(a.allowed_message_purposes)
      and coalesce(r.manifest->'message_purposes','[]'::jsonb) ? (case when m.kind in ('initial','followup') then 'consented_prospecting' else 'business_correspondence' end)
  ) then
    update public.intel_messages set state='approved',send_day=null,reserved_at=null,error='provider account or sending gate disabled before submission' where id=m.id and state='reserved';
    update public.intel_settings set send_slot_message_id=null,send_slot_until=null where organization_id=v_org and send_slot_message_id=p_message_id;
    return false;
  end if;
  -- Zoho prospecting is never autonomous. auto_sent=true identifies an automatic
  -- approval path; only the explicit admin review RPC clears it.
  if (m.provider_key='zoho' or (m.provider_key is null and exists(select 1 from public.intel_mail_account la where la.organization_id=v_org and la.provider='zoho' and la.status='connected')))
     and m.kind in ('initial','followup') and m.auto_sent then
    update public.intel_messages set state='pending_approval',send_day=null,reserved_at=null,error='Zoho outreach requires explicit human approval' where id=m.id and state='reserved';
    update public.intel_settings set send_slot_message_id=null,send_slot_until=null where organization_id=v_org and send_slot_message_id=p_message_id;
    return false;
  end if;
  if s.send_slot_message_id=p_message_id and (s.send_slot_until is null or s.send_slot_until<=clock_timestamp()) then
    update public.intel_messages set state='approved',send_day=null,reserved_at=null,error='send slot expired before provider submission' where id=m.id and state='reserved';
    update public.intel_settings set send_slot_message_id=null,send_slot_until=null where organization_id=v_org and send_slot_message_id=p_message_id;
    return false;
  end if;
  if s.send_slot_message_id is distinct from p_message_id or s.send_slot_until is null or s.send_slot_until<=clock_timestamp() then return false; end if;
  update public.intel_messages set state='sending' where id=m.id and organization_id=v_org and state='reserved';
  return found;
end $$;
revoke all on function public.intel_agent_assign_provider_account(uuid) from public,anon;
grant execute on function public.intel_agent_assign_provider_account(uuid) to authenticated;

revoke all on function public.intel_agent_mark_sending(uuid) from public,anon;
grant execute on function public.intel_agent_mark_sending(uuid) to authenticated;

-- A human approval must enqueue a fresh send attempt after a Zoho automatic send was held.
create or replace function public.intel_admin_review_message(p_message_id uuid, p_action text, p_subject text default null, p_body text default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_admin_org(); m public.intel_messages;
begin
  select * into m from public.intel_messages where id=p_message_id and organization_id=v_org for update;
  if not found then raise exception 'message not found'; end if;
  if m.direction <> 'outbound' then raise exception 'only outbound messages can be reviewed'; end if;
  if p_action='approve' then
    if m.state <> 'pending_approval' then raise exception 'message is not waiting for approval'; end if;
    update public.intel_messages set state='approved',auto_sent=false,error=null where id=m.id;
    insert into public.intel_jobs(organization_id,kind,payload,priority,idempotency_key)
      values(v_org,'send',jsonb_build_object('message_id',m.id),10,'manual-approve-send:'||m.id::text||':'||gen_random_uuid()::text)
      on conflict (organization_id,idempotency_key) do nothing;
  elsif p_action='discard' then
    if m.state in ('reserved','sending','sent','unknown') then raise exception 'message already in flight'; end if;
    update public.intel_messages set state='discarded' where id=m.id;
  elsif p_action='edit' then
    if m.state not in ('draft','pending_approval','failed') then raise exception 'message can no longer be edited'; end if;
    update public.intel_messages set subject=coalesce(left(p_subject,300),subject),body_text=coalesce(left(p_body,20000),body_text),state='pending_approval',auto_sent=false,error=null where id=m.id;
  elsif p_action='retry' then
    if m.state <> 'failed' then raise exception 'only failed messages can be retried'; end if;
    update public.intel_messages set state='approved',auto_sent=false,error=null where id=m.id;
    insert into public.intel_jobs(organization_id,kind,payload,priority,idempotency_key)
      values(v_org,'send',jsonb_build_object('message_id',m.id),10,'manual-retry-send:'||m.id::text||':'||gen_random_uuid()::text)
      on conflict (organization_id,idempotency_key) do nothing;
  else raise exception 'unknown action'; end if;
  perform public._intel_log(v_org,'admin','review_message_'||p_action,'message',m.id::text,'{}'::jsonb);
  return jsonb_build_object('ok',true);
end $$;
revoke all on function public.intel_admin_review_message(uuid,text,text,text) from public,anon;
grant execute on function public.intel_admin_review_message(uuid,text,text,text) to authenticated;

commit;
