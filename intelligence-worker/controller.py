"""Loopback-only controller for starting/stopping the local KairFlow worker.

The browser app cannot spawn a process on the user's computer. This small
companion runs locally and exposes a tightly origin-restricted, per-install
token-authenticated HTTP API on 127.0.0.1 only. It never returns environment
variables or credentials.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import signal
import hmac
import socket
import subprocess
import sys
import threading
import time
import traceback
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

VERSION = "1.2.5"
HOST = "127.0.0.1"
PORT = 17843
ALLOWED_ORIGINS = {
    "https://app.studiokairegi.com",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
}
# Phase 4: restart policy. A worker that dies immediately (bad worker.env, missing model, import error) used to be restarted every 20 s forever,
# filling the log and hammering Supabase sign-in. Delays now escalate with consecutive short-lived runs and reset once a run stays up.
RESTART_DELAYS = (20, 40, 80, 160, 320, 600)
STABLE_SECONDS = 120          # a run that lasts this long counts as healthy and clears the failure streak
CONFIG_ERROR_EXIT = 2         # kairflow_intel exits 2 on ConfigError: retrying fast cannot help
CONFIG_ERROR_DELAY = 300
DUPLICATE_EXIT = 73


def restart_delay(consecutive_failures: int, exit_code: int | None) -> int:
    """Seconds to wait before restarting the worker after an unexpected exit."""
    n = max(1, int(consecutive_failures or 1))
    delay = RESTART_DELAYS[min(n, len(RESTART_DELAYS)) - 1]
    if exit_code == CONFIG_ERROR_EXIT:
        delay = max(delay, CONFIG_ERROR_DELAY)
    return delay


LOCAL_OLLAMA = re.compile(r"^https?://(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?/?$", re.I)


def read_env_file(path: Path) -> dict[str, str]:
    """Read simple KEY=VALUE lines; do not evaluate shell syntax."""
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if re.match(r"export\s", line):
            line = line[6:].lstrip()          # shell-style "export KEY=value" (previously skipped silently)
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        values[key] = value
    return values


def allowed_origin(origin: str | None) -> bool:
    return bool(origin and origin in ALLOWED_ORIGINS)


class WorkerController:
    # Serialises Start/Stop/Shutdown with each other so a slow Stop can run WITHOUT holding self.lock (status polls and the monitor stay responsive).
    # One controller per process, so a class-level lock is sufficient.
    _op_lock = threading.RLock()

    def __init__(self, worker_dir: Path, env_file: Path, python: Path, log_file: Path, token_file: Path):
        self.worker_dir = worker_dir.resolve()
        self.token_file = token_file.resolve()
        self.env_file = env_file.resolve()
        self.python = python.resolve()
        self.log_file = log_file.resolve()
        self.lock = threading.RLock()
        self.process: subprocess.Popen | None = None
        self.desired_running = False
        self.started_at: str | None = None
        self.last_exit_code: int | None = None
        self.last_error: str | None = None
        self.restart_at = 0.0
        self.restart_count = 0
        self.consecutive_failures = 0
        self.started_mono: float | None = None
        self.closed = threading.Event()
        self.monitor_thread = threading.Thread(target=self._monitor, daemon=True)
        self.monitor_thread.start()

    def authenticate(self, authorization: str) -> bool:
        match = re.fullmatch(r"Bearer\s+(\S+)", authorization or "", re.I)
        if not match or not self.token_file.is_file():
            return False
        try:
            # utf-8-sig: a token file saved by an editor/PowerShell with a BOM must still match.
            expected = self.token_file.read_text(encoding="utf-8-sig").strip()
        except (OSError, UnicodeError):
            return False
        supplied = match.group(1)
        # Installer tokens are base64-encoded 32-byte random values (44 chars).
        if len(expected) < 43 or len(supplied) < 43:
            return False
        # Compare bytes: hmac.compare_digest() raises TypeError on non-ASCII str, which would crash the request thread with no response.
        return hmac.compare_digest(supplied.encode("utf-8", "replace"), expected.encode("utf-8", "replace"))

    def _capture_output(self, proc: subprocess.Popen) -> None:
        stream = getattr(proc, "stdout", None)
        if stream is None:
            return
        def read_early_output():
            try:
                for line in stream:
                    # The worker switches its own stdout/stderr to the rotating
                    # handler after startup. This pipe captures only interpreter,
                    # import and pre-logger failures; open per line so it never
                    # holds the log file open across live rotations.
                    try:
                        self.log_file.parent.mkdir(parents=True, exist_ok=True)
                        with self.log_file.open("a", encoding="utf-8") as log:
                            log.write(line)
                    except OSError:
                        pass
            except (OSError, ValueError):
                pass
            finally:
                try:
                    stream.close()
                except OSError:
                    pass
        threading.Thread(target=read_early_output, name="kairflow-worker-output", daemon=True).start()

    def _spawn(self) -> None:
        if not self.env_file.is_file():
            raise RuntimeError(f"Worker settings file not found: {self.env_file}")
        if not self.python.is_file():
            raise RuntimeError(f"Python environment not found: {self.python}")
        if not (self.worker_dir / "kairflow_intel" / "__main__.py").is_file():
            raise RuntimeError(f"Worker package not found in: {self.worker_dir}")
        env = os.environ.copy()
        env.update(read_env_file(self.env_file))
        for key in ('PYTHONHOME', 'PYTHONPATH', 'PYTHONUSERBASE', 'PYTHONSTARTUP'):
            env.pop(key, None)
        env['PYTHONNOUSERSITE'] = '1'
        env["KAIRFLOW_WORKER_LOG_FILE"] = str(self.log_file)
        ollama_url = (env.get("KAIRFLOW_OLLAMA_URL") or "").strip() or "http://127.0.0.1:11434"   # blank = default, same as the worker
        if not LOCAL_OLLAMA.fullmatch(ollama_url):
            raise RuntimeError("KAIRFLOW_OLLAMA_URL must point to this computer (127.0.0.1/localhost).")
        self.log_file.parent.mkdir(parents=True, exist_ok=True)
        creationflags = 0
        if os.name == "nt":
            creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        try:
            self.process = subprocess.Popen(
                [str(self.python), "-m", "kairflow_intel", "run"],
                cwd=str(self.worker_dir), env=env,
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding="utf-8", errors="replace", bufsize=1,
                creationflags=creationflags,
            )
        except Exception:
            raise
        self._capture_output(self.process)
        self.started_at = datetime.now(timezone.utc).isoformat()
        self.started_mono = time.monotonic()
        self.last_error = None
        self.last_exit_code = None

    def start(self) -> dict:
        with self._op_lock, self.lock:
            if self.process is not None and self.process.poll() is None:
                self.desired_running = True
                return self.status()
            self.desired_running = True
            self.consecutive_failures = 0       # an explicit Start clears the crash-loop streak
            try:
                self._spawn()
            except Exception as exc:
                # A failed explicit Start must not leave "desired running" set with nothing scheduled to retry it.
                self.desired_running = False
                self.restart_at = 0
                self.last_error = str(exc)[:500]
                raise
            self.restart_at = 0                 # drop any backoff timer left from a crash loop
            return self.status()

    def stop(self) -> dict:
        with self._op_lock:
            with self.lock:
                self.desired_running = False
                self.restart_at = 0
                proc = self.process
                was_running = proc is not None and proc.poll() is None
            if was_running:
                # Terminate/wait can take up to 13 s; do it without self.lock so /api/status and the monitor are not blocked meanwhile.
                try:
                    if os.name == "nt" and hasattr(signal, "CTRL_BREAK_EVENT"):
                        proc.send_signal(signal.CTRL_BREAK_EVENT)
                        proc.wait(timeout=8)
                    else:
                        proc.terminate()
                        proc.wait(timeout=8)
                except (subprocess.TimeoutExpired, OSError):
                    try:
                        proc.kill()
                        proc.wait(timeout=5)
                    except (subprocess.TimeoutExpired, OSError):
                        pass
            with self.lock:
                if proc is not None and proc.poll() is not None:
                    # An exit we requested is not a failure: leaving the code set makes Settings show "The worker exited with code N"
                    # (N is 3221225786 after a Windows Ctrl+Break) as a warning after every deliberate Stop. An exit that happened on its own
                    # before Stop keeps its code.
                    self.last_exit_code = None if was_running else proc.returncode
                    if self.process is proc:
                        self.process = None
                        self.started_at = None
                        self.started_mono = None
                # A deliberate Stop supersedes any "restarting in Ns" crash message, and ends a crash-loop streak (Settings otherwise keeps
                # warning "stopped unexpectedly N times in a row" about a worker the user has deliberately stopped).
                self.last_error = None
                self.consecutive_failures = 0
                return self.status()

    def status(self) -> dict:
        with self.lock:
            running = self.process is not None and self.process.poll() is None
            return {
                "ok": True,
                "controller_version": VERSION,
                "worker_running": running,
                "worker_pid": self.process.pid if running and self.process else None,
                "worker_started_at": self.started_at if running else None,
                "last_exit_code": self.last_exit_code,
                "duplicate_worker_detected": self.last_exit_code == 73,
                "last_error": self.last_error,
                # Phase 4 (additive): crash-loop visibility
                "restart_count": getattr(self, "restart_count", 0),
                "consecutive_failures": getattr(self, "consecutive_failures", 0),
                "next_restart_seconds": self._next_restart_seconds(),
            }

    def _next_restart_seconds(self) -> int | None:
        at = getattr(self, "restart_at", 0) or 0
        if not at or not getattr(self, "desired_running", False) or self.process is not None:
            return None
        return max(0, int(round(at - time.monotonic())))

    def _monitor(self) -> None:
        while not self.closed.wait(2):
            try:
                self._monitor_tick()
            except Exception as exc:  # never let the supervisor thread die silently: no restarts or exit tracking would follow
                traceback.print_exc()
                with self.lock:
                    self.last_error = f"Controller supervisor error: {str(exc)[:400]}"

    def _monitor_tick(self) -> None:
        with self.lock:
            proc = self.process
            if proc is not None and proc.poll() is not None:
                self.last_exit_code = proc.returncode
                self.process = None
                ran_for = time.monotonic() - self.started_mono if self.started_mono else 0.0
                self.started_at = None
                self.started_mono = None
                if proc.returncode == 73:  # DUPLICATE_EXIT
                    self.last_error = "Another worker instance is already running; controller will not start a duplicate."
                    self.desired_running = False
                    self.restart_at = 0
                elif self.desired_running:
                    # A run that stayed up for STABLE_SECONDS was healthy: start the streak over. Otherwise escalate.
                    self.consecutive_failures = 1 if ran_for >= STABLE_SECONDS else self.consecutive_failures + 1
                    delay = restart_delay(self.consecutive_failures, proc.returncode)
                    self.restart_at = time.monotonic() + delay
                    if proc.returncode == CONFIG_ERROR_EXIT:
                        self.last_error = (f"The worker stopped with a configuration error (exit {CONFIG_ERROR_EXIT}). Check worker.env and worker.log; "
                                           f"retrying in {delay}s.")
                    else:
                        self.last_error = (f"The worker stopped unexpectedly (exit {proc.returncode}) after {int(ran_for)}s; restarting in {delay}s "
                                           f"(consecutive failures: {self.consecutive_failures}). See worker.log.")
            if self.desired_running and self.process is None and self.restart_at and time.monotonic() >= self.restart_at:
                try:
                    self._spawn()
                    self.restart_count += 1
                    self.restart_at = 0
                    # _spawn clears last_error on success; the streak stays until the run proves stable or an explicit Start clears it
                except Exception as exc:
                    self.consecutive_failures += 1
                    self.last_error = str(exc)[:500]
                    self.restart_at = time.monotonic() + max(60, restart_delay(self.consecutive_failures, None))

    def auto_start(self) -> dict:
        """Start the worker when the controller launches with --auto-start.

        If local prerequisites are not ready yet (for example worker.env is
        still being completed), retain the desired state and retry in the
        monitor loop. A manual Stop clears desired_running and prevents restart.
        """
        with self.lock:
            self.desired_running = True
            try:
                if self.process is None or self.process.poll() is not None:
                    self._spawn()
                self.restart_at = 0
            except Exception as exc:
                self.last_error = str(exc)[:500]
                self.restart_at = time.monotonic() + 30
            return self.status()

    def shutdown(self) -> dict:
        """Master off switch: stop the worker AND mark the controller itself as finished.

        Clearing desired_running first guarantees the monitor loop cannot restart the worker while the process winds down. The HTTP handler
        replies and then stops the server; main() returns 0, which Task Scheduler treats as a normal finish (it restarts only failed runs), so the
        controller stays off until the next sign-in or until the app's launcher (windows/launcher.ps1) starts it again."""
        with self._op_lock:
            with self.lock:
                self.desired_running = False
                self.restart_at = 0
            status = self.stop()
        status["controller_exiting"] = True
        return status

    def close(self) -> None:
        self.closed.set()
        self.stop()


