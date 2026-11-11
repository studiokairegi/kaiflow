-- Emergency rollback for 20261223100000_email_crm_timeline_reconciliation.sql.
-- Review the matching section in docs/PHASE_7_DEPLOYMENT_MANIFEST.md before use.
--
-- REQUIRED ORDER:
--   1. Back up the database.
--   2. Redeploy the previous resend-webhook / Edge Function version that calls
--      email_reconcile_tagged_delivery_event(), NOT the *_with_rfc wrapper.
--   3. Only then run this script in the intended database as a trusted operator.
--
-- This restores the pre-reconciliation inbound timeline behavior. It does not
-- reverse timeline entries already backfilled/relinked by the forward migration.
-- It also removes webhook-based RFC Message-ID recovery; the send-path retrieval
-- remains whatever is present in the separately deployed prior function version.

begin;

-- Remove the two new relink/rethread triggers first.
drop trigger if exists email_messages_rethread_timeline on public.email_messages;
drop trigger if exists email_conversations_crm_timeline on public.email_conversations;

-- Replace the inbound trigger function below with its Phase 5 implementation.
drop trigger if exists email_messages_inbound_timeline on public.email_messages;

-- The migration introduced these helpers and the service-only RFC wrapper.
drop function if exists public._email_rethread_message_timeline();
drop function if exists public._email_reconcile_conversation_timeline();
drop function if exists public._email_sync_message_crm_timeline(uuid);
drop function if exists public.email_reconcile_tagged_delivery_event_with_rfc(
  uuid, text, text, text, timestamptz, jsonb, text, text[], text
);

-- Restore the stale-editor guard from 20261221090000_email_crm_inbound_timeline.sql.
create or replace function public._email_preserve_crm_activity_entries() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
declare
  v_entry jsonb;
  v_log jsonb := coalesce(new.activity_log, '[]'::jsonb);
begin
  if tg_op = 'UPDATE' then
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

-- Restore the original inbound-only append behavior from 20261221090000.
create or replace function public._email_append_inbound_timeline() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_lead uuid;
  v_entry jsonb;
  v_from text;
begin
  if new.direction <> 'inbound' then return new; end if;
  begin
    select c.lead_id into v_lead
      from public.email_conversations c
     where c.id = new.conversation_id;
    if v_lead is null then return new; end if;
    v_from := coalesce(nullif(new.from_name, ''), nullif(new.from_email, ''), 'sender');
    v_entry := jsonb_build_object(
      'ts', coalesce(new.received_at, new.created_at, now()),
      'type', 'email_received',
      'note', left('Email received from ' || v_from || ' — ' || coalesce(nullif(new.subject, ''), '(no subject)'), 500),
      'emailMessageId', new.id,
      'emailConversationId', new.conversation_id,
      'provider', new.provider
    );
    update public.leads
       set activity_log = coalesce(activity_log, '[]'::jsonb) || jsonb_build_array(v_entry)
     where id = v_lead
       and not exists (
         select 1 from jsonb_array_elements(coalesce(activity_log, '[]'::jsonb)) e
          where e ->> 'emailMessageId' = new.id::text
       );
  exception when others then
    raise warning 'email inbound CRM timeline entry skipped for message %: %', new.id, sqlerrm;
  end;
  return new;
end $$;
revoke all on function public._email_append_inbound_timeline() from public, anon, authenticated;

create trigger email_messages_inbound_timeline
  after insert on public.email_messages
  for each row when (new.direction = 'inbound')
  execute function public._email_append_inbound_timeline();

-- email_link_lead(uuid,uuid) is intentionally left in place: the Phase 7
-- definition is identical to the authorization-preserving definition in
-- 20261110090000_email_resend_core.sql. email_message_conversation(uuid) is
-- also unchanged and remains available.

commit;
