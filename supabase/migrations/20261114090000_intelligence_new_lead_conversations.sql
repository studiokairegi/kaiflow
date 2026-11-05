-- Allow the authorized Intelligence administrator to start a new, manually reviewed
-- outbound conversation with an existing CRM lead already linked to an Intelligence prospect.
-- The message is deliberately created as pending_approval; no send is triggered here.
begin;

create or replace function public.intel_admin_compose_lead_message(
  p_lead_id uuid,
  p_subject text,
  p_body text
) returns uuid
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.intel_admin_org();
  l public.leads;
  p public.intel_prospects;
  s public.intel_settings;
  v_to text;
  v_id uuid;
begin
  if nullif(btrim(coalesce(p_subject, '')), '') is null then
    raise exception 'Subject is required';
  end if;
  if nullif(btrim(coalesce(p_body, '')), '') is null then
    raise exception 'Message is required';
  end if;
  if char_length(p_subject) > 300 or char_length(p_body) > 20000 then
    raise exception 'Message exceeds the allowed length';
  end if;

  select * into l from public.leads where id = p_lead_id for update;
  if not found then raise exception 'CRM lead not found'; end if;

  if not exists (
    select 1
    from public.studio_data_owners o
    where o.user_id = l.user_id
      and o.organization_id = v_org
  ) then
    raise exception 'CRM lead is outside the Intelligence organization';
  end if;

  if not public.studio_user_has_app_permission(
    'crm.read',
    l.user_id,
    NULL::uuid,
    'lead',
    l.id
  ) then
    raise exception 'You do not have permission to access this CRM lead';
  end if;
  select * into p from public.intel_prospects
   where organization_id = v_org and (lead_id = l.id or id = l.intel_prospect_id)
   order by (lead_id = l.id) desc limit 1 for update;
  if not found then raise exception 'CRM lead is not linked to an Intelligence prospect'; end if;
  if p.lead_id is distinct from l.id then
    raise exception 'CRM lead and Intelligence prospect linkage is inconsistent';
  end if;
  if p.status in ('rejected','closed','suppressed','replied') then
    raise exception 'This prospect is not eligible for a new outbound conversation';
  end if;

  v_to := public.intel_norm_email(l.email);
  if v_to is null
     or v_to = ''
     or v_to is distinct from public.intel_norm_email(p.contact_email) then
    raise exception 'CRM lead email does not match the linked Intelligence prospect email';
  end if;
  select * into s from public.intel_settings where organization_id = v_org;
  if not found or nullif(btrim(s.sender_email), '') is null then
    raise exception 'Configure the Intelligence sender email first';
  end if;
  if exists (select 1 from public.intel_suppressions x where x.organization_id = v_org and
    ((x.kind = 'email' and x.value = v_to) or (x.kind = 'domain' and x.value = split_part(v_to, '@', 2)))) then
    raise exception 'Recipient is suppressed';
  end if;
  if exists (select 1 from public.intel_messages m where m.organization_id = v_org
    and m.prospect_id = p.id and m.direction = 'outbound'
    and m.kind = 'initial' and m.state not in ('discarded','failed')) then
    raise exception 'An initial conversation already exists for this prospect';
  end if;

  insert into public.intel_messages(
    organization_id, prospect_id, lead_id, campaign_type, direction, kind, step, state,
    to_email, from_email, subject, body_text, idempotency_key, auto_sent
  ) values (
    v_org, p.id, l.id, p.type, 'outbound', 'initial', 0, 'pending_approval',
    v_to, s.sender_email, left(btrim(p_subject), 300), left(btrim(p_body), 20000),
    'admin-new-lead:' || gen_random_uuid()::text, false
  ) returning id into v_id;

  perform public._intel_log(v_org, 'admin', 'compose_new_lead_message', 'message', v_id::text,
    jsonb_build_object('lead_id', l.id, 'prospect_id', p.id));
  return v_id;
end $$;

revoke all on function public.intel_admin_compose_lead_message(uuid,text,text) from public, anon;
grant execute on function public.intel_admin_compose_lead_message(uuid,text,text) to authenticated;

commit;
