-- Indie Game Developers V2 / Phase 3: project-first Steam and itch.io discovery.
-- Additive and safe to re-run. No source is enabled and no terms are auto-confirmed.
begin;

-- Keep one prospect per game project rather than one per developer-domain.
-- A developer may have several projects; publisher identity is stored separately in facts.
create or replace function public.intel_agent_upsert_prospect(
  p_type text, p_name text, p_website text, p_contact_name text, p_contact_email text,
  p_contact_source_url text, p_country text, p_language text, p_verified jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.intel_agent_org();
  v_domain text := public.intel_domain_of(p_website);
  v_key text;
  v_id uuid;
  v_new boolean := false;
  v_camp uuid;
  v_email text := public.intel_norm_email(p_contact_email);
  v_supp boolean := false;
  v_title text := nullif(btrim(coalesce(nullif(p_verified ->> 'project_title', ''), p_verified ->> 'game', '')), '');
begin
  if p_type not in ('indie_game_developer','animation_studio_support') then raise exception 'bad type'; end if;
  if btrim(coalesce(p_name, '')) = '' then raise exception 'name required'; end if;

  if p_type = 'indie_game_developer' and v_title is not null then
    -- The same developer/title pair deduplicates Steam and itch discoveries. This key is
    -- project-scoped, not publisher-scoped or developer-domain-scoped.
    v_key := 'project:' || md5(lower(regexp_replace(btrim(p_name), '\s+', ' ', 'g')) || '|' || lower(regexp_replace(btrim(v_title), '\s+', ' ', 'g')));
  elsif p_type = 'indie_game_developer' and coalesce(p_verified ->> 'steam_appid', '') ~ '^[0-9]+$' then
    v_key := 'project:steam:' || (p_verified ->> 'steam_appid');
  elsif p_type = 'indie_game_developer' and coalesce(p_verified ->> 'itch_project_id', '') <> '' then
    v_key := 'project:itch:' || md5(lower(p_verified ->> 'itch_project_id'));
  else
    v_key := case when v_domain <> '' then 'd:' || v_domain else 'n:' || public.intel_norm_company(p_name) end;
  end if;
  if v_key in ('d:', 'n:', 'project:') then raise exception 'cannot derive a canonical key'; end if;

  select id into v_camp from public.intel_campaigns where organization_id = v_org and type = p_type;
  v_supp := exists (select 1 from public.intel_suppressions x where x.organization_id = v_org and
    ((x.kind = 'email' and x.value = v_email and v_email <> '')
      or (x.kind = 'domain' and x.value = v_domain and v_domain <> '')
      or (x.kind = 'domain' and v_email like '%@' || x.value)));

  insert into public.intel_prospects(organization_id, campaign_id, type, canonical_key, name, website, domain, contact_name,
    contact_email, contact_source_url, country, language, facts, status)
  values (v_org, v_camp, p_type, v_key, left(p_name, 200), left(coalesce(p_website, ''), 300), v_domain,
    left(coalesce(p_contact_name, ''), 200), v_email, left(coalesce(p_contact_source_url, ''), 500),
    left(coalesce(p_country, ''), 80), left(coalesce(nullif(p_language, ''), 'en'), 12),
    case when p_type = 'indie_game_developer' then
      jsonb_build_object('verified', coalesce(p_verified, '{}'::jsonb) || jsonb_build_object(
        'project_source_urls', case when coalesce(p_verified ->> 'project_url', '') <> '' then jsonb_build_array(p_verified ->> 'project_url') else '[]'::jsonb end,
        'last_discovered_at', coalesce(p_verified ->> 'discovered_at', now()::text)), 'estimates', '{}'::jsonb)
      else jsonb_build_object('verified', coalesce(p_verified, '{}'::jsonb), 'estimates', '{}'::jsonb) end,
    case when v_supp then 'suppressed' else 'discovered' end)
  on conflict (organization_id, canonical_key) do update
    set website = case when p_type = 'indie_game_developer' and public.intel_prospects.website = '' then excluded.website else public.intel_prospects.website end,
        domain = case when p_type = 'indie_game_developer' and public.intel_prospects.domain = '' then excluded.domain else public.intel_prospects.domain end,
        contact_email = case when public.intel_prospects.contact_email = '' then excluded.contact_email else public.intel_prospects.contact_email end,
        contact_name = case when public.intel_prospects.contact_name = '' then excluded.contact_name else public.intel_prospects.contact_name end,
        contact_source_url = case when public.intel_prospects.contact_source_url = '' then excluded.contact_source_url else public.intel_prospects.contact_source_url end,
        facts = case when p_type = 'indie_game_developer' then
          jsonb_set(public.intel_prospects.facts, '{verified}',
            coalesce(public.intel_prospects.facts -> 'verified', '{}'::jsonb) || coalesce(p_verified, '{}'::jsonb) ||
            jsonb_build_object('discovered_at', coalesce(public.intel_prospects.facts #>> '{verified,discovered_at}', p_verified ->> 'discovered_at'),
              'last_discovered_at', coalesce(p_verified ->> 'discovered_at', now()::text), 'project_source_urls',
              case when coalesce(p_verified ->> 'project_url', '') <> ''
                and not (coalesce(public.intel_prospects.facts #> '{verified,project_source_urls}', '[]'::jsonb) @> jsonb_build_array(p_verified ->> 'project_url'))
                then coalesce(public.intel_prospects.facts #> '{verified,project_source_urls}', '[]'::jsonb) || jsonb_build_array(p_verified ->> 'project_url')
                else coalesce(public.intel_prospects.facts #> '{verified,project_source_urls}', '[]'::jsonb) end), true)
          else jsonb_set(public.intel_prospects.facts, '{verified}',
            coalesce(public.intel_prospects.facts -> 'verified', '{}'::jsonb) || coalesce(p_verified, '{}'::jsonb), true) end,
        updated_at = now()
  returning id, (xmax = 0) into v_id, v_new;

  if p_type = 'indie_game_developer' and v_supp then
    update public.intel_prospects set status = 'suppressed', review_reason = 'Existing email/domain suppression conflict'
      where id = v_id and organization_id = v_org and status not in ('lead_linked','contacted','replied','closed');
  end if;
  if p_type = 'indie_game_developer' and public._intel_is_protected_indie_entity(p_name, v_title) then
    update public.intel_prospects set status = 'rejected', review_reason = 'Protected Studio Kairegi account'
      where id = v_id and organization_id = v_org and status not in ('lead_linked','contacted','replied','closed');
  end if;
  return jsonb_build_object('prospect_id', v_id, 'created', v_new, 'suppressed', v_supp);
end $$;

-- Source items now distinguish game projects from studio entities. Every project URL
-- is retained independently, even when the same game is found on both platforms.
alter table public.intel_source_items drop constraint if exists intel_source_items_item_type_check;
alter table public.intel_source_items add constraint intel_source_items_item_type_check
  check (item_type in ('studio_entity','recruit_page','news','feed','feed_entry','manual_post','credit_link','game_project'));
create index if not exists intel_source_items_project_id_idx
  on public.intel_source_items(organization_id, (meta ->> 'project_id')) where item_type = 'game_project';

create or replace function public.intel_agent_record_item(p_source text, p_type text, p_url text, p_title text, p_snippet text,
  p_language text, p_prospect_id uuid, p_meta jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org(); v_id uuid; v_new boolean;
begin
  if p_prospect_id is not null and not exists (select 1 from public.intel_prospects where id = p_prospect_id and organization_id = v_org) then
    raise exception 'prospect not found';
  end if;
  insert into public.intel_source_items(organization_id, source_key, item_type, url, url_hash, title, snippet, language, prospect_id, meta)
  values (v_org, left(p_source, 40), p_type, left(coalesce(p_url, ''), 500),
    md5(coalesce(nullif(p_url, ''), p_source || coalesce(p_title, '') || coalesce(p_snippet, ''))),
    left(coalesce(p_title, ''), 300), left(coalesce(p_snippet, ''), 600), left(coalesce(p_language, ''), 12), p_prospect_id, coalesce(p_meta, '{}'::jsonb))
  on conflict (organization_id, url_hash) do update set
    last_seen = now(), prospect_id = coalesce(public.intel_source_items.prospect_id, excluded.prospect_id),
    title = case when excluded.item_type = 'game_project' and excluded.title <> '' then excluded.title else public.intel_source_items.title end,
    snippet = case when excluded.item_type = 'game_project' and excluded.snippet <> '' then excluded.snippet else public.intel_source_items.snippet end,
    language = case when excluded.item_type = 'game_project' and excluded.language <> '' then excluded.language else public.intel_source_items.language end,
    meta = case when excluded.item_type = 'game_project'
      then coalesce(public.intel_source_items.meta, '{}'::jsonb) || coalesce(excluded.meta, '{}'::jsonb)
      else public.intel_source_items.meta end
  returning id, (xmax = 0) into v_id, v_new;
  return jsonb_build_object('item_id', v_id, 'new', v_new);
end $$;

-- The access method changed, so force a fresh terms review. Preserve explicit administrator exclusions.
update public.intel_sources set
  enabled = false,
  tos_status = case when tos_status = 'excluded' then 'excluded' else 'unverified' end,
  label = case key when 'steam' then 'Steam public store discovery' when 'itch' then 'itch.io public browse discovery' else label end,
  tos_note = case key
    when 'steam' then 'Uses public Steam Store search and public app pages only; no login or private/partner API. Confirm current Valve terms and robots/access rules before enabling. Store search/page structures may change.'
    when 'itch' then 'Uses public indexed browse/tag pages only; robots and access rules must be respected. Confirm current itch.io terms before enabling; do not collect personal data beyond public project attribution.'
    else tos_note end,
  updated_at = now()
where key in ('steam','itch');

-- Broaden only the untouched seeded keyword list. Do not overwrite administrator-customized terms.
update public.intel_campaigns
set criteria = jsonb_set(criteria, '{keywords}',
  '["anime game","anime-inspired game","2d RPG","JRPG","pixel art RPG","action RPG","indie adventure","story-driven game","visual novel","upcoming PC game","indie game demo","early access game","game devlog","hand-drawn game","2d indie game"]'::jsonb, true)
where type = 'indie_game_developer'
  and criteria -> 'keywords' = '["2d","anime","hand-drawn","stylized","story rich","visual novel","pixel graphics"]'::jsonb;


-- Full agent-only source status is separate from intel_agent_sources(), which intentionally
-- returns only sources with remaining budget. Paginated discovery needs to distinguish an
-- exhausted daily budget from a disabled/unconfirmed source so it can retain the cursor.
create or replace function public.intel_agent_source_status() returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org(); v_today date := public._intel_today(v_org);
begin
  update public.intel_sources set used_today = 0, used_on = v_today
    where organization_id = v_org and used_on is distinct from v_today;
  return coalesce((select jsonb_object_agg(key, jsonb_build_object(
    'enabled', enabled,
    'tos_status', tos_status,
    'remaining', greatest(daily_budget - used_today, 0),
    'circuit_open', circuit_open_until is not null and circuit_open_until > now(),
    'retry_after_seconds', case when circuit_open_until is not null and circuit_open_until > now()
      then greatest(60, ceil(extract(epoch from (circuit_open_until - now())))::integer) else 0 end
  )) from public.intel_sources where organization_id = v_org), '{}'::jsonb);
end $$;

-- A daily initial scan must not race a queued continuation cursor. This lets the existing
-- durable intel_jobs queue carry the next page across worker restarts and source-budget resets.
create or replace function public.intel_agent_discovery_has_pending(p_type text) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select case when p_type <> 'indie_game_developer' then false else exists (
    select 1 from public.intel_jobs j
    where j.organization_id = public.intel_agent_org()
      and j.kind = 'discover'
      and j.state in ('queued', 'running')
      and j.payload ->> 'type' = p_type
      and j.payload ? 'cursor'
      and jsonb_typeof(j.payload -> 'cursor') = 'object'
      and j.payload -> 'cursor' <> '{}'::jsonb
  ) end
$$;

revoke all on function public.intel_agent_source_status() from public, anon;
grant execute on function public.intel_agent_source_status() to authenticated;
revoke all on function public.intel_agent_discovery_has_pending(text) from public, anon;
grant execute on function public.intel_agent_discovery_has_pending(text) to authenticated;

commit;
