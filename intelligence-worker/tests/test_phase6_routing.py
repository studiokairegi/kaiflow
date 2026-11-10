"""Phase 6: inbound classification, Agent Chat and the selftest health checks go through the one AI router; the pinned model is the default.

Classification reads raw inbound email, so decision D1 governs it exactly like drafting: D1=A (default) keeps it on Ollama whatever the
policy says; D1=C plus a policy entry lets it try Gemini first. Agent Chat keeps its long-standing Gemini-first behaviour but now obeys the
same budget, backoff, cooldowns, rollback flag and provenance as everything else. Providers are mocked; no network, no real key.
"""
import contextlib
import io
import json
import logging
import re
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import requests

from kairflow_intel import chat, classify, config as cfgmod, jobs, main
from kairflow_intel.ai_types import AIResult, GeminiPermanent, GeminiTransient, K_AUTH, K_RATE_DAILY, K_SERVER
from kairflow_intel.airouter import settings_from_env
from kairflow_intel.errors import InvalidModelOutput, PermanentError, RpcError, TransientError
from kairflow_intel.gemini import FallbackLLM, GeminiClient
from .helpers import CFG
from .test_ai_router import Clock, FakeOllama, MODEL, Sess, reply
from .test_logic import SETTINGS
from .test_v1 import ChatRpc, FakeLLM, deps

LABEL = {"label": "portfolio_request", "confidence": 0.9, "summary": "Asks for the portfolio"}
PLAN_REPLY = {"action": "reply", "reply": "From Gemini."}
SCHEMA = {"type": "object", "required": ["ok"], "properties": {"ok": {"type": "boolean"}}}


class G:
    """Gemini stand-in with provenance support for generate_json and chat. `sent` records what would leave the machine."""
    def __init__(self, label=None, plan=None, exc=None):
        self.label, self.plan, self.exc, self.sent, self.model = label or LABEL, plan or PLAN_REPLY, exc, [], MODEL
    def generate_json_ex(self, instruction, untrusted, schema, *, fast=False, site="unspecified", timeout=60):
        self.sent.append({"kind": "json", "site": site, "untrusted": untrusted})
        if self.exc: raise self.exc
        data = self.label if "label" in schema.get("properties", {}) else {"ok": True}
        return AIResult(data=data, provider="gemini", model=MODEL, model_reported=MODEL, site=site, finish_reason="STOP", usage={"promptTokens": 3})
    def chat_json_ex(self, system, messages, schema, *, timeout=45, site="chat.plan"):
        self.sent.append({"kind": "chat", "site": site, "messages": messages})
        if self.exc: raise self.exc
        data = {"ok": True} if "ok" in schema.get("properties", {}) else self.plan
        return AIResult(data=data, provider="gemini", model=MODEL, model_reported=MODEL, site=site, finish_reason="STOP")


class O(FakeOllama):
    def __init__(self, label=None, plan=None, exc=None):
        super().__init__(exc=exc); self.label, self.plan, self.sent = label or LABEL, plan or {"action": "reply", "reply": "From Ollama."}, []
    def generate_json(self, instruction, untrusted, schema, **kw):
        self.sent.append({"kind": "json", "untrusted": untrusted, **kw})
        if self.exc: raise self.exc
        return self.label if "label" in schema.get("properties", {}) else {"ok": True}
    def chat_json(self, system, messages, schema, **kw):
        self.sent.append({"kind": "chat", "messages": messages})
        if self.exc: raise self.exc
        return self.plan


def llm_for(g, o, d1="A", policy="", **env):
    e = {"KAIRFLOW_AI_D1": d1, **({"KAIRFLOW_AI_POLICY": policy} if policy else {}), **env}
    return FallbackLLM(g, o, clock=Clock(), settings=settings_from_env(e))


# ---- inbound classification (h_classify) ----------------------------------------------------------------------------------------------
BODY = "Hi, could you send me a link to your portfolio? Thanks, Rina"


def run_classify(model, body=BODY, subject="Portfolio request", fail_log=False):
    calls = []
    msg = {"id": "in1", "prospect_id": None, "from_email": "rina@pixelmoon.com", "subject": subject, "body_text": body, "rfc_message_id": "<in1@x>"}
    def rpc(name, p=None):
        calls.append((name, p or {}))
        if fail_log and name == "intel_agent_log": raise RpcError("log unavailable")
        return {"intel_agent_settings": {**SETTINGS, "autonomy": "shadow"}, "intel_agent_kb": [], "intel_agent_unprocessed_inbound": [msg]}.get(name, {})
    out = jobs.h_classify(jobs.Deps(cfg=CFG, rpc=rpc, fetcher=None, zoho=None, llm=model, clock=lambda: 1_800_000_000.0), {"payload": {}})
    return out, calls


