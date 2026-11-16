# Worker Reliability Tests

**All results below are from mocked tests (fake RPC surface, fake providers, scripted clocks) or source-level contract checks. None is a live run against Supabase, Ollama, Gemini or a mail provider, and the SQL was not executed.**

## Actual results, 13 Nov 2026
| Suite | Baseline (before Phase 4) | After |
|---|---|---|
| Python unittest (`intelligence-worker/tests`) | 953 OK | **1006 OK** (53 new) |
| `npm test` (node --test) | 1157 pass | **1173 pass, 0 fail** (16 new) |
| `python -m compileall` | not recorded | passed |
| `npm run build` | not run | **not run** (no `node_modules`; Vite absent) |
| SQL migration + `intelligence_phase4_job_reliability.test.sql` | n/a | **not executed** (no PostgreSQL) |
| Live scheduling-to-persisted-result test | n/a | **not run** |

Output lines such as `FAIL Ollama structured output` in the Python log are mocked preflight fixtures, not health results.

Two existing tests were changed on purpose (`test_ops.WorkerLoop.test_error_mapping`, `test_one_bad_job_does_not_stop_the_worker`) because they pinned the old schedule and the old daily retry of permanent errors. One Phase 12 contract test (`proc.returncode == 73`) failed after my first controller edit; the literal was restored, the test was not edited.

## What the new tests prove (mocked)
- Backoff tables, clamping and jitter bounds; classification of every error class including SQLSTATE busy codes.
- Credential scrubbing (bearer, key= in URLs, JSON password, Google key and JWT shapes) and length bound.
- Transient failure: correct retry delay, scrubbed text, audit row. Permanent: dead, no retry delay. Older schema: falls back to 24 h retry. Chat uses the short schedule. `not_owner` is treated as lease lost and not counted. Failure recording with an unreachable database does not raise and is retried a bounded number of times. Audit failure does not break recording.
- Completion: metadata attached; non-dict results wrapped; short network failure retried without any failure report; persistent failure never reported as a job failure; rejected completion treated as lease lost.
- AI call counting per job; Ollama-by-configuration is not counted as a fallback; a Gemini-first site with no key is.
- Scheduler: failing step does not block claiming; one rejected enqueue does not stop the rest; network failure aborts the pass; errors reach the heartbeat; healthy pass clears the error; 30 s cadence kept even on failure.
- Loop survives unexpected exceptions with escalating waits; outage backoff and recovery.
- Controller: delay schedule; config-error floor; quick crash, escalation, stable-run reset, duplicate-worker exit (73) not restarted, restart counted, spawn failure escalates, status stays additive and secret-free.
- App logic: `jobPhase`, `jobSummary`, scheduler and crash-loop notices. Source contracts: migration is additive, guards present, signatures unchanged.

## Not tested, and needed before Phase 4's completion gate can be called met
1. A real test job: scheduled by the worker, claimed, executed and persisted in a staging Supabase, visible in Agent Activity Logs.
2. Migration `20270103090000` applied twice and `run_intelligence_phase4.sh` run (needs the auth fixtures).
3. Kill the worker mid-job and confirm lease expiry returns the job; cut the network during completion and confirm no duplicate effect.
4. Browser check of the Logs, Overview and Settings changes; production build.
