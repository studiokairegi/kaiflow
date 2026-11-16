# PHASE 3 HANDOFF — Steam and Multi-Source Discovery Redesign

## 1. Phase objective

Expand Indie Game Developers candidate discovery while keeping discovery separate from final qualification. Steam and itch.io now produce project-level candidates with source provenance, pagination state, and conservative deduplication. Phase 2 qualification gates, contactability, suppression, protected-account checks, and human approval remain authoritative.

**Phase 3 implementation is complete in the delivered repository.** No production database or campaign was changed. The migration is authored but unapplied.

## 2. Work completed

### Steam discovery

- Removed the publisher/developer mismatch rejection. A project with a third-party publisher is retained; developer and publisher identities are stored separately.
- Replaced the old narrow storesearch/appdetails adapter with public Steam Store search HTML and public app-page extraction.
- Added bounded `start`/`count` pagination and resumable keyword/offset cursors.
- Extracts available title, developer(s), publisher(s), public project URL, app ID, release date, coming-soon state, genres/tags, description, public artwork, trailer indicator, and official website link when present.
- Keeps upcoming, unreleased, recent, and older released projects as candidates; later research and Phase 2 scoring decide whether there is a credible current marketing opportunity.
- Does not fabricate announcement dates, activity dates, or `recent_activity` signals.

### itch.io discovery

- Reworked newest/tag browse discovery to retain game project URLs and identifiers.
- Added ordinary `?page=` pagination, plus an offset cursor within a listing page so a large page can be consumed in bounded slices.
- Deduplicates by project URL, not creator profile. Several games by the same creator are now separate candidates.
- Stores creator name/profile as platform attribution with `developer_identity_status=platform_creator_unverified`; it does not assume that the campaign creator is the actual developer.
- Does not claim activity based on discovery or public listing visibility.
- Does not crawl restricted/unlisted pages or extract creator-profile contact details.

### Project-first storage and provenance

- Added resumable `discover_batch` processing for Indie campaigns. Each authorized source processes a bounded page/slice per job.
- Cursor continuation is persisted through the existing database-backed `intel_jobs` queue with deterministic cursor-derived idempotency keys. A time-bucket suffix lets the same cursor be re-enqueued for a later budget window without colliding with the currently running job. A new agent-only source-status RPC distinguishes disabled/unconfirmed sources from exhausted budgets and open circuits; budget/circuit holds retain the cursor without counting as source failures. A pending-cursor RPC prevents the daily initial scan from restarting while a continuation is queued or running. Transient fetch errors bubble up so the queue retries without advancing the cursor.
- Each discovered game is upserted using a project-scoped key based on normalized developer name + project title, rather than the developer website domain. Multiple projects from one developer are no longer collapsed by a shared domain.
- Same developer/title projects discovered on Steam and itch.io share a prospect; each source URL is retained in `intel_source_items` and in `project_source_urls`.
- Added the `game_project` source-item type. Source-item refresh merges current metadata and updates `last_seen` for game projects while preserving the pre-existing update behavior for non-game item types.
- Candidate metadata records source key, source URL, project URL, project ID, project title, developer/creator attribution, publisher identity when available, available evidence, and discovery timestamp.
- Existing Phase 2 prospect rows are not destructively merged or re-keyed. A historic developer-domain prospect can coexist with a new project-keyed prospect until a separately reviewed reconciliation process is designed.

### Search terms and source governance

- Broadened Indie starter terms to include anime games, anime-inspired games, 2D RPGs, JRPGs, pixel-art RPGs, action RPGs, indie adventures, story-driven games, visual novels, upcoming PC games, demos, early access, devlogs, and hand-drawn games, including Japanese terms.
- The migration updates the original seeded keyword list only when it is still exactly the untouched default; customized administrator keywords are preserved.
- The migration forces Steam and itch source rows to `enabled=false` and `tos_status='unverified'`, while preserving an explicit `excluded` status. The changed access methods therefore require a fresh administrator terms review before re-enabling.
- No additional automated platforms were enabled. Kickstarter remains Session 4.

## 3. Important architecture decisions

1. **Discovery is not qualification.** Steam/itch candidates do not receive anime-fit or active-development claims from discovery. Research and the Phase 2 `indie-project-v2` scorer remain responsible for evidence and qualification.
2. **Publisher and developer are separate.** A third-party publisher never disqualifies the developer and is not treated as a protected-account match by itself. Protected developer/project names remain excluded.
3. **Project is the prospect identity.** A developer can have several active projects; a shared website/domain is not a reason to merge those projects.
4. **itch creator attribution is unverified.** The public author label is a research lead, not proof of developer identity or business authority.
5. **Source provenance is persistent.** Every project retains its source key, project/source URL, project identifier, discovery timestamp, and available source metadata.
6. **Cursors live in the job queue.** No process-local cursor state is required. Existing lease, retry, and idempotency behavior provides restart recovery.
7. **Terms remain a gate.** The Phase 3 migration disables both sources and resets them to unverified until the administrator reviews the current access method and terms.
8. **Animation Studio Support is preserved.** The upsert and source-item migration branches project-specific behavior only for Indie Game Developers; non-Indie fact merging and source-item update behavior remain on their existing paths.

