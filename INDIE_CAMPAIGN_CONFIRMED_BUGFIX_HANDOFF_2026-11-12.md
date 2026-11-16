# Indie Campaign — Confirmed Bug Fix Handoff

**Date:** 12 November 2026  
**Base:** `KairFlow_Indie_V2_Phase_7_Confirmed_Bugfixes.zip`  
**Scope:** Correct the six confirmed findings in `INDIE_CAMPAIGN_END_TO_END_AUDIT_2026-11-12.md`.

## Changes made

### F-01 — Parent-domain suppression matching
- Added `_intel_indie_domain_matches(host, blocked_domain)` with exact-host and dot-boundary parent-domain matching. This avoids false matches such as `notexample.com` against `example.com`.
- Updated the Indie suppression-facts RPC to match the prospect domain and recipient email domain, including subdomains.
- Added a final database trigger on Indie message transitions into `reserved`/`sending`. It checks email and parent-domain suppressions and takes the same advisory policy locks for each parent suffix before allowing the transition. This is defense in depth alongside the Phase 8 send RPC.

### F-02 — itch.io creator attribution
- The mandatory project-identity gate now treats both `itch` and `kickstarter_manual` attribution as unverified unless `developer_identity_status` is `independently_verified`, `human_confirmed`, or `verified`.
- Added regression coverage proving an unverified itch creator fails and a verified identity passes.

### F-03 — Existing-project research refresh
- Indie discovery now enqueues a research refresh for an existing project when its observed website/source/facts signature changes.
- The idempotency key is derived from stable source data and excludes volatile discovery timestamps/cursors, preventing repeated identical polls from producing duplicate research jobs.
- Existing CRM/terminal states remain protected by the research handler's existing status gate; refresh does not reopen closed, rejected, suppressed, or already-converted prospects.

### F-04 — Campaign pause semantics
- Indie follow-up candidate selection now requires the associated Indie campaign to be active. Non-Indie campaigns retain their previous behavior, including legacy prospects without a campaign row.
- Worker-side follow-up/re-engagement drafting checks the Indie campaign status immediately before composition.
- Scheduled takeover follow-ups also stop when the Indie campaign is paused. Manual reply handling is not disabled by this follow-up-specific gate.

### F-05 — Misleading discovery-profile UI
- The shared news/feed/archive discovery-profile editor is now rendered only for `animation_studio_support`. It no longer appears on the Indie campaign where its approved terms were not consumed by Steam/itch discovery.

### F-06 — Kickstarter fetch-boundary protection
- The generic research function now rejects Kickstarter-host research targets before invoking the fetcher. Kickstarter remains manual-only; a separate official developer website must be supplied for research.
- Added a regression test proving the fetcher is never called for a Kickstarter-only project.

## Files changed

- `intelligence-worker/kairflow_intel/scoring.py`
- `intelligence-worker/kairflow_intel/jobs.py`
- `intelligence-worker/kairflow_intel/research.py`
- `intelligence-worker/kairflow_intel/takeover.py`
- `src/intelligence/CampaignView.jsx`
- `intelligence-worker/tests/test_indie_qualification_v2.py`
- `intelligence-worker/tests/test_indie_evidence_v5.py`
- `intelligence-worker/tests/test_indie_campaign_audit_fixes.py` (new)
- `supabase/migrations/20270101100000_intelligence_indie_campaign_safety_hardening.sql` (new)
- `supabase/migrations/20270101101000_intelligence_indie_pause_followups.sql` (new)

Historical migrations were left unchanged; fixes are delivered as forward-only migrations.

## Validation

| Check | Result |
|---|---:|
| Full Node test suite (`npm test`) | **1,142 passed, 0 failed** |
| Full Python worker suite | **911 passed, 0 failed** |
| New focused regression tests | **6 passed** |
| ZIP integrity | **Passed** — archive test reports no errors |
| Production frontend build | **Not run successfully** — Vite executable is absent from `node_modules` |
| PostgreSQL/Supabase migration execution | **Not run** — no local PostgreSQL/Supabase CLI/staging DB available |
| Browser E2E | Not run |

## Operational restrictions observed

- No migrations were applied to any database.
- No Edge Functions were deployed.
- No secrets or environment variables were changed.
- No worker was started.
- No Steam, itch.io, Kickstarter, or email provider was contacted.
- No email or campaign was sent.
- Existing kill switch, autonomy mode, sending caps, and provider adapters were not changed.

## Staging acceptance still required

1. Apply both new migrations to a disposable/staging Supabase database and inspect the function/trigger definitions.
2. Exercise exact-domain, subdomain, and unrelated-suffix suppression cases at the actual `intel_agent_mark_sending` boundary.
3. Verify concurrent suppression insertion serializes against the send guard.
4. Verify paused Indie campaigns produce no follow-up candidates and queued follow-up/takeover jobs settle without drafts.
5. Verify new Steam/itch observations refresh only researchable existing projects and do not reopen CRM/terminal states.
6. Verify Kickstarter-only research is rejected, while a separate official developer website remains researchable.
7. Run browser E2E and a production build after installing dependencies from the lockfile.
8. Keep Steam/itch source authorization disabled until current terms/access review is explicitly confirmed by an administrator.

**Disposition:** all six static-code findings have corresponding code or migration fixes and regression coverage. This handoff is not a production deployment approval because database execution, browser E2E, source-policy confirmation, and live provider acceptance remain outstanding.
