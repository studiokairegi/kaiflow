import unittest
import requests
from types import SimpleNamespace

from kairflow_intel import config, jobs, mailops
from kairflow_intel.errors import MailRejected, TransientError
from kairflow_intel.resend import ResendClient
from .test_ops import FakeRpc


class Response:
    def __init__(self, status, data):
        self.status_code, self._data = status, data
        self.content = b"1"
    def json(self): return self._data


class Session:
    def __init__(self, response=None, raises=None): self.response, self.raises, self.calls = response, raises, []
    def post(self, *a, **kw):
        self.calls.append((a, kw))
        if self.raises: raise self.raises
        return self.response


class ResendAdapterTests(unittest.TestCase):
    def setUp(self):
        self.cfg = SimpleNamespace(supabase_url="https://example.supabase.co", supabase_anon_key="anon")
        self.supa = SimpleNamespace(token=lambda: "agent-jwt")

    def test_accepted_response_returns_provider_id_without_resend_key(self):
        s = Session(Response(200, {"ok": True, "id": "re_123"}))
        c = ResendClient(self.cfg, self.supa, s)
        out = c.send("sender@x.test", "to@x.test", "subject", "body", message_id="11111111-1111-1111-1111-111111111111")
        self.assertEqual(out["zoho_message_id"], "re_123")
        self.assertIn("intel-resend-send", s.calls[0][0][0])
        self.assertNotIn("RESEND_API_KEY", str(s.calls[0][1]))

    def test_definitive_rejection_is_not_unknown(self):
        c = ResendClient(self.cfg, self.supa, Session(Response(422, {"status": "rejected", "error": "invalid recipient"})))
        with self.assertRaises(MailRejected):
            c.send("s@x.test", "bad", "subject", "body", message_id="11111111-1111-1111-1111-111111111111")

    def test_uncertain_response_is_transient_unknown(self):
        c = ResendClient(self.cfg, self.supa, Session(Response(202, {"status": "unknown"})))
        with self.assertRaises(TransientError):
            c.send("s@x.test", "t@x.test", "subject", "body", message_id="11111111-1111-1111-1111-111111111111")

    def test_network_exception_is_uncertain(self):
        c = ResendClient(self.cfg, self.supa, Session(raises=requests.Timeout("simulated timeout")))
        with self.assertRaises(TransientError):
            c.send("s@x.test", "t@x.test", "subject", "body", message_id="11111111-1111-1111-1111-111111111111")

    def test_no_sent_folder_search_is_never_treated_as_absence(self):
        c = ResendClient(self.cfg, self.supa, Session())
        self.assertIsNone(c.find_sent("kf" + "a" * 32, "to@x.test", 0))

    def test_resend_is_not_a_prospect_dispatcher_adapter(self):
        self.assertEqual(config.Config.__dataclass_fields__["mail_provider"].default, "none")
        env = {"KAIRFLOW_SUPABASE_URL": "https://example.supabase.co", "KAIRFLOW_SUPABASE_ANON_KEY": "anon",
               "KAIRFLOW_AGENT_EMAIL": "agent@example.test", "KAIRFLOW_AGENT_PASSWORD": "pw",
               "KAIRFLOW_OLLAMA_URL": "http://127.0.0.1:11434", "KAIRFLOW_MAIL_PROVIDER": "resend"}
        with self.assertRaises(config.ConfigError): config.load(env)

    def test_resend_inbound_sync_is_webhook_only(self):
        d = SimpleNamespace(zoho=SimpleNamespace(provider="resend"))
        self.assertIn("not an Intelligence mailbox adapter", jobs.h_sync_mail(d, {})["skipped"])


class ResendReconciliationTests(unittest.TestCase):
    def test_missing_resend_id_stays_unknown_and_is_never_failed_or_resent(self):
        rpc_calls = []
        def rpc(name, p=None):
            rpc_calls.append((name, p or {}))
            if name == "intel_agent_stale_sends":
                return [{"id": "m1", "state": "unknown", "token": "kf" + "a" * 32, "to_email": "to@x.test", "reserved_at": "2026-11-01T00:00:00Z"}]
            return None
        c = SimpleNamespace(provider="resend", verify_sent=lambda *a: self.fail("must not verify without provider id"))
        result = mailops.reconcile(rpc, c)
        self.assertEqual(result, {"confirmed": 0, "absent": 0, "left": 1})
        self.assertIn("intel_agent_mark_unknown", [x[0] for x in rpc_calls])
        self.assertNotIn("intel_agent_fail_send", [x[0] for x in rpc_calls])

    def test_duplicate_webhook_ingestion_and_classification_are_database_idempotent(self):
        rpc = FakeRpc()
        payload = {"p_zoho_message_id": "re_received_1", "p_rfc_message_id": "<reply@x.test>"}
        first = rpc("intel_agent_record_inbound", payload)
        second = rpc("intel_agent_record_inbound", payload)
        self.assertFalse(first["duplicate"])
        self.assertTrue(second["duplicate"])
        self.assertEqual(len(rpc.inbound), 1)

    def test_kill_switch_refusal_happens_before_provider_call(self):
        rpc = FakeRpc(); rpc.add("m1")
        calls = []
        def guarded(name, p=None):
            calls.append(name)
            if name == "intel_agent_reserve_send": return {"ok": False, "reason": "kill_switch"}
            return rpc(name, p)
        client = SimpleNamespace(provider="resend", send=lambda *a, **k: self.fail("provider must not be called"))
        out = mailops.send_message(guarded, client, "m1")
        self.assertEqual(out["reason"], "kill_switch")
        self.assertNotIn("intel_agent_mark_sending", calls)

    def test_uncertain_resend_is_marked_unknown_and_never_retried(self):
        rpc = FakeRpc(); rpc.add("m1")
        class Uncertain:
            provider = "resend"
            def __init__(self): self.calls = 0
            def send(self, *a, **kw):
                self.calls += 1
                raise TransientError("provider outcome unknown")
        client = Uncertain()
        first = mailops.send_message(rpc, client, "m1")
        second = mailops.send_message(rpc, client, "m1")
        self.assertEqual(first["reason"], "unknown")
        self.assertEqual(second["reason"], "needs_reconcile")
        self.assertEqual(client.calls, 1)
        self.assertEqual(rpc.msgs["m1"]["state"], "unknown")

    def test_definitive_resend_rejection_fails_without_retry(self):
        rpc = FakeRpc(); rpc.add("m1")
        class Rejected:
            provider = "resend"
            def send(self, *a, **kw): raise MailRejected("invalid recipient")
        out = mailops.send_message(rpc, Rejected(), "m1")
        self.assertEqual(out["reason"], "rejected")
        self.assertEqual(rpc.msgs["m1"]["state"], "failed")


if __name__ == "__main__":
    unittest.main()
