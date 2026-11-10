-- Phase 4F corrective recovery: reconcile a provider-accepted send even when every
-- post-send database write failed. Resend echoes the server-generated kf_message_id
-- custom tag in signed email.* webhook events. Nothing is sent by applying this migration; no provider request is repeated here.
begin;

do $$ begin
  if to_regclass('public.email_messages') is null
     or to_regclass('public.email_webhook_events') is null
     or to_regprocedure('public.email_record_crm_activity(uuid)') is null
     or to_regprocedure('public.email_apply_delivery_event(text,text,text,text,timestamptz,jsonb)') is null
     or to_regprocedure('public._email_status_rank(text)') is null then
    raise exception 'Apply the Phase 4C–4F email prerequisites before accepted-send reconciliation';
  end if;
end $$;

-- Persist the provider acceptance response without ever moving a message backwards.
-- A webhook may have already advanced it to delivered/bounced/complained before the
-- synchronous send handler receives its HTTP response.
create or replace function public.email_mark_provider_accepted(
  p_message_id uuid, p_provider_message_id text, p_sent_at timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare m public.email_messages;
begin
  if p_message_id is null or nullif(btrim(coalesce(p_provider_message_id,'')), '') is null then
    raise exception 'Message and provider message id are required' using errcode = '22023';
  end if;
  select * into m from public.email_messages where id = p_message_id for update;
  if not found or m.direction <> 'outbound' then raise exception 'Outbound email message not found'; end if;
  if not exists (select 1 from public.email_accounts a where a.id = m.account_id and a.organization_id = m.organization_id and a.provider = m.provider) then
    raise exception 'Sender account/provider ownership mismatch';
  end if;
  if m.provider_message_id is not null and m.provider_message_id <> p_provider_message_id then
    raise exception 'Provider message id conflicts with the persisted message';
  end if;
  if exists (
    select 1 from public.email_messages x
     where x.provider = m.provider and x.direction = 'outbound'
       and x.provider_message_id = p_provider_message_id and x.id <> m.id
  ) then raise exception 'Provider message id is already assigned to another message'; end if;

  update public.email_messages
     set provider_message_id = p_provider_message_id,
         status = case when public._email_status_rank('sent') > public._email_status_rank(status) then 'sent' else status end,
         sent_at = coalesce(sent_at, p_sent_at, now()), error = ''
   where id = m.id;
  select * into m from public.email_messages where id = p_message_id;
  return jsonb_build_object('saved', true, 'message_id', m.id, 'status', m.status, 'provider_message_id', m.provider_message_id);
end $$;

-- A signed Resend webhook is the durable recovery channel. The custom tag is only a
-- lookup hint: sender, account, subject and recipients are checked against the stored
-- outbound row before the provider id can be attached.
create or replace function public.email_reconcile_tagged_delivery_event(
  p_message_id uuid,
  p_provider_message_id text,
  p_event_type text,
  p_provider_event_id text,
  p_occurred_at timestamptz,
  p_detail jsonb,
  p_sender_email text,
  p_recipients text[],
  p_subject text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  m public.email_messages;
  a public.email_accounts;
  v_status text;
  v_recipients text[];
  v_expected text[];
begin
  v_status := case p_event_type
    when 'email.sent' then 'sent'
    when 'email.delivered' then 'delivered'
    when 'email.delivery_delayed' then 'delivery_delayed'
    when 'email.bounced' then case when coalesce(p_detail ->> 'type','') ~* '(temporary|transient|soft)' then 'delivery_delayed' else 'bounced' end
    when 'email.complained' then 'complained'
    else null end;
  if v_status is null then raise exception 'Webhook event does not prove provider acceptance' using errcode = '22023'; end if;
  if p_message_id is null or nullif(btrim(coalesce(p_provider_message_id,'')), '') is null
     or nullif(btrim(coalesce(p_provider_event_id,'')), '') is null then
    raise exception 'Message, provider message and event ids are required' using errcode = '22023';
  end if;

  select * into m from public.email_messages where id = p_message_id for update;
  if not found then return jsonb_build_object('found', false); end if;
  if m.provider <> 'resend' or m.direction <> 'outbound' then
    return jsonb_build_object('found', false, 'conflict', true);
  end if;
  if m.status not in ('sending','sent','delivery_delayed','delivered','bounced','complained') then
    return jsonb_build_object('found', false, 'conflict', true);
  end if;
  if m.provider_message_id is not null and m.provider_message_id <> p_provider_message_id then
    return jsonb_build_object('found', false, 'conflict', true);
  end if;

  select * into a from public.email_accounts
   where id = m.account_id and organization_id = m.organization_id and provider = 'resend';
  if not found or lower(btrim(coalesce(a.address,''))) <> lower(btrim(coalesce(p_sender_email,''))) then
    return jsonb_build_object('found', false, 'conflict', true);
  end if;
  if coalesce(m.subject,'') <> coalesce(p_subject,'') then
    return jsonb_build_object('found', false, 'conflict', true);
  end if;

  select coalesce(array_agg(distinct lower(btrim(x))), '{}') into v_recipients
    from unnest(coalesce(p_recipients, array[]::text[])) x
   where nullif(btrim(x),'') is not null;
  v_expected := array(
    select distinct lower(btrim(x))
      from unnest(coalesce(m.to_emails,'{}') || coalesce(m.cc_emails,'{}') || coalesce(m.bcc_emails,'{}')) x
     where nullif(btrim(x),'') is not null
  );
  if cardinality(v_recipients) = 0
     or not (v_recipients && v_expected)
     or exists (select 1 from unnest(v_recipients) x where not (x = any(v_expected))) then
    return jsonb_build_object('found', false, 'conflict', true);
  end if;

  if exists (
    select 1 from public.email_messages x
     where x.provider = 'resend' and x.direction = 'outbound'
       and x.provider_message_id = p_provider_message_id and x.id <> m.id
  ) then
    return jsonb_build_object('found', false, 'conflict', true);
  end if;

  update public.email_messages set provider_message_id = p_provider_message_id
   where id = m.id and provider_message_id is null;
  -- Updating provider_message_id replays any webhook events already durably queued.
  -- Apply this event explicitly too: it is idempotent and covers a repeat tag event
  -- when the provider id was already attached by a previous partial recovery.
  perform public.email_apply_delivery_event(
    p_provider_message_id, v_status, p_event_type, p_provider_event_id,
    coalesce(p_occurred_at, now()), coalesce(p_detail, '{}'::jsonb)
  );

  select * into m from public.email_messages where id = p_message_id;
  if m.crm_lead_id is not null and m.status in ('sent','delivered','delivery_delayed','bounced','complained') then
    perform public.email_record_crm_activity(m.id);
  end if;
  return jsonb_build_object('found', true, 'message_id', m.id, 'status', m.status, 'provider_message_id', m.provider_message_id);
end $$;

revoke all on function public.email_mark_provider_accepted(uuid,text,timestamptz) from public, anon, authenticated;
grant execute on function public.email_mark_provider_accepted(uuid,text,timestamptz) to service_role;
revoke all on function public.email_reconcile_tagged_delivery_event(uuid,text,text,text,timestamptz,jsonb,text,text[],text) from public, anon, authenticated;
grant execute on function public.email_reconcile_tagged_delivery_event(uuid,text,text,text,timestamptz,jsonb,text,text[],text) to service_role;

commit;

-- Rollback: drop the two RPCs above. No email rows or provider events are deleted.
-- drop function public.email_reconcile_tagged_delivery_event(uuid,text,text,text,timestamptz,jsonb,text,text[],text);
-- drop function public.email_mark_provider_accepted(uuid,text,timestamptz);
