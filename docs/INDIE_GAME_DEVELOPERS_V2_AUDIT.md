# KairFlow Intelligence — Indie Game Developers Campaign V2
## Phase 1: Repository Audit and Implementation Blueprint

**Audit date:** 2026-11-12  
**Scope:** Session 1 only. Read-only audit plus documentation. No application, worker, database, migration, configuration, or test implementation changes were made.

## 1. Executive summary

The repository contains a substantial KairFlow Intelligence implementation and a campaign type named `indie_game_developer`. It is not yet a project-first prospecting system. The active indie workflow discovers developer/studio records from Steam and itch.io, researches the developer's own website, scores textual evidence, checks contactability separately, links qualified prospects into the CRM, and queues an initial email draft.

The most consequential gaps against the V2 brief are:

1. Steam discovery rejects third-party-published games and is narrow, bounded, and non-paginated.
2. Kickstarter is explicitly unimplemented and absent from the source registry's allowed keys.
3. itch.io discovery reads only newest tag pages and has no cursor or durable project-level queue.
4. A game is not represented as a first-class project. `intel_prospects` is developer/studio-oriented; source items are generic and do not model project lifecycle/timing.
5. Indie scoring is a legacy 90-effective-point rubric despite declared maxima totaling 100. Its breakdown omits the contact category.
6. `style_anime` matches JRPG and visual-novel wording, which is not sufficient proof of anime-compatible visuals.
7. Steam candidates are assigned `recent_activity=True` based on release eligibility, and itch candidates are also assigned it simply because they were seen on a newest page. These are not reliable proofs of active development.
8. The current contactability policy does not allow an associated personal mailbox such as Gmail/Outlook/Proton to pass through the normal documented path. It requires the email domain to associate with the prospect's official domain, even when employee affiliation is asserted.
9. Contactability is a separate gate for CRM resolution, but the stored prospect score/decision can still say `qualified` when contactability fails. This distinction is useful but needs explicit UI and qualification-state semantics.
10. Initial email construction includes portfolio content in the legacy and Japanese initial paths; the English AI composer is also given approved portfolio material. This conflicts with V2's no-unsolicited-portfolio rule.
11. Reply classification has a small label set and does not explicitly represent several required states (Not Now, Not Interested, Already Has Trailer, Wrong Person, Referral, Tell Me More, etc.).
12. Follow-up timing is a configurable business-day interval (default seven business days) and maximum count (default one), not the requested Day 5 / Day 10 / Month 3 / Month 6 schedule.
13. The four named protected accounts were not found in the repository as explicit literals. Database suppression infrastructure exists, but no live database was available to verify that those names/accounts are present in deployed protected records.

The current system has important architecture to preserve: evidence-backed deterministic research, source authorization and budgets, job retries/idempotency, provider-neutral sending, human approval, kill switch, send-boundary checks, suppression handling, CRM linkage, RLS, and AI routing with Ollama fallback.

## 2. Repository and continuity observations

- The supplied archive contained 4,054 ZIP entries and extracted successfully.
- The archive does **not** contain a Git repository (`.git` is absent); therefore the current branch, commit, and working-tree status cannot be verified. `git status` reports “not a git repository”.
- The archive includes a local Python virtual environment (`intelligence-worker/.venv`), Python bytecode/cache directories, pytest cache, Supabase `.temp` state, and a worker log. These are not source-of-truth files and are excluded from the Phase 1 delivery ZIP under the delivery protocol.
- There are 123 SQL migration files in `supabase/migrations`.
- Migration filenames extend through `20261229...`, later than the audit date 2026-11-12. This is a significant migration chronology/deployment-state ambiguity. Do not infer that every migration has been applied in production; verify the actual Supabase migration history before deploying any V2 migration.
- The ZIP contains `.env.example` and `intelligence-worker/.env.example`; no plain `.env`, PEM/key, or credential JSON file was found outside the bundled virtual environment during the audit scan. The final ZIP excludes environment secrets and local runtime artifacts.

## 3. Existing architecture and data flow

### 3.1 Intelligence worker

Primary implementation: `intelligence-worker/kairflow_intel/`.

