# Manual Lead Email Composition — Phase 6: Security, Testing & Regression Validation

**Baseline:** `00_repo_33_phase5-limitations-fixed.zip`
**Status:** Verification complete. **No production code, migration or database change.** Nothing deployed, no real email sent.
**Result:** `npm test` **1009 passed, 0 failed** (987 baseline + 22 new).

> Not to be confused with the older `PHASE_6_*` files in `docs/`, which belong to the Intelligence and multi-provider email roadmaps.

## Files changed
- `src/email/phase6-security.test.mjs` (new, 22 tests)
- `docs/PHASE_6_COMPOSER_SECURITY_REPORT.md` (new, this file)

Migrations: none. A diff against the original zip shows these are the only differences. No file under `intelligence-worker/` or `supabase/functions/intel-*` was touched.

## Checklist results

| Roadmap item | Evidence | Result |
|---|---|---|
| Verify RLS and authorization | Tests 1–3, 5–8: RLS on all 14 email tables; no client write grant on any; credential/OAuth/sync/webhook tables service-role only with no policy; all 40+ `SECURITY DEFINER` functions pin `search_path`; 20 server-only functions never granted to `anon`/`authenticated`; every browser RPC calls `email_require_access()` and filters by organization; `email_link_lead` and `email_create_outbound` check lead ownership in the database | Pass (static) |
| Test account isolation | Tests 12–14: another organization's account, unknown account, paused account, someone else's lead, lead/conversation conflict, no/invalid token, restricted user all refused; each creates **no** message row, makes **no** provider call, records **no** CRM activity | Pass |
| OAuth tokens remain server-side | Tests 4, 9–11: `email_accounts` has no secret-like column; ciphertext only in `email_provider_credentials`; browser code references no credential table, vault module, service-role key or provider secret; `.env.example`/Vite expose none; `email-send` authenticates with the caller's JWT + anon key and reads the service key once, for the store. Existing vault tests (AES-256-GCM, account/provider binding, wrong key/binding rejected) still pass | Pass |
| Successful and failed sending | Tests 15, 17, 18: success reaches the provider once and records one CRM activity, without leaking the lead id or provider key; provider rejection and network error record no CRM activity and are never reported as sent | Pass |
| Retries and duplicate prevention | Test 16 (+ existing 4C tests): repeating a key is a lookup, never a second provider call | Pass |
| CRM recording recovery | Test 19: CRM write failure after acceptance still returns success with `activity: "pending"`, no second send | Pass |
| Disconnected accounts | Tests 14, 21: paused, disabled, unknown, and unconnected/reauth-required/expired OAuth accounts cannot be selected; an OAuth provider with no compiled adapter is refused server-side | Pass (see F1) |
| Leads without emails | Test 20: no/blank/invalid email, archived, unsaved id, colleague's lead → no Compose; only valid addresses used | Pass |
| Replies and lead associations | Existing Phase 4D/5 tests (`crm-attribution-corrective`, `phase5-sync`) and `email_crm_inbound_timeline.test.sql` | Pass for JS; **SQL not re-run** (see limitations) |
| Existing Inbox intact | Full pre-existing suite unchanged and green | Pass |

**Mutation check:** I deliberately broke the code five ways (a client write grant, RLS removed from a table, a `refresh_token` reference in the browser, archived leads allowed to compose, a server-only function granted to `authenticated`). Each was caught by the intended test, and the files were restored byte-for-byte.

## Findings

- **F1 — Low, latent.** `email-send` checks `account.status` but not `connection_status`. The browser (`accountCanSend`) and the mailbox sync both enforce `connected`. Today only the Resend adapter is compiled and Resend accounts need no OAuth connection, so this is unreachable. **Before any OAuth provider send adapter is enabled, enforce `connection_status = 'connected'` server-side** for providers whose registry row declares `oauth: true`. Test 14 pins today's safe refusal.
- **F2 — Informational (design).** Leads are owned per user, email access is per organization. A teammate's lead cannot be emailed or linked by you; the UI hides Compose and the server and database both refuse. It fails closed.
- **F3 — Informational.** `email_accounts.last_connection_error` is readable by every organization member, and nothing writes it yet. When a writer is added, pass the text through `sanitizeProviderMessage`.

No defect requiring a code change was found, so none was made.

## Unresolved issues and limitations
- **SQL tests not run.** The sandbox has no PostgreSQL and no network. The `supabase/tests/*.sql` files (including `email_crm_activity`, `email_crm_inbound_timeline`, `email_phase4f_validation`) were not executed. The static checks above read migrations in timestamp order and approximate the final state; they do not prove live RLS behavior. **Run the SQL tests against the full migration chain in your environment**, and a manual cross-organization check with two real users.
- **`npm run build` not run** (`node_modules` is not in the zip; no network).
- **No browser or responsive check, and no live provider or webhook test** (by rule: no real prospect email).
- **Carried from Phase 5:** inbound replies from before the timeline migration or before a lead link are not backfilled; the open lead timeline refreshes every 30 s.
- The existing SQL runner (`run_intelligence_auth.sh`) was already failing at its baseline per the Phase 5 notes.

## Suggested approval gate
Approve security and testing results, with F1 accepted as a documented precondition for any future OAuth sending, and the SQL-chain run done on your side. **Phase 7 has not been started.**
