-- KairFlow Intelligence: V1 completion.
--   1. Security fix: crm_find_lead_duplicates may only read the leads of the Intelligence studio's own data owner.
--   2. Existing-CRM follow-up workflow: read-only review of the leads you already have, and an explicit "adopt" step.
--      Adopting NEVER sends anything. Follow-ups for adopted leads are always drafted as pending_approval.
--   3. Agent Chat: threads, messages and ONE allowlisted tool dispatcher. The model can only name a tool and its
--      arguments; every call re-checks that the requesting user is STILL admin AND an active Master User.
--   4. Threading context: the agent now receives the previous email's Message-ID/References to reply into the thread.
-- Requires the five previous Intelligence migrations. Additive and re-runnable. Do NOT apply to production until reviewed.
begin;

do $$ begin
  if to_regprocedure('public.intel_agent_org()') is null or to_regprocedure('public.intel_is_authorized_user(uuid,uuid)') is null then
    raise exception 'Apply the five earlier Intelligence migrations (20261109090000 .. 20261109130000) first';
  end if;
end $$;

-- 1. Schema ---------------------------------------------------------------------------------------------------------
alter table public.intel_prospects add column if not exists origin text not null default 'discovered';
alter table public.intel_prospects drop constraint if exists intel_prospects_origin_check;
alter table public.intel_prospects add constraint intel_prospects_origin_check check (origin in ('discovered', 'crm_existing'));

alter table public.intel_jobs drop constraint if exists intel_jobs_kind_check;
alter table public.intel_jobs add constraint intel_jobs_kind_check check (kind in
  ('discover','research','qualify','resolve','draft','send','sync_mail','classify','reconcile','followup_scan','retention','chat'));

create table if not exists public.intel_chat_threads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists intel_chat_threads_user_idx on public.intel_chat_threads(user_id, updated_at desc);

create table if not exists public.intel_chat_messages (
  id bigint generated always as identity primary key,
  thread_id uuid not null references public.intel_chat_threads(id) on delete cascade,
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'tool')),
  content text not null default '' check (char_length(content) <= 8000),
  tool_name text,
  tool_args jsonb,
  tool_result jsonb,
  status text not null default 'done' check (status in ('done', 'error')),
  client_key text,
  reply_to bigint,                         -- the user message this assistant / tool row answers
  created_at timestamptz not null default now()
);
create index if not exists intel_chat_messages_thread_idx on public.intel_chat_messages(thread_id, id);
create unique index if not exists intel_chat_messages_client_uidx on public.intel_chat_messages(thread_id, client_key) where client_key is not null;
create unique index if not exists intel_chat_one_reply_uidx on public.intel_chat_messages(thread_id, reply_to) where role = 'assistant' and reply_to is not null;

alter table public.intel_chat_threads enable row level security;
alter table public.intel_chat_messages enable row level security;
revoke all on public.intel_chat_threads, public.intel_chat_messages from public, anon, authenticated;
grant select on public.intel_chat_threads, public.intel_chat_messages to authenticated;
drop policy if exists intel_chat_select on public.intel_chat_threads;
create policy intel_chat_select on public.intel_chat_threads for select to authenticated
  using (user_id = auth.uid() and public.intel_is_authorized(organization_id));
drop policy if exists intel_chat_select on public.intel_chat_messages;
create policy intel_chat_select on public.intel_chat_messages for select to authenticated
  using (public.intel_is_authorized(organization_id)
         and exists (select 1 from public.intel_chat_threads t where t.id = thread_id and t.user_id = auth.uid()));

-- 2. Security fix: duplicate lookup scope ---------------------------------------------------------------------------------
--    Before: an authorized administrator or the agent could pass ANY user's id and probe that user's leads.
--    Now: a caller may read (a) their own leads, or (b) the leads of the data owner of an Intelligence studio they are
--    authorized for / are the registered agent of. Nothing else.
create or replace function public.crm_find_lead_duplicates(
  p_owner uuid, p_company text, p_website text, p_email text, p_contact text, p_exclude uuid default null)
returns table(lead_id uuid, confidence text, reason text)
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  v_email text := public.intel_norm_email(p_email);
  v_site text := public.intel_norm_website(p_website);
  v_comp text := public.intel_norm_company(p_company);
  v_contact text := lower(btrim(coalesce(p_contact, '')));
  v_ok boolean := false;
begin
  if auth.uid() is null or p_owner is null then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if auth.uid() = p_owner then
    v_ok := true;
  else
    v_ok := exists (
      select 1 from public.intel_settings s
       where s.owner_user_id = p_owner
         and (s.agent_user_id = auth.uid() or public.intel_is_authorized(s.organization_id)));
  end if;
  if not v_ok then raise exception 'Not allowed' using errcode = '42501'; end if;
  if v_email = '' and v_site = '' and v_comp = '' then return; end if;
  return query
    select l.id, c.conf, c.why
      from public.leads l
      cross join lateral (
        select
          case
            when v_email <> '' and public.intel_norm_email(l.email) = v_email then 'very_high'
            when v_site <> '' and public.intel_norm_website(l.website) = v_site then 'very_high'
            when v_comp <> '' and public.intel_norm_company(l.company_name) = v_comp then
              case when v_contact <> '' and lower(btrim(coalesce(l.contact_person, ''))) = v_contact then 'very_high' else 'high' end
            when v_comp <> '' and length(v_comp) >= 4 and length(public.intel_norm_company(l.company_name)) >= 4
                 and (starts_with(v_comp, public.intel_norm_company(l.company_name))
                      or starts_with(public.intel_norm_company(l.company_name), v_comp)) then 'medium'
          end as conf,
          case
            when v_email <> '' and public.intel_norm_email(l.email) = v_email then 'email'
            when v_site <> '' and public.intel_norm_website(l.website) = v_site then 'website'
            when v_comp <> '' and public.intel_norm_company(l.company_name) = v_comp then 'company'
            else 'similar company name'
          end as why
      ) c
     where l.user_id = p_owner and l.id is distinct from p_exclude and c.conf is not null
     order by case c.conf when 'very_high' then 0 when 'high' then 1 else 2 end, l.created_at;
