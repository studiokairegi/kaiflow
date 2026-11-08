# KairFlow Intelligence — Phase 12 Handoff

**Phase:** 12 — Worker reliability and operational status  
**Status:** Local implementation complete; PostgreSQL and Windows acceptance remain pending.  
**Disposition:** Do not treat this as production acceptance until the Phase 12 migration is replayed twice and the Windows installation modes are exercised on a test machine.

## 1. Objective

Address duplicate worker installation modes, restart/recovery, send-window deferral, unified health status, log rotation, queue recovery, and reply association using RFC Message-ID, In-Reply-To and References.

## 2. Changes

### A. Duplicate installation modes and restart ownership

- Added a machine-wide singleton lock to the worker entrypoint. Windows uses a named mutex with an explicit ACL for SYSTEM, Administrators and authenticated users; POSIX uses a non-blocking file lock.
- Duplicate process startup exits with code 73 before provider/worker construction. The controller recognizes this code and does not enter a restart loop.
- The two Windows installers now refuse to coexist and reject an already-running worker.
- The legacy scheduled-task wrapper now runs one worker process and exits; Task Scheduler is its only restart supervisor. The controller-managed mode retains the controller's own worker restart loop, and its scheduled task now restarts the controller on failure.

### B. Worker restart, lease ownership and queue recovery

- Worker lease renewal now checks the database ownership result. A rejected or uncertain renewal is treated as lease loss; the former worker does not complete or fail the job after losing ownership.
- Long-running jobs refresh the worker heartbeat while renewing their lease.
- Expired leases are reclaimed atomically by the next claim transaction, with a bounded timestamp/previous-owner diagnostic. Attempts are respected; exhausted jobs become dead.
- Added an admin-only, audited requeue action for failed/dead jobs in Agent Activity Logs. It resets retry state but does not bypass the message state machine or any approval, consent, kill-switch, quota or final send-boundary check.

### C. Send-window deferral

- Added `intel_agent_send_window_status`, which evaluates initial/follow-up windows using the studio timezone and weekday setting and returns the next permitted opening.
- The worker queues deferred initial/follow-up sends for that opening, with an idempotency key. It rechecks after a final-boundary rejection to handle a window closing between preflight and provider submission.
- Replies remain outside the initial/follow-up send-window restriction, matching the existing final database gate. The final send gate remains authoritative.

### D. Unified operational status

- Admin overview now includes worker identity/info, heartbeat age, ready/scheduled/queued/running/dead/failed counts, expired leases and oldest runnable queue age.
- Worker heartbeat reports worker version, PID, active job, Ollama health, last successful job time and a non-sensitive last-error class.
- Overview has a Worker operations panel with these signals.

### E. Log rotation

- The worker process itself uses a thread-safe rotating stream for stdout/stderr in both installation modes. It rotates continuously at 5 MiB and retains three backups; it does not depend on a process restart to rotate.
- Removed the nested PowerShell restart loop; only one supervisor is active in each installation mode.

### F. RFC reply association

- Provider header names are normalized case-insensitively before persistence. Inbound matching prefers exact RFC Message-ID tokens in In-Reply-To, then References.
- Header matching requires the inbound sender to match the original outbound recipient, reducing forged-header cross-association.
- The high-entropy per-message token remains the strongest association path (including provider DSNs), but token matches are also bound to the normalized inbound sender matching the original outbound recipient. RFC-header association applies the same sender/recipient agreement and prefers the last matching identifier in header order. Exact-contact fallback is allowed only when one prospect has prior outbound history at that address; ambiguous matches stay unmatched.

## 3. Main files changed

