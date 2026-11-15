# Controller audit — `intelligence-worker/controller.py` (2026-11-13)

Scope: `controller.py` only (v1.2.0 -> v1.2.4), plus its tests. No migrations, no deploys, no worker restarts, no secrets touched.
Verification: 10 existing controller tests + 8 new regression tests pass; full worker suite 1032 tests pass.
7 of the 8 new tests fail against the original controller (the 8th, remote-Ollama rejection, guards behavior that was already correct).
Not tested here: Windows behavior (Task Scheduler, SO_EXCLUSIVEADDRUSE, CTRL_BREAK, Chrome Private Network Access). Linux sandbox only.

## Fixed

| # | Severity | Bug | Fix |
|---|----------|-----|-----|
| 1 | High | `authenticate()` called `hmac.compare_digest` on `str`. Non-ASCII input raises `TypeError`, so the request thread dies with no HTTP response. A token file saved with a UTF-8 BOM (not removed by `.strip()`) made *every* authenticated request crash the same way. | Read token with `utf-8-sig`, compare as bytes, catch `UnicodeError`. |
| 2 | High | `main()` ran `auto_start()` *before* binding port 17843. If the port was taken, the controller exited after already spawning a worker nothing supervises (orphan, and later exit-73 confusion). | Bind first; only then create the controller / auto-start. Cleanup only calls `server.shutdown()` if serving began. |
| 3 | Medium (Windows) | `http.server` sets `SO_REUSEADDR`; on Windows that lets another process bind the same port (second controller, or a local program that could receive the bearer token). | `ControllerServer`: `SO_EXCLUSIVEADDRUSE` on Windows, `SO_REUSEADDR` kept on POSIX. |
| 4 | Medium | No SIGTERM/SIGBREAK handling: stopping the controller (task end, `kill`) skipped the `finally` block, leaving the worker running unmanaged; Stop in the UI then controls nothing. | Signal handlers trigger the normal shutdown path, which stops the worker. (Hard kill / TerminateProcess still cannot be caught.) |
| 5 | Medium | `_monitor` had no exception guard; one unexpected error silently killed the supervisor thread (no exit tracking, no restarts). | Per-tick try/except; error recorded in `last_error`. |
| 6 | Medium | Blank `KAIRFLOW_OLLAMA_URL=` was rejected by the controller ("must point to this computer") while the worker treats blank as the default. | Blank = default `http://127.0.0.1:11434`. Remote hosts still rejected. |
| 7 | Medium | POST body was never read. Closing a socket with unread data can send a TCP reset on Windows, surfacing as "Failed to fetch" before the browser reads the response. Negative / invalid `Content-Length` was silently accepted. | Body (<=1024 bytes) is drained; invalid or negative length -> 400. |
| 8 | Low-Med | After a crash, `last_error` ("restarting in 80s") stayed in status after the user pressed Stop; stale `started_mono`/`process` were left behind; `kill()` followed by an uncaught `wait()` timeout returned a misleading 400. | `stop()` clears them and tolerates a failed kill-wait. |
| 9 | Low-Med | A failed explicit `start()` (e.g. missing worker.env) left `desired_running=True` with no retry scheduled and no `last_error`. A successful Start also left a stale backoff timer. | Failed Start rolls back and records `last_error`; successful Start clears `restart_at`. |
| 10 | Low | Every unexpected exception returned HTTP 400. | `RuntimeError` (preconditions) stays 400; anything else is 500. |
| 11 | - | (Withdrawn) Replacing the literal `73` with `DUPLICATE_EXIT` broke `phase12-worker-reliability-contract.test.mjs`, which asserts the literal in the source. Reverted; not a bug. | - |

## Re-audit (v1.2.2)

Ran the real controller against a dummy worker process (auto-start, Start/Stop, crash-loop backoff, SIGTERM). All behaved correctly, with one new finding:

| # | Severity | Bug | Fix |
|---|----------|-----|-----|
| 12 | Medium | Handler sockets had no timeout. A client that connected, or declared a request body and sent nothing, pinned a handler thread forever (reproduced: no answer after 20 s). My body-drain fix in #7 made this reachable for authenticated callers. | `Handler.timeout = 10`; the stalled request now ends after 10 s. |

