# PHASE 2 HANDOFF — Indie Game Developers Qualification and Scoring V2

## 1. Phase objective

Replace the restrictive Indie Game Developers qualification rules with a project-first, evidence-driven 100-point scoring model. Preserve Animation Studio Support behavior, existing CRM history, provider-neutral email architecture, AI routing, human approval, RLS, and send-safety controls.

**Phase 2 is implemented in the repository.** The database migration has been authored but has not been applied to any database. This handoff does not claim production readiness.

## 2. Work completed

### Scoring and qualification

Implemented the five requested categories, totaling exactly 100 points:

| Category | Maximum |
|---|---:|
| Anime visual identity | 30 |
| Active development evidence | 25 |
| Release and marketing timing | 25 |
| Indie partnership opportunity | 10 |
| Project identity and research confidence | 10 |
| **Total** | **100** |

Qualification bands are fixed in the worker and UI: 75–100 is Qualified only when all mandatory gates pass; 55–74 is Needs Review; below 55 is rejected/low priority according to evidence quality. A score cannot override a failed mandatory gate.

Removed the old qualification dependencies on animation need, multiple published games, wishlist counts, studio reputation, publisher relationships, publisher involvement, and animator recruitment. Publisher involvement does not add points or disqualify a developer in the V2 scorer. **The legacy Steam discovery adapter still has a publisher/developer filter; removing that discovery restriction belongs to Session 3.**

Activity points now require dated, verified development evidence. The discovery `recent_activity` boolean alone earns no points and cannot pass the activity gate. Project announcement, campaign, expected release, actual release, latest activity, and dated marketing milestones are stored separately.

Timing rules include the approximately six-month announcement window, upcoming release windows up to twelve months, deprioritization (not automatic rejection) of release dates beyond twelve months, review of unknown dates when activity/marketing evidence exists, and post-release qualification only with a meaningful new marketing opportunity.

Anime-style qualification requires verified visual evidence or an explicit anime/manga style description on an official project/developer source. JRPG, visual-novel, or Japanese-inspired labels alone do not satisfy the gate.

### Contact verification and safety

- Contact forms without a usable email are rejected.
- Personal email addresses (including Gmail, Outlook, and Proton) can pass the Indie path only when the exact address is verified and its association with the developer/authorized contact is supported by an official source or cited affiliation evidence.
- A contactability pass must include the exact prospect email and a valid HTTP(S) source URL.
- Suppression lookup failures fail closed to Needs Review; known unsubscribe, bounce, complaint, or other suppression conflicts block research/outreach and are marked suppressed.
- Protected accounts are checked before Indie discovery upsert and before research/crawling. Database guards also reject protected prospects and block outbound messages.
- Manual approval, lead creation, and linking to an existing lead require the V2 model, at least 75 points, all seven mandatory gates, and passing contactability.
- The outbound database guard checks the V2 model/score/gates, active status, exact `to_email` match, protected accounts, and live suppression state.

### Project-first research

An official project/store page can be used as the research starting point when a separate developer website is unavailable. This avoids treating a studio website as a mandatory qualification requirement for first-time developers. Existing verified project identity, dates, marketing milestones, contact evidence, and suppression flags are preserved when research refreshes facts.

### Database and frontend

Added typed project/date fields, verified-fact synchronization, Indie-only qualification/status guards, suppression and protected-account RPC support, manual-review guards, and outbound safeguards. Updated the campaign thresholds/help text and prospect modal to show project timing, marketing milestones, evidence IDs, and mandatory-gate reasons.

Animation Studio Support scoring and contactability behavior remain on their existing path. No email drafting, reply classification, follow-up schedule, Kickstarter engine, or broad source-discovery redesign was implemented; those belong to later sessions.

## 3. Important architecture decisions

