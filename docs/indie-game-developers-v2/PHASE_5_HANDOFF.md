# PHASE 5 HANDOFF — Indie Research Enrichment and Verified Contact Discovery

## 1. Phase outcome

Session 5 adds deterministic, evidence-backed research enrichment and administrator verification actions for Indie Game Developers. It does not implement personalized outreach, reply-state handling, follow-up scheduling, or Session 7 frontend/E2E release work.

The research worker now:
- records exact literal mentions of the developer/studio and project title as evidence candidates without treating those mentions as independent identity verification;
- extracts explicit dated development updates only when a page's own `<time datetime>` or Article/BlogPosting/NewsArticle `datePublished` is accompanied by matching development/update content;
- keeps project announcement dates and future marketing milestones separate from development activity;
- stores public image/video references as unverified visual candidates for human review;
- never uses page crawl time, generic CMS `dateModified`, newest-list position, or release dates as activity evidence.

Kickstarter remains manual-only. The Kickstarter URL is never fetched. Research is only queued against the separately supplied official developer website. Steam and itch remain disabled/unverified pending administrator terms review.

## 2. Administrator verification workflow

Migration `20261112180000_intelligence_indie_research_verification_v5.sql` adds three Master User-only, organization-scoped RPCs:

1. `intel_admin_add_indie_evidence(...)` records a reviewed source snippet. It accepts a bounded allowlist of identity, contact, visual, activity, announcement, and marketing evidence types. Date-dependent evidence requires an explicit date; visual evidence requires a media URL. The evidence URL must match the recorded official developer website or a non-Kickstarter project source.
2. `intel_admin_verify_indie_identity(...)` requires two separate administrator-reviewed evidence rows: one for the exact developer/studio name and one for the exact game title, both on the official developer website. It records reviewer, timestamp, evidence IDs, and verified developer name. Kickstarter creator role is stored separately and only when explicitly supplied.
3. `intel_admin_verify_indie_contact(...)` requires the exact email address in an administrator-reviewed evidence row on the official developer website. It rejects protected entities, prospect-level suppression flags, and email/domain suppression, bounce, complaint, unsubscribe, and DNC conflicts.

The new RPCs are revoked from `public` and `anon`, granted to `authenticated`, and call `intel_admin_org()` for the existing Master User authorization boundary. They do not qualify a prospect, create a CRM lead, draft an email, or send anything.

No frontend verification panel was added; Session 7 owns UI integration. The admin RPCs provide the server-side capability and enforcement boundary for that UI.

## 3. Files added, changed, removed

### Added
- `intelligence-worker/kairflow_intel/indie_evidence.py`
- `intelligence-worker/tests/test_indie_evidence_v5.py`
- `intelligence-worker/tests/test_indie_research_v5_migration.py`
- `docs/INDIE_GAME_RESEARCH_V2.md`
- `docs/indie-game-developers-v2/PHASE_5_HANDOFF.md`
- `supabase/migrations/20261112180000_intelligence_indie_research_verification_v5.sql`

### Changed
- `intelligence-worker/kairflow_intel/research.py`
- `docs/INDIE_GAME_DISCOVERY_V2.md`

### Removed
- `paystack-live.env.txt` — removed because the Phase 4 archive contained a live payment-provider secret in this file. The credential must be rotated immediately in the payment-provider dashboard. Removing the file from this clean Phase 5 archive does not revoke or invalidate the previously exposed key.

No other application files were removed. No `.env` secrets, provider tokens, private keys, local virtual environments, dependency caches, or build outputs are included in the Phase 5 archive.

## 4. Contact policy

- Only addresses actually published on the developer's own pages are extracted; no address guessing or synthesis is permitted.
- Contact forms without an email remain not-contactable.
- Official-domain emails require exact source evidence and human confirmation or provider delivery evidence.
- Personal mailboxes remain Indie-only and require exact-address affiliation evidence plus human confirmation or provider delivery evidence. A bare affiliation boolean is insufficient.
- Bounce, complaint, unsubscribe, DNC, and domain/email suppression remain hard blocks. Suppression lookup failure continues to fail closed during qualification.