def saved(calls): return [p for n, p in calls if n == "intel_agent_classify_inbound"]
def cls_logs(calls): return [p["p_detail"]["ai"] for n, p in calls if n == "intel_agent_log" and p["p_action"] == "classify_ai_provenance"]


class ClassificationD1A(unittest.TestCase):
    def test_inbound_email_never_reaches_gemini_under_a_even_with_policy_and_default(self):
        for policy in ("classification=gemini_first", "default=gemini_first", "classification.inbound=gemini_first"):
            with self.subTest(policy=policy):
                g, o = G(), O()
                out, calls = run_classify(llm_for(g, o, "A", policy))
                self.assertEqual(out, {"classified": 1})
                self.assertEqual((len(g.sent), len(o.sent)), (0, 1))
                self.assertIn("portfolio", o.sent[0]["untrusted"])
                [ai] = cls_logs(calls)
                self.assertEqual((ai["provider"], ai["site"], ai["fallback_reason"]), ("ollama", "classification.inbound", "d1_private"))
                self.assertEqual(saved(calls)[0]["p_class"], "portfolio_request")

    def test_default_configuration_is_ollama_with_a_policy_reason(self):
        g, o = G(), O()
        _, calls = run_classify(llm_for(g, o))
        self.assertEqual((len(g.sent), len(o.sent)), (0, 1)); self.assertEqual(cls_logs(calls)[0]["fallback_reason"], "policy_ollama")

    def test_fast_flag_is_still_requested_from_ollama(self):
        o = O(); run_classify(llm_for(G(), o)); self.assertTrue(o.sent[0]["fast"])

    def test_plain_client_with_no_router_still_classifies(self):
        class Plain:
            cfg = SimpleNamespace(ollama_model="m", ollama_fast_model="f")
            def generate_json(self, i, u, s, **kw): return LABEL
        out, calls = run_classify(Plain())
        self.assertEqual(out, {"classified": 1}); self.assertEqual(cls_logs(calls)[0]["fallback_reason"], "no_router")


