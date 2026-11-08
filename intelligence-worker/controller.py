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
import subprocess
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

VERSION = "1.1.0"
HOST = "127.0.0.1"
PORT = 17843
ALLOWED_ORIGINS = {
    "https://app.studiokairegi.com",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
}
LOCAL_OLLAMA = re.compile(r"^https?://(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?/?$", re.I)


def read_env_file(path: Path) -> dict[str, str]:
    """Read simple KEY=VALUE lines; do not evaluate shell syntax."""
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
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
        self.closed = threading.Event()
        self.monitor_thread = threading.Thread(target=self._monitor, daemon=True)
        self.monitor_thread.start()

    def authenticate(self, authorization: str) -> bool:
        match = re.fullmatch(r"Bearer\s+(\S+)", authorization or "", re.I)
        if not match or not self.token_file.is_file():
            return False
        try:
            expected = self.token_file.read_text(encoding="utf-8").strip()
        except OSError:
            return False
        supplied = match.group(1)
        # Installer tokens are base64-encoded 32-byte random values (44 chars).
        if len(expected) < 43 or len(supplied) < 43:
            return False
        return hmac.compare_digest(supplied, expected)

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
        env["KAIRFLOW_WORKER_LOG_FILE"] = str(self.log_file)
        ollama_url = env.get("KAIRFLOW_OLLAMA_URL", "http://127.0.0.1:11434")
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
        self.last_error = None
        self.last_exit_code = None

    def start(self) -> dict:
        with self.lock:
            if self.process is not None and self.process.poll() is None:
                self.desired_running = True
                return self.status()
            self.desired_running = True
            self._spawn()
            return self.status()

    def stop(self) -> dict:
        with self.lock:
            self.desired_running = False
            self.restart_at = 0
            proc = self.process
            if proc is not None and proc.poll() is None:
                try:
                    if os.name == "nt" and hasattr(signal, "CTRL_BREAK_EVENT"):
                        proc.send_signal(signal.CTRL_BREAK_EVENT)
                        proc.wait(timeout=8)
                    else:
                        proc.terminate()
                        proc.wait(timeout=8)
                except (subprocess.TimeoutExpired, OSError):
                    proc.kill()
                    proc.wait(timeout=5)
                self.last_exit_code = proc.returncode
            elif proc is not None:
                self.last_exit_code = proc.returncode
                self.process = None
                self.started_at = None
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
            }

    def _monitor(self) -> None:
        while not self.closed.wait(2):
            with self.lock:
                proc = self.process
                if proc is not None and proc.poll() is not None:
                    self.last_exit_code = proc.returncode
                    self.process = None
                    self.started_at = None
                    if proc.returncode == 73:
                        self.last_error = "Another worker instance is already running; controller will not start a duplicate."
                        self.desired_running = False
                        self.restart_at = 0
                    elif self.desired_running:
                        self.restart_at = time.monotonic() + 20
                if self.desired_running and self.process is None and self.restart_at and time.monotonic() >= self.restart_at:
                    try:
                        self._spawn()
                        self.restart_at = 0
                    except Exception as exc:
                        self.last_error = str(exc)[:500]
                        self.restart_at = time.monotonic() + 60

    def close(self) -> None:
        self.closed.set()
        self.stop()


class Handler(BaseHTTPRequestHandler):
    controller: WorkerController

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
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length > 1024:
            self._json(413, {"ok": False, "error": "Request too large."})
            return
        path = urlparse(self.path).path
        try:
            if path == "/api/start":
                self._json(200, self.controller.start())
            elif path == "/api/stop":
                self._json(200, self.controller.stop())
            else:
                self._json(404, {"ok": False, "error": "Not found."})
        except Exception as exc:
            self._json(400, {"ok": False, "error": str(exc)[:500]})


def main() -> int:
    parser = argparse.ArgumentParser(description="KairFlow local worker controller")
    parser.add_argument("--worker-dir", required=True)
    parser.add_argument("--env-file", required=True)
    parser.add_argument("--python", required=True)
    parser.add_argument("--log-file", required=True)
    parser.add_argument("--token-file", required=True)
    args = parser.parse_args()
    controller = WorkerController(Path(args.worker_dir), Path(args.env_file), Path(args.python), Path(args.log_file), Path(args.token_file))
    Handler.controller = controller
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    print(f"KairFlow local controller listening on http://{HOST}:{PORT}", flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()
        controller.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
