# KairFlow Intelligence Phase 2 — Line-by-Line Production Readiness Review

**Review date:** 2026-11-07  
**Scope:** Phase 2 English outreach, follow-ups/re-engagement, inbound reply drafting, worker send lifecycle, Gmail/Zoho mail transport, inbox/Sent reconciliation, and supporting Supabase RPC contracts.  
**Source:** Uploaded `KairFlow_Phase2_Patch.zip`, with the Phase 2 corrective changes applied to a working copy.

## Executive result

The Phase 2 worker code has been hardened and regression-tested. The most important gaps in the handoff were not cosmetic: process-local send spacing could be bypassed by a second worker, Zoho could downgrade a reply to a new unthreaded message, and Zoho Sent reconciliation inspected only the first page. These have been corrected in code and covered by tests.

**This is a staging candidate, not a live-production certification.** The new Supabase migration has not been executed against a database, no authenticated provider mailbox was available for a live Zoho/Gmail test, and the frontend production build could not run because dependencies (`vite`) are not installed in this environment.

## Findings and corrections

| Area | Finding | Correction | Verification |
|---|---|---|---|
| `jobs.py` send scheduling | 45–120 second pacing was stored on one Python process (`_last_send`); multiple worker processes could burst-send. | Removed process-local pacing. Worker now obtains a database-coordinated slot and requeues a throttled message with a delay. | Worker regression test verifies `send_spacing` creates a delayed retry. SQL contract test verifies the organization-row lock and 45–120 second slot. |
| `mailops.py` send lifecycle | A reserved message needed a durable global slot before entering `sending`. | Added `intel_agent_acquire_send_slot` before `intel_agent_mark_sending`. RPC errors fail before the provider call; spacing denial leaves the message reserved and retryable. | Unit tests cover slot denial, no provider call, and requeue. |
| Emergency stop | A kill-switch change between initial settings read and provider send could race. | New migration rechecks the kill switch while locking settings in both slot acquisition and `mark_sending`. A reserved message blocked by the stop returns to `approved`. | SQL contract tests verify both checks and state rollback. A provider call already in flight cannot be canceled. |
| `zoho.py` reply threading | A Zoho 4xx on native reply action silently fell back to a normal new message; malformed parent IDs could also fall through. | Added `ThreadingRejected`; malformed or rejected parent threading fails closed. No unthreaded fallback is attempted. | Tests verify one reply endpoint call only, permanent manual-review failure, and zero plain-send calls. |
| `zoho.py` Sent reconciliation | Only the first 50 Sent messages were searched. | Sent search now scans up to 20 pages of 100 messages, with overlap/deduplication for offset pagination. | Regression test finds a matching token on page two. |
| `zoho.py` inbox pagination | Offset pagination can shift while new messages arrive. | Retained overlapping pages and per-sync ID deduplication; added an optional page cap for bounded reconciliation while normal inbox sync can continue through backlog. | Existing inbox backlog/cursor tests plus pagination coverage. |
| Draft uniqueness | Existing check compared only a prospect's local thread. Similar model-generated copy for another recipient could pass. | Added an agent-only `intel_agent_recent_outbound` RPC returning at most 500 recent outbound records from the same organization, limited to required fields. Both outbound and reply uniqueness checks now use persisted organization-wide history. | SQL contract test verifies org scoping, 180-day window, 500-row cap, and grants. Existing lexical/structural uniqueness tests remain. |
| CRM email guard | The earlier `reserve_send` definition could resume a reserved message before rechecking the CRM email gate. | The effective override migration `20261116100000_intelligence_crm_reserve_send_email_gate.sql` validates the CRM email before reserved recovery. The SQL contract test now checks the effective override rather than the superseded earlier definition. | Node SQL-contract test. |
| Test harness | Several `.mjs` tests import TypeScript edge-function modules directly; plain Node test invocation rejected `.ts` files. | Declared Node `>=22.6.0` and changed the test script to use Node's type-stripping flag. | `npm test` passes on Node 22.16.0 in this environment. |

## Files changed or added