class ClassificationD1C(unittest.TestCase):
    POLICY = "classification=gemini_first"

    def test_gemini_first_and_success_never_calls_ollama(self):
        g, o = G(), O()
        out, calls = run_classify(llm_for(g, o, "C", self.POLICY))
        self.assertEqual(out, {"classified": 1}); self.assertEqual((len(g.sent), len(o.sent)), (1, 0))
        self.assertEqual(g.sent[0]["site"], "classification.inbound")
        [ai] = cls_logs(calls); self.assertEqual((ai["provider"], ai["model"]), ("gemini", MODEL)); self.assertNotIn("fallback_reason", ai)
        self.assertEqual(saved(calls)[0]["p_class"], "portfolio_request")

    def test_every_gemini_failure_causes_exactly_one_ollama_attempt_with_the_same_outcome(self):
        for exc in (GeminiTransient("x", K_SERVER), GeminiTransient("quota", K_RATE_DAILY), GeminiPermanent("bad key", K_AUTH), RuntimeError("bug")):
            with self.subTest(exc=type(exc).__name__):
                g, o = G(exc=exc), O()
                out, calls = run_classify(llm_for(g, o, "C", self.POLICY))
                self.assertEqual((len(g.sent), len(o.sent)), (1, 1))
                [ai] = cls_logs(calls); self.assertEqual(ai["provider"], "ollama"); self.assertTrue(ai["fallback_reason"])
                self.assertEqual((saved(calls)[0]["p_class"], saved(calls)[0]["p_escalate"]), ("portfolio_request", False))

    def test_schema_invalid_gemini_label_is_discarded_and_ollama_decides(self):
        bad = Sess(reply(json.dumps({"label": "make_me_rich", "confidence": 0.99, "summary": "x"})))
        o = O(); model = llm_for(GeminiClient("SECRET", MODEL, bad), o, "C", self.POLICY)
        out, calls = run_classify(model)
        self.assertEqual(len(bad.calls), 1); self.assertEqual(len(o.sent), 1)
        self.assertEqual(saved(calls)[0]["p_class"], "portfolio_request"); self.assertEqual(cls_logs(calls)[0]["fallback_reason"], "schema_invalid")

    def test_truncated_gemini_output_triggers_fallback(self):
        trunc = Sess(reply('{"label": "posi', finish="MAX_TOKENS"))
        o = O(); run_classify(llm_for(GeminiClient("SECRET", MODEL, trunc), o, "C", self.POLICY))
        self.assertEqual(len(o.sent), 1)

    def test_both_providers_down_retries_the_job_and_saves_nothing_final(self):
        """Fix (Phase 5 audit, finding 4): an outage used to save a keyword-guessed class for good. Now the job retries with the message still pending."""
        g, o = G(exc=GeminiTransient("x", K_SERVER)), O(exc=TransientError("ollama down"))
        with self.assertRaises(TransientError):
            run_classify(llm_for(g, o, "C", self.POLICY))
        self.assertEqual((len(g.sent), len(o.sent)), (1, 1))                  # one attempt on each provider, never a loop

    def test_a_badly_shaped_model_answer_still_falls_back_to_keywords(self):
        """Retrying a temperature-0 request that answered badly cannot help, and one such message must not block the ones behind it."""
        g, o = G(exc=GeminiTransient("x", K_SERVER)), O(exc=InvalidModelOutput("model returned invalid JSON: x"))
        out, calls = run_classify(llm_for(g, o, "C", self.POLICY))
        self.assertEqual(out, {"classified": 1}); self.assertEqual(saved(calls)[0]["p_class"], "portfolio_request")   # from the deterministic keyword rule
        self.assertEqual(cls_logs(calls), [])                                                                          # no model produced it, so nothing is attributed

    def test_rollback_flag_forces_ollama(self):
        g, o = G(), O(); _, calls = run_classify(llm_for(g, o, "C", self.POLICY, KAIRFLOW_AI_FORCE_OLLAMA="1"))
        self.assertEqual((len(g.sent), len(o.sent)), (0, 1)); self.assertEqual(cls_logs(calls)[0]["fallback_reason"], "forced_ollama")

    def test_japanese_email_uses_the_same_site_and_schema(self):
        g, o = G(), O()
        run_classify(llm_for(g, o, "C", self.POLICY), body="ポートフォリオを送っていただけますか。よろしくお願いします。", subject="ポートフォリオのお願い")
        self.assertEqual((g.sent[0]["site"], len(o.sent)), ("classification.inbound", 0)); self.assertIn("ポートフォリオ", g.sent[0]["untrusted"])


class ClassificationSafety(unittest.TestCase):
    def test_hard_rules_beat_the_model_and_no_model_is_called(self):
        for body, want in (("Please unsubscribe me from this list.", "unsubscribe"), ("I will take legal action over this.", "complaint")):
            with self.subTest(want=want):
                g, o = G(), O(); out, calls = run_classify(llm_for(g, o, "C", "classification=gemini_first"), body=body, subject="Re: hi")
                self.assertEqual((len(g.sent), len(o.sent)), (0, 0)); self.assertEqual(saved(calls)[0]["p_class"], want); self.assertEqual(cls_logs(calls), [])

    def test_model_cannot_override_confidence_floor_or_label_set(self):
        low = {"label": "positive", "confidence": 0.3, "summary": "maybe"}
        _, calls = run_classify(llm_for(G(label=low), O(), "C", "classification=gemini_first"))
        self.assertEqual(saved(calls)[0]["p_class"], "ambiguous")

    def test_classification_is_saved_even_if_the_provenance_log_fails(self):
        _, calls = run_classify(llm_for(G(), O(), "C", "classification=gemini_first"), fail_log=True)
        self.assertEqual(len(saved(calls)), 1)

    def test_provenance_holds_no_email_text_or_secret(self):
        g = G(); _, calls = run_classify(llm_for(g, O(), "C", "classification=gemini_first"))
        blob = json.dumps([p for n, p in calls if n == "intel_agent_log"])
        for forbidden in ("Rina", "portfolio?", "SECRET", "Thanks"): self.assertNotIn(forbidden, blob)

    def test_each_message_gets_its_own_provenance(self):
        msgs = [{"id": f"in{i}", "prospect_id": None, "from_email": "a@b.co", "subject": "s", "body_text": b, "rfc_message_id": f"<{i}>"}
                for i, b in enumerate(("Could you send your portfolio link?", "Please unsubscribe me.", "Could you send your portfolio link again?"))]
        calls = []
        def rpc(name, p=None):
            calls.append((name, p or {}))
            return {"intel_agent_settings": {**SETTINGS, "autonomy": "shadow"}, "intel_agent_kb": [], "intel_agent_unprocessed_inbound": msgs}.get(name, {})
        jobs.h_classify(jobs.Deps(cfg=CFG, rpc=rpc, fetcher=None, zoho=None, llm=llm_for(G(), O(), "C", "classification=gemini_first")), {"payload": {}})
        logged = [p["p_entity_id"] for n, p in calls if n == "intel_agent_log" and p["p_action"] == "classify_ai_provenance"]
        self.assertEqual(logged, ["in0", "in2"])                                  # the unsubscribe was decided by a rule: no model, no attribution


