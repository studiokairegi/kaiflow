# PHASE 4 HANDOFF — Kickstarter Project Discovery

## 1. Phase outcome

Session 4 is complete as a **terms-gated, manual-only Kickstarter intake workflow**. Kickstarter's published Terms of Use prohibit automated crawling/spidering and require prior written permission for commercial use of site content. No automated Kickstarter search, category scan, pagination, page parsing, creator-profile collection, search-engine harvesting, or contact extraction was added. The source registry includes Kickstarter but it is forced disabled/unverified with zero budget; the source-admin RPC rejects attempts to enable it in this release.

This is a deliberate access constraint, not an incomplete scraper. If written permission or a documented official API license is obtained later, that authorization must be reviewed and recorded before implementing automated discovery.

## 2. What was implemented

- Added the `kickstarter` source registry key and a per-organization disabled/unverified row for Indie Game Developers campaigns only.
- Added the admin-only `intel_admin_add_kickstarter_project` RPC.
- Added a manual intake panel in the Indie Game Developers campaign view.
- Inputs: canonical Kickstarter project URL, project title, creator name, optional developer/studio name, optional separate official developer website, short administrator-authored notes, required prior-written-permission attestation, and an internal permission reference.
- Server-side URL, required-field, permission-attestation, and permission-reference validation; canonical URL normalization; idempotent source-item upsert keyed by the canonical Kickstarter project URL.
- Persists as `game_project` under `kickstarter_manual`, with a stable source URL and administrator-submitted attribution metadata.
- Reuses the existing durable `manual_post` queue kind and job leasing/retry machinery; the worker routes Kickstarter items to a dedicated handler.
- The worker revalidates URL structure, performs no Kickstarter fetch, stores the project using Phase 3 project-first identity, and preserves the Kickstarter URL as provenance.
- Creator identity, developer identity, and creator role remain explicitly unverified. Administrator entry is not treated as verification. The Phase 2 project-identity gate explicitly fails Kickstarter manual candidates until `developer_identity_status` is independently verified.
- Research is queued only against the separate official developer website entered by the administrator. The Kickstarter project URL is never handed to the research fetcher. Missing official websites are flagged for manual review.
- Research refresh preserves Kickstarter creator/developer attribution and intake provenance fields.
- Existing protected-account, suppression, qualification, contactability, and human approval gates remain unchanged.

## 3. Files added, changed, or removed

### Added
- `docs/KICKSTARTER_DISCOVERY_V2.md`
- `docs/indie-game-developers-v2/PHASE_4_HANDOFF.md`
- `supabase/migrations/20261112170000_intelligence_kickstarter_manual_intake_v4.sql`

### Changed
- `src/intelligence/api.js`
- `src/intelligence/CampaignView.jsx`
- `src/intelligence/DiscoveryPanels.jsx`
- `src/intelligence/kickstarter-manual-intake-v4.test.mjs`
- `intelligence-worker/kairflow_intel/discovery.py`
- `intelligence-worker/kairflow_intel/research.py`
- `intelligence-worker/kairflow_intel/scoring.py`
- `intelligence-worker/tests/test_discovery.py`
- `intelligence-worker/tests/test_indie_qualification_v2.py`
- `docs/INDIE_GAME_DISCOVERY_V2.md`

### Removed
- None.

## 4. Database migration

Added `supabase/migrations/20261112170000_intelligence_kickstarter_manual_intake_v4.sql`.

It extends the source registry key constraint, creates a disabled/unverified Kickstarter row for organizations with an Indie campaign (and for future organizations), prevents the source-admin RPC from enabling automated Kickstarter access, and adds the administrator-only manual intake RPC. The intake RPC requires a prior-written-permission attestation and internal reference, validates a canonical Kickstarter project URL and required title/creator fields, stores a `game_project` source item, and enqueues a persistent `manual_post` job with an idempotency key. It does not fetch Kickstarter.

**Migration not applied.** No staging or production database was changed. The repository contains later-dated migrations through December 2026; reconcile the actual Supabase migration ledger before applying. Apply in staging first and verify the RPC grants and source-item/job constraints.

## 5. Tests and validation

| Check | Result |
|---|---:|
| Python unit tests (`python -m unittest discover -s tests -t . -q`) | **826 passed, 0 failed** |
| Python compile check | **Passed** |
| Frontend/Node tests (`npm test`) | **1,126 passed, 0 failed** |
| Targeted discovery tests | **56 passed, 0 failed** |
| Targeted Indie qualification tests | **50 passed, 0 failed** |

The Python run emitted the repository's existing live-preflight diagnostics: intermittent Ollama structured-output/model availability and PostgREST draft-RPC signature probe warnings; the later autonomous probe resolved the 11-argument signature without writing a record. Gemini quota/auth warnings were also present. These did not fail the 826 unit tests.

## 6. Not tested / environment limitations

- PostgreSQL migration execution and RPC/RLS integration: no connected database, `psql`, or Supabase CLI available.
- Frontend production build: attempted but unavailable because `node_modules/vite/bin/vite.js` is missing from the supplied repository copy. The Node test suite passed.
- Browser end-to-end workflow: no running application/browser E2E environment.
- No live Kickstarter requests were made, by design.
- No permission request to Kickstarter was submitted; source remains disabled/unverified.
- No production deploy or outbound email was performed.

## 7. Important constraints and unresolved items

1. Do not enable automated Kickstarter access based solely on a visible public project page, the Discover UI, or search-engine indexing.
2. The manual intake requires the administrator to attest that prior written permission covers commercial use and record an internal permission reference; this self-attestation is not independently verified by KairFlow. Obtain written permission or documented official API authorization covering automated discovery, storage, and use before adding any automated adapter.
3. Manual creator/developer attribution remains unverified. Identity verification belongs to Session 5.
4. If no separate official developer website is entered, the prospect is flagged for human review and not automatically researched from Kickstarter.
5. Exact developer/title matches can deduplicate with Steam/itch. Different creator/developer labels are not fuzzy-merged; review manually to avoid incorrect entity merges.
6. The migration is unapplied and must be staged after reconciling the deployed migration ledger.
7. Sessions 5–7 have not been started.

## 8. Exact next step

Session 5 should start from `KairFlow_Indie_V2_Phase_4.zip` only. Focus on evidence-backed developer/studio identity verification, official websites, dated activity/opportunity evidence, and eligible contact discovery. Keep Kickstarter as manual provenance unless a written authorization has been obtained. Do not begin outreach or frontend end-to-end campaign completion (Sessions 6–7).
