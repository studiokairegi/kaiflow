-- Resolve delayed CRM activity attribution from the conversation's current lead link.
-- This closes the gap where a sent message is relinked/unlinked before its activity row exists.
begin;

create or replace function public.email_record_crm_activity(p_message_id uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  m public.email_messages;
  a public.email_accounts;
  v_lead uuid;
  v_lead_owner uuid;
  v_activity_id uuid;
  v_entry jsonb;
  v_recipient text;
begin
  select * into m from public.email_messages where id = p_message_id for update;
  if not found then raise exception 'Email message not found'; end if;
  if m.direction <> 'outbound' or m.crm_lead_id is null then
    return jsonb_build_object('recorded', false, 'duplicate', false, 'reason', 'no_crm_lead');
  end if;
  if m.status not in ('sent','delivered','delivery_delayed','bounced','complained') then
    raise exception 'CRM activity cannot be recorded before provider acceptance';
  end if;
  if nullif(m.provider_message_id, '') is null then
    raise exception 'Provider message id is required for CRM activity recording';
  end if;

  select c.lead_id into v_lead
    from public.email_conversations c
   where c.id = m.conversation_id
     and c.organization_id = m.organization_id
   for share;

  -- An unlink is authoritative. Do not recreate an activity against the message's stale
  -- original crm_lead_id; a later relink will make the message eligible for recovery again.
  if v_lead is null then
    return jsonb_build_object('recorded', false, 'duplicate', false, 'reason', 'conversation_unlinked');
  end if;

  select * into a from public.email_accounts
   where id = m.account_id and organization_id = m.organization_id;
  if not found then raise exception 'Sender account ownership mismatch'; end if;

  select user_id into v_lead_owner from public.leads where id = v_lead for update;
  if not found or v_lead_owner is distinct from m.created_by or m.created_by is null then
    raise exception 'CRM lead ownership mismatch';
  end if;

  insert into public.email_crm_activities (
    message_id, organization_id, lead_id, account_id, user_id, provider, provider_message_id,
    from_email, from_name, to_emails, cc_emails, bcc_emails, reply_to, subject, body_text, body_html, sent_at
  ) values (
    m.id, m.organization_id, v_lead, m.account_id, m.created_by, m.provider, m.provider_message_id,
    m.from_email, m.from_name, m.to_emails, m.cc_emails, m.bcc_emails, m.reply_to, m.subject, m.body_text, m.body_html,
    coalesce(m.sent_at, m.created_at, now())
  ) on conflict (message_id) do nothing returning id into v_activity_id;

  if v_activity_id is null then
    -- Keep retries safe and repair attribution if an earlier activity row predates this correction.
    update public.email_crm_activities set lead_id = v_lead where message_id = m.id;
    select id into v_activity_id from public.email_crm_activities where message_id = m.id;
    return jsonb_build_object('recorded', true, 'duplicate', true, 'activity_id', v_activity_id, 'lead_id', v_lead);
  end if;

  v_recipient := coalesce(nullif(m.to_emails[1], ''), 'recipient');
  v_entry := jsonb_build_object(
    'ts', coalesce(m.sent_at, m.created_at, now()),
    'type', 'email_sent',
    'note', left('Email sent to ' || v_recipient || ' — ' || coalesce(nullif(m.subject, ''), '(no subject)'), 500),
    'emailMessageId', m.id,
    'emailActivityId', v_activity_id,
    'provider', m.provider,
    'providerMessageId', m.provider_message_id
  );
  update public.leads
     set activity_log = coalesce(activity_log, '[]'::jsonb) || jsonb_build_array(v_entry)
   where id = v_lead and user_id = m.created_by
     and not exists (
       select 1 from jsonb_array_elements(coalesce(activity_log, '[]'::jsonb)) e
        where e ->> 'emailMessageId' = m.id::text
     );
  if not found and not exists (select 1 from public.leads where id = v_lead and user_id = m.created_by) then
    raise exception 'CRM lead disappeared during activity recording';
  end if;
  return jsonb_build_object('recorded', true, 'duplicate', false, 'activity_id', v_activity_id, 'lead_id', v_lead);
end $$;
revoke all on function public.email_record_crm_activity(uuid) from public, anon, authenticated;
grant execute on function public.email_record_crm_activity(uuid) to service_role;

create or replace function public.email_recover_crm_activities(p_limit integer default 100) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v record; v_result jsonb; v_attempted integer:=0; v_recorded integer:=0; v_skipped integer:=0; v_failed integer:=0;
begin
  for v in
    select m.id
      from public.email_messages m
      join public.email_conversations c
        on c.id = m.conversation_id and c.organization_id = m.organization_id
     where m.direction='outbound'
       and m.crm_lead_id is not null
       and c.lead_id is not null
       and m.status in ('sent','delivered','delivery_delayed','bounced','complained')
       and m.crm_recovery_attempts < 10
       and not exists (select 1 from public.email_crm_activities a where a.message_id=m.id)
     order by m.crm_recovery_last_attempt_at nulls first, coalesce(m.sent_at,m.created_at)
     limit greatest(1,least(coalesce(p_limit,100),500))
     for update of m skip locked
  loop
    v_attempted:=v_attempted+1;
    update public.email_messages
       set crm_recovery_attempts=crm_recovery_attempts+1,
           crm_recovery_last_attempt_at=now()
     where id=v.id;
    begin
      v_result := public.email_record_crm_activity(v.id);
      if coalesce((v_result ->> 'recorded')::boolean, false) then
        v_recorded:=v_recorded+1;
      else
        v_skipped:=v_skipped+1;
      end if;
    exception when others then
      v_failed:=v_failed+1;
      raise warning 'CRM activity recovery failed for message %: %',v.id,sqlerrm;
    end;
  end loop;
  return jsonb_build_object('attempted',v_attempted,'recorded',v_recorded,'skipped',v_skipped,'failed',v_failed);
end $$;
revoke all on function public.email_recover_crm_activities(integer) from public, anon, authenticated;
grant execute on function public.email_recover_crm_activities(integer) to service_role;

commit;

-- Rollback: restore email_record_crm_activity(uuid) and email_recover_crm_activities(integer)
-- from 20261222100000_email_composer_send_crm_fixes.sql. No message or CRM data is deleted.
