-- Phase 7 corrective patch: suppression propagation, provenance preservation and durable retry behavior.
begin;
do $$ begin
  if to_regclass('public.email_messages') is null or to_regclass('public.intel_suppressions') is null
     or to_regclass('public.intel_messages') is null then
    raise exception 'Apply Phase 7 delivery-event prerequisites first';
  end if;
end $$;

create or replace function public.email_webhook_claim(p_svix_id text, p_type text, p_payload jsonb, p_lease_seconds int default 300, p_max_attempts int default 12)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare r public.email_webhook_events; v_lease interval := make_interval(secs => least(greatest(coalesce(p_lease_seconds, 300), 30), 900));
begin
  if nullif(btrim(coalesce(p_svix_id, '')), '') is null then raise exception 'Missing webhook id' using errcode = '22023'; end if;
  insert into public.email_webhook_events (svix_id, event_type, status, attempts, payload, claim_token, claimed_at, lease_expires_at)
  values (p_svix_id, left(coalesce(p_type, ''), 100), 'processing', 1, coalesce(p_payload, '{}'::jsonb), gen_random_uuid(), now(), now() + v_lease)
  on conflict (svix_id) do nothing
  returning * into r;
  if found then
    return jsonb_build_object('state', 'claimed', 'token', r.claim_token, 'attempts', 1);
  end if;

  select * into r from public.email_webhook_events where svix_id = p_svix_id for update;     -- serialises concurrent claimers on this row
  if r.status in ('processed', 'ignored') then
    return jsonb_build_object('state', 'done', 'status', r.status);
  end if;
  if r.status = 'processing' and r.lease_expires_at is not null and r.lease_expires_at > now() then
    return jsonb_build_object('state', 'busy');
  end if;
  if r.attempts >= greatest(coalesce(p_max_attempts, 12), 1) then
    update public.email_webhook_events set status = 'failed', claim_token = null, lease_expires_at = null,
           error = case when error = '' then 'Retry limit reached' else error end where svix_id = p_svix_id;
    return jsonb_build_object('state', 'exhausted', 'attempts', r.attempts);
  end if;
  update public.email_webhook_events
     set status = 'processing', attempts = attempts + 1, claim_token = gen_random_uuid(), claimed_at = now(), lease_expires_at = now() + v_lease
   where svix_id = p_svix_id
   returning * into r;
  return jsonb_build_object('state', 'claimed', 'token', r.claim_token, 'attempts', r.attempts);
end $$;