class ControllerServer(ThreadingHTTPServer):
    """Refuse to share the control port with another process.

    http.server sets SO_REUSEADDR, which on Windows lets a second process (a duplicate controller or another local program) bind the same
    port and receive requests, including the bearer token. Windows gets SO_EXCLUSIVEADDRUSE instead; POSIX keeps SO_REUSEADDR (there it only
    permits rebinding through TIME_WAIT)."""
    daemon_threads = True
    allow_reuse_address = os.name != "nt"

    def server_bind(self):
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


class Handler(BaseHTTPRequestHandler):
    controller: WorkerController
    # Without a socket timeout a client that connects (or declares a body) and then goes silent pins a handler thread forever.
    timeout = 10

    def log_message(self, fmt, *args):  # keep server logs quiet
        return

    def _cors(self) -> bool:
        origin = self.headers.get("Origin")
        if not allowed_origin(origin):
            return False
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        if self.headers.get("Access-Control-Request-Private-Network", "").lower() == "true":
            self.send_header("Access-Control-Allow-Private-Network", "true")
        return True

    def _json(self, code: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        origin = self.headers.get("Origin")
        if allowed_origin(origin):
            self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _valid_request(self, require_auth: bool = True) -> bool:
        # Origin + Host checks constrain browser callers; the per-install bearer token
        # independently authenticates control operations (CORS is not authentication).
        host = self.headers.get("Host", "").lower()
        if host not in (f"{HOST}:{PORT}", f"localhost:{PORT}"):
            self._json(403, {"ok": False, "error": "Invalid local host header."})
            return False
        if not allowed_origin(self.headers.get("Origin")):
            self._json(403, {"ok": False, "error": "This app origin is not allowed."})
            return False
        if require_auth and not self.controller.authenticate(self.headers.get("Authorization", "")):
            self._json(401, {"ok": False, "error": "Local controller authentication is required. Enter the token from controller.token in KairFlow Settings."})
            return False
        return True

    def do_OPTIONS(self):
        if not self._valid_request(require_auth=False):
            return
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if not self._valid_request():
            return
        if urlparse(self.path).path != "/api/status":
            self._json(404, {"ok": False, "error": "Not found."})
            return
        self._json(200, self.controller.status())

    def do_POST(self):
        if not self._valid_request():
            return
        if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            self._json(415, {"ok": False, "error": "Content-Type must be application/json."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            self._json(400, {"ok": False, "error": "Invalid Content-Length."})
            return
        if length < 0:
            self._json(400, {"ok": False, "error": "Invalid Content-Length."})
            return
        if length > 1024:
            self._json(413, {"ok": False, "error": "Request too large."})
            return
        if length:
            # Consume the (tiny) body. Closing the socket with unread request data can make Windows send a reset, which the browser reports as
            # "Failed to fetch" before it ever reads the response.
            try:
                self.rfile.read(length)
            except OSError:
                return
        path = urlparse(self.path).path
        try:
            if path == "/api/start":
                self._json(200, self.controller.start())
            elif path == "/api/stop":
                self._json(200, self.controller.stop())
            elif path == "/api/shutdown":
                payload = self.controller.shutdown()
                self._json(200, payload)
                # serve_forever() runs in the main thread; shutdown() must be called from another one.
                threading.Thread(target=self.server.shutdown, name="kairflow-controller-shutdown", daemon=True).start()
            else:
                self._json(404, {"ok": False, "error": "Not found."})
        except RuntimeError as exc:      # precondition failures (missing worker.env / Python / package, non-local Ollama URL)
            self._json(400, {"ok": False, "error": str(exc)[:500]})
        except Exception as exc:         # anything else is a controller fault, not a bad request
            self._json(500, {"ok": False, "error": str(exc)[:500]})


def attach_diagnostics(log_file: Path) -> Path | None:
    """Under pythonw.exe (the scheduled task) sys.stdout/sys.stderr are None, so a crash or traceback leaves no trace at all. Point them at
    controller.log beside worker.log. Console runs are left alone."""
    if sys.stdout is not None and sys.stderr is not None:
        return None
    path = log_file.with_name("controller.log")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        stream = path.open("a", encoding="utf-8", buffering=1)
    except OSError:
        return None
    if sys.stdout is None:
        sys.stdout = stream
    if sys.stderr is None:
        sys.stderr = stream
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description="KairFlow local worker controller")
    parser.add_argument("--worker-dir", required=True)
    parser.add_argument("--env-file", required=True)
    parser.add_argument("--python", required=True)
    parser.add_argument("--log-file", required=True)
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--auto-start", action="store_true", help="Start the worker automatically when the controller launches")
    args = parser.parse_args()
    attach_diagnostics(Path(args.log_file))
    # Bind the port BEFORE creating the controller or auto-starting the worker: if the port is taken (a duplicate controller, another program)
    # we must exit without having spawned a worker that nothing supervises.
    Handler.controller = None  # type: ignore[assignment]
    server = ControllerServer((HOST, PORT), Handler)
    controller = WorkerController(Path(args.worker_dir), Path(args.env_file), Path(args.python), Path(args.log_file), Path(args.token_file))
    Handler.controller = controller

    def _graceful(_signum=None, _frame=None):
        # Task Scheduler / OS shutdown / `kill`: stop serving so the finally block below stops the worker too (otherwise it is orphaned).
        threading.Thread(target=server.shutdown, name="kairflow-controller-signal", daemon=True).start()
    for name in ("SIGTERM", "SIGBREAK"):
        sig = getattr(signal, name, None)
        if sig is not None:
            try:
                signal.signal(sig, _graceful)
            except (ValueError, OSError):
                pass
    serving = False
    try:
        if args.auto_start:
            controller.auto_start()
        print(f"KairFlow local controller listening on http://{HOST}:{PORT}", flush=True)
        serving = True
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        if serving:
            server.shutdown()   # shutdown() blocks forever if serve_forever() never started
        server.server_close()
        controller.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