# ---- Agent Chat -----------------------------------------------------------------------------------------------------------------------
class AgentChatRouting(unittest.TestCase):
    def test_gemini_first_is_available_when_d1_c_explicitly_allows_chat(self):
        g, o = G(), O(); m = llm_for(g, o, "C", "chat=gemini_first")
        self.assertEqual(m.chat_json("sys", [{"role": "user", "content": "hi"}], chat.PLAN_SCHEMA), PLAN_REPLY)
        self.assertEqual((len(g.sent), len(o.sent), m.last_backend), (1, 0, "gemini")); self.assertEqual(g.sent[0]["site"], "chat.plan")
        self.assertEqual(m.last_chat, {"provider": "gemini", "model": MODEL, "route_reason": None})

    def test_default_d1_a_keeps_chat_local_even_when_chat_defaults_to_gemini_first(self):
        g, o = G(), O(); m = FallbackLLM(g, o, clock=Clock(), settings=settings_from_env({}))
        m.chat_json("s", [], chat.PLAN_SCHEMA); self.assertEqual((len(g.sent), len(o.sent)), (0, 1))
        self.assertEqual(m.last_chat["route_reason"], "d1_private")

    def test_per_call_provenance_when_d1_c_allows_chat(self):
        g, o = G(), O(); m = llm_for(g, o, "C", "chat=gemini_first")
        res = m.chat_json_ex("chat.plan", "s", [], chat.PLAN_SCHEMA)
        self.assertEqual((res.provider, res.model, res.site, res.gemini_attempted, res.route_reason), ("gemini", MODEL, "chat.plan", True, None))

    def test_each_failure_kind_causes_exactly_one_ollama_attempt(self):
        for exc in (GeminiTransient("x", K_SERVER), GeminiPermanent("bad key", K_AUTH), TransientError("plain"), RuntimeError("bug")):
            with self.subTest(exc=type(exc).__name__):
                g, o = G(exc=exc), O(); m = llm_for(g, o, "C", "chat=gemini_first")
                self.assertEqual(m.chat_json("s", [], chat.PLAN_SCHEMA)["reply"], "From Ollama.")
                self.assertEqual((len(g.sent), len(o.sent), m.last_backend), (1, 1, "ollama"))

    def test_both_failing_propagates_ollamas_error_once(self):
        g, o = G(exc=GeminiTransient("x", K_SERVER)), O(exc=TransientError("ollama down"))
        with self.assertRaises(TransientError): llm_for(g, o, "C", "chat=gemini_first").chat_json("s", [], chat.PLAN_SCHEMA)
        self.assertEqual((len(g.sent), len(o.sent)), (1, 1))

    def test_policy_and_rollback_flag_send_chat_to_ollama(self):
        for kw in ({"policy": "chat=ollama"}, {"KAIRFLOW_AI_FORCE_OLLAMA": "1"}, {"policy": "chat.plan=ollama"}):
            with self.subTest(kw=kw):
                g, o = G(), O(); m = llm_for(g, o, **kw); m.chat_json("s", [], chat.PLAN_SCHEMA)
                self.assertEqual((len(g.sent), len(o.sent), m.last_backend), (0, 1, "ollama"))

    def test_daily_exhaustion_seen_by_another_site_makes_chat_skip_gemini(self):
        g, o = G(exc=GeminiTransient("quota", K_RATE_DAILY)), O(); m = llm_for(g, o, "C", "chat=gemini_first")
        m.generate_json_ex("discovery.news", "i", "u", SCHEMA)                    # opens the shared daily cooldown
        m.chat_json("s", [], chat.PLAN_SCHEMA)
        self.assertEqual(len(g.sent), 1)                                          # chat did not pay a second Gemini attempt
        self.assertEqual(m.last_chat["route_reason"], "gemini_cooldown_daily")

    def test_chat_failure_cooldown_is_shared_with_the_structured_sites(self):
        g, o = G(exc=GeminiPermanent("bad key", K_AUTH)), O(); m = llm_for(g, o, "C", "chat=gemini_first")
        m.chat_json("s", [], chat.PLAN_SCHEMA); m.generate_json_ex("discovery.news", "i", "u", SCHEMA)
        self.assertEqual(len(g.sent), 1)

    def test_chat_counts_against_the_free_tier_budget(self):
        g, o = G(), O(); m = llm_for(g, o, "C", "chat=gemini_first", KAIRFLOW_GEMINI_RPM="2")
        for _ in range(3): m.chat_json("s", [], chat.PLAN_SCHEMA)
        self.assertEqual((len(g.sent), len(o.sent), m.last_chat["route_reason"]), (2, 1, "budget_minute"))

    def test_chat_is_private_under_d1_a_but_can_use_gemini_under_d1_c(self):
        g, o = G(), O(); llm_for(g, o, "A").chat_json("s", [], chat.PLAN_SCHEMA); self.assertEqual((len(g.sent), len(o.sent)), (0, 1))
        g, o = G(), O(); llm_for(g, o, "C", "chat=gemini_first").chat_json("s", [], chat.PLAN_SCHEMA); self.assertEqual((len(g.sent), len(o.sent)), (1, 0))

    def test_primary_without_chat_provenance_support_is_still_usable(self):
        class Old:
            model = "gemini-x"
            def chat_json(self, system, messages, schema, **kw): return PLAN_REPLY
        m = FallbackLLM(Old(), O(), clock=Clock(), settings=settings_from_env({"KAIRFLOW_AI_D1": "C", "KAIRFLOW_AI_POLICY": "chat=gemini_first"})); res = m.chat_json_ex("chat.plan", "s", [], chat.PLAN_SCHEMA)
        self.assertEqual((res.provider, res.model), ("gemini", "gemini-x"))

    def test_no_gemini_key_means_ollama(self):
        o = O(); m = FallbackLLM(None, o, clock=Clock(), settings=settings_from_env({"KAIRFLOW_AI_D1": "C", "KAIRFLOW_AI_POLICY": "chat=gemini_first"})); m.chat_json("s", [], chat.PLAN_SCHEMA)
        self.assertEqual((len(o.sent), m.last_backend, m.last_chat["route_reason"]), (1, "ollama", "no_gemini"))


