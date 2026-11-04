import unittest

from kairflow_intel import config, jobs, mailops
from kairflow_intel.errors import PermanentError, RpcError, TransientError
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
        if name == "intel_agent_reserve_send":
            if m["state"] in ("sending", "unknown"): return {"ok": False, "reason": "needs_reconcile"}
            if m["state"] == "sent": return {"ok": False, "reason": "already_sent"}
            if m["state"] != "approved": return {"ok": False, "reason": "not_approved"}
            m["state"] = "reserved"; return {"ok": True, "message": dict(m)}
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

    def test_success_sends_once_with_ref_and_confirms(self):
        out = mailops.send_message(self.r, self.z, "m1")
        self.assertEqual(out, {"sent": True, "reason": "ok"}); self.assertEqual(len(self.z.sent), 1)
        self.assertIn("Ref: kf" + "a" * 32, self.z.sent[0][3]); self.assertEqual(self.r.msgs["m1"]["state"], "sent")
        self.assertEqual(mailops.send_message(self.r, self.z, "m1")["reason"], "already_sent"); self.assertEqual(len(self.z.sent), 1)

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
