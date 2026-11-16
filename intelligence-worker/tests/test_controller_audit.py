"""Regression tests for the controller audit (2026-11-13). Stdlib only; no real worker is spawned."""
from __future__ import annotations

import importlib.util
import tempfile
import threading
import time
import unittest
from pathlib import Path

PATH = Path(__file__).resolve().parents[1] / "controller.py"
_spec = importlib.util.spec_from_file_location("kairflow_controller_audit", PATH)
ctl = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ctl)

TOKEN = "A" * 44


class FakeProc:
    def __init__(self, returncode=None): self.returncode, self.pid = returncode, 5
    def poll(self): return self.returncode
    def terminate(self): self.returncode = 0
    def kill(self): self.returncode = -9
    def wait(self, timeout=None): return self.returncode
    def send_signal(self, sig): self.returncode = 0


def make(tmp: Path) -> "ctl.WorkerController":
    c = ctl.WorkerController.__new__(ctl.WorkerController)
    c.lock = threading.RLock(); c.token_file = tmp / "controller.token"
    c.env_file = tmp / "worker.env"; c.python = tmp / "python.exe"; c.worker_dir = tmp; c.log_file = tmp / "worker.log"
    c.process = None; c.desired_running = False; c.started_at = None; c.started_mono = None
    c.last_exit_code = None; c.last_error = None; c.restart_at = 0.0; c.restart_count = 0; c.consecutive_failures = 0
    c.closed = threading.Event()
    return c


class AuthRobustness(unittest.TestCase):
    def test_non_ascii_bearer_is_rejected_not_crashed(self):
        with tempfile.TemporaryDirectory() as d:
            c = make(Path(d)); c.token_file.write_text(TOKEN, encoding="utf-8")
            self.assertFalse(c.authenticate("Bearer " + "é" * 44))   # used to raise TypeError inside the request thread

    def test_token_file_with_utf8_bom_still_authenticates(self):
        with tempfile.TemporaryDirectory() as d:
            c = make(Path(d)); c.token_file.write_bytes(b"\xef\xbb\xbf" + TOKEN.encode() + b"\r\n")
            self.assertTrue(c.authenticate("Bearer " + TOKEN))

    def test_undecodable_token_file_fails_closed(self):
        with tempfile.TemporaryDirectory() as d:
            c = make(Path(d)); c.token_file.write_bytes(b"\xff\xfe\x00bad" * 20)
            self.assertFalse(c.authenticate("Bearer " + TOKEN))


class LifecycleState(unittest.TestCase):
    def test_stop_clears_stale_crash_message_and_process(self):
        with tempfile.TemporaryDirectory() as d:
            c = make(Path(d)); c.process = FakeProc(); c.desired_running = True
            c.last_error = "The worker stopped unexpectedly (exit 1) ... restarting in 80s"; c.restart_at = time.monotonic() + 80
            st = c.stop()
            self.assertIsNone(st["last_error"]); self.assertFalse(st["worker_running"])
            self.assertIsNone(c.process); self.assertEqual(c.restart_at, 0); self.assertIsNone(st["next_restart_seconds"])

    def test_failed_explicit_start_does_not_leave_phantom_desired_state(self):
        with tempfile.TemporaryDirectory() as d:
            c = make(Path(d))                      # worker.env does not exist
            with self.assertRaises(RuntimeError):
                c.start()
            self.assertFalse(c.desired_running); self.assertEqual(c.restart_at, 0)
            self.assertIn("Worker settings file not found", c.last_error)

    def test_blank_ollama_url_means_default_like_the_worker(self):
        with tempfile.TemporaryDirectory() as d:
            c = make(Path(d)); (Path(d) / "kairflow_intel").mkdir(); (Path(d) / "kairflow_intel" / "__main__.py").write_text("")
            c.env_file.write_text("KAIRFLOW_OLLAMA_URL=\n", encoding="utf-8"); c.python.write_text("")
            try:
                c._spawn()                          # python.exe is an empty file, so Popen itself fails; the Ollama guard must not be what raises
            except RuntimeError as exc:
                self.fail(f"blank KAIRFLOW_OLLAMA_URL was rejected: {exc}")
            except Exception:
                pass

    def test_remote_ollama_url_is_still_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            c = make(Path(d)); (Path(d) / "kairflow_intel").mkdir(); (Path(d) / "kairflow_intel" / "__main__.py").write_text("")
            c.env_file.write_text("KAIRFLOW_OLLAMA_URL=http://10.0.0.5:11434\n", encoding="utf-8"); c.python.write_text("")
            with self.assertRaises(RuntimeError):
                c._spawn()

    def test_monitor_tick_exception_does_not_kill_supervisor_thread(self):
        with tempfile.TemporaryDirectory() as d:
            c = make(Path(d)); calls = []
            def boom(): calls.append(1); raise ValueError("x")
            c._monitor_tick = boom
            t = threading.Thread(target=c._monitor, daemon=True)
            orig = c.closed.wait; n = {"i": 0}
            def fast_wait(_t):
                n["i"] += 1; return n["i"] > 3
            c.closed.wait = fast_wait
            t.start(); t.join(timeout=3)
            self.assertEqual(len(calls), 3)         # kept ticking after the first failure
            self.assertIn("supervisor error", c.last_error)


