-- Phase 2.5: deterministic message/account assignment, purpose consent and atomic mailbox quotas.
-- Fail closed for prospecting: no send without an explicit, active contact permission record.
begin;

create table if not exists public.intel_contact_permissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  email text not null,
  purpose text not null check (purpose in ('consented_prospecting','business_correspondence')),
  status text not null default 'granted' check (status in ('granted','revoked')),
  evidence_type text not null,
  evidence_reference text not null default '',
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (email = lower(btrim(email))),
  check (length(btrim(evidence_type)) > 0)
);
create index if not exists intel_contact_permissions_lookup_idx
  on public.intel_contact_permissions(organization_id,email,purpose,status,granted_at desc);
alter table public.intel_contact_permissions enable row level security;
revoke all on public.intel_contact_permissions from public,anon,authenticated;
grant all on public.intel_contact_permissions to service_role;

create unique index if not exists intel_messages_org_id_uidx on public.intel_messages(organization_id,id);

-- Conservative per-mailbox defaults; admins may lower or raise them explicitly.
update public.intel_provider_accounts set daily_send_limit=25 where daily_send_limit is null;
update public.intel_provider_accounts set hourly_send_limit=5 where hourly_send_limit is null;
update public.intel_provider_accounts set minute_send_limit=1 where minute_send_limit is null;
alter table public.intel_provider_accounts alter column daily_send_limit set default 25;
alter table public.intel_provider_accounts alter column hourly_send_limit set default 5;
alter table public.intel_provider_accounts alter column minute_send_limit set default 1;

create table if not exists public.intel_provider_account_usage (
  organization_id uuid not null,
  provider_account_id uuid not null,
  message_id uuid not null,
  reserved_at timestamptz not null default now(),
  primary key (organization_id, provider_account_id, message_id),
  foreign key (organization_id,provider_account_id) references public.intel_provider_accounts(organization_id,id) on delete restrict,
  foreign key (organization_id,message_id) references public.intel_messages(organization_id,id) on delete cascade
);
create index if not exists intel_provider_account_usage_windows_idx
  on public.intel_provider_account_usage(organization_id,provider_account_id,reserved_at desc);
alter table public.intel_provider_account_usage enable row level security;
revoke all on public.intel_provider_account_usage from public,anon,authenticated;
grant all on public.intel_provider_account_usage to service_role;

