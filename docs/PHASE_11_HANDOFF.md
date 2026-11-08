# KairFlow Intelligence — Phase 11 Handoff

**Phase:** 11 — Security and controller hardening  
**Status:** Local implementation and regression tests complete; deployed and PostgreSQL acceptance remains outstanding.  
**Disposition:** Do not treat this as a production security certification. Apply and verify the migration and deployment configuration in a disposable/staging environment before production rollout.

## 1. Objective

Address controller authentication, DNS rebinding and SSRF, Edge Function CORS, endpoint authorization, RLS/grants and privileged-user protection, and safe handling of environment secrets.

## 2. What was inspected

- Local worker controller routes, origin/Host checks, worker process lifecycle, Windows installer/uninstaller and Intelligence Settings UI.
- Public page Fetcher, allowlisted discovery API client, DNS pinning, urllib3 connection pools and SMTP transport.
- Every `supabase/functions/*/index.ts` endpoint and shared CORS/auth/OAuth/webhook helpers.
- Supabase function deployment configuration and the full source-level Intelligence authorization, RLS and grant migrations.
- Existing privileged-user guard in `migration_security_hardening.sql` and whether it was part of the ordered migration history.
- Local archive for environment files and secret-shaped values without printing any candidate values.

## 3. Changes

### A. Controller authentication

- Added a per-install bearer token stored in `%LOCALAPPDATA%\KairFlowIntelligence\controller.token`.
- Windows installer generates 32 random bytes using the OS cryptographic RNG and restricts the token file ACL.
- Controller compares tokens using `hmac.compare_digest` and requires the token for status/start/stop in addition to exact Host and Origin checks.
- The browser holds the token in component memory only and never persists it; the UI has a password field.
- Uninstaller now sends the bearer token when requesting a worker stop.
- CORS preflight remains unauthenticated but cannot perform an action.

### B. DNS rebinding / SSRF

- The allowlisted API client now pins the actual validated DNS result for its TCP connection, disables environment proxy inheritance and refuses redirects.
- Public IP validation now requires `ipaddress.is_global`, rejecting shared, special-use and documentation/benchmarking ranges.
- Fixed urllib3 2.x pool-manager initialization and pool-key handling so the pinned transport actually constructs correctly.
- SMTP was reviewed; its existing global-IP validation and pinned connection path were retained.

### C. Edge Function configuration and CORS

- Added `supabase/config.toml` with explicit `verify_jwt = false` for 19 endpoints that intentionally use a signed webhook, one-time OAuth state or capability token. Other endpoints retain Supabase's secure JWT-verification default.
- Reviewed the shared wildcard CORS policy. It remains intentionally non-credentialed for public capability viewers/media; `Access-Control-Allow-Credentials` is not set. The source now documents that CORS is not authentication.
- Added a streaming 4 KiB request-body cap and 120-per-minute IP and token-hash rate limits to the anonymous portfolio share lookup before token database lookup. Rate-limit infrastructure failure is fail-closed.

### D. Privileged-user protection and database authorization

- Added `20261201090000_intelligence_phase11_privileged_user_guard.sql` to the ordered migration chain. The migration installs and verifies the trigger that prevents authenticated users from self-granting `is_admin` or `plan`.
- Updated `supabase/tests/intelligence_authorization.test.sql` to test direct self-promotion and ensure privileged operations in the harness use the service-role claim.
- Updated `supabase/tests/run_intelligence_auth.sh` to apply the new migration twice.
- Existing strict Intelligence authorization and RLS/grant rules were retained.

### E. Secret handling

- No environment secret values were read, printed, modified or rotated.
- No populated local environment files were found in the uploaded archive. Added a placeholder-only `.env.example`; the non-disclosing pattern scan found only test-fixture-looking values. Remote deployment and Git-history exposure cannot be ruled out from this checkout.

## 4. Files changed

