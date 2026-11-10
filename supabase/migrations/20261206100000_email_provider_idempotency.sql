begin;

-- Phase 4C corrective hardening: bind an idempotency key to the complete original submission,
-- and make legacy rows without a fingerprint fail closed on key reuse.
-- Rollback: drop the request_fingerprint column and restore the prior email_create_outbound
-- definition from 20261204100000_email_provider_scoping.sql. Nothing here deletes messages.
-- Phase 4C corrective hardening: bind an idempotency key to the complete original submission,
-- and make legacy rows without a fingerprint fail closed on key reuse.
alter table public.email_messages add column if not exists request_fingerprint text;

create or replace function public.email_create_outbound(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := (p ->> 'organization_id')::uuid; v_acc public.email_accounts; v_conv uuid := nullif(p ->> 'conversation_id', '')::uuid; v_conv_acc uuid; v_draft_acc uuid;
  v_draft uuid := nullif(p ->> 'draft_id', '')::uuid; v_key text := nullif(p ->> 'idempotency_key', ''); m public.email_messages; v_addr text; r text; v_fingerprint text;
begin
  v_fingerprint := md5(jsonb_build_object(
    'account_id', p ->> 'account_id', 'user_id', p ->> 'user_id', 'conversation_id', nullif(p ->> 'conversation_id',''),
    'draft_id', nullif(p ->> 'draft_id',''), 'to_emails', coalesce(p -> 'to_emails','[]'::jsonb),
    'cc_emails', coalesce(p -> 'cc_emails','[]'::jsonb), 'bcc_emails', coalesce(p -> 'bcc_emails','[]'::jsonb),
    'reply_to', coalesce(p ->> 'reply_to',''), 'subject', coalesce(p ->> 'subject',''),
    'body_text', coalesce(p ->> 'body_text',''), 'body_html', coalesce(p ->> 'body_html',''),
    'in_reply_to', nullif(p ->> 'in_reply_to',''), 'references_ids', nullif(p ->> 'references_ids',''),
    'attachments', coalesce(p -> 'attachments','[]'::jsonb)
  )::text);
  select * into v_acc from public.email_accounts where id = (p ->> 'account_id')::uuid and organization_id = v_org;
  if not found then raise exception 'Sender address not found'; end if;
  if v_key is not null then
    select * into m from public.email_messages where organization_id = v_org and idempotency_key = v_key;
    if found then
      if m.account_id <> v_acc.id or m.request_fingerprint is null or m.request_fingerprint <> v_fingerprint then
        raise exception 'idempotency_key_conflict' using errcode = '22023';
      end if;
      return jsonb_build_object('duplicate', true, 'message_id', m.id, 'conversation_id', m.conversation_id, 'status', m.status, 'provider_message_id', m.provider_message_id);
    end if;
  end if;
  if v_conv is not null then
    select account_id into v_conv_acc from public.email_conversations where id = v_conv and organization_id = v_org;
    if not found then raise exception 'Conversation not found'; end if;
    if v_conv_acc <> v_acc.id then raise exception 'This conversation belongs to a different sender account'; end if;
  end if;
  if v_draft is not null then
    select conversation_id, account_id into v_conv, v_draft_acc from public.email_messages where id = v_draft and organization_id = v_org and status = 'draft' for update;
    if not found then raise exception 'Draft not found'; end if;
    if v_draft_acc <> v_acc.id then raise exception 'This draft belongs to a different sender account'; end if;
    update public.email_messages
       set status = 'queued', from_email = v_acc.address, from_name = v_acc.display_name,
           to_emails = coalesce(array(select jsonb_array_elements_text(p -> 'to_emails')), '{}'), cc_emails = coalesce(array(select jsonb_array_elements_text(p -> 'cc_emails')), '{}'),
           bcc_emails = coalesce(array(select jsonb_array_elements_text(p -> 'bcc_emails')), '{}'), reply_to = left(coalesce(p ->> 'reply_to', ''), 500),
           subject = left(coalesce(p ->> 'subject', ''), 998), body_text = left(coalesce(p ->> 'body_text', ''), 200000), body_html = left(coalesce(p ->> 'body_html', ''), 400000),
           in_reply_to = nullif(p ->> 'in_reply_to', ''), references_ids = nullif(p ->> 'references_ids', ''), idempotency_key = v_key, request_fingerprint = v_fingerprint, created_by = nullif(p ->> 'user_id', '')::uuid
     where id = v_draft returning * into m;
  else
    if v_conv is null then
      insert into public.email_conversations (organization_id, account_id, subject, normalized_subject)
      values (v_org, v_acc.id, left(coalesce(p ->> 'subject', ''), 998), coalesce(p ->> 'normalized_subject', '')) returning id into v_conv;
    end if;
    insert into public.email_messages (organization_id, conversation_id, account_id, direction, status, from_email, from_name, to_emails, cc_emails, bcc_emails, reply_to,
           subject, body_text, body_html, in_reply_to, references_ids, is_read, idempotency_key, request_fingerprint, created_by)
    values (v_org, v_conv, v_acc.id, 'outbound', 'queued', v_acc.address, v_acc.display_name,
            coalesce(array(select jsonb_array_elements_text(p -> 'to_emails')), '{}'), coalesce(array(select jsonb_array_elements_text(p -> 'cc_emails')), '{}'),
            coalesce(array(select jsonb_array_elements_text(p -> 'bcc_emails')), '{}'), left(coalesce(p ->> 'reply_to', ''), 500),
            left(coalesce(p ->> 'subject', ''), 998), left(coalesce(p ->> 'body_text', ''), 200000), left(coalesce(p ->> 'body_html', ''), 400000),
            nullif(p ->> 'in_reply_to', ''), nullif(p ->> 'references_ids', ''), true, v_key, v_fingerprint, nullif(p ->> 'user_id', '')::uuid)
    returning * into m;
  end if;
  -- everyone on the message becomes a participant of the conversation
  foreach r in array array['to_emails', 'cc_emails'] loop
    for v_addr in select lower(btrim(x)) from jsonb_array_elements_text(coalesce(p -> r, '[]'::jsonb)) x loop
      insert into public.email_participants (organization_id, conversation_id, email) values (v_org, m.conversation_id, v_addr) on conflict (conversation_id, email) do nothing;
    end loop;
  end loop;
  insert into public.email_participants (organization_id, conversation_id, email, name) values (v_org, m.conversation_id, v_acc.address, v_acc.display_name) on conflict (conversation_id, email) do nothing;
  return jsonb_build_object('duplicate', false, 'message_id', m.id, 'conversation_id', m.conversation_id, 'status', m.status);
end $$;
revoke all on function public.email_create_outbound(jsonb) from public, anon, authenticated;
grant execute on function public.email_create_outbound(jsonb) to service_role;



commit;

-- OWNER NOTES (not executed)
--   * Pre-flight, read-only: rows that would violate the new provider references (expect 0 rows from both):
--       select id, provider from public.email_accounts where provider not in (select provider_key from public.email_provider_registry);
--       select m.id from public.email_messages m join public.email_accounts a on a.id = m.account_id where m.provider <> a.provider;
--   * If a warning said a constraint was left NOT VALID, fix the rows above, then:
--       alter table public.email_accounts validate constraint email_accounts_provider_registry_fk;
--       alter table public.email_messages validate constraint email_messages_provider_registry_fk;
--       alter table public.email_messages validate constraint email_messages_account_provider_fk;
--   * Event ids: email_events keeps its global unique index on provider_event_id. Every future adapter MUST prefix the ids it stores
--     with its provider key (for example 'gmail:...') so ids from different providers cannot collide. Phase 3 contract rule.
-- Rollback (nothing here deletes data; run this BEFORE the registry migration's rollback):
--   drop trigger if exists email_messages_provider_from_account on public.email_messages;
--   drop trigger if exists email_messages_owner_immutable on public.email_messages;
--   drop trigger if exists email_conversations_owner_immutable on public.email_conversations;
--   drop trigger if exists email_accounts_owner_immutable on public.email_accounts;
--   drop function if exists public._email_message_provider_from_account(), public._email_owner_immutable();
--   alter table public.email_messages alter column provider set default 'resend';
--   alter table public.email_messages drop constraint if exists email_messages_account_provider_fk;
--   alter table public.email_messages drop constraint if exists email_messages_provider_registry_fk;
--   alter table public.email_accounts drop constraint if exists email_accounts_provider_registry_fk;
--   -- restore the org-wide indexes (fails if two accounts of one organization already hold the same provider/RFC id: resolve those first)
--   create unique index if not exists email_accounts_address_uidx on public.email_accounts(organization_id, address);          -- fails if an address exists under two providers
--   create unique index if not exists email_messages_provider_uidx on public.email_messages(organization_id, direction, provider_message_id) where provider_message_id is not null;
--   create unique index if not exists email_messages_rfc_uidx on public.email_messages(organization_id, rfc_message_id) where rfc_message_id is not null;
--   drop index if exists public.email_messages_account_provider_uidx, public.email_messages_account_rfc_uidx, public.email_accounts_provider_address_uidx, public.email_accounts_id_provider_uidx;
--   -- the Resend-only check (only if every account is 'resend'):
--   alter table public.email_accounts add constraint email_accounts_provider_check check (provider = 'resend');
--   -- functions: re-run the function definitions of 20261110090000 (email_save_draft, email_create_outbound) and 20261111090000 (email_ingest_inbound);
--   -- restore the two-argument account RPC:
--   drop function if exists public.email_upsert_account(text, text, text);
--   -- then re-run email_upsert_account(text,text) from 20261110090000 (its 'on conflict (organization_id, address)' needs email_accounts_address_uidx back first).

commit;
