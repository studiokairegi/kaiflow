-- KairFlow Email (Resend), migration 20261110090000, against real Postgres. Run by run_intelligence_auth.sh AFTER the Intelligence
-- tests; it reuses their fixture: ADMIN ...e1 (admin + Master of orgA), MASTER ...e2 (Master only), AGENT ...f0 (registered agent).
-- NOT EXECUTED where this file was written (no PostgreSQL available there): run it before trusting the migration.
do $$
declare
  ADMIN uuid := '00000000-0000-0000-0000-0000000000e1'; MASTER uuid := '00000000-0000-0000-0000-0000000000e2'; AGENT uuid := '00000000-0000-0000-0000-0000000000f0';
  orgA uuid := '20000000-0000-0000-0000-00000000000a';
  acc jsonb; v_acc uuid; r jsonb; v_conv uuid; v_msg uuid; v_out uuid; v_lead uuid; d jsonb; n int;
begin
  -- 1. provider flags ------------------------------------------------------------------------------------------------------------
  perform ti.ok(public.email_provider_enabled('resend') and not public.email_provider_enabled('gmail') and not public.email_provider_enabled('zoho'), 'Resend is on; Gmail and Zoho are off by default');
  perform ti.ok(not public.email_provider_enabled('nonsense'), 'an unknown provider counts as off');
  perform ti.ok(not exists (select 1 from intel_mail_account where false), 'Gmail/Zoho tables are untouched (still queryable)');

  -- 2. access: only admin + Master User ------------------------------------------------------------------------------------------
  perform ti.as_user(MASTER);
  perform ti.throws($q$select public.email_list_conversations('inbox')$q$, 'restricted', 'a Master User who is not admin cannot read email');
  perform ti.throws($q$select public.email_list_accounts()$q$, 'restricted', 'a Master User who is not admin cannot list accounts');
  perform ti.as_user(AGENT);
  perform ti.throws($q$select public.email_list_conversations('inbox')$q$, 'restricted', 'the agent identity cannot use the browser email functions');
  perform ti.ok((select count(*) from public.email_messages) = 0, 'row-level security hides every message from the agent identity');
  perform ti.as_user(ADMIN);
  perform ti.throws($q$select count(*) from public.email_webhook_events$q$, 'permission denied', 'the webhook log is service-role only');
  perform ti.throws($q$select public.email_ingest_inbound('{}'::jsonb)$q$, 'permission denied', 'ingest is service-role only');
  perform ti.throws($q$update public.email_provider_flags set enabled = true$q$, 'permission denied', 'no client can flip a provider flag');
  perform ti.ok(public.email_provider_flags_get() = jsonb_build_object('resend', true), 'the allowed admin reads the general Email provider list (registry: Resend only; Gmail/Zoho flags stay Intelligence-only)');

  -- 3. account ---------------------------------------------------------------------------------------------------------------------
  acc := public.email_upsert_account('John@StudioKairegi.com', 'Studio Kairegi');
  v_acc := (acc ->> 'id')::uuid;
  perform ti.ok(acc ->> 'address' = 'john@studiokairegi.com' and (acc ->> 'is_default')::boolean, 'address is lower-cased and the first account becomes the default');
  perform ti.throws($q$select public.email_upsert_account('not an address', '')$q$, 'valid email', 'invalid address refused');

  -- 4. inbound ingest: stored once, counters follow, duplicates are safe ---------------------------------------------------------
  perform ti.as_super();
  r := public.email_ingest_inbound(jsonb_build_object('organization_id', orgA, 'account_id', v_acc, 'normalized_subject', 'quote', 'provider_message_id', 'rx_1',
         'rfc_message_id', '<abc@client.com>', 'from_email', 'Ada@Client.com', 'from_name', 'Ada', 'to_emails', jsonb_build_array('john@studiokairegi.com'),
         'subject', 'Quote', 'body_text', 'Hello there', 'body_html', '<p>Hello there</p>', 'received_at', now(),
         'participants', jsonb_build_array(jsonb_build_object('email', 'ada@client.com', 'name', 'Ada'), jsonb_build_object('email', 'john@studiokairegi.com')),
         'attachments', jsonb_build_array(jsonb_build_object('provider_attachment_id', 'att1', 'filename', 'brief.pdf', 'content_type', 'application/pdf', 'size_bytes', 4, 'storage_path', orgA::text || '/rx_1/att1-brief.pdf'))));
  v_conv := (r ->> 'conversation_id')::uuid; v_msg := (r ->> 'message_id')::uuid;
  perform ti.ok(not (r ->> 'duplicate')::boolean and v_conv is not null, 'inbound message creates a conversation');
  r := public.email_ingest_inbound(jsonb_build_object('organization_id', orgA, 'account_id', v_acc, 'provider_message_id', 'rx_1', 'rfc_message_id', '<abc@client.com>', 'subject', 'Quote', 'from_email', 'ada@client.com'));
  perform ti.ok((r ->> 'duplicate')::boolean and (r ->> 'message_id')::uuid = v_msg, 'the same Resend email id is a duplicate, not a second message');
  r := public.email_ingest_inbound(jsonb_build_object('organization_id', orgA, 'account_id', v_acc, 'provider_message_id', 'rx_1b', 'rfc_message_id', '<abc@client.com>', 'subject', 'Quote', 'from_email', 'ada@client.com'));
  perform ti.ok((r ->> 'duplicate')::boolean, 'the same Message-ID delivered under another Resend id is also a duplicate');
  perform ti.ok((select count(*) from public.email_messages where conversation_id = v_conv) = 1 and (select count(*) from public.email_attachments where message_id = v_msg) = 1, 'one message and one attachment row');
  perform ti.ok((select message_count = 1 and unread_count = 1 and last_direction = 'inbound' and snippet = 'Hello there' from public.email_conversations where id = v_conv), 'conversation counters, snippet and direction follow the message');
  perform ti.ok((select count(*) = 2 from public.email_participants where conversation_id = v_conv), 'participants are recorded once each');
  perform ti.ok((select count(*) = 1 from public.email_events where message_id = v_msg and event_type = 'received'), 'a received event is logged');

  -- 5. reading, read state, archive, search, folders ---------------------------------------------------------------------------
  perform ti.as_user(ADMIN);
  perform ti.ok(jsonb_array_length(public.email_list_conversations('inbox')) = 1 and jsonb_array_length(public.email_list_conversations('unread')) = 1, 'the conversation shows in Inbox and Unread');
  perform ti.ok(jsonb_array_length(public.email_list_conversations('inbox', 'ADA')) = 1 and jsonb_array_length(public.email_list_conversations('inbox', 'hello there')) = 1, 'search finds it by person and by body, case-insensitively');
  perform ti.ok(jsonb_array_length(public.email_list_conversations('inbox', '100%_')) = 0, 'search wildcards are escaped, not interpreted');
  perform ti.ok(jsonb_array_length(public.email_list_conversations('inbox', 'nothing like this')) = 0, 'search with no match returns nothing');
  perform ti.throws($q$select public.email_list_conversations('bogus')$q$, 'Unknown folder', 'unknown folder refused');
  d := public.email_get_conversation(v_conv);
  perform ti.ok(jsonb_array_length(d -> 'messages') = 1 and (d -> 'messages' -> 0 ? 'headers') is false and jsonb_array_length(d -> 'messages' -> 0 -> 'attachments') = 1, 'thread comes with attachments and without raw headers');
  perform ti.ok((public.email_mark_read(v_conv, true) ->> 'unread_count')::int = 0 and public.email_unread_total() = 0, 'mark read clears the unread count');
  perform ti.ok((public.email_mark_read(v_conv, false) ->> 'unread_count')::int = 1, 'mark unread flags the newest incoming message');
  perform public.email_set_archived(v_conv, true);
  perform ti.ok(jsonb_array_length(public.email_list_conversations('inbox')) = 0 and jsonb_array_length(public.email_list_conversations('archived')) = 1, 'archived conversations leave the Inbox');
  perform ti.as_super();
  perform public.email_ingest_inbound(jsonb_build_object('organization_id', orgA, 'account_id', v_acc, 'conversation_id', v_conv, 'provider_message_id', 'rx_2', 'rfc_message_id', '<def@client.com>',
           'in_reply_to', '<sent@studiokairegi.com>', 'from_email', 'ada@client.com', 'subject', 'Re: Quote', 'body_text', 'Following up', 'received_at', now() + interval '1 second'));
  perform ti.as_user(ADMIN);
  perform ti.ok((select status = 'open' and message_count = 2 and snippet = 'Following up' from public.email_conversations where id = v_conv), 'a new incoming reply re-opens an archived conversation and updates the snippet');

  -- 6. outbound: idempotent creation, delivery events only move forward -------------------------------------------------------
  perform ti.as_super();
  r := public.email_create_outbound(jsonb_build_object('organization_id', orgA, 'account_id', v_acc, 'conversation_id', v_conv, 'idempotency_key', 'key-1', 'user_id', ADMIN,
         'to_emails', jsonb_build_array('ada@client.com'), 'subject', 'Re: Quote', 'body_text', 'Thanks', 'in_reply_to', '<def@client.com>'));
  v_out := (r ->> 'message_id')::uuid;
  perform ti.ok(not (r ->> 'duplicate')::boolean and r ->> 'status' = 'queued', 'outbound message is recorded as queued before anything is sent');
  r := public.email_create_outbound(jsonb_build_object('organization_id', orgA, 'account_id', v_acc, 'conversation_id', v_conv, 'idempotency_key', 'key-1', 'to_emails', jsonb_build_array('ada@client.com'), 'subject', 'x', 'body_text', 'x'));
  perform ti.ok((r ->> 'duplicate')::boolean and (r ->> 'message_id')::uuid = v_out, 'the same idempotency key never creates a second message');
  update public.email_messages set status = 'sent', provider_message_id = 're_out_1', sent_at = now() + interval '5 minutes', rfc_message_id = '<outbound@studio.test>' where id = v_out;
  perform ti.ok((select message_count = 3 and last_direction = 'outbound' from public.email_conversations where id = v_conv), 'sending bumps the conversation');
  perform ti.ok((select last_message_at = now() + interval '5 minutes' from public.email_conversations where id = v_conv), 'provider-confirmed sent_at advances shared Inbox conversation ordering');
  perform ti.ok(public.email_get_thread_parent(orgA, v_conv, v_acc) ->> 'rfc_message_id' = '<outbound@studio.test>', 'thread-parent RPC selects the newest RFC message across inbound and outbound timestamps');
  perform ti.ok((public.email_apply_delivery_event('re_out_1', 'delivered', 'email.delivered', 'ev1', now(), '{}') ->> 'found')::boolean, 'a delivery event finds the message by its Resend id');
  perform public.email_apply_delivery_event('re_out_1', 'sent', 'email.sent', 'ev2', now(), '{}');
  perform ti.ok((select status = 'delivered' from public.email_messages where id = v_out), 'a late "sent" event never moves delivered back to sent');
  perform public.email_apply_delivery_event('re_out_1', 'delivered', 'email.delivered', 'ev1', now(), '{}');
  perform ti.ok((select count(*) = 2 from public.email_events where message_id = v_out), 'the same event id is logged once');
  perform public.email_apply_delivery_event('re_out_1', 'bounced', 'email.bounced', 'ev3', now(), '{"reason":"Mailbox full"}');
  perform ti.ok((select status = 'bounced' and error = 'Mailbox full' from public.email_messages where id = v_out), 'a bounce always wins and keeps its reason');
  perform ti.ok(not (public.email_apply_delivery_event('re_unknown', 'delivered', 'email.delivered', 'ev9', now(), '{}') ->> 'found')::boolean, 'an unknown Resend id is reported as not found');

  -- 7. drafts and AI drafts ---------------------------------------------------------------------------------------------------
  perform ti.as_user(ADMIN);
  d := public.email_save_draft(null, null, v_acc, array['new@client.com'], '{}', '{}', 'Hello', 'Draft body', '');
  perform ti.ok(jsonb_array_length(public.email_list_conversations('drafts')) >= 1 and (select message_count = 0 from public.email_conversations where id = (d ->> 'conversation_id')::uuid), 'a draft is listed under Drafts and does not count as a message');
  d := public.email_save_draft((d ->> 'draft_id')::uuid, null, v_acc, array['new@client.com'], '{}', '{}', 'Hello again', 'Edited', '');
  perform ti.ok((select subject = 'Hello again' from public.email_messages where id = (d ->> 'draft_id')::uuid), 'saving again edits the same draft');
  perform public.email_delete_draft((d ->> 'draft_id')::uuid);
  perform ti.ok(not exists (select 1 from public.email_conversations where id = (d ->> 'conversation_id')::uuid), 'deleting the only draft removes its empty conversation');
  perform ti.as_user(AGENT);
  perform ti.ok(jsonb_array_length(public.intel_agent_email_recent_inbound(10)) >= 1, 'the agent can read recent incoming mail');
  d := public.intel_agent_email_thread(v_conv);
  perform ti.ok(jsonb_array_length(d -> 'messages') = 3 and not (d::text like '%bcc%'), 'the agent thread has messages and never bcc or raw headers');
  d := public.intel_agent_email_save_draft(v_conv, 'Re: Quote', 'Suggested reply');
  perform ti.as_super();
  perform ti.ok((select status = 'draft' and ai_generated from public.email_messages where id = (d ->> 'draft_id')::uuid), 'an agent reply is only ever a draft flagged as AI-generated');
  perform ti.ok((select count(*) = 0 from public.email_messages where ai_generated and status <> 'draft'), 'nothing AI-generated is sent');
  perform ti.as_user(MASTER);
  perform ti.throws(format($q$select public.intel_agent_email_thread(%L)$q$, v_conv), '', 'a non-agent cannot call the agent email functions');

  -- 8. CRM lead link ---------------------------------------------------------------------------------------------------------------
  perform ti.as_super();
  insert into leads(user_id, company_name) values (ADMIN, 'Email Lead') returning id into v_lead;
  perform ti.as_user(ADMIN);
  perform ti.ok((public.email_link_lead(v_conv, v_lead) ->> 'lead_id')::uuid = v_lead, 'a conversation can be linked to the admin''s own lead');
  perform ti.throws(format($q$select public.email_link_lead(%L, '99999999-9999-9999-9999-999999999999')$q$, v_conv), 'Lead not found', 'an unknown lead is refused');
  perform ti.ok(jsonb_array_length(public.email_list_conversations('all')) >= 1 and (public.email_list_conversations('all') -> 0 ->> 'lead_id') is not null, 'the list shows the lead link');
  perform ti.ok(public.email_link_lead(v_conv, null) is not null, 'the link can be cleared');
  perform ti.as_super();
  delete from leads where id = v_lead;
  perform ti.ok((select lead_id is null from public.email_conversations where id = v_conv), 'deleting a lead only unlinks the conversation');
  raise notice 'PASS email_resend.test.sql complete';
end $$;