- `jobs.py`: worker job handlers and orchestration (`discover`, `research`, `qualify`, `resolve`, `draft`, `send`, mailbox sync, classify, reconcile, follow-up scan, etc.).
- `sources.py`: Steam and itch.io adapters plus admin-provided seed pages. Kickstarter and X fetching are explicitly not implemented.
- `research.py`: fetches the developer's own site and selected internal pages, extracts emails, asks the AI only for named contact/name-role extraction, and stores deterministic evidence.
- `signals.py`: regex-based indie and animation-studio signal extraction.
- `scoring.py`: deterministic indie and animation-studio scoring. The model does not generate scores.
- `contactability.py`: deterministic syntax, provenance, domain association, human confirmation, provider delivery, bounce and complaint assessment.
- `drafting.py`: evidence-grounded initial/follow-up/reply composition, validation, approved knowledge-base usage, similarity checking, and threading helpers.
- `classify.py` and `policy.py`: deterministic high-priority inbound handling plus constrained AI classification for remaining replies.
- `safety.py`, `entity.py`, `siteanalysis.py`, `profile.py`, `feeds.py`, `gdelt.py`, `commoncrawl.py`, `wikidata.py`, `anilist.py`: source safety, entity resolution, website crawling, feeds and other research sources.
- `airouter.py`, `ai_call.py`, `ollama.py`, `gemini.py`: AI routing, structured calls, and local/cloud provider integration.
- `providers/`: provider-neutral worker adapter contract, registry, router, and Gmail/SMTP/Zoho adapters.
- `supa.py`: Supabase RPC/data access; `worker_lock.py` and controller scripts manage worker process lifecycle.

### 3.2 Discovery and research flow

1. `CampaignView.jsx` queues a `discover` job for the selected campaign.
2. `jobs.h_discover` loads campaign criteria and the organization-scoped source registry.
3. Indie discovery accepts only explicitly configured `steam` and/or `itch` sources and non-empty keywords.
4. `sources.discover` calls the adapter(s), enforcing source registry authorization and reserving budget per request.
5. Candidates are upserted as `intel_prospects`; new candidates queue `research`.
6. `jobs.h_research` requires a website, then `research.research` reads the home page and up to eight selected internal pages, records verified snippets and contact data, and queues deeper site analysis.
7. `siteanalysis.analyze` performs further page/sitemap analysis and queues qualification.
8. `research.qualify` computes the deterministic indie score and separately checks contactability and suppression/bounce/complaint facts.
9. `jobs.h_qualify` queues CRM resolution only when the score decision is qualified and contactability status is pass.
10. CRM resolution creates/links a lead and queues an initial draft.
11. The draft is stored for approval; the send pipeline uses provider assignment, quotas, kill switch, campaign status, suppression, CRM ownership/email checks, and final database authorization.

### 3.3 Database and Edge Functions

- Core campaign, prospect, evidence, job, message, settings, and suppression structures are in the `intel_*` schema/tables, primarily introduced by `20261109100000_intelligence_core_tables.sql` and surrounding migrations.
- `intel_prospects` is organization-scoped and canonicalized; it stores developer/studio identity, website, contact, lifecycle status, score, score breakdown, facts JSON, and CRM lead linkage.
- `intel_evidence` stores verified/unverified facts with source URL, snippet, hash and fetched timestamp.
- `intel_jobs` is a persistent, idempotent queue with attempts, leases, run-after time and terminal states.
- `intel_sources`, `intel_source_items`, and `intel_entity_aliases` support source registry, generic discovered items and organization aliases. `intel_sources.key` currently allows `steam` and `itch`, but not `kickstarter`; `intel_source_items.item_type` has no explicit game-project type.
- RLS is enabled for Intelligence tables; direct writes are restricted and database SECURITY DEFINER RPCs enforce administrative/worker operations.
- Edge Functions include provider connect/callback/token/health functions, `email-send`, `email-mailbox-sync`, Resend webhook/delivery functions, and shared provider/token/credential utilities. They are not currently a game-discovery service.

### 3.4 Frontend

Primary files: `src/intelligence/CampaignView.jsx`, `DiscoveryPanels.jsx`, `ProspectsView.jsx`, `ProspectModal.jsx`, `OutreachView.jsx`, `OverviewView.jsx`, `SettingsView.jsx`, `api.js`, and `logic.js`.

