-- KairFlow Intelligence: autonomous discovery. ADDITIVE ONLY. Requires the earlier Intelligence migrations (through 20261109160000). Safe to run twice.
--   * intel_sources         registry of discovery sources with terms-of-use status, budgets and health (circuit breaker)
--   * intel_source_items    every page/post/news item discovery found, linked to a prospect when there is one
--   * intel_entity_aliases  name/domain aliases so one studio found under several names stays ONE prospect
--   * discovery profile     stored in intel_campaigns.criteria.profile; the agent uses only terms YOU approved
-- Sources whose terms have not been confirmed by the administrator never run.
begin;

-- 1. Job kinds -------------------------------------------------------------------------------------
alter table public.intel_jobs drop constraint if exists intel_jobs_kind_check;
alter table public.intel_jobs add constraint intel_jobs_kind_check check (kind in
  ('discover','research','qualify','resolve','draft','send','sync_mail','classify','reconcile','followup_scan','retention','chat',
   'seed_sources','analyze_site','news_scan','feed_poll','crawl_index','manual_post','profile_terms'));
-- ('chat' comes from 20261109140000_intelligence_v1_completion.sql. This list is the union of both; keep it so if you edit it.)

-- 2. Tables ----------------------------------------------------------------------------------------
create table if not exists public.intel_sources (
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  key text not null check (key in ('wikidata','anilist','gdelt','commoncrawl','site_crawler','rss','steam','itch','x_manual')),
  label text not null,
  enabled boolean not null default false,
  tos_status text not null default 'unverified' check (tos_status in ('confirmed','unverified','excluded')),
  tos_note text not null default '',
  daily_budget int not null default 200 check (daily_budget between 0 and 100000),
  used_on date,
  used_today int not null default 0,
  consecutive_failures int not null default 0,
  circuit_open_until timestamptz,
  last_ok_at timestamptz,
  last_error text not null default '',
  updated_at timestamptz not null default now(),
  primary key (organization_id, key)
);

create table if not exists public.intel_source_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  source_key text not null,
  item_type text not null check (item_type in ('studio_entity','recruit_page','news','feed','feed_entry','manual_post','credit_link')),
  url text not null default '',
  url_hash text not null,
  title text not null default '' check (char_length(title) <= 300),
  snippet text not null default '' check (char_length(snippet) <= 600),
  language text not null default '',
  prospect_id uuid references public.intel_prospects(id) on delete set null,
  meta jsonb not null default '{}'::jsonb,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  unique (organization_id, url_hash)
);
create index if not exists intel_source_items_prospect_idx on public.intel_source_items(prospect_id);
create index if not exists intel_source_items_seen_idx on public.intel_source_items(organization_id, source_key, last_seen desc);

create table if not exists public.intel_entity_aliases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  prospect_id uuid not null references public.intel_prospects(id) on delete cascade,
  kind text not null check (kind in ('name','domain')),
  value text not null check (value = lower(value) and char_length(value) between 2 and 200),
  created_at timestamptz not null default now(),
  unique (organization_id, kind, value)
);

