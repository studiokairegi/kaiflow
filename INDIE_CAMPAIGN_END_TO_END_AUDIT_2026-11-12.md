# KairFlow Intelligence — Indie Game Developers Campaign
## End-to-End Technical Audit

**Audit date:** 12 November 2026  
**Repository audited:** `KairFlow_Indie_V2_Phase_7_Confirmed_Bugfixes.zip` / extracted Phase 7 repository  
**Mode:** Read-only audit. No application or database files were changed.

---

## 1. Executive assessment

The Indie campaign has a substantial end-to-end implementation, but it is **not ready for an unrestricted production launch**. The strongest parts are the project-scoped discovery model, evidence-backed deterministic qualification, exact-address contact verification, protected-account checks, human approval, provider-neutral delivery, and the final database send boundary.

The audit found **two confirmed high-priority safety/qualification defects**, plus several workflow and operational gaps:

1. **Domain suppression matching is inconsistent for subdomains.** The Indie suppression lookup and final send boundary use exact-domain matching, while the contact-verification migration explicitly recognizes subdomains. A domain suppression can therefore be missed for an address on a subdomain, including at the final send boundary.
2. **itch.io creator attribution is not required to be independently verified by the project-identity gate.** The adapter marks the creator as `platform_creator_unverified`, but the gate only checks that the creator name, project title, and URL are present. This conflicts with the discovery policy that a creator label is not proof of developer identity.
3. **New information on an already-existing project does not requeue research.** Discovery only queues research when the prospect row is newly created. A later Steam/itch observation that fills a missing website or adds source facts updates the row but does not restart the research/qualification chain.
4. **The Indie campaign displays a discovery-profile editor whose approval state is not consumed by the Indie Steam/itch discovery path.** Its copy describes news/archive discovery, but the Indie discovery handler uses only the campaign keyword list and source registry.
5. **Campaign pause stops discovery and final sending, but follow-up candidate selection and draft generation are not gated by campaign status.** This can continue creating drafts while a campaign is paused, even though the final send boundary blocks delivery.
6. **Kickstarter's no-fetch guarantee relies on the current enqueue path.** The normal manual intake queues research only when a separate developer website is supplied, but the generic research handler still accepts a project URL as a fallback. A future/direct research job for a Kickstarter-only prospect could fetch Kickstarter unless the worker itself rejects that host.

The repository's unit tests pass, but they do not establish SQL correctness, deployed migration state, provider health, browser behavior, or production readiness. SQL/RLS integration, browser E2E, and production build remain unverified.

**Recommendation:** keep automated sends disabled until the two high-priority findings are corrected and tested in staging. Keep Steam/itch disabled until source-specific terms/access review is documented and confirmed. Do not treat this audit as a deployment sign-off.

---

## 2. Scope and methodology

Reviewed the Indie-specific frontend and worker paths, project discovery adapters, research/evidence extraction, deterministic scoring, contactability, database migrations/RPCs/triggers, manual Kickstarter intake, CRM conversion, drafting, reply classification, follow-up scheduling, provider send orchestration, and related tests/docs.

Key code areas:

- Frontend: `src/intelligence/CampaignView.jsx`, `DiscoveryPanels.jsx`, `ProspectModal.jsx`, `IndieAdminPanel.jsx`, `OutreachView.jsx`, `SettingsView.jsx`, `api.js`, `logic.js`.
- Worker: `intelligence-worker/kairflow_intel/jobs.py`, `sources.py`, `research.py`, `indie_evidence.py`, `scoring.py`, `contactability.py`, `drafting.py`, `policy.py`, `classify.py`, `indie_outreach.py`, `takeover.py`.
- Database: Indie migrations dated `20261112140000` through `20261112192000`, plus later send-boundary and delivery/reliability migrations.
- Tests: Indie qualification, Kickstarter intake, Phase 7 UI/reply approval, outreach sequence, and full repository suites.

The ZIP does not include `.git`; branch, commit, and working-tree provenance cannot be independently established. No connected Supabase database, production migration ledger, provider account, or browser E2E runtime was available.

---

## 3. End-to-end workflow map

