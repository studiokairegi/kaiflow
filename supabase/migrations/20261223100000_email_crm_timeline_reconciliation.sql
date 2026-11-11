-- Phase 5 confirmed sync fixes: RFC threading persistence is handled by the send path;
-- this migration reconciles CRM timeline entries when conversations are linked/unlinked/re-threaded.
begin;

-- A controlled relink operation may remove email timeline entries from the former lead.
-- Ordinary CRM saves still preserve server-authored email entries against stale browser snapshots.
create or replace function public._email_preserve_crm_activity_entries() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
declare
  v_entry jsonb;
  v_log jsonb := coalesce(new.activity_log, '[]'::jsonb);
begin
  if tg_op = 'UPDATE' and current_setting('app.email_timeline_relink', true) is distinct from 'on' then
    for v_entry in
      select e.value from jsonb_array_elements(coalesce(old.activity_log, '[]'::jsonb)) e(value)
       where e.value ->> 'type' in ('email_sent', 'email_received') and e.value ? 'emailMessageId'
    loop
      if not exists (
        select 1 from jsonb_array_elements(v_log) n(value)
         where n.value ->> 'emailMessageId' = v_entry ->> 'emailMessageId'
      ) then
        v_log := v_log || jsonb_build_array(v_entry);
      end if;
    end loop;
    new.activity_log := v_log;
  end if;
  return new;
end $$;

-- Rebuild exactly one message's timeline projection from its current conversation link.
-- This is idempotent and intentionally leaves non-email CRM activity untouched.
create or replace function public._email_sync_message_crm_timeline(p_message_id uuid) returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  m public.email_messages;
  v_lead uuid;
  v_entry jsonb;
  v_from text;
  v_auto_submitted text;
  v_precedence text;
  v_auto_reply text;
  v_local text;
  v_previous_relink_flag text;
begin
  select * into m from public.email_messages where id = p_message_id;
  if not found then return; end if;
  select c.lead_id into v_lead from public.email_conversations c
   where c.id = m.conversation_id and c.organization_id = m.organization_id;

  v_previous_relink_flag := current_setting('app.email_timeline_relink', true);
  perform set_config('app.email_timeline_relink', 'on', true);
  update public.leads l
     set activity_log = coalesce((
       select jsonb_agg(e.value order by e.ordinality)
         from jsonb_array_elements(coalesce(l.activity_log, '[]'::jsonb)) with ordinality e(value, ordinality)
        where e.value ->> 'emailMessageId' is distinct from m.id::text
     ), '[]'::jsonb)
   where exists (
     select 1 from jsonb_array_elements(coalesce(l.activity_log, '[]'::jsonb)) e
      where e ->> 'emailMessageId' = m.id::text
   );
  perform set_config('app.email_timeline_relink', coalesce(v_previous_relink_flag, ''), true);

  if v_lead is null then return; end if;

  if m.direction = 'inbound' then
    v_local := lower(split_part(coalesce(m.from_email, ''), '@', 1));
    v_auto_submitted := lower(coalesce(m.headers ->> 'auto-submitted', ''));
    v_precedence := lower(coalesce(m.headers ->> 'precedence', ''));
    v_auto_reply := lower(coalesce(m.headers ->> 'x-autoreply', m.headers ->> 'x-autorespond', ''));
    if v_local in ('mailer-daemon', 'postmaster')
       or (v_auto_submitted <> '' and v_auto_submitted <> 'no')
       or v_precedence in ('bulk', 'list', 'junk')
       or v_auto_reply in ('yes', 'true', '1')
       or lower(coalesce(m.subject, '')) ~ '(automatic reply|auto.?reply|out of office|undeliverable|delivery status notification|mail delivery failed|returned mail)' then
      return;
    end if;
    v_from := coalesce(nullif(m.from_name, ''), nullif(m.from_email, ''), 'sender');
    v_entry := jsonb_build_object(
      'ts', coalesce(m.received_at, m.created_at, now()),
      'type', 'email_received',
      'note', left('Email received from ' || v_from || ' — ' || coalesce(nullif(m.subject, ''), '(no subject)'), 500),
      'emailMessageId', m.id,
      'emailConversationId', m.conversation_id,
      'provider', m.provider
    );
  elsif m.direction = 'outbound' and m.status in ('sent','delivered','delivery_delayed','bounced','complained') then
    v_entry := jsonb_build_object(
      'ts', coalesce(m.sent_at, m.created_at, now()),
      'type', 'email_sent',
      'note', left('Email sent to ' || coalesce(nullif(m.to_emails[1], ''), 'recipient') || ' — ' || coalesce(nullif(m.subject, ''), '(no subject)'), 500),
      'emailMessageId', m.id,
      'emailConversationId', m.conversation_id,
      'provider', m.provider,
      'providerMessageId', m.provider_message_id
    );
  else
    return;
  end if;

  update public.leads l
     set activity_log = coalesce(l.activity_log, '[]'::jsonb) || jsonb_build_array(v_entry)
   where l.id = v_lead
     and not exists (
       select 1 from jsonb_array_elements(coalesce(l.activity_log, '[]'::jsonb)) e
        where e ->> 'emailMessageId' = m.id::text
     );
