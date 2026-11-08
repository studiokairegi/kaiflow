# KairFlow Phase 11 — Security Findings

**Scope:** Controller authentication, DNS rebinding / SSRF, Edge Function CORS, endpoint authorization, RLS/grants and privileged-user protection, and secret handling.

## Findings and dispositions

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| S-11-01 | High | The loopback worker controller relied on Origin/Host checks without an independent credential. | Fixed with a random 256-bit per-install bearer token, constant-time comparison, authenticated status/start/stop routes, and token-file ACLs. |
| S-11-02 | High | The allowlisted discovery API client validated DNS but then let Requests resolve the hostname again. | Fixed by connecting to the validated public IP through the pinned transport, disabling environment proxies, and refusing redirects. |
| S-11-03 | Medium | The public-IP predicate admitted some special-use/shared ranges that are not globally routable. | Fixed by requiring `ipaddress.is_global`; added CGNAT, documentation, benchmarking and reserved-range tests. |
| S-11-04 | High | The pinned urllib3 pool manager was incompatible with urllib3 2.x initialization and pool-key normalization. | Fixed and regression-tested against the installed urllib3 2.7 runtime. This affected the production pinned transport path. |
| S-11-05 | High | Privileged `user_settings.is_admin` / `plan` protection existed only in a root-level manual SQL file, outside the ordered Supabase migration chain. | Fixed by adding an idempotent migration that installs and verifies the trigger; SQL test harness now tests self-promotion and re-applies the migration. |
| S-11-06 | Medium | Public portfolio lookup documented a need for edge/WAF rate limiting but had no application-level limiter or request-body bound. | Fixed with a streaming 4 KiB body bound and service-role `portal_rate_limit` checks keyed by client IP and token hash. Both checks run before share-token database lookup; rate-limit failure is fail-closed. |
| S-11-07 | High | Public OAuth, webhook and capability endpoints relied on operator-supplied `--no-verify-jwt` deployment flags without a checked-in Supabase function configuration. | Fixed by adding `supabase/config.toml` with explicit `verify_jwt = false` for the 19 reviewed endpoints that use one-time state, signed webhooks or capability tokens. All unlisted functions retain the secure default (`verify_jwt = true`). |
| S-11-08 | Medium | Both Windows worker installers referenced `intelligence-worker/.env.example`, but the template was absent from the uploaded baseline. | Fixed by adding a placeholder-only template with no populated secrets. |

## Controller route review

The controller binds only to `127.0.0.1:17843` and checks the exact Host and allowed Origin. CORS preflight is unauthenticated by design, but it cannot perform an action. Every operational route now also requires the per-install bearer token:

- `GET /api/status`: authenticated; returns process status only, never token or environment values.
- `POST /api/start`: authenticated; JSON-only, body bounded, and the UI requires a user confirmation before starting.
- `POST /api/stop`: authenticated; JSON-only, body bounded.
- `OPTIONS`: exact allowed Origin/Host check; no state change.
- Unknown paths and methods are rejected.

The Windows installer generates the token using the OS cryptographic RNG, restricts the token file ACL, passes only its path to the controller, and prints the path but never the token value. The Settings UI accepts the token in a password field and holds it in component memory only. The uninstaller sends an authenticated stop request.

## SSRF and DNS handling

- Public page fetches retain manual redirect validation and IP-pinned TCP connections.
- The allowlisted API client now uses the same IP-pinned adapter, with `trust_env = false` and `allow_redirects = false`.
- The SMTP adapter already validates global addresses and connects to the chosen pinned IP; no change was needed there.
- Private, loopback, link-local, multicast, reserved, unspecified, shared-address and documentation/benchmarking ranges are rejected through the global-unicast check.
- No DNS probing of recipient mailboxes or SMTP VRFY/RCPT checks were introduced.

## Edge Function CORS and endpoint authorization

The shared CORS policy still uses `Access-Control-Allow-Origin: *` because the app has public capability-link viewers and cross-origin media consumers. It does **not** enable `Access-Control-Allow-Credentials`; CORS is not treated as authentication. Privileged endpoints must independently validate a bearer JWT or a capability credential.

The endpoint inventory was reviewed by trust model:

- **Supabase JWT + user authorization:** account management, email sending, Intelligence admin/provider connection, worker token issuance, internal chat attachments, Drive/portfolio administration, studio Drive operations, final-QC upload, payment administration, and other staff-only functions.
- **One-time OAuth state:** Google Drive and Patreon connect/callback; Gmail, Zoho and provider-neutral Intelligence callbacks. OAuth initiation for Intelligence providers remains JWT/admin protected.
- **Signed webhook:** Resend and Intelligence Resend use Svix verification; Patreon uses its required HMAC signature; Paystack uses HMAC verification and a server-side transaction verification call before applying payment state.
- **Capability credential:** checkout uses an unguessable invoice token; studio invite acceptance uses a one-time invite token; freelancer upload uses the shot share token; client downloads use a short-lived signed ticket plus a live database check; portfolio viewing uses the share token and portfolio media uses a signed ticket plus a live database check; portal chat and push resolve guest/client/freelancer credentials before service-role operations.