The campaign screen currently exposes campaign activation, daily introduction cap, keyword editing, indie score thresholds, a discovery button, discovery profile controls, and a prospects table. `DiscoveryProfile` and `ManualPost` are shared with the animation-studio campaign; the manual X post panel is only rendered for Animation Studio Support. There is no dedicated Kickstarter scan/queue/status/import interface.

### 3.5 AI and email architecture

- AI provider routing is centralized through `airouter.py`; routing policy and data-class controls determine whether Gemini is allowed, with Ollama fallback.
- Worker email adapters are provider-neutral via a registry and adapter interface. Current worker provider adapters include Gmail, SMTP and Zoho; Resend is a separate transactional/Inbox Edge Function path, not the cold-outreach adapter.
- Existing human approval, kill switch, rate/cap controls, provider account assignment, final send-boundary checks, and suppression checks must remain authoritative.
- Shared Inbox architecture is documented in `docs/EMAIL_ADAPTER_ARCHITECTURE.md` and related email architecture/handoff documents.

## 4. Detailed campaign audit

### 4.1 Steam discovery

Files: `intelligence-worker/kairflow_intel/sources.py`; orchestration in `jobs.py`.

Observed behavior:
- Uses `store.steampowered.com/api/storesearch/` and `appdetails` public storefront endpoints.
- Searches at most eight configured keywords, takes at most 12 search results per keyword, and stops after at most 25 candidates.
- Does not implement Steam search pagination or a persistent cursor.
- Requires a game and at least one developer name.
- Rejects third-party-published titles when publisher names do not match developer names. This is a direct conflict with V2.
- Only retains upcoming games (`coming_soon`) or games whose parsed release date is within 365 days of the current date. It therefore misses older games with meaningful DLC/update/console/relaunch opportunities and projects further from release.
- Candidate identity is the first developer string; the game name and app ID are only metadata. Multiple games by one developer collapse into a developer prospect instead of independent project records.
- Website is taken from the Steam website/support URL; absent websites later block the research flow.
- `recent_activity` is set true for every candidate that passed the upcoming/recent release filter. That flag is not proof of a recent announcement, devlog, update, build, or other development activity.
- `release_date` is stored as a display string and `coming_soon` boolean; expected and actual release dates are not normalized into distinct typed fields.

### 4.2 itch.io discovery

Observed behavior:
- Fetches `https://itch.io/games/newest/tag-{tag}` for at most six keywords.
- Reads only the first 20 game cells on each page; there is no page cursor or continuation.
- Deduplicates by itch developer profile host, not game/project ID.
- Returns the author/profile as the candidate developer and stores game title as metadata.
- Sets `recent_activity=True` simply because the candidate appeared on a newest listing; this should be treated as a discovery timestamp/listing signal, not independently verified development activity.
- Research then requires a readable developer site; profile-only or solo developers without a separate website can be flagged and stalled.

### 4.3 Kickstarter discovery

- `sources.py` explicitly states Kickstarter is not implemented because there is no free official API and terms are not verified.
- The source registry migration has no `kickstarter` key and no Kickstarter-specific enable/terms state.
- No Kickstarter search adapter, campaign listing scanner, public creator profile extraction, project queue/cursor, URL importer, or tests were found.
- No compliant fallback discovery strategy is implemented.

### 4.4 Qualification and scoring

Files: `scoring.py`, `signals.py`, `research.py`, `contactability.py`, `jobs.py`.

Current declared indie maxima are `20 + 20 + 20 + 15 + 15 + 10 = 100`, but `score_indie` appends only five rows: active development, style fit, release/promo, commercial and animation need. It never appends the contact row. Its effective maximum is 90.

