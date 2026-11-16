# Phase 4 Handoff: Controller, Worker and Job Execution Reliability

**Status: PARTIAL.** Code, migration, app changes, docs and mocked tests are complete. The completion gate (a real job from scheduling to a persisted result, failures visible and recoverable) has **not** been demonstrated live. Phase 2 and 3 live checks are also still open.

## Files
- **Created:** `intelligence-worker/kairflow_intel/job_policy.py`; `intelligence-worker/tests/test_phase4_job_reliability.py`; `src/intelligence/phase4-job-reliability.test.mjs`; `supabase/migrations/20270103090000_intelligence_phase4_job_reliability.sql`; `supabase/tests/intelligence_phase4_job_reliability.test.sql`; `supabase/tests/run_intelligence_phase4.sh`; `docs/production-roadmap-phase4/*`.
- **Changed:** `kairflow_intel/jobs.py` (Worker rewritten: housekeeping, settlement, failure recording, loop survival), `gemini.py` (`FallbackLLM.usage_counts`, `generate_json` routed through the counted path), `controller.py` (restart policy, additive status), `src/intelligence/logic.js`, `api.js` (`lease_until` selected), `LogsView.jsx`, `OverviewView.jsx`, `SettingsView.jsx`; `tests/test_ops.py` (two expectations updated to the new contract).
- **Removed:** none. Backups and earlier reports untouched.

## Addendum: Emma master switch (added after the first Phase 4 delivery, at the owner's request)
One front-end switch (Overview and Settings) that turns the worker AND controller off, and back on. See `EMMA_SWITCH_GUIDE.md`.
- Created: `src/intelligence/EmmaSwitch.jsx`, `intelligence-worker/windows/launcher.ps1`, `install-launcher.ps1`, `uninstall-launcher.ps1`, `Install-Emma-Switch.cmd`, `tests/test_controller_shutdown.py`.
- Changed: `controller.py` (authenticated `POST /api/shutdown`, version 1.2.0), `windows/install-controller.ps1` (registers the launcher), `logic.js` (`emmaSwitch`), `SettingsView.jsx` (old Start/Stop kept under "Advanced"), `OverviewView.jsx`.
- Owner step: run `Install-Emma-Switch.cmd` once on the existing install; restart the controller to get `/api/shutdown`.
- Unverified: no Windows, Task Scheduler or browser run (see guide, "Not yet verified").

## Addendum: bug re-check (13 Nov 2026)
Found and fixed in my own work: switch stopped updating after React StrictMode's dev remount; a controller error answer showed as "paused"; launch via `window.location` could navigate away in some browsers (now an anchor click); Overview called failed attempts "failed jobs"; a persistent scheduler error was logged every 30 s; scheduler pass ran against an unreachable database after a failed heartbeat. Regression tests added. JSX edits were syntax-checked with `tsc` only; still no real build or browser run.

## Deployment (in order)
1. Apply migration `20270103090000` to a copy; run `run_intelligence_phase4.sh` (needs the auth fixtures). Two function replacements, no table or data change. Do not run a blanket `supabase db push` (hosted migration ledger unverified, finding P1-S01).
2. Deploy the frontend.
3. Restart the controller, then the worker. The worker works before or after step 1.

## Tests (actual)
Python 1006 OK (baseline 953). Node 1173 pass, 0 fail (baseline 1157). compileall passed. **Not run:** build, SQL, live. See `WORKER_RELIABILITY_TESTS.md`.

## Behaviour changes to know about
Permanent errors now go dead immediately (previously retried daily for 5 days). Background retries span about 81 minutes. Job results gain a `_run` key. Heartbeat info gains `started_at`, `jobs_succeeded`, `jobs_failed`, `scheduler_error`. Controller status gains `restart_count`, `consecutive_failures`, `next_restart_seconds`.

## Known bugs, risks, unresolved
- Dead scheduled jobs block their idempotency bucket until requeued; no auto-revival (needs a new RPC).
- `failed` state is never set by the database; the app derives Retrying from the row. Overview `failed_jobs` KPI still counts the unused state; the Logs view is the accurate one.
- Settlement not fenced by attempt number; handler idempotency not audited per handler.
- Heartbeat counters reset when the worker restarts.
- `scrub_error` may over-redact messages containing words like "token".
- Carried: Phase 2 live Gemini/Ollama gate; Phase 3 KB approval and SQL run; Phase 7 migration ledger; N-xx item definitions were not in the repo, so Phase 4 scope came from the code audit.
- No `.git` in the ZIP: branch, commit and dirty state unknown.

## Secrets: none new. **Outbound sending untouched and disabled; the deployed kill-switch state was not verified.**

## Next (Phase 5)
Read the roadmap and Phase 1 to 4 handoffs. Ideally first close the Phase 4 live checks (staging job end to end, kill-worker and network-cut tests, migration run). Then discovery quality: source-specific extraction, evidence, duplicates, research standard. Consider the dead-job revival RPC early, since it affects scheduled discovery.