if __name__ == "__main__":
    unittest.main()


class SlowClient(unittest.TestCase):
    def test_handler_has_socket_timeout(self):
        self.assertTrue(0 < ctl.Handler.timeout <= 30)


class DeliberateStop(unittest.TestCase):
    def test_stop_does_not_report_a_failure_exit_code_or_crash_streak(self):
        with tempfile.TemporaryDirectory() as d:
            c = make(Path(d)); c.process = FakeProc(); c.desired_running = True; c.consecutive_failures = 4
            st = c.stop()
            self.assertIsNone(st["last_exit_code"]); self.assertEqual(st["consecutive_failures"], 0)


class SlowStop(unittest.TestCase):
    def test_status_stays_responsive_while_stop_waits_for_the_worker(self):
        class SlowProc(FakeProc):
            def terminate(self): pass
            def wait(self, timeout=None): time.sleep(0.6); self.returncode = 0; return 0
        with tempfile.TemporaryDirectory() as d:
            c = make(Path(d)); c.process = SlowProc(); c.desired_running = True
            t = threading.Thread(target=c.stop); t.start(); time.sleep(0.15)
            t0 = time.monotonic(); st = c.status(); took = time.monotonic() - t0
            t.join(3)
            self.assertLess(took, 0.3)                 # used to block until stop() finished
            self.assertFalse(c.desired_running); self.assertIsNone(c.process)

    def test_start_waits_for_a_stop_in_progress(self):
        class SlowProc(FakeProc):
            def terminate(self): pass
            def wait(self, timeout=None): time.sleep(0.5); self.returncode = 0; return 0
        with tempfile.TemporaryDirectory() as d:
            c = make(Path(d)); c.process = SlowProc(); c.desired_running = True
            order = []
            orig_spawn = c._spawn
            c._spawn = lambda: order.append("spawn")
            t = threading.Thread(target=lambda: (c.stop(), order.append("stopped"))); t.start(); time.sleep(0.1)
            c.start(); t.join(3)
            self.assertEqual(order, ["stopped", "spawn"])   # no start/stop interleaving


class EnvExport(unittest.TestCase):
    def test_export_prefix_is_accepted(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "worker.env"; f.write_text("export A=1\nexport   B=\"two words\"\nexporter=3\n", encoding="utf-8")
            self.assertEqual(ctl.read_env_file(f), {"A": "1", "B": "two words", "exporter": "3"})


class DiagnosticsTests(unittest.TestCase):
    def test_pythonw_streams_are_redirected_to_controller_log(self):
        import sys, tempfile
        from pathlib import Path
        saved = (sys.stdout, sys.stderr)
        with tempfile.TemporaryDirectory() as d:
            try:
                sys.stdout = sys.stderr = None            # what pythonw.exe provides
                path = ctl.attach_diagnostics(Path(d) / "worker.log")
                print("boom", file=sys.stderr, flush=True)
                self.assertEqual(path, Path(d) / "controller.log")
                self.assertIn("boom", path.read_text(encoding="utf-8"))
            finally:
                if sys.stderr is not None and sys.stderr is not saved[1]:
                    sys.stderr.close()
                sys.stdout, sys.stderr = saved

    def test_console_run_is_left_alone(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(ctl.attach_diagnostics(Path(d) / "worker.log"))
            self.assertFalse((Path(d) / "controller.log").exists())
