"""Phase 4: controller / worker / job-execution reliability.

Everything here is a MOCKED test: a fake database (rpc callable), fake provider clients and a scripted clock. It proves the worker's behaviour
around the database state machine; it does not prove the SQL (see supabase/tests/intelligence_phase4_job_reliability.test.sql, not executed
in the session that wrote it) and it is not a live run against Supabase, Ollama or Gemini.
"""
from __future__ import annotations

import importlib.util
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

from kairflow_intel import jobs
from kairflow_intel.airouter import RouterSettings
from kairflow_intel.errors import PermanentError, RpcError, TransientError
from kairflow_intel.gemini import FallbackLLM
from kairflow_intel.job_policy import (BACKGROUND_BACKOFF, INTERACTIVE_BACKOFF, classify_failure, scrub_error, settle_delays,
                                       transient_backoff)
from .helpers import CFG
from .test_ai_router import FakeGemini, FakeOllama

CONTROLLER_PATH = Path(__file__).resolve().parents[1] / "controller.py"
_spec = importlib.util.spec_from_file_location("kairflow_local_controller_p4", CONTROLLER_PATH)
controller = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(controller)

NOW = 1_800_000_000.0


class Db:
    """Scriptable fake of the intel_agent_* RPC surface the worker uses for job settlement and scheduling."""
    def __init__(self):
        self.calls, self.script, self.sleeps = [], {}, []

    def on(self, name, *outcomes):
        """Outcomes are consumed in order (the last repeats): a value is returned, an Exception is raised."""
        self.script[name] = list(outcomes)

    def __call__(self, name, params=None):
        params = params or {}
        self.calls.append((name, params))
        outs = self.script.get(name)
        if not outs:
            return {"intel_agent_complete_job": True, "intel_agent_fail_job": "queued", "intel_agent_fail_job_permanent": "dead"}.get(name)
        o = outs.pop(0) if len(outs) > 1 else outs[0]
        if isinstance(o, BaseException):
            raise o
        return o

    def named(self, name):
        return [p for n, p in self.calls if n == name]

    def count(self, name):
        return len(self.named(name))


def make_worker(db, *, llm=None, rand=None, lease_thread=False):
    d = jobs.Deps(cfg=CFG, rpc=db, fetcher=None, zoho=None, llm=llm, sleep=lambda s: db.sleeps.append(s), clock=lambda: NOW,
                  **({"rand": rand} if rand else {"rand": lambda a, b: 1.0}))
    return jobs.Worker(d, lease_thread=lease_thread)


def with_handler(kind, fn):
    class Ctx:
        def __enter__(self):
            self.orig = jobs.HANDLERS.get(kind); jobs.HANDLERS[kind] = fn
        def __exit__(self, *a):
            if self.orig is None: jobs.HANDLERS.pop(kind, None)
            else: jobs.HANDLERS[kind] = self.orig
    return Ctx()


def raiser(exc):
    def h(d, job):
        raise exc
    return h


JOB = {"id": "j1", "kind": "discover", "attempts": 1, "max_attempts": 5, "payload": {}}


class BackoffPolicy(unittest.TestCase):
    def test_background_schedule_spans_hours_not_minutes(self):
        delays = [transient_backoff("discover", n) for n in range(1, 6)]
        self.assertEqual(delays, list(BACKGROUND_BACKOFF))
        # The four waits that happen between five attempts must outlast a restart or a short provider outage (the old schedule totalled 450 s).
        self.assertEqual(sum(delays[:4]), 60 + 300 + 900 + 3600)
        self.assertGreater(sum(delays[:4]), 60 * 75)

    def test_interactive_schedule_is_short(self):
        self.assertEqual([transient_backoff("chat", n) for n in range(1, 6)], list(INTERACTIVE_BACKOFF))
        self.assertLessEqual(max(INTERACTIVE_BACKOFF), 240)

    def test_attempts_out_of_range_are_clamped_and_jitter_is_bounded(self):
        self.assertEqual(transient_backoff("discover", 0), BACKGROUND_BACKOFF[0])
        self.assertEqual(transient_backoff("discover", 99), BACKGROUND_BACKOFF[-1])
        self.assertEqual(transient_backoff("discover", None), BACKGROUND_BACKOFF[0])
        self.assertEqual(transient_backoff("discover", 3, rand=lambda a, b: a), int(900 * 0.9))
        self.assertEqual(transient_backoff("discover", 3, rand=lambda a, b: b), int(900 * 1.1))

    def test_settle_delays_are_a_bounded_minute(self):
        self.assertLessEqual(sum(settle_delays()), 90)


