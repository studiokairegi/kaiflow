"""Master off switch: POST /api/shutdown stops the worker and then the controller itself. Real local HTTP server on 127.0.0.1:17843 (the
controller's fixed port); the worker process is a fake. Mocked/local only; not a Windows or Task Scheduler test."""
from __future__ import annotations

import http.client
import importlib.util
import json
import socket
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

PATH = Path(__file__).resolve().parents[1] / "controller.py"
_spec = importlib.util.spec_from_file_location("kairflow_controller_shutdown", PATH)
ctl = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(ctl)

TOKEN = "A" * 44
ORIGIN = "https://app.studiokairegi.com"


class FakeProc:
    def __init__(self): self.returncode, self.pid, self.terminated = None, 77, False
    def poll(self): return self.returncode
    def terminate(self): self.terminated = True; self.returncode = 0
    def kill(self): self.returncode = -9
    def wait(self, timeout=None): return self.returncode
    def send_signal(self, sig): self.terminated = True; self.returncode = 0


def port_free() -> bool:
    with socket.socket() as s:
        return s.connect_ex((ctl.HOST, ctl.PORT)) != 0


@unittest.skipUnless(port_free(), "controller port 17843 is in use on this machine")
class ShutdownEndpoint(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); tok = Path(self.tmp.name) / "controller.token"; tok.write_text(TOKEN, encoding="utf-8")
        c = ctl.WorkerController.__new__(ctl.WorkerController)
        c.lock = threading.RLock(); c.token_file = tok; c.process = FakeProc(); c.desired_running = True; c.started_at = "x"
        c.started_mono = time.monotonic(); c.last_exit_code = None; c.last_error = None; c.restart_at = 0.0
        c.restart_count = 0; c.consecutive_failures = 0; c.closed = threading.Event()
        self.c = c
        ctl.Handler.controller = c
        self.server = ThreadingHTTPServer((ctl.HOST, ctl.PORT), ctl.Handler); self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True); self.thread.start()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.tmp.cleanup()

    def post(self, path, token=TOKEN, origin=ORIGIN):
        conn = http.client.HTTPConnection(ctl.HOST, ctl.PORT, timeout=5)
        headers = {"Origin": origin, "Content-Type": "application/json", "Host": f"{ctl.HOST}:{ctl.PORT}"}
        if token: headers["Authorization"] = f"Bearer {token}"
        conn.request("POST", path, body="{}", headers=headers)
        r = conn.getresponse(); body = json.loads(r.read() or b"{}"); conn.close()
        return r.status, body

    def test_unauthenticated_or_foreign_origin_requests_cannot_shut_anything_down(self):
        self.assertEqual(self.post("/api/shutdown", token=None)[0], 401)
        self.assertEqual(self.post("/api/shutdown", token="B" * 44)[0], 401)
        self.assertEqual(self.post("/api/shutdown", origin="https://evil.example")[0], 403)
        self.assertTrue(self.c.desired_running); self.assertFalse(self.c.process.terminated)

    def test_authenticated_shutdown_stops_the_worker_then_the_controller_stops_serving(self):
        proc = self.c.process
        status, body = self.post("/api/shutdown")
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"]); self.assertTrue(body["controller_exiting"]); self.assertFalse(body["worker_running"])
        self.assertTrue(proc.terminated)
        self.assertFalse(self.c.desired_running)                     # the monitor loop can no longer restart the worker
        self.assertEqual(self.c.restart_at, 0)
        self.thread.join(timeout=3)
        self.assertFalse(self.thread.is_alive())                     # serve_forever returned: main() will return 0

    def test_plain_stop_still_leaves_the_controller_running(self):
        status, body = self.post("/api/stop")
        self.assertEqual(status, 200); self.assertNotIn("controller_exiting", body)
        self.assertTrue(self.thread.is_alive())


if __name__ == "__main__":
    unittest.main()
