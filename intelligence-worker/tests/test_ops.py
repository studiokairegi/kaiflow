import unittest

from kairflow_intel import config, jobs, mailops
from kairflow_intel.errors import PermanentError, RpcError, ThreadingRejected, TransientError
from kairflow_intel.supa import SupabaseAgent
from kairflow_intel.zoho import ZohoRejected
from .helpers import CFG


class FakeRpc:
    """Just enough of the database state machine to test the worker's behaviour around it."""
    def __init__(self): self.msgs, self.calls, self.jobs, self.inbound, self.cursor, self.fail_confirm = {}, [], {}, {}, {}, False
    def add(self, id, state="approved", token="kf" + "a" * 32, to="rina@pixelmoon.com"):
        self.msgs[id] = {"id": id, "state": state, "token": token, "to_email": to, "from_email": "alex@studio.test", "subject": "Hello", "body_text": "Body", "reserved_at": "2026-11-02T10:00:00Z"}
    def __call__(self, name, p=None):
        p = p or {}; self.calls.append((name, p))
        m = self.msgs.get(p.get("p_message_id"))
        if name == "intel_agent_send_window_status": return {"allowed": True, "reason": "inside_send_window"}
        if name == "intel_agent_reserve_send":
            if m["state"] in ("sending", "unknown"): return {"ok": False, "reason": "needs_reconcile"}
            if m["state"] == "sent": return {"ok": False, "reason": "already_sent"}
            if m["state"] != "approved": return {"ok": False, "reason": "not_approved"}
            m["state"] = "reserved"; return {"ok": True, "message": dict(m)}
        if name == "intel_agent_acquire_send_slot": return {"ok": True, "resumed": False}
        if name == "intel_agent_mark_sending": m["state"] = "sending"; return True
        if name == "intel_agent_confirm_send":
            if self.fail_confirm: raise TransientError("network")
            m["state"] = "sent"; m["zoho"] = p["p_zoho_message_id"]; return {"ok": True}
        if name == "intel_agent_mark_unknown": m["state"] = "unknown"; return None
        if name == "intel_agent_fail_send": m["state"] = "failed"; m["perm"] = p["p_permanent"]; return None
        if name == "intel_agent_stale_sends": return [dict(x) for x in self.msgs.values() if x["state"] in ("sending", "unknown")]
        if name == "intel_agent_sync_state":
            if p.get("p_set") is not None: self.cursor = p["p_set"]
            return self.cursor
        if name == "intel_agent_record_inbound":
            if p["p_zoho_message_id"] in self.inbound: return {"message_id": self.inbound[p["p_zoho_message_id"]], "duplicate": True}
            self.inbound[p["p_zoho_message_id"]] = "m-" + p["p_zoho_message_id"]; return {"message_id": self.inbound[p["p_zoho_message_id"]], "duplicate": False, "matched": True}
        if name == "intel_agent_enqueue_job":
            new = p["p_idempotency_key"] not in self.jobs; self.jobs.setdefault(p["p_idempotency_key"], p); return "id" if new else None
        return None


class FakeZoho:
    def __init__(self): self.sent, self.sent_folder, self.inbox, self.raise_on_send = [], [], [], None
    def send(self, frm, to, subject, body, reply_to_zoho_id=None, in_reply_to=None, references=None):
        if self.raise_on_send: raise self.raise_on_send
        self.parents = getattr(self, 'parents', []) + [reply_to_zoho_id]; self.headers = getattr(self, 'headers', []) + [(in_reply_to, references)]
        self.sent.append((frm, to, subject, body)); return {"zoho_message_id": f"z{len(self.sent)}", "thread_id": "t"}
    def find_sent(self, token, to, since): return next((m for m in self.sent_folder if m["token"] == token), None)
    def list_messages(self, folder, limit=50): return self.inbox
    def content_text(self, f, i): return f"body of {i} kf{'a' * 32}"
    def rfc_headers(self, f, i): return {"Message-ID": f"<{i}@x>", "In-Reply-To": "<o@x>"}


