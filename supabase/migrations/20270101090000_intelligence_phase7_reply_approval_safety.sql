-- Phase 7 corrective safety patch: manual replies require explicit approval and
-- cannot be composed for closed/suppressed prospects or suppressed recipients.
-- Forward-only: do not edit historical migrations.
begin;

create or replace function public.intel_admin_compose_reply(p_prospect_id uuid, p_subject text, p_body text) returns uuid
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.intel_admin_org();
  p public.intel_prospects;
  s public.intel_settings;
  v_in public.intel_messages;
  v_id uuid;
  v_to text;
begin
  select * into p
    from public.intel_prospects
   where id = p_prospect_id and organization_id = v_org
   for update;
  if not found then raise exception 'prospect not found'; end if;

  if p.status in ('closed', 'suppressed') then
    raise exception 'cannot compose a reply for a closed or suppressed prospect' using errcode = 'P0001';
  end if;

  select * into s from public.intel_settings where organization_id = v_org;
  select * into v_in
    from public.intel_messages
   where prospect_id = p.id and organization_id = v_org and direction = 'inbound'
   order by received_at desc nulls last, created_at desc
   limit 1;
  if not found then raise exception 'no inbound message exists for this prospect' using errcode = 'P0001'; end if;

  v_to := public.intel_norm_email(coalesce(nullif(v_in.from_email, ''), p.contact_email));
  if v_to = '' or position('@' in v_to) < 2 then
    raise exception 'recipient email is missing or invalid' using errcode = 'P0001';
  end if;

  if exists (
    select 1
      from public.intel_suppressions x
     where x.organization_id = v_org
       and ((x.kind = 'email' and x.value = v_to)
         or (x.kind = 'domain' and split_part(v_to, '@', 2) = x.value))
  ) then
    raise exception 'recipient is suppressed; reply was not created' using errcode = 'P0001';
  end if;

  insert into public.intel_messages(
    organization_id, prospect_id, lead_id, campaign_type, direction, kind,
    state, auto_sent, to_email, from_email, subject, body_text,
    idempotency_key, in_reply_to, references_ids
  ) values (
    v_org, p.id, p.lead_id, p.type, 'outbound', 'reply',
    'pending_approval', false, v_to, s.sender_email, left(coalesce(p_subject, ''), 300),
    left(coalesce(p_body, ''), 20000), 'admin-reply:' || gen_random_uuid()::text,
    v_in.rfc_message_id, v_in.references_ids
  ) returning id into v_id;

  perform public._intel_log(v_org, 'admin', 'compose_reply_pending_approval', 'message', v_id::text,
    jsonb_build_object('prospect_id', p.id, 'approval_required', true));
  return v_id;
end $$;

revoke all on function public.intel_admin_compose_reply(uuid, text, text) from public, anon;
grant execute on function public.intel_admin_compose_reply(uuid, text, text) to authenticated;

commit;
