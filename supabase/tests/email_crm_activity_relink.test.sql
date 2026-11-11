-- Requires the email CRM activity, Phase 7 timeline reconciliation and confirmed-bugfix migrations.
begin;
do $$
declare
  v_user uuid; v_org uuid; v_acc uuid; v_lead_a uuid; v_lead_b uuid; v_conv uuid; v_conv_b uuid; v_msg uuid; v_delayed_relink_msg uuid; v_delayed_unlink_msg uuid; v_recovery jsonb;
begin
  select id into v_user from auth.users limit 1;
  select organization_id, id into v_org, v_acc from public.email_accounts limit 1;
  if v_user is null or v_acc is null then raise exception 'SKIP: needs one auth user and one email account fixture'; end if;
  insert into public.leads (user_id, company_name, activity_log) values (v_user, 'Activity Lead A', '[]'::jsonb) returning id into v_lead_a;
  insert into public.leads (user_id, company_name, activity_log) values (v_user, 'Activity Lead B', '[]'::jsonb) returning id into v_lead_b;
  insert into public.email_conversations (organization_id, account_id, subject, normalized_subject, lead_id)
    values (v_org, v_acc, 'Attribution test', 'attribution test', v_lead_a) returning id into v_conv;
  insert into public.email_conversations (organization_id, account_id, subject, normalized_subject, lead_id)
    values (v_org, v_acc, 'Rethread destination', 'rethread destination', v_lead_b) returning id into v_conv_b;
  insert into public.email_messages (organization_id, conversation_id, account_id, direction, status, from_email, to_emails, subject, created_by, provider, provider_message_id, sent_at)
    values (v_org, v_conv, v_acc, 'outbound', 'sent', 'studio@example.com', array['client@example.com'], 'Attribution test', v_user, 'resend', 'provider-activity-test', now()) returning id into v_msg;
  insert into public.email_crm_activities (message_id, organization_id, lead_id, account_id, user_id, provider, provider_message_id, from_email, to_emails, subject, body_text, body_html, sent_at)
    values (v_msg, v_org, v_lead_a, v_acc, v_user, 'resend', 'provider-activity-test', 'studio@example.com', array['client@example.com'], 'Attribution test', '', '', now());

  update public.email_conversations set lead_id = v_lead_b where id = v_conv;
  if (select lead_id from public.email_crm_activities where message_id = v_msg) is distinct from v_lead_b then
    raise exception 'FAIL: structured activity did not follow conversation relink';
  end if;
  raise notice 'PASS: structured activity follows conversation relink';

  update public.email_conversations set lead_id = null where id = v_conv;
  if (select lead_id from public.email_crm_activities where message_id = v_msg) is not null then
    raise exception 'FAIL: structured activity was not unlinked';
  end if;
  raise notice 'PASS: structured activity is retained but unlinked when conversation is unlinked';

  update public.email_messages set conversation_id = v_conv_b where id = v_msg;
  if (select lead_id from public.email_crm_activities where message_id = v_msg) is distinct from v_lead_b then
    raise exception 'FAIL: structured activity did not follow message rethread';
  end if;
  raise notice 'PASS: structured activity follows message rethread';

  -- A message relinked before CRM recording must recover against the destination lead,
  -- not the original lead stored on email_messages.crm_lead_id.
  insert into public.email_messages (
    organization_id, conversation_id, account_id, direction, status, from_email, to_emails,
    subject, created_by, provider, provider_message_id, sent_at, crm_lead_id
  ) values (
    v_org, v_conv, v_acc, 'outbound', 'sent', 'studio@example.com', array['client@example.com'],
    'Delayed relink recovery', v_user, 'resend', 'provider-delayed-relink', now(), v_lead_a
  ) returning id into v_delayed_relink_msg;
  update public.email_conversations set lead_id = v_lead_b where id = v_conv;
  v_recovery := public.email_recover_crm_activities(500);
  if (select lead_id from public.email_crm_activities where message_id = v_delayed_relink_msg) is distinct from v_lead_b then
    raise exception 'FAIL: delayed recovery did not use the conversation current lead after relink';
  end if;
  if exists (
    select 1 from public.leads l
     cross join lateral jsonb_array_elements(coalesce(l.activity_log, '[]'::jsonb)) e
    where l.id = v_lead_a and e.value ->> 'emailMessageId' = v_delayed_relink_msg::text
  ) then
    raise exception 'FAIL: delayed recovery recreated the timeline entry on the original lead';
  end if;
  raise notice 'PASS: delayed recovery uses the current lead after relink';

  -- An unlink before recovery must not recreate an activity on the stale original lead.
  insert into public.email_messages (
    organization_id, conversation_id, account_id, direction, status, from_email, to_emails,
    subject, created_by, provider, provider_message_id, sent_at, crm_lead_id
  ) values (
    v_org, v_conv, v_acc, 'outbound', 'sent', 'studio@example.com', array['client@example.com'],
    'Delayed unlink recovery', v_user, 'resend', 'provider-delayed-unlink', now(), v_lead_b
  ) returning id into v_delayed_unlink_msg;
  update public.email_conversations set lead_id = null where id = v_conv;
  v_recovery := public.email_recover_crm_activities(500);
  if exists (select 1 from public.email_crm_activities where message_id = v_delayed_unlink_msg) then
    raise exception 'FAIL: recovery recreated a CRM activity while the conversation was unlinked';
  end if;
  if (select crm_recovery_attempts from public.email_messages where id = v_delayed_unlink_msg) <> 0 then
    raise exception 'FAIL: unlinked message was consumed by the CRM recovery queue';
  end if;
  update public.email_conversations set lead_id = v_lead_a where id = v_conv;
  v_recovery := public.email_recover_crm_activities(500);
  if (select lead_id from public.email_crm_activities where message_id = v_delayed_unlink_msg) is distinct from v_lead_a then
    raise exception 'FAIL: delayed recovery did not record against the lead after a later relink';
  end if;
  raise notice 'PASS: unlinked messages wait for a current lead link before recovery';
end $$;
rollback;
