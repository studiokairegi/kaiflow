-- Phase 5 follow-up: inbound replies on the CRM lead timeline, and "open this email" from a timeline entry.
-- Requires 20261208100000_email_crm_activity.sql. Idempotent; makes no provider calls and changes no send behaviour.

-- 1. Keep BOTH email entry types when a stale lead editor saves the whole activity_log (extends the Phase 4D guard).
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

-- 2. A reply that arrives in a conversation linked to a CRM lead becomes one `email_received` timeline entry.
--    Runs for every ingestion path (webhook or mailbox sync) because it hangs off the message insert. Only rows that are really
--    inserted fire it, so a duplicate provider delivery (ON CONFLICT DO NOTHING) cannot add a second entry. A failure here must
--    never block receiving mail, so it is reported as a warning and swallowed.
create or replace function public._email_append_inbound_timeline() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_lead uuid;
  v_entry jsonb;
  v_from text;
begin
  if new.direction <> 'inbound' then return new; end if;
  begin
    select c.lead_id into v_lead from public.email_conversations c where c.id = new.conversation_id;
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

drop trigger if exists email_messages_inbound_timeline on public.email_messages;
create trigger email_messages_inbound_timeline
  after insert on public.email_messages
  for each row when (new.direction = 'inbound')
  execute function public._email_append_inbound_timeline();

-- 3. Resolve a timeline entry's email to its Inbox conversation (entries written before this migration carry only the message id).
create or replace function public.email_message_conversation(p_message_id uuid) returns uuid
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.email_require_access();
begin
  return (select m.conversation_id from public.email_messages m where m.id = p_message_id and m.organization_id = v_org);
end $$;
revoke all on function public.email_message_conversation(uuid) from public, anon;
grant execute on function public.email_message_conversation(uuid) to authenticated;

-- Rollback (leaves all email and CRM data in place; existing email_received entries stay on the timeline):
--   drop trigger if exists email_messages_inbound_timeline on public.email_messages;
--   drop function if exists public._email_append_inbound_timeline();
--   drop function if exists public.email_message_conversation(uuid);
--   -- and re-apply the _email_preserve_crm_activity_entries() body from 20261208100000_email_crm_activity.sql
