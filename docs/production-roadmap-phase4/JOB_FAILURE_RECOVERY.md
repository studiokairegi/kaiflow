# Job Failure Recovery (operator runbook)

## Reading a failure
- **Agent Activity Logs > Jobs**: state label, tries, next try time, last error. A `job_failed` row in the activity log below it records class, attempt, outcome, retry delay, duration and AI calls.
- **Overview > Worker operations**: heartbeat age, dead/failed counts, last job issue, scheduler notice, counts since Emma started.
- **Settings > Emma**: controller status, restart problem, crash-loop notice.
- `worker.log` (rotated, 5 MiB x 3): full tracebacks for unexpected errors.

## By symptom
| You see | Meaning | Do |
|---|---|---|
| Retrying (try n of 5) | Failed, will try again at the shown time | Usually nothing. If the error names Ollama or the network, fix that; the next try picks it up |
| Failed permanently, `permanent: ...` | Input or policy refusal (no valid website, missing approved knowledge, draft failed policy) | Fix the cause (approve the KB entry, correct the prospect), then Requeue |
| Failed permanently, `unexpected <Class>` after 5 tries | Probably a bug | Keep the row and the log traceback; Requeue only after a fix |
| Failed permanently, `lease expired` text | Worker died or stalled repeatedly | Check the worker and Ollama; Requeue |
| Stalled (lease expired) | Worker stopped mid-job | Start Emma. The next claim recovers it |
| Overview "scheduling pass" notice | A scheduled enqueue was refused; queued jobs still run | Read the text; usually a database function or permission mismatch after a partial migration |
| Settings "stopped unexpectedly n times" | Crash loop; restarts are spaced out | Read `worker.log`; fix `worker.env` or Ollama; press Start to reset the streak |
| Exit 2 | Configuration error | Fix `worker.env`; retry in about 5 min or press Start |
| Exit 73 | Another worker owns the lock | Stop the other mode; not a crash |

## Recovery rules that hold
- Requeue is audited and never bypasses approval, suppression, kill switch, caps or the send window.
- An `unknown` send is never re-sent by a requeue; resolve it from Outreach.
- A dead scheduled job (for example `discover:<type>:<day>`) blocks its bucket until requeued; check for dead jobs after any outage.

## Rollback of Phase 4
Worker/controller/app: redeploy the previous files (the worker needs no schema change). SQL: re-apply the two function definitions from `20261109120000_intelligence_rpcs.sql`. No data was altered.