Current behavior and risks:
- Existing thresholds default to 70 qualify / 50 review, not V2's 75 / 55.
- `style_anime` matches `anime`, `manga`, `visual novel`, `JRPG`, and `anime-inspired`. JRPG/visual-novel classification is not sufficient visual evidence and must not be treated as proof of anime aesthetics.
- `style_fit` awards points for broad 2D, anime, stylized and narrative text signals. The model does not inspect screenshots/trailers/artwork for anime visual identity.
- `active_development` awards 20 points when `meta.recent_activity` is true. Steam and itch adapters currently populate this flag from discovery/release heuristics, so the score can reward weak or false activity.
- `release_promo` awards points from upcoming release, `coming_soon`, Kickstarter mention or trailer. It does not use a normalized announcement-to-campaign interval, release horizon, or latest activity date.
- `commercial` awards points for Kickstarter, publisher, and price presence. Publisher involvement is a positive scoring input, even though V2 says publisher must not automatically disqualify or earn points merely for being present.
- `animation_need` awards 15 points for explicit animation-seeking wording or 5 for trailer evidence. V2 says existing animation recruitment is not a requirement; scoring should instead assess cinematic opportunity from the game and timing.
- The `contact` category is declared but absent from score output. Contactability is separately assessed, which is the right separation, but the declared model and actual breakdown disagree.
- `research.qualify` records contactability and score but does not change `res.decision` based on contactability. `jobs.h_qualify` correctly prevents CRM resolution unless contactability passes. The UI/status model should make suitability and mandatory qualification gates unambiguous.
- Evidence dictionary construction in indie qualification collapses multiple evidence rows with the same `fact_type` to the last snippet; this loses supporting evidence for score explanation.
- There is no distinct mandatory gate object covering project identity, active/opportunity evidence, visual anime proof, contact status, suppression, and confidence.

### 4.5 Research and contact verification

- Research requires an official website and reads only that site and selected same-host internal pages; Steam/itch candidate pages are not themselves a first-class project evidence package.
- Contact emails are extracted from the developer's own site and may be seeded from Steam support metadata.
- `contactability.assess` requires valid syntax, source provenance, domain association, and either human confirmation or provider-delivery evidence.
- A contact form without an email is rejected, consistent with V2.
- A listed but not deliverability-confirmed address is `needs_review`, not pass.
- A personal email address cannot pass the normal domain-association check: `domain_associated` is based on matching the email domain to the official developer domain. `employee_affiliation` can allow a third-party source page, but does not waive the official-domain association check. This blocks legitimate personal mailboxes even if affiliation is documented.
- Bounce and complaint evidence are hard rejection inputs; database contactability lookup failures fail closed to review.
- The current assessment does not explicitly receive all suppression categories as a single decision input. Suppression is enforced separately in database send gates; ensure prospect qualification also checks full suppression/protected status before promotion.
- `research.qualify` stores `contactability` in estimate metadata and the worker only queues CRM resolution when status is pass. This is a useful existing safety boundary to preserve.

### 4.6 Timing and activity data

Current fields are spread across metadata/facts JSON and display strings. The current prospect table has no typed project dates. There is no first-class separation of:
- project announcement date;
- campaign/marketing opportunity date;
- expected release date;
- actual release date;
- latest meaningful activity date;
- discovery timestamp.

The V2 timing model cannot be implemented reliably by reusing `release_date` or `recent_activity`. A project-level data model and evidence provenance are needed. Unknown release dates should remain unknown, not be converted to inactivity or rejection.

### 4.7 Protected accounts and suppression

- The named protected entities Brain Jar Games, Silver Line Interactive, Thermite Games, and Lie of Caelum: Spirit were not found as literals in the extracted source tree (excluding caches).
- `intel_suppressions` exists and is checked at send reservation/final send boundaries by normalized email/domain.
- Bounce/complaint events write or update suppression records in the delivery-event migrations.
- Prospect/reply states and suppression controls exist, but no repository-level explicit name/project protected-account denylist was located.
- The production suppression table was not queried; therefore this audit cannot assert whether the four named protected entities are already suppressed in production.
- V2 must add a durable protected-entity/project check before discovery candidate promotion, qualification, CRM resolution, draft creation, and sending, without weakening existing email/domain suppression gates.

### 4.8 Initial email drafting

- The active worker initial draft path is `jobs.h_draft` -> `drafting.compose_english` or `compose_japanese`.
- `build_initial` (legacy/template helper) includes `portfolio.main` in English initial email and Japanese required content includes `portfolio.main.ja`.
- The English AI composer receives `portfolio.main` in `approved_studio_facts`; therefore portfolio content is available to initial drafting unless separately forbidden by prompt/validator.
- Initial drafts are evidence-grounded and validated for URLs, pricing, false claims, compliance footer, and similarity. The initial draft is stored with `p_auto_ok=False`, and the normal path requires human approval.
- The current prompt requires individualized opening/collaboration angle but does not explicitly enforce every V2 structural requirement (first-name greeting where known, a specific game detail, studio introduction as an anime animation studio, natural question, no portfolio, no website link, no em-dash).
- The initial outreach path must be revised in Session 6 while retaining evidence IDs, validation, similarity checks, approved studio knowledge, human approval and compliance footer.