## 4. Files added, changed, or removed

### Added

- `docs/INDIE_GAME_DISCOVERY_V2.md`
- `supabase/migrations/20261112160000_intelligence_indie_project_discovery_v3.sql`
- `docs/indie-game-developers-v2/PHASE_3_HANDOFF.md` (this report; the pre-existing root-level `PHASE_3_HANDOFF.md` was preserved unchanged)

### Changed

- `intelligence-worker/kairflow_intel/sources.py`
- `intelligence-worker/kairflow_intel/jobs.py`
- `intelligence-worker/kairflow_intel/profile.py`
- `intelligence-worker/tests/test_discovery.py`
- `intelligence-worker/tests/test_logic.py`
- `intelligence-worker/tests/test_indie_qualification_v2.py`
- `intelligence-worker/tests/test_v1.py`

### Removed

- None.

## 5. Database migrations created

Created one additive migration:

- `supabase/migrations/20261112160000_intelligence_indie_project_discovery_v3.sql`

It:

- Replaces `intel_agent_upsert_prospect` with an Indie project-scoped canonical key while preserving the existing non-Indie keying and fact-merge behavior.
- Retains distinct project source URLs and discovery timestamps in Indie verified facts.
- Adds `game_project` to `intel_source_items.item_type` and adds a project-ID index.
- Updates `intel_agent_record_item` to refresh project-item metadata and `last_seen`, while retaining prior non-project item behavior.
- Adds agent-only `intel_agent_source_status` and `intel_agent_discovery_has_pending` RPCs for budget/circuit-aware cursor recovery and daily-scan suppression.
- Forces Steam and itch source rows off and back to unverified, preserving explicit exclusions.
- Broadens only the untouched seeded Indie keyword list.

**The migration has not been executed.** No database, staging or production, was modified.

**Migration ordering risk remains:** the repository contains later-dated migrations through December 2026. Reconcile the actual deployed Supabase migration ledger and repository ordering before applying. Apply in staging first.

## 6. Tests executed and exact results

| Test/check | Result |
|---|---:|
| Python unittest discovery (`python -m unittest discover -s tests -t . -q`) | **817 passed, 0 failed** |
| Python compile check (`python -m compileall -q kairflow_intel tests`) | **Passed** |
| Frontend/Node suite (`npm test`) | **1,123 passed, 0 failed** |
| ZIP integrity | **Passed** (see Artifact A verification at delivery) |

The Python suite includes new tests for third-party-published Steam games, Steam public HTML extraction/pagination, itch project-level deduplication and pagination, source registry budget reservations, persistent cursor return across budget/circuit holds, daily-scan suppression while a cursor is pending, transient retry behavior, protected publisher handling, and the new migration contract.

### Environment diagnostics (not unit-test failures)

The worker test run emits live preflight diagnostics in addition to the successful unit-test summary. One preflight pass reports Ollama structured-output/model availability failures and a `PGRST202` draft-RPC signature probe; a later autonomous-mode probe resolves the 11-argument signature without writing a record. Gemini quota/auth and AI-routing policy warnings also appear in the test logs. These are environment/integration warnings and should be checked against the deployed worker/database configuration.

## 7. Tests not executed and why

- PostgreSQL migration execution / trigger and RPC integration: no `psql`, Supabase CLI, or connected database is available in this environment.
- Frontend production build: `npm run build` was attempted but cannot run because `node_modules/vite/bin/vite.js` is absent. `npm test` works because it uses Node's built-in test runner.
- Live Steam and itch requests: deliberately not run. Their source rows are disabled/unverified, and the changed access methods require administrator terms/robots review first.
- Browser end-to-end discovery-to-research testing: no running application/browser environment was available.
- Production deployment and live campaign discovery: not attempted.

## 8. Known bugs and unresolved issues