1. **Campaign configuration** — `CampaignView` loads the `indie_game_developer` campaign, allows keyword/cap edits, and queues `discover`.
2. **Source authorization** — `h_discover` requires explicitly configured `steam`/`itch` sources, keywords, and source registry authorization. The registry requires `enabled=true`, `tos_status='confirmed'`, an available budget, and a closed circuit.
3. **Discovery** — Steam public Store search/app pages and itch.io public browse pages produce project-level candidates. Kickstarter is manual-only; its admin RPC requires an internal written-permission reference and does not enqueue automated Kickstarter discovery.
4. **Project persistence** — `intel_agent_upsert_prospect` uses a developer/title project key, while `intel_agent_record_item` stores each source URL independently.
5. **Research** — the worker fetches the official developer website or project/store source, stores verified text/date evidence, and stores visual candidates as unverified pending human inspection.
6. **Qualification** — deterministic `indie-project-v2` scoring computes five categories and seven mandatory gates. A numeric score alone cannot qualify a prospect.
7. **Contact verification** — the admin panel records exact-address evidence and invokes server-side identity/contact verification RPCs. Contactability requires exact-address confirmation/deliverability and source/affiliation evidence.
8. **CRM resolution** — only qualified prospects with contactability `pass` are queued for lead resolution. Database review functions independently re-check qualification, suppression, protected-account and contactability constraints.
9. **Initial outreach** — a project-specific message must use verified project and visual evidence, name the exact project, identify Studio Kairegi's service, and pass the outbound policy/similarity checks. The draft is pending human approval.
10. **Replies** — inbound messages are classified, outcome actions are logged, and model-written replies remain pending approval. Unsubscribe/complaint/bounce controls take precedence.
11. **Follow-ups** — Indie schedule is Day 5, Day 10, Month 3 and Month 6, anchored to the initial sent message. Re-engagement requires new verified dated project evidence. Any inbound message interrupts the sequence.
12. **Sending** — provider-neutral adapters handle dispatch; database reservation/final-send checks revalidate kill switch, campaign state, quotas, contact permissions, recipient matching, suppression and Indie qualification gates.

---

## 4. Findings

### F-01 — Domain suppression does not consistently cover subdomains

**Severity: High (P1)**  
**Area:** Suppression, qualification, final send boundary  
**Status:** Confirmed static-code defect

The Indie suppression RPC matches a domain suppression when the suppression value equals the prospect domain or the email ends exactly in `@<suppressed-domain>`. The final send boundary similarly compares the suppression value to the exact recipient email domain. Neither path consistently checks `@%.<suppressed-domain>`.

The Phase 5 contact-verification migration *does* include the subdomain form (`v_email like '%@%.'||s.value`), showing that subdomain coverage is intended elsewhere. As a result, a domain suppression for `example.com` can be recognized by contact verification but missed by later Indie qualification/final-send checks when the contact is `person@mail.example.com` and the prospect domain is not exactly `example.com`.

**Impact:** a suppressed subdomain address can potentially pass a later safety check and reach provider dispatch. This is the most important issue in this audit.

**Evidence locations:**
- `supabase/migrations/20261112140000_intelligence_indie_project_qualification_v2.sql:522-527` — Indie suppression lookup.
- `supabase/migrations/20261128100000_intelligence_phase8_final_send_boundary.sql:119-129` — final recipient suppression check.
- `supabase/migrations/20261112191000_intelligence_indie_research_integrity_v6.sql:104-111` — contact-verification path includes subdomain matching.

**Required correction:** use one canonical domain-match helper for qualification, identity/contact verification, suppression lookup, prospect triggers, and final send. Define and test parent-domain/subdomain semantics explicitly. Add SQL tests for exact domain, subdomain, unrelated suffix (`notexample.com`), and email suppression.

### F-02 — itch.io creator attribution can satisfy the project-identity gate while still unverified

**Severity: High (P1/P2)**  
**Area:** Discovery identity / qualification  
**Status:** Confirmed policy-enforcement gap