create or replace function public.email_apply_delivery_event(p_provider_message_id text, p_status text, p_event_type text, p_provider_event_id text, p_occurred_at timestamptz, p_detail jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare m public.email_messages; v_n int; v_ins int; v_applied boolean := false; v_recipient text; v_reason text; v_existing_message uuid; v_duplicate boolean := false;
begin
  if p_status is null or p_status not in ('sent', 'delivered', 'delivery_delayed', 'bounced', 'complained', 'failed', 'rejected') then
    raise exception 'Unsupported delivery status' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_provider_message_id, '')), '') is null then raise exception 'Missing provider message id' using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p_provider_event_id, '')), '') is null or nullif(btrim(coalesce(p_event_type, '')), '') is null then raise exception 'Missing provider event identity' using errcode = '22023'; end if;

  select count(*) into v_n from public.email_messages where provider = 'resend' and direction = 'outbound' and provider_message_id = p_provider_message_id;
  if v_n = 0 then return jsonb_build_object('found', false); end if;
  if v_n > 1 then return jsonb_build_object('found', false, 'ambiguous', true); end if;          -- never update an arbitrary row

  select * into m from public.email_messages where provider = 'resend' and direction = 'outbound' and provider_message_id = p_provider_message_id for update;
  v_recipient := lower(btrim(coalesce(p_detail ->> 'recipient','')));
  if v_recipient <> '' and not exists (
    select 1 from unnest(coalesce(m.to_emails, array[]::text[])) as recipient(email)
     where lower(btrim(recipient.email)) = v_recipient
  ) then
    return jsonb_build_object('found', false, 'recipient_mismatch', true);
  end if;
  insert into public.email_events (organization_id, message_id, event_type, provider_event_id, occurred_at, detail)
  values (m.organization_id, m.id, left(coalesce(p_event_type, ''), 100), p_provider_event_id, coalesce(p_occurred_at, now()), coalesce(p_detail, '{}'::jsonb))
  on conflict (provider_event_id) where provider_event_id is not null do nothing;
  get diagnostics v_ins = row_count;
  if v_ins = 0 then
    select message_id into v_existing_message from public.email_events where provider_event_id = p_provider_event_id;
    if v_existing_message is distinct from m.id then raise exception 'provider event id collision'; end if;
    v_duplicate := true;
  end if;

  -- A CRM-only delivery record must still protect Intelligence contactability.
  if p_status in ('bounced','complained') or p_event_type = 'email.suppressed' then
    v_recipient := lower(btrim(coalesce(nullif(p_detail ->> 'recipient',''),
      case when cardinality(m.to_emails) = 1 then m.to_emails[1] else '' end, '')));
    if char_length(v_recipient) <= 320 and v_recipient ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
      v_reason := case when p_status = 'complained' then 'complaint'
                       when p_event_type = 'email.suppressed' then 'provider_suppressed'
                       else 'bounce' end;
      insert into public.intel_suppressions(organization_id,kind,value,reason,source)
      values (m.organization_id,'email',v_recipient,v_reason,'provider:resend')
      on conflict (organization_id,kind,value) do update
        set reason = case
              when public.intel_suppressions.source = 'agent'
                or public.intel_suppressions.source like 'provider:%'
                then case when excluded.reason = 'complaint' and lower(btrim(public.intel_suppressions.reason)) in ('bounce','complaint','provider_suppressed') then 'complaint'
                          when excluded.reason = 'provider_suppressed' and lower(btrim(public.intel_suppressions.reason)) in ('bounce','provider_suppressed') then 'provider_suppressed'
                          else public.intel_suppressions.reason end
              else public.intel_suppressions.reason end,
            source = case
              when excluded.reason = 'complaint'
                and (public.intel_suppressions.source = 'agent' or public.intel_suppressions.source like 'provider:%')
                and lower(btrim(public.intel_suppressions.reason)) in ('bounce','provider_suppressed')
                then excluded.source
              when excluded.reason = 'provider_suppressed'
                and (public.intel_suppressions.source = 'agent' or public.intel_suppressions.source like 'provider:%')
                and lower(btrim(public.intel_suppressions.reason)) = 'bounce'
                then excluded.source
              else public.intel_suppressions.source end;
    end if;
  end if;
  if v_duplicate then
    return jsonb_build_object('found', true, 'duplicate', true, 'applied', false, 'message_id', m.id);
  end if;

  if public._email_status_rank(p_status) > public._email_status_rank(m.status) then      -- strictly forward: delivered never back to sent, bounced never replaced by failed
    update public.email_messages
       set status = p_status,
           error = case when p_status in ('bounced', 'failed', 'rejected', 'complained') then left(coalesce(p_detail ->> 'reason', p_event_type), 500) else error end,
           sent_at = coalesce(sent_at, case when p_status = 'sent' then coalesce(p_occurred_at, now()) end)
     where id = m.id;
    v_applied := true;
  end if;
  return jsonb_build_object('found', true, 'applied', v_applied, 'message_id', m.id);
end $$;