- `intelligence-worker/kairflow_intel/errors.py` — added `ThreadingRejected`.
- `intelligence-worker/kairflow_intel/zoho.py` — fail-closed native threading; bounded paginated Sent search.
- `intelligence-worker/kairflow_intel/mailops.py` — acquire durable send slot before marking sending; handle thread refusal as permanent.
- `intelligence-worker/kairflow_intel/jobs.py` — database-wide pacing, delayed retry, and organization-wide persisted duplicate checks.
- `intelligence-worker/tests/test_ops.py` — send-slot, worker requeue and threading regressions.
- `intelligence-worker/tests/test_v1.py` — changed the Zoho fallback expectation to fail closed.
- `intelligence-worker/tests/test_zoho.py` — new Zoho threading and Sent pagination tests.
- `supabase/migrations/20261119090000_intelligence_phase2_global_send_pacing.sql` — new send-slot, emergency-stop and outbound-history RPCs.
- `src/intelligence/phase2-global-pacing.test.mjs` — new SQL/worker contract tests.
- `src/intelligence/takeover-sql-contract.test.mjs` — validates the effective CRM email-gate migration.
- `package.json` — explicit Node test runtime requirement and type-stripping test command.
- `intelligence-worker/README.md`, `docs/ZOHO_COMPATIBILITY.md`, and Phase 2 handoff documents — updated deployment and behavior notes.

## Verification performed

| Command | Result |
|---|---:|
| `python -m unittest discover -s tests -t .` in `intelligence-worker` | **207 passed** |
| `python -m compileall -q intelligence-worker` | Passed |
| `npm test` (Node 22.16.0) | **749 passed, 0 failed** |
| `npm run build` | **Not run successfully** — `vite: not found`; this environment has no `node_modules` installed. |
| Supabase SQL runtime validation | **Not performed** — no `psql`/Postgres runtime available. SQL contract tests are static checks, not a substitute for applying the migration to staging. |
| Live Gmail/Zoho/Resend calls | Not performed. |
| Real email sends | None. |

The Python worker test intentionally prints a `ValueError: boom` traceback from a test that verifies the worker catches unexpected handler errors; the suite result is still successful.

## Required staging rollout

1. Back up the Supabase project and review the migration plan.
2. Apply all existing Intelligence migrations in order, including `20261116100000_intelligence_crm_reserve_send_email_gate.sql`, then apply `20261119090000_intelligence_phase2_global_send_pacing.sql`.
3. Verify the new functions exist and are executable only by the authenticated agent identity. Confirm the agent is the only identity accepted by `intel_agent_org()`.
4. Deploy the updated worker only after the migration succeeds. Without the new RPC, the updated worker fails closed rather than sending without global pacing.
5. Keep the emergency kill switch ON. Run read-only Zoho/Gmail self-tests and verify folder/message response shapes.
6. In a controlled staging mailbox, test a single approved send, a threaded reply, a Sent-folder reconciliation, a 429/timeout ambiguity, and a kill-switch change before provider submission. Confirm ambiguous outcomes remain unknown and are not resent.
7. Verify two worker instances cannot obtain send slots inside the same spacing window. Confirm the next job is requeued and eventually progresses.
8. Only after these checks should the administrator consider enabling outbound sending, with the normal approval and daily-cap controls intact.

## Remaining limitations / not claimed as solved

- The duplicate guard is lexical/structural and compares against the most recent 500 outbound records in a 180-day window. It is not embedding-based semantic similarity, cannot prove entailment, and may conservatively send drafts to manual review. A representative labeled corpus is still needed to calibrate thresholds.
- Zoho's actual API response shapes and native reply behavior remain unverified against the user's connected account. Fail-closed behavior protects against accidental unthreaded sends but does not prove the endpoint works.
- Zoho uses offset pagination, not an opaque snapshot cursor. Overlap and deduplication reduce concurrent-insert gaps but cannot guarantee a stable snapshot while the mailbox is continuously changing.
- Gmail and Resend live webhook/send/reconciliation behavior, domain authentication (SPF/DKIM/DMARC), provider rate limits and deliverability need staging verification.
- The migration is present but unapplied. Until it is applied and validated, the new global send throttle and organization-wide history RPC are not active in the user's database.
- The production frontend build remains unverified because Vite dependencies were not installed in this environment.

## Explicit non-actions

No production database was modified, no migration was applied, no deployment or Git push was made, no worker was activated, no credentials or secrets were changed, and no real emails were sent.