The itch adapter sets `developer_identity_status='platform_creator_unverified'` and records the page creator as `developer_name`. The Phase 3 discovery documentation explicitly says itch creator attribution is not proof that the creator is the actual developer or an authorized business contact. However, `indie_mandatory_gates()` only treats unverified attribution specially for `kickstarter_manual`; for itch it checks only that a title, non-empty developer name, and project URL exist.

A direct scorer check with an itch candidate marked `platform_creator_unverified` returned `project_identity.passed = true`.

**Impact:** an itch creator may be treated as the game's developer without the identity review that the campaign's source policy says is required. Other gates still apply, but if the prospect later obtains verified contactability and the remaining evidence, it can progress as a qualified developer.

**Evidence locations:**
- `intelligence-worker/kairflow_intel/sources.py:228-235` — itch creator marked unverified.
- `intelligence-worker/kairflow_intel/scoring.py:220-224` — only Kickstarter unverified attribution is blocked.
- `docs/INDIE_GAME_DISCOVERY_V2.md` — itch creator attribution policy.

**Required correction:** enforce developer identity status for itch candidates, or introduce a typed distinction between platform creator attribution and verified developer identity. The gate should require a reviewed identity link before CRM/outreach, without requiring an independent developer website if the official project page itself provides sufficient evidence and the reviewer can attest to it.

### F-03 — Later discovery observations do not restart research for an existing project

**Severity: Medium (P2)**  
**Area:** Discovery-to-research lifecycle  
**Status:** Confirmed workflow gap

`h_discover()` records each candidate and upserts its project prospect, but it queues the `research` job only when the upsert response says `created=true`. The upsert RPC merges newly discovered website/contact/project metadata into an existing canonical project row. If the first observation came from itch without a developer website and a later Steam observation supplies the website, the row is updated but no new research job is queued.

The research handler itself only accepts prospects in `discovered` or `researched` status. A prospect that has already moved to `needs_review` cannot be refreshed through the normal research handler, even if later discovery supplies materially better data.

**Impact:** cross-source enrichment can be persisted without triggering the research/qualification steps needed to use it. Some projects can remain stuck in review with stale evidence/contactability.

**Evidence locations:**
- `intelligence-worker/kairflow_intel/jobs.py:125-136` — research enqueued only for `r['created']`.
- `supabase/migrations/20261112160000_intelligence_indie_project_discovery_v3.sql:55-73` — existing project row is enriched on conflict.
- `intelligence-worker/kairflow_intel/jobs.py:147-151` — research status allowlist.

**Required correction:** compare material fields before/after upsert and enqueue an idempotent refresh when official website, project source, identity or contact metadata materially improves. Provide an explicit admin re-research action for non-terminal Indie prospects, with safe status transitions and no duplicate CRM lead creation.

### F-04 — Pausing a campaign does not stop follow-up draft generation

**Severity: Medium (P2)**  
**Area:** Campaign lifecycle / follow-up queue  
**Status:** Confirmed behavior

Discovery checks that the campaign is active, and the final send boundary blocks delivery if the campaign is paused. However, the Indie follow-up candidate RPC does not filter on campaign status, and `h_followup_scan()`/`h_draft()` do not independently check campaign status before composing a follow-up/re-engagement draft.

**Impact:** pausing the campaign can still generate pending drafts and review work. The final send boundary protects against delivery, but the pause behavior is incomplete and may confuse the administrator.

**Evidence locations:**
- `intelligence-worker/kairflow_intel/jobs.py:56-64` — discovery pause check.
- `intelligence-worker/kairflow_intel/jobs.py:691-704` — follow-up scan enqueues drafts.
- `supabase/migrations/20261112192000_intelligence_indie_outreach_v6.sql:12-86` — follow-up candidate query has no active-campaign predicate.
- `supabase/migrations/20261128100000_intelligence_phase8_final_send_boundary.sql:277-281` — send is blocked when campaign is paused.

**Required correction:** define pause semantics (stop all campaign activity vs stop sending only). If pause is intended to stop campaign activity, gate follow-up candidate selection and draft generation on active status, and ensure queued draft jobs are harmlessly skipped after pause.

### F-05 — Indie discovery profile UI is not connected to Indie discovery

**Severity: Low (P3)**  
**Area:** Campaign configuration UX  
**Status:** Confirmed mismatch