create or replace function public._intel_apply_delivery_event_internal(
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
    -- Replayed legacy events may have been recorded before suppression synchronization
    -- was fixed. Re-apply the idempotent suppression even when the event receipt exists.
    if v_status in ('bounced','complained') or p_event_type = 'email.suppressed' then
      insert into public.intel_suppressions(organization_id,kind,value,reason,source)
      values (m.organization_id,'email',public.intel_norm_email(m.to_email),
        case when v_status = 'complained' then 'complaint' when p_event_type = 'email.suppressed' then 'provider_suppressed' else 'bounce' end,'provider:' || p_provider_key)
      on conflict (organization_id,kind,value) do update
        set reason = case
              when (public.intel_suppressions.source = 'agent' or public.intel_suppressions.source like 'provider:%')
               and excluded.reason = 'complaint'
               and lower(btrim(public.intel_suppressions.reason)) in ('bounce','complaint','provider_suppressed')
                then 'complaint'
              when (public.intel_suppressions.source = 'agent' or public.intel_suppressions.source like 'provider:%')
               and excluded.reason = 'provider_suppressed'
               and lower(btrim(public.intel_suppressions.reason)) in ('bounce','provider_suppressed')
                then 'provider_suppressed'
              else public.intel_suppressions.reason end,
            source = case
              when excluded.reason = 'complaint'
               and (public.intel_suppressions.source = 'agent' or public.intel_suppressions.source like 'provider:%')
               and lower(btrim(public.intel_suppressions.reason)) in ('bounce','provider_suppressed')
                then excluded.source
              when excluded.reason = 'provider_suppressed'
               and (public.intel_suppressions.source = 'agent' or public.intel_suppressions.source like 'provider:%')
               and lower(btrim(public.intel_suppressions.reason)) in ('bounce','provider_suppressed')
                then excluded.source
              else public.intel_suppressions.source end;
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
  if v_status in ('bounced','complained') or p_event_type = 'email.suppressed' then
    insert into public.intel_suppressions(organization_id,kind,value,reason,source)
    values (m.organization_id,'email',public.intel_norm_email(m.to_email),
      case when v_status = 'complained' then 'complaint' when p_event_type = 'email.suppressed' then 'provider_suppressed' else 'bounce' end,'provider:' || p_provider_key)
    on conflict (organization_id,kind,value) do update
      -- Only upgrade an existing provider/agent bounce marker. Never replace an
      -- administrator/legal/other suppression reason or its provenance.
      set reason = case
            when (public.intel_suppressions.source = 'agent' or public.intel_suppressions.source like 'provider:%')
             and excluded.reason = 'complaint'
             and lower(btrim(public.intel_suppressions.reason)) in ('bounce','complaint','provider_suppressed')
              then 'complaint'
            when (public.intel_suppressions.source = 'agent' or public.intel_suppressions.source like 'provider:%')
             and excluded.reason = 'provider_suppressed'
             and lower(btrim(public.intel_suppressions.reason)) in ('bounce','provider_suppressed')
              then 'provider_suppressed'
            else public.intel_suppressions.reason end,
          source = case
            when excluded.reason = 'complaint'
             and (public.intel_suppressions.source = 'agent' or public.intel_suppressions.source like 'provider:%')
             and lower(btrim(public.intel_suppressions.reason)) in ('bounce','provider_suppressed')
              then excluded.source
            when excluded.reason = 'provider_suppressed'
             and (public.intel_suppressions.source = 'agent' or public.intel_suppressions.source like 'provider:%')
             and lower(btrim(public.intel_suppressions.reason)) in ('bounce','provider_suppressed')
              then excluded.source
            else public.intel_suppressions.source end;
  end if;

  perform public._intel_log(m.organization_id,'system','delivery_event','message',m.id::text,
    jsonb_build_object('provider',p_provider_key,'status',v_status,'event_type',left(p_event_type,120),'applied',v_rank > v_current_rank));
  return jsonb_build_object('ok',true,'found',true,'duplicate',false,'applied',v_rank > v_current_rank,
    'message_id',m.id,'delivery_status',case when v_rank > v_current_rank then v_status else m.delivery_status end);
end $$;

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
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  return public._intel_apply_delivery_event_internal(
    p_provider_key,p_provider_account_id,p_provider_message_id,p_provider_event_id,
    p_event_type,p_status,p_occurred_at,p_recipient,p_reason);
end $$;


create index if not exists email_webhook_events_provider_message_idx
  on public.email_webhook_events ((payload -> 'data' ->> 'email_id'))
  where payload -> 'data' ->> 'email_id' is not null;

-- The signed event payload remains in email_webhook_events as the durable reconciliation record.
-- The webhook receipt itself is the durable pending-event record. If a provider event
-- arrives before the send worker commits the provider message id, replay it when either
-- CRM Inbox or Intelligence later records that exact id. The event receipt is idempotent.
create or replace function public.email_replay_delivery_events_for_message()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare ev record; v_status text; v_recipient text; v_reason text; v_event_at timestamptz; v_detail jsonb;
begin
  if new.provider <> 'resend' or new.direction <> 'outbound' or nullif(new.provider_message_id,'') is null then return new; end if;
  if tg_op = 'UPDATE' and old.provider_message_id is not distinct from new.provider_message_id then return new; end if;
  for ev in
    select svix_id,event_type,payload,received_at from public.email_webhook_events
     where payload -> 'data' ->> 'email_id' = new.provider_message_id
       and event_type in ('email.sent','email.delivered','email.delivery_delayed','email.bounced','email.complained','email.failed','email.suppressed','email.rejected')
     order by received_at,svix_id
  loop
    v_status := case ev.event_type
      when 'email.sent' then 'sent'
      when 'email.delivered' then 'delivered'
      when 'email.delivery_delayed' then 'delivery_delayed'
      when 'email.bounced' then case when coalesce(ev.payload #>> '{data,bounce,type}','') ~* '(temporary|transient|soft)' then 'delivery_delayed' else 'bounced' end
      when 'email.complained' then 'complained'
      when 'email.failed' then 'failed'
      when 'email.suppressed' then 'rejected'
      when 'email.rejected' then 'rejected'
      else null end;
    if v_status is null then continue; end if;
    v_recipient := case when jsonb_typeof(ev.payload #> '{data,to}') = 'array' then
                          case when jsonb_array_length(ev.payload #> '{data,to}') = 1
                               then lower(btrim(ev.payload #>> '{data,to,0}')) else '' end
                        else '' end;
    v_reason := left(coalesce(ev.payload #>> '{data,bounce,message}',ev.payload #>> '{data,failed,reason}',
                              ev.payload #>> '{data,suppressed,message}',ev.payload #>> '{data,reason}',''),400);
    v_detail := jsonb_build_object('reason',v_reason,'recipient',v_recipient,'type',ev.payload #>> '{data,bounce,type}');
    begin v_event_at := nullif(ev.payload ->> 'created_at','')::timestamptz;
    exception when others then v_event_at := null;
    end;
    perform public.email_apply_delivery_event(new.provider_message_id,v_status,ev.event_type,ev.svix_id,
      coalesce(v_event_at,ev.received_at),v_detail);
  end loop;
  return new;
end $$;

create or replace function public.intel_replay_delivery_events_for_message()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare ev record; v_status text; v_recipient text; v_reason text; v_event_at timestamptz;
begin
  if new.provider_key <> 'resend' or new.direction <> 'outbound'
     or new.provider_account_id is null or nullif(new.provider_message_id,'') is null then return new; end if;
  if tg_op = 'UPDATE' and old.provider_message_id is not distinct from new.provider_message_id then return new; end if;
  for ev in
    select svix_id,event_type,payload,received_at from public.email_webhook_events
     where payload -> 'data' ->> 'email_id' = new.provider_message_id
       and event_type in ('email.sent','email.delivered','email.delivery_delayed','email.bounced','email.complained','email.failed','email.suppressed','email.rejected')
     order by received_at,svix_id
  loop
    v_status := case ev.event_type
      when 'email.sent' then 'accepted'
      when 'email.delivered' then 'delivered'
      when 'email.delivery_delayed' then 'delayed'
      when 'email.bounced' then case when coalesce(ev.payload #>> '{data,bounce,type}','') ~* '(temporary|transient|soft)' then 'delayed' else 'bounced' end
      when 'email.complained' then 'complained'
      when 'email.failed' then 'failed'
      when 'email.suppressed' then 'failed'
      when 'email.rejected' then 'failed'
      else null end;
    if v_status is null then continue; end if;
    v_recipient := case when jsonb_typeof(ev.payload #> '{data,to}') = 'array' then
                          case when jsonb_array_length(ev.payload #> '{data,to}') = 1
                               then lower(btrim(ev.payload #>> '{data,to,0}')) else '' end
                        else '' end;
    v_reason := left(coalesce(ev.payload #>> '{data,bounce,message}',ev.payload #>> '{data,failed,reason}',
                              ev.payload #>> '{data,suppressed,message}',ev.payload #>> '{data,reason}',''),240);
    begin v_event_at := nullif(ev.payload ->> 'created_at','')::timestamptz;
    exception when others then v_event_at := null;
    end;
    perform public._intel_apply_delivery_event_internal(new.provider_key,new.provider_account_id,
      new.provider_message_id,ev.svix_id,ev.event_type,v_status,
      coalesce(v_event_at,ev.received_at),coalesce(nullif(v_recipient,''),new.to_email),v_reason);
  end loop;
  return new;
end $$;

drop trigger if exists email_messages_replay_delivery_events on public.email_messages;
create trigger email_messages_replay_delivery_events
after insert or update of provider_message_id on public.email_messages
for each row execute function public.email_replay_delivery_events_for_message();

drop trigger if exists intel_messages_replay_delivery_events on public.intel_messages;
create trigger intel_messages_replay_delivery_events
after insert or update of provider_message_id on public.intel_messages
for each row execute function public.intel_replay_delivery_events_for_message();

revoke all on function public._intel_apply_delivery_event_internal(text,uuid,text,text,text,text,timestamptz,text,text) from public, anon, authenticated, service_role;
revoke all on function public.email_replay_delivery_events_for_message() from public, anon, authenticated;
revoke all on function public.intel_replay_delivery_events_for_message() from public, anon, authenticated;

revoke all on function public.email_webhook_claim(text,text,jsonb,int,int) from public, anon, authenticated;
grant execute on function public.email_webhook_claim(text,text,jsonb,int,int) to service_role;
revoke all on function public.email_apply_delivery_event(text,text,text,text,timestamptz,jsonb) from public, anon, authenticated;
grant execute on function public.email_apply_delivery_event(text,text,text,text,timestamptz,jsonb) to service_role;
revoke all on function public.intel_agent_apply_delivery_event(text,uuid,text,text,text,text,timestamptz,text,text) from public, anon, authenticated;
grant execute on function public.intel_agent_apply_delivery_event(text,uuid,text,text,text,text,timestamptz,text,text) to service_role;
commit;