1. Steam Store search and app-page HTML are public storefront pages, not a versioned documented discovery API. DOM selectors and pagination markers may change; parse failure yields no candidate rather than a guessed record.
2. Steam public search page access must be checked against current Valve terms and robots rules before enabling. The documented Steamworks Web API is separate from the Store HTML used here.
3. itch.io Terms of Service include restrictions concerning collecting information about others. The source remains disabled/unverified; administrator/legal review must confirm whether the narrow public project-metadata discovery use is permitted before enabling. This phase does not scrape creator contact details.
4. itch.io creator attribution does not prove that the account holder is the actual developer. Session 5 must verify the developer/studio and authorized contact.
5. Cross-source deduplication is conservative and based on normalized developer name + project title. Spelling/branding differences may result in duplicates; fuzzy merging is intentionally avoided.
6. Existing Phase 2 domain-keyed prospects are not automatically migrated to project keys. A historic row can coexist with a new project row pending safe reconciliation.
7. Steam public pages may omit developer/publisher names, release dates, or official links. Such missing values are not invented; candidates without a defensible developer identity are skipped.
8. itch browse visibility depends on public indexing and creator visibility settings. Restricted/unlisted projects are not discovered by this adapter.
9. No new external discovery source beyond Steam and itch.io was added. Additional sources require source-specific access/terms review.
10. Kickstarter remains unimplemented by design and is Session 4.
11. Database migration execution, production build, and end-to-end integration remain outstanding.

## 9. Security and safety considerations

- Uses the existing robots-respecting, bounded `Fetcher`; no authentication, CAPTCHAs, private APIs, proxy rotation, anti-bot bypass, or access-control circumvention was added.
- Every network request is reserved against the existing organization-scoped source registry. Existing budget and circuit-breaker controls remain active.
- Steam/itch are explicitly disabled and unverified by the migration until re-confirmed by an administrator.
- Candidate content is treated as untrusted data. Only bounded public project metadata is recorded; discovery does not draft or send email.
- Publisher name alone is not treated as a protected-account match. Protected developer and protected project names remain blocked in worker and database safeguards.
- Suppression, bounce, complaint, unsubscribe, contactability, qualification, and outbound gates from Phase 2 are unchanged.
- No credentials, `.env` secrets, provider tokens, private keys, or production data were added.
- No production data or sending state was changed.

## 10. Deployment or environment changes

- No new environment variables.
- No new dependencies.
- Apply the migration in a reviewed staging environment only after checking the actual Supabase migration ledger.
- Confirm service-role execution/grants for the existing `intel_agent_upsert_prospect` and `intel_agent_record_item` RPCs after migration.
- Review current Steam/itch terms and robots/access policies. Both source rows must remain disabled until administrator confirmation; the migration resets them to unverified.
- Begin with low source daily budgets and monitor parse success, source circuit-breaker status, cursor continuation, duplicate rates, and research queue behavior.
- Install repository dependencies in the deployment/build environment before running the Vite production build.
- No production deployment was performed.

## 11. Exact next steps for Session 4

1. Start from `KairFlow_Indie_V2_Phase_3.zip` only. Read this report and inspect the entire delivered repository before editing.
2. Verify the Phase 2 scoring, project-first source identity, new source-item type, source-status RPCs, and cursor recovery across daily budget resets. Do not assume the Phase 2 or Phase 3 migrations have been applied.
3. Build Kickstarter as a persistent discovery engine, not a one-page scraper. Investigate legitimate public discovery methods and terms before enabling each one.
4. Support public search/category discovery, project pages, creator profiles, search-engine-indexed pages where permitted, and manual Kickstarter project URL import.
5. Implement persistent candidate storage, cursors where supported, incremental/date-window searches, deduplication, retries/recovery, periodic rescans, and source provenance.
6. Keep creator attribution separate from verified developer identity; the creator may be a developer, studio representative, publisher, or third-party organizer.
7. Do not bypass authentication, CAPTCHAs, access controls, anti-bot protections, platform restrictions, or terms.
8. Preserve the Phase 2 qualification gates and Phase 3 source provenance. Do not begin Session 5 contact research or Session 6 outreach implementation.
9. Deliver `KairFlow_Indie_V2_Phase_4.zip` and `PHASE_4_HANDOFF.md` before ending Session 4.

## 12. Repository ZIP confirmation

The complete Phase 3 repository archive is delivered as `KairFlow_Indie_V2_Phase_3.zip`. It is created from the Phase 2 repository plus the Phase 3 additions/changes, with generated bytecode/cache directories, local environments, dependency caches, build output, and secrets excluded. The pre-existing root-level `PHASE_3_HANDOFF.md` was restored byte-for-byte from the Phase 2 archive; this phase report is included separately at `docs/indie-game-developers-v2/PHASE_3_HANDOFF.md`. The archive is reopened, integrity-tested, and its required migration, tests, documentation, and handoff files are checked before delivery.

## 13. Confirmed-bug corrective pass — 12 November 2026

### Scope

This corrective pass fixes the two confirmed Section 3 defects from the independent audit. It does not begin Phase 4 and does not change qualification, research, outreach, email, CRM, suppression, protected-account, or source-governance policy.

### Findings fixed

