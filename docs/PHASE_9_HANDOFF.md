# KairFlow Intelligence — Phase 9 Handoff

**Phase:** 9 — Fix discovery source-registry enforcement  
**Status:** Implemented locally; automated suites pass.  
**Disposition:** Ready for reviewed staging migration and source-policy verification. No deployment or live discovery was performed.

## 1. Objective

Ensure every discovery pathway respects source enablement, administrator-managed campaign terms, daily budgets and source compliance. Close the legacy Steam/itch indie discovery path that previously invoked adapters directly from campaign criteria.

## 2. What was inspected

- `intelligence-worker/kairflow_intel/jobs.py`
- `intelligence-worker/kairflow_intel/sources.py`
- `intelligence-worker/kairflow_intel/discovery.py`
- `intelligence-worker/kairflow_intel/siteanalysis.py`
- `intelligence-worker/tests/test_discovery.py`
- `intelligence-worker/tests/test_v1.py`
- `supabase/migrations/20261109170000_intelligence_discovery.sql`
- Existing source registry, campaign criteria and worker RPC authorization.

## 3. Changes

### A. Steam/itch discovery now fails closed

- Removed the implicit default source list from the indie discovery execution path. Campaign criteria must explicitly contain a source list and configured keywords.
- The organization-scoped `intel_agent_sources` registry determines which sources may run. A source omitted because it is disabled, terms-unconfirmed, over budget or circuit-open cannot be used.
- Steam and itch are independently checked against the registry. An unapproved or unavailable source is never called simply because it appears in campaign criteria.
- Added a metered fetch wrapper. Every Steam search request, Steam app-details request and itch tag-page request atomically reserves one unit from the relevant source budget immediately before network access.
- A denied reservation raises a permanent fail-closed condition inside the adapter; no request is made.

### B. Other discovery paths verified and tightened

- Administrator-seeded discovery URLs now require the `site_crawler` source to be available and reserve one unit per fetch.
- Site analysis now wraps the Fetcher so homepage, sitemap, recruitment-page and portfolio-page requests each reserve `site_crawler` budget before network access. Removed the previous approximate three-unit reservation and the unrelated per-credit-candidate charge.
- Existing Wikidata, AniList, GDELT, RSS and Common Crawl paths continue to reserve against their own registry keys. GDELT continues to require an approved discovery profile. Manual posts remain administrator-supplied and do not fetch X.

### C. Atomic source-budget RPC

Added `20261129100000_intelligence_phase9_source_registry_enforcement.sql`.

- `intel_agent_source_use` now atomically reserves the requested positive number of units only when the source belongs to the authenticated agent's organization, is enabled, has confirmed terms, has a closed circuit and has sufficient remaining daily budget.
- Daily usage resets atomically when the organization-local day changes.
- The RPC returns `1` for a successful reservation and `0` for denial. This avoids the previous edge case where consuming the final budget unit returned zero and was misread by callers as a failed reservation.
- Execution is granted to `authenticated`, matching the worker's documented agent-user JWT model; it is not granted to `service_role` as a substitute for agent identity.

## 4. Files changed

- `intelligence-worker/kairflow_intel/jobs.py`
- `intelligence-worker/kairflow_intel/sources.py`
- `intelligence-worker/kairflow_intel/discovery.py`
- `intelligence-worker/kairflow_intel/siteanalysis.py`
- `intelligence-worker/tests/test_discovery.py`
- `intelligence-worker/tests/test_v1.py`
- `supabase/migrations/20261129100000_intelligence_phase9_source_registry_enforcement.sql`
- `docs/PHASE_9_HANDOFF.md`

## 5. Verification

- Full Python worker suite: **439 passed, 0 failed**.
- Full JavaScript suite (`npm test`): **797 passed, 0 failed**.
- Python compilation: passed.
- SQL source structure checks: passed (balanced dollar quoting, one transaction begin/commit, authenticated execution grant).
- ZIP integrity: checked after packaging.

Regression tests cover registry source filtering, per-request budget reservation, denied-reservation no-network behavior, fail-closed handling when registry or campaign terms are absent, and SQL budget conditions. Existing discovery and worker tests continue to pass.

## 6. Important operating constraints

- Steam and itch remain disabled/unverified by default in the source registry. This phase does not enable them or assert their terms have been accepted.
- They run only after an administrator separately enables the source and confirms its terms, and the campaign has explicit sources and keywords.
- No live discovery API calls were made. No database migration was executed; SQL was source-reviewed and contract-tested, not run on PostgreSQL. Transactional concurrency must still be confirmed in a disposable/staging database.
- The source-registry RPC's new `1`/`0` result contract is consumed by the worker's existing boolean reservation checks. No UI depends on the prior remaining-budget integer result.

## 7. Architecture and safety confirmation

- Dynamic Gmail/Zoho Mail/SMTP multi-adapter outreach remains authoritative.
- Zoho prospect outreach remains human-approved.
- Resend remains excluded from prospect communication.
- No provider activation, credential change, mailbox connection, worker restart, deployment, Git push, autonomy change, production DB modification, or real email sending occurred.

## 8. Stop condition

**Phase 9 implementation is complete locally. Stop here.** Phase 10 — schema, migrations and email-provider integration — is the next roadmap phase and requires separate authorization.