class Sending(unittest.TestCase):
    def setUp(self): self.r, self.z = FakeRpc(), FakeZoho(); self.r.add("m1")


    def test_prospecting_consent_denial_never_calls_provider(self):
        self.r.add("no-consent")
        def rpc(name, params=None):
            if name == "intel_agent_assign_provider_account":
                return {"ok": False, "reason": "prospecting_consent_required"}
            return self.r(name, params)
        out = mailops.send_message(rpc, self.z, "no-consent")
        self.assertEqual(out["reason"], "prospecting_consent_required")
        self.assertEqual(self.z.sent, [])
        self.assertEqual(self.r.msgs["no-consent"]["state"], "failed")

    def test_dynamic_assignment_selects_account_adapter_before_provider_send(self):
        self.r.add("dynamic")
        class Routed:
            def __init__(self, client): self.client = client; self.message = None
            def for_message(self, message): self.message = message; return self.client
        routed = Routed(self.z)
        def rpc(name, params=None):
            if name == "intel_agent_assign_provider_account":
                m = dict(self.r.msgs["dynamic"])
                m.update({"provider_account_id": "acct-1", "provider_key": "gmail"})
                return {"ok": True, "legacy": False, "message": m}
            return self.r(name, params)
        out = mailops.send_message(rpc, routed, "dynamic")
        self.assertEqual(out["reason"], "ok")
        self.assertEqual(routed.message["provider_account_id"], "acct-1")
        self.assertEqual(len(self.z.sent), 1)

    def test_parent_lookup_failure_is_definite_non_send_not_unknown(self):
        rpc_calls = []
        def rpc(name, params=None):
            params = params or {}; rpc_calls.append(name)
            if name == "intel_agent_reserve_send": return {"ok": True, "message": {"id": "m1", "in_reply_to": "<parent@x>", "prospect_id": "p1", "state": "approved"}}
            if name == "intel_agent_acquire_send_slot": return {"ok": True, "resumed": False}
            if name == "intel_agent_mark_sending": return True
            if name == "intel_agent_context": raise TransientError("db unavailable")
            return None
        z = FakeZoho()
        out = mailops.send_message(rpc, z, "m1")
        self.assertEqual(out["reason"], "parent_lookup_retry")
        self.assertNotIn("intel_agent_mark_unknown", rpc_calls)
        self.assertIn("intel_agent_fail_send", rpc_calls)
        self.assertNotIn("intel_agent_acquire_send_slot", rpc_calls)
        self.assertNotIn("intel_agent_mark_sending", rpc_calls)
        self.assertEqual(z.sent, [])

    def test_zoho_reply_missing_parent_is_not_sent_as_unthreaded(self):
        self.r.add("m2")
        m = self.r.msgs["m2"]; m["in_reply_to"] = "<incoming@x>"; m["prospect_id"] = "p1"
        def rpc(name, params=None):
            params = params or {}
            if name == "intel_agent_context": return {"messages": []}
            return self.r(name, params)
        z = FakeZoho()
        out = mailops.send_message(rpc, z, "m2")
        self.assertEqual(out["reason"], "reply_parent_missing")
        self.assertEqual(z.sent, [])


    def test_reply_parent_preflight_happens_before_slot_and_final_transition(self):
        self.r.add("reply")
        m = self.r.msgs["reply"]
        m.update({"in_reply_to": "<incoming@x>", "prospect_id": "p1"})
        calls = []
        def rpc(name, params=None):
            calls.append(name)
            if name == "intel_agent_context":
                return {"messages": [{"rfc_message_id": "<incoming@x>", "zoho_message_id": "parent-zoho"}]}
            return self.r(name, params)
        out = mailops.send_message(rpc, self.z, "reply")
        self.assertEqual(out["reason"], "ok")
        self.assertLess(calls.index("intel_agent_context"), calls.index("intel_agent_acquire_send_slot"))
        self.assertLess(calls.index("intel_agent_acquire_send_slot"), calls.index("intel_agent_mark_sending"))
        self.assertEqual(self.z.parents, ["parent-zoho"])

    def test_kill_switch_rejection_at_final_transition_prevents_provider_call(self):
        self.r.add("stopped")
        calls = []
        def rpc(name, params=None):
            calls.append(name)
            if name == "intel_agent_mark_sending":
                return False  # models kill switch enabled after slot acquisition
            return self.r(name, params)
        out = mailops.send_message(rpc, self.z, "stopped")
        self.assertEqual(out["reason"], "not_reserved_or_send_stopped")
        self.assertEqual(self.z.sent, [])
        self.assertLess(calls.index("intel_agent_acquire_send_slot"), calls.index("intel_agent_mark_sending"))
        self.assertEqual(calls[-1], "intel_agent_mark_sending")

    def test_provider_response_without_id_is_unknown_not_confirmed_sent(self):
        self.r.add("m3")
        class MissingId(FakeZoho):
            def send(self, *a, **kw): return {"zoho_message_id": "", "thread_id": "t"}
        z = MissingId()
        out = mailops.send_message(self.r, z, "m3")
        self.assertEqual(out["reason"], "unknown")
        self.assertEqual(self.r.msgs["m3"]["state"], "unknown")
        self.assertNotIn("intel_agent_confirm_send", [name for name, _ in self.r.calls])

    def test_worker_requeues_message_after_global_send_spacing_denial(self):
        calls = []
        message = {"id": "paced", "state": "reserved", "token": "kf" + "b" * 32,
                   "to_email": "rina@pixelmoon.com", "from_email": "alex@studio.test",
                   "subject": "Hello", "body_text": "Body"}
        def rpc(name, params=None):
            params = params or {}; calls.append((name, params))
            if name == "intel_agent_settings": return {"kill_switch": False}
            if name == "intel_agent_send_window_status": return {"allowed": True, "reason": "inside_send_window"}
            if name == "intel_agent_reserve_send": return {"ok": True, "message": dict(message)}
            if name == "intel_agent_acquire_send_slot": return {"ok": False, "reason": "send_spacing", "retry_after": 73}
            if name == "intel_agent_enqueue_job": return "queued"
            return None
        d = jobs.Deps(cfg=CFG, rpc=rpc, fetcher=None, zoho=self.z, llm=None,
                      sleep=lambda _seconds: None, clock=lambda: 1_800_000_000.0)
        out = jobs.h_send(d, {"payload": {"message_id": "paced"}})
        self.assertEqual(out["reason"], "send_spacing")
        queued = next(params for name, params in calls if name == "intel_agent_enqueue_job")
        self.assertEqual(queued["p_kind"], "send")
        self.assertEqual(queued["p_payload"], {"message_id": "paced"})
        self.assertEqual(queued["p_run_after"], "2027-01-15T08:01:13Z")
        self.assertEqual(self.z.sent, [])

    def test_worker_defers_initial_send_until_next_local_window(self):
        calls = []
        def rpc(name, params=None):
            params = params or {}; calls.append((name, params))
            if name == "intel_agent_settings": return {"kill_switch": False}
            if name == "intel_agent_send_window_status": return {"allowed": False, "reason": "outside_send_window", "next_open_at": "2027-01-15T09:00:00+00:00"}
            if name == "intel_agent_enqueue_job": return "queued"
            return None
        d = jobs.Deps(cfg=CFG, rpc=rpc, fetcher=None, zoho=self.z, llm=None,
                      clock=lambda: 1_800_000_000.0)
        out = jobs.h_send(d, {"payload": {"message_id": "windowed"}})
        self.assertEqual(out["reason"], "send_window_deferred")
        self.assertTrue(out["deferred"])
        self.assertGreater(out["retry_after"], 0)
        queued = next(params for name, params in calls if name == "intel_agent_enqueue_job")
        self.assertTrue(queued["p_idempotency_key"].startswith("send-window:windowed:"))
        self.assertEqual(self.z.sent, [])

    def test_provider_account_quota_denial_is_requeued_without_marking_failed(self):
        self.r.add("quota")
        def rpc(name, params=None):
            if name == "intel_agent_assign_provider_account":
                return {"ok": False, "reason": "provider_account_quota", "retry_after": 60}
            return self.r(name, params)
        out = mailops.send_message(rpc, self.z, "quota")
        self.assertEqual(out["reason"], "provider_account_quota")
        self.assertEqual(self.r.msgs["quota"]["state"], "reserved")
        self.assertEqual(self.z.sent, [])

    def test_global_send_slot_denial_defers_before_provider_call(self):
        self.r.add("paced")
        original = self.r.__call__
        def throttled(name, params=None):
            if name == "intel_agent_acquire_send_slot":
                return {"ok": False, "reason": "send_spacing", "retry_after": 73}
            return original(name, params)
        out = mailops.send_message(throttled, self.z, "paced")
        self.assertEqual(out["reason"], "send_spacing")
        self.assertEqual(out["retry_after"], 73)
        self.assertEqual(self.z.sent, [])
        self.assertEqual(self.r.msgs["paced"]["state"], "reserved")

    def test_success_sends_once_with_ref_and_confirms(self):
        out = mailops.send_message(self.r, self.z, "m1")
        self.assertEqual(out, {"sent": True, "reason": "ok"}); self.assertEqual(len(self.z.sent), 1)
        self.assertIn("Ref: kf" + "a" * 32, self.z.sent[0][3]); self.assertEqual(self.r.msgs["m1"]["state"], "sent")
        self.assertEqual(mailops.send_message(self.r, self.z, "m1")["reason"], "already_sent"); self.assertEqual(len(self.z.sent), 1)

    def test_threading_rejection_is_permanent_and_not_sent_unthreaded(self):
        self.z.raise_on_send = ThreadingRejected("Zoho rejected native reply threading")
        self.r.add("threaded")
        out = mailops.send_message(self.r, self.z, "threaded")
        self.assertEqual(out["reason"], "threading_rejected")
        self.assertEqual((self.r.msgs["threaded"]["state"], self.r.msgs["threaded"]["perm"]), ("failed", True))
        self.assertEqual(self.z.sent, [])

    def test_zoho_rejection_marks_failed_and_is_not_retried(self):
        self.z.raise_on_send = ZohoRejected("zoho 400: invalid recipient address")
        self.assertEqual(mailops.send_message(self.r, self.z, "m1")["reason"], "rejected")
        self.assertEqual((self.r.msgs["m1"]["state"], self.r.msgs["m1"]["perm"]), ("failed", True))

    def test_network_failure_mid_send_is_unknown_and_never_resent(self):
        self.z.raise_on_send = TransientError("timeout")
        self.assertEqual(mailops.send_message(self.r, self.z, "m1")["reason"], "unknown")
        self.assertEqual(self.r.msgs["m1"]["state"], "unknown")
        self.z.raise_on_send = None
        for _ in range(3): self.assertEqual(mailops.send_message(self.r, self.z, "m1")["reason"], "needs_reconcile")
        self.assertEqual(self.z.sent, [])

    def test_confirm_failure_leaves_message_for_reconcile_without_resend(self):
        self.r.fail_confirm = True
        self.assertEqual(mailops.send_message(self.r, self.z, "m1")["reason"], "confirm_pending")
        self.assertEqual(len(self.z.sent), 1); self.assertEqual(self.r.msgs["m1"]["state"], "sending")
        self.assertEqual(mailops.send_message(self.r, self.z, "m1")["reason"], "needs_reconcile"); self.assertEqual(len(self.z.sent), 1)

    def test_reconcile_found_confirms_absent_fails_unverifiable_waits(self):
        self.r.add("a", "unknown", "kf" + "1" * 32); self.r.add("b", "sending", "kf" + "2" * 32); self.r.add("c", "unknown", "kf" + "3" * 32)
        self.z.sent_folder = [{"token": "kf" + "1" * 32, "zoho_message_id": "zz", "rfc_message_id": "<r@x>", "thread_id": "t", "time_ms": 1_700_000_000_000}]
        orig = self.z.find_sent
        self.z.find_sent = lambda t, to, s: (_ for _ in ()).throw(TransientError("down")) if t.endswith("3" * 32) else orig(t, to, s)
        counts = mailops.reconcile(self.r, self.z)
        self.assertEqual(counts, {"confirmed": 1, "absent": 1, "left": 1})
        self.assertEqual([self.r.msgs[k]["state"] for k in "abc"], ["sent", "failed", "unknown"]); self.assertEqual(self.z.sent, [])


