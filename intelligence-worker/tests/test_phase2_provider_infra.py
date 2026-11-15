"""Phase 2 (provider infrastructure) offline tests. All network is faked: nothing here proves live Gemini behaviour."""
import json, unittest
from pathlib import Path

from kairflow_intel.airouter import settings_from_env, RequestBudget, AIRouter
from kairflow_intel.gemini import GeminiClient
from .helpers import Resp

WORKER = Path(__file__).resolve().parents[1]


def _parse_env(text):
    out = {}
    for line in text.splitlines():
        if line.strip() and not line.lstrip().startswith("#") and "=" in line:
            k, v = line.split("=", 1); out[k.strip()] = v.strip()
    return out


class Sess:
    def __init__(self): self.urls = []
    def post(self, url, **kw):
        self.urls.append((url, kw["json"]["generationConfig"]))
        return Resp(200, json.dumps({"candidates": [{"content": {"parts": [{"text": "{\"a\": 1}"}]}}]}).encode(), {})


SCHEMA = {"type": "object", "properties": {"a": {"type": "integer"}}, "required": ["a"]}


class TemplateTests(unittest.TestCase):
    def test_worker_template_exists_and_encodes_owner_decisions(self):
        env = _parse_env((WORKER / ".env.example").read_text(encoding="utf-8"))
        s = settings_from_env(env)                       # the template itself must be a valid configuration
        self.assertEqual((s.d1, s.rpm, s.rpd), ("C", 10, 200))
        self.assertFalse(s.force_ollama)
        self.assertEqual(env["KAIRFLOW_GEMINI_API_KEY"], "")
        self.assertEqual(env["KAIRFLOW_MAIL_PROVIDER"], "none")

    def test_d1_c_moves_chat_by_default_but_not_drafting(self):
        r = AIRouter(None, None, settings_from_env({"KAIRFLOW_AI_D1": "C"}))
        self.assertEqual(r.resolve("chat.plan", "gemini_first")[0], "gemini_first")     # chat_json_ex passes gemini_first as its default route
        self.assertEqual(r.resolve("drafting.initial", "ollama")[0], "ollama")    # needs an explicit policy entry


class FastModelTests(unittest.TestCase):
    def test_fast_model_used_only_for_fast_calls_and_defaults_off(self):
        s = Sess(); c = GeminiClient("K", "gemini-3.8-flash", s, fast_model="gemini-3.8-flash-lite")
        self.assertEqual(c.generate_json_ex("i", "u", SCHEMA, fast=True).model, "gemini-3.8-flash-lite")
        self.assertEqual(c.generate_json_ex("i", "u", SCHEMA, fast=False).model, "gemini-3.8-flash")
        self.assertIn("gemini-3.8-flash-lite:generateContent", s.urls[0][0])
        self.assertEqual(GeminiClient("K", "gemini-3.8-flash", Sess()).generate_json_ex("i", "u", SCHEMA, fast=True).model, "gemini-3.8-flash")

    def test_fast_model_setting_validated(self):
        self.assertEqual(settings_from_env({"KAIRFLOW_GEMINI_FAST_MODEL": "gemini-3.8-flash-lite"}).fast_model, "gemini-3.8-flash-lite")
        for bad in ("gemini-flash-latest", "gpt-4", "x y"):
            with self.assertRaises(ValueError): settings_from_env({"KAIRFLOW_GEMINI_FAST_MODEL": bad})


class CapTests(unittest.TestCase):
    def test_10_rpm_cap_holds_and_resets(self):
        t = [0.0]; b = RequestBudget(10, 0, 0.0, clock=lambda: t[0])
        self.assertEqual([b.try_acquire("research") for _ in range(10)], [None] * 10)
        self.assertEqual(b.try_acquire("research"), "budget_minute")
        t[0] += 61
        self.assertIsNone(b.try_acquire("research"))

    def test_200_rpd_cap_holds_exactly(self):
        t = [0.0]; b = RequestBudget(0, 200, 0.0, clock=lambda: t[0])
        got = 0
        while b.try_acquire("research") is None:
            got += 1; t[0] += 1
        self.assertEqual(got, 200)
        self.assertEqual(b.try_acquire("research"), "budget_day")


class PrivateRoutingTests(unittest.TestCase):
    def test_template_sends_every_group_to_gemini_first_with_ollama_fallback(self):
        # Owner decision 13 Nov 2026: Gemini does everything (D1=C, default=gemini_first). Only the health.ollama selftest stays on Ollama.
        from kairflow_intel.airouter import KNOWN_SITES, GROUPS
        env = _parse_env((WORKER / ".env.example").read_text(encoding="utf-8"))
        st = settings_from_env(env)
        self.assertEqual(st.d1, "C")
        self.assertFalse(st.force_ollama)
        r = AIRouter(None, None, st)
        self.assertEqual(r.resolve("chat.plan", "gemini_first")[0], "gemini_first")
        for site in sorted(KNOWN_SITES - {"health.ollama"}):
            self.assertEqual(r.resolve(site, "gemini_first" if site.startswith("chat.") else "ollama")[0], "gemini_first", site)
        self.assertEqual(r.resolve("health.ollama")[0], "ollama")
