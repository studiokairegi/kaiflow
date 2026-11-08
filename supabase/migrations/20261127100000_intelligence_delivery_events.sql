-- Phase 7: provider-neutral, idempotent delivery lifecycle for Intelligence prospect mail.
-- This is separate from the Resend transactional Inbox event pipeline.
begin;

do $$ begin
  if to_regclass('public.intel_messages') is null
     or to_regclass('public.intel_provider_accounts') is null
     or to_regclass('public.intel_suppressions') is null then
    raise exception 'Apply Intelligence provider/account migrations before Phase 7 delivery events';
  end if;
end $$;

alter table public.intel_messages
  add column if not exists delivery_status text not null default 'pending',
  add column if not exists delivery_event_at timestamptz,
  add column if not exists delivered_at timestamptz,
  add column if not exists delivery_error text not null default '';

-- Earlier Resend/Zoho-era indexes treated provider message IDs as organization-wide
-- unique. Multi-adapter, multi-account routing requires the actual account namespace.
-- Keep legacy columns for compatibility, but remove their cross-provider uniqueness.
drop index if exists public.intel_messages_provider_uidx;
drop index if exists public.intel_messages_zoho_uidx;
create unique index if not exists intel_messages_provider_account_message_uidx
  on public.intel_messages(organization_id, provider_key, provider_account_id, provider_message_id)
  where provider_key is not null and provider_account_id is not null and provider_message_id is not null;
create index if not exists intel_messages_legacy_zoho_message_idx
  on public.intel_messages(organization_id, zoho_message_id)
  where zoho_message_id is not null;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'intel_messages_delivery_status_check') then
    alter table public.intel_messages add constraint intel_messages_delivery_status_check
      check (delivery_status in ('pending','accepted','delayed','delivered','failed','bounced','complained'));
  end if;
end $$;

-- One immutable receipt per provider event. Store no raw message body, headers, or credentials.
create table if not exists public.intel_delivery_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  message_id uuid not null references public.intel_messages(id) on delete cascade,
  provider_key text not null,
  provider_account_id uuid not null,
  provider_message_id text not null,
  provider_event_id text not null,
  event_type text not null,
  status text not null check (status in ('accepted','delayed','delivered','failed','bounced','complained')),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  recipient text not null default '',
  reason text not null default '',
  unique (organization_id, provider_key, provider_account_id, provider_event_id),
  foreign key (organization_id, provider_account_id)
    references public.intel_provider_accounts(organization_id, id) on delete restrict
);
create index if not exists intel_delivery_events_message_idx
  on public.intel_delivery_events(organization_id, message_id, occurred_at desc);
create index if not exists intel_messages_delivery_status_idx
  on public.intel_messages(organization_id, delivery_status, delivery_event_at desc)
  where direction = 'outbound';

-- Existing provider-confirmed sends begin at accepted; this is not a claim of delivery.
update public.intel_messages
   set delivery_status = 'accepted'
 where direction = 'outbound' and state = 'sent' and delivery_status = 'pending';

-- Earlier adapter sends retained their provider id only in the legacy Zoho-named
-- column. Backfill the provider-neutral key for assigned accounts.
update public.intel_messages m
   set provider_message_id = m.zoho_message_id
 where m.provider_key is not null and m.provider_account_id is not null
   and m.provider_message_id is null and nullif(m.zoho_message_id,'') is not null
   and not exists (
     select 1 from public.intel_messages x
      where x.organization_id = m.organization_id and x.provider_key = m.provider_key
        and x.zoho_message_id = m.zoho_message_id and x.id <> m.id
   );

alter table public.intel_delivery_events enable row level security;
revoke all on public.intel_delivery_events from public, anon, authenticated;
grant all on public.intel_delivery_events to service_role;

-- A send confirmation means provider acceptance, not mailbox delivery. Do not overwrite
-- an earlier delayed/delivered/bounce event that raced ahead of send confirmation.
create or replace function public.intel_delivery_mark_accepted()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if new.direction = 'outbound' and new.state = 'sent' and old.state is distinct from 'sent'
     and new.delivery_status = 'pending' then
    new.delivery_status := 'accepted';
  end if;
  return new;
