"""Phase 2: Gemini-first router, per-call provenance and fallback rules. Providers are mocked; no network, no real key."""
import json
import logging
import threading
import unittest
from types import SimpleNamespace

import requests

from kairflow_intel import config as cfgmod
from kairflow_intel.ai_types import (AIResult, GeminiPermanent, GeminiTransient, K_AUTH, K_BAD_REQUEST, K_BLOCKED, K_CONNECTION, K_EMPTY, K_INVALID_JSON,
                                     K_RATE_DAILY, K_RATE_MINUTE, K_SCHEMA, K_SERVER, K_TIMEOUT, K_TRUNCATED, K_UNEXPECTED)
from kairflow_intel.airouter import AIRouter, RequestBudget, RouterSettings, parse_policy, settings_from_env
from kairflow_intel.errors import PermanentError, TransientError
from kairflow_intel.gemini import FallbackLLM, GEMINI_HOST, GeminiClient
from kairflow_intel.ollama import OllamaClient
from .helpers import Resp

SCHEMA = {"type": "object", "required": ["ok"], "properties": {"ok": {"type": "boolean"}}}
MODEL = "gemini-3.8-flash"


class Clock:
    def __init__(self): self.t = 1000.0
    def __call__(self): return self.t


class FakeGemini:
    """Stands in for GeminiClient. `script` is a list of outcomes: a dict (success) or an Exception (raised), consumed in order; the last repeats."""
    def __init__(self, *script):
        self.script, self.calls = list(script) or [{"ok": True}], []
    def generate_json_ex(self, instruction, untrusted, schema, *, fast=False, site="unspecified", timeout=60):
        self.calls.append({"fast": fast, "site": site, "timeout": timeout})
        o = self.script[min(len(self.calls) - 1, len(self.script) - 1)]
        if isinstance(o, Exception):
            raise o
        return AIResult(data=o, provider="gemini", model=MODEL, model_reported=MODEL, finish_reason="STOP", site=site)
    def chat_json(self, *a, **k):
        self.calls.append({"chat": True})
        return {"action": "reply", "reply": "g"}
    @property
    def n(self): return len(self.calls)


class FakeOllama:
    cfg = SimpleNamespace(ollama_model="qwen-3b", ollama_fast_model="qwen-1.5b")
    def __init__(self, out=None, exc=None): self.out, self.exc, self.calls = out if out is not None else {"ok": True, "from": "ollama"}, exc, []
    def generate_json(self, instruction, untrusted, schema, **kw):
        self.calls.append(kw)
        if self.exc: raise self.exc
        return self.out
    def chat_json(self, *a, **k):
        self.calls.append({"chat": True}); return {"action": "reply", "reply": "o"}
    def is_up(self): return True
    @property
    def n(self): return len(self.calls)


def router(g, o=None, clock=None, **settings):
    s = {"policy": {"discovery": "gemini_first", "research": "gemini_first", "drafting": "gemini_first", "classification": "gemini_first"}}
    s.update(settings)
    return AIRouter(g, o or FakeOllama(), RouterSettings(**s), clock or Clock())


def call(r, site="discovery.news", **kw):
    return r.generate_json_ex(site, "instr", "text", SCHEMA, **kw)


