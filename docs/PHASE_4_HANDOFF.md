# KairFlow Intelligence — Phase 4 Handoff

**Date:** 8 November 2026  
**Phase:** 4 — Improve discovery of leads and suitable studios  
**Disposition:** Discovery expansion implemented; one pre-existing acceptance dependency remains explicitly deferred to Phase 9.

## 1. Objective

Expand discovery through independent public evidence of actual work, especially portfolios, published productions and production credits. Preserve the existing discovery sources, provenance, deduplication, quotas and compliance controls. Recruitment and outsourcing signals remain supplementary rather than a prerequisite for discovery.

## 2. What was inspected

- `intelligence-worker/kairflow_intel/discovery.py`
- `intelligence-worker/kairflow_intel/wikidata.py`
- `intelligence-worker/kairflow_intel/anilist.py`
- `intelligence-worker/kairflow_intel/commoncrawl.py`
- `intelligence-worker/kairflow_intel/siteanalysis.py`
- `intelligence-worker/kairflow_intel/profile.py`
- `intelligence-worker/kairflow_intel/jobs.py`
- `intelligence-worker/tests/test_discovery.py`
- Discovery source registry and item-recording definitions in `supabase/migrations/20261109170000_intelligence_discovery.sql`

## 3. What changed

- Expanded Wikidata's exact class-label matching to support English and Japanese labels. Labels are only used when they match an actual `rdfs:label` on a class; malformed or unsupported input cannot broaden the query.
- Added Japanese studio class-label candidates alongside English animation-studio and production-company labels.
- Expanded AniList studio discovery to include `FINISHED` anime, not only currently airing and not-yet-released titles. The source quota reservation was adjusted from two to three units for the additional status request.
- Expanded site portfolio/credit page discovery to recognize English and Japanese paths including works, portfolio, filmography, production, projects, 制作実績, 作品, クレジット and 参加作品.
- Kept the homepage credit scan and added sitemap-based selection of up to two dedicated portfolio/credit pages. This path is independent of recruitment-page selection.
- Expanded Common Crawl's archived-page query from recruitment-only paths to portfolio, published-work, production-credit and recruitment paths. Results remain associated with already-known domains and must still be checked against the live site.
- Expanded proposed English and Japanese studio discovery terms with portfolio, production-credit and production-company language. Terms remain proposals and are not used by GDELT until the administrator approves the discovery profile.
- Added regression tests for Japanese Wikidata labels, finished AniList productions, English/Japanese portfolio path selection, Common Crawl portfolio indexing and source-registry use.

## 4. Files modified

- `intelligence-worker/kairflow_intel/commoncrawl.py`
- `intelligence-worker/kairflow_intel/discovery.py`
- `intelligence-worker/kairflow_intel/profile.py`
- `intelligence-worker/kairflow_intel/siteanalysis.py`
- `intelligence-worker/kairflow_intel/wikidata.py`
- `intelligence-worker/tests/test_discovery.py`
- `docs/PHASE_4_HANDOFF.md`

## 5. Database migrations

None created or modified. Existing source registry, item provenance and database RPC contracts were preserved.

## 6. Verification

- Python compile check: passed.
- Discovery-focused Python tests: **31 passed**.
- Full Python worker suite: **407 passed, 0 failed**.
- JavaScript regression suite: **773 passed, 0 failed**.
- The full Python suite prints expected diagnostic output from mocked failure-path tests and environment preflight probes; the test runner exits successfully and reports `OK`.
- No live third-party discovery API calls were made as part of this verification.

## 7. Remaining defects, acceptance dependencies and boundaries

1. **Pre-existing indie Steam/itch source-registry bypass:** `jobs.h_discover` still has a legacy direct path for Steam/itch discovery that does not use the same source-registry enforcement as the `seed_sources` handlers. The roadmap explicitly assigns the indie discovery bypass and full source-registry enforcement to Phase 9. It was not silently pulled forward into Phase 4. Therefore the Phase 4 acceptance statement that no existing source controls can be bypassed is not fully satisfied until Phase 9.
2. **Live source validation:** no live Wikidata, AniList or Common Crawl run was performed. Terms, rate limits and actual coverage still require controlled validation before enabling those sources.
3. **Phase 3 production-quality gates remain outstanding as recorded in `PHASE_3_CORRECTIVE_HANDOFF.md`:** live Ollama output evaluation, native Japanese business-language review and the frontend production build. The Phase 3 automated corrective tests passed, but those external acceptance gates were not performed in this Phase 4 session.

## 8. Safety confirmation

- No deployment or Git push.
- No worker activation.
- No autonomy or kill-switch change.
- No provider activation.
- No real email sent.
- No database migration applied.
- No production database modified.
- Existing suppression, unsubscribe, human-approval and sending controls were not changed.

## 9. Next phase

**Phase 5 — Contactability and email verification.** Do not start automatically. Phase 4 should first be reviewed with the Phase 9 source-registry dependency clearly understood; the roadmap requires each phase to be reviewed and accepted before the next begins.