class Classification(unittest.TestCase):
    def test_classes(self):
        self.assertEqual(classify_failure(TransientError("x")), ("transient", False))
        self.assertEqual(classify_failure(PermanentError("x")), ("permanent", True))
        self.assertEqual(classify_failure(RpcError("rejected", "23514", 400)), ("database_rejected", True))
        self.assertEqual(classify_failure(RpcError("deadlock detected", "40P01", 409)), ("database_busy", False))
        self.assertEqual(classify_failure(RpcError("timeout", "57014", 500)), ("database_busy", False))
        self.assertEqual(classify_failure(ValueError("bug")), ("unexpected", False))


class Scrubbing(unittest.TestCase):
    def test_credentials_are_removed_and_length_is_bounded(self):
        for raw in ("Authorization: Bearer abcdefghijklmnop12345", "GET https://x.test/v1?key=SECRETVALUE123&a=1",
                    "api_key=SECRETVALUE123", 'password": "hunter2hunter2"', "AIzaSyA1234567890abcdefghijKLMNOP",
                    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop"):
            out = scrub_error("failed: " + raw)
            for secret in ("abcdefghijklmnop12345", "SECRETVALUE123", "hunter2hunter2", "AIzaSyA1234567890", "eyJhbGciOiJIUzI1NiJ9"):
                self.assertNotIn(secret, out, raw)
        self.assertEqual(len(scrub_error("x" * 5000, 400)), 400)
        self.assertEqual(scrub_error(None), "")
        self.assertEqual(scrub_error("a\n\n  b\tc"), "a b c")

    def test_ordinary_messages_are_untouched(self):
        self.assertEqual(scrub_error("ollama timed out after 60s"), "ollama timed out after 60s")


class FailureHandling(unittest.TestCase):
    def fail(self, exc, job=None, db=None):
        db = db or Db(); w = make_worker(db)
        with with_handler("discover", raiser(exc)):
            w.run_job(dict(job or JOB))
        return db, w

    def test_transient_is_retried_with_the_scheduled_backoff_and_audited(self):
        db, w = self.fail(TransientError("ollama down"), {**JOB, "attempts": 3})
        p = db.named("intel_agent_fail_job")[0]
        self.assertEqual(p["p_retry_seconds"], 900)
        self.assertTrue(p["p_error"].startswith("transient: ollama down"))
        a = db.named("intel_agent_log")[0]
        self.assertEqual(a["p_action"], "job_failed")
        d = a["p_detail"]
        self.assertEqual((d["error_class"], d["outcome"], d["attempt"], d["max_attempts"], d["retry_seconds"]), ("transient", "queued", 3, 5, 900))
        self.assertEqual(w._jobs_failed, 1)

    def test_permanent_is_dead_immediately_and_visible(self):
        db, w = self.fail(PermanentError("prospect has no valid official website"))
        self.assertEqual(db.count("intel_agent_fail_job"), 0)
        p = db.named("intel_agent_fail_job_permanent")[0]
        self.assertTrue(p["p_error"].startswith("permanent: prospect has no valid"))
        d = db.named("intel_agent_log")[0]["p_detail"]
        self.assertEqual((d["error_class"], d["outcome"], d["retry_seconds"]), ("permanent", "dead", None))

    def test_older_schema_without_the_permanent_rpc_keeps_the_previous_behaviour(self):
        db = Db(); db.on("intel_agent_fail_job_permanent", RpcError("function not found", "PGRST202", 404))
        db, _ = self.fail(PermanentError("bad input"), db=db)
        p = db.named("intel_agent_fail_job")[0]
        self.assertEqual(p["p_retry_seconds"], 86400)

    def test_database_refusal_is_dead_but_deadlock_is_retried(self):
        db, _ = self.fail(RpcError("check constraint violated", "23514", 400))
        self.assertEqual(db.count("intel_agent_fail_job_permanent"), 1)
        db, _ = self.fail(RpcError("deadlock detected", "40P01", 409))
        self.assertEqual(db.count("intel_agent_fail_job_permanent"), 0)
        self.assertEqual(db.count("intel_agent_fail_job"), 1)

    def test_unexpected_exception_names_its_class_and_is_retried(self):
        db, _ = self.fail(KeyError("campaigns"))
        self.assertTrue(db.named("intel_agent_fail_job")[0]["p_error"].startswith("unexpected KeyError"))

    def test_error_text_is_scrubbed_before_it_is_stored(self):
        db, _ = self.fail(TransientError("provider said: Authorization: Bearer abcdefghijklmnop12345 key=SECRETVALUE123"))
        stored = db.named("intel_agent_fail_job")[0]["p_error"]
        self.assertNotIn("abcdefghijklmnop12345", stored); self.assertNotIn("SECRETVALUE123", stored)
        self.assertNotIn("abcdefghijklmnop12345", str(db.named("intel_agent_log")))

    def test_agent_chat_retries_quickly(self):
        db = Db(); w = make_worker(db)
        with with_handler("chat", raiser(TransientError("ollama busy"))):
            w.run_job({"id": "c1", "kind": "chat", "attempts": 2, "max_attempts": 5, "payload": {}})
        self.assertEqual(db.named("intel_agent_fail_job")[0]["p_retry_seconds"], 30)

    def test_not_owner_means_the_lease_was_lost_and_is_not_counted_as_a_failure(self):
        db = Db(); db.on("intel_agent_fail_job", "not_owner")
        db, w = self.fail(TransientError("x"), db=db)
        self.assertEqual(w._last_job_error, "lease lost during failure")
        self.assertEqual(w._jobs_failed, 0)
        self.assertEqual(db.count("intel_agent_log"), 0)

    def test_unreachable_database_during_failure_recording_does_not_crash_the_worker(self):
        db = Db(); db.on("intel_agent_fail_job", TransientError("network"))
        db, w = self.fail(TransientError("x"), db=db)             # must not raise
        self.assertEqual(db.count("intel_agent_fail_job"), len(settle_delays()) + 1)   # bounded retries, then give up
        self.assertEqual(db.sleeps, list(settle_delays()))
        self.assertIn("lease expiry will recover", w._last_job_error)

    def test_audit_failure_never_breaks_failure_recording(self):
        db = Db(); db.on("intel_agent_log", RpcError("denied", "42501", 403))
        db, w = self.fail(TransientError("x"), db=db)
        self.assertEqual(db.count("intel_agent_fail_job"), 1)


class CompletionHandling(unittest.TestCase):
    def run_ok(self, db, result=None, llm=None):
        w = make_worker(db, llm=llm)
        with with_handler("discover", lambda d, j: {"found": 2} if result is None else result):
            w.run_job(dict(JOB))
        return w

    def test_success_is_recorded_with_run_metadata(self):
        db = Db(); w = self.run_ok(db)
        p = db.named("intel_agent_complete_job")[0]["p_result"]
        self.assertEqual(p["found"], 2)
        self.assertEqual(p["_run"]["attempt"], 1); self.assertEqual(p["_run"]["worker_id"], "w1"); self.assertIn("duration_ms", p["_run"])
        self.assertNotIn("ai_calls", p["_run"])
        self.assertEqual(w._jobs_succeeded, 1); self.assertIsNone(w._last_job_error)

    def test_non_dict_results_are_wrapped(self):
        db = Db(); self.run_ok(db, result=[1, 2])
        p = db.named("intel_agent_complete_job")[0]["p_result"]
        self.assertEqual(p["value"], [1, 2]); self.assertIn("_run", p)

    def test_completion_survives_a_short_network_failure_without_reporting_a_failure(self):
        db = Db(); db.on("intel_agent_complete_job", TransientError("net"), TransientError("net"), True)
        w = self.run_ok(db)
        self.assertEqual(db.count("intel_agent_complete_job"), 3)
        self.assertEqual(db.count("intel_agent_fail_job"), 0)       # the finished job is NOT reported as failed
        self.assertEqual(db.sleeps, list(settle_delays())[:2])
        self.assertEqual(w._jobs_succeeded, 1)

    def test_persistent_completion_failure_is_never_reported_as_a_job_failure(self):
        db = Db(); db.on("intel_agent_complete_job", TransientError("net"))
        w = self.run_ok(db)
        self.assertEqual(db.count("intel_agent_fail_job"), 0)
        self.assertEqual(db.count("intel_agent_fail_job_permanent"), 0)
        self.assertEqual(w._jobs_succeeded, 0)
        self.assertIn("re-run after its lease expires", w._last_job_error)

    def test_rejected_completion_means_lease_lost(self):
        db = Db(); db.on("intel_agent_complete_job", False)
        w = self.run_ok(db)
        self.assertIn("lease ownership was lost", w._last_job_error); self.assertEqual(w._jobs_succeeded, 0)

    def test_ai_calls_served_during_the_job_are_recorded_by_provider(self):
        llm = FallbackLLM(FakeGemini(TransientError("429"), {"ok": True}), FakeOllama(),
                          settings=RouterSettings(policy={"discovery": "gemini_first"}))
        db = Db(); w = make_worker(db, llm=llm)
        def handler(d, j):
            d.llm.generate_json_ex("discovery.news", "i", "u", {})      # Gemini 429 -> served by Ollama (a fallback)
            return {"ok": True}
        with with_handler("discover", handler):
            w.run_job(dict(JOB))
        ai = db.named("intel_agent_complete_job")[0]["p_result"]["_run"]["ai_calls"]
        self.assertEqual(ai, {"ollama": 1, "fallbacks": 1})

    def test_only_calls_made_during_this_job_are_counted(self):
        llm = FallbackLLM(None, FakeOllama())
        llm.generate_json_ex("drafting.initial", "i", "u", {})          # before the job (private group: Ollama by configuration)
        db = Db(); w = make_worker(db, llm=llm)
        with with_handler("discover", lambda d, j: (d.llm.generate_json_ex("drafting.initial", "i", "u", {}), {"n": 1})[1]):
            w.run_job(dict(JOB))
        # one call during the job, and Ollama-by-configuration is NOT reported as a fallback
        self.assertEqual(db.named("intel_agent_complete_job")[0]["p_result"]["_run"]["ai_calls"], {"ollama": 1})

    def test_a_gemini_first_site_with_no_key_is_reported_as_a_fallback(self):
        llm = FallbackLLM(None, FakeOllama())                           # public discovery is Gemini-first by default; no key configured
        db = Db(); w = make_worker(db, llm=llm)
        with with_handler("discover", lambda d, j: (d.llm.generate_json_ex("discovery.news", "i", "u", {}), {"n": 1})[1]):
            w.run_job(dict(JOB))
        self.assertEqual(db.named("intel_agent_complete_job")[0]["p_result"]["_run"]["ai_calls"], {"ollama": 1, "fallbacks": 1})


class SendJobFailureResult(unittest.TestCase):
    def test_terminal_send_denial_is_dead_and_retryable_send_failure_waits_a_day(self):
        for terminal, rpc_name in ((True, "intel_agent_fail_job_permanent"), (False, "intel_agent_fail_job")):
            db = Db(); w = make_worker(db)
            with with_handler("send", lambda d, j, t=terminal: {"job_failure": True, "terminal_failure": t, "reason": "suppressed"}):
                w.run_job({"id": "s1", "kind": "send", "attempts": 1, "max_attempts": 5, "payload": {}})
            self.assertEqual(db.count(rpc_name), 1)
            self.assertEqual(db.count("intel_agent_complete_job"), 0)

    def test_send_failure_that_cannot_be_recorded_does_not_crash(self):
        db = Db(); db.on("intel_agent_fail_job", TransientError("net")); w = make_worker(db)
        with with_handler("send", lambda d, j: {"job_failure": True, "reason": "provider rejected"}):
            w.run_job({"id": "s1", "kind": "send", "attempts": 1, "max_attempts": 5, "payload": {}})
        self.assertEqual(w._last_job_error, "send job failure could not be recorded")


class Scheduling(unittest.TestCase):
    SETTINGS = {"today": "2026-11-13", "kill_switch": False,
                "campaigns": [{"type": "indie_game_developer", "status": "active"}, {"type": "animation_studio_support", "status": "active"}]}

    def db_with_settings(self):
        db = Db(); db.on("intel_agent_settings", self.SETTINGS); db.on("intel_agent_approved_outbound", [{"id": "m1"}]); return db

    def test_a_failing_scheduled_step_no_longer_blocks_job_claiming(self):
        db = self.db_with_settings()
        db.on("intel_agent_enqueue_job", RpcError("job kind not allowed", "P0001", 400))
        db.on("intel_agent_claim_job", {"id": "j9", "kind": "discover", "attempts": 1, "max_attempts": 5, "payload": {}})
        w = make_worker(db)
        with with_handler("discover", lambda d, j: {"ok": 1}):
            busy = w.tick()
        self.assertTrue(busy)                                           # the job WAS claimed and run despite the scheduler problem
        self.assertEqual(db.count("intel_agent_claim_job"), 1)
        self.assertEqual(db.count("intel_agent_complete_job"), 1)
        self.assertIn("scheduler", w._scheduler_error)

    def test_one_rejected_enqueue_does_not_stop_the_rest_of_the_schedule(self):
        db = self.db_with_settings()
        db.on("intel_agent_enqueue_job", RpcError("rejected", "P0001", 400), None)
        w = make_worker(db)
        with self.assertRaises(RpcError):
            w.periodic()
        keys = [p["p_idempotency_key"] for p in db.named("intel_agent_enqueue_job")]
        self.assertGreaterEqual(len(keys), 8)                           # every kind was still attempted
        self.assertTrue(any(k.startswith("send:m1") for k in keys))

    def test_network_failure_aborts_the_pass_and_is_reported(self):
        db = self.db_with_settings(); db.on("intel_agent_enqueue_job", TransientError("net")); w = make_worker(db)
        with self.assertRaises(TransientError):
            w.periodic()
        self.assertEqual(db.count("intel_agent_enqueue_job"), 1)

    def test_housekeeping_failures_are_published_in_the_next_heartbeat(self):
        db = Db(); db.on("intel_agent_settings", RpcError("permission denied", "42501", 403)); w = make_worker(db)
        w._housekeeping()
        self.assertIn("permission denied", w._scheduler_error)
        w._heartbeat()
        self.assertIn("permission denied", db.named("intel_agent_heartbeat")[-1]["p_info"]["scheduler_error"])

    def test_healthy_housekeeping_clears_the_scheduler_error(self):
        db = self.db_with_settings(); w = make_worker(db); w._scheduler_error = "old problem"
        w._housekeeping()
        self.assertIsNone(w._scheduler_error)

    def test_housekeeping_runs_on_a_30_second_cadence_even_when_it_fails(self):
        db = Db(); db.on("intel_agent_settings", RpcError("boom", "P0001", 400)); db.on("intel_agent_claim_job", None); w = make_worker(db)
        w.tick(); w.tick(); w.tick()
        self.assertEqual(db.count("intel_agent_settings"), 1)           # not retried on every tick (no hot loop against the database)
        self.assertEqual(db.count("intel_agent_claim_job"), 3)

    def test_unreachable_database_skips_the_scheduler_pass_instead_of_waiting_on_it(self):
        db = Db(); db.on("intel_agent_heartbeat", TransientError("network")); db.on("intel_agent_settings", {"today": "d", "kill_switch": True, "campaigns": []})
        w = make_worker(db); w._housekeeping()
        self.assertEqual(db.count("intel_agent_settings"), 0)
        self.assertIn("heartbeat", w._scheduler_error)

    def test_a_persistent_scheduler_problem_is_logged_once_not_every_pass(self):
        import io, contextlib
        db = Db(); db.on("intel_agent_settings", RpcError("permission denied", "42501", 403)); w = make_worker(db)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            for _ in range(3): w._housekeeping()
        self.assertEqual(buf.getvalue().count("housekeeping problem"), 1)
        self.assertIn("permission denied", w._scheduler_error)             # still published on every pass

    def test_heartbeat_reports_counters(self):
        db = Db(); w = make_worker(db); w._jobs_succeeded, w._jobs_failed = 4, 2; w._heartbeat()
        info = db.named("intel_agent_heartbeat")[0]["p_info"]
        self.assertEqual((info["jobs_succeeded"], info["jobs_failed"]), (4, 2)); self.assertIn("started_at", info)


class _StopAfter(threading.Event):
    def __init__(self, n): super().__init__(); self.n, self.waits = n, []
    def wait(self, timeout=None):
        self.waits.append(timeout)
        if len(self.waits) >= self.n: self.set()
        return self.is_set()


class WorkerLoopSurvival(unittest.TestCase):
    def test_an_unexpected_exception_does_not_end_the_loop(self):
        db = Db(); w = make_worker(db)
        n = {"i": 0}
        def tick():
            n["i"] += 1
            if n["i"] <= 2: raise KeyError("campaigns")
            return False
        w.tick = tick
        stop = _StopAfter(4)
        w.run_forever(stop)
        self.assertGreaterEqual(n["i"], 3)                              # kept going after two crashes
        self.assertEqual(stop.waits[:2], [15, 30])                      # escalating wait, not a hot loop
        self.assertTrue(w._last_job_error.startswith("worker loop error"))

    def test_database_outage_backs_off_and_recovers(self):
        db = Db(); w = make_worker(db); seq = iter([TransientError("net"), TransientError("net"), False])
        def tick():
            v = next(seq)
            if isinstance(v, Exception): raise v
            return v
        w.tick = tick; stop = _StopAfter(3); w.run_forever(stop)
        self.assertEqual(stop.waits[:2], [15, 30])


class UsageCounters(unittest.TestCase):
    def test_gemini_and_fallback_calls_are_counted(self):
        llm = FallbackLLM(FakeGemini({"ok": 1}, TransientError("429")), FakeOllama(), settings=RouterSettings(policy={"discovery": "gemini_first"}))
        llm.generate_json_ex("discovery.news", "i", "u", {})
        llm.generate_json_ex("discovery.news", "i", "u", {})
        self.assertEqual(llm.usage_counts(), {"gemini": 1, "ollama": 1, "fallbacks": 1})

    def test_default_policy_ollama_calls_are_counted_without_a_fallback(self):
        llm = FallbackLLM(None, FakeOllama())
        llm.generate_json("i", "u", {}, site="discovery.news")
        self.assertEqual(llm.usage_counts().get("ollama"), 1)


class FakeProc:
    def __init__(self, code=None): self.returncode, self.pid = code, 4242
    def poll(self): return self.returncode


class ControllerRestartPolicy(unittest.TestCase):
    def test_delay_schedule_escalates_and_caps(self):
        self.assertEqual([controller.restart_delay(n, 1) for n in range(1, 8)], [20, 40, 80, 160, 320, 600, 600])

    def test_configuration_error_waits_at_least_five_minutes(self):
        self.assertEqual(controller.restart_delay(1, 2), 300)
        self.assertEqual(controller.restart_delay(6, 2), 600)

    def build(self, proc, started_ago):
        c = controller.WorkerController.__new__(controller.WorkerController)
        c.lock = threading.RLock(); c.process = proc; c.desired_running = True; c.started_at = "x"
        c.started_mono = time.monotonic() - started_ago; c.last_exit_code = None; c.last_error = None
        c.restart_at = 0.0; c.restart_count = 0; c.consecutive_failures = 0
        c.token_file = Path("/nonexistent")
        c.spawns = []
        def spawn():
            c.spawns.append(1); c.process = FakeProc(None); c.started_mono = time.monotonic(); c.started_at = "y"; c.last_error = None
        c._spawn = spawn
        return c

    def one_pass(self, c):
        gate = _StopAfter(2)               # first wait -> False (one loop pass), second -> stop
        c.closed = gate
        c._monitor()

    def test_quick_crash_schedules_a_delayed_restart_with_an_actionable_message(self):
        c = self.build(FakeProc(1), started_ago=1)
        self.one_pass(c)
        self.assertIsNone(c.process); self.assertEqual(c.consecutive_failures, 2 - 1)
        self.assertEqual(c.spawns, [])                                  # not restarted immediately
        st = c.status()
        self.assertTrue(18 <= st["next_restart_seconds"] <= 20)
        self.assertIn("exit 1", c.last_error); self.assertIn("worker.log", c.last_error)
        self.assertEqual(st["consecutive_failures"], 1); self.assertFalse(st["worker_running"])

    def test_consecutive_quick_crashes_escalate(self):
        c = self.build(FakeProc(1), started_ago=1); c.consecutive_failures = 3
        self.one_pass(c)
        self.assertEqual(c.consecutive_failures, 4)
        self.assertTrue(155 <= c.status()["next_restart_seconds"] <= 160)

    def test_a_stable_run_resets_the_streak(self):
        c = self.build(FakeProc(1), started_ago=controller.STABLE_SECONDS + 30); c.consecutive_failures = 5
        self.one_pass(c)
        self.assertEqual(c.consecutive_failures, 1)
        self.assertTrue(18 <= c.status()["next_restart_seconds"] <= 20)

    def test_configuration_error_is_reported_and_not_retried_fast(self):
        c = self.build(FakeProc(2), started_ago=1)
        self.one_pass(c)
        self.assertIn("configuration error", c.last_error)
        self.assertTrue(295 <= c.status()["next_restart_seconds"] <= 300)

    def test_duplicate_worker_exit_is_not_a_crash_and_is_not_restarted(self):
        c = self.build(FakeProc(73), started_ago=1)
        self.one_pass(c)
        self.assertFalse(c.desired_running); self.assertEqual(c.restart_at, 0); self.assertEqual(c.consecutive_failures, 0)
        self.assertIn("already running", c.last_error)

    def test_restart_happens_once_the_delay_has_passed_and_is_counted(self):
        c = self.build(None, started_ago=0); c.process = None; c.restart_at = time.monotonic() - 1
        self.one_pass(c)
        self.assertEqual(c.spawns, [1]); self.assertEqual(c.restart_count, 1); self.assertEqual(c.restart_at, 0)

    def test_spawn_failure_escalates_instead_of_retrying_every_minute_forever(self):
        c = self.build(None, started_ago=0); c.process = None; c.restart_at = time.monotonic() - 1; c.consecutive_failures = 4
        def bad(): raise RuntimeError("Python environment not found: C:/x")
        c._spawn = bad
        self.one_pass(c)
        self.assertEqual(c.consecutive_failures, 5); self.assertIn("Python environment", c.last_error)
        self.assertGreaterEqual(c.restart_at - time.monotonic(), 300)

    def test_status_is_additive_and_exposes_no_secrets(self):
        c = self.build(None, started_ago=0); c.process = None; st = c.status()
        for key in ("ok", "controller_version", "worker_running", "worker_pid", "worker_started_at", "last_exit_code", "duplicate_worker_detected", "last_error"):
            self.assertIn(key, st)
        self.assertNotIn("token", " ".join(st).lower())


if __name__ == "__main__":
    unittest.main()