class RoutingTests(unittest.TestCase):
    def test_gemini_first_and_success_never_calls_ollama(self):
        g, o = FakeGemini({"ok": True}), FakeOllama()
        res = call(router(g, o), fast=True)
        self.assertEqual((res.provider, res.model, res.route_reason, res.gemini_attempted, res.site), ("gemini", MODEL, None, True, "discovery.news"))
        self.assertEqual((g.n, o.n), (1, 0))
        self.assertEqual(g.calls[0]["site"], "discovery.news"); self.assertTrue(g.calls[0]["fast"])

    def test_empty_policy_is_ollama_for_everything_and_never_touches_gemini(self):
        g, o = FakeGemini(), FakeOllama()
        r = AIRouter(g, o, RouterSettings(policy={}), Clock())
        for site in ("discovery.news", "research.entities", "drafting.initial", "classification.inbound", "chat.plan", "health.selftest", "unspecified"):
            res = call(r, site)
            self.assertEqual((res.provider, res.route_reason), ("ollama", "policy_ollama"))
        self.assertEqual((g.n, o.n), (0, 7))

    def test_default_policy_sends_only_discovery_and_research_to_gemini(self):
        g, o = FakeGemini(), FakeOllama()
        r = AIRouter(g, o, RouterSettings(), Clock())
        got = {site: call(r, site).provider for site in ("discovery.news", "discovery.manual_post", "discovery.studio_profile", "research.entities",
                                                         "drafting.initial", "classification.inbound", "chat.plan", "health.selftest", "unspecified")}
        self.assertEqual([k for k, v in got.items() if v == "gemini"], ["discovery.news", "discovery.manual_post", "discovery.studio_profile", "research.entities"])

    def test_untagged_call_is_always_ollama_even_with_a_default_policy(self):
        g, o = FakeGemini(), FakeOllama()
        r = AIRouter(g, o, RouterSettings(policy={"default": "gemini_first"}), Clock())
        res = r.generate_json_ex("unspecified", "i", "u", SCHEMA)
        self.assertEqual((res.provider, g.n), ("ollama", 0))
        self.assertEqual(r.generate_json("i", "u", SCHEMA), {"ok": True, "from": "ollama"})   # legacy drop-in call, no site tag

    def test_exact_site_policy_beats_group_policy(self):
        g, o = FakeGemini(), FakeOllama()
        r = AIRouter(g, o, RouterSettings(policy={"discovery": "gemini_first", "discovery.news": "ollama"}), Clock())
        self.assertEqual(call(r, "discovery.news").provider, "ollama")
        self.assertEqual(call(r, "discovery.studio").provider, "gemini")

    def test_ollama_provenance_names_the_fast_or_standard_model(self):
        r = AIRouter(None, FakeOllama(), RouterSettings(policy={"discovery": "gemini_first"}), Clock())
        self.assertEqual(call(r, fast=True).model, "qwen-1.5b"); self.assertEqual(call(r, fast=False).model, "qwen-3b")
        self.assertEqual(call(r).route_reason, "no_gemini")

    def test_every_fallback_trigger_causes_exactly_one_ollama_attempt(self):
        triggers = [GeminiTransient("x", K_RATE_MINUTE, 5), GeminiTransient("x", K_RATE_DAILY), GeminiTransient("x", K_TIMEOUT),
                    GeminiTransient("x", K_CONNECTION), GeminiTransient("x", K_SERVER), GeminiTransient("x", K_TRUNCATED),
                    GeminiTransient("x", K_EMPTY), GeminiTransient("x", K_INVALID_JSON), GeminiTransient("x", K_SCHEMA),
                    GeminiTransient("x", K_BLOCKED), GeminiPermanent("x", K_AUTH)]
        for exc in triggers:
            g, o = FakeGemini(exc), FakeOllama()
            res = call(router(g, o))
            self.assertEqual((g.n, o.n, res.provider, res.route_reason, res.gemini_attempted), (1, 1, "ollama", exc.kind, True), exc.kind)
            self.assertEqual(res.data, {"ok": True, "from": "ollama"})          # only Ollama's data; nothing from the failed Gemini attempt

    def test_unexpected_exception_in_gemini_falls_back_and_message_is_not_logged(self):
        g, o = FakeGemini(RuntimeError("https://x?key=SECRET")), FakeOllama()
        with self.assertLogs("kairflow_intel.airouter", level="DEBUG") as lg:
            res = call(router(g, o))
        self.assertEqual((res.provider, res.route_reason, o.n), ("ollama", K_UNEXPECTED, 1))
        self.assertNotIn("SECRET", "\n".join(lg.output))

    def test_both_failing_raises_the_ollama_error_class_with_no_loop(self):
        for o_exc, expect in ((TransientError("o down"), TransientError), (PermanentError("no model"), PermanentError)):
            g, o = FakeGemini(GeminiTransient("x", K_SERVER)), FakeOllama(exc=o_exc)
            with self.assertRaises(expect):
                call(router(g, o))
            self.assertEqual((g.n, o.n), (1, 1))

    def test_rollback_flag_forces_ollama_everywhere_including_chat(self):
        g, o = FakeGemini(), FakeOllama()
        llm = FallbackLLM(g, o, settings=RouterSettings(policy={"default": "gemini_first", "discovery": "gemini_first"}, force_ollama=True))
        self.assertEqual(llm.generate_json_ex("discovery.news", "i", "u", SCHEMA).route_reason, "forced_ollama")
        llm.chat_json("s", [], {})
        self.assertEqual((g.n, llm.last_backend), (0, "ollama"))

    def test_both_providers_are_checked_against_the_same_schema(self):
        # Ollama path: the real OllamaClient validates with the shared validate(); a schema-invalid answer raises instead of being returned.
        class S:
            def post(self, url, **kw):
                return Resp(200, json.dumps({"message": {"content": json.dumps({"ok": "nope"})}}).encode(), {"Content-Type": "application/json"})
        ollama = OllamaClient(SimpleNamespace(ollama_url="http://127.0.0.1:11434", ollama_model="m", ollama_fast_model="f"), S())
        g = FakeGemini(GeminiTransient("x", K_SCHEMA))
        with self.assertRaises(TransientError):
            call(router(g, ollama))
        self.assertEqual(g.n, 1)