end $$;

create or replace function public._intel_safe_date(p text) returns date
language plpgsql immutable as $$
begin return left(p, 10)::date; exception when others then return null; end $$;

-- 3. Existing-CRM follow-up review (read only) ------------------------------------------------------------------------------
--    Buckets: follow_up_due, waiting, replied, needs_review, not_contacted, no_email, do_not_contact.
create or replace function public._intel_crm_review(p_org uuid, p_limit int default 400, p_ids uuid[] default null)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  s public.intel_settings;
  v_today date;
  v_tz text;
  v_days int;
begin
  select * into s from public.intel_settings where organization_id = p_org;
  if not found then return jsonb_build_object('counts', '{}'::jsonb, 'leads', '[]'::jsonb); end if;
  v_today := public._intel_today(p_org);
  v_tz := s.timezone;
  v_days := s.followup_business_days;
  return (
    with base as (
      select l.id, l.company_name, l.contact_person, l.email, l.website, l.stage, l.priority, l.needs_followup,
             l.last_contacted_at, l.stage_changed_at, l.source_kind,
             (case when jsonb_typeof(l.emails) = 'array' then l.emails else '[]'::jsonb end) as em
        from public.leads l
       where l.user_id = s.owner_user_id and l.archived_at is null and (p_ids is null or l.id = any (p_ids))
    ), enriched as (
      select b.*,
             (select count(*) from jsonb_array_elements(b.em) x where x ->> 'sent' = 'true')::int as emails_sent,
             (select max(public._intel_safe_date(x ->> 'dateSent')) from jsonb_array_elements(b.em) x
               where x ->> 'sent' = 'true') as last_email_date,
             public.intel_norm_email(b.email) as nemail,
             public.intel_domain_of(b.website) as ndomain
        from base b
    ), classified as (
      select e.*, pr.id as prospect_id, pr.status as prospect_status,
             exists (select 1 from public.intel_suppressions z
                      where z.organization_id = p_org
                        and ((z.kind = 'email' and z.value = e.nemail and e.nemail <> '')
                          or (z.kind = 'domain' and ((z.value = e.ndomain and e.ndomain <> '') or (e.nemail <> '' and e.nemail like '%@' || z.value))))) as suppressed,
             exists (select 1 from public.intel_messages m
                      where m.organization_id = p_org and m.direction = 'inbound' and e.nemail <> ''
                        and public.intel_norm_email(m.from_email) = e.nemail) as has_inbound,
             coalesce((e.last_contacted_at at time zone v_tz)::date, e.last_email_date, (e.stage_changed_at at time zone v_tz)::date) as anchor
        from enriched e
        left join lateral (select p2.id, p2.status from public.intel_prospects p2
                            where p2.organization_id = p_org and p2.lead_id = e.id order by p2.updated_at desc limit 1) pr on true
    ), decided as (
      select c.*,
        case
          when c.stage in ('lost', 'disqualified', 'closed', 'no_response') then 'do_not_contact|Stage is ' || c.stage
          when c.stage = 'won' then 'do_not_contact|Already a client (Won)'
          when c.nemail = '' or position('@' in c.nemail) < 2 then 'no_email|No usable email address'
          when c.suppressed then 'do_not_contact|Suppressed (opted out or blocked)'
          when c.prospect_status in ('closed', 'rejected', 'suppressed') then 'do_not_contact|Closed in Intelligence'
          when c.prospect_status = 'replied' or c.has_inbound or c.stage in ('responded', 'qualified', 'proposal', 'negotiation')
            then 'replied|Has replied or is already in conversation (' || c.stage || ')'
          when c.stage = 'pool' and c.emails_sent = 0 and c.last_contacted_at is null then 'not_contacted|Never contacted: not a follow-up'
          when c.emails_sent >= 4 then 'do_not_contact|All four emails in the sequence were already sent'
          when c.anchor is null then 'needs_review|No contact date recorded'
          when public.intel_business_days_between(c.anchor, v_today) >= v_days
            then 'follow_up_due|Last contact ' || public.intel_business_days_between(c.anchor, v_today) || ' business days ago'
          else 'waiting|Not due yet (' || public.intel_business_days_between(c.anchor, v_today) || ' of ' || v_days || ' business days)'
        end as verdict
        from classified c
    ), ranked as (
      select d.*, split_part(d.verdict, '|', 1) as bucket,
             case split_part(d.verdict, '|', 1)
               when 'follow_up_due' then 0 when 'replied' then 1 when 'needs_review' then 2 when 'waiting' then 3
               when 'not_contacted' then 4 when 'no_email' then 5 else 6 end as rk
        from decided d
    )
    select jsonb_build_object(
      'counts', coalesce((select jsonb_object_agg(q.bucket, q.n) from (select r.bucket, count(*) as n from ranked r group by r.bucket) q), '{}'::jsonb),
      'leads', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'lead_id', t.id, 'company_name', t.company_name, 'contact_person', t.contact_person, 'email', t.email,
                 'stage', t.stage, 'priority', t.priority, 'needs_followup', t.needs_followup, 'emails_sent', t.emails_sent,
                 'last_contact', t.anchor, 'bucket', t.bucket, 'reason', split_part(t.verdict, '|', 2),
                 'prospect_id', t.prospect_id, 'tracked', t.prospect_id is not null, 'source_kind', t.source_kind)
               order by t.rk, t.anchor nulls last, t.company_name)
          from (select r.* from ranked r order by r.rk, r.anchor nulls last, r.company_name limit greatest(1, least(p_limit, 500))) t
      ), '[]'::jsonb)
    )
  );