class AgentChatGeminiRequest(unittest.TestCase):
    def _post(self, model, **kw):
        s = Sess(reply(json.dumps({"action": "reply", "reply": "x"})))
        GeminiClient("SECRET", model, s, **kw).chat_json("sys", [{"role": "user", "content": "a"}], chat.PLAN_SCHEMA)
        return s.calls[0]

    def test_gemini_3_request_has_low_thinking_and_a_larger_budget_never_minimal(self):
        url, kw = self._post(MODEL); g = kw["json"]["generationConfig"]
        self.assertEqual(g, {"responseMimeType": "application/json", "maxOutputTokens": 2048, "thinkingConfig": {"thinkingLevel": "low"}})
        self.assertTrue(url.endswith(f"/models/{MODEL}:generateContent")); self.assertNotIn("SECRET", url); self.assertEqual(kw["headers"]["x-goog-api-key"], "SECRET")
        self.assertNotIn("minimal", json.dumps(g)); self.assertNotIn("responseSchema", json.dumps(kw["json"]))

    def test_thinking_off_is_rejected_instead_of_silently_using_the_model_default(self):
        with self.assertRaises(ValueError): GeminiClient("SECRET", MODEL, Sess(reply("{}")), thinking="off")

    def test_truncated_plan_is_discarded_and_raised_as_transient(self):
        with self.assertRaises(TransientError) as cm:
            GeminiClient("SECRET", MODEL, Sess(reply('{"action": "rep', finish="MAX_TOKENS"))).chat_json("s", [], chat.PLAN_SCHEMA)
        self.assertNotIn("SECRET", str(cm.exception))

    def test_daily_quota_is_told_apart_from_the_minute_limit_for_chat_too(self):
        from .test_ai_router import quota
        for metric, kind in (("GenerateRequestsPerDayPerProjectPerModel-FreeTier", "rate_limit_daily"), ("GenerateRequestsPerMinutePerProjectPerModel-FreeTier", "rate_limit_minute")):
            with self.assertRaises(GeminiTransient) as cm:
                GeminiClient("k", MODEL, Sess(requests_resp(429, quota(metric)))).chat_json("s", [], chat.PLAN_SCHEMA)
            self.assertEqual(cm.exception.kind, kind)

    def test_connection_error_never_leaks_the_key(self):
        with self.assertRaises(TransientError) as cm:
            GeminiClient("SECRET", MODEL, Sess(requests.ConnectionError("https://x?key=SECRET"))).chat_json("s", [], chat.PLAN_SCHEMA)
        self.assertNotIn("SECRET", str(cm.exception))