class Inbox(unittest.TestCase):
    def test_sync_paginates_backlog_before_advancing_cursor(self):
        r, z = FakeRpc(), FakeZoho()
        base = 1_700_000_100_000
        z.inbox = [{"id": f"old{i}", "folder_id": "f", "subject": "reply", "from": f"u{i}@example.com",
                    "to": "", "time_ms": base - i * 1000, "thread_id": ""} for i in range(125)]
        z.iter_messages = lambda folder, page_size: (item for item in z.inbox)
        got = mailops.sync_inbox(r, z, set(), overlap_ms=0, limit=50)
        self.assertEqual(got["new"], 125)
        self.assertEqual(len(r.inbound), 125)
        self.assertEqual(r.cursor["last_time_ms"], base)

    def test_inbound_rfc_headers_are_case_insensitive_across_providers(self):
        r, z = FakeRpc(), FakeZoho()
        z.inbox = [{"id": "lowercase", "folder_id": "f", "subject": "Re: hi", "from": "rina@pixelmoon.com",
                    "to": "studio@test", "time_ms": 1_700_000_100_000, "thread_id": "t"}]
        z.iter_messages = lambda folder, page_size: iter(z.inbox)
        z.rfc_headers = lambda *_: {"message-id": "<reply@pixelmoon.com>", "in-reply-to": "<outbound@studio.test>",
                                    "references": "<older@studio.test> <outbound@studio.test>"}
        mailops.sync_inbox(r, z, set(), overlap_ms=0)
        payload = next(p for name, p in r.calls if name == "intel_agent_record_inbound")
        self.assertEqual(payload["p_rfc_message_id"], "<reply@pixelmoon.com>")
        self.assertEqual(payload["p_in_reply_to"], "<outbound@studio.test>")
        self.assertEqual(payload["p_references"], "<older@studio.test> <outbound@studio.test>")

    def test_cursor_does_not_advance_when_persisting_page_fails(self):
        class BrokenRpc(FakeRpc):
            def __call__(self, name, p=None):
                if name == "intel_agent_record_inbound":
                    raise RuntimeError("db unavailable")
                return super().__call__(name, p)
        r, z = BrokenRpc(), FakeZoho()
        z.inbox = [{"id": "one", "folder_id": "f", "subject": "reply", "from": "u@example.com",
                    "to": "", "time_ms": 1_700_000_100_000, "thread_id": ""}]
        with self.assertRaises(RuntimeError):
            mailops.sync_inbox(r, z, set(), overlap_ms=0)
        self.assertEqual(r.cursor.get("last_time_ms", 0), 0)

    def test_multi_account_sync_uses_account_scoped_cursors_and_ids(self):
        class Provider(FakeZoho):
            def __init__(self, account):
                super().__init__(); self.account = account
                self.inbox = [{"id": "same-local-id", "folder_id": "inbox", "subject": "Re: hello",
                               "from": "rina@example.com", "to": "", "time_ms": 1_700_000_100_000,
                               "thread_id": f"thread-{account}"}]
            def iter_messages(self, folder, page_size=50): return iter(self.inbox)
            def content_text(self, folder_id, message_id): return "A reply"
            def rfc_headers(self, folder_id, message_id): return {"Message-ID": f"<{self.account}@example.com>"}

        accounts = [
            {"id": "acct-a", "provider_key": "gmail", "mailbox": "a@studio.test", "receive_enabled": True},
            {"id": "acct-b", "provider_key": "zoho", "mailbox": "b@studio.test", "receive_enabled": True},
        ]
        class Rpc:
            def __init__(self): self.calls=[]; self.inbound=[]; self.cursors={}; self.jobs=[]
            def __call__(self, name, params=None):
                params=params or {}; self.calls.append((name, params))
                if name == "intel_agent_receive_sync_state":
                    key=params["p_account_id"]
                    if params.get("p_set") is not None: self.cursors[key]=params["p_set"]
                    return self.cursors.get(key, {})
                if name == "intel_agent_record_inbound":
                    self.inbound.append(params); return {"message_id": f"msg-{len(self.inbound)}", "duplicate": False}
                if name == "intel_agent_enqueue_job": self.jobs.append(params); return "job"
                return None
        class Registry:
            def __init__(self): self.clients={}
            def create(self, key, **ctx):
                account=ctx["account_id"]; self.clients[account]=Provider(account); return self.clients[account]
        class Router:
            cfg=object(); supa=object()
            registry=Registry()
        rpc, router = Rpc(), Router()
        result=mailops.sync_provider_accounts(rpc, router, set(), overlap_ms=0, accounts=accounts)
        self.assertEqual(result, {"accounts": 2, "seen": 2, "new": 2})
        ids={x["p_zoho_message_id"] for x in rpc.inbound}
        self.assertEqual(ids, {"in:gmail:acct-a:same-local-id", "in:zoho:acct-b:same-local-id"})
        self.assertEqual(set(rpc.cursors), {"acct-a", "acct-b"})
        self.assertEqual(len(rpc.jobs), 2)

    def test_disabled_registry_account_is_not_polled(self):
        class Registry:
            def create(self, *args, **kwargs): raise AssertionError("disabled account must not be instantiated")
        class Router:
            registry = Registry(); cfg = object(); supa = object()
        rpc = lambda name, params=None: []
        result = mailops.sync_provider_accounts(rpc, Router(), set(), accounts=[
            {"id": "acct-disabled", "provider_key": "gmail", "mailbox": "a@studio.test", "receive_enabled": False}
        ])
        self.assertEqual(result, {"accounts": 0, "seen": 0, "new": 0})

    def test_sync_is_idempotent_and_skips_own_mail(self):
        r, z = FakeRpc(), FakeZoho()
        z.inbox = [{"id": "i1", "folder_id": "f", "subject": "Re: hi", "from": "Rina <rina@pixelmoon.com>", "to": "", "time_ms": 1_700_000_100_000, "thread_id": ""},
                   {"id": "i2", "folder_id": "f", "subject": "x", "from": "alex@studio.test", "to": "", "time_ms": 1_700_000_200_000, "thread_id": ""}]
        first = mailops.sync_inbox(r, z, {"alex@studio.test"}); second = mailops.sync_inbox(r, z, {"alex@studio.test"})
        self.assertEqual((first["new"], second["new"]), (1, 0))
        self.assertEqual(len(r.inbound), 1); self.assertEqual(len([k for k in r.jobs if k.startswith("classify:")]), 1)
        rec = next(p for n, p in r.calls if n == "intel_agent_record_inbound")
        self.assertEqual((rec["p_from_email"], rec["p_token"]), ("rina@pixelmoon.com", "kf" + "a" * 32))
        self.assertEqual(r.cursor["last_time_ms"], 1_700_000_100_000)