end $$;

-- Adopt existing CRM leads into Intelligence so follow-ups can be DRAFTED (never sent) for them. Only leads whose
-- history shows they were contacted and are not yet due/overdue replied-to are accepted. The lead row is not changed
-- (its manual attribution stays), and a visible "Imported from CRM history" message anchors the follow-up timing.
create or replace function public._intel_crm_adopt(p_org uuid, p_ids uuid[], p_type text, p_actor text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  s public.intel_settings; r jsonb; v_row jsonb; l public.leads; v_id uuid; v_prospect uuid; v_camp uuid;
  v_key text; v_domain text; v_anchor timestamptz; v_ok int := 0; v_skipped jsonb := '[]'::jsonb; v_ids uuid[];
begin
  if p_type not in ('indie_game_developer', 'animation_studio_support') then raise exception 'bad campaign type'; end if;
  select array_agg(distinct x) into v_ids from unnest(coalesce(p_ids, '{}'::uuid[])) x;
  if v_ids is null or array_length(v_ids, 1) is null then raise exception 'no leads selected'; end if;
  if array_length(v_ids, 1) > 25 then raise exception 'adopt at most 25 leads at a time'; end if;
  select * into s from public.intel_settings where organization_id = p_org;
  if not found then raise exception 'Run setup first (intel_admin_bootstrap)'; end if;
  perform pg_advisory_xact_lock(hashtext(p_org::text || ':lead'));
  select id into v_camp from public.intel_campaigns where organization_id = p_org and type = p_type;
  r := public._intel_crm_review(p_org, 500, v_ids);
  foreach v_id in array v_ids loop
    select e into v_row from jsonb_array_elements(r -> 'leads') e where (e ->> 'lead_id')::uuid = v_id limit 1;
    if v_row is null then
      v_skipped := v_skipped || jsonb_build_object('lead_id', v_id, 'reason', 'not_found'); continue;
    end if;
    if (v_row ->> 'tracked')::boolean then
      v_skipped := v_skipped || jsonb_build_object('lead_id', v_id, 'reason', 'already_tracked'); continue;
    end if;
    if (v_row ->> 'bucket') not in ('follow_up_due', 'waiting') then
      v_skipped := v_skipped || jsonb_build_object('lead_id', v_id, 'reason', v_row ->> 'bucket', 'detail', v_row ->> 'reason'); continue;
    end if;
    select * into l from public.leads where id = v_id and user_id = s.owner_user_id;
    if not found then v_skipped := v_skipped || jsonb_build_object('lead_id', v_id, 'reason', 'not_found'); continue; end if;
    v_domain := public.intel_domain_of(l.website);
    v_key := case when v_domain <> '' then 'd:' || v_domain else 'n:' || public.intel_norm_company(l.company_name) end;
    if v_key in ('d:', 'n:') then
      v_skipped := v_skipped || jsonb_build_object('lead_id', v_id, 'reason', 'no_identity'); continue;
    end if;
    v_anchor := ((v_row ->> 'last_contact')::date)::timestamp at time zone s.timezone;
    begin
      insert into public.intel_prospects(organization_id, campaign_id, type, canonical_key, name, website, domain, contact_name, contact_email,
                                         country, status, facts, lead_id, origin)
      values (p_org, v_camp, p_type, v_key, left(l.company_name, 200), left(coalesce(l.website, ''), 300), v_domain, left(coalesce(l.contact_person, ''), 200),
              public.intel_norm_email(l.email), left(coalesce(l.country, ''), 80), 'contacted',
              jsonb_build_object('verified', '{}'::jsonb, 'estimates', jsonb_build_object('adopted_from_crm', true)), l.id, 'crm_existing')
      returning id into v_prospect;
      insert into public.intel_messages(organization_id, prospect_id, lead_id, campaign_type, direction, kind, step, state, to_email, from_email,
                                        subject, body_text, idempotency_key, sent_at, summary)
      values (p_org, v_prospect, l.id, p_type, 'outbound', 'initial', 0, 'sent', public.intel_norm_email(l.email), s.sender_email,
              'Imported from CRM history', left(coalesce(l.emails -> 0 ->> 'message', ''), 4000), 'crm-import:' || l.id::text, v_anchor,
              'Imported from the CRM. The last recorded contact date anchors follow-up timing. Nothing was sent by Intelligence.');
      perform public._intel_log(p_org, p_actor, 'crm_adopt', 'lead', l.id::text, jsonb_build_object('prospect_id', v_prospect, 'type', p_type));
      v_ok := v_ok + 1;
    exception when unique_violation then
      v_skipped := v_skipped || jsonb_build_object('lead_id', v_id, 'reason', 'already_tracked_or_introduced');
    end;
  end loop;
  return jsonb_build_object('adopted', v_ok, 'skipped', v_skipped);
end $$;

create or replace function public.intel_admin_crm_review(p_limit int default 400) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_admin_org();
begin return public._intel_crm_review(v_org, p_limit, null); end $$;

create or replace function public.intel_admin_crm_adopt(p_lead_ids uuid[], p_type text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_admin_org();
begin return public._intel_crm_adopt(v_org, p_lead_ids, p_type, 'admin'); end $$;

-- 4. Agent functions replaced to carry what follow-ups and threading need --------------------------------------------------
-- (a) context now includes the linked lead's sent-email history (dates only), so a follow-up uses the right sequence step.
create or replace function public.intel_agent_context(p_prospect_id uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org();
begin
  return (select jsonb_build_object(
      'prospect', to_jsonb(p),
      'evidence', coalesce((select jsonb_agg(jsonb_build_object('source', e.source, 'url', e.url, 'fact_type', e.fact_type, 'snippet', e.snippet, 'verified', e.verified) order by e.fetched_at) from public.intel_evidence e where e.prospect_id = p.id), '[]'::jsonb),
      'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'direction', m.direction, 'kind', m.kind, 'step', m.step, 'state', m.state, 'subject', m.subject, 'body_text', left(m.body_text, 4000), 'rfc_message_id', m.rfc_message_id, 'references_ids', m.references_ids, 'zoho_message_id', m.zoho_message_id, 'from_email', m.from_email, 'created_at', m.created_at, 'sent_at', m.sent_at) order by m.created_at) from public.intel_messages m where m.prospect_id = p.id), '[]'::jsonb),
      'lead', (select jsonb_build_object('id', l.id, 'stage', l.stage, 'source_kind', l.source_kind, 'last_contacted_at', l.last_contacted_at,
                 'sent_flags', coalesce((select jsonb_agg(coalesce(x.e ->> 'sent', 'false') = 'true' order by x.n)
                                           from jsonb_array_elements(case when jsonb_typeof(l.emails) = 'array' then l.emails else '[]'::jsonb end) with ordinality as x(e, n)), '[]'::jsonb),
                 'sent_dates', coalesce((select jsonb_agg(jsonb_build_object('idx', x.n - 1, 'date', x.e ->> 'dateSent') order by x.n)
                                           from jsonb_array_elements(case when jsonb_typeof(l.emails) = 'array' then l.emails else '[]'::jsonb end) with ordinality as x(e, n)
                                          where x.e ->> 'sent' = 'true'), '[]'::jsonb))
                 from public.leads l where l.id = p.lead_id))
     from public.intel_prospects p where p.id = p_prospect_id and p.organization_id = v_org);
end $$;

-- (b) inbound messages now carry their threading headers so a reply can be placed in the same thread.
create or replace function public.intel_agent_unprocessed_inbound(p_limit int default 20) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org();
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'prospect_id', m.prospect_id, 'from_email', m.from_email, 'subject', m.subject,
                                                       'body_text', left(m.body_text, 6000), 'rfc_message_id', m.rfc_message_id, 'in_reply_to', m.in_reply_to,
                                                       'references_ids', m.references_ids, 'zoho_message_id', m.zoho_message_id) order by m.received_at)
                     from (select * from public.intel_messages where organization_id = v_org and direction = 'inbound' and classification is null order by received_at limit greatest(1, least(p_limit, 100))) m), '[]'::jsonb);
