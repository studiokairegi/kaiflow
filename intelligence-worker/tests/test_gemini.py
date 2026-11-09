import json
import unittest

from kairflow_intel import chat
from kairflow_intel.errors import PermanentError, TransientError
from kairflow_intel.gemini import FallbackLLM, GeminiClient, GEMINI_HOST
from .helpers import Resp


class Sess:
    def __init__(self, resp=None, exc=None): self.resp, self.exc, self.calls = resp, exc, []
    def post(self, url, **kw):
        self.calls.append((url, kw))
        if self.exc: raise self.exc
        return self.resp


def ok(obj):
    return Resp(200, json.dumps({"candidates": [{"content": {"parts": [{"text": json.dumps(obj)}]}}]}).encode(), {"Content-Type": "application/json"})


class GeminiClientTests(unittest.TestCase):
    def test_success_sends_key_in_header_not_url_and_maps_roles(self):
        s = Sess(ok({"action": "reply", "reply": "hi"}))
        out = GeminiClient("SECRET", "gemini-x", s).chat_json("sys", [{"role": "user", "content": "a"}, {"role": "user", "content": "b"},
                                                                  {"role": "assistant", "content": "c"}], chat.PLAN_SCHEMA)
        self.assertEqual(out["reply"], "hi")
        url, kw = s.calls[0]
        self.assertTrue(url.startswith(GEMINI_HOST)); self.assertNotIn("SECRET", url)
        self.assertEqual(kw["headers"]["x-goog-api-key"], "SECRET")
        roles = [c["role"] for c in kw["json"]["contents"]]
        self.assertEqual(roles, ["user", "model"])                       # consecutive user turns merged
        self.assertNotIn("responseSchema", json.dumps(kw["json"]))

    def test_errors_are_classified_and_never_contain_the_key(self):
        for status, exc in ((429, TransientError), (503, TransientError), (400, PermanentError), (403, PermanentError)):
            with self.assertRaises(exc) as cm:
                GeminiClient("SECRET", "m", Sess(Resp(status, b"{}"))).chat_json("s", [{"role": "user", "content": "x"}], chat.PLAN_SCHEMA)
            self.assertNotIn("SECRET", str(cm.exception))
        import requests
        with self.assertRaises(TransientError) as cm:
            GeminiClient("SECRET", "m", Sess(exc=requests.ConnectionError("https://x?key=SECRET"))).chat_json("s", [{"role": "user", "content": "x"}], chat.PLAN_SCHEMA)
        self.assertNotIn("SECRET", str(cm.exception))

    def test_schema_violation_is_transient(self):
        with self.assertRaises(TransientError):
            GeminiClient("k", "m", Sess(ok({"action": "dance"}))).chat_json("s", [{"role": "user", "content": "x"}], chat.PLAN_SCHEMA)


class Fake:
    def __init__(self, out=None, exc=None): self.out, self.exc, self.n = out, exc, 0
    def chat_json(self, *a, **k):
        self.n += 1
        if self.exc: raise self.exc
        return self.out
    def is_up(self): return True
    def generate_json(self, *a, **k): return {"from": "ollama"}


class FallbackTests(unittest.TestCase):
    def test_gemini_used_when_healthy(self):
        g, o = Fake({"action": "reply", "reply": "g"}), Fake({"action": "reply", "reply": "o"})
        r = FallbackLLM(g, o)
        self.assertEqual(r.chat_json("s", [], {})["reply"], "g"); self.assertEqual(r.last_backend, "gemini"); self.assertEqual(o.n, 0)

    def test_transient_failure_falls_back_to_ollama_each_time_but_still_retries_gemini(self):
        g, o = Fake(exc=TransientError("429")), Fake({"action": "reply", "reply": "o"})
        r = FallbackLLM(g, o)
        r.chat_json("s", [], {}); r.chat_json("s", [], {})
        self.assertEqual((g.n, o.n, r.last_backend), (2, 2, "ollama"))

    def test_permanent_failure_pauses_gemini_then_retries_after_cooldown(self):
        t = [0.0]; g, o = Fake(exc=PermanentError("bad key")), Fake({"action": "reply", "reply": "o"})
        r = FallbackLLM(g, o, clock=lambda: t[0])
        r.chat_json("s", [], {}); r.chat_json("s", [], {})
        self.assertEqual((g.n, o.n), (1, 2)); self.assertIn("bad key", r.last_gemini_error)
        t[0] = 10_000; r.chat_json("s", [], {}); self.assertEqual(g.n, 2)

    def test_other_methods_stay_on_ollama(self):
        r = FallbackLLM(Fake(), Fake())
        self.assertEqual(r.generate_json("i", "u", {}), {"from": "ollama"}); self.assertTrue(r.is_up())


if __name__ == "__main__":
    unittest.main()
