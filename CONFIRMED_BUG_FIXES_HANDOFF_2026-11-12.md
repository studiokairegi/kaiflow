# KairFlow Combined Repository — Confirmed Bug Fixes Handoff

**Date:** 2026-11-12  
**Baseline:** Uploaded `KairFlow_Indie_V2_Combined_2026-11-12(1).zip`  
**Scope:** Source-only corrections to the confirmed/deferred Agent Chat issues and campaign-specific follow-up enforcement.

## Fixed in this pass

### 1. Campaign-specific follow-up ceiling
- Added `supabase/migrations/20261230100000_intelligence_campaign_followup_send_cap.sql`.
- A `BEFORE UPDATE OF state` trigger enforces the ceiling exactly when an outbound follow-up transitions to `sending`.
- Indie Game Developers: `min(configured max_followups, 4)`.
- All other campaign types: `min(configured max_followups, 3)`.
- Counts other reserved/sending/sent/unknown follow-ups for the same prospect, and fails closed if campaign type or settings cannot be verified.
- The Phase 8 final-send RPC locks organization settings before the transition, serializing the check with other organization sends.
- Updated the historical `20261109160000_intelligence_chat_actions.sql` validator and the new upgrade migration so Agent Chat accepts `max_followups=4` (the setting remains capped by campaign type at the final send boundary).

### 2. Deferred Agent Chat Python patch
Ported the confirmed-bug chat corrections onto the Phase 6/7 worker instead of replacing it with the older worker snapshot:
- Looking up/showing an existing draft is not classified as an order to create a draft.
- Negation is clause-scoped; a later explicit draft request still works.
- Recipient parsing handles trailing topics and names containing “and”.
- Role recipients such as “my accountant” fall through to ordinary writing help instead of being treated as an Intelligence prospect.
- Unexpected non-retryable failures leave a user-visible error reply; retryable `TransientError`/`RpcError` still propagate for retry.
- Non-finite/overflow numeric arguments are dropped safely.
- Prepared proposals are described as awaiting explicit confirmation, not as completed actions.
- Added `intelligence-worker/tests/test_chat_fixes.py`.
- Preserved Phase 6/7 Indie campaign logic and the Python chat setting range `0–4`.

## Validation

| Check | Result |
|---|---:|
| Node test suite (`npm test`) | **1,138 passed, 0 failed, 0 skipped** |
| Python worker suite (`python -m unittest discover -s tests -t . -q`) | **882 passed** |
| Focused chat + Indie sequence + migration contract tests | **37 passed** before the final additional validator assertion was added; the full Python suite subsequently passed with 882 tests |
| Python compileall | Passed |
| ZIP integrity | Checked after packaging |
| Production frontend build | **Blocked**: Vite is absent at `node_modules/vite/bin/vite.js` |
| PostgreSQL migration execution | Not run; no PostgreSQL/Supabase staging database available |
| Deno/browser E2E | Not run in this environment |

## Safety and scope boundaries
- No migrations were applied to a live database.
- No production/staging provider was contacted.
- No emails were sent, mailbox sync started, CRM records changed, or deployments performed.
- Human approval and Phase 8 final-send checks remain in place.
- No credentials were added. The previously exposed Paystack credential still requires rotation at the provider; removing its file does not revoke it.

## Remaining acceptance work
1. Apply the migration in a disposable PostgreSQL/Supabase staging environment and verify: Indie 4th follow-up can pass when configured to 4; non-Indie 4th follow-up is rejected; all sends remain subject to approval, suppression, permission, campaign, daily-cap and kill-switch checks.
2. Install the locked frontend dependencies and run the production build.
3. Run browser E2E and the complete Python suite on a clean CI host (including worker-lock tests).
4. Complete controlled provider acceptance before enabling any live mailbox sync or sending.

**Release status:** Source-level confirmed-bug fixes implemented and regression suites pass. Not production acceptance.
