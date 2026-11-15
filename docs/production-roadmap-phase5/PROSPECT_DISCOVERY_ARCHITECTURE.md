# Prospect Discovery Architecture — Phase 5

Status: describes the code as it stands after Phase 5 changes, read from source on 13 Nov 2026. Nothing here was observed against live sources.

## Two campaigns, two paths

| | Indie game developers (primary) | Animation studios (secondary) |
|---|---|---|
| Entry | `jobs.h_discover` -> `sources.discover_batch` | `h_discover` -> `sources.discover` seeds; `h_seed_sources`; `h_news_scan`; `h_feed_poll`; `h_crawl_index`; `h_manual_post` |
| Sources | Steam store search and app pages, itch.io tag browse pages, Kickstarter by administrator entry only | Wikidata, AniList, GDELT news, RSS, Common Crawl index, administrator seed URLs and pasted posts |
| Unit of record | The project: one prospect per developer and game title | The organization: one prospect per registrable domain or normalized name |
| Dedupe | SQL canonical key in `intel_agent_upsert_prospect` | `intel_agent_resolve_entity` by domain, domain alias or normalized name, then aliases added |
| AI use | None in discovery. One narrow extraction in research | `discovery.news`, `discovery.manual_post`, `discovery.studio_profile`, `research.entity`; all quote-checked |

## Flow

```text
scheduler -> discover job (cursor, limit 25, source budget per request)
  -> candidate {name, website, meta{project_url, source_key, developer_identity_status ...}}
  -> protected-account filter -> upsert prospect (idempotent) -> record source item
  -> research job (one per stable signature, not per poll)
       fetch own site or store page via metered, robots-respecting Fetcher
       deterministic signals + dated events + identity mentions + visual CANDIDATES (unverified)
       optional model call: named contact and role only, kept only if quoted on the page
       contactability assessment, suppression lookup
       NEW Phase 5: research_report.build() -> facts.verified.research_report
  -> analyze_site -> qualify (deterministic scoring, advisory only report) -> resolve -> draft (human approval)
```

## Safeguards that decide, none of them AI

Source registry (enabled, `tos_status` confirmed, daily budget, circuit breaker), protected accounts, suppression and contactability, Kickstarter exclusion, approval before any send. The research report and the model never move these.

## Phase 5 changes

1. `kairflow_intel/research_report.py`: deterministic report per prospect, stored under `facts.verified.research_report`, rebuilt on each research run. No migration needed.
2. `research.research()` collects the evidence rows written in the run and builds the report. A report failure is recorded as `{"error": ...}` and never loses the research.
3. `h_discover` result now carries `by_source` and `duplicate_rate`, so yield per source is measurable from job results.

## Known limits

- Platform-only developers, mostly itch.io creators, have no website until research or a person finds one.
- The indie dedupe key is exact developer name plus title after case and whitespace folding only; see PROSPECT_RESEARCH_STANDARD section on duplicates and the handoff for the proposed fix.