## 5. Qualification and source safety

- The existing `indie-project-v2` 100-point scorer and seven mandatory gates remain authoritative.
- Kickstarter creator attribution remains unverified until the administrator identity-verification RPC succeeds. A creator, publisher, or organizer is not assumed to be the developer.
- Visual media candidates have `verified=false` and cannot satisfy the anime visual gate. A human-reviewed visual evidence type or explicit official anime/manga visual-style description is required.
- Dated development evidence uses existing scorer-recognized fact types. Upcoming marketing milestones are separately date-bound. Discovery recency is not active development.
- Existing protected-account, suppression, qualification, contactability, CRM approval, and send-boundary controls are unchanged.

## 6. Tests and validation

| Check | Result |
|---|---:|
| Python unit tests (`python -m unittest discover -s tests -t . -q`) | **843 passed, 0 failed** |
| Python compile check (`python -m compileall -q kairflow_intel tests`) | **Passed** |
| Frontend/Node tests (`npm test`) | **1,126 passed, 0 failed** |
| Targeted research/contact/migration tests | **67 passed, 0 failed** |
| ZIP integrity | **Passed** |
| Secret scan of delivery tree | **No credential file or live payment key found after removal** |

The Python suite continues to print the repository's existing preflight diagnostics: Gemini quota/auth warnings, an Ollama structured-output/model availability warning in one probe, and a draft-RPC signature probe warning before a later 11-argument signature resolution. These did not fail unit tests and are not evidence of production health.

## 7. Not tested / environment limitations

- PostgreSQL migration execution and RPC/RLS integration: no PostgreSQL, `psql`, Supabase CLI, or connected staging database was available. SQL received static review and repository contract tests only.
- Frontend production build: attempted but blocked because `node_modules/vite/bin/vite.js` is absent. `npm test` passed.
- Browser end-to-end workflow: no running app/browser E2E environment.
- No live platform requests, Steam/itch/Kickstarter access, provider-delivery tests, CRM mutations, outbound email, or production deployment were performed.
- No production migration history or suppression records were inspected.
- ZIP contains no `.git` metadata; branch, commit, and working-tree state cannot be verified.

## 8. Migration and deployment caution

The migration is **not applied**. Repository migration filenames extend through December 2026, later than the audit date. Reconcile the actual deployed Supabase migration ledger before applying any migration. Apply in a reviewed staging environment first and verify function grants, RLS, date-sync triggers, exact evidence constraints, and suppression gates. No production or staging database was changed.

## 9. Security issue inherited from Phase 4

The supplied Phase 4 archive contained `paystack-live.env.txt` with a live payment-provider secret. The file has been removed from the Phase 5 source tree and delivery archive, and a filename/pattern scan of the clean tree found no remaining credential file or matching live key. Because the Phase 4 archive was already delivered, the owner must rotate the exposed credential immediately. This phase cannot revoke it.

## 10. Exact next steps for Session 6

1. Start from `KairFlow_Indie_V2_Phase_5.zip` only.
2. Implement project-specific, evidence-ID-grounded initial outreach. Require a grounded game detail, relevant cinematic opportunity, a concise Studio Kairegi introduction as an anime animation studio, and a natural question.
3. Block portfolio and studio website links from initial emails; share portfolio only after an explicit request.
4. Preserve pricing exclusions, NDA restrictions, compliance footer, URL/claim validation, similarity checks, and human approval.
5. Implement deterministic reply outcomes and actions, with unsubscribe/complaint/DNC precedence and reply interruption of cold follow-ups.
6. Implement Day 5 / Day 10 follow-ups and reasoned Month 3 / Month 6 re-engagement, without sending after a reply.
7. Do not begin Session 7 frontend integration, browser E2E, or release completion.

## 11. Repository archive

The complete clean repository is delivered as `KairFlow_Indie_V2_Phase_5.zip`. The archive is created from the Phase 4 repository with Session 5 changes and the exposed payment-secret file removed. It is reopened, integrity-tested, and checked for required worker code, tests, migration, and documentation.