- `intelligence-worker/controller.py`
- `intelligence-worker/kairflow_intel/apis.py`
- `intelligence-worker/kairflow_intel/safety.py`
- `intelligence-worker/tests/test_controller.py`
- `intelligence-worker/tests/test_safety.py`
- `intelligence-worker/tests/test_discovery.py`
- `intelligence-worker/windows/install-controller.ps1`
- `intelligence-worker/windows/uninstall-controller.ps1`
- `intelligence-worker/.env.example` (new, placeholder-only template)
- `intelligence-worker/README.md`
- `src/intelligence/SettingsView.jsx`
- `src/intelligence/worker-control.test.mjs`
- `src/intelligence/worker-status-label.test.mjs`
- `src/intelligence/phase11-security-contract.test.mjs` (new)
- `supabase/config.toml` (new)
- `supabase/functions/_shared/cors.ts`
- `supabase/functions/portfolio-view/index.ts`
- `supabase/functions/google-drive-connect/index.ts`
- `supabase/functions/google-drive-callback/index.ts`
- `supabase/functions/patreon-connect/index.ts`
- `supabase/functions/patreon-callback/index.ts`
- `supabase/functions/freelancer-drive-upload/index.ts`
- `supabase/functions/intel-resend-webhook/index.ts`
- `supabase/migrations/20261201090000_intelligence_phase11_privileged_user_guard.sql` (new)
- `supabase/tests/intelligence_authorization.test.sql`
- `supabase/tests/run_intelligence_auth.sh`
- `README.md`
- `docs/PHASE_ROADMAP.txt`
- `docs/PHASE_11_SECURITY_FINDINGS.md` (new)
- `docs/PHASE_11_HANDOFF.md` (new)

## 5. Tests and verification

- Full JavaScript suite: **813 passed, 0 failed**.
- Full Python worker suite: **448 passed, 0 failed**.
- Python `compileall`: passed.
- Phase 11 targeted controller, SSRF, API-client and contract tests: passed.
- Supabase `config.toml`: parsed successfully; 19 intentional JWT bypasses were cross-checked against source declarations.
- ZIP integrity: checked after packaging.
- Frontend production build: not run successfully because `vite` is not installed in this environment.
- Deno type-check: not run because Deno is unavailable.
- PostgreSQL migration and SQL authorization harness: not run because `psql`, Docker and Supabase CLI are unavailable.

The Python unit runner also invokes optional live preflight probes after the test suite. Some environment-dependent Ollama/RPC probes reported failures in this environment; these are separate from the **448 passing unit tests** and are recorded as deployment acceptance work, not hidden as test passes.

## 6. Remaining acceptance work

1. Apply the new migration in a disposable PostgreSQL/Supabase database; run the updated SQL authorization test harness and verify idempotency.
2. Deploy with the checked-in Supabase config and inspect deployed `verify_jwt` settings, RLS, table grants, function grants and privileged-user trigger.
3. Test controller token acceptance/rejection on Windows and restart the scheduled task using the updated installer.
4. Verify production and untrusted-origin CORS behaviour.
5. Run Vite production build and Deno type-check in an environment with dependencies/tooling installed.
6. Review remote secret inventory and repository history through the authorized deployment/repository controls; rotate any confirmed exposed secret without disclosing its value.

## 7. Safety confirmation

- No production or staging database changed.
- No migration was applied.
- No Edge Function was deployed.
- No environment secret was read, printed, changed or rotated.
- No provider account was connected, enabled or activated.
- No worker was started, stopped or restarted.
- No Git push or production deployment occurred.
- No autonomy, approval or kill-switch setting changed.
- No email was sent.
- Dynamic Gmail/Zoho/SMTP multi-account outreach, Zoho human approval, Resend separation and Phase 8 global human approval remain unchanged.

## 8. Stop condition

Phase 11 local implementation is complete. Stop here. **Phase 12 — Worker reliability and operational status** is next, but requires separate authorization after Phase 11 acceptance.

## 6. Corrective audit and fixes

A follow-up security audit identified and corrected three anonymous rate-limiting defects:

- All public IP rate-limit identities now come only from Cloudflare's platform-injected `CF-Connecting-IP`; untrusted `X-Forwarded-For` is never used. If the trusted header is absent, requests fail closed.
- `PORTAL_HASH_PEPPER` is mandatory and must be at least 32 characters for public actions in `portfolio-view`, `portal-chat` and `push`. Missing/weak configuration fails closed rather than hashing with an empty secret.
- The new migration `20261201100000_intelligence_phase11_atomic_portal_rate_limit.sql` serializes each `(scope, subject_hash)` bucket with a transaction-scoped PostgreSQL advisory lock before the count/decision/insert, preventing concurrent over-admission.

The deployment guide now identifies the pepper as required. The access/chat SQL harness applies the corrective migration twice. The Node regression suite exercises spoofed forwarding headers and missing/weak peppers.

**Corrective validation:** JavaScript suite **816 passed, 0 failed**; Python worker suite **448 passed, 0 failed**; ZIP integrity passed. PostgreSQL migration replay/concurrency validation, Deno type-check and frontend production build remain outstanding because the corresponding tools are unavailable in this environment. Set `PORTAL_HASH_PEPPER` to a securely generated random value of at least 32 characters before deploying these endpoint changes.
