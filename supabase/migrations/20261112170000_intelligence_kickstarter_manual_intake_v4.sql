-- Indie Game Developers V2 / Phase 4: Kickstarter manual-only intake.
-- Kickstarter Terms (effective 2025-02-11) prohibit automated crawling/spidering and require prior written permission
-- for commercial use/reproduction of site content. This migration adds no Kickstarter fetcher or crawler.
begin;

-- Keep Kickstarter visible in source governance, but disabled and unverified. The manual intake below does not
-- reserve or make network requests against Kickstarter; this row is a gate for any future, separately authorized API.
alter table public.intel_sources drop constraint if exists intel_sources_key_check;
alter table public.intel_sources add constraint intel_sources_key_check
  check (key in ('wikidata','anilist','gdelt','commoncrawl','site_crawler','rss','steam','itch','x_manual','kickstarter'));
insert into public.intel_sources(organization_id, key, label, enabled, tos_status, tos_note, daily_budget)
select o.id, 'kickstarter', 'Kickstarter (manual intake only)', false, 'unverified',
  'Automated crawling/spidering is prohibited by Kickstarter Terms. Manual administrator-submitted URLs only, and prior written permission is required for commercial use of entered project information. Do not enable automated access unless written permission or a permitted official API method is documented and approved.', 0
from public.studio_organizations o
where exists (select 1 from public.intel_campaigns c where c.organization_id = o.id and c.type = 'indie_game_developer')
on conflict (organization_id, key) do update set
  enabled = false,
  tos_status = case when public.intel_sources.tos_status = 'excluded' then 'excluded' else 'unverified' end,
  tos_note = excluded.tos_note,
  updated_at = now();