class WorkerLoop(unittest.TestCase):
    def mk(self):
        calls = []
        def rpc(name, p=None): calls.append((name, p or {})); return None
        d = jobs.Deps(cfg=CFG, rpc=rpc, fetcher=None, zoho=None, llm=None, sleep=lambda s: None, clock=lambda: 1_800_000_000.0)
        return jobs.Worker(d, lease_thread=False), calls

    def run_with(self, exc):
        w, calls = self.mk()
        jobs.HANDLERS["send"] = lambda d, j: (_ for _ in ()).throw(exc)
        try: w.run_job({"id": "j1", "kind": "send", "attempts": 3, "payload": {}})
        finally: jobs.HANDLERS["send"] = ORIGINAL_SEND
        return next(p for n, p in calls if n == "intel_agent_fail_job")

    def test_error_mapping(self):
        self.assertEqual(self.run_with(TransientError("x"))["p_retry_seconds"], 120)        # exponential backoff
        self.assertEqual(self.run_with(PermanentError("x"))["p_retry_seconds"], 86400)
        self.assertEqual(self.run_with(RpcError("x"))["p_retry_seconds"], 86400)
        self.assertTrue(self.run_with(ValueError("boom"))["p_error"].startswith("unexpected ValueError"))

    def test_one_bad_job_does_not_stop_the_worker(self):
        w, calls = self.mk(); w.run_job({"id": "j", "kind": "nonsense", "attempts": 1, "payload": {}})
        self.assertIn("intel_agent_fail_job", [n for n, _ in calls])

    def test_lost_lease_does_not_complete_or_fail_the_job(self):
        calls = []
        def rpc(name, p=None):
            calls.append(name)
            if name == "intel_agent_extend_lease": return False
            return True
        w, _ = self.mk()
        w.d.rpc = rpc
        original = jobs.HANDLERS.get("send")
        jobs.HANDLERS["send"] = lambda d, j: d.sleep(0.03) or {"sent": False}
        try:
            lease = jobs._Lease(rpc, {"id": "lease-job"}, "w", every=0.005)
            # Exercise lease keeper deterministically without relying on the worker's normal 60s cadence.
            lease.__enter__(); import time; time.sleep(0.02); lease.__exit__()
            self.assertTrue(lease.lost.is_set())
            self.assertEqual(lease.error, "lease renewal rejected")
        finally:
            jobs.HANDLERS["send"] = original

    def test_run_job_does_not_complete_or_fail_after_lease_loss(self):
        from unittest.mock import patch
        import threading
        calls = []
        def rpc(name, p=None):
            calls.append(name)
            return True
        w, _ = self.mk(); w.d.rpc = rpc; w = jobs.Worker(w.d, lease_thread=True)
        class LostLease:
            def __init__(self, *_args, **_kwargs): self.lost = threading.Event(); self.lost.set(); self.error = "lease renewal rejected"
            def __enter__(self): return self
            def __exit__(self, *_args): pass
        original = jobs.HANDLERS.get("send")
        jobs.HANDLERS["send"] = lambda *_: {"sent": True}
        try:
            with patch.object(jobs, "_Lease", LostLease):
                w.run_job({"id": "lost", "kind": "send", "attempts": 1, "payload": {}})
        finally:
            jobs.HANDLERS["send"] = original
        self.assertNotIn("intel_agent_complete_job", calls)
        self.assertNotIn("intel_agent_fail_job", calls)
        self.assertIn("intel_agent_log", calls)

    def test_periodic_enqueues_idempotent_keys_and_sends_only_when_sending_is_on(self):
        for kill in (True, False):
            w, calls = self.mk()
            def rpc(name, p=None, calls=calls, kill=kill):
                calls.append((name, p or {}))
                if name == "intel_agent_settings": return {"today": "2026-11-02", "kill_switch": kill, "campaigns": [{"type": "indie_game_developer", "status": "active", "criteria": {}}, {"type": "animation_studio_support", "status": "paused", "criteria": {}}]}
                if name == "intel_agent_approved_outbound": return [{"id": "m1"}]
                return None
            w.d.rpc = rpc; w.periodic()
            keys = [p["p_idempotency_key"] for n, p in calls if n == "intel_agent_enqueue_job"]
            self.assertIn("discover:indie_game_developer:2026-11-02", keys); self.assertNotIn("discover:animation_studio_support:2026-11-02", keys)
            self.assertEqual(any(k.startswith("send:m1") for k in keys), not kill)

    def test_draft_blocked_by_policy_is_permanent_and_logged(self):
        calls = []
        kb = [{"key": "studio.about", "body": "About"}, {"key": "services.indie_game_developer", "body": "Do 2D. Only $5 per frame"}, {"key": "portfolio.main", "body": "https://s.test"}]
        st = {"sender_name": "A", "sender_email": "a@s.test", "physical_address": "1 Road", "opt_out_text": "reply unsubscribe", "autonomy": "shadow"}
        P = {"id": "p", "type": "indie_game_developer", "name": "Pixel", "contact_email": "r@pixel.com", "contact_name": "", "status": "lead_linked", "domain": "pixel.com"}
        def rpc(name, p=None):
            calls.append(name)
            return {"intel_agent_context": {"prospect": P, "evidence": [], "messages": []}, "intel_agent_settings": st, "intel_agent_kb": kb}.get(name)
        d = jobs.Deps(cfg=CFG, rpc=rpc, fetcher=None, zoho=None, llm=None)
        with self.assertRaises(PermanentError): jobs.h_draft(d, {"payload": {"prospect_id": "p", "kind": "initial"}})
        self.assertIn("intel_agent_log", calls); self.assertNotIn("intel_agent_upsert_draft", calls)