class CooldownTests(unittest.TestCase):
    def test_daily_exhaustion_skips_gemini_until_the_cooldown_ends(self):
        clk, g, o = Clock(), FakeGemini(GeminiTransient("x", K_RATE_DAILY), {"ok": True}), FakeOllama()
        r = router(g, o, clk, daily_cooldown=3600)
        self.assertEqual(call(r).route_reason, K_RATE_DAILY)
        for _ in range(5):
            self.assertEqual(call(r).route_reason, "gemini_cooldown_daily")
        self.assertEqual((g.n, o.n), (1, 6))                       # later calls do not pay for a Gemini attempt
        clk.t += 3601
        self.assertEqual(call(r).provider, "gemini"); self.assertEqual(g.n, 2)

    def test_minute_limit_honours_retry_after_then_resumes(self):
        clk, g, o = Clock(), FakeGemini(GeminiTransient("x", K_RATE_MINUTE, 45), {"ok": True}), FakeOllama()
        r = router(g, o, clk)
        call(r); self.assertEqual(call(r).route_reason, "gemini_backoff_rate_limit"); self.assertEqual(g.n, 1)
        clk.t += 44; self.assertEqual(call(r).route_reason, "gemini_backoff_rate_limit")
        clk.t += 2;  self.assertEqual(call(r).provider, "gemini")

    def test_minute_limit_backoff_defaults_and_is_capped(self):
        clk = Clock(); g = FakeGemini(GeminiTransient("x", K_RATE_MINUTE, None), {"ok": True})
        r = router(g, clock=clk, rate_backoff_default=30)
        call(r); clk.t += 29; self.assertEqual(call(r).route_reason, "gemini_backoff_rate_limit")
        clk.t += 2; self.assertEqual(call(r).provider, "gemini")
        clk2 = Clock(); r2 = router(FakeGemini(GeminiTransient("x", K_RATE_MINUTE, 99999), {"ok": True}), clock=clk2, rate_backoff_max=120)
        call(r2); clk2.t += 121; self.assertEqual(call(r2).provider, "gemini")

    def test_permanent_error_uses_the_600_second_cooldown_and_is_shared_with_chat(self):
        clk, g, o = Clock(), FakeGemini(GeminiPermanent("bad key"), {"ok": True}), FakeOllama()
        llm = FallbackLLM(g, o, clock=clk, settings=RouterSettings(policy={"discovery": "gemini_first"}))
        self.assertEqual(llm.generate_json_ex("discovery.news", "i", "u", SCHEMA).route_reason, K_AUTH)
        self.assertEqual(llm.generate_json_ex("discovery.news", "i", "u", SCHEMA).route_reason, "gemini_cooldown_permanent")
        llm.chat_json("s", [], {})                                  # chat also skips Gemini during the shared cooldown
        self.assertEqual(g.n, 1); self.assertEqual(llm.last_backend, "ollama"); self.assertIn("bad key", llm.last_gemini_error)
        clk.t += 601
        self.assertEqual(llm.generate_json_ex("discovery.news", "i", "u", SCHEMA).provider, "gemini")

    def test_repeated_outage_failures_open_a_short_pause_and_success_resets_the_count(self):
        clk = Clock(); T = GeminiTransient("x", K_TIMEOUT)
        g = FakeGemini(T, T, {"ok": True}, T, T, T, {"ok": True})
        r = router(g, clock=clk, outage_threshold=3, outage_backoff=60)
        call(r); call(r); call(r)                                   # fail, fail, success: count resets
        call(r); call(r); call(r)                                   # fail x3: pause opens
        self.assertEqual(g.n, 6); self.assertEqual(call(r).route_reason, "gemini_backoff_outage"); self.assertEqual(g.n, 6)
        clk.t += 61; self.assertEqual(call(r).provider, "gemini")


class RegressionCooldownTests(unittest.TestCase):
    def test_outage_count_is_consecutive_other_failures_break_the_run(self):
        clk = Clock(); T, S = GeminiTransient("x", K_SERVER), GeminiTransient("x", K_SCHEMA)
        g = FakeGemini(T, S, T, S, T)
        r = router(g, clock=clk, outage_threshold=3, outage_backoff=60)
        for _ in range(5): call(r)
        self.assertIsNone(r.status()["gemini_block"])                                      # server, schema, server, schema, server: never 3 in a row
        g2 = FakeGemini(T, T, T); r2 = router(g2, clock=clk, outage_threshold=3, outage_backoff=60)
        for _ in range(3): call(r2)
        self.assertEqual(r2.status()["gemini_block"], "gemini_backoff_outage")

    def test_repeated_429_without_details_backs_off_harder_then_assumes_daily_exhaustion(self):
        clk = Clock(); g = FakeGemini(GeminiTransient("429", K_RATE_MINUTE))
        r = router(g, clock=clk, rate_backoff_default=30, rate_backoff_max=300, daily_cooldown=10800)
        waits = []
        for _ in range(4):
            before = r._rate_until; call(r); waits.append(round(r._rate_until - clk.t)); clk.t = r._rate_until + 0.1
        self.assertEqual(waits, [30, 60, 120, 240])
        call(r)                                                                            # fifth in a row: daily cooldown, not another 300 s
        self.assertEqual(r.status()["gemini_block"], "gemini_cooldown_daily")
        n = g.n; clk.t += 3600; call(r); self.assertEqual(g.n, n)                          # skipped for hours instead of every few minutes

    def test_429_with_retry_after_and_a_success_reset_the_streak(self):
        clk = Clock(); N = GeminiTransient("429", K_RATE_MINUTE); W = GeminiTransient("429", K_RATE_MINUTE, 20.0)
        g = FakeGemini(N, N, N, N, W, N, N, N, N, {"ok": True}, N, N, N, N)
        r = router(g, clock=clk)
        for _ in range(5): call(r); clk.t = max(r._rate_until, clk.t) + 0.1
        self.assertIsNone(r.status()["gemini_block"])                                      # Retry-After was believed and reset the streak
        for _ in range(4): call(r); clk.t = max(r._rate_until, clk.t) + 0.1
        call(r); clk.t = max(r._rate_until, clk.t) + 0.1                                   # success resets the streak
        for _ in range(4): call(r); clk.t = max(r._rate_until, clk.t) + 0.1
        self.assertIsNone(r.status()["gemini_block"])


