# KairFlow Indie Game Developers V2 — Phase 5 Corrective Handoff

**Date:** 2026-11-12  
**Starting point:** `KairFlow_Indie_V2_Phase_4.zip`  
**Scope:** Phase 5 — Research Enrichment and Verified Contact Discovery  
**Mode:** Corrective implementation; Phase 6 not started.

## 1. Objective

Close the confirmed Phase 5 defects from the audit while preserving the Phase 4 repository and existing campaign, suppression, protected-account, qualification, and email-safety behavior.

## 2. Work completed

### 2.1 Activity-date monotonicity

- Research now compares newly extracted development-update dates with the dates already stored on the prospect and in verified facts.
- `project_latest_activity_date` is updated to the maximum valid ISO date; partial or older fetches cannot move it backwards.
- Announcement dates are retained as a separate field and reconciled to the earliest valid announcement date.

### 2.2 Identity and contact verification provenance

- Research preservation now includes `kickstarter_creator_role_verified` as well as the creator role.
- Contact verification audit fields are preserved across refreshes: `contact_verification_method`, `contact_verified_at`, and `contact_verified_by`.
- Existing employee/personal-email affiliation evidence, source URLs, delivery evidence, and suppression fields continue to be preserved.

### 2.3 Suppression-aware research assessment

- Research independently calls `intel_agent_indie_suppression_facts` before returning a contactability assessment for indie prospects.
- Prospect-level suppressed, unsubscribed, do-not-contact, bounce, complaint, and complaint-alias flags are applied to the assessment.
- Suppression lookup errors or incomplete responses raise `TransientError`; research cannot report an address as contactable when suppression status cannot be established.
- Existing worker preflight and qualification gates remain in place as separate safeguards.

### 2.4 JSON-LD announcement and graph extraction

- JSON-LD `NewsArticle`, `Article`, and `BlogPosting` nodes are now accepted when the headline/name/description/article body contains activity, announcement, or marketing-opportunity language.
- `ANNOUNCEMENT_RE` is included in the initial content gate, fixing the missed-announcement defect.
- Nested `@graph` objects and arrays are traversed.
- Only explicit `datePublished` is used; generic `dateModified` is still not treated as development activity.

### 2.5 Persisted visual-review queue count

- `visual_review_pending_count` is now calculated from persisted `visual_asset_candidate` evidence plus newly discovered candidates.
- Duplicate asset URLs are counted once.
- A candidate is removed from the pending count only when a verified administrator-review visual evidence row explicitly references the same media URL.
- Visual candidates remain unverified until a human inspects the asset.

### 2.6 External personal-email evidence workflow

- Added migration `20261112191000_intelligence_indie_research_integrity_v6.sql`.
- Added a narrowly scoped administrator RPC, `intel_admin_add_indie_contact_evidence`, for public non-Kickstarter contact evidence.
- External evidence must contain the exact email, a named developer/authorized contact, and an explicit role/affiliation term. Private/local hostnames and Kickstarter URLs are rejected.
- The contact-verification RPC now distinguishes official-site evidence from administrator-reviewed external affiliation evidence.
- Suppression, bounce, complaint, opt-out, protected-account, exact-email, organization, and administrator checks remain enforced.
- The admin panel now routes `contact_email` evidence through the new RPC and explains the stricter requirements for external professional profiles.
- Identity, anime-style, project, visual, and activity evidence remain restricted to official developer/project sources; this change does not broaden those evidence types.

## 3. Important architecture decisions

- No automated Kickstarter crawler or undocumented Kickstarter API access was introduced.
- External contact evidence is limited to the contact-email evidence type and requires explicit administrator review.
- A personal mailbox is not accepted merely because it appears on a third-party page; the exact address and named developer/team relationship must be documented, and deliverability evidence remains required by the contactability engine.
- Existing Phase 4 behavior and all unrelated CRM/email systems were left in place.

## 4. Files changed

- `intelligence-worker/kairflow_intel/research.py`
- `intelligence-worker/kairflow_intel/indie_evidence.py`
- `intelligence-worker/tests/test_indie_evidence_v5.py`
- `intelligence-worker/tests/test_indie_qualification_v2.py`
- `intelligence-worker/tests/test_phase4_research_routing.py`
- `intelligence-worker/tests/test_indie_research_integrity_v6.py` (new)
- `supabase/migrations/20261112191000_intelligence_indie_research_integrity_v6.sql` (new)
- `src/intelligence/api.js`
- `src/intelligence/IndieAdminPanel.jsx`
- `PHASE_5_CONFIRMED_BUGFIX_HANDOFF_2026-11-12.md` (new)