1. Numerical scoring and mandatory qualification gates are separate. A high score never overrides project identity, activity/marketing opportunity, anime evidence, exact verified email, suppression, protected-account, or evidence requirements.
2. The worker and database independently enforce the V2 model and gate set. The database is the final authority for qualification and outbound sends.
3. Project timing is represented by separate typed columns and is synchronized only from explicit verified facts. Discovery timestamps and generic discovery recency are not substituted for project activity.
4. Official project/store pages are valid research entry points even without a separate developer website.
5. Personal email acceptance is an Indie-only exception with source-backed affiliation evidence; the default contactability path for other campaigns is unchanged.
6. Protected/suppressed checks occur before Indie crawling and again at database qualification and send boundaries.
7. Existing CRM lead rows, messages, replies, and conversation history are retained. Legacy Indie prospects with `qualified` status are moved to Needs Review so they must be rescored under V2; protected/suppressed records are rejected/suppressed instead.
8. Project-fact synchronization trigger is named to run before the Indie status guard. This is intentional because PostgreSQL runs same-timing triggers alphabetically.

## 4. Files added, changed, or removed

Relative to the Phase 1 repository ZIP:

### Added

- `docs/INDIE_GAME_DEVELOPERS_SCORING_V2.md`
- `intelligence-worker/kairflow_intel/protected_accounts.py`
- `intelligence-worker/tests/test_indie_qualification_v2.py`
- `src/intelligence/indie-qualification-v2-contract.test.mjs`
- `supabase/migrations/20261112140000_intelligence_indie_project_qualification_v2.sql`
- `PHASE_2_HANDOFF.md` (this report)

### Changed

- `intelligence-worker/kairflow_intel/contactability.py`
- `intelligence-worker/kairflow_intel/jobs.py`
- `intelligence-worker/kairflow_intel/research.py`
- `intelligence-worker/kairflow_intel/scoring.py`
- `intelligence-worker/kairflow_intel/signals.py`
- `intelligence-worker/tests/test_contactability.py`
- `intelligence-worker/tests/test_logic.py`
- `intelligence-worker/tests/test_studio_scoring.py`
- `src/intelligence/CampaignView.jsx`
- `src/intelligence/ProspectModal.jsx`
- `src/intelligence/logic.js`
- `src/intelligence/ui-logic.test.mjs`

### Removed

- None.

## 5. Database migrations created

Created one additive migration:

- `supabase/migrations/20261112140000_intelligence_indie_project_qualification_v2.sql`

It adds typed project/date fields; date parsing and verified-fact synchronization; protected-account and suppression checks; V2 qualification/status enforcement; Indie context/suppression/blocked-prospect RPCs; manual-review guards; and a send-boundary guard.

**The migration has not been executed.** No production or staging database was changed.

**Migration ordering risk:** the repository already contains later-dated migrations through `20261229120000`. This new migration's filename sorts before those later files. Before applying it, reconcile the actual deployed Supabase migration ledger and the repository's unusual future-dated migration history. Do not blindly apply it out of order. Review/apply it in a staging database first.

## 6. Tests executed and exact results

| Test/check | Result |
|---|---:|
| Python unittest discovery (`python -m unittest discover -s tests -t .`) | **807 passed, 0 failed** |
| Python compile check (`python -m compileall -q kairflow_intel tests`) | **Passed** |
| Frontend/Node test suite (`npm test`) | **1,123 passed, 0 failed** |

The full Python run also emitted live preflight diagnostics. One preflight path passed the installed Ollama model/structured-output checks; a second path reported a Qwen structured-output failure, a missing `qwen2.5:1.5b-instruct` model, and a `PGRST202` probe for the draft RPC's `p_force_review` signature. A later autonomous-mode probe resolved the 11-argument signature without writing a record. These are environment/integration warnings, not failures in the 807 Python unit tests; they need follow-up against the deployed environment.

## 7. Tests not executed and why