def requests_resp(status, body):
    from .helpers import Resp
    return Resp(status, body, {"Content-Type": "application/json"})


class AgentChatEndToEnd(unittest.TestCase):
    """chat.handle is unchanged; only the planner call's route changed. Safety (allowlist, untrusted tool results) is still enforced."""

    def test_forbidden_tool_from_gemini_is_never_executed(self):
        g = G(plan={"action": "tool", "tool": "send_email", "args": {"to": "x@y.z"}}); rpc = ChatRpc()
        out = chat.handle(deps(rpc, llm_for(g, O())), {"thread_id": "t", "message_id": 1})
        self.assertEqual(rpc.tools_called(), []); self.assertTrue(out["replied"])

    def test_gemini_down_chat_is_answered_by_ollama(self):
        g, o = G(exc=GeminiTransient("x", K_SERVER)), O(plan={"action": "reply", "reply": "Local answer."}); rpc = ChatRpc()
        out = chat.handle(deps(rpc, llm_for(g, o)), {"thread_id": "t", "message_id": 1})
        self.assertEqual(out, {"replied": True, "tools": []}); self.assertEqual(rpc.replies[0]["p_text"], "Local answer.")

    def test_both_down_uses_the_existing_deterministic_fallback(self):
        g, o = G(exc=GeminiTransient("x", K_SERVER)), O(exc=TransientError("down")); rpc = ChatRpc()
        out = chat.handle(deps(rpc, llm_for(g, o, "C", "chat=gemini_first")), {"thread_id": "t", "message_id": 1})
        self.assertTrue(out.get("unparsed") or out.get("fallback")); self.assertEqual(len(rpc.replies), 1)

    def test_tool_result_goes_back_to_the_planner_inside_untrusted_tags(self):
        g = G(plan={"action": "tool", "tool": "stats", "args": {"days": 7}}); rpc = ChatRpc()
        class Seq(G):
            def chat_json_ex(self, system, messages, schema, **kw):
                res = super().chat_json_ex(system, messages, schema, **kw)
                if len(self.sent) > 1: return AIResult(data=PLAN_REPLY, provider="gemini", model=MODEL, site="chat.plan")
                return res
        sg = Seq(plan={"action": "tool", "tool": "stats", "args": {"days": 7}})
        chat.handle(deps(rpc, llm_for(sg, O(), "C", "chat=gemini_first")), {"thread_id": "t", "message_id": 1})
        self.assertEqual(rpc.tools_called(), ["stats"]); self.assertIn("<untrusted>", json.dumps(sg.sent[1]["messages"]))

    def test_heartbeat_reports_provider_and_model_without_secrets(self):
        m = llm_for(G(), O(), "C", "chat=gemini_first"); m.chat_json("s", [], chat.PLAN_SCHEMA)
        beats = []
        w = jobs.Worker(jobs.Deps(cfg=CFG, rpc=lambda n, p=None: beats.append((n, p)) or {}, fetcher=None, zoho=None, llm=m), lease_thread=False)
        w._heartbeat(); info = [p for n, p in beats if n == "intel_agent_heartbeat"][0]["p_info"]
        self.assertEqual((info["chat_llm"], info["chat_model"]), ("gemini", MODEL))


# ---- health checks (selftest) ---------------------------------------------------------------------------------------------------------
def run_selftest(model, what="gemini", key="SECRET", **cfg_kw):
    cfg = SimpleNamespace(gemini_api_key=key, gemini_model=MODEL, ollama_model="m", ollama_fast_model="f", mail_provider="none", **cfg_kw)
    deps_ = SimpleNamespace(llm=model)
    buf = io.StringIO()
    with patch.object(main, "build", return_value=(None, deps_)), contextlib.redirect_stdout(buf):
        rc = main.selftest(cfg, what)
    return rc, buf.getvalue()