### 4.9 Reply classification and follow-ups

- `classify.py` uses deterministic bounce, auto-reply, unsubscribe, complaint and other hard-rule handling before AI classification.
- Current labels: positive, meeting_request, pricing, negotiation, portfolio_request, project_opportunity, rejection, unsubscribe, ambiguous, complaint, other.
- Required V2 distinctions absent as explicit states include Not Now, Not Interested (distinct from permanent DNC), Already Has Trailer/No Current Need, Wrong Person, Referral, and Tell Me More.
- Current deterministic decline logic returns `rejection`; it is not the same as unsubscribe or complaint, which are handled separately. However, there is no explicit long-term state/action mapping for Not Interested versus Not Now.
- Any inbound message prevents the normal follow-up candidate query from selecting the prospect, which is a useful stop-on-reply property. Recheck all final follow-up gates when adding reply states.
- Follow-up timing is driven by `intel_settings.followup_business_days` (schema default seven business days) and `max_followups` (schema default one, maximum three). It is not the requested 5/10-day and 3/6-month re-engagement model.
- Re-engagement currently occupies the final follow-up slot through a special composition kind and is bounded by existing follow-up count; it is not a separately timed Month 3 / Month 6 milestone engine.
- `policy.hard_class` prioritizes unsubscribe, complaint, contract, negotiation, pricing, deadline, meeting, availability and ambiguous classes. Preserve and extend deterministic priority rather than relying on model classification for opt-out safety.

## 5. Database changes required (blueprint only; no migrations created)

The current schema is useful for CRM and outbound messaging, but a project-first discovery model needs additive project/source structures.

Recommended Session 2–5 database work:

1. **First-class project table** (e.g. `intel_game_projects`): organization, canonical project key, title, developer/prospect relationship, Steam app ID, itch project ID, Kickstarter project ID, official URLs, genres/tags, description, campaign status, announcement date, campaign date, expected release date, actual release date, latest meaningful activity date, discovery timestamp, research state, qualification state, and project facts.
2. **Project source/provenance table** (or extend `intel_source_items`): source key, source URL, source project ID, first/last seen, discovery run, evidence metadata, page/search query, and project FK. Deduplicate across Steam, Kickstarter, itch and manual imports without collapsing distinct games from one developer.
3. **Project evidence linkage**: extend `intel_evidence` with nullable project FK or create `intel_project_evidence` so screenshot/trailer/artwork/description evidence is attached to the correct game rather than only the developer.
4. **Source registry extension**: add `kickstarter` to the allowed `intel_sources.key` values and source administration/terms controls. Add source item types for projects/campaigns as appropriate.
5. **Persistent discovery run/cursor state**: run ID, source, strategy/query, time window, page/cursor, next scan time, completion state, attempt/retry state, rate-limit backoff, and last error. Reuse `intel_jobs` lease/retry machinery where possible rather than creating a competing queue.
6. **Contact verification model**: typed verification state (`verified_eligible`, `needs_review`, `invalid`, `unverified`, `suppressed`), exact normalized email, source URL, developer-affiliation evidence, verification method/time, deliverability evidence, and bounce/complaint/protected conflict status. Personal addresses need an explicit affiliation path that does not incorrectly require their domain to equal the studio domain.
7. **Qualification model/version**: persist V2 model version, 5 category scores (30/25/25/10/10), evidence IDs, mandatory gate results, decision and human-readable reasons. Suitability score must not override mandatory gates.
8. **Reply state/action mapping**: persist normalized reply outcome separately from raw provider classification; preserve immutable suppression reasons and distinguish Not Interested from DNC/unsubscribe/complaint.
9. **Follow-up schedule state**: model Day 5, Day 10, Month 3 and Month 6 milestones with reply interruption and meaningful-reason requirements; retain the final database send gate as authority.
10. **Protected entities**: add an admin-controlled, auditable protected-entity registry or immutable seed records for the four named exclusions, matched against developer aliases, project names and relevant identifiers. Do not rely only on a frontend filter.