class BudgetTests(unittest.TestCase):
    def test_per_minute_cap_then_resets(self):
        clk, g = Clock(), FakeGemini()
        r = router(g, clock=clk, rpm=2)
        self.assertEqual([call(r).provider for _ in range(2)], ["gemini", "gemini"])
        res = call(r); self.assertEqual((res.provider, res.route_reason, g.n), ("ollama", "budget_minute", 2))
        clk.t += 61; self.assertEqual(call(r).provider, "gemini")

    def test_daily_cap_reserves_a_share_for_drafting(self):
        g = FakeGemini()
        r = router(g, rpd=10, draft_reserve=0.3, d1="C")
        ok = [call(r, "discovery.news").provider for _ in range(9)]
        self.assertEqual(ok.count("gemini"), 7)                    # int(10 * 0.7)
        self.assertEqual(call(r, "research.entities").route_reason, "budget_day")
        self.assertEqual([call(r, "drafting.initial").provider for _ in range(3)], ["gemini"] * 3)
        self.assertEqual(call(r, "drafting.initial").route_reason, "budget_day")

    def test_draft_reserve_is_not_held_back_when_drafting_cannot_reach_gemini(self):
        pol = {"discovery": "gemini_first", "research": "gemini_first"}
        r = router(FakeGemini(), rpd=100, draft_reserve=0.25, policy=pol)                    # D1=A: drafting never reaches Gemini
        self.assertEqual(r.budget.reserve, 0.0)
        self.assertEqual([call(r).provider for _ in range(100)].count("gemini"), 100)
        for kw in ({"d1": "C", "policy": {**pol, "drafting": "gemini_first"}}, {"d1": "C", "policy": {"default": "gemini_first"}}):
            self.assertEqual(router(FakeGemini(), rpd=100, draft_reserve=0.25, **kw).budget.reserve, 0.25)
        self.assertEqual(router(FakeGemini(), rpd=100, draft_reserve=0.25, d1="C", policy={"drafting": "gemini_first"}, force_ollama=True).budget.reserve, 0.0)

    def test_failed_attempts_count_and_zero_means_no_local_cap(self):
        g = FakeGemini(GeminiTransient("x", K_SCHEMA)); r = router(g, rpm=2)
        call(r); call(r); self.assertEqual(call(r).route_reason, "budget_minute"); self.assertEqual(g.n, 2)
        g2 = FakeGemini(); r2 = router(g2)
        for _ in range(50): call(r2)
        self.assertEqual(g2.n, 50)

    def test_budget_counts_are_secret_free(self):
        b = RequestBudget(5, 100, 0.2); b.try_acquire("discovery")
        self.assertEqual(b.counts(), {"last_minute": 1, "last_24h": 1, "rpm": 5, "rpd": 100})


