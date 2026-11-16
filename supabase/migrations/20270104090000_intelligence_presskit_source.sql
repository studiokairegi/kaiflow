-- Indie Game Developers / Phase 5 follow-up: "presskit" discovery source. ADDITIVE ONLY. LOCAL FILE: NOT APPLIED to any database.
-- Requires 20261112170000_intelligence_kickstarter_manual_intake_v4.sql (the latest intel_sources key list before this file).
-- The source reads only administrator-listed press-kit URLs (campaign criteria.presskit_urls) through the robots-respecting fetcher.
-- It is registered DISABLED and UNVERIFIED: it never runs until an administrator confirms the terms and enables it.
-- Rollback: delete from public.intel_sources where key = 'presskit'; then restore the previous key check (list below without 'presskit').
begin;

alter table public.intel_sources drop constraint if exists intel_sources_key_check;
alter table public.intel_sources add constraint intel_sources_key_check
  check (key in ('wikidata','anilist','gdelt','commoncrawl','site_crawler','rss','steam','itch','x_manual','kickstarter','presskit'));

insert into public.intel_sources(organization_id, key, label, enabled, tos_status, tos_note, daily_budget)
select o.id, 'presskit', 'Game press kits (administrator-listed URLs)', false, 'unverified',
  'Reads only press-kit pages whose URLs the administrator lists in the campaign criteria. Robots and access rules are respected; nothing is crawled beyond the listed pages. Confirm each publisher''s terms before enabling. A press address is a press contact, not a verified business contact.', 50
from public.studio_organizations o
where exists (select 1 from public.intel_campaigns c where c.organization_id = o.id and c.type = 'indie_game_developer')
on conflict (organization_id, key) do update set
  enabled = false,
  tos_status = case when public.intel_sources.tos_status = 'excluded' then 'excluded' else 'unverified' end,
  tos_note = excluded.tos_note,
  updated_at = now();

commit;
