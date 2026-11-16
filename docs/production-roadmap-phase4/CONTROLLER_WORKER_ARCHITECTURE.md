# Controller / Worker Architecture (Phase 4, as audited and as changed)

Source-level audit, 13 Nov 2026. Nothing here was observed running; see `WORKER_RELIABILITY_TESTS.md` for what was and was not verified.

## Components
- **Local controller** (`intelligence-worker/controller.py`, loopback 127.0.0.1:17843, per-install bearer token, exact-origin allow-list). Starts/stops the worker as a child process, restarts it if it dies while it is meant to run, exposes `GET /api/status`, `POST /api/start|stop`. It never returns environment values.
- **Worker** (`python -m kairflow_intel run`, `jobs.Worker`). Holds a machine-wide singleton lock (exit 73 = another instance owns it). Signs in as the agent user and may call only `intel_agent_*` RPCs. Loop: every tick, if 30 s have passed run **housekeeping** (heartbeat + scheduler pass), then **claim** one job, run its handler under a renewed lease, then **settle** it (complete / fail).
- **Database** (`intel_jobs`, `intel_worker_heartbeat`, `intel_agent_*` RPCs). Single source of truth for job state. The worker keeps no durable state.
- **AI router** (`airouter.py`, `FallbackLLM`). Handlers call it; each job result now records how many calls each provider served.

## Ownership and permissions
Every RPC resolves the organization from the agent identity (`intel_agent_org()`); the worker cannot name an organization. Admin RPCs (`intel_admin_enqueue_job`, `intel_admin_requeue_job`) resolve it from the signed-in administrator and only allow a fixed list of job kinds. Safeguards (kill switch, approval, caps, suppression, send window) are enforced in handlers and the database, never by model output.

## What Phase 4 changed
| Area | Before | Now |
|---|---|---|
| Heartbeat / scheduler failure | Escaped `tick()` before the claim call: one failing step starved the whole queue | Isolated in `_housekeeping`; claim always runs; error published as `scheduler_error` |
| One rejected enqueue | Aborted the rest of the schedule | Recorded; remaining enqueues still run (network error still aborts the pass) |
| Unexpected exception in the loop | Ended the worker | Logged, escalating wait (15 s to 300 s), loop continues |
| Completion RPC network error | Fell into the transient handler: finished job reported failed and re-queued | Retried (2, 5, 10, 20, 30 s); never reported as a failure; lease expiry recovers if still unreachable |
| PermanentError / definite DB refusal | Re-queued for +24 h, up to the attempt limit, looked like a scheduled job | `intel_agent_fail_job_permanent`: dead at once, visible, Requeue available. Older schema falls back to the previous behaviour |
| Retry schedule (background) | 30, 60, 120, 240 s (7.5 min then dead) | 60 s, 5 min, 15 min, 1 h (about 81 min then dead), +-10% jitter |
| Retry schedule (Agent Chat) | Same as above | 15, 30, 60, 120, 240 s |
| Error text | Raw exception text, 400 chars | Scrubbed of credential-shaped strings, bounded |
| Failure audit | Console only | `job_failed` row in the audit log (class, attempt, outcome, retry, duration, AI calls) |
| Job result | Handler result only | Plus `_run`: duration_ms, attempt, worker_id, ai_calls |
| Controller restart | Fixed 20 s, forever | 20, 40, 80, 160, 320, 600 s; config error (exit 2) at least 300 s; streak resets after a 120 s healthy run; status shows restart_count, consecutive_failures, next_restart_seconds |
| Job states in the app | `failed` shown but never produced; retrying jobs looked scheduled | Retrying / Stalled / Deferred / Scheduled / Failed permanently derived from the row |
| `fail_job` / `complete_job` SQL | `fail_job` could reset a succeeded job; repeat completion returned false | Migration `20270103090000` (not executed here) |

## Unchanged on purpose
Claim logic (`for update skip locked`, expired-lease recovery, `dead` at max attempts), idempotent enqueue keys, the send state machine and its `DEFER` / terminal-denial sets, singleton lock, provider adapters, all safeguards.

## Known structural limits
- A dead job keeps its idempotency key. A dead `discover:<type>:<day>` job blocks that day's discovery until requeued. No automatic revival exists.
- Settlement is not fenced by attempt number. Worker ids are per worker, not per attempt.
- Handler idempotency was not audited handler by handler; the re-run path relies on it.
