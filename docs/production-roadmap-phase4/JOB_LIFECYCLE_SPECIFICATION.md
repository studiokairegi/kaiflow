# Job Lifecycle Specification

## Required fields (table `intel_jobs`)
`kind` (checked against an allow-list), `payload`, `state`, `priority`, `run_after`, `attempts`, `max_attempts` (default 5), `lease_until`, `locked_by`, `last_error`, `result`, `idempotency_key` (unique per organization), timestamps. Organization is fixed by the RPC, not the caller.

## States
| State | Meaning | Set by |
|---|---|---|
| `queued` | Waiting for `run_after` | enqueue; fail (retry); defer; lease recovery; manual requeue |
| `running` | Claimed, lease held | claim |
| `succeeded` | Handler finished and result stored | complete |
| `dead` | Will not run again without a human Requeue | fail at max attempts; fail_permanent; lease recovery at max attempts |
| `failed` | Exists in the constraint; **no function sets it** | nothing (see presentation below) |

## Transitions
1. enqueue: `queued`; duplicate key = no-op (returns null).
2. claim: recovers expired leases first (`running` to `queued`, or `dead` at max attempts, with a diagnostic), then takes the best `queued` job with `run_after <= now` (`priority desc, run_after, created_at`, `skip locked`); `attempts + 1`, lease 30 s to 1 h (worker asks 300 s).
3. lease renewal every 60 s while the handler runs. Loss or an uncertain renewal marks the lease lost: the worker then neither completes nor fails the job.
4. handler outcome:
   - result: `complete` (with `_run` metadata). Result `reason` in the DEFER set marks `deferred: true` (still a normal completion).
   - `job_failure` result (send path): terminal denial goes to `fail_job_permanent`; otherwise `fail_job` +24 h.
   - exception: classified (below), then `fail_job` or `fail_job_permanent`.
5. defer (`intel_agent_defer_job`): back to `queued`, attempt refunded, `last_error = 'deferred: ...'`.
6. manual Requeue (admin): `dead` or `failed` to `queued`, attempts reset, audited.

## Failure classes (`job_policy.classify_failure`)
| Class | Source | Action |
|---|---|---|
| transient | `TransientError` | `fail_job`, backoff |
| database_busy | `RpcError` with SQLSTATE 40001, 40P01, 55P03, 57014, 53300, or HTTP 408/425 | `fail_job`, backoff |
| permanent | `PermanentError` | `fail_job_permanent` |
| database_rejected | any other `RpcError` | `fail_job_permanent` |
| unexpected | any other exception | `fail_job`, backoff; message starts `unexpected <Class>:` |

## Retry policy
Background kinds: waits 60 s, 5 min, 15 min, 1 h, 2 h (fifth only if `max_attempts` is raised); with 5 attempts the job is declared dead after about 81 minutes. `chat`: 15, 30, 60, 120, 240 s. Jitter +-10%. The database caps any wait at 24 h.

## Idempotency
Enqueue keys are bucketed (`discover:<type>:<day>`, `sync_mail:<2-min bucket>`, `send:<message>:<15-min bucket>`, `fuscan:...:<day>`). Sends are settled by the message state machine (`reserved`, `sending`, `unknown`, `sent`); an `unknown` send is never re-sent and is checked by reconciliation. Completion and failure settlement are guarded by `state = 'running' and locked_by = worker` (after migration `20270103090000`, for `fail_job` as well); repeat completion by the same worker is a no-op success.

## How the app presents a job (`jobPhase`)
| Row | Label |
|---|---|
| `dead` | Failed permanently (Requeue) |
| `failed` | Failed, retry pending (Requeue) |
| `queued`, attempts > 0, `last_error` not starting `deferred:` | Retrying (try n of max), next try time shown (Requeue) |
| `queued`, `last_error` starts `deferred:` | Deferred by a safeguard |
| `queued`, `run_after` in the future | Scheduled |
| `queued`, due | Waiting for the worker |
| `running`, `lease_until` passed | Stalled (lease expired) |
| `running` | Running |

## Recovery after a restart or outage
Worker killed: lease expires (at most about 5 min after the last renewal), the next claim returns the job to `queued`, or to `dead` if attempts are exhausted. Supabase unreachable: the loop waits 15 s doubling to 300 s; settlement is retried for about a minute, then left to lease expiry. Controller restarts the worker with escalating delay; exit 73 is never restarted.