- `intelligence-worker/kairflow_intel/worker_lock.py` (new)
- `intelligence-worker/kairflow_intel/logging_setup.py` (new)
- `intelligence-worker/kairflow_intel/main.py`
- `intelligence-worker/kairflow_intel/jobs.py`
- `intelligence-worker/controller.py`
- `intelligence-worker/windows/install-task.ps1`
- `intelligence-worker/windows/install-controller.ps1`
- `intelligence-worker/windows/run-worker.ps1`
- `intelligence-worker/windows/uninstall-task.ps1`
- `intelligence-worker/windows/uninstall-controller.ps1`
- `intelligence-worker/README.md`
- `intelligence-worker/tests/test_worker_lock.py` (new)
- `intelligence-worker/tests/test_logging_setup.py` (new)
- `intelligence-worker/tests/test_ops.py`
- `intelligence-worker/tests/test_controller.py`
- `intelligence-worker/tests/test_ops.py`
- `src/intelligence/api.js`
- `src/intelligence/LogsView.jsx`
- `src/intelligence/OverviewView.jsx`
- `src/intelligence/phase12-worker-reliability-contract.test.mjs` (new)
- `supabase/migrations/20261202090000_intelligence_phase12_worker_reliability.sql` (new)
- `supabase/tests/intelligence_phase12_worker.test.sql` (new)
- `supabase/tests/run_intelligence_phase12.sh` (new)
- `docs/PHASE_ROADMAP.txt`
- `docs/PHASE_12_HANDOFF.md` (new)
- `docs/PHASE_12_WORKER_OPERATIONS.md` (new)

## 4. Validation

- JavaScript suite: **822 passed, 0 failed**.
- Python worker suite: **455 passed, 0 failed**.
- Python compileall: passed.
- New POSIX singleton-lock tests: passed.
- New live rotating log-stream tests: passed.
- New send-window deferral tests: passed.
- New lease-loss behavior tests: passed.
- New JS Phase 12 contract tests: passed, including a regression assertion that token matching includes the sender/recipient equality check.
- New SQL contract assertion verifies the deployed function definition contains the sender check inside the token-matching branch. The SQL assertion is authored but not executed here because PostgreSQL/Docker are unavailable.
- ZIP integrity: checked after packaging.
- PostgreSQL migration replay/SQL contract tests: not executed because PostgreSQL/Docker are unavailable.
- Windows named-mutex ACL, Task Scheduler mutual exclusion, PowerShell installer/uninstaller and restart behavior: source-reviewed; PowerShell/Windows are unavailable in this validation environment.
- Frontend production build: blocked because `vite` is not installed (`npm run build` reports `vite: not found`).
- Optional live preflight probes after the Python unit suite reported environment-dependent Ollama/RPC failures; these are not unit-test failures and remain staging acceptance checks.


## 5. Deployment order and acceptance

1. Back up the staging database and apply `20261202090000_intelligence_phase12_worker_reliability.sql` twice using `supabase/tests/run_intelligence_phase12.sh`.
2. Run the SQL contract tests and verify queue-recovery grants under a non-admin authenticated account and an admin account.
3. On a disposable Windows machine, test both installation paths separately: each installer must reject the other mode; starting a second manual worker must exit 73; controller/task restart must not create two workers.
4. Test log rotation beyond 5 MiB and confirm `.1`, `.2`, `.3` backups.
5. Test send deferral across weekday, weekend, overnight and studio timezone/DST boundaries. Replies should not be deferred by the initial/follow-up window check.
6. Test inbound replies with only In-Reply-To, only References, multiple IDs, unrelated sender, and a forged header pointing to another prospect. Also verify that a valid per-message token from an unrelated sender remains unmatched unless a separately validated RFC-header or unique exact-contact path independently establishes the association.
7. Run frontend production build and Deno/Windows checks in a fully provisioned environment.

Apply the database migration before deploying the updated worker: until the new send-window RPC exists, the updated worker intentionally fails closed and will not send.

## 6. Safety confirmation

- No production/staging database was changed; the migration was not applied.
- No Windows task was installed, stopped, restarted or removed.
- No worker was started, stopped or restarted.
- No provider account was connected or activated; no credentials were changed.
- No email was sent and no queue rows were modified.
- Dynamic Gmail/Zoho/SMTP multi-account outreach, Zoho's per-message human approval, Resend's separate transactional role, recipient consent and Phase 8 final human approval remain intact.

## 7. Stop condition

Phase 12 local implementation is complete. **Stop here. Phase 13 must be separately authorized.**