The Indie campaign renders the shared `DiscoveryProfile` panel. Its UI says approved English/Japanese phrases are used for news, feeds and archives, and the panel lets the admin request and approve phrases. But Indie `h_discover()`/`sources.discover_batch()` only consume `criteria.sources` and `criteria.keywords` for Steam/itch. The news scan handler is hard-coded to `animation_studio_support`. Thus changing/approving the Indie profile does not alter Steam/itch queries or enable Indie news/archive discovery.

**Impact:** the user can spend time configuring a feature that has no effect on the Indie campaign. It also creates a misleading impression that additional discovery sources are active.

**Evidence locations:**
- `src/intelligence/CampaignView.jsx` — `DiscoveryProfile` is rendered for both campaign types.
- `src/intelligence/DiscoveryPanels.jsx:8-37` — profile panel claims news/feed/archive usage.
- `intelligence-worker/kairflow_intel/jobs.py:185-188` — news scan fixed to animation-studio campaign.
- `intelligence-worker/kairflow_intel/sources.py:269-280` — Indie batch uses only configured keywords and Steam/itch sources.

**Required correction:** either hide the profile panel for Indie until an Indie-compatible source consumes it, or wire approved terms into a separately authorized Indie discovery source. Do not imply news/archive coverage that is not implemented.

### F-06 — Kickstarter host protection is enforced by workflow convention, not at the research fetch boundary

**Severity: Medium (P2, defense-in-depth)**  
**Area:** Source-policy enforcement  
**Status:** Current normal path is safe; generic handler is not self-protecting

The manual Kickstarter intake correctly does not fetch Kickstarter and only queues research when a separate developer website is supplied. But `h_research()` permits an Indie prospect with any `project_source_url`, and `research.research()` uses that project URL when `website` is empty. There is no explicit Kickstarter-host rejection in the research fetch boundary.

**Impact:** the current manual intake flow avoids the fetch, but a directly queued or future-generated research job for a Kickstarter-only prospect could fetch Kickstarter despite the documented no-crawl policy.

**Evidence locations:**
- `intelligence-worker/kairflow_intel/discovery.py:278-381` — manual Kickstarter path only enqueues research when a separate website is present.
- `intelligence-worker/kairflow_intel/jobs.py:172-185` — generic Indie research allows project source fallback.
- `intelligence-worker/kairflow_intel/research.py:163-177` — project source becomes fetch target when no website exists.

**Required correction:** enforce a host denylist at the actual fetch boundary for Kickstarter (and any other manual-only source), not only at the intake/enqueue caller. Add a worker test that injects a Kickstarter-only project and proves the fetcher is never called.

---

## 5. Controls that are present and appear correctly layered

The following controls were found in source and static SQL review:

- Steam/itch source registry authorization, terms confirmation, request budgets, circuit state, resumable cursors and idempotent continuation jobs.
- Kickstarter is not an automated adapter; manual intake is admin-only and records a written-permission reference/attestation.
- Visual media candidates are stored unverified; human review is required before visual qualification.
- Qualification uses deterministic scoring, five categories totaling 100, fixed 75/55 bands, and seven mandatory gates.
- Protected account names are checked in worker code and database qualification/outbound paths.
- Exact contact address, evidence URL, personal mailbox affiliation, and provider delivery/human verification are separate checks.
- Suppression lookup errors fail closed during qualification.
- CRM approval/link/create RPCs independently enforce Indie qualification and suppression conditions.
- Initial outreach requires project-specific and visual evidence, with a natural question and no URL; unsolicited portfolio content is blocked.
- Model-written drafts/replies are approval-first; the Phase 7 reply fix now stores manual replies as `pending_approval`.
- Inbound replies interrupt the follow-up sequence; unsubscribe/complaint/bounce handling has higher priority than ordinary reply classification.
- Day 5/Day 10 follow-ups and Month 3/Month 6 re-engagement are anchored to the original introduction; re-engagement requires newer verified dated project evidence.
- Provider-neutral adapter selection, message idempotency, send reservation, kill switch, send windows, quotas, and final database send checks are present.