end $$;

-- (c) drafts: anything for an adopted CRM lead ALWAYS waits for the administrator, whatever the autonomy setting.
create or replace function public.intel_agent_upsert_draft(
  p_prospect_id uuid, p_kind text, p_step int, p_subject text, p_body text, p_idempotency_key text, p_to_email text, p_auto_ok boolean default false,
  p_in_reply_to text default null, p_references text default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org(); s public.intel_settings; p public.intel_prospects; v_state text; v_id uuid; v_to text := public.intel_norm_email(p_to_email);
begin
  select * into s from public.intel_settings where organization_id = v_org;
  select * into p from public.intel_prospects where id = p_prospect_id and organization_id = v_org;
  if not found then raise exception 'prospect not found'; end if;
  if p_kind not in ('initial','followup','reply') then raise exception 'bad kind'; end if;
  if p.status in ('suppressed','rejected','closed') then return public._intel_deny('prospect_not_contactable'); end if;
  if not (v_to = public.intel_norm_email(p.contact_email)
          or (p_kind = 'reply' and exists (select 1 from public.intel_messages i where i.prospect_id = p.id and i.direction = 'inbound' and public.intel_norm_email(i.from_email) = v_to))) then
    return public._intel_deny('recipient_not_allowed');
  end if;
  if v_to = '' then return public._intel_deny('no_recipient'); end if;
  v_state := case
    when p.origin = 'crm_existing' then 'pending_approval'
    when s.autonomy = 'autonomous' and (p_kind <> 'reply' or p_auto_ok) then 'approved'
    when s.autonomy = 'assisted' and p_kind = 'followup' then 'approved'
    when s.autonomy = 'assisted' and p_kind = 'reply' and p_auto_ok then 'approved'
    else 'pending_approval' end;
  insert into public.intel_messages(organization_id, prospect_id, lead_id, campaign_type, direction, kind, step, state, to_email, from_email, subject, body_text,
                                    idempotency_key, auto_sent, in_reply_to, references_ids)
  values (v_org, p.id, p.lead_id, p.type, 'outbound', p_kind, coalesce(p_step, 0), v_state, v_to, s.sender_email, left(p_subject, 300), left(p_body, 20000),
          left(p_idempotency_key, 200), v_state = 'approved', left(p_in_reply_to, 998), left(p_references, 4000))
  on conflict (organization_id, idempotency_key) do nothing returning id into v_id;
  if v_id is null then
    select id into v_id from public.intel_messages where organization_id = v_org and idempotency_key = left(p_idempotency_key, 200);
    return jsonb_build_object('ok', true, 'message_id', v_id, 'created', false);
  end if;
  perform public._intel_log(v_org, 'agent', 'draft_' || p_kind, 'message', v_id::text, jsonb_build_object('state', v_state, 'origin', p.origin));
  return jsonb_build_object('ok', true, 'message_id', v_id, 'created', true, 'state', v_state);
exception when unique_violation then
  return public._intel_deny('already_introduced');
end $$;

-- 5. Agent Chat: user-facing RPCs ---------------------------------------------------------------------------------------
create or replace function public.intel_admin_chat_new_thread(p_title text default 'New chat') returns uuid
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_admin_org(); v_id uuid;
begin
  if not exists (select 1 from public.intel_settings where organization_id = v_org) then raise exception 'Run setup first (intel_admin_bootstrap)'; end if;
  insert into public.intel_chat_threads(organization_id, user_id, title)
  values (v_org, auth.uid(), left(coalesce(nullif(btrim(p_title), ''), 'New chat'), 80)) returning id into v_id;
  return v_id;
end $$;

create or replace function public.intel_admin_chat_send(p_thread_id uuid, p_text text, p_client_key text default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_admin_org(); t public.intel_chat_threads; v_id bigint; v_job uuid; v_text text := btrim(coalesce(p_text, '')); v_key text := nullif(left(coalesce(p_client_key, ''), 80), '');
begin
  select * into t from public.intel_chat_threads where id = p_thread_id and organization_id = v_org and user_id = auth.uid();
  if not found then raise exception 'chat not found'; end if;
  if v_text = '' or char_length(v_text) > 2000 then raise exception 'A message must be 1 to 2000 characters'; end if;
  if (select count(*) from public.intel_chat_messages m join public.intel_chat_threads x on x.id = m.thread_id
       where x.user_id = auth.uid() and x.organization_id = v_org and m.role = 'user' and m.created_at > now() - interval '1 hour') >= 60 then
    raise exception 'Too many messages in the last hour. Try again later.';
  end if;
  insert into public.intel_chat_messages(thread_id, organization_id, role, content, client_key) values (t.id, v_org, 'user', v_text, v_key)
  on conflict (thread_id, client_key) where client_key is not null do nothing returning id into v_id;
  if v_id is null then
    select m.id into v_id from public.intel_chat_messages m where m.thread_id = t.id and m.client_key = v_key;
    return jsonb_build_object('ok', true, 'message_id', v_id, 'duplicate', true);
  end if;
  update public.intel_chat_threads set updated_at = now(), title = case when title = 'New chat' then left(v_text, 60) else title end where id = t.id;
  insert into public.intel_jobs(organization_id, kind, payload, priority, idempotency_key)
  values (v_org, 'chat', jsonb_build_object('thread_id', t.id, 'message_id', v_id), 10, 'chat:' || v_id::text)
  on conflict (organization_id, idempotency_key) do nothing returning id into v_job;
  perform public._intel_log(v_org, 'admin', 'chat_message', 'chat', t.id::text, jsonb_build_object('message_id', v_id));
  return jsonb_build_object('ok', true, 'message_id', v_id, 'job_id', v_job);
end $$;

-- 6. Agent Chat: worker-facing RPCs ---------------------------------------------------------------------------------------
create or replace function public.intel_agent_chat_context(p_thread_id uuid, p_message_id bigint, p_limit int default 16) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org(); t public.intel_chat_threads; v_msg public.intel_chat_messages;
begin
  select * into t from public.intel_chat_threads where id = p_thread_id and organization_id = v_org;
  if not found then return public._intel_deny('thread_not_found'); end if;
  select * into v_msg from public.intel_chat_messages where id = p_message_id and thread_id = t.id and role = 'user';
  if not found then return public._intel_deny('message_not_found'); end if;
  if not public.intel_is_authorized_user(t.user_id, v_org) then return public._intel_deny('requester_not_authorized'); end if;
  return jsonb_build_object('ok', true,
    'answered', exists (select 1 from public.intel_chat_messages a where a.thread_id = t.id and a.role = 'assistant' and a.reply_to = p_message_id),
    'request', v_msg.content,
    'history', coalesce((select jsonb_agg(jsonb_build_object('role', h.role, 'content', left(h.content, 1500)) order by h.id)
                           from (select * from public.intel_chat_messages where thread_id = t.id and role in ('user', 'assistant') and id < p_message_id
                                  order by id desc limit greatest(1, least(p_limit, 30))) h), '[]'::jsonb));
end $$;

create or replace function public.intel_agent_chat_reply(p_thread_id uuid, p_message_id bigint, p_text text, p_status text default 'done') returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org(); t public.intel_chat_threads;
begin
  select * into t from public.intel_chat_threads where id = p_thread_id and organization_id = v_org;
  if not found then raise exception 'thread not found'; end if;
  if p_status not in ('done', 'error') then raise exception 'bad status'; end if;
  if not exists (select 1 from public.intel_chat_messages m where m.id = p_message_id and m.thread_id = t.id and m.role = 'user') then raise exception 'message not found'; end if;
  insert into public.intel_chat_messages(thread_id, organization_id, role, content, status, reply_to)
  values (t.id, v_org, 'assistant', left(coalesce(p_text, ''), 8000), p_status, p_message_id)
  on conflict (thread_id, reply_to) where role = 'assistant' and reply_to is not null do nothing;
  update public.intel_chat_threads set updated_at = now() where id = t.id;
  return jsonb_build_object('ok', true);
end $$;

-- 7. Agent Chat: the ONE tool dispatcher ------------------------------------------------------------------------------
-- The model never runs SQL, shell commands or any other function. It names a tool and arguments; this function is the
-- complete list of what can happen. It can never send an email, approve a message, turn sending on, change settings,
-- remove a suppression, or touch any other module. Every call: re-checks the requester, is capped, and is audited.
create or replace function public._intel_jint(a jsonb, k text, def int, lo int, hi int) returns int
language sql immutable as $$
  select least(greatest(case when (a ->> k) ~ '^\d{1,6}$' then (a ->> k)::int else def end, lo), hi)
$$;
create or replace function public._intel_juuid(a jsonb, k text) returns uuid
language sql immutable as $$
  select case when (a ->> k) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (a ->> k)::uuid end
$$;
create or replace function public._intel_juuids(a jsonb, k text, p_max int) returns uuid[]
language sql immutable as $$
  select coalesce(array_agg(x::uuid), '{}'::uuid[])
    from (select x from jsonb_array_elements_text(case when jsonb_typeof(a -> k) = 'array' then a -> k else '[]'::jsonb end) x
           where x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' limit p_max) q
$$;

create or replace function public.intel_agent_chat_tool(p_thread_id uuid, p_message_id bigint, p_tool text, p_args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.intel_agent_org();
  t public.intel_chat_threads;
  s public.intel_settings;
  a jsonb := case when jsonb_typeof(coalesce(p_args, '{}'::jsonb)) = 'object' then coalesce(p_args, '{}'::jsonb) else '{}'::jsonb end;
  v_out jsonb; v_n int; v_id uuid; v_ids uuid[]; v_job uuid;
  v_type text := nullif(a ->> 'type', ''); v_status text := nullif(a ->> 'status', ''); v_query text := nullif(left(btrim(coalesce(a ->> 'query', a ->> 'name', '')), 120), '');
  v_limit int := public._intel_jint(a, 'limit', 10, 1, 25);
  v_days int := public._intel_jint(a, 'days', 7, 1, 90);
  v_up jsonb; pr public.intel_prospects;
  v_tools text[] := array['campaign_status','list_prospects','prospect_detail','opportunities','stats','crm_followup_review',
                          'start_discovery','research_prospect','set_campaign_status','emergency_stop','adopt_crm_leads','prepare_followups','prepare_introductions'];
begin
  select * into t from public.intel_chat_threads where id = p_thread_id and organization_id = v_org;
  if not found then return public._intel_deny('thread_not_found'); end if;
  if not exists (select 1 from public.intel_chat_messages m where m.id = p_message_id and m.thread_id = t.id and m.role = 'user') then
    return public._intel_deny('message_not_found');
  end if;
  -- the person who asked must STILL be an administrator AND an active Master User of this studio, right now
  if not public.intel_is_authorized_user(t.user_id, v_org) then
    perform public._intel_log(v_org, 'agent', 'chat_denied_unauthorized', 'chat', t.id::text, jsonb_build_object('tool', left(coalesce(p_tool, ''), 40)));
    return public._intel_deny('requester_not_authorized');
  end if;
  if p_tool is null or not (p_tool = any (v_tools)) then
    perform public._intel_log(v_org, 'agent', 'chat_denied_unknown_tool', 'chat', t.id::text, jsonb_build_object('tool', left(coalesce(p_tool, ''), 40)));
    return public._intel_deny('unknown_tool');
  end if;
  select count(*) into v_n from public.intel_chat_messages m where m.thread_id = t.id and m.role = 'tool' and m.reply_to = p_message_id;
  if v_n >= 8 then return public._intel_deny('too_many_tool_calls'); end if;
  select * into s from public.intel_settings where organization_id = v_org;

  begin   -- any failure inside a tool rolls that tool back and is reported as a normal denial
    if p_tool = 'campaign_status' then
      v_out := jsonb_build_object('ok', true, 'sending_stopped', s.kill_switch, 'autonomy', s.autonomy,
        'campaigns', coalesce((select jsonb_agg(jsonb_build_object('type', c.type, 'name', c.name, 'status', c.status, 'daily_cap', c.daily_cap,
                       'prospects', (select count(*) from public.intel_prospects p where p.campaign_id = c.id))) from public.intel_campaigns c where c.organization_id = v_org), '[]'::jsonb),
        'waiting_for_approval', (select count(*) from public.intel_messages where organization_id = v_org and state = 'pending_approval'),
        'prospects_by_status', coalesce((select jsonb_object_agg(q.status, q.n) from (select status, count(*) n from public.intel_prospects where organization_id = v_org group by status) q), '{}'::jsonb));

    elsif p_tool = 'list_prospects' then
      if v_status is not null and v_status not in ('discovered','researched','qualified','needs_review','rejected','lead_linked','contacted','replied','closed','suppressed') then
        return public._intel_deny('bad_status');
      end if;
      if v_type is not null and v_type not in ('indie_game_developer','animation_studio_support') then return public._intel_deny('bad_type'); end if;
      v_out := jsonb_build_object('ok', true, 'prospects', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'type', p.type, 'status', p.status,
                 'score', p.score, 'website', p.website, 'origin', p.origin, 'lead_id', p.lead_id, 'updated_at', p.updated_at))
                 from (select * from public.intel_prospects where organization_id = v_org and (v_status is null or status = v_status) and (v_type is null or type = v_type)
                          and (v_query is null or position(lower(v_query) in lower(name)) > 0) order by updated_at desc limit v_limit) p), '[]'::jsonb));

    elsif p_tool = 'prospect_detail' then
      v_id := public._intel_juuid(a, 'prospect_id');
      select * into pr from public.intel_prospects where organization_id = v_org
         and ((v_id is not null and id = v_id) or (v_id is null and v_query is not null and position(lower(v_query) in lower(name)) > 0))
       order by updated_at desc limit 1;
      if not found then return public._intel_deny('prospect_not_found'); end if;
      v_out := jsonb_build_object('ok', true,
        'prospect', jsonb_build_object('id', pr.id, 'name', pr.name, 'type', pr.type, 'status', pr.status, 'score', pr.score, 'website', pr.website, 'country', pr.country,
                      'origin', pr.origin, 'review_reason', pr.review_reason, 'score_breakdown', pr.score_breakdown, 'lead_id', pr.lead_id),
        'evidence_count', (select count(*) from public.intel_evidence e where e.prospect_id = pr.id),
        'lead', (select jsonb_build_object('id', l.id, 'stage', l.stage, 'source_kind', l.source_kind) from public.leads l where l.id = pr.lead_id),
        'recent_messages', coalesce((select jsonb_agg(jsonb_build_object('direction', m.direction, 'kind', m.kind, 'state', m.state, 'subject', left(m.subject, 120),
                       'classification', m.classification, 'summary', left(m.summary, 240), 'at', coalesce(m.sent_at, m.received_at, m.created_at)) order by coalesce(m.sent_at, m.received_at, m.created_at) desc)
                       from (select * from public.intel_messages where prospect_id = pr.id order by created_at desc limit 6) m), '[]'::jsonb));

    elsif p_tool = 'opportunities' then
      v_out := jsonb_build_object('ok', true, 'opportunities', coalesce((select jsonb_agg(jsonb_build_object('prospect_id', x.id, 'name', x.name, 'type', x.type, 'class', x.last_class,
                 'summary', x.last_summary, 'received_at', x.last_at, 'lead_id', x.lead_id, 'lead_stage', x.lead_stage) order by x.last_at desc nulls last)
                 from (select * from (select p.id, p.name, p.type, p.lead_id,
                              (select l.stage from public.leads l where l.id = p.lead_id) as lead_stage,
                              (select m.classification from public.intel_messages m where m.prospect_id = p.id and m.direction = 'inbound' order by m.received_at desc nulls last limit 1) as last_class,
                              (select left(m.summary, 240) from public.intel_messages m where m.prospect_id = p.id and m.direction = 'inbound' order by m.received_at desc nulls last limit 1) as last_summary,
                              (select m.received_at from public.intel_messages m where m.prospect_id = p.id and m.direction = 'inbound' order by m.received_at desc nulls last limit 1) as last_at
                         from public.intel_prospects p where p.organization_id = v_org and p.status = 'replied') y
                        where y.last_class in ('positive','meeting_request','pricing','negotiation','portfolio_request','project_opportunity')
                        order by y.last_at desc nulls last limit v_limit) x), '[]'::jsonb));

    elsif p_tool = 'stats' then
      v_out := jsonb_build_object('ok', true, 'days', v_days,
        'introductions_sent', (select count(*) from public.intel_messages where organization_id = v_org and direction = 'outbound' and kind = 'initial' and state = 'sent'
                                  and idempotency_key not like 'crm-import:%' and sent_at > now() - make_interval(days => v_days)),
        'followups_sent', (select count(*) from public.intel_messages where organization_id = v_org and direction = 'outbound' and kind = 'followup' and state = 'sent' and sent_at > now() - make_interval(days => v_days)),
        'replies_received', (select count(*) from public.intel_messages where organization_id = v_org and direction = 'inbound' and received_at > now() - make_interval(days => v_days)
                                and coalesce(classification, '') not in ('out_of_office','auto_reply','bounce')),
        'positive_replies', (select count(*) from public.intel_messages where organization_id = v_org and direction = 'inbound' and received_at > now() - make_interval(days => v_days)
                                and classification in ('positive','meeting_request','portfolio_request','project_opportunity')),
        'replies_by_class', coalesce((select jsonb_object_agg(q.c, q.n) from (select classification c, count(*) n from public.intel_messages where organization_id = v_org and direction = 'inbound'
                                       and received_at > now() - make_interval(days => v_days) and classification is not null group by classification) q), '{}'::jsonb),
        'new_prospects', (select count(*) from public.intel_prospects where organization_id = v_org and created_at > now() - make_interval(days => v_days)),
        'ai_leads_created', (select count(*) from public.leads where user_id = s.owner_user_id and source_kind = 'ai_intelligence' and created_at > now() - make_interval(days => v_days)));

    elsif p_tool = 'crm_followup_review' then
      v_out := jsonb_build_object('ok', true) || public._intel_crm_review(v_org, v_limit, null);

    elsif p_tool = 'start_discovery' then
      if v_type is null or v_type not in ('indie_game_developer','animation_studio_support') then return public._intel_deny('bad_type'); end if;
      insert into public.intel_jobs(organization_id, kind, payload, priority, idempotency_key)
      values (v_org, 'discover', jsonb_build_object('type', v_type, 'limit', v_limit, 'manual', true), 5, 'chat:' || p_message_id::text || ':discover:' || v_type)
      on conflict (organization_id, idempotency_key) do nothing returning id into v_job;
      v_out := jsonb_build_object('ok', true, 'queued', v_job is not null, 'job_id', v_job, 'limit', v_limit,
                                  'note', 'Discovery only finds and researches prospects. Nothing is emailed.');

    elsif p_tool = 'research_prospect' then
      v_id := public._intel_juuid(a, 'prospect_id');
      if v_id is null then
        if v_type is null or v_type not in ('indie_game_developer','animation_studio_support') or v_query is null or btrim(coalesce(a ->> 'website', '')) = '' then
          return public._intel_deny('need_prospect_id_or_name_website_type');
        end if;
        v_up := public.intel_agent_upsert_prospect(v_type, v_query, left(a ->> 'website', 300), '', '', '', '', 'en', jsonb_build_object('added_by', 'chat'));
        if coalesce((v_up ->> 'suppressed')::boolean, false) then return public._intel_deny('suppressed'); end if;
        v_id := (v_up ->> 'prospect_id')::uuid;
      end if;
      select * into pr from public.intel_prospects where id = v_id and organization_id = v_org;
      if not found then return public._intel_deny('prospect_not_found'); end if;
      if pr.status not in ('discovered', 'researched') then
        v_out := jsonb_build_object('ok', true, 'queued', false, 'prospect_id', v_id, 'status', pr.status, 'note', 'Already researched. Use prospect_detail to read it.');
      else
        insert into public.intel_jobs(organization_id, kind, payload, priority, idempotency_key)
        values (v_org, 'research', jsonb_build_object('prospect_id', v_id), 5, 'chat:' || p_message_id::text || ':research:' || v_id::text)
        on conflict (organization_id, idempotency_key) do nothing returning id into v_job;
        v_out := jsonb_build_object('ok', true, 'queued', v_job is not null, 'prospect_id', v_id, 'job_id', v_job);
      end if;

    elsif p_tool = 'set_campaign_status' then
      -- Chat can only PAUSE. Starting a campaign is done on the Campaign tab so it is always a deliberate click.
      if coalesce(v_status, 'paused') <> 'paused' then return public._intel_deny('only_pause_allowed_from_chat'); end if;
      if v_type is not null and v_type <> 'all' and v_type not in ('indie_game_developer','animation_studio_support') then return public._intel_deny('bad_type'); end if;
      update public.intel_campaigns set status = 'paused', updated_at = now()
       where organization_id = v_org and status <> 'paused' and (v_type is null or v_type = 'all' or type = v_type);
      get diagnostics v_n = row_count;
      v_out := jsonb_build_object('ok', true, 'paused_campaigns', v_n);

    elsif p_tool = 'emergency_stop' then
      update public.intel_settings set kill_switch = true, updated_at = now() where organization_id = v_org;
      v_out := jsonb_build_object('ok', true, 'sending_stopped', true, 'note', 'Turning sending back on is only possible from the Overview tab.');

    elsif p_tool = 'adopt_crm_leads' then
      v_ids := public._intel_juuids(a, 'lead_ids', 25);
      if v_type is null or v_type not in ('indie_game_developer','animation_studio_support') then return public._intel_deny('bad_type'); end if;
      v_out := jsonb_build_object('ok', true) || public._intel_crm_adopt(v_org, v_ids, v_type, 'agent');

    elsif p_tool = 'prepare_followups' then
      insert into public.intel_jobs(organization_id, kind, payload, priority, idempotency_key)
      values (v_org, 'followup_scan', '{}'::jsonb, 5, 'chat:' || p_message_id::text || ':followup_scan')
      on conflict (organization_id, idempotency_key) do nothing returning id into v_job;
      v_out := jsonb_build_object('ok', true, 'queued', v_job is not null,
                                  'note', 'Follow-up drafts will appear under Outreach and wait for your approval. Nothing is sent by this request.');

    elsif p_tool = 'prepare_introductions' then
      v_ids := public._intel_juuids(a, 'prospect_ids', 10);
      v_n := 0;
      for v_id in select p.id from public.intel_prospects p
                   where p.organization_id = v_org and p.id = any (v_ids) and p.status = 'lead_linked' and p.origin = 'discovered' and p.contact_email <> '' loop
        insert into public.intel_jobs(organization_id, kind, payload, idempotency_key)
        values (v_org, 'draft', jsonb_build_object('prospect_id', v_id, 'kind', 'initial'), 'draft:' || v_id::text || ':initial')
        on conflict (organization_id, idempotency_key) do nothing;
        v_n := v_n + 1;
      end loop;
      v_out := jsonb_build_object('ok', true, 'requested', coalesce(array_length(v_ids, 1), 0), 'eligible', v_n,
                                  'note', 'Introductions are drafted and wait for approval unless autonomous mode is on.');
    end if;
  exception when others then
    return public._intel_deny('tool_failed: ' || left(sqlerrm, 160));
  end;

  insert into public.intel_chat_messages(thread_id, organization_id, role, content, tool_name, tool_args, tool_result, reply_to)
  values (t.id, v_org, 'tool', '', p_tool, a, v_out, p_message_id);
  perform public._intel_log(v_org, 'agent', 'chat_tool', 'chat', t.id::text,
                            jsonb_build_object('tool', p_tool, 'args', a, 'message_id', p_message_id, 'requested_by', t.user_id));
  return v_out;