class PrivacyPolicyTests(unittest.TestCase):
    def test_drafting_and_classification_stay_on_ollama_under_d1_a(self):
        g = FakeGemini(); r = router(g, d1="A")
        for site in ("drafting.initial", "drafting.reply", "classification.inbound"):
            self.assertEqual(call(r, site).route_reason, "d1_private")
        self.assertEqual(g.n, 0)
        self.assertEqual(call(r, "discovery.news").provider, "gemini")

    def test_default_policy_does_not_pull_private_groups_to_gemini_under_d1_a(self):
        g = FakeGemini(); r = AIRouter(g, FakeOllama(), RouterSettings(policy={"default": "gemini_first"}), Clock())
        self.assertEqual(call(r, "drafting.reply").route_reason, "d1_private"); self.assertEqual(call(r, "research.entities").provider, "gemini")

    def test_d1_c_allows_private_groups(self):
        self.assertEqual(call(router(FakeGemini(), d1="C"), "drafting.reply").provider, "gemini")

    def test_settings_validation(self):
        self.assertEqual(settings_from_env({}), RouterSettings())
        for bad in ({"KAIRFLOW_AI_D1": "B"}, {"KAIRFLOW_AI_D1": "Z"}, {"KAIRFLOW_GEMINI_THINKING": "minimal"}, {"KAIRFLOW_GEMINI_THINKING": "off"}, {"KAIRFLOW_GEMINI_THINKING": "max"},
                    {"KAIRFLOW_AI_POLICY": "discovery=maybe"}, {"KAIRFLOW_AI_POLICY": "discoveryX=ollama"}, {"KAIRFLOW_AI_POLICY": "oops"},
                    {"KAIRFLOW_GEMINI_RPM": "ten"}, {"KAIRFLOW_GEMINI_MAX_OUTPUT": "10"}, {"KAIRFLOW_GEMINI_DRAFT_RESERVE": "2"}):
            with self.assertRaises(ValueError, msg=str(bad)):
                settings_from_env(bad)
        s = settings_from_env({"KAIRFLOW_AI_POLICY": "discovery=gemini_first, research.entity=ollama,default=ollama", "KAIRFLOW_AI_FORCE_OLLAMA": "1",
                               "KAIRFLOW_GEMINI_RPM": "10", "KAIRFLOW_GEMINI_RPD": "250", "KAIRFLOW_GEMINI_THINKING": "medium"})
        self.assertEqual((s.policy["discovery"], s.policy["research.entity"], s.force_ollama, s.rpm, s.rpd, s.thinking), ("gemini_first", "ollama", True, 10, 250, "medium"))
        self.assertEqual(parse_policy(""), {})

    def test_policy_default_ollama_puts_discovery_and_research_back_on_ollama(self):
        r = AIRouter(FakeGemini(), FakeOllama(), settings_from_env({"KAIRFLOW_AI_POLICY": "default=ollama"}), Clock())
        for site in ("discovery.news", "research.entity", "chat.plan", "drafting.initial"):
            self.assertEqual(r.resolve(site, "ollama")[0], "ollama", site)
        r2 = AIRouter(FakeGemini(), FakeOllama(), settings_from_env({"KAIRFLOW_AI_POLICY": "default=ollama,research=gemini_first"}), Clock())
        self.assertEqual((r2.resolve("research.entity")[0], r2.resolve("discovery.news")[0]), ("gemini_first", "ollama"))   # explicit entries still win
        self.assertEqual(settings_from_env({}).policy, {"discovery": "gemini_first", "research": "gemini_first"})          # no `default`: built-ins stay

    def test_group_entry_cannot_move_a_pinned_health_check_but_an_exact_site_entry_can(self):
        r = AIRouter(FakeGemini(), FakeOllama(), settings_from_env({"KAIRFLOW_AI_POLICY": "health=gemini_first"}), Clock())
        self.assertEqual(r.resolve("health.ollama")[0], "ollama")
        self.assertEqual(r.resolve("health.gemini")[0], "gemini_first")
        self.assertEqual(r.resolve("health.chat")[0], "gemini_first")                     # an unpinned health site follows the group
        r2 = AIRouter(FakeGemini(), FakeOllama(), settings_from_env({"KAIRFLOW_AI_POLICY": "health.ollama=gemini_first"}), Clock())
        self.assertEqual(r2.resolve("health.ollama")[0], "gemini_first")

    def test_typo_in_a_policy_site_name_is_rejected(self):
        for bad in ("discovery.nwes=ollama", "research.entities=ollama", "chat.plann=ollama"):
            with self.assertRaises(ValueError, msg=bad):
                parse_policy(bad)
        self.assertEqual(parse_policy("discovery.news=ollama,health.ollama=gemini_first"), {"discovery.news": "ollama", "health.ollama": "gemini_first"})

    def test_config_load_carries_router_settings_and_rejects_bad_ones(self):
        env = {"KAIRFLOW_SUPABASE_URL": "https://x.supabase.co", "KAIRFLOW_SUPABASE_ANON_KEY": "a", "KAIRFLOW_AGENT_EMAIL": "w@x.com",
               "KAIRFLOW_AGENT_PASSWORD": "p", "KAIRFLOW_OLLAMA_URL": "http://127.0.0.1:11434"}
        cfg = cfgmod.load(dict(env, KAIRFLOW_AI_POLICY="discovery=gemini_first"))
        self.assertEqual(cfg.ai_router.policy, {"discovery": "gemini_first", "research": "gemini_first"})
        self.assertEqual(cfgmod.load(dict(env)).ai_router, RouterSettings())              # default: every call site stays on Ollama
        self.assertEqual(cfgmod.load(dict(env)).gemini_model, "gemini-3.8-flash")         # Phase 6: the pinned model is the default
        with self.assertRaises(cfgmod.ConfigError):
            cfgmod.load(dict(env, KAIRFLOW_AI_D1="B"))


class Sess:
    def __init__(self, *outcomes): self.outcomes, self.calls = list(outcomes), []
    def post(self, url, **kw):
        self.calls.append((url, kw))
        o = self.outcomes[min(len(self.calls) - 1, len(self.outcomes) - 1)]
        if isinstance(o, Exception): raise o
        return o


def reply(text="{\"ok\": true}", finish="STOP", **extra):
    cand = {"content": {"parts": [{"text": text}]}}
    if finish is not None: cand["finishReason"] = finish
    body = {"candidates": [cand], "usageMetadata": {"promptTokenCount": 11, "candidatesTokenCount": 5, "thoughtsTokenCount": 7, "totalTokenCount": 23},
            "modelVersion": MODEL}
    body.update(extra)
    return Resp(200, json.dumps(body).encode(), {"Content-Type": "application/json"})


def client(*outcomes, **kw):
    s = Sess(*outcomes); return GeminiClient("SECRET", MODEL, s, **kw), s