These are source-level observations, not proof that the corresponding migrations have been applied or that deployed services are configured correctly.

---

## 6. Test and validation results

| Validation | Result |
|---|---:|
| Full Node/frontend contract suite (`npm test`) | **1,142 passed, 0 failed** |
| Full Python worker suite | **903 passed, 0 failed** |
| Focused Indie/Kickstarter/Phase 7 Node tests | **17 passed, 0 failed** |
| Focused Indie outreach Python tests | **25 passed, 0 failed** |
| Direct reproduction of itch identity gate | **Confirmed:** `platform_creator_unverified` still passes project identity |
| SQL migration execution / RPC integration | **Not run** — no PostgreSQL/Supabase CLI/staging DB |
| RLS and grant verification against deployed DB | **Not run** |
| Browser E2E / visual UI test | **Not run** |
| Production frontend build | **Not verified** — Vite executable is absent from `node_modules` in this environment |
| Live Steam/itch/Kickstarter requests | **Not run** |
| Live email provider send/reply test | **Not run** |
| CRM mutation / production migration / deployment | **Not performed** |

The Python test runner emits expected environment/preflight diagnostics for Gemini quota/auth and Ollama availability. They do not cause test failures and do not demonstrate live AI provider health.

---

## 7. Release-readiness checklist

Before enabling this campaign in production:

1. Fix F-01 and add SQL-level regression tests that exercise the actual final-send function.
2. Fix F-02 so itch creator attribution cannot silently become verified developer identity.
3. Fix F-03 to make project enrichment reliably trigger research/qualification refresh.
4. Decide and implement explicit pause semantics (F-04).
5. Remove or wire the misleading Indie profile panel (F-05).
6. Add a Kickstarter host deny rule at the research fetch boundary (F-06).
7. Reconcile the actual Supabase migration ledger with all repository migrations. Do not assume filename chronology equals deployed state; this archive contains migrations later than the audit date.
8. Apply migrations only in staging, then verify function signatures, grants, RLS, triggers, and send-boundary behavior.
9. Confirm source terms/robots/access policies for Steam and itch before enabling either source. The repository migration intentionally leaves both disabled/unverified.
10. Run browser E2E for discovery, source holds/cursor continuation, evidence entry, identity/contact verification, qualification, CRM approval, initial draft, reply handling, and all four follow-up stages.
11. Test provider dispatch and reconciliation with a non-production mailbox, including definitive failure, timeout/unknown outcome, bounce, complaint, unsubscribe, and account disablement.
12. Keep sending disabled until all acceptance checks pass and an administrator explicitly enables it.

---

## 8. Final verdict

**Campaign implementation:** Substantial / functionally broad.  
**Safety architecture:** Strong layered design, with a confirmed domain-suppression consistency defect requiring correction.  
**Qualification integrity:** Needs correction for unverified itch creator attribution.  
**Operational reliability:** Good queue/cursor foundations, but project enrichment/research refresh and pause semantics need tightening.  
**Production readiness:** **Not approved by this audit.** SQL integration, deployed migration reconciliation, browser E2E, source-policy approval, and live provider acceptance remain outstanding.

No source code, migrations, database records, credentials, provider settings, or worker processes were modified or activated during this audit.


---

## 9. Remediation update — 12 November 2026

All six findings above have been addressed in the follow-up bugfix repository. The fixes are in `INDIE_CAMPAIGN_CONFIRMED_BUGFIX_HANDOFF_2026-11-12.md`; they include parent-domain suppression protection, itch identity verification, research refresh for changed project observations, paused-campaign follow-up gating, removal of the ineffective Indie discovery-profile editor, and a Kickstarter fetch-boundary deny rule.

Validation after the fixes: Node suite **1,142 passed / 0 failed**; Python worker suite **911 passed / 0 failed**; six focused remediation regression tests passed. The new ZIP passed archive integrity validation. The production build remains unverified because Vite is absent from `node_modules`; SQL migration execution and browser E2E remain outstanding. No migration was applied, no deployment was performed, and no provider was contacted.

**Updated disposition:** static-code remediation complete; staging/database/browser acceptance still required before production activation.