- Supabase migration execution and PostgreSQL trigger/RPC integration tests: no connected database, Supabase CLI, or `psql` runtime was available. SQL was reviewed statically and covered by repository contract tests only.
- Frontend production build: `node_modules` is absent in the supplied working tree, so a Vite/production build was not run. The Node test suite did run successfully.
- Browser-based end-to-end tests: no running application/browser test environment was available.
- Live email provider sends, reply ingestion, and follow-up interruption: deliberately not attempted; these are outside Session 2 and require controlled integration testing.
- Production deployment: not attempted.

## 8. Known bugs, risks, and unresolved issues

1. The Steam discovery adapter still rejects some third-party-published games based on publisher/developer mismatch. Session 3 must remove that discovery restriction while retaining the developer identity for research.
2. Kickstarter remains an unimplemented discovery source. Its persistent discovery engine is Session 4.
3. Broader research enrichment, creator/developer verification, and contact discovery remain for Session 5.
4. Personalized drafting, reply-state changes, and Day 5/Day 10 follow-ups remain for Session 6.
5. Full frontend workflow integration and end-to-end campaign validation remain for Session 7.
6. The migration's SQL has not been executed against PostgreSQL. Trigger order, grants, RLS behavior, and RPC signatures must be verified in staging.
7. The repository has no `.git` metadata, so branch name and working-tree status cannot be confirmed. The Phase 1 ZIP was used as the starting point; no Phase 1 files were removed.
8. The live preflight warnings described above require environment-level investigation.
9. The migration timestamp must be reconciled with the deployed migration ledger before application.

## 9. Security and safety considerations

- No secrets, credentials, `.env` files, private keys, or provider tokens were added to the repository.
- The migration does not delete CRM leads, sent messages, replies, or conversation history.
- Protected accounts are rejected before Indie crawling and blocked by database/send guards.
- Suppression lookup is fail-closed before research; known suppression conflicts are marked suppressed and blocked at qualification and send time.
- Personal email acceptance is limited to the Indie path and requires exact-address verification plus source-backed affiliation.
- Manual approval/linking and outbound sends require all V2 gates.
- Human approval and the existing provider-neutral email adapter architecture remain in place.
- Animation Studio Support behavior was covered by the existing Studio scoring/contactability tests.

## 10. Deployment and environment changes

- No new environment variables are required by this phase.
- Apply the database migration in a reviewed staging environment before deploying the worker/frontend code that calls the new RPCs and reads the new columns.
- Verify the actual Supabase migration ledger first because of the future-dated migration files in the repository.
- After staging verification, deploy the worker, then the frontend. Keep sending disabled/manual approval in place during validation.
- No production migration, production send, or live data mutation was performed in this session.

## 11. Exact next steps for Session 3

1. Start from `KairFlow_Indie_V2_Phase_2.zip` only. Read this report and inspect the entire delivered repository before editing.
2. Verify the Phase 2 scoring, project-date fields, protected/suppression guards, and tests; do not assume the migration has been applied.
3. Redesign Steam discovery to collect candidates broadly and remove the publisher/developer mismatch rejection. Retain publisher and developer as separate facts; research must identify the actual developer.
4. Keep discovery separate from final qualification. Sources should collect candidates/evidence; research and the V2 scorer make qualification decisions.
5. Improve pagination, incremental scans, deduplication, source provenance, retries, and recovery for Steam and itch.io where supported.
6. Investigate additional credible public game-development sources without bypassing platform access controls or terms.
7. Add tests for first-time developers, small teams, third-party-published games, and developer identity attribution.
8. Do not build the persistent Kickstarter engine in Session 3; that is Session 4. Preserve the Phase 2 qualification and safety gates.
9. Deliver the complete Phase 3 repository ZIP and `PHASE_3_HANDOFF.md` before ending Session 3.

## 12. Repository ZIP confirmation

The complete Phase 2 repository archive is created as `KairFlow_Indie_V2_Phase_2.zip`. The archive is reopened and integrity-tested; its file inventory is checked for required source, migration, tests, and documentation. The archive excludes secrets, local virtual environments, dependency caches, build caches, and transient generated files.