-- Prevent an administrator from accidentally turning this manual-only source into an automated one.
create or replace function public.intel_admin_update_source(p_key text, p_enabled boolean default null, p_tos_status text default null, p_daily_budget int default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_admin_org(); s public.intel_sources;
begin
  select * into s from public.intel_sources where organization_id = v_org and key = p_key for update;
  if not found then raise exception 'unknown source'; end if;
  if p_key = 'kickstarter' and coalesce(p_enabled, s.enabled) is true then
    raise exception 'automated Kickstarter discovery is unavailable; use manual project intake until written permission and an authorized connector exist';
  end if;
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

-- Future organizations receive the same disabled/unverified Kickstarter row when their Intelligence settings are seeded.
create or replace function public._intel_seed_sources(p_org uuid) returns void
language sql security definer set search_path = pg_catalog, public as $$
  insert into public.intel_sources(organization_id, key, label, enabled, tos_status, tos_note, daily_budget) values
    (p_org, 'wikidata',    'Wikidata: studios with official websites', true,  'confirmed',  'CC0 data. Query service policy: descriptive User-Agent, 60 s timeout.', 40),
    (p_org, 'site_crawler','Studio sites: sitemaps, recruit pages, credits', true, 'confirmed', 'Public pages only, robots.txt respected, 2 s between requests per host.', 600),
    (p_org, 'rss',         'RSS / Atom feeds found on studio sites',   true,  'confirmed',  'Feeds the sites publish themselves.', 300),
    (p_org, 'x_manual',    'X posts you paste in (manual assist)',      true,  'confirmed',  'Nothing is fetched from X. You paste a post; the agent investigates the studio it names.', 200),
    (p_org, 'anilist',     'AniList: studios on current productions',   false, 'unverified', 'Free GraphQL API, about 90 requests/min. Read AniList terms before confirming.', 120),
    (p_org, 'gdelt',       'GDELT: news mentioning studios',            false, 'unverified', 'Confirm attribution/commercial terms before confirming.', 150),
    (p_org, 'commoncrawl', 'Common Crawl: recruit pages on known domains', false, 'unverified', 'Read Common Crawl terms before confirming.', 300),
    (p_org, 'steam',       'Steam (indie game track)',                  false, 'unverified', 'Confirm Valve terms before enabling.', 300),
    (p_org, 'itch',        'itch.io (indie game track)',                false, 'unverified', 'Confirm itch.io terms and robots rules before enabling.', 200),
    (p_org, 'kickstarter','Kickstarter (manual intake only)',           false, 'unverified', 'Automated crawling/spidering is prohibited by Kickstarter Terms. Manual administrator-submitted URLs only; prior written permission is required for commercial use, and separate authorization is required before automated access.', 0)
  on conflict (organization_id, key) do nothing
$$;

-- Admin submits the URL and metadata they personally observed. We persist the intake and enqueue the existing durable
-- manual_post job. No Kickstarter URL is fetched, parsed, crawled, or sent to an external search provider.
create or replace function public.intel_admin_add_kickstarter_project(
  p_url text, p_title text, p_creator text, p_developer text default '', p_website text default '', p_notes text default '',
  p_permission_reference text default '', p_permission_confirmed boolean default false
) returns uuid
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.intel_admin_org();
  v_id uuid;
  v_url text := btrim(coalesce(p_url, ''));
  v_title text := left(btrim(coalesce(p_title, '')), 200);
  v_creator text := left(btrim(coalesce(p_creator, '')), 160);
  v_developer text := left(btrim(coalesce(p_developer, '')), 160);
  v_website text := left(btrim(coalesce(p_website, '')), 300);
  v_permission_reference text := left(btrim(coalesce(p_permission_reference, '')), 200);
  v_meta jsonb;
begin
  if p_permission_confirmed is not true or v_permission_reference = '' then
    raise exception 'prior written permission for commercial use is required; provide an internal permission reference';
  end if;
  if not exists (select 1 from public.intel_campaigns c where c.organization_id = v_org and c.type = 'indie_game_developer') then
    raise exception 'Indie Game Developers campaign is not configured';
  end if;
  if exists (select 1 from public.intel_sources s where s.organization_id = v_org and s.key = 'kickstarter' and s.tos_status = 'excluded') then
    raise exception 'Kickstarter intake is excluded by administrator';
  end if;
  if v_url !~ '^https://(www\.)?kickstarter\.com/projects/[A-Za-z0-9_-]{1,100}/[A-Za-z0-9_-]{1,160}/?$' then
    raise exception 'use a canonical HTTPS Kickstarter project URL';
  end if;
  if v_title = '' or v_creator = '' then raise exception 'project title and creator name are required'; end if;
  if v_website <> '' and (v_website !~ '^https?://[^/[:space:]]+([/][^[:space:]]*)?$' or lower(v_website) ~ 'kickstarter\.com') then
    raise exception 'developer website must be a separate official HTTP(S) website';
  end if;
  v_url := regexp_replace(v_url, '^https://(www\.)?kickstarter\.com', 'https://www.kickstarter.com');
  v_url := regexp_replace(v_url, '/+$', '') || '/';
  v_meta := jsonb_build_object(
    'project_title', v_title,
    'creator_name', v_creator,
    'developer_name', v_developer,
    'developer_website', v_website,
    'admin_notes', left(btrim(coalesce(p_notes, '')), 600),
    'discovery_method', 'administrator_manual_url_import',
    'developer_identity_status', 'admin_attributed_unverified',
    'kickstarter_creator_role', 'unverified',
    'qualification_evidence_status', 'not_assessed',
    'permission_confirmed_by_admin', true,
    'permission_reference', v_permission_reference,
    'permission_recorded_at', now()
  );
  insert into public.intel_source_items(organization_id, source_key, item_type, url, url_hash, title, snippet, meta)
  values (v_org, 'kickstarter_manual', 'game_project', v_url, md5(v_url), v_title,
    left(btrim(coalesce(p_notes, '')), 600), v_meta)
  on conflict (organization_id, url_hash) do update set
    last_seen = now(), title = excluded.title, snippet = excluded.snippet,
    meta = coalesce(public.intel_source_items.meta, '{}'::jsonb) || excluded.meta
  returning id into v_id;
  insert into public.intel_jobs(organization_id, kind, payload, idempotency_key)
  values (v_org, 'manual_post', jsonb_build_object('item_id', v_id, 'type', 'indie_game_developer'),
    'kickstarter_manual:' || v_id::text || ':' || md5(v_meta::text))
  on conflict (organization_id, idempotency_key) do nothing;
  perform public._intel_log(v_org, 'admin', 'add_kickstarter_project', 'source_item', v_id::text,
    jsonb_build_object('discovery_method', 'manual_url_import'));
  return v_id;
end $$;

revoke all on function public.intel_admin_add_kickstarter_project(text,text,text,text,text,text,text,boolean) from public, anon;
grant execute on function public.intel_admin_add_kickstarter_project(text,text,text,text,text,text,text,boolean) to authenticated;

commit;