do $$
declare t text;
begin
  foreach t in array array['intel_sources','intel_source_items','intel_entity_aliases'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists intel_select on public.%I', t);
    execute format('create policy intel_select on public.%I for select to authenticated using (public.intel_is_authorized(organization_id))', t);
  end loop;
end $$;

-- 3. Default sources. Only Wikidata (CC0, documented policy) and the robots-respecting site crawler / feed reader start
--    confirmed. Everything else stays OFF until the administrator has read its terms and confirmed it.
create or replace function public._intel_seed_sources(p_org uuid) returns void
language sql security definer set search_path = pg_catalog, public as $$
  insert into public.intel_sources(organization_id, key, label, enabled, tos_status, tos_note, daily_budget) values
    (p_org, 'wikidata',    'Wikidata: studios with official websites', true,  'confirmed',  'CC0 data. Query service policy: descriptive User-Agent, 60 s timeout.', 40),
    (p_org, 'site_crawler','Studio sites: sitemaps, recruit pages, credits', true, 'confirmed', 'Public pages only, robots.txt respected, 2 s between requests per host.', 600),
    (p_org, 'rss',         'RSS / Atom feeds found on studio sites',   true,  'confirmed',  'Feeds the sites publish themselves.', 300),
    (p_org, 'x_manual',    'X posts you paste in (manual assist)',      true,  'confirmed',  'Nothing is fetched from X. You paste a post; the agent investigates the studio it names.', 200),
    (p_org, 'anilist',     'AniList: studios on current productions',   false, 'unverified', 'Free GraphQL API, about 90 requests/min. Read AniList''s terms (commercial use) before confirming.', 120),
    (p_org, 'gdelt',       'GDELT: news mentioning studios',            false, 'unverified', 'Keyless, about 1 request per 5 s. Confirm attribution/commercial terms at gdeltproject.org before confirming.', 150),
    (p_org, 'commoncrawl', 'Common Crawl: recruit pages on known domains', false, 'unverified', 'Free monthly crawl index. Read Common Crawl''s terms of use before confirming.', 300),
    (p_org, 'steam',       'Steam (indie game track)',                  false, 'unverified', 'Unofficial public storefront endpoints. Confirm Valve''s terms before enabling.', 300),
    (p_org, 'itch',        'itch.io (indie game track)',                false, 'unverified', 'Public browse pages. Confirm itch.io terms and robots rules before enabling.', 200)
  on conflict (organization_id, key) do nothing
$$;
create or replace function public._intel_seed_sources_trg() returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin perform public._intel_seed_sources(new.organization_id); return new; end $$;
drop trigger if exists intel_settings_seed_sources on public.intel_settings;
create trigger intel_settings_seed_sources after insert on public.intel_settings for each row execute function public._intel_seed_sources_trg();
select public._intel_seed_sources(organization_id) from public.intel_settings;   -- orgs that already finished setup

-- 4. Administrator functions -----------------------------------------------------------------------
create or replace function public.intel_admin_update_source(p_key text, p_enabled boolean default null, p_tos_status text default null, p_daily_budget int default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_admin_org(); s public.intel_sources;
begin
  select * into s from public.intel_sources where organization_id = v_org and key = p_key for update;
  if not found then raise exception 'unknown source'; end if;
  if p_tos_status is not null and p_tos_status not in ('confirmed','unverified','excluded') then raise exception 'bad terms status'; end if;
  if coalesce(p_tos_status, s.tos_status) <> 'confirmed' and coalesce(p_enabled, s.enabled) then
    raise exception 'Confirm the source''s terms before enabling it';
  end if;
  update public.intel_sources set enabled = coalesce(p_enabled, enabled), tos_status = coalesce(p_tos_status, tos_status),
         daily_budget = coalesce(p_daily_budget, daily_budget),
         consecutive_failures = case when p_enabled is true then 0 else consecutive_failures end,
         circuit_open_until = case when p_enabled is true then null else circuit_open_until end, updated_at = now()
   where organization_id = v_org and key = p_key;
  perform public._intel_log(v_org, 'admin', 'update_source', 'source', p_key, jsonb_build_object('enabled', p_enabled, 'tos', p_tos_status, 'budget', p_daily_budget));
  return to_jsonb((select x from public.intel_sources x where x.organization_id = v_org and x.key = p_key));
end $$;

-- Discovery profile: what you want, in your words. Terms are PROPOSED by the model (or typed by you) and used only after you approve.
create or replace function public.intel_admin_set_profile(p_type text, p_description text, p_terms_en jsonb, p_terms_ja jsonb, p_exclude jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_admin_org(); c public.intel_campaigns; v_old jsonb;
begin
  select * into c from public.intel_campaigns where organization_id = v_org and type = p_type for update;
  if not found then raise exception 'unknown campaign'; end if;
  v_old := coalesce(c.criteria -> 'profile', '{}'::jsonb);
  if jsonb_typeof(coalesce(p_terms_en, '[]'::jsonb)) <> 'array' or jsonb_typeof(coalesce(p_terms_ja, '[]'::jsonb)) <> 'array' or jsonb_typeof(coalesce(p_exclude, '[]'::jsonb)) <> 'array' then
    raise exception 'terms must be lists';
  end if;
  update public.intel_campaigns set criteria = criteria || jsonb_build_object('profile', jsonb_build_object(
      'description', left(coalesce(p_description, ''), 2000), 'terms_en', coalesce(p_terms_en, '[]'::jsonb), 'terms_ja', coalesce(p_terms_ja, '[]'::jsonb),
      'exclude', coalesce(p_exclude, '[]'::jsonb), 'approved', false)), updated_at = now()
   where id = c.id;
  perform public._intel_log(v_org, 'admin', 'set_profile', 'campaign', p_type, '{}'::jsonb);
  return (select criteria -> 'profile' from public.intel_campaigns where id = c.id);
end $$;

create or replace function public.intel_admin_approve_profile(p_type text, p_approved boolean) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_admin_org();
begin
  update public.intel_campaigns
     set criteria = jsonb_set(criteria, '{profile,approved}', to_jsonb(p_approved), true), updated_at = now()
   where organization_id = v_org and type = p_type and criteria ? 'profile';
  if not found then raise exception 'save the profile first'; end if;
  perform public._intel_log(v_org, 'admin', case when p_approved then 'approve_profile' else 'unapprove_profile' end, 'campaign', p_type, '{}'::jsonb);
  return (select criteria -> 'profile' from public.intel_campaigns where organization_id = v_org and type = p_type);
end $$;

-- Optional manual assist for sources that cannot be read automatically (e.g. an X post you found).
create or replace function public.intel_admin_add_manual_post(p_type text, p_url text, p_text text) returns uuid
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_admin_org(); v_id uuid; v_hash text;
begin
  if p_type not in ('indie_game_developer','animation_studio_support') then raise exception 'bad type'; end if;
  if btrim(coalesce(p_text, '')) = '' and btrim(coalesce(p_url, '')) = '' then raise exception 'paste a post URL or its text'; end if;
  v_hash := md5(coalesce(nullif(btrim(p_url), ''), p_text));
  insert into public.intel_source_items(organization_id, source_key, item_type, url, url_hash, title, snippet, meta)
  values (v_org, 'x_manual', 'manual_post', left(coalesce(p_url, ''), 500), v_hash, '', left(coalesce(p_text, ''), 600), jsonb_build_object('type', p_type, 'text', left(coalesce(p_text, ''), 4000)))
  on conflict (organization_id, url_hash) do update set last_seen = now() returning id into v_id;
  insert into public.intel_jobs(organization_id, kind, payload, idempotency_key)
  values (v_org, 'manual_post', jsonb_build_object('item_id', v_id, 'type', p_type), 'manual_post:' || v_id::text || ':' || floor(extract(epoch from now()) / 60)::text)
  on conflict (organization_id, idempotency_key) do nothing;
  perform public._intel_log(v_org, 'admin', 'add_manual_post', 'source_item', v_id::text, '{}'::jsonb);
  return v_id;
end $$;

create or replace function public.intel_admin_discovery_stats() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_admin_org();
begin
  return jsonb_build_object(
    'items_by_source', coalesce((select jsonb_object_agg(source_key, n) from (select source_key, count(*) n from public.intel_source_items where organization_id = v_org group by 1) x), '{}'::jsonb),
    'items_by_type', coalesce((select jsonb_object_agg(item_type, n) from (select item_type, count(*) n from public.intel_source_items where organization_id = v_org group by 1) x), '{}'::jsonb),
    'prospects', (select count(*) from public.intel_prospects where organization_id = v_org),
    'with_website', (select count(*) from public.intel_prospects where organization_id = v_org and website <> ''),
    'with_contact', (select count(*) from public.intel_prospects where organization_id = v_org and contact_email <> ''),
    'with_recruit_evidence', (select count(distinct prospect_id) from public.intel_source_items where organization_id = v_org and item_type in ('recruit_page','feed_entry','manual_post') and prospect_id is not null),
    'qualified_or_beyond', (select count(*) from public.intel_prospects where organization_id = v_org and status in ('qualified','lead_linked','contacted','replied')),
    'new_last_7_days', (select count(*) from public.intel_prospects where organization_id = v_org and created_at > now() - interval '7 days'));
end $$;

-- 5. Agent functions ---------------------------------------------------------------------------------
-- Sources the worker may use right now: enabled, terms confirmed, circuit closed, budget left.
create or replace function public.intel_agent_sources() returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org(); v_today date := public._intel_today(v_org);
begin
  update public.intel_sources set used_today = 0, used_on = v_today where organization_id = v_org and used_on is distinct from v_today;
  return coalesce((select jsonb_object_agg(key, jsonb_build_object('remaining', greatest(daily_budget - used_today, 0)))
                     from public.intel_sources
                    where organization_id = v_org and enabled and tos_status = 'confirmed' and (circuit_open_until is null or circuit_open_until <= now())
                      and used_today < daily_budget), '{}'::jsonb);
end $$;

create or replace function public.intel_agent_source_use(p_key text, p_n int default 1) returns int
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org(); v int;
begin
  update public.intel_sources set used_today = used_today + greatest(p_n, 0), used_on = coalesce(used_on, public._intel_today(v_org))
   where organization_id = v_org and key = p_key and enabled and tos_status = 'confirmed'
   returning greatest(daily_budget - used_today, 0) into v;
  return coalesce(v, 0);
end $$;

-- Circuit breaker: 5 failures in a row opens the circuit for 1 hour, doubling each time (max 24 h). A success closes it.
create or replace function public.intel_agent_source_report(p_key text, p_ok boolean, p_error text default '') returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org();
begin
  if p_ok then
    update public.intel_sources set consecutive_failures = 0, circuit_open_until = null, last_ok_at = now(), last_error = '' where organization_id = v_org and key = p_key;
  else
    update public.intel_sources
       set consecutive_failures = consecutive_failures + 1, last_error = left(coalesce(p_error, ''), 300),
           circuit_open_until = case when consecutive_failures + 1 >= 5
             then now() + make_interval(hours => least(24, 1 << least((consecutive_failures + 1 - 5) / 5, 4))) else circuit_open_until end
     where organization_id = v_org and key = p_key;
  end if;
end $$;

create or replace function public.intel_agent_record_item(p_source text, p_type text, p_url text, p_title text, p_snippet text, p_language text, p_prospect_id uuid, p_meta jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org(); v_id uuid; v_new boolean;
begin
  if p_prospect_id is not null and not exists (select 1 from public.intel_prospects where id = p_prospect_id and organization_id = v_org) then raise exception 'prospect not found'; end if;
  insert into public.intel_source_items(organization_id, source_key, item_type, url, url_hash, title, snippet, language, prospect_id, meta)
  values (v_org, left(p_source, 40), p_type, left(coalesce(p_url, ''), 500), md5(coalesce(nullif(p_url, ''), p_source || coalesce(p_title, '') || coalesce(p_snippet, ''))),
          left(coalesce(p_title, ''), 300), left(coalesce(p_snippet, ''), 600), left(coalesce(p_language, ''), 12), p_prospect_id, coalesce(p_meta, '{}'::jsonb))
  on conflict (organization_id, url_hash) do update set last_seen = now(), prospect_id = coalesce(public.intel_source_items.prospect_id, excluded.prospect_id)
  returning id, (xmax = 0) into v_id, v_new;
  return jsonb_build_object('item_id', v_id, 'new', v_new);
end $$;

-- Entity resolution: one studio under several names/domains stays ONE prospect.
create or replace function public.intel_agent_resolve_entity(p_domain text, p_name_norm text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org(); v_id uuid; v_how text;
begin
  if coalesce(p_domain, '') <> '' then
    select id into v_id from public.intel_prospects where organization_id = v_org and domain = lower(p_domain);
    if v_id is not null then return jsonb_build_object('prospect_id', v_id, 'match', 'domain'); end if;
    select prospect_id into v_id from public.intel_entity_aliases where organization_id = v_org and kind = 'domain' and value = lower(p_domain);
    if v_id is not null then return jsonb_build_object('prospect_id', v_id, 'match', 'domain_alias'); end if;
  end if;
  if coalesce(p_name_norm, '') <> '' and char_length(p_name_norm) >= 3 then
    select prospect_id into v_id from public.intel_entity_aliases where organization_id = v_org and kind = 'name' and value = lower(p_name_norm);
    if v_id is not null then return jsonb_build_object('prospect_id', v_id, 'match', 'name'); end if;
  end if;
  return jsonb_build_object('prospect_id', null, 'match', null);
end $$;

create or replace function public.intel_agent_add_alias(p_prospect_id uuid, p_kind text, p_value text) returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org(); v text := lower(btrim(coalesce(p_value, '')));
begin
  if char_length(v) < 2 or p_kind not in ('name','domain') then return; end if;
  if not exists (select 1 from public.intel_prospects where id = p_prospect_id and organization_id = v_org) then raise exception 'prospect not found'; end if;
  insert into public.intel_entity_aliases(organization_id, prospect_id, kind, value) values (v_org, p_prospect_id, p_kind, left(v, 200)) on conflict do nothing;
end $$;

-- Prospect that needs a person's attention because discovery could not finish it (e.g. no website found).
create or replace function public.intel_agent_flag_prospect(p_prospect_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org();
begin
  update public.intel_prospects set status = case when status in ('discovered','researched') then 'needs_review' else status end,
         review_reason = left(coalesce(p_reason, ''), 300), updated_at = now()
   where id = p_prospect_id and organization_id = v_org;
end $$;

-- Proposed terms (from the local model) are stored UNAPPROVED; adapters that need terms wait for the administrator.
create or replace function public.intel_agent_propose_terms(p_type text, p_terms_en jsonb, p_terms_ja jsonb, p_exclude jsonb) returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org(); c public.intel_campaigns; prof jsonb;
begin
  select * into c from public.intel_campaigns where organization_id = v_org and type = p_type for update;
  if not found then raise exception 'unknown campaign'; end if;
  prof := coalesce(c.criteria -> 'profile', '{}'::jsonb);
  if coalesce((prof ->> 'approved')::boolean, false) then return; end if;     -- never overwrite approved terms
  update public.intel_campaigns set criteria = criteria || jsonb_build_object('profile', prof || jsonb_build_object(
      'proposed_en', coalesce(p_terms_en, '[]'::jsonb), 'proposed_ja', coalesce(p_terms_ja, '[]'::jsonb), 'proposed_exclude', coalesce(p_exclude, '[]'::jsonb))) where id = c.id;
end $$;

create or replace function public.intel_agent_item(p_item_id uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org();
begin
  return (select to_jsonb(i) from public.intel_source_items i where i.id = p_item_id and i.organization_id = v_org);
end $$;

create or replace function public.intel_agent_feeds(p_limit int default 40) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org();
begin
  return coalesce((select jsonb_agg(jsonb_build_object('item_id', i.id, 'url', i.url, 'prospect_id', i.prospect_id))
                     from (select * from public.intel_source_items where organization_id = v_org and item_type = 'feed' and prospect_id is not null order by last_seen limit greatest(1, least(p_limit, 200))) i), '[]'::jsonb);
end $$;

create or replace function public.intel_agent_known_domains(p_limit int default 100) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org();
begin
  return coalesce((select jsonb_agg(jsonb_build_object('prospect_id', p.id, 'domain', p.domain)) from (select id, domain from public.intel_prospects
                    where organization_id = v_org and domain <> '' and status not in ('suppressed','rejected') order by updated_at limit greatest(1, least(p_limit, 500))) p), '[]'::jsonb);
end $$;

-- Grants for everything new (same rule as before)
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and (p.proname like 'intel\_%' or p.proname like '\_intel\_%')
  loop
    execute format('revoke all on function %s from public, anon', r.sig);
    if r.proname like '\_intel\_%' then execute format('revoke all on function %s from authenticated', r.sig);
    else execute format('grant execute on function %s to authenticated', r.sig); end if;
  end loop;
end $$;

commit;
