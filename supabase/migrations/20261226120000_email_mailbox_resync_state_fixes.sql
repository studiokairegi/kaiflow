-- Mailbox re-sync fixes (same signatures and grants as before; existing rows untouched).
--  1. email_ingest_inbound: a re-sync used to overwrite is_read with the provider's value, so a message already read in KairFlow
--     became unread again on the next poll while the provider still showed it unread. A message the provider reports as read is
--     still marked read; a local read is never undone by a sync.
--  2. email_ingest_inbound / email_ingest_synced_outbound: attachments with no provider_attachment_id never matched on re-sync
--     (NULL = NULL is not true), so every sync inserted another copy. NULL ids now match by filename.
begin;
create or replace function public.email_ingest_inbound(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid; v_acc uuid; v_conv uuid; v_pmid text; v_rfc text; v_provider text;
  a public.email_accounts; c public.email_conversations;
  v_msg uuid; v_existing uuid; part jsonb; att jsonb; v_addr text; v_new_conv boolean := false;
begin
  begin
    v_org := (p ->> 'organization_id')::uuid; v_acc := (p ->> 'account_id')::uuid; v_conv := nullif(p ->> 'conversation_id', '')::uuid;
  exception when others then
    raise exception 'Invalid inbound payload' using errcode = '22023';
  end;
  v_pmid := nullif(btrim(coalesce(p ->> 'provider_message_id', '')), '');
  v_rfc := nullif(btrim(coalesce(p ->> 'rfc_message_id', '')), '');
  v_provider := lower(coalesce(nullif(btrim(coalesce(p ->> 'provider', '')), ''), 'resend'));
  if v_org is null or v_acc is null or v_pmid is null then raise exception 'Invalid inbound payload' using errcode = '22023'; end if;

  -- ownership, checked here regardless of what the caller already checked
  select * into a from public.email_accounts where id = v_acc;
  if not found or a.organization_id <> v_org then raise exception 'Inbound account does not belong to this organization' using errcode = '42501'; end if;
  if a.status <> 'active' then raise exception 'Inbound account is not active' using errcode = '42501'; end if;
  if a.provider <> v_provider then
    raise exception 'Inbound account is not a % account', coalesce((select r.display_name from public.email_provider_registry r where r.provider_key = v_provider), v_provider) using errcode = '42501';
  end if;
  if v_conv is not null then
    select * into c from public.email_conversations where id = v_conv;
    if not found or c.organization_id <> v_org then raise exception 'Conversation does not belong to this organization' using errcode = '42501'; end if;
    if c.account_id <> v_acc then raise exception 'Conversation belongs to a different sender address' using errcode = '42501'; end if;
  end if;

  select id into v_existing from public.email_messages
   where account_id = v_acc and ((direction = 'inbound' and provider_message_id = v_pmid) or (v_rfc is not null and rfc_message_id = v_rfc))
   limit 1;
  if v_existing is not null then
    update public.email_messages set conversation_id=coalesce(v_conv,conversation_id),rfc_message_id=coalesce(v_rfc,rfc_message_id),
      in_reply_to=nullif(p ->> 'in_reply_to',''),references_ids=nullif(p ->> 'references_ids',''),
      from_email=lower(coalesce(p ->> 'from_email',from_email)),from_name=left(coalesce(p ->> 'from_name',from_name),200),
      to_emails=coalesce(array(select jsonb_array_elements_text(p -> 'to_emails')),to_emails),
      cc_emails=coalesce(array(select jsonb_array_elements_text(p -> 'cc_emails')),cc_emails),
      bcc_emails=coalesce(array(select jsonb_array_elements_text(p -> 'bcc_emails')),bcc_emails),
      reply_to=left(coalesce(p ->> 'reply_to',reply_to),500),subject=left(coalesce(p ->> 'subject',subject),998),
      body_text=left(coalesce(p ->> 'body_text',body_text),400000),body_html=left(coalesce(p ->> 'body_html',body_html),800000),
      headers=coalesce(p -> 'headers',headers),is_read=(is_read or coalesce((p ->> 'is_read')::boolean,false)),
      received_at=coalesce((p ->> 'received_at')::timestamptz,received_at)
    where id=v_existing and account_id=v_acc and organization_id=v_org;
    for att in select * from jsonb_array_elements(coalesce(p -> 'attachments','[]'::jsonb)) loop
      update public.email_attachments set filename=left(coalesce(att ->> 'filename',filename),300),content_type=coalesce(att ->> 'content_type',content_type),
        size_bytes=greatest(coalesce((att ->> 'size_bytes')::bigint,size_bytes),0),content_id=nullif(att ->> 'content_id',''),
        is_inline=coalesce((att ->> 'is_inline')::boolean,is_inline)
      where message_id=v_existing and (provider_attachment_id is not distinct from att ->> 'provider_attachment_id' and (att ->> 'provider_attachment_id' is not null or filename = left(coalesce(att ->> 'filename','attachment'),300)));
      if not exists(select 1 from public.email_attachments where message_id=v_existing and (provider_attachment_id is not distinct from att ->> 'provider_attachment_id' and (att ->> 'provider_attachment_id' is not null or filename = left(coalesce(att ->> 'filename','attachment'),300)))) then
        insert into public.email_attachments(organization_id,message_id,provider_attachment_id,filename,content_type,size_bytes,content_id,is_inline,storage_path)
        values(v_org,v_existing,att ->> 'provider_attachment_id',left(coalesce(att ->> 'filename','attachment'),300),coalesce(att ->> 'content_type','application/octet-stream'),
          greatest(coalesce((att ->> 'size_bytes')::bigint,0),0),nullif(att ->> 'content_id',''),coalesce((att ->> 'is_inline')::boolean,false),nullif(att ->> 'storage_path',''));
      end if;
    end loop;
    return jsonb_build_object('duplicate',true,'updated',true,'message_id',v_existing);
  end if;

  begin     -- sub-transaction: a lost race on the unique indexes rolls the new conversation back with it
    if v_conv is null then
      insert into public.email_conversations (organization_id, account_id, subject, normalized_subject)
      values (v_org, v_acc, left(coalesce(p ->> 'subject', ''), 998), coalesce(p ->> 'normalized_subject', '')) returning id into v_conv;
      v_new_conv := true;
    end if;
    insert into public.email_messages (organization_id, conversation_id, account_id, direction, provider_message_id, rfc_message_id, in_reply_to, references_ids,
           from_email, from_name, to_emails, cc_emails, bcc_emails, reply_to, subject, body_text, body_html, status, is_read, headers, auth_results, received_at)
    values (v_org, v_conv, v_acc, 'inbound', v_pmid, v_rfc, nullif(p ->> 'in_reply_to', ''), nullif(p ->> 'references_ids', ''),
            lower(coalesce(p ->> 'from_email', '')), left(coalesce(p ->> 'from_name', ''), 200),
            coalesce(array(select jsonb_array_elements_text(p -> 'to_emails')), '{}'), coalesce(array(select jsonb_array_elements_text(p -> 'cc_emails')), '{}'),
            coalesce(array(select jsonb_array_elements_text(p -> 'bcc_emails')), '{}'), left(coalesce(p ->> 'reply_to', ''), 500),
            left(coalesce(p ->> 'subject', ''), 998), left(coalesce(p ->> 'body_text', ''), 400000), left(coalesce(p ->> 'body_html', ''), 800000),
            'received', coalesce((p ->> 'is_read')::boolean,false), coalesce(p -> 'headers', '{}'::jsonb), p -> 'auth_results', coalesce((p ->> 'received_at')::timestamptz, now()))
    returning id into v_msg;
  exception when unique_violation then
    select id into v_existing from public.email_messages
     where account_id = v_acc and ((direction = 'inbound' and provider_message_id = v_pmid) or (v_rfc is not null and rfc_message_id = v_rfc)) limit 1;
    if v_existing is null then raise; end if;
    return jsonb_build_object('duplicate', true, 'message_id', v_existing);
  end;

  for part in select * from jsonb_array_elements(coalesce(p -> 'participants', '[]'::jsonb)) loop
    v_addr := lower(btrim(coalesce(part ->> 'email', '')));
    if v_addr <> '' then
      insert into public.email_participants (organization_id, conversation_id, email, name) values (v_org, v_conv, v_addr, left(coalesce(part ->> 'name', ''), 200))
      on conflict (conversation_id, email) do update set name = case when public.email_participants.name = '' then excluded.name else public.email_participants.name end;
    end if;
  end loop;

  for att in select * from jsonb_array_elements(coalesce(p -> 'attachments', '[]'::jsonb)) loop
    insert into public.email_attachments (organization_id, message_id, provider_attachment_id, filename, content_type, size_bytes, content_id, is_inline, storage_path)
    values (v_org, v_msg, att ->> 'provider_attachment_id', left(coalesce(att ->> 'filename', 'attachment'), 300), coalesce(att ->> 'content_type', 'application/octet-stream'),
            coalesce((att ->> 'size_bytes')::bigint, 0), nullif(att ->> 'content_id', ''), coalesce((att ->> 'is_inline')::boolean, false), nullif(att ->> 'storage_path', ''))
    on conflict do nothing;
  end loop;

  insert into public.email_events (organization_id, message_id, event_type, detail) values (v_org, v_msg, 'received', '{}'::jsonb);
  insert into public.email_sync_state (account_id, organization_id, last_webhook_at, last_received_at) values (v_acc, v_org, now(), now())
  on conflict (account_id) do update set last_webhook_at = now(), last_received_at = now(), last_error = '';
  return jsonb_build_object('duplicate', false, 'message_id', v_msg, 'conversation_id', v_conv);
end $$;

create or replace function public.email_ingest_synced_outbound(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid; v_acc uuid; v_pmid text; v_rfc text; v_provider text; v_conv uuid; v_msg uuid; v_existing uuid;
  a public.email_accounts; part jsonb; att jsonb; v_addr text; v_subject text;
begin
  begin
    v_org := (p ->> 'organization_id')::uuid;
    v_acc := (p ->> 'account_id')::uuid;
  exception when others then
    raise exception 'Invalid synchronized message payload' using errcode = '22023';
  end;
  v_pmid := nullif(btrim(coalesce(p ->> 'provider_message_id','')), '');
  v_rfc := nullif(btrim(coalesce(p ->> 'rfc_message_id','')), '');
  v_provider := lower(coalesce(nullif(btrim(coalesce(p ->> 'provider','')),''),'resend'));
  if v_org is null or v_acc is null or v_pmid is null then raise exception 'Invalid synchronized message payload' using errcode='22023'; end if;
  select * into a from public.email_accounts where id=v_acc;
  if not found or a.organization_id<>v_org or a.provider<>v_provider or a.status<>'active' then
    raise exception 'Synchronized message account is not authorized' using errcode='42501';
  end if;
  select id into v_existing from public.email_messages where account_id=v_acc and direction='outbound'
    and (provider_message_id=v_pmid or (v_rfc is not null and rfc_message_id=v_rfc)) limit 1;
  if v_existing is not null then
    update public.email_messages set rfc_message_id=coalesce(v_rfc,rfc_message_id),in_reply_to=nullif(p ->> 'in_reply_to',''),
      references_ids=nullif(p ->> 'references_ids',''),from_email=lower(coalesce(p ->> 'from_email',from_email)),
      from_name=left(coalesce(p ->> 'from_name',from_name),200),to_emails=coalesce(array(select jsonb_array_elements_text(p -> 'to_emails')),to_emails),
      cc_emails=coalesce(array(select jsonb_array_elements_text(p -> 'cc_emails')),cc_emails),bcc_emails=coalesce(array(select jsonb_array_elements_text(p -> 'bcc_emails')),bcc_emails),
      reply_to=left(coalesce(p ->> 'reply_to',reply_to),500),subject=left(coalesce(p ->> 'subject',subject),998),
      body_text=left(coalesce(p ->> 'body_text',body_text),400000),body_html=left(coalesce(p ->> 'body_html',body_html),800000),
      headers=coalesce(p -> 'headers',headers),sent_at=coalesce((p ->> 'sent_at')::timestamptz,sent_at)
    where id=v_existing and account_id=v_acc and organization_id=v_org;
    for att in select * from jsonb_array_elements(coalesce(p -> 'attachments','[]'::jsonb)) loop
      update public.email_attachments set filename=left(coalesce(att ->> 'filename',filename),300),content_type=coalesce(att ->> 'content_type',content_type),
        size_bytes=greatest(coalesce((att ->> 'size_bytes')::bigint,size_bytes),0),content_id=nullif(att ->> 'content_id',''),
        is_inline=coalesce((att ->> 'is_inline')::boolean,is_inline)
      where message_id=v_existing and (provider_attachment_id is not distinct from att ->> 'provider_attachment_id' and (att ->> 'provider_attachment_id' is not null or filename = left(coalesce(att ->> 'filename','attachment'),300)));
      if not exists(select 1 from public.email_attachments where message_id=v_existing and (provider_attachment_id is not distinct from att ->> 'provider_attachment_id' and (att ->> 'provider_attachment_id' is not null or filename = left(coalesce(att ->> 'filename','attachment'),300)))) then
        insert into public.email_attachments(organization_id,message_id,provider_attachment_id,filename,content_type,size_bytes,content_id,is_inline,storage_path)
        values(v_org,v_existing,att ->> 'provider_attachment_id',left(coalesce(att ->> 'filename','attachment'),300),coalesce(att ->> 'content_type','application/octet-stream'),
          greatest(coalesce((att ->> 'size_bytes')::bigint,0),0),nullif(att ->> 'content_id',''),coalesce((att ->> 'is_inline')::boolean,false),nullif(att ->> 'storage_path',''));
      end if;
    end loop;
    return jsonb_build_object('duplicate',true,'updated',true,'message_id',v_existing);
  end if;

  v_conv := nullif(p ->> 'conversation_id','')::uuid;
  if v_conv is not null and not exists(select 1 from public.email_conversations where id=v_conv and organization_id=v_org and account_id=v_acc) then
    raise exception 'Conversation belongs to a different account' using errcode='42501';
  end if;
  v_subject := left(coalesce(p ->> 'subject',''),998);
  if v_conv is null then
    insert into public.email_conversations(organization_id,account_id,subject,normalized_subject)
    values(v_org,v_acc,v_subject,coalesce(p ->> 'normalized_subject','')) returning id into v_conv;
  end if;
  begin
    insert into public.email_messages(organization_id,conversation_id,account_id,direction,provider_message_id,rfc_message_id,in_reply_to,references_ids,
      from_email,from_name,to_emails,cc_emails,bcc_emails,reply_to,subject,body_text,body_html,status,is_read,headers,sent_at)
    values(v_org,v_conv,v_acc,'outbound',v_pmid,v_rfc,nullif(p ->> 'in_reply_to',''),nullif(p ->> 'references_ids',''),
      lower(coalesce(p ->> 'from_email',a.address)),left(coalesce(p ->> 'from_name',a.display_name),200),
      coalesce(array(select jsonb_array_elements_text(p -> 'to_emails')),'{}'),
      coalesce(array(select jsonb_array_elements_text(p -> 'cc_emails')),'{}'),
      coalesce(array(select jsonb_array_elements_text(p -> 'bcc_emails')),'{}'),left(coalesce(p ->> 'reply_to',''),500),
      v_subject,left(coalesce(p ->> 'body_text',''),400000),left(coalesce(p ->> 'body_html',''),800000),'sent',coalesce((p ->> 'is_read')::boolean,true),
      coalesce(p -> 'headers','{}'::jsonb),coalesce((p ->> 'sent_at')::timestamptz,now())) returning id into v_msg;
  exception when unique_violation then
    select id into v_existing from public.email_messages where account_id=v_acc and direction='outbound'
      and (provider_message_id=v_pmid or (v_rfc is not null and rfc_message_id=v_rfc)) limit 1;
    if v_existing is null then raise; end if;
    return jsonb_build_object('duplicate',true,'message_id',v_existing);
  end;
  insert into public.email_participants(organization_id,conversation_id,email,name)
  values(v_org,v_conv,a.address,a.display_name) on conflict(conversation_id,email) do nothing;
  for part in select * from jsonb_array_elements(coalesce(p -> 'participants','[]'::jsonb)) loop
    v_addr := lower(btrim(coalesce(part ->> 'email','')));
    if v_addr<>'' then
      insert into public.email_participants(organization_id,conversation_id,email,name)
      values(v_org,v_conv,v_addr,left(coalesce(part ->> 'name',''),200))
      on conflict(conversation_id,email) do update set name=case when public.email_participants.name='' then excluded.name else public.email_participants.name end;
    end if;
  end loop;
  for att in select * from jsonb_array_elements(coalesce(p -> 'attachments','[]'::jsonb)) loop
    insert into public.email_attachments(organization_id,message_id,provider_attachment_id,filename,content_type,size_bytes,content_id,is_inline,storage_path)
    values(v_org,v_msg,att ->> 'provider_attachment_id',left(coalesce(att ->> 'filename','attachment'),300),coalesce(att ->> 'content_type','application/octet-stream'),
      greatest(coalesce((att ->> 'size_bytes')::bigint,0),0),nullif(att ->> 'content_id',''),coalesce((att ->> 'is_inline')::boolean,false),nullif(att ->> 'storage_path',''))
    on conflict do nothing;
  end loop;
  insert into public.email_events(organization_id,message_id,event_type,detail)
  values(v_org,v_msg,'mailbox_sync_imported',jsonb_build_object('provider',v_provider));
  return jsonb_build_object('duplicate',false,'message_id',v_msg,'conversation_id',v_conv);
end $$;

revoke all on function public.email_ingest_inbound(jsonb) from public, anon, authenticated;
grant execute on function public.email_ingest_inbound(jsonb) to service_role;
revoke all on function public.email_ingest_synced_outbound(jsonb) from public, anon, authenticated;
grant execute on function public.email_ingest_synced_outbound(jsonb) to service_role;

commit;