def quota(metric, retry=None):
    d = [{"@type": "type.googleapis.com/google.rpc.QuotaFailure", "violations": [{"quotaMetric": "generativelanguage.googleapis.com/generate_content_free_tier_requests", "quotaId": metric}]}]
    if retry: d.append({"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": retry})
    return json.dumps({"error": {"code": 429, "status": "RESOURCE_EXHAUSTED", "details": d}}).encode()


class GeminiGenerateJsonTests(unittest.TestCase):
    def test_success_records_provenance_finish_reason_and_usage(self):
        c, s = client(reply())
        res = c.generate_json_ex("instr", "page text", SCHEMA, fast=True, site="discovery.news")
        self.assertEqual((res.data, res.provider, res.model, res.model_reported, res.finish_reason, res.site), ({"ok": True}, "gemini", MODEL, MODEL, "STOP", "discovery.news"))
        self.assertEqual(res.usage, {"promptTokens": 11, "outputTokens": 5, "thoughtsTokens": 7, "totalTokens": 23})
        self.assertEqual(c.generate_json("i", "u", SCHEMA), {"ok": True})

    def test_request_shape_key_in_header_untrusted_wrapped_schema_in_instructions(self):
        c, s = client(reply())
        c.generate_json("do it", "PAGE", SCHEMA)
        url, kw = s.calls[0]
        self.assertTrue(url.startswith(GEMINI_HOST) and url.endswith(f"/models/{MODEL}:generateContent")); self.assertNotIn("SECRET", url)
        self.assertEqual(kw["headers"]["x-goog-api-key"], "SECRET"); self.assertNotIn("SECRET", json.dumps(kw["json"]))
        user = kw["json"]["contents"][0]["parts"][0]["text"]
        self.assertIn("<untrusted>\nPAGE\n</untrusted>", user); self.assertIn("DATA copied from a website", kw["json"]["systemInstruction"]["parts"][0]["text"])
        self.assertIn('"required"', kw["json"]["systemInstruction"]["parts"][0]["text"]); self.assertNotIn("responseSchema", json.dumps(kw["json"]))

    def test_untrusted_text_is_capped_like_ollama(self):
        from kairflow_intel.ollama import MAX_UNTRUSTED_CHARS
        c, s = client(reply()); c.generate_json("i", "x" * (MAX_UNTRUSTED_CHARS + 5000), SCHEMA)
        self.assertLess(len(s.calls[0][1]["json"]["contents"][0]["parts"][0]["text"]), MAX_UNTRUSTED_CHARS + 500)

    def test_thinking_is_low_by_default_never_minimal_and_only_for_gemini_3(self):
        c, s = client(reply(), reply(), reply())
        c.generate_json("i", "u", SCHEMA, fast=True); c.generate_json("i", "u", SCHEMA, fast=False)
        g1, g2 = (x[1]["json"]["generationConfig"] for x in s.calls[:2])
        self.assertEqual(g1["thinkingConfig"], {"thinkingLevel": "low"}); self.assertEqual(g1["maxOutputTokens"], 2048); self.assertEqual(g2["maxOutputTokens"], 4096)
        self.assertGreater(g1["maxOutputTokens"], 1500)
        for g in (g1, g2): self.assertNotIn("minimal", json.dumps(g)); self.assertNotIn("temperature", g); self.assertEqual(g["responseMimeType"], "application/json")
        with self.assertRaises(ValueError): GeminiClient("k", MODEL, thinking="minimal")
        with self.assertRaises(ValueError): client(reply(), thinking="off")
        s3 = Sess(reply()); GeminiClient("k", "gemini-2.5-flash", s3).generate_json("i", "u", SCHEMA)
        self.assertNotIn("thinkingConfig", s3.calls[0][1]["json"]["generationConfig"]); self.assertEqual(s3.calls[0][1]["json"]["generationConfig"]["temperature"], 0)

    def test_chat_json_request_is_unchanged_for_a_legacy_model(self):
        # Phase 6: an owner who explicitly keeps an older model (KAIRFLOW_GEMINI_MODEL=gemini-2.5-flash) gets exactly the original request.
        s = Sess(Resp(200, json.dumps({"candidates": [{"content": {"parts": [{"text": json.dumps({"action": "reply", "reply": "x"})}]}}]}).encode()))
        from kairflow_intel import chat
        GeminiClient("SECRET", "gemini-2.5-flash", s).chat_json("sys", [{"role": "user", "content": "a"}], chat.PLAN_SCHEMA)
        g = s.calls[0][1]["json"]["generationConfig"]
        self.assertEqual(g, {"temperature": 0, "responseMimeType": "application/json", "maxOutputTokens": 1500})

    def test_thought_parts_are_excluded_from_the_answer(self):
        body = {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"thought": True, "text": "reasoning {not json"}, {"text": "{\"ok\": true}"}]}}]}
        c, _ = client(Resp(200, json.dumps(body).encode())); self.assertEqual(c.generate_json("i", "u", SCHEMA), {"ok": True})

    def _kind(self, outcome):
        c, _ = client(outcome)
        with self.assertRaises((GeminiTransient, GeminiPermanent)) as cm:
            c.generate_json("i", "u", SCHEMA)
        self.assertNotIn("SECRET", str(cm.exception)); return cm.exception

    def test_http_and_transport_failures_are_classified(self):
        self.assertEqual(self._kind(Resp(408, b"{}")).kind, K_TIMEOUT)
        self.assertEqual(self._kind(Resp(500, b"{}")).kind, K_SERVER); self.assertEqual(self._kind(Resp(503, b"{}")).kind, K_SERVER)
        self.assertEqual(self._kind(requests.Timeout("https://x?key=SECRET")).kind, K_TIMEOUT)
        self.assertEqual(self._kind(requests.ConnectionError("https://x?key=SECRET")).kind, K_CONNECTION)
        for status in (401, 403, 404):
            e = self._kind(Resp(status, b"{}")); self.assertIsInstance(e, PermanentError); self.assertEqual(e.kind, K_AUTH)

    def test_a_plain_400_is_transient_but_a_400_for_an_invalid_key_is_permanent(self):
        for status in (400, 413, 422):
            e = self._kind(Resp(status, b"{}")); self.assertIsInstance(e, TransientError); self.assertNotIsInstance(e, PermanentError); self.assertEqual(e.kind, K_BAD_REQUEST)
        bad_key = json.dumps({"error": {"code": 400, "status": "INVALID_ARGUMENT", "message": "API key not valid. Please pass a valid API key.",
                                        "details": [{"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": "API_KEY_INVALID"}]}}).encode()
        e = self._kind(Resp(400, bad_key)); self.assertIsInstance(e, PermanentError); self.assertEqual(e.kind, K_AUTH)
        msg_only = json.dumps({"error": {"code": 400, "message": "API key not valid. Please pass a valid API key."}}).encode()
        self.assertIsInstance(self._kind(Resp(400, msg_only)), PermanentError)

    def test_one_odd_400_does_not_pause_gemini_for_other_call_sites(self):
        c, _ = client(Resp(400, b"{}"), reply())
        r = AIRouter(c, FakeOllama(), RouterSettings(policy={"discovery": "gemini_first", "research": "gemini_first"}), Clock())
        self.assertEqual(call(r, "discovery.news").route_reason, K_BAD_REQUEST)
        self.assertIsNone(r.status()["gemini_block"])
        self.assertEqual(call(r, "research.entity").provider, "gemini")                   # an unrelated site still reaches Gemini

    def test_429_per_minute_vs_daily_and_retry_after(self):
        e = self._kind(Resp(429, quota("GenerateRequestsPerMinutePerProjectPerModel-FreeTier", "34s")))
        self.assertEqual((e.kind, e.retry_after), (K_RATE_MINUTE, 34.0))
        e = self._kind(Resp(429, quota("GenerateRequestsPerDayPerProjectPerModel-FreeTier")))
        self.assertEqual(e.kind, K_RATE_DAILY)
        e = self._kind(Resp(429, b"{}", {"retry-after": "12"})); self.assertEqual((e.kind, e.retry_after), (K_RATE_MINUTE, 12.0))   # header, any case
        e = self._kind(Resp(429, b"not json")); self.assertEqual((e.kind, e.retry_after), (K_RATE_MINUTE, None))

    def test_incomplete_or_unusable_output_is_discarded(self):
        self.assertEqual(self._kind(reply("{\"ok\": tr", finish="MAX_TOKENS")).kind, K_TRUNCATED)
        self.assertEqual(self._kind(reply("{\"ok\": true}", finish="MAX_TOKENS")).kind, K_TRUNCATED)       # complete-looking JSON, still not trusted
        self.assertEqual(self._kind(reply("")).kind, K_EMPTY)
        self.assertEqual(self._kind(Resp(200, json.dumps({"candidates": []}).encode())).kind, K_EMPTY)
        self.assertEqual(self._kind(Resp(200, json.dumps({}).encode())).kind, K_EMPTY)
        self.assertEqual(self._kind(Resp(200, json.dumps({"promptFeedback": {"blockReason": "SAFETY"}}).encode())).kind, K_BLOCKED)
        self.assertEqual(self._kind(reply("{\"ok\": true}", finish="SAFETY")).kind, K_BLOCKED)
        self.assertEqual(self._kind(reply("not json at all")).kind, K_INVALID_JSON)
        self.assertEqual(self._kind(Resp(200, b"<html>")).kind, K_INVALID_JSON)
        self.assertEqual(self._kind(reply("{\"ok\": \"yes\"}")).kind, K_SCHEMA)
        self.assertEqual(self._kind(reply("{}")).kind, K_SCHEMA)
        self.assertEqual(self._kind(reply("[1, 2]")).kind, K_SCHEMA)

    def test_full_path_real_client_truncation_falls_back_to_ollama_once(self):
        c, s = client(reply("{\"ok\": tr", finish="MAX_TOKENS")); o = FakeOllama()
        res = call(AIRouter(c, o, RouterSettings(policy={"discovery": "gemini_first"}), Clock()))
        self.assertEqual((len(s.calls), o.n, res.provider, res.route_reason, res.data), (1, 1, "ollama", K_TRUNCATED, {"ok": True, "from": "ollama"}))

    def test_model_mismatch_is_recorded_not_hidden(self):
        c, _ = client(reply(modelVersion="gemini-3.8-flash-preview-x"))
        res = c.generate_json_ex("i", "u", SCHEMA); self.assertEqual((res.model, res.model_reported), (MODEL, "gemini-3.8-flash-preview-x"))