class HealthChecks(unittest.TestCase):
    def test_pass_means_gemini_actually_served_both_checks(self):
        g, o = G(), O(); rc, out = run_selftest(llm_for(g, o))
        self.assertEqual(rc, 0); self.assertEqual(out.count("PASS "), 2); self.assertEqual(len(o.sent), 0)
        self.assertEqual([x["site"] for x in g.sent], ["health.chat", "health.gemini"])
        self.assertIn("finish=STOP", out); self.assertIn(MODEL, out); self.assertNotIn("SECRET", out)

    def test_health_checks_send_nothing_but_the_probe_text(self):
        g = G(); run_selftest(llm_for(g, O()))
        self.assertEqual(g.sent[1]["untrusted"], "health check only"); self.assertEqual(g.sent[0]["messages"], [{"role": "user", "content": "health check only"}])

    def test_gemini_failure_is_reported_as_fail_with_the_reason_not_hidden_by_the_fallback(self):
        g, o = G(exc=GeminiTransient("x", K_SERVER)), O(); rc, out = run_selftest(llm_for(g, o))
        self.assertEqual(rc, 1); self.assertIn("FAIL Gemini Agent Chat planning (router)", out); self.assertIn("served by Ollama instead; reason=server_error", out)

    def test_permanent_error_is_reported(self):
        rc, out = run_selftest(llm_for(G(exc=GeminiPermanent("bad key", K_AUTH)), O())); self.assertEqual(rc, 1); self.assertIn("reason=auth", out)

    def test_rollback_flag_is_a_skip_not_a_false_pass_or_a_failure(self):
        g, o = G(), O(); rc, out = run_selftest(llm_for(g, o, KAIRFLOW_AI_FORCE_OLLAMA="1"))
        self.assertEqual(rc, 0); self.assertEqual(len(g.sent), 0); self.assertNotIn("PASS ", out); self.assertEqual(out.count("SKIP "), 2); self.assertIn("forced_ollama=True", out)

    def test_no_key_is_a_skip(self):
        rc, out = run_selftest(llm_for(None, O()), key=""); self.assertEqual(rc, 0); self.assertIn("SKIP gemini", out)

    def test_ollama_check_is_pinned_to_ollama_even_with_default_gemini_first(self):
        g, o = G(), O()
        cfg = SimpleNamespace(gemini_api_key="", gemini_model=MODEL, ollama_model="m", ollama_fast_model="f", mail_provider="none")
        class Llm(FallbackLLM):
            def list_models(self): return ["m", "f"]
        model = Llm(g, o, clock=Clock(), settings=settings_from_env({"KAIRFLOW_AI_POLICY": "default=gemini_first", "KAIRFLOW_AI_D1": "C"}))
        buf = io.StringIO()
        with patch.object(main, "build", return_value=(None, SimpleNamespace(llm=model))), contextlib.redirect_stdout(buf):
            rc = main.selftest(cfg, "ollama")
        self.assertEqual(rc, 0); self.assertEqual((len(g.sent), len(o.sent)), (0, 2))

    def test_routing_report_shows_where_each_site_goes_and_why(self):
        _, out = run_selftest(llm_for(G(), O(), "A", "classification=gemini_first,drafting=gemini_first"))
        self.assertIn("INFO routing: d1=A", out)
        self.assertIn("classification.inbound -> ollama (d1_private)", out); self.assertIn("drafting.reply -> ollama (d1_private)", out)
        self.assertIn("discovery.news -> gemini, then ollama", out); self.assertIn("research.entity -> gemini, then ollama", out); self.assertIn("chat.plan -> ollama (d1_private)", out)

    def test_routing_report_under_rollback_flag(self):
        _, out = run_selftest(llm_for(G(), O(), KAIRFLOW_AI_FORCE_OLLAMA="1")); self.assertIn("chat.plan -> ollama (forced_ollama)", out)

    def test_every_routed_site_in_the_report_exists_in_the_code(self):
        src = "".join(p.read_text(encoding="utf-8") for p in Path(main.__file__).parent.glob("*.py") if p.name != "main.py")
        for site in main.ROUTED_SITES:
            if site != "chat.plan": self.assertIn(f'"{site}"', src, site)


# ---- pinned model ---------------------------------------------------------------------------------------------------------------------
ENV = {"KAIRFLOW_SUPABASE_URL": "https://x.supabase.co", "KAIRFLOW_SUPABASE_ANON_KEY": "a", "KAIRFLOW_AGENT_EMAIL": "w@x.com",
       "KAIRFLOW_AGENT_PASSWORD": "p", "KAIRFLOW_OLLAMA_URL": "http://127.0.0.1:11434"}