All migrations should be additive, organization-scoped, RLS-protected, and backward-compatible with Animation Studio Support and existing CRM records. No production migration should be applied without explicit authorization and verified migration history.

## 6. Prioritized implementation plan for Sessions 2–7

### Session 2 — Prospect qualification and scoring V2

- Replace indie scoring with the requested 30/25/25/10/10 rubric and 75/55 bands.
- Enforce mandatory project/activity/visual/contact/suppression/evidence gates independently of score.
- Remove publisher/reputation/published-game/wishlist/animation-recruitment requirements or positive scoring assumptions.
- Separate project date fields and activity evidence.
- Replace broad anime keyword inference with evidence confidence classes; JRPG/VN alone cannot qualify visual anime style.
- Preserve scoring explainability and test first-time developers, one-game studios, personal email, unknown release date and third-party publisher cases.

### Session 3 — Steam and multi-source discovery redesign

- Make Steam discovery project-first, broad and paginated/incremental where supported.
- Remove publisher != developer rejection; resolve developer, publisher and campaign organizer as separate roles.
- Replace fabricated `recent_activity` flags with timestamped evidence from actual updates/announcements/devlogs/store events.
- Expand itch discovery with supported pagination and game-level IDs.
- Add other compliant public discovery sources only after terms/access review.
- Preserve source URL, source ID, discovery time, raw evidence and cross-source dedupe.

### Session 4 — Kickstarter discovery engine

- Add registry/terms support and a dedicated persistent discovery workflow.
- Investigate public search/category pages, public project pages, creator profiles, search-engine-indexed pages and permitted public interfaces.
- Add varied keyword/category search strategies, date windows, cursors where available, retry/backoff, dedupe, periodic rescan and manual project URL import.
- Do not bypass login, CAPTCHA, anti-bot, access controls or platform restrictions; document unsupported methods and use approved alternatives.
- Separate creator, developer, publisher and organizer identities.
- Store campaign funding metrics as campaign facts, never as evidence of willingness/ability to buy animation.

### Session 5 — Research enrichment and verified contact discovery

- Research each game and its responsible developer/studio.
- Verify anime aesthetic from actual screenshots, trailers, artwork, official descriptions and official store/project pages.
- Capture evidence for activity, dates, marketing opportunity, official profiles and developer identity.
- Add verified personal-email affiliation path while preserving syntax, deliverability, bounce, complaint, suppression and source evidence.
- Keep contact form only as not-contactable; do not synthesize email addresses.

### Session 6 — Personalized outreach and reply roadmap

- Enforce project-specific opening detail and evidence IDs.
- Initial email: first name when known, real game detail, relevant cinematic opportunity, Studio Kairegi as anime animation studio, short natural question.
- Block portfolio and studio website links from initial email; only provide portfolio after explicit request.
- Preserve price exclusion, NDA restrictions, footer, similarity, evidence validation and human approval.
- Implement the reply outcomes and their deterministic actions, with unsubscribe/complaint/DNC taking precedence.
- Implement Day 5/Day 10 and reasoned Month 3/Month 6 re-engagement, with all replies interrupting cold follow-ups immediately.

### Session 7 — Frontend integration, E2E and release

- Add source controls/status, Steam/Kickstarter scan status, queue/retry visibility, URL import, project list, research/qualification/contact status, approvals, sent mail, replies/opportunities, protected/suppression visibility and campaign performance.
- Ensure every control is functional and all rejection/review reasons are visible.
- Run full cross-source E2E, RLS/security, worker, frontend, database and email regression tests.
- Verify Animation Studio Support, transactional Resend, provider-neutral adapters, AI routing/Ollama fallback, CRM history and human approval remain intact.
- Provide deployment/migration/rollout instructions and do not claim production readiness from unit tests alone.

## 7. Test inventory, executed checks and gaps

### Executed in the audit environment

- Python worker suite: `cd intelligence-worker && python -m unittest discover -s tests -t .` — **754 tests passed, 0 failed**.
- Frontend/Node suite: `npm test` — **1,114 tests passed, 0 failed**.
- Supabase-side Python reevaluation suite: `PYTHONPATH=intelligence-worker python -m pytest -q supabase/tests/test_studio_reeval.py` — **40 passed**.