`supabase/config.toml` lists the 19 endpoints that intentionally do not use the Supabase gateway JWT check. Their own credential checks remain mandatory. All other functions are left at the Supabase default JWT verification. The config has been parsed as TOML and cross-checked against the source's `no-verify-jwt` declarations.

## RLS, grants and privileged users

Static migration review confirms the Intelligence authorization rule requires both:

1. the same caller to have `user_settings.is_admin = true`; and
2. an active `master_user` membership in the target organization for organization-scoped checks.

The helper functions are `SECURITY DEFINER` with a pinned `search_path`; anonymous/PUBLIC execution is revoked and authenticated execution is granted. The Edge Function helper validates the caller with `auth.getUser()` and calls `intel_is_authorized()` using the caller's ANON-key client before service-role work. The new Phase 11 trigger prevents authenticated users from promoting their own `is_admin` or `plan` fields; service-role provisioning remains the trusted path.

The SQL authorization test harness now applies the Phase 11 migration twice and attempts a direct authenticated self-promotion. It has **not** been executed in this environment because PostgreSQL, Docker and the Supabase CLI are unavailable.

## Environment-secret review

- No populated local environment files were present in the uploaded archive. Phase 11 adds `intelligence-worker/.env.example` as a placeholder-only template; it contains no live credentials.
- A non-disclosing pattern scan found only test-fixture-looking key patterns in three test files; no values were copied into this report.
- No deployed Supabase secret inventory or repository history was accessible. Therefore this phase does not claim to prove that a secret was never exposed in remote logs, Git history or prior deployments.
- No secret value was read, printed, changed or rotated. If a secret is later confirmed exposed, rotate it through the provider's supported secret-management workflow and redeploy the dependent function; do not paste it into logs or reports.

## Deployment verification still required

The source and tests do not establish the state of the deployed project. Before calling Phase 11 accepted:

1. Apply/replay the Phase 11 migration in a disposable PostgreSQL/Supabase database and run `supabase/tests/run_intelligence_auth.sh`.
2. Deploy Edge Functions using the checked-in `supabase/config.toml`, then inspect deployed function configuration metadata to confirm the 19 intentional JWT bypasses and that all other functions retain JWT verification.
3. Verify live RLS enablement, table grants, function grants and the privileged-user trigger using database catalog queries and negative tests for non-admin, inactive-member, cross-organization and self-promotion attempts.
4. Verify CORS from the production app origin and an untrusted origin, confirming no credentialed CORS response is emitted.
5. On Windows, reinstall/restart the local controller and verify missing/wrong token requests fail while the correct token can read status and perform explicitly confirmed start/stop actions.
6. Run the frontend production build and Deno type-check once project dependencies/tooling are installed.

No production database, deployment, provider account, worker or email activity was changed by this local implementation.

## Corrective audit (2026-11-08)

A follow-up audit found three weaknesses in the anonymous rate-limit identity and enforcement path. All three have been corrected locally:

| ID | Severity | Confirmed defect | Corrective change |
|---|---|---|---|
| S-11-09 | High | `portfolio-view`, `portal-chat` and `push` fell back to caller-controlled `X-Forwarded-For` when the Cloudflare client-IP header was absent. | Added `_shared/rate_limit_identity.ts`. It accepts only the platform-injected `CF-Connecting-IP`; it never reads `X-Forwarded-For`. Missing or malformed identity fails closed with HTTP 503. |
| S-11-10 | High | `portal_rate_limit` used an unlocked count-then-insert sequence, allowing concurrent requests for the same bucket to exceed the configured window limit. | Added `20261201100000_intelligence_phase11_atomic_portal_rate_limit.sql`. A transaction-scoped advisory lock keyed by `(scope, subject_hash)` is acquired before count/decision/insert. Unrelated buckets remain concurrent; hash collisions only serialize extra work. |
| S-11-11 | Medium | The IP-hash pepper was optional and defaulted to an empty string. | All three endpoints now require `PORTAL_HASH_PEPPER` with at least 32 characters and fail closed when it is missing or too short. Deployment guidance updated. |

Regression coverage now checks that caller-supplied forwarding headers are ignored, the trusted platform header is required, weak/missing peppers fail closed, and the SQL advisory lock precedes the bucket count and insert. The access/chat SQL harness now applies and re-applies the corrective migration. The actual PostgreSQL concurrency test remains pending until the SQL harness can be run against PostgreSQL 16.