1. **Steam developer/publisher selector collision.** Steam markup can place both the developer and publisher sections inside elements sharing the `.dev_row` class. The old selector `#developers_list a, .dev_row a` therefore included publisher links in `developer_names`. Extraction now reads developers only from `#developers_list a` and publishers only from `#publishers_list a`. The explicit JSON-LD author fallback remains available only when the developer list is absent. A regression fixture wraps both sections in `.dev_row` and verifies that only the actual developer is returned as the candidate identity.

2. **Completed source restarted during another source's continuation.** Previously, a source that returned `nxt=None` was omitted from the continuation cursor. When another source still had pages, the next job treated the missing source cursor as an initial cursor and restarted it. The batch processor now persists `{"done": true}` for a completed source while any other source still needs continuation. Subsequent jobs skip that source. Terminal markers are discarded once no active or deferred source remains, preventing endless continuation jobs. Existing budget-exhaustion and open-circuit cursors remain preserved.

### Files changed in this corrective pass

- `intelligence-worker/kairflow_intel/sources.py`
- `intelligence-worker/tests/test_discovery.py`
- `docs/indie-game-developers-v2/PHASE_3_HANDOFF.md`
- `docs/indie-game-developers-v2/PHASE_3_CONFIRMED_BUGFIX_HANDOFF_2026-11-12.md`

No files were removed. No migration was added or changed.

### Regression tests added/updated

- Steam page with developer and publisher sections both nested in `.dev_row` does not misattribute the publisher as developer.
- A completed itch source is not fetched again while Steam continues from its saved cursor.
- Completed source markers survive continuation and the next source cursor advances.
- When all requested sources finish, the returned cursor is empty and no continuation delay is scheduled.
- Existing registry, budget hold, circuit-open, retry, and protected-publisher tests remain passing.

### Exact verification

| Check | Result |
|---|---:|
| Focused discovery suite: `python -m unittest tests.test_discovery -v` | **59 passed, 0 failed** |
| Full worker suite: `python -m unittest discover -s . -t . -v` | **885 passed, 0 failed** |
| Python compile: `python -m compileall -q intelligence-worker/kairflow_intel intelligence-worker/tests` | **Passed** |

An initial full-suite invocation using `-s tests` without a top-level package caused import errors because this repository's tests use relative imports. The supported invocation is `python -m unittest discover -s . -t .`; that correctly imported the test package and passed all 885 tests. The live preflight diagnostics appended by the test command still report environment-dependent Ollama model/structured-output and draft-RPC probe warnings; these are not unit-test failures and do not establish live integration readiness.

### Additional-source discovery limitation

No new automated external source was added in this corrective pass. The repository already includes Kickstarter administrator-only manual URL intake; its migration explicitly keeps automated Kickstarter crawling disabled because platform terms/access authorization have not been established. Steam and itch also remain disabled/unverified pending administrator terms and robots review. Existing general RSS/site-feed infrastructure is not yet wired as a game-project discovery source. Adding another automated source without source-specific terms, access, and provenance review would be unsafe and would exceed the two confirmed bug repairs. This remains a documented Phase 3 limitation for a separately authorized future change.

### Database, deployment, and safety

- No database migration was created or modified.
- No database, production, staging, campaign, source registry, or account settings were changed.
- No live Steam, itch, or Kickstarter requests were made.
- No source was enabled and no terms status was changed.
- No email was drafted or sent; no qualification or suppression behavior was changed.
- No environment variables or dependencies were added.

### Remaining limitations

- Steam and itch access must remain disabled until an administrator confirms current terms and robots/access rules.
- Kickstarter remains manual-only under the existing permission-attestation gate.
- Additional public game-development sources are not yet integrated into the Indie campaign.
- Database migration application, live-source behavior, and production end-to-end acceptance remain unverified.

### Next-session instruction

Continue with **Session 4 — Kickstarter Discovery Engine** from this complete Phase 3 repository ZIP. Preserve the manual-only Kickstarter policy unless written permission and terms review support a different access method. Do not restart from the Section 2 archive. Re-run the full worker suite using `python -m unittest discover -s . -t .` after changes.

## 14. Corrective delivery artifact verification

- Complete repository archive: `KairFlow_Indie_V2_Phase_3.zip`
- Archive content root: `KairFlow_Indie_V2_Phase_3/`
- Archive entries: 882 files
- Archive size: 2,948,093 bytes
- ZIP CRC/integrity test: passed (`ZipFile.testzip()` returned no corrupt member)
- Required source, regression tests, Phase 3 migration, main handoff, and corrective handoff: all present
- `.env`, `paystack-live.env.txt`, Python bytecode/cache directories, `.git`, dependency caches, and build output: excluded
- `.env.example`, source code, tests, migrations, docs, configuration templates, and deployment scripts: retained