class ProvenanceAndSecrecyTests(unittest.TestCase):
    def test_provenance_is_per_call_under_concurrency(self):
        g, o = FakeGemini(), FakeOllama()
        r = AIRouter(g, o, RouterSettings(policy={"discovery": "gemini_first"}), Clock())
        out, lock = [], threading.Lock()
        def work(site):
            res = r.generate_json_ex(site, "i", "u", SCHEMA)
            with lock: out.append((site, res.provider, res.site))
        ts = [threading.Thread(target=work, args=(("discovery.news", "research.entities")[i % 2],)) for i in range(40)]
        [t.start() for t in ts]; [t.join() for t in ts]
        for site, provider, rsite in out:
            self.assertEqual(provider, "gemini" if site.startswith("discovery") else "ollama"); self.assertEqual(site, rsite)

    def test_key_never_appears_in_logs_errors_or_results(self):
        errs = [requests.ConnectionError("https://generativelanguage.googleapis.com/x?key=SECRET"), requests.Timeout("key=SECRET"), Resp(403, b"{\"key\":\"SECRET\"}"),
                Resp(429, quota("PerDay")), reply("{\"ok\": \"bad\"}"), Resp(500, b"SECRET")]
        with self.assertLogs("kairflow_intel.airouter", level="DEBUG") as lg:
            for e in errs:
                c, _ = client(e); o = FakeOllama()
                res = call(AIRouter(c, o, RouterSettings(policy={"discovery": "gemini_first"}), Clock()))
                self.assertNotIn("SECRET", repr(res))
        self.assertNotIn("SECRET", "\n".join(lg.output))

    def test_router_never_logs_provider_exception_text(self):
        for exc in (GeminiTransient("leak SECRET", K_SERVER), GeminiTransient("leak SECRET", K_RATE_DAILY), GeminiPermanent("leak SECRET")):
            with self.assertLogs("kairflow_intel.airouter", level="DEBUG") as lg:
                call(router(FakeGemini(exc)))
            self.assertNotIn("SECRET", "\n".join(lg.output))

    def test_status_is_secret_free_and_reports_blocks(self):
        clk = Clock(); r = router(FakeGemini(GeminiPermanent("bad SECRET-less")), clock=clk)
        call(r); st = r.status()
        self.assertEqual((st["gemini_block"], st["gemini_configured"], st["d1"], st["forced_ollama"]), ("gemini_cooldown_permanent", True, "A", False))