end $$;
drop trigger if exists intel_delivery_mark_accepted on public.intel_messages;
create trigger intel_delivery_mark_accepted
before update of state on public.intel_messages
for each row execute function public.intel_delivery_mark_accepted();
revoke all on function public.intel_delivery_mark_accepted() from public, anon, authenticated;

-- Persist the provider-neutral id for Gmail, Zoho and SMTP while retaining the
-- legacy zoho_message_id field used by existing threading/reconciliation code.
create or replace function public.intel_agent_confirm_send(
  p_message_id uuid,
  p_zoho_message_id text,
  p_rfc_message_id text,
  p_thread_id text,
  p_sent_at timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.intel_agent_org();
  m public.intel_messages;
  v_when timestamptz := coalesce(p_sent_at, now());
  v_emails jsonb;
  v_slot jsonb;
begin
  select * into m from public.intel_messages
   where id = p_message_id and organization_id = v_org for update;
  if not found then raise exception 'message not found'; end if;
  if m.state = 'sent' then
    update public.intel_messages
       set provider_message_id = coalesce(provider_message_id, nullif(p_zoho_message_id,'')),
           zoho_message_id = coalesce(zoho_message_id, nullif(p_zoho_message_id,'')),
           rfc_message_id = coalesce(rfc_message_id, nullif(p_rfc_message_id,'')),
           zoho_thread_id = coalesce(zoho_thread_id, nullif(p_thread_id,''))
     where id = m.id;
    return jsonb_build_object('ok', true, 'idempotent', true);
  end if;
  if m.state not in ('reserved','sending','unknown') then
    raise exception 'message is % and cannot be confirmed', m.state;
  end if;

  update public.intel_messages
     set state = 'sent', sent_at = v_when,
         provider_message_id = coalesce(provider_message_id, nullif(p_zoho_message_id,'')),
         zoho_message_id = nullif(p_zoho_message_id,''),
         rfc_message_id = nullif(p_rfc_message_id,''),
         zoho_thread_id = nullif(p_thread_id,''), error = null
   where id = m.id;

  if m.kind in ('initial','followup') then
    update public.intel_prospects
       set status = case when status in ('replied','closed') then status else 'contacted' end,
           updated_at = now()
     where id = m.prospect_id;
    if m.lead_id is not null then
      select case when jsonb_typeof(l.emails) = 'array' then l.emails else '[]'::jsonb end
        into v_emails from public.leads l where l.id = m.lead_id for update;
      if found then
        if m.step < 0 or m.step > 100 then raise exception 'message step is outside the supported range'; end if;
        while jsonb_array_length(v_emails) <= m.step loop
          if jsonb_array_length(v_emails) = 0 then
            v_slot := jsonb_build_object('label','Initial Email','message','','sent',false,'dateSent',null);
          else
            v_slot := jsonb_build_object('label','Follow-up ' || jsonb_array_length(v_emails)::text,'message','','sent',false,'dateSent',null);
          end if;
          v_emails := v_emails || jsonb_build_array(v_slot);
        end loop;
        v_slot := coalesce(v_emails -> m.step, '{}'::jsonb)
          || jsonb_build_object('sent',true,'dateSent',to_char(v_when,'YYYY-MM-DD'),'message',m.body_text);
        v_emails := jsonb_set(v_emails,array[m.step::text],v_slot,true);
        update public.leads set emails = v_emails, last_contacted_at = v_when,
          stage = case when m.kind = 'initial' and stage = 'pool' then 'cold_email' else stage end,
          stage_changed_at = case when m.kind = 'initial' and stage = 'pool' then now() else stage_changed_at end
        where id = m.lead_id;
      end if;
    end if;
  end if;
  perform public._intel_log(v_org,'agent','confirm_send','message',m.id::text,jsonb_build_object('kind',m.kind));
  return jsonb_build_object('ok',true);
end $$;
revoke all on function public.intel_agent_confirm_send(uuid,text,text,text,timestamptz) from public, anon;
grant execute on function public.intel_agent_confirm_send(uuid,text,text,text,timestamptz) to authenticated;

create or replace function public.intel_agent_apply_delivery_event(
  p_provider_key text,
  p_provider_account_id uuid,
  p_provider_message_id text,
  p_provider_event_id text,
  p_event_type text,
  p_status text,
  p_occurred_at timestamptz default null,
  p_recipient text default '',
  p_reason text default ''
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  m public.intel_messages;
  v_status text := lower(btrim(coalesce(p_status,'')));
  v_recipient text := public.intel_norm_email(p_recipient);
  v_rank int;
  v_current_rank int;
  v_event_at timestamptz := coalesce(p_occurred_at, now());
  v_inserted int;
  v_existing_message uuid;
  v_existing_account uuid;
  v_existing_provider_message text;
  v_emails jsonb;
  v_slot jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if v_status not in ('accepted','delayed','delivered','failed','bounced','complained') then
    raise exception 'unsupported delivery status' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_provider_key,'')), '') is null
     or p_provider_account_id is null
     or nullif(btrim(coalesce(p_provider_message_id,'')), '') is null
     or nullif(btrim(coalesce(p_provider_event_id,'')), '') is null
     or nullif(btrim(coalesce(p_event_type,'')), '') is null then
    raise exception 'provider, account, message, event id and event type are required' using errcode = '22023';
  end if;

  select im.* into m
    from public.intel_messages im
   where im.organization_id is not null
     and im.direction = 'outbound'
     and im.provider_key = p_provider_key
     and im.provider_account_id = p_provider_account_id
     and im.provider_message_id = p_provider_message_id
     and exists (
       select 1 from public.intel_provider_accounts a
        where a.organization_id = im.organization_id
          and a.id = p_provider_account_id
          and a.provider_key = p_provider_key
     )
   for update of im;
  if not found then
    return jsonb_build_object('ok', false, 'found', false, 'retryable', false, 'reason', 'message_not_matched');
  end if;
  if v_recipient <> '' and v_recipient <> public.intel_norm_email(m.to_email) then
    return jsonb_build_object('ok', false, 'found', false, 'retryable', false, 'reason', 'recipient_mismatch');
  end if;

  insert into public.intel_delivery_events(
    organization_id, message_id, provider_key, provider_account_id,
    provider_message_id, provider_event_id, event_type, status, occurred_at, recipient, reason
  ) values (
    m.organization_id, m.id, p_provider_key, p_provider_account_id,
    p_provider_message_id, p_provider_event_id, left(p_event_type,120), v_status,
    v_event_at, v_recipient, left(coalesce(p_reason,''),240)
  ) on conflict (organization_id, provider_key, provider_account_id, provider_event_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    select message_id, provider_account_id, provider_message_id
      into v_existing_message, v_existing_account, v_existing_provider_message
      from public.intel_delivery_events
     where organization_id = m.organization_id
       and provider_key = p_provider_key
       and provider_account_id = p_provider_account_id
       and provider_event_id = p_provider_event_id;
    if v_existing_message is distinct from m.id
       or v_existing_account is distinct from p_provider_account_id
       or v_existing_provider_message is distinct from p_provider_message_id then
      raise exception 'provider event id collision';
    end if;
    return jsonb_build_object('ok', true, 'found', true, 'duplicate', true, 'applied', false, 'message_id', m.id);
  end if;

  -- Monotonic progression makes delayed/out-of-order delivery harmless.
  -- A complaint outranks every other event; a bounce/terminal failure cannot be
  -- overwritten by a late delivered or delayed notification.
  v_rank := case v_status when 'accepted' then 10 when 'delayed' then 20 when 'delivered' then 30
                           when 'failed' then 40 when 'bounced' then 50 when 'complained' then 60 else 0 end;
  v_current_rank := case m.delivery_status when 'accepted' then 10 when 'delayed' then 20 when 'delivered' then 30
                                   when 'failed' then 40 when 'bounced' then 50 when 'complained' then 60 else 0 end;
  if v_rank > v_current_rank then
    update public.intel_messages
       set delivery_status = v_status,
           delivery_event_at = v_event_at,
           delivered_at = case when v_status = 'delivered' then coalesce(delivered_at, v_event_at) else delivered_at end,
           delivery_error = case when v_status in ('failed','bounced','complained') then left(coalesce(nullif(p_reason,''),p_event_type),500) else delivery_error end
     where id = m.id;

    -- Keep the CRM sequence row synchronized without pretending a bounce is a send failure.
    if m.lead_id is not null and m.kind in ('initial','followup') and m.step between 0 and 100 then
      select case when jsonb_typeof(l.emails) = 'array' then l.emails else '[]'::jsonb end
        into v_emails from public.leads l where l.id = m.lead_id for update;
      if found then
        while jsonb_array_length(v_emails) <= m.step loop
          v_slot := case when jsonb_array_length(v_emails) = 0
            then jsonb_build_object('label','Initial Email','message','','sent',false,'dateSent',null)
            else jsonb_build_object('label','Follow-up ' || jsonb_array_length(v_emails)::text,'message','','sent',false,'dateSent',null) end;
          v_emails := v_emails || jsonb_build_array(v_slot);
        end loop;
        v_slot := coalesce(v_emails -> m.step, '{}'::jsonb)
          || jsonb_build_object('deliveryStatus',v_status,'deliveryUpdatedAt',v_event_at);
        if v_status in ('failed','bounced','complained') then
          v_slot := v_slot || jsonb_build_object('deliveryIssue',left(coalesce(nullif(p_reason,''),p_event_type),240));
        end if;
        v_emails := jsonb_set(v_emails,array[m.step::text],v_slot,true);
        update public.leads set emails = v_emails where id = m.lead_id;
      end if;
    end if;
  end if;

  -- Any bounce or complaint blocks future outreach to this exact address.
  -- Complaint is the stronger reason and may upgrade an existing bounce suppression.
  if v_status in ('bounced','complained') then
    insert into public.intel_suppressions(organization_id,kind,value,reason,source)
    values (m.organization_id,'email',public.intel_norm_email(m.to_email),
      case when v_status = 'complained' then 'complaint' else 'bounce' end,'provider:' || p_provider_key)
    on conflict (organization_id,kind,value) do update
      -- Only upgrade an existing provider/agent bounce marker. Never replace an
      -- administrator/legal/other suppression reason or its provenance.
      set reason = case
            when excluded.reason = 'complaint'
             and lower(btrim(public.intel_suppressions.reason)) in ('bounce','complaint')
              then 'complaint'
            else public.intel_suppressions.reason end,
          source = case
            when excluded.reason = 'complaint'
             and lower(btrim(public.intel_suppressions.reason)) in ('bounce','complaint')
             and public.intel_suppressions.source in ('agent')
              then excluded.source
            else public.intel_suppressions.source end;
  end if;

  perform public._intel_log(m.organization_id,'system','delivery_event','message',m.id::text,
    jsonb_build_object('provider',p_provider_key,'status',v_status,'event_type',left(p_event_type,120),'applied',v_rank > v_current_rank));
  return jsonb_build_object('ok',true,'found',true,'duplicate',false,'applied',v_rank > v_current_rank,
    'message_id',m.id,'delivery_status',case when v_rank > v_current_rank then v_status else m.delivery_status end);
end $$;

revoke all on function public.intel_agent_apply_delivery_event(text,uuid,text,text,text,text,timestamptz,text,text) from public, anon, authenticated;
grant execute on function public.intel_agent_apply_delivery_event(text,uuid,text,text,text,text,timestamptz,text,text) to service_role;

commit;