exception when others then
  raise warning 'email CRM timeline reconciliation skipped for message %: %', p_message_id, sqlerrm;
end $$;
revoke all on function public._email_sync_message_crm_timeline(uuid) from public, anon, authenticated;

-- Existing inbound insert path now uses the same reconciliation logic as link/rethread operations.
create or replace function public._email_append_inbound_timeline() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if new.direction = 'inbound' then
    perform public._email_sync_message_crm_timeline(new.id);
  end if;
  return new;
end $$;
revoke all on function public._email_append_inbound_timeline() from public, anon, authenticated;

drop trigger if exists email_messages_inbound_timeline on public.email_messages;
create trigger email_messages_inbound_timeline
  after insert on public.email_messages
  for each row when (new.direction = 'inbound')
  execute function public._email_append_inbound_timeline();

-- A duplicate inbound message may be re-associated by email_ingest_inbound's UPDATE path.
create or replace function public._email_rethread_message_timeline() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if new.conversation_id is distinct from old.conversation_id then
    perform public._email_sync_message_crm_timeline(new.id);
  end if;
  return new;
end $$;
revoke all on function public._email_rethread_message_timeline() from public, anon, authenticated;
drop trigger if exists email_messages_rethread_timeline on public.email_messages;
create trigger email_messages_rethread_timeline
  after update of conversation_id on public.email_messages
  for each row when (new.conversation_id is distinct from old.conversation_id)
  execute function public._email_rethread_message_timeline();

-- Link/unlink/relink: reconcile every existing message in the conversation, not only future inserts.
create or replace function public._email_reconcile_conversation_timeline() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v record;
begin
  if new.lead_id is not distinct from old.lead_id then return new; end if;
  for v in select id from public.email_messages where conversation_id = new.id order by coalesce(received_at, sent_at, created_at), created_at loop
    perform public._email_sync_message_crm_timeline(v.id);
  end loop;
  return new;
end $$;
revoke all on function public._email_reconcile_conversation_timeline() from public, anon, authenticated;
drop trigger if exists email_conversations_crm_timeline on public.email_conversations;
create trigger email_conversations_crm_timeline
  after update of lead_id on public.email_conversations
  for each row when (new.lead_id is distinct from old.lead_id)
  execute function public._email_reconcile_conversation_timeline();

-- Preserve the original authorization contract: only the signed-in user's own lead may be linked.
create or replace function public.email_link_lead(p_conversation_id uuid, p_lead_id uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.email_require_access();
begin
  if p_lead_id is not null and not exists (
    select 1 from public.leads l where l.id = p_lead_id and l.user_id = auth.uid()
  ) then
    raise exception 'Lead not found';
  end if;
  update public.email_conversations set lead_id = p_lead_id
   where id = p_conversation_id and organization_id = v_org;
  if not found then raise exception 'Conversation not found'; end if;
  return jsonb_build_object('lead_id', p_lead_id);
end $$;
revoke all on function public.email_link_lead(uuid,uuid) from public, anon;
grant execute on function public.email_link_lead(uuid,uuid) to authenticated;

-- Resend now exposes its provider-generated RFC Message-ID in GET /emails/:id and signed
-- email.* webhook payloads. Keep the existing tagged-reconciliation RPC signature intact;
-- this service-only wrapper also persists the RFC id when the signed event arrives.
create or replace function public.email_reconcile_tagged_delivery_event_with_rfc(
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
  v_result jsonb;
  v_rfc text := nullif(btrim(coalesce(p_detail ->> 'message_id', '')), '');
begin
  v_result := public.email_reconcile_tagged_delivery_event(
    p_message_id, p_provider_message_id, p_event_type, p_provider_event_id,
    p_occurred_at, p_detail, p_sender_email, p_recipients, p_subject
  );
  if v_result ->> 'found' = 'true' and v_rfc is not null then
    if length(v_rfc) > 998 or v_rfc !~ '^<[^<>[:cntrl:]]{1,996}>$' then
      return v_result || jsonb_build_object('rfc_message_id_saved', false);
    end if;
    update public.email_messages
       set rfc_message_id = v_rfc
     where id = p_message_id
       and provider = 'resend'
       and direction = 'outbound'
       and (rfc_message_id is null or rfc_message_id = v_rfc);
    if not found then
      return v_result || jsonb_build_object('conflict', true, 'rfc_message_id_saved', false);
    end if;
    return v_result || jsonb_build_object('rfc_message_id_saved', true);
  end if;
  return v_result;
end $$;
revoke all on function public.email_reconcile_tagged_delivery_event_with_rfc(uuid,text,text,text,timestamptz,jsonb,text,text[],text) from public, anon, authenticated;
grant execute on function public.email_reconcile_tagged_delivery_event_with_rfc(uuid,text,text,text,timestamptz,jsonb,text,text[],text) to service_role;

commit;

-- Rollback: restore email_link_lead(uuid,uuid) from 20261110090000_email_resend_core.sql;
-- restore _email_preserve_crm_activity_entries() and _email_append_inbound_timeline() from
-- 20261221090000_email_crm_inbound_timeline.sql; drop the three new timeline triggers/functions.
