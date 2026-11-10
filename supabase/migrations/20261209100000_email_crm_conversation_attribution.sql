-- Phase 4D corrective migration: make conversation-to-CRM attribution authoritative and atomic.
-- Locks the conversation (and draft, when applicable), rejects stale/conflicting lead IDs,
-- and writes the lead association before queuing the outbound message. This function never
-- contacts an email provider; provider submission remains in the Edge Function after commit.
begin;

create or replace function public.email_create_outbound(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := (p ->> 'organization_id')::uuid;
  v_acc public.email_accounts;
  v_conv uuid := nullif(p ->> 'conversation_id', '')::uuid;
  v_conv_acc uuid;
  v_draft uuid := nullif(p ->> 'draft_id', '')::uuid;
  v_draft_acc uuid;
  v_draft_status text;
  v_conv_lead uuid;
  v_key text := nullif(p ->> 'idempotency_key', '');
  v_lead uuid := nullif(p ->> 'crm_lead_id', '')::uuid;
  v_crm_user uuid := nullif(p ->> 'crm_user_id', '')::uuid;
  v_lead_owner uuid;
  m public.email_messages;
  v_addr text;
  r text;
  v_fingerprint text;
begin
  select * into v_acc from public.email_accounts where id = (p ->> 'account_id')::uuid and organization_id = v_org;
  if not found then raise exception 'Sender address not found'; end if;

  -- Serialize submissions sharing an organization-scoped idempotency key. This closes the
  -- read-before-insert race for concurrent new conversations as well as draft submissions.
  if v_key is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_org::text || ':' || v_key, 0));
  end if;
  -- Resolve a draft's conversation before fingerprinting, but allow an already-submitted
  -- draft row to be found on an idempotent retry. The draft row and conversation are locked
  -- so a concurrent lead relink cannot race this authoritative decision.
  if v_draft is not null then
    select conversation_id, account_id, status into v_conv, v_draft_acc, v_draft_status
      from public.email_messages
     where id = v_draft and organization_id = v_org
     for update;
    if not found then raise exception 'Draft not found'; end if;
    if v_draft_acc <> v_acc.id then raise exception 'This draft belongs to a different sender account'; end if;
    if nullif(p ->> 'conversation_id', '') is not null
       and (p ->> 'conversation_id')::uuid is distinct from v_conv then
      raise exception 'Draft conversation does not match the requested conversation';
    end if;
  end if;

  if v_conv is not null then
    select account_id, lead_id into v_conv_acc, v_conv_lead
      from public.email_conversations
     where id = v_conv and organization_id = v_org
     for update;
    if not found then raise exception 'Conversation not found'; end if;
    if v_conv_acc <> v_acc.id then raise exception 'This conversation belongs to a different sender account'; end if;
    if v_conv_lead is not null and v_lead is not null and v_conv_lead <> v_lead then
      raise exception 'crm_lead_conflict' using errcode = '22023';
    end if;
    if v_lead is null then v_lead := v_conv_lead; end if;
    if v_conv_lead is null and v_lead is not null then
      update public.email_conversations set lead_id = v_lead where id = v_conv;
    end if;
  end if;

  if v_lead is not null then
    if v_crm_user is null then v_crm_user := nullif(p ->> 'user_id', '')::uuid; end if;
    if v_crm_user is distinct from nullif(p ->> 'user_id', '')::uuid then
      raise exception 'CRM user must match the authenticated sender' using errcode = '42501';
    end if;
    select user_id into v_lead_owner from public.leads where id = v_lead for share;
    if not found or v_lead_owner is distinct from v_crm_user then
      raise exception 'CRM lead not found' using errcode = '42501';
    end if;
  elsif v_crm_user is not null then
    raise exception 'CRM lead and user must be supplied together' using errcode = '22023';
  end if;

  v_fingerprint := md5((jsonb_build_object(
    'account_id', p ->> 'account_id', 'user_id', p ->> 'user_id', 'conversation_id', nullif(p ->> 'conversation_id',''),
    'draft_id', nullif(p ->> 'draft_id',''), 'to_emails', coalesce(p -> 'to_emails','[]'::jsonb),
    'cc_emails', coalesce(p -> 'cc_emails','[]'::jsonb), 'bcc_emails', coalesce(p -> 'bcc_emails','[]'::jsonb),
    'reply_to', coalesce(p ->> 'reply_to',''), 'subject', coalesce(p ->> 'subject',''),
    'body_text', coalesce(p ->> 'body_text',''), 'body_html', coalesce(p ->> 'body_html',''),
    'in_reply_to', nullif(p ->> 'in_reply_to',''), 'references_ids', nullif(p ->> 'references_ids',''),
    'attachments', coalesce(p -> 'attachments','[]'::jsonb)
  ) || case when v_lead is not null then jsonb_build_object('crm_lead_id', v_lead, 'crm_user_id', v_crm_user) else '{}'::jsonb end)::text);

  if v_key is not null then
    select * into m from public.email_messages where organization_id = v_org and idempotency_key = v_key;
    if found then
      if m.account_id <> v_acc.id or m.request_fingerprint is null or m.request_fingerprint <> v_fingerprint then
        raise exception 'idempotency_key_conflict' using errcode = '22023';
      end if;
      return jsonb_build_object('duplicate', true, 'message_id', m.id, 'conversation_id', m.conversation_id,
        'status', m.status, 'provider_message_id', m.provider_message_id);
    end if;
  end if;

  if v_draft is not null then
    if v_draft_status <> 'draft' then raise exception 'Draft not found'; end if;
    update public.email_messages
       set status = 'queued', from_email = v_acc.address, from_name = v_acc.display_name,
           to_emails = coalesce(array(select jsonb_array_elements_text(p -> 'to_emails')), '{}'),
           cc_emails = coalesce(array(select jsonb_array_elements_text(p -> 'cc_emails')), '{}'),
           bcc_emails = coalesce(array(select jsonb_array_elements_text(p -> 'bcc_emails')), '{}'),
           reply_to = left(coalesce(p ->> 'reply_to', ''), 500), subject = left(coalesce(p ->> 'subject', ''), 998),
           body_text = left(coalesce(p ->> 'body_text', ''), 200000), body_html = left(coalesce(p ->> 'body_html', ''), 400000),
           in_reply_to = nullif(p ->> 'in_reply_to', ''), references_ids = nullif(p ->> 'references_ids', ''),
           idempotency_key = v_key, request_fingerprint = v_fingerprint, created_by = nullif(p ->> 'user_id', '')::uuid,
           crm_lead_id = v_lead
     where id = v_draft returning * into m;
  else
    if v_conv is null then
      insert into public.email_conversations (organization_id, account_id, subject, normalized_subject, lead_id)
      values (v_org, v_acc.id, left(coalesce(p ->> 'subject', ''), 998), coalesce(p ->> 'normalized_subject', ''), v_lead) returning id into v_conv;
    end if;
    insert into public.email_messages (organization_id, conversation_id, account_id, direction, status, from_email, from_name,
      to_emails, cc_emails, bcc_emails, reply_to, subject, body_text, body_html, in_reply_to, references_ids,
      is_read, idempotency_key, request_fingerprint, created_by, crm_lead_id)
    values (v_org, v_conv, v_acc.id, 'outbound', 'queued', v_acc.address, v_acc.display_name,
      coalesce(array(select jsonb_array_elements_text(p -> 'to_emails')), '{}'),
      coalesce(array(select jsonb_array_elements_text(p -> 'cc_emails')), '{}'),
      coalesce(array(select jsonb_array_elements_text(p -> 'bcc_emails')), '{}'), left(coalesce(p ->> 'reply_to', ''), 500),
      left(coalesce(p ->> 'subject', ''), 998), left(coalesce(p ->> 'body_text', ''), 200000),
      left(coalesce(p ->> 'body_html', ''), 400000), nullif(p ->> 'in_reply_to', ''), nullif(p ->> 'references_ids', ''),
      true, v_key, v_fingerprint, nullif(p ->> 'user_id', '')::uuid, v_lead)
    returning * into m;
  end if;

  foreach r in array array['to_emails', 'cc_emails'] loop
    for v_addr in select lower(btrim(x)) from jsonb_array_elements_text(coalesce(p -> r, '[]'::jsonb)) x loop
      insert into public.email_participants (organization_id, conversation_id, email)
      values (v_org, m.conversation_id, v_addr) on conflict (conversation_id, email) do nothing;
    end loop;
  end loop;
  insert into public.email_participants (organization_id, conversation_id, email, name)
  values (v_org, m.conversation_id, v_acc.address, v_acc.display_name) on conflict (conversation_id, email) do nothing;
  return jsonb_build_object('duplicate', false, 'message_id', m.id, 'conversation_id', m.conversation_id, 'status', m.status);
end $$;
revoke all on function public.email_create_outbound(jsonb) from public, anon, authenticated;
grant execute on function public.email_create_outbound(jsonb) to service_role;

commit;

-- Rollback: restore public.email_create_outbound(jsonb) from
-- 20261208100000_email_crm_activity.sql. Existing lead links written by this migration are
-- retained because they represent the CRM attribution already attached to those conversations.