The worker suite emitted expected mocked error/fallback diagnostics during tests and still completed successfully. It also printed self-test output for mocked configuration scenarios; these are not production health checks.

### Not executed / not verifiable

- `npm run build`: not run because `node_modules` is absent from the supplied archive and no dependency installation was performed.
- Full Supabase SQL integration tests: not run; no local PostgreSQL/Supabase runtime or production connection was used.
- Live provider acceptance: not run; no Gmail/Zoho/SMTP/Resend credentials or live mailboxes were accessed.
- Live Ollama/Gemini or external source acceptance: not run as part of the audit; unit tests are mocked/no-network where applicable.
- `supabase/tests` pytest collection initially failed because the worker package was not on `PYTHONPATH`; the one discovered Python suite was rerun with `PYTHONPATH=intelligence-worker` and passed.
- Full project-specific test coverage for Kickstarter, project-first deduplication, release/announcement date semantics, visual anime evidence, personal mailbox eligibility, protected-account matching, and the V2 reply-state matrix does not exist yet.
- Live production suppression/protected-account records and deployed migration history were not inspected.

## 8. Test gaps and known risks

1. No explicit tests for the four named protected accounts.
2. No Kickstarter adapter/queue/import/retry/cursor tests.
3. Steam tests should cover third-party publishers, multi-developer projects, old games with DLC/update/console release opportunities, future release dates, unknown release dates, pagination and no false activity.
4. itch tests should cover pagination, multiple games by one developer, game-level dedupe and listing recency versus actual activity.
5. Anime verification tests should assert that JRPG, visual novel or Japanese setting alone is insufficient.
6. Scoring tests should assert category maxima total exactly 100, contactability mandatory gate behavior, score explainability and evidence accumulation.
7. Contactability tests should cover Gmail/Outlook/Proton with documented developer affiliation and provider deliverability, while still blocking unverified/complained/bounced/suppressed addresses.
8. Project timing tests should cover announcement date, campaign date, expected release, actual release, latest activity, unknown dates and recently released games with DLC/update/port/relaunch.
9. Outreach tests should explicitly block portfolio and studio links from initial emails, verify no em dash, and require a grounded project detail and natural question.
10. Reply tests should cover every required state, deterministic priority, Not Interested vs DNC, reply interruption and referral capture.
11. Migration ordering risk: the archive contains migrations dated through 2026-12-29 although audit date is 2026-11-12; deployed state must be reconciled before adding a migration.
12. ZIP lacks Git metadata, so no source commit/branch baseline can be supplied.

## 9. Security and safety observations

Preserve existing controls:
- Source enablement requires explicit terms confirmation; per-source budgets and circuit breakers are checked before requests.
- Site crawler respects robots rules and configured per-host delay.
- AI-generated research does not itself create verified facts; important facts are tied to source evidence.
- Outbound messages require approved knowledge, policy validation, human approval in the normal initial path, and similarity checks.
- Database send boundary checks kill switch, campaign state, suppression, prospect state, CRM email/ownership, provider account and provider capability/quota.
- Unsubscribe and complaint handling are deterministic and take precedence over model labels.
- Organization-scoped RLS and SECURITY DEFINER RPC boundaries protect Intelligence data.
- Worker credentials and provider tokens must remain server-side and must not enter ZIPs/reports.

Risks to address in V2:
- Add the named protected-account guard at discovery/qualification/CRM/draft/send boundaries.
- Ensure source-specific terms and platform access are reviewed before enabling Kickstarter or expanding Steam/itch collection.
- Do not treat funding, publisher, wishlist, newest-page presence or release proximity as proof of budget, activity or animation need.
- Do not allow personal email to pass without exact affiliation evidence and deliverability checks.
- Keep sending fail-closed if suppression lookup or final provider checks fail.

## 10. Session 1 scope confirmation

- No worker source code changed.
- No frontend source code changed.
- No database schema or migration changed.
- No Edge Function changed.
- No environment variables changed.
- No campaign configuration changed.
- Only this audit report and the Phase 1 handoff report were added.

**Session 2 must not begin until the owner reviews and approves this audit and implementation blueprint.**