-- Admin-only permission management RPCs; evidence is required and secret-free.
create or replace function public.intel_admin_set_contact_permission(
  p_email text,p_purpose text,p_evidence_type text,p_evidence_reference text default '',p_granted boolean default true
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_org uuid:=public.intel_admin_org(); v_id uuid; v_email text:=public.intel_norm_email(p_email);
begin
  if p_purpose not in ('consented_prospecting','business_correspondence') then raise exception 'invalid_purpose' using errcode='22023'; end if;
  if v_email is null or position('@' in v_email)=0 then raise exception 'invalid_email' using errcode='22023'; end if;
  if p_granted and nullif(btrim(p_evidence_type),'') is null then raise exception 'permission_evidence_required' using errcode='22023'; end if;
  if p_granted then
    insert into public.intel_contact_permissions(organization_id,email,purpose,status,evidence_type,evidence_reference,granted_at,revoked_at,created_by)
    values(v_org,v_email,p_purpose,'granted',left(btrim(p_evidence_type),80),left(coalesce(p_evidence_reference,''),500),now(),null,auth.uid())
    returning id into v_id;
  else
    update public.intel_contact_permissions set status='revoked',revoked_at=now(),updated_at=now()
     where organization_id=v_org and email=v_email and purpose=p_purpose and status='granted';
    insert into public.intel_contact_permissions(organization_id,email,purpose,status,evidence_type,evidence_reference,granted_at,revoked_at,created_by)
    values(v_org,v_email,p_purpose,'revoked','admin_revocation',left(coalesce(p_evidence_reference,''),500),now(),now(),auth.uid())
    returning id into v_id;
  end if;
  return jsonb_build_object('id',v_id,'email',v_email,'purpose',p_purpose,'status',case when p_granted then 'granted' else 'revoked' end);
end $$;
revoke all on function public.intel_admin_set_contact_permission(text,text,text,text,boolean) from public,anon;
grant execute on function public.intel_admin_set_contact_permission(text,text,text,text,boolean) to authenticated;

-- Called only after the existing reservation gates. Locks both message and candidate account,
-- so assignment and quota accounting are atomic across concurrent workers.
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
       or not exists(select 1 from public.intel_email_provider_registry pr where pr.provider_key=a.provider_key and pr.enabled and pr.sending_enabled)
       or not public.email_provider_enabled(a.provider_key) then return public._intel_deny('assigned_account_disabled'); end if;
  else
    -- Deterministic load-aware choice: least recently used, then lowest rolling daily usage, then UUID.
    select pa.* into a
      from public.intel_provider_accounts pa
      join public.intel_email_provider_registry pr on pr.provider_key=pa.provider_key
     where pa.organization_id=v_org and pa.status='connected' and pa.is_enabled and pa.send_enabled
       and pr.enabled and pr.sending_enabled
       and coalesce((pr.manifest->>'supports_multiple_accounts')::boolean,false) is true
       and v_purpose = any(pa.allowed_message_purposes)
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
    return jsonb_build_object('ok',true,'legacy',true,'purpose',v_purpose,'message',to_jsonb(m));
  end if;
  return jsonb_build_object('ok',true,'legacy',false,'purpose',v_purpose,
    'account',jsonb_build_object('id',a.id,'provider_key',a.provider_key,'mailbox',a.mailbox),
    'message',to_jsonb(m));
end $$;
revoke all on function public.intel_agent_assign_provider_account(uuid) from public,anon;
grant execute on function public.intel_agent_assign_provider_account(uuid) to authenticated;


create or replace function public.intel_admin_set_provider_sending_enabled(p_provider_key text,p_enabled boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_org uuid:=public.intel_admin_org(); v_key text:=lower(btrim(p_provider_key));
begin
  update public.intel_email_provider_registry set sending_enabled=p_enabled,updated_at=now()
   where provider_key=v_key and enabled=true;
  if not found then raise exception 'provider adapter is not enabled'; end if;
  update public.email_provider_flags set enabled=p_enabled,note='Managed by Intelligence provider account controls',updated_at=now() where provider=v_key;
  perform public._intel_log(v_org,'admin','provider_sending_gate','provider',v_key,jsonb_build_object('enabled',p_enabled));
  return jsonb_build_object('provider_key',v_key,'sending_enabled',p_enabled);
end $$;
revoke all on function public.intel_admin_set_provider_sending_enabled(text,boolean) from public,anon;
grant execute on function public.intel_admin_set_provider_sending_enabled(text,boolean) to authenticated;


create or replace function public.intel_admin_update_provider_account(p_account_id uuid,p_patch jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_org uuid:=public.intel_admin_org(); v_account public.intel_provider_accounts;
begin
  if p_patch is null or jsonb_typeof(p_patch)<>'object'
     or exists(select 1 from jsonb_object_keys(p_patch) k where k not in ('is_enabled','send_enabled','allowed_message_purposes','daily_send_limit','hourly_send_limit','minute_send_limit')) then
    raise exception 'unsupported provider account update';
  end if;
  if p_patch ? 'allowed_message_purposes' then
    if jsonb_typeof(p_patch->'allowed_message_purposes')<>'array' then raise exception 'invalid message purposes'; end if;
    if exists(select 1 from jsonb_array_elements_text(p_patch->'allowed_message_purposes') x where x not in ('business_correspondence','consented_prospecting')) then raise exception 'invalid message purposes'; end if;
  end if;
  update public.intel_provider_accounts a set
    is_enabled=coalesce((p_patch->>'is_enabled')::boolean,a.is_enabled),
    send_enabled=coalesce((p_patch->>'send_enabled')::boolean,a.send_enabled),
    allowed_message_purposes=case when p_patch ? 'allowed_message_purposes' then array(select jsonb_array_elements_text(p_patch->'allowed_message_purposes')) else a.allowed_message_purposes end,
    daily_send_limit=case when p_patch ? 'daily_send_limit' then nullif(p_patch->>'daily_send_limit','')::integer else a.daily_send_limit end,
    hourly_send_limit=case when p_patch ? 'hourly_send_limit' then nullif(p_patch->>'hourly_send_limit','')::integer else a.hourly_send_limit end,
    minute_send_limit=case when p_patch ? 'minute_send_limit' then nullif(p_patch->>'minute_send_limit','')::integer else a.minute_send_limit end,
    updated_at=now()
   where a.id=p_account_id and a.organization_id=v_org and a.status='connected' returning * into v_account;
  if not found then raise exception 'connected provider account not found'; end if;
  return jsonb_build_object('ok',true,'id',v_account.id,'is_enabled',v_account.is_enabled,'send_enabled',v_account.send_enabled,
    'allowed_message_purposes',v_account.allowed_message_purposes,'daily_send_limit',v_account.daily_send_limit,
    'hourly_send_limit',v_account.hourly_send_limit,'minute_send_limit',v_account.minute_send_limit);
end $$;
revoke all on function public.intel_admin_update_provider_account(uuid,jsonb) from public,anon;
grant execute on function public.intel_admin_update_provider_account(uuid,jsonb) to authenticated;


create or replace function public.intel_agent_stale_sends(p_older_than_seconds int default 600) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare v_org uuid:=public.intel_agent_org();
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id',m.id,'token',m.token,'to_email',m.to_email,'from_email',m.from_email,'subject',m.subject,
    'state',m.state,'reserved_at',m.reserved_at,'zoho_message_id',m.zoho_message_id,
    'provider_message_id',m.provider_message_id,'provider_account_id',m.provider_account_id,
    'provider_key',m.provider_key,'in_reply_to',m.in_reply_to,'references_ids',m.references_ids
  )) from public.intel_messages m where m.organization_id=v_org and m.direction='outbound'
    and m.state in ('sending','unknown') and m.reserved_at < now()-make_interval(secs=>greatest(60,p_older_than_seconds))), '[]'::jsonb);
end $$;
revoke all on function public.intel_agent_stale_sends(int) from public,anon;
grant execute on function public.intel_agent_stale_sends(int) to authenticated;


-- Last-moment account/provider gate check, adjacent to the final state transition.
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
  ) then
    update public.intel_messages set state='approved',send_day=null,reserved_at=null,error='provider account or sending gate disabled before submission' where id=m.id and state='reserved';
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
revoke all on function public.intel_agent_mark_sending(uuid) from public,anon;
grant execute on function public.intel_agent_mark_sending(uuid) to authenticated;

commit;