No files were intentionally removed or renamed.

## 5. Database migrations

New migration:

`supabase/migrations/20261112191000_intelligence_indie_research_integrity_v6.sql`

It adds the restricted external contact-evidence RPC and replaces the contact-verification RPC with the external-affiliation-aware version. It has **not** been applied to a live database in this environment.

## 6. Tests executed

### Python

Command:

```bash
cd intelligence-worker
python -m unittest discover -s tests -t .
```

Result: **899 tests passed, 0 failed**.

Focused Phase 5 / qualification / routing command:

```bash
python -m unittest tests.test_indie_evidence_v5 tests.test_indie_research_integrity_v6 tests.test_indie_qualification_v2 tests.test_phase4_research_routing -q
```

Result: **101 tests passed, 0 failed**.

New regression coverage includes:

- activity dates cannot regress;
- creator-role verification and contact audit metadata survive refresh;
- suppression flags prevent a contactability pass;
- suppression lookup failure holds research;
- JSON-LD announcement extraction;
- nested JSON-LD `@graph` extraction;
- visual pending counts reconcile persisted candidates with exact reviewed media URLs;
- external-contact RPC and UI contracts.

### Node/frontend contract tests

Command:

```bash
npm test
```

Result: **1,139 tests passed, 0 failed**.

### Static Python validation

`py_compile` passed for the modified research/evidence modules and regression tests.

## 7. Tests not executed / limitations

- PostgreSQL migration execution and live RPC integration tests were not run because PostgreSQL/Supabase is not available in this environment.
- Production RLS and authorization behavior for the new RPC must be verified after applying the migration to the target Supabase project.
- `npm run build` was not run because `node_modules/vite/bin/vite.js` is not installed in this repository environment.
- Live external professional-profile evidence was not fetched; the workflow is administrator-entered and source-backed by design.
- The Python test runner's separate environment preflight emitted Ollama model/structured-output and draft-RPC probe warnings. The 899 Python unit tests themselves passed; these preflight warnings are not represented as test failures.

## 8. Known issues / unresolved items

- The new SQL migration is pending deployment and must be validated against the actual database schema before production use.
- External profile evidence is a human attestation workflow; it does not independently authenticate third-party profile ownership.
- Contactability still requires the existing human confirmation or positive delivery evidence and exact affiliation evidence. No SMTP probing was added.
- Production readiness is not claimed until database migration, RPC authorization, and frontend build checks are completed.

## 9. Security and safety considerations

- No secrets or credentials were added to the migration, report, or test fixtures.
- External evidence is rejected when the URL is Kickstarter or a local/private hostname.
- The new external-evidence function is granted only to `authenticated` and calls `intel_admin_org()` for organization/admin authorization.
- Suppression checks are performed both when evidence is added and when contact verification is committed.
- Protected accounts and outbound suppression safeguards remain unchanged.

## 10. Deployment instructions

1. Back up the target Supabase database and review the migration.
2. Apply `20261112191000_intelligence_indie_research_integrity_v6.sql` after the existing Phase 4/Phase 5 migrations.
3. Verify the two RPC signatures exist:
   - `intel_admin_add_indie_contact_evidence(uuid,text,text)`
   - `intel_admin_verify_indie_contact(uuid,text,uuid)`
4. Verify execute grants are limited to `authenticated`; test that a non-admin authenticated user is rejected by `intel_admin_org()`.
5. In a staging organization, test official-domain contact evidence, external profile evidence with exact email/name/role, missing association, Kickstarter URL, suppressed email, bounced email, and unsubscribe/DNC flags.
6. Run the full Python and Node test commands above in the deployment environment.
7. Install the repository's locked dependencies and run `npm run build`.
8. Only then deploy the worker/frontend and manually verify the Indie contact-review workflow.

## 11. Exact next-session instructions

- Start from `KairFlow_Indie_V2_Phase_5.zip` delivered with this report.
- Do not restart from the original repository or the Phase 4 ZIP.
- Before Phase 6, apply and validate the Phase 5 migration in staging and verify the contact-review workflow.
- Phase 6 scope remains personalized outreach, reply classification, human approval, and follow-up interruption. Do not rewrite Phase 5 qualification or evidence behavior unless a newly confirmed defect requires it.

## 12. Repository archive verification

The complete repository archive was created as `KairFlow_Indie_V2_Phase_5.zip` and checked with `unzip -t`. It contains the full project source, migrations, tests, documentation, and configuration templates, excluding secrets, dependency caches, Python bytecode/cache directories, and build artifacts.