Verified fine: SIGTERM stops the worker with the controller; crash message and restart timer clear on Stop; early worker output reaches `worker.log`. Tests: 19 controller tests, 1,033 in the full suite.

## Third pass (v1.2.3) - checked against the Settings UI

| # | Severity | Bug | Fix |
|---|----------|-----|-----|
| 13 | Low-Med | After a deliberate Stop, status kept the worker's exit code, so Settings showed "The worker exited with code N" (N = 3221225786 after a Windows Ctrl+Break) as a warning every time. This predates the audit. | `stop()` clears `last_exit_code` when it ended the process itself. |
| 14 | Low | Stop did not reset `consecutive_failures`, so Settings kept saying "Emma has stopped unexpectedly N times in a row... restarts are being spaced out" about a worker the user had stopped on purpose. | `stop()` resets the streak. |

Outside `controller.py`, not changed: `windows/install-controller.ps1` registers the task with `python.exe` (not `pythonw.exe`), so a console window can stay open at sign-in; closing it would kill the controller.

## Fourth pass (v1.2.4) - the previously listed items

| # | Item | Resolution |
|---|------|-----------|
| 15 | `stop()` held the controller lock up to ~13 s, blocking `/api/status` and the monitor. | Fixed. Terminate/wait now run outside the state lock; a separate operation lock keeps Start/Stop/Shutdown from interleaving. Tests: status answers in <0.3 s during a slow stop; Start waits for a Stop in progress. |
| 16 | `export KEY=value` lines in `worker.env` were silently skipped. | Fixed. |
| 17 | `install-controller.ps1` ran the controller with `python.exe` (console window left open at sign-in). | Fixed: uses `pythonw.exe` beside it when present, else falls back. **Not tested on Windows**; rerun the installer and confirm the controller still comes up. |

Deliberately NOT changed (decisions, not bugs):
- Inline `# comments` in `worker.env` values: stripping them would corrupt passwords/URLs containing ` #`.
- `ALLOWED_ORIGINS` (e.g. `vite preview` on 4173): widening it widens what may control your machine; add an origin only if you need it.
- Origin required on GET /api/status (curl without `Origin` gets 403): intentional.
- Repo hygiene (`.bak`, empty `wmic`, `.pyc`, `FIXES_APPLIED - Copy.md`): left alone; say if you want them removed.

## Acceptance run (v1.2.4)

`intelligence-worker/scripts/controller_acceptance.py` starts the real controller with a fake worker and checks 39 behaviours against the docs (all pass on Linux): auto-start and retry until `worker.env` exists; env pass-through and PYTHONPATH stripping; early output in worker.log; 401/403/404/413/415 guards incl. DNS-rebinding Host and non-ASCII bearer; CORS + Private Network Access preflight; remote-Ollama refusal; backoff escalation (20 s first delay measured with real constants), exit 2 delay, exit 73 never restarted, streak reset after a stable run; external kill restarted; Stop cancels backoff; SIGTERM-ignoring worker force-killed at ~8 s; Shutdown and SIGTERM stop worker and controller (exit 0).
Not covered: Windows (Task Scheduler, Ctrl+Break, exclusive port bind, pythonw), real Chrome PNA prompts, log rotation interplay.

## Fifth pass (v1.2.5)

| # | Severity | Item | Resolution |
|---|----------|------|-----------|
| 18 | Low-Med | Under `pythonw.exe` (the scheduled task) stdout/stderr are None, so controller crashes and supervisor errors left no trace. | `attach_diagnostics()` points them at `controller.log` beside `worker.log` when they are None; console runs unchanged. Supervisor errors now print a traceback. 2 new tests. |
| 19 | Low | `repair-controller.ps1` ignored `export ` prefixes and quotes in worker.env, unlike `controller.py`. | Same parsing as `read_env_file`. |
| 20 | Hygiene | Stray files. | Removed empty `git`, `main`, `intelligence-worker/wmic`, `controller.py.before-python-env-fix.bak`, `FIXES_APPLIED - Copy.md`, and all `__pycache__` folders. |

Not changed, still unverified on Windows: Ctrl+Break graceful stop under a console-less controller, `SO_EXCLUSIVEADDRUSE`, `pythonw.exe` startup.
