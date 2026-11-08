# Phase 9 corrective bug-fix handoff

## Confirmed defects corrected

1. **Ordinary prospect research bypassed the source registry and budget.** `h_research` passed the raw Fetcher into `research.research`, allowing homepage and candidate-page requests without a `site_crawler` registry check or per-request reservation. It now requires `site_crawler` to be available and wraps every `fetch` with an atomic one-unit reservation before network access.
2. **Site analysis crashed when using its metered wrapper.** `siteanalysis.sitemap_urls` calls `fetcher.sitemaps`, but the Phase 9 local wrapper implemented only `fetch`. The wrapper is now the shared `safety.MeteredFetcher`, which implements both methods. Sitemap discovery (including the possible robots.txt lookup performed internally by the underlying Fetcher) reserves budget before delegation; each subsequent sitemap/page fetch is separately metered.
3. **Studio reevaluation bypassed source registry/budget.** Its recovery and research requests used the raw Fetcher. The reevaluation worker now checks `site_crawler` availability and meters each network fetch, including candidate website recovery, before calling the underlying safe Fetcher. If unavailable, the run is recorded for manual review rather than crawling.

## Correction to previous audit statement

The earlier statement that `_site_for()` made unmetered Wikidata lookups was incorrect. `_site_for()` calls `_use(d, "wikidata")` before each lookup. No change was made to that already-metered path.

## Validation

- Python unit tests: **442 passed**.
- Python compilation: passed.
- JavaScript tests: **797 passed, 0 failed**.
- Added regression tests verify that both `fetch` and `sitemaps` reserve before delegation, and that successful operations each reserve separately.
- Live-preflight diagnostics still show environment-dependent optional checks (Ollama/RPC signature probe); they are not production acceptance tests.

## Deployment boundary

No migration was applied. No provider was enabled, no live discovery or email sending was run, no worker restarted, no credentials or mailbox connected, and no production data/deployment changed. Staging SQL/concurrency acceptance and provider-event acquisition setup remain separate required steps.
