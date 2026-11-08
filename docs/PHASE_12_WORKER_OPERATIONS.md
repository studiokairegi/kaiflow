# Phase 12 — Worker Operations Reference

## Installation mode

Choose one Windows mode only:

- Recommended: controller-managed mode via `intelligence-worker\windows\install-controller.ps1`.
- Legacy mode: SYSTEM scheduled worker via `intelligence-worker\windows\install-task.ps1`.

Installers refuse coexistence. The worker process also owns a machine-wide singleton lock. Exit code 73 means another worker is already running; this is not a crash and must not trigger another restart attempt.

## Restart ownership

- Controller-managed mode: the controller restarts its child worker; Task Scheduler restarts the controller if it exits.
- Legacy scheduled mode: Task Scheduler restarts the one-shot `run-worker.ps1` task. The wrapper has no inner restart loop.

## Logs

`worker.log` is rotated continuously by the worker process at 5 MiB. Three backups are retained as `worker.log.1`, `.2` and `.3`; rotation does not wait for a restart.

## Queue recovery

Scheduled deferrals are reported separately from ready jobs. Expired running leases are reclaimed during the next job claim. If the attempt budget is exhausted, the job becomes `dead`. An administrator may manually requeue `failed` or `dead` jobs from Agent Activity Logs. Requeueing is audited and does not bypass downstream gates.

## Send windows

Initial and follow-up sends are scheduled for the next opening in the studio's configured timezone. The final database send boundary rechecks the window. Replies are not subject to this initial/follow-up window rule.

## Reply threading

Association priority: token plus sender match; exact Message-ID in `In-Reply-To`; exact Message-ID in `References`; then exact prospect contact address only when that address has one unambiguous prospect with prior outbound history. RFC header matches require the sender to equal the original outbound recipient.