ORIGINAL_SEND = jobs.HANDLERS["send"]


class Boundaries(unittest.TestCase):
    def test_worker_can_only_call_agent_functions(self):
        s = SupabaseAgent(CFG)
        for name in ("intel_admin_set_kill_switch", "intel_admin_register_agent", "rest_anything", "intel_is_authorized"):
            with self.assertRaises(RpcError): s.rpc(name, {})

    def test_ollama_must_be_loopback(self):
        env = {"KAIRFLOW_SUPABASE_URL": "https://x.supabase.co", "KAIRFLOW_SUPABASE_ANON_KEY": "a", "KAIRFLOW_AGENT_EMAIL": "a@b.c", "KAIRFLOW_AGENT_PASSWORD": "p"}
        self.assertEqual(config.load({**env, "KAIRFLOW_OLLAMA_URL": "http://127.0.0.1:11434"}).ollama_url, "http://127.0.0.1:11434")
        for bad in ("http://192.168.1.50:11434", "http://8.8.8.8:11434"):
            with self.assertRaises(config.ConfigError): config.load({**env, "KAIRFLOW_OLLAMA_URL": bad})
        with self.assertRaises(config.ConfigError): config.load({**env, "KAIRFLOW_SUPABASE_URL": "http://x.supabase.co"})
        with self.assertRaises(config.ConfigError): config.load({k: v for k, v in env.items() if k != "KAIRFLOW_AGENT_EMAIL"})


if __name__ == "__main__":
    unittest.main()
