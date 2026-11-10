-- Phase 4F PostgreSQL integration checks. Run after the 4C-4F migrations and email fixtures.
do $$
declare
  v_org uuid := '20000000-0000-0000-0000-00000000000a';
  v_admin uuid := '00000000-0000-0000-0000-0000000000e1';
  v_acc uuid;
  v_conv uuid;
  v_msg uuid;
  v_inbound uuid;
  v_recovery_lead uuid;
  v_recovery_msg uuid;
  v_monotonic_msg uuid;
  v_result jsonb;
  v_sent timestamptz := now() + interval '10 minutes';
begin
  perform ti.as_super();
  insert into public.email_accounts (organization_id, address, display_name, is_default)
  values (v_org, 'phase4f-validation@studiokairegi.com', 'Phase 4F validation', false)
  returning id into v_acc;

  v_result := public.email_create_outbound(jsonb_build_object(
    'organization_id', v_org, 'account_id', v_acc, 'user_id', v_admin,
    'idempotency_key', 'phase4f-outbound-001',
    'to_emails', jsonb_build_array('client@example.test'),
    'subject', 'Phase 4F Inbox ordering',
    'body_text', 'Outbound    message   snippet'
  ));
  v_msg := (v_result ->> 'message_id')::uuid;
  v_conv := (v_result ->> 'conversation_id')::uuid;

  update public.email_messages
     set status = 'sent', provider_message_id = 'phase4f-provider-001', sent_at = v_sent
   where id = v_msg;

  perform ti.ok(
    (select c.message_count = 1 and c.last_direction = 'outbound'
       and c.last_message_at = v_sent and c.snippet = 'Outbound message snippet'
     from public.email_conversations c where c.id = v_conv),
    'outbound acceptance recalculates count, sent timestamp, direction and normalized snippet'
  );

  insert into public.email_messages (
    organization_id, conversation_id, account_id, direction, provider, provider_message_id,
    rfc_message_id, from_email, to_emails, subject, body_text, status, is_read, received_at
  ) values (
    v_org, v_conv, v_acc, 'inbound', 'resend', 'phase4f-inbound-001',
    '<phase4f-inbound@example.test>', 'client@example.test', array['phase4f-validation@studiokairegi.com'],
    'Re: Phase 4F Inbox ordering', 'Inbound    reply   snippet', 'received', false, v_sent + interval '5 minutes'
  ) returning id into v_inbound;

  perform ti.ok(
    (select c.message_count = 2 and c.unread_count = 1 and c.last_direction = 'inbound'
       and c.last_message_at = v_sent + interval '5 minutes' and c.snippet = 'Inbound reply snippet'
     from public.email_conversations c where c.id = v_conv),
    'inbound receipt increments unread and becomes the latest chronological Inbox message'
  );

  update public.email_messages set is_read = true where id = v_inbound;
  perform ti.ok(
    (select c.unread_count = 0 from public.email_conversations c where c.id = v_conv),
    'read-state changes recalculate the conversation unread counter'
  );

  -- A later persisted sent_at can reorder the conversation even if the row was originally queued.
  update public.email_messages set sent_at = v_sent + interval '10 minutes' where id = v_msg;
  perform ti.ok(
    (select c.last_direction = 'outbound' and c.last_message_at = v_sent + interval '10 minutes'
       and c.message_count = 2 and c.unread_count = 0
     from public.email_conversations c where c.id = v_conv),
    'a delayed provider timestamp reorders latest-message metadata without double-counting'
  );

  -- A signed Resend event can recover a provider-accepted send whose synchronous
  -- post-send database write failed. The correlation tag resolves only to a persisted
  -- message and the database verifies sender, recipients and subject before binding.
  insert into public.leads (user_id, company_name, activity_log)
  values (v_admin, 'Phase 4F accepted-send recovery', '[]'::jsonb)
  returning id into v_recovery_lead;

  v_result := public.email_create_outbound(jsonb_build_object(
    'organization_id', v_org, 'account_id', v_acc, 'user_id', v_admin,
    'crm_lead_id', v_recovery_lead, 'crm_user_id', v_admin,
    'idempotency_key', 'phase4f-accepted-recovery-001',
    'to_emails', jsonb_build_array('recovery-client@example.test'),
    'subject', 'Phase 4F accepted recovery', 'body_text', 'Accepted before database recovery'
  ));
  v_recovery_msg := (v_result ->> 'message_id')::uuid;
  update public.email_messages set status = 'sending' where id = v_recovery_msg;

  v_result := public.email_reconcile_tagged_delivery_event(
    v_recovery_msg, 'resend-phase4f-accepted-001', 'email.sent', 'svix-phase4f-accepted-001',
    v_sent + interval '20 minutes', jsonb_build_object('reason','', 'type',''),
    'phase4f-validation@studiokairegi.com', array['recovery-client@example.test'], 'Phase 4F accepted recovery'
  );
  perform ti.ok((v_result ->> 'found')::boolean
    and (select status = 'sent' and provider_message_id = 'resend-phase4f-accepted-001' from public.email_messages where id = v_recovery_msg),
    'signed provider evidence binds the accepted provider id and advances the persisted sending row');
  perform ti.ok((select count(*) = 1 from public.email_crm_activities where message_id = v_recovery_msg)
    and (select count(*) = 1 from jsonb_array_elements((select activity_log from public.leads where id = v_recovery_lead)) e(value)
      where e.value ->> 'emailMessageId' = v_recovery_msg::text),
    'tagged acceptance recovery records exactly one CRM activity without resubmitting');

  v_result := public.email_reconcile_tagged_delivery_event(
    v_recovery_msg, 'resend-phase4f-accepted-001', 'email.sent', 'svix-phase4f-accepted-001',
    v_sent + interval '20 minutes', jsonb_build_object('reason','', 'type',''),
    'phase4f-validation@studiokairegi.com', array['recovery-client@example.test'], 'Phase 4F accepted recovery'
  );
  perform ti.ok((v_result ->> 'found')::boolean
    and (select count(*) = 1 from public.email_crm_activities where message_id = v_recovery_msg),
    'replaying the same tagged provider event remains idempotent');

  -- The tag is only a hint: mismatched provider evidence must not attach a provider id.
  v_result := public.email_create_outbound(jsonb_build_object(
    'organization_id', v_org, 'account_id', v_acc, 'user_id', v_admin,
    'idempotency_key', 'phase4f-accepted-recovery-mismatch',
    'to_emails', jsonb_build_array('other-client@example.test'),
    'subject', 'Different subject', 'body_text', 'Must not bind'
  ));
  v_monotonic_msg := (v_result ->> 'message_id')::uuid;
  update public.email_messages set status = 'sending' where id = v_monotonic_msg;
  v_result := public.email_reconcile_tagged_delivery_event(
    v_monotonic_msg, 'resend-phase4f-mismatch-001', 'email.sent', 'svix-phase4f-mismatch-001',
    v_sent, jsonb_build_object('reason','', 'type',''),
    'wrong-sender@example.test', array['other-client@example.test'], 'Different subject'
  );
  perform ti.ok(not (v_result ->> 'found')::boolean and (v_result ->> 'conflict')::boolean
    and (select provider_message_id is null and status = 'sending' from public.email_messages where id = v_monotonic_msg),
    'a mismatched sender cannot use the correlation tag to claim another provider message');

  -- A late synchronous HTTP response cannot downgrade a delivery webhook that already
  -- moved the message beyond sent.
  v_result := public.email_create_outbound(jsonb_build_object(
    'organization_id', v_org, 'account_id', v_acc, 'user_id', v_admin,
    'idempotency_key', 'phase4f-monotonic-accepted-001',
    'to_emails', jsonb_build_array('monotonic@example.test'),
    'subject', 'Monotonic status', 'body_text', 'Status must not go backwards'
  ));
  v_monotonic_msg := (v_result ->> 'message_id')::uuid;
  update public.email_messages set status = 'delivered', provider_message_id = 'resend-phase4f-monotonic-001', sent_at = v_sent where id = v_monotonic_msg;
  perform public.email_mark_provider_accepted(v_monotonic_msg, 'resend-phase4f-monotonic-001', v_sent + interval '1 minute');
  perform ti.ok((select status = 'delivered' from public.email_messages where id = v_monotonic_msg),
    'late synchronous acceptance persistence cannot downgrade delivered status to sent');

  delete from public.email_crm_activities where message_id = v_recovery_msg;
  delete from public.email_accounts where id = v_acc;
  delete from public.leads where id = v_recovery_lead;
  raise notice 'PASS email_phase4f_validation.test.sql complete';
end $$;