class PinnedModel(unittest.TestCase):
    def test_default_is_the_pinned_3_8_model_everywhere(self):
        cfg = cfgmod.load(dict(ENV)); self.assertEqual((cfg.gemini_model, cfg.ai_router.model), ("gemini-3.8-flash", "gemini-3.8-flash"))
        self.assertEqual(cfgmod.Config.__dataclass_fields__["gemini_model"].default, "gemini-3.8-flash")
        from kairflow_intel import gemini; self.assertEqual(gemini.DEFAULT_MODEL, "gemini-3.8-flash")

    def test_no_source_default_still_names_the_old_model(self):
        for p in Path(cfgmod.__file__).parent.glob("*.py"):
            for ln in p.read_text(encoding="utf-8").splitlines():
                if "2.5-flash" in ln: self.assertTrue(ln.strip().startswith("#") or "legacy" in ln or "older family" in ln or "retired" in ln or "(KAIRFLOW_GEMINI_MODEL=" in ln, f"{p.name}: {ln}")

    def test_floating_aliases_and_junk_are_rejected(self):
        for bad in ("gemini-flash-latest", "gemini-latest", "gpt-4", "gemini 3", "gemini-"):
            with self.subTest(bad=bad), self.assertRaises(cfgmod.ConfigError): cfgmod.load(dict(ENV, KAIRFLOW_GEMINI_MODEL=bad))

    def test_an_explicit_exact_id_is_honoured_never_silently_replaced(self):
        self.assertEqual(cfgmod.load(dict(ENV, KAIRFLOW_GEMINI_MODEL="gemini-2.5-flash")).gemini_model, "gemini-2.5-flash")

    def test_build_hands_the_pinned_model_to_the_client(self):
        from kairflow_intel.airouter import RouterSettings
        cfg = SimpleNamespace(supabase_url="https://x.supabase.co", supabase_anon_key="a", agent_email="w@x.com", agent_password="p", worker_id="w",
                              ollama_url="http://127.0.0.1:11434", ollama_model="m", ollama_fast_model="f", gemini_api_key="SECRET", gemini_model="",
                              mail_provider="none", mail_account_id="", user_agent="ua", fetch_timeout=5, max_fetch_bytes=1000, per_host_delay=0.0, ai_router=RouterSettings())
        _, d = main.build(cfg); self.assertEqual((d.llm.primary.model, d.llm.primary.json_model), ("gemini-3.8-flash", "gemini-3.8-flash"))


# ---- secrecy and the unchanged guarantees ---------------------------------------------------------------------------------------------
class Secrecy(unittest.TestCase):
    def test_no_key_in_logs_for_chat_classification_or_selftest(self):
        with self.assertLogs("kairflow_intel", level="DEBUG") as cm:
            sess = Sess(requests.ConnectionError("https://x?key=SECRET"))
            m = llm_for(GeminiClient("SECRET", MODEL, sess), O(), "C", "classification=gemini_first")
            m.chat_json("s", [], chat.PLAN_SCHEMA); run_classify(m)
            logging.getLogger("kairflow_intel.airouter").info("anchor")
        self.assertNotIn("SECRET", "\n".join(cm.output))

    def test_status_is_secret_free(self):
        self.assertNotIn("SECRET", json.dumps(llm_for(GeminiClient("SECRET", MODEL), O()).ai_status()))


class UnchangedGuarantees(unittest.TestCase):
    def test_classification_changes_no_send_or_draft_boundary(self):
        # The classifier only writes a label. It never enqueues a send, never approves anything, and never touches autonomy or the kill switch.
        _, calls = run_classify(llm_for(G(), O(), "C", "classification=gemini_first"))
        forbidden = {"intel_agent_enqueue", "intel_agent_set_autonomy", "intel_agent_set_kill_switch", "intel_agent_upsert_draft"}
        self.assertFalse(forbidden & {n for n, _ in calls})
        self.assertEqual({n for n, _ in calls} - {"intel_agent_settings", "intel_agent_kb", "intel_agent_unprocessed_inbound", "intel_agent_classify_inbound",
                                                  "intel_agent_log"}, set())

    def test_classify_schema_and_labels_are_unchanged(self):
        self.assertEqual(classify.SCHEMA["required"], ["label", "confidence", "summary"]); self.assertIn("portfolio_request", classify.LABELS)

    def test_plain_ollama_client_still_works_as_a_chat_and_json_backend(self):
        self.assertTrue(callable(FallbackLLM(None, O(), clock=Clock()).generate_json))


if __name__ == "__main__":
    unittest.main()