end $$;

-- 8. Grants: same rule as the earlier migration (client roles may run intel_* only; _intel_* are internal) ---------------------
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig, p.proname
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and (p.proname like 'intel\_%' or p.proname like '\_intel\_%' or p.proname = 'crm_find_lead_duplicates')
  loop
    execute format('revoke all on function %s from public, anon', r.sig);
    if r.proname like '\_intel\_%' then
      execute format('revoke all on function %s from authenticated', r.sig);
    elsif r.proname = 'intel_is_authorized_user' then
      execute format('revoke all on function %s from authenticated', r.sig);   -- service_role only (kept from the Zoho migration)
    else
      execute format('grant execute on function %s to authenticated', r.sig);
    end if;
  end loop;
end $$;

commit;

-- Rollback (manual, only if nothing depends on it):
--   drop function if exists public.intel_agent_chat_tool(uuid, bigint, text, jsonb), public.intel_agent_chat_reply(uuid, bigint, text, text),
--     public.intel_agent_chat_context(uuid, bigint, int), public.intel_admin_chat_send(uuid, text, text), public.intel_admin_chat_new_thread(text),
--     public.intel_admin_crm_adopt(uuid[], text), public.intel_admin_crm_review(int), public._intel_crm_adopt(uuid, uuid[], text, text),
--     public._intel_crm_review(uuid, int, uuid[]), public._intel_jint(jsonb, text, int, int, int), public._intel_juuid(jsonb, text), public._intel_juuids(jsonb, text, int);
--   drop table if exists public.intel_chat_messages, public.intel_chat_threads;
