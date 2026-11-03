-- KairFlow Intelligence: CRM attribution, server-side duplicate detection, notification dedupe.
-- Additive. Existing lead rows keep their data (new columns default to 'manual' / NULL;
-- nothing is back-filled or invented). Safe to run more than once.
begin;

-- 1. Attribution columns on leads ---------------------------------------------------------------
alter table public.leads add column if not exists source_kind text not null default 'manual';
alter table public.leads add column if not exists intel_prospect_id uuid references public.intel_prospects(id) on delete set null;
alter table public.leads add column if not exists created_by uuid references auth.users(id) on delete set null;
alter table public.leads drop constraint if exists leads_source_kind_check;
alter table public.leads add constraint leads_source_kind_check check (source_kind in ('manual','ai_intelligence'));
create unique index if not exists leads_intel_prospect_uidx on public.leads(intel_prospect_id) where intel_prospect_id is not null;
create index if not exists leads_source_kind_idx on public.leads(source_kind) where source_kind <> 'manual';

-- 2. Attribution guard. Only the agent's resolve function (which sets intel.agent_write for the
--    current transaction) may create an 'ai_intelligence' lead. After creation the three columns
--    can NEVER change, whoever edits or reassigns the lead. Manual leads can never receive the marker.
create or replace function public._intel_lead_attribution_guard()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
declare v_agent boolean := coalesce(current_setting('intel.agent_write', true), '') = 'on';
begin
  if tg_op = 'INSERT' then
    if (new.source_kind = 'ai_intelligence' or new.intel_prospect_id is not null) and not v_agent then
      raise exception 'AI-generated attribution can only be set by KairFlow Intelligence' using errcode = '42501';
    end if;
    if new.source_kind = 'manual' and new.created_by is null then new.created_by := auth.uid(); end if;
    return new;
  end if;
  new.source_kind := old.source_kind;
  new.intel_prospect_id := old.intel_prospect_id;
  new.created_by := old.created_by;
  return new;
end $$;
drop trigger if exists leads_intel_attribution_guard on public.leads;
create trigger leads_intel_attribution_guard before insert or update on public.leads
  for each row execute function public._intel_lead_attribution_guard();

-- 3. Duplicate-detection primitives: a faithful SQL port of src/App.jsx normalizeCompanyName /
--    normalizeWebsite / normalizeEmailStr / findPossibleDuplicates. Keep them in lockstep
--    (src/intelligence/duplicates.parity.test.mjs checks the JS side against shared fixtures).
create or replace function public.intel_norm_company(p text) returns text language sql immutable as $$
  select regexp_replace(
           regexp_replace(
             regexp_replace(lower(coalesce(p, '')), '[.,]', '', 'g'),
             '\m(ltd|llc|inc|studio|studios|games|co|corp|company)\M', '', 'g'),
           '[^a-z0-9]+', '', 'g')
$$;
create or replace function public.intel_norm_website(p text) returns text language sql immutable as $$
  select regexp_replace(regexp_replace(regexp_replace(lower(btrim(coalesce(p, ''))), '^https?://', ''), '^www\.', ''), '/+$', '')
$$;
create or replace function public.intel_norm_email(p text) returns text language sql immutable as $$
  select lower(btrim(coalesce(p, '')))
$$;
create or replace function public.intel_domain_of(p text) returns text language sql immutable as $$
  select regexp_replace(split_part(public.intel_norm_website(p), '/', 1), ':[0-9]+$', '')
$$;

create or replace function public.intel_is_agent() returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select auth.uid() is not null and exists (select 1 from public.intel_settings s where s.agent_user_id = auth.uid())
$$;

-- Same confidence levels as the UI: very_high (email or website match, or company + contact),
-- high (company only), medium (prefix, >= 4 chars). Scope: leads owned by p_owner.
-- Callable by that owner, the Intelligence administrator, or the agent identity.
create or replace function public.crm_find_lead_duplicates(
  p_owner uuid, p_company text, p_website text, p_email text, p_contact text, p_exclude uuid default null)
returns table(lead_id uuid, confidence text, reason text)
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  v_email text := public.intel_norm_email(p_email);
  v_site text := public.intel_norm_website(p_website);
  v_comp text := public.intel_norm_company(p_company);
  v_contact text := lower(btrim(coalesce(p_contact, '')));
begin
  if auth.uid() is distinct from p_owner and not public.intel_is_authorized() and not public.intel_is_agent() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
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

-- 4. Notifications. KairFlow's bell reads activity_log rows (event_type allowlist in
--    src/notifications/logic.js). Intelligence reuses it: one row per event, de-duplicated by a
--    stable key (the Zoho message id), so re-syncing an inbox can never notify twice.
create unique index if not exists activity_log_intel_dedupe_uidx
  on public.activity_log (user_id, event_type, ((meta ->> 'intelDedupeKey')))
  where meta ? 'intelDedupeKey';

create or replace function public._intel_notify(
  p_org uuid, p_event text, p_title text, p_body text,
  p_lead uuid, p_prospect uuid, p_message uuid, p_dedupe text)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_owner uuid;
begin
  select owner_user_id into v_owner from public.intel_settings where organization_id = p_org;
  if v_owner is null then return; end if;
  insert into public.activity_log (user_id, project_id, event_type, description, meta)
  values (v_owner, null, p_event, left(coalesce(p_body, ''), 500),
          jsonb_strip_nulls(jsonb_build_object(
            'source', 'intelligence', 'title', left(p_title, 140),
            'leadId', p_lead, 'conversationId', p_prospect, 'messageId', p_message,
            'intelDedupeKey', p_dedupe)))
  on conflict (user_id, event_type, ((meta ->> 'intelDedupeKey'))) where meta ? 'intelDedupeKey' do nothing;
end $$;

create or replace function public._intel_log(p_org uuid, p_actor text, p_action text, p_type text, p_id text, p_detail jsonb)
returns void language sql security definer set search_path = pg_catalog, public as $$
  insert into public.intel_actions(organization_id, actor, actor_user_id, action, entity_type, entity_id, detail)
  values (p_org, p_actor, auth.uid(), p_action, coalesce(p_type, ''), coalesce(p_id, ''), coalesce(p_detail, '{}'::jsonb))
$$;

create or replace function public.intel_business_days_between(p_from date, p_to date) returns int
language sql immutable as $$
  select count(*)::int from generate_series(1, greatest(p_to - p_from, 0)) g
   where extract(isodow from (p_from + g)) < 6
$$;

commit;