class ExistingBehaviourTests(unittest.TestCase):
    def test_default_fallbackllm_generate_json_is_plain_ollama_passthrough(self):
        o = FakeOllama(out={"from": "ollama"}); llm = FallbackLLM(FakeGemini(), o)
        self.assertEqual(llm.generate_json("i", "u", {}, fast=True, timeout=90), {"from": "ollama"})
        self.assertEqual(o.calls[0], {"fast": True, "timeout": 90}); self.assertTrue(llm.is_up())

    def test_generate_json_does_not_disturb_agent_chat_state(self):
        g, o = FakeGemini(GeminiTransient("x", K_SERVER)), FakeOllama()
        llm = FallbackLLM(g, o, settings=settings_from_env({"KAIRFLOW_AI_D1": "C", "KAIRFLOW_AI_POLICY": "chat=gemini_first"}))
        llm.generate_json_ex("discovery.news", "i", "u", SCHEMA)
        self.assertEqual(llm.last_backend, "ollama")
        self.assertEqual(llm.chat_json("s", [], {})["reply"], "g"); self.assertEqual(llm.last_backend, "gemini")     # chat still tries Gemini first

    def test_build_always_wraps_so_call_sites_can_ask_for_provenance(self):
        from kairflow_intel import main
        cfg = SimpleNamespace(supabase_url="https://x.supabase.co", supabase_anon_key="a", agent_email="w@x.com", agent_password="p", worker_id="w",
                              ollama_url="http://127.0.0.1:11434", ollama_model="m", ollama_fast_model="f", gemini_api_key="", gemini_model="",
                              mail_provider="none", mail_account_id="", user_agent="ua", fetch_timeout=5, max_fetch_bytes=1000, per_host_delay=0.0,
                              ai_router=RouterSettings(policy={"discovery": "gemini_first"}))
        _, d = main.build(cfg)
        self.assertIsInstance(d.llm, FallbackLLM); self.assertIsNone(d.llm.primary)
        res = d.llm.router.resolve("discovery.news"); self.assertEqual(res, ("gemini_first", None))
        cfg.gemini_api_key = "SECRET"; cfg.gemini_model = MODEL
        _, d2 = main.build(cfg); self.assertEqual((d2.llm.primary.model, d2.llm.primary.thinking), (MODEL, "low"))


if __name__ == "__main__":
    unittest.main()
