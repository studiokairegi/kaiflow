"""Phase 5: drafting, replies and follow-ups go through the AI router (decision D1).

D1 = A (default): the drafting group reads private correspondence, so it stays on local Ollama even if the policy says gemini_first.
D1 = C: the same call sites may go to Gemini first (unredacted); everything else about drafting is unchanged.
Under both, the same schema and the same deterministic validators decide what becomes a draft, and every draft stays pending approval.
"""
import json
import unittest
from types import SimpleNamespace

from kairflow_intel import ai_call, drafting, jobs, takeover
from kairflow_intel.ai_types import AIResult, GeminiPermanent, GeminiTransient, K_AUTH, K_SERVER
from kairflow_intel.airouter import settings_from_env
from kairflow_intel.errors import PermanentError, RpcError, TransientError
from kairflow_intel.gemini import FallbackLLM
from .helpers import CFG
from .test_ai_router import Clock, FakeOllama, MODEL
from .test_logic import EV, KB as LOGIC_KB, P, SETTINGS
from . import test_takeover as tk

GROUNDED = "The hand-drawn 2D adventure and cinematic trailer seem like a distinctive direction. We make 2D character animation and trailers for indie games."
COMPOSE = {"subject": "A thought on Pixel Moon's hand-drawn adventure", "body": GROUNDED, "evidence_ids": ["e0"]}
REPLY = {"subject": "Re: Portfolio request", "body": "Portfolio link: https://studio.test/portfolio", "evidence_ids": ["in1", "e0"]}
LABEL = {"label": "portfolio_request", "confidence": 0.9, "summary": "Asks for the portfolio"}


def pick(answers):
    def f(schema, untrusted):
        props = schema.get("properties", {})
        key = "compose" if "evidence_ids" in props else "paragraph" if "paragraph" in props else "analysis" if "intent" in props else "label"
        out = answers[key]
        if callable(out):
            out = out(json.loads(untrusted))
        if isinstance(out, Exception):
            raise out
        return out
    return f


class G:
    """Gemini stand-in: records what would be sent to Google."""
    def __init__(self, answers=None, exc=None): self.answer, self.exc, self.sent = pick(answers or {}), exc, []
    def generate_json_ex(self, instruction, untrusted, schema, *, fast=False, site="unspecified", timeout=60):
        self.sent.append({"site": site, "instruction": instruction, "untrusted": untrusted})
        if self.exc: raise self.exc
        return AIResult(data=self.answer(schema, untrusted), provider="gemini", model=MODEL, model_reported=MODEL, site=site, finish_reason="STOP")
    def chat_json(self, *a, **k): return {"action": "reply", "reply": "g"}


class O(FakeOllama):
    def __init__(self, answers=None, exc=None): super().__init__(exc=exc); self.answer, self.sent = pick(answers or {}), []
    def generate_json(self, instruction, untrusted, schema, **kw):
        self.sent.append({"instruction": instruction, "untrusted": untrusted, **kw})
        if self.exc: raise self.exc
        return self.answer(schema, untrusted)


def router(g, o, d1="A", policy="drafting=gemini_first", **env):
    e = {"KAIRFLOW_AI_D1": d1, "KAIRFLOW_AI_POLICY": policy, **env}
    return FallbackLLM(g, o, clock=Clock(), settings=settings_from_env(e))


def ai_logs(calls):
    return [a["p_detail"] for n, a in calls if n == "intel_agent_log" and a["p_action"] == "draft_ai_provenance"]


def names(calls):
    return [n for n, _ in calls]


# ---- h_draft (initial) ----------------------------------------------------------------------------------------------------------------
KB_LIST = [{"key": k, "body": v["body"]} for k, v in LOGIC_KB.items()]


def run_initial(model, *, rpc_fail_log=False, ev=None):
    calls = []
    ctx = {"prospect": {**P, "status": "lead_linked", "contact_email": "rina@pixelmoon.com"}, "evidence": EV if ev is None else ev, "lead": {}, "messages": []}
    st = {**SETTINGS, "autonomy": "shadow"}
    def rpc(name, p=None):
        calls.append((name, p or {}))
        if rpc_fail_log and name == "intel_agent_log" and p.get("p_action") == "draft_ai_provenance":
            raise RpcError("log unavailable")
        return {"intel_agent_context": ctx, "intel_agent_settings": st, "intel_agent_kb": KB_LIST, "intel_agent_recent_outbound": [],
                "intel_agent_upsert_draft": {"ok": True, "message_id": "m1", "state": "pending_approval", "created": True}}.get(name, {})
    out = jobs.h_draft(jobs.Deps(cfg=CFG, rpc=rpc, fetcher=None, zoho=None, llm=model, clock=lambda: 1_800_000_000.0), {"payload": {"prospect_id": "p1", "kind": "initial"}})
    return out, calls


class DecisionD1A(unittest.TestCase):
    """Default: private correspondence never goes to Google, whatever the policy says."""

    def test_initial_draft_stays_on_ollama_even_when_policy_says_gemini_first(self):
        g, o = G({"compose": COMPOSE}), O({"compose": COMPOSE})
        out, calls = run_initial(router(g, o, "A"))
        self.assertTrue(out["ok"])
        self.assertEqual((len(g.sent), len(o.sent)), (0, 1))
        [log] = ai_logs(calls)
        self.assertEqual((log["ai"]["provider"], log["ai"]["site"], log["ai"]["fallback_reason"]), ("ollama", "drafting.initial", "d1_private"))

    def test_reply_draft_and_classification_stay_on_ollama(self):
        g, o = G({"compose": REPLY, "label": LABEL}), O({"compose": REPLY, "label": LABEL})
        out, calls, _ = run_reply(router(g, o, "A"))
        self.assertEqual(out, {"classified": 1})
        self.assertEqual(len(g.sent), 0)
        self.assertEqual(ai_logs(calls)[0]["ai"]["fallback_reason"], "d1_private")

    def test_takeover_followup_reply_and_analysis_stay_on_ollama(self):
        for entries, last, paragraph in ((([tk.OUT1]), "2026-10-05", None),
                                         ([tk.OUT1, tk.entry("inbound", "Sounds good, tell me more about your reel.", "2026-10-06")], "2026-10-06",
                                          "Thank you for your reply about the reel, we are glad Pixel Moon is interested.")):
            with self.subTest(last=last):
                def compose_takeover(payload):
                    if payload["message_kind"] == "reply":
                        inbound_ids = [e["id"] for e in payload["verified_evidence"] if e["fact_type"] == "actual_incoming_message"]
                        return {"subject": "Re: 2D animation for Pixel Moon",
                                "body": "Hello Hana Sato,\n\nHere are details of our reel and portfolio: https://kairegi.com/reel.",
                                "evidence_ids": inbound_ids + ["e0"]}
                    return COMPOSE
                answers = {"analysis": {"summary": "They are interested." if paragraph else "No reply yet.", "intent": "interested" if paragraph else "no_response", "open_questions": [], "language": "en"},
                           "compose": compose_takeover}
                g, o = G(answers), O(answers)
                takeover_ctx = tk.ctx(entries, last_contact=last)
                takeover_ctx["evidence"] = EV
                out, rpc = run_takeover(takeover_ctx, router(g, o, "A"))
                self.assertIn(out["next_action"], ("follow_up", "reply"))
                self.assertEqual(len(g.sent), 0)
                [log] = ai_logs(rpc.calls)
                self.assertEqual(log["ai"]["provider"], "ollama")
                self.assertEqual(log["analysis_ai"]["site"], "drafting.takeover_analysis")
                self.assertEqual(log["ai"]["site"], "drafting.takeover_reply" if paragraph else "drafting.takeover_followup")

    def test_d1_b_is_still_rejected_and_never_treated_as_c(self):
        with self.assertRaises(ValueError):
            settings_from_env({"KAIRFLOW_AI_D1": "B"})


class DecisionD1C(unittest.TestCase):
    """Owner accepted Google's free-tier terms for private correspondence: same call sites, Gemini first."""

    def test_initial_draft_goes_to_gemini_first_and_success_never_calls_ollama(self):
        g, o = G({"compose": COMPOSE}), O({"compose": COMPOSE})
        out, calls = run_initial(router(g, o, "C"))
        self.assertEqual((out["ok"], out["state"]), (True, "pending_approval"))
        self.assertEqual((len(g.sent), len(o.sent)), (1, 0))
        [log] = ai_logs(calls)
        self.assertEqual((log["ai"]["provider"], log["ai"]["model"], log["ai"]["site"]), ("gemini", MODEL, "drafting.initial"))
        self.assertNotIn("fallback_reason", log["ai"])

    def test_draft_stays_a_draft_and_no_send_job_is_queued(self):
        g, o = G({"compose": COMPOSE}), O({"compose": COMPOSE})
        _, calls = run_initial(router(g, o, "C"))
        [up] = [a for n, a in calls if n == "intel_agent_upsert_draft"]
        self.assertFalse(up["p_auto_ok"])
        self.assertFalse(any(n == "intel_agent_enqueue_job" and a["p_kind"] == "send" for n, a in calls))
        self.assertFalse(any(n in ("intel_agent_send", "intel_agent_reserve_send") for n, _ in calls))

    def test_gemini_failure_causes_exactly_one_ollama_attempt_and_is_recorded(self):
        for exc in (GeminiTransient("x", K_SERVER), GeminiPermanent("x", K_AUTH)):
            with self.subTest(exc=type(exc).__name__):
                g, o = G({"compose": COMPOSE}, exc=exc), O({"compose": COMPOSE})
                out, calls = run_initial(router(g, o, "C"))
                self.assertTrue(out["ok"])
                self.assertEqual((len(g.sent), len(o.sent)), (1, 1))
                [log] = ai_logs(calls)
                self.assertEqual(log["ai"]["provider"], "ollama")
                self.assertTrue(log["ai"]["fallback_reason"])

    def test_both_providers_down_retries_the_job_and_flags_nobody(self):
        g, o = G(exc=GeminiTransient("x", K_SERVER)), O(exc=TransientError("ollama down"))
        calls = []
        with self.assertRaises(TransientError):
            run_initial(router(g, o, "C"))
        self.assertEqual((len(g.sent), len(o.sent)), (1, 1))

    def test_rollback_flag_sends_drafting_back_to_ollama(self):
        g, o = G({"compose": COMPOSE}), O({"compose": COMPOSE})
        _, calls = run_initial(router(g, o, "C", KAIRFLOW_AI_FORCE_OLLAMA="1"))
        self.assertEqual((len(g.sent), len(o.sent)), (0, 1))
        self.assertEqual(ai_logs(calls)[0]["ai"]["fallback_reason"], "forced_ollama")

    def test_same_validators_whichever_provider_wrote_the_text(self):
        """A draft refused by the validators never becomes a draft. Gemini's refusal now gets one Ollama retry first (see test_phase5_audit_fixes);
        here Ollama is no better, so both paths still end at a person."""
        bad = {"subject": "A thought on Pixel Moon", "body": "The hand-drawn 2D adventure and cinematic trailer seem like a distinctive direction. Pixel Moon is hiring animators.", "evidence_ids": ["e0"]}
        outcomes = {}
        for label, (g, o) in {"gemini": (G({"compose": bad}), O({"compose": bad})),
                              "ollama_fallback": (G(exc=GeminiTransient("x", K_SERVER)), O({"compose": bad}))}.items():
            out, calls = run_initial(router(g, o, "C"))
            outcomes[label] = (out, [n for n, _ in calls if n in ("intel_agent_upsert_draft", "intel_agent_flag_prospect")], ai_logs(calls))
        for label, (out, rpcs, logs) in outcomes.items():
            with self.subTest(provider=label):
                self.assertEqual(out, {"skipped": "manual_review_required"})
                self.assertEqual(rpcs, ["intel_agent_flag_prospect"])      # no draft stored; a person is asked to look
                self.assertEqual(logs, [])                                   # no provenance for a draft that was never written

    def test_ungrounded_evidence_ids_are_rejected_for_both_providers(self):
        bad = {**COMPOSE, "evidence_ids": ["made-up-id"]}
        for g, o in ((G({"compose": bad}), O({})), (G(exc=GeminiTransient("x", K_SERVER)), O({"compose": bad}))):
            out, calls = run_initial(router(g, o, "C"))
            self.assertEqual(out, {"skipped": "manual_review_required"})
            self.assertNotIn("intel_agent_upsert_draft", names(calls))

    def test_reply_draft_goes_to_gemini_but_classification_is_still_ollama_until_phase_6(self):
        g, o = G({"compose": REPLY}), O({"label": LABEL})
        out, calls, up = run_reply(router(g, o, "C"))
        self.assertEqual(out, {"classified": 1})
        self.assertEqual([s["site"] for s in g.sent], ["drafting.reply"])
        self.assertEqual(len(o.sent), 1)                                   # the classifier call (fast=True, untagged)
        self.assertTrue(o.sent[0].get("fast"))
        self.assertFalse(up[0]["p_auto_ok"])                               # model-written replies are always human-approved
        self.assertEqual(ai_logs(calls)[0]["ai"]["provider"], "gemini")
        self.assertEqual(ai_logs(calls)[0]["inbound_message_id"], "in1")
        self.assertFalse(any(n == "intel_agent_enqueue_job" and a["p_kind"] == "send" for n, a in calls))

    def test_takeover_goes_to_gemini_first_and_falls_back_per_call(self):
        answers = {"analysis": {"summary": "No reply yet.", "intent": "no_response", "open_questions": [], "language": "en"},
                   "compose": COMPOSE}
        g, o = G(answers), O(answers)
        takeover_ctx = tk.ctx([tk.OUT1])
        takeover_ctx["evidence"] = EV
        out, rpc = run_takeover(takeover_ctx, router(g, o, "C"))
        self.assertEqual(out["next_action"], "follow_up")
        self.assertEqual([s["site"] for s in g.sent], ["drafting.takeover_analysis", "drafting.takeover_followup"])
        self.assertEqual(len(o.sent), 0)
        [draft] = rpc.named("intel_agent_upsert_draft")
        self.assertFalse(draft["p_auto_ok"])
        [log] = ai_logs(rpc.calls)
        self.assertEqual((log["ai"]["provider"], log["analysis_ai"]["provider"], log["source"]), ("gemini", "gemini", "takeover"))
        # Gemini down: both takeover calls fall back to Ollama, one attempt each
        g2, o2 = G(answers, exc=GeminiTransient("x", K_SERVER)), O(answers)
        takeover_ctx = tk.ctx([tk.OUT1])
        takeover_ctx["evidence"] = EV
        out, rpc = run_takeover(takeover_ctx, router(g2, o2, "C"))
        self.assertEqual(out["next_action"], "follow_up")
        self.assertEqual(len(o2.sent), 2)
        self.assertEqual(ai_logs(rpc.calls)[0]["ai"]["provider"], "ollama")


class Japanese(unittest.TestCase):
    """A Japanese draft is judged by the Japanese validators, not by 'contains Japanese'."""
    INBOUND = "制作実績に興味があります。ポートフォリオをお願いします。"
    GOOD = "Hana Sato様\n\nご返信ありがとうございます。貴社が公開された2Dゲームのキャラクターアニメーション制作実績を拝見しました。ポートフォリオをお送りします。"

    def run_jp(self, model, body):
        c = tk.ctx([tk.OUT1, tk.entry("inbound", self.INBOUND, "2026-10-06", "Re: 制作協力")])
        c["evidence"] = [{"id": "ev-pixel-1", "verified": True, "fact_type": "portfolio", "url": "https://pixelmoon.jp/works",
                          "snippet": "Pixel Moonは2Dゲームのキャラクターアニメーション制作実績を公開しています。"}]
        kb = tk.KB + [{"key": "studio.about.ja", "body": "Studio Kairegiは2Dアニメーション制作を行うスタジオです。"},
                      {"key": "services.indie_game_developer.ja", "body": "ゲーム向けの2Dアニメーション映像制作に対応しています。"},
                      {"key": "portfolio.main.ja", "body": "制作実績：https://kairegi.com/reel"}]
        class R(tk.Rpc):
            def __call__(self, name, p=None):
                return kb if name == "intel_agent_kb" else super().__call__(name, p)
        return run_takeover(c, model, rpc=R(c))

    def answers(self, body):
        cite_everything = lambda payload: {"subject": "Re: 制作協力について", "body": body, "evidence_ids": [e["id"] for e in payload["verified_evidence"]]}
        return {"analysis": {"summary": "They are interested.", "intent": "interested", "open_questions": [], "language": "ja"},
                "compose": cite_everything, "paragraph": {"paragraph": "x"}}

    def test_valid_japanese_draft_from_gemini_is_stored_for_approval_with_provenance(self):
        a = self.answers(self.GOOD); g, o = G(a), O(a)
        out, rpc = self.run_jp(router(g, o, "C"), self.GOOD)
        self.assertEqual(out["next_action"], "reply")
        [draft] = rpc.named("intel_agent_upsert_draft")
        self.assertIn("ポートフォリオをお送りします", draft["p_body"]); self.assertFalse(draft["p_auto_ok"])
        self.assertEqual([s["site"] for s in g.sent], ["drafting.takeover_analysis", "drafting.takeover"])
        self.assertEqual(ai_logs(rpc.calls)[0]["ai"]["provider"], "gemini")

    def test_japanese_with_a_price_or_invented_history_is_refused_whichever_provider_wrote_it(self):
        for bad in (self.GOOD + "\n料金は1分あたり5万円です。", self.GOOD + "\n以前ご相談いただいた通り、数多くの作品の実績があります。"):
            for make in (lambda a: (G(a), O({})), lambda a: (G(a, exc=GeminiTransient("x", K_SERVER)), O(a))):
                a = self.answers(bad); g, o = make(a)
                with self.subTest(body=bad[-12:], first=type(g.exc).__name__):
                    out, rpc = self.run_jp(router(g, o, "C"), bad)
                    self.assertEqual(out["next_action"], "needs_human")
                    self.assertEqual(rpc.named("intel_agent_upsert_draft"), [])
                    self.assertEqual(ai_logs(rpc.calls), [])


class Provenance(unittest.TestCase):
    def test_missing_evidence_does_not_create_a_template_draft_or_provenance(self):
        a = {"analysis": {"summary": "No reply yet.", "intent": "no_response", "open_questions": [], "language": "en"},
             "compose": COMPOSE}
        out, rpc = run_takeover(tk.ctx([tk.OUT1]), router(G(a), O(a), "C"))
        self.assertEqual(out["next_action"], "needs_human")
        self.assertEqual(ai_logs(rpc.calls), [])
        self.assertEqual(rpc.named("intel_agent_upsert_draft"), [])

    def test_provenance_log_holds_no_draft_text_page_text_or_secret(self):
        g, o = G({"compose": COMPOSE}), O({"compose": COMPOSE})
        _, calls = run_initial(router(g, o, "C"))
        text = json.dumps(ai_logs(calls)[0])
        for needle in ("hand-drawn", "Pixel Moon", "rina@", "KAIRFLOW", "api_key", "AIza"):
            self.assertNotIn(needle, text)
        self.assertEqual(set(ai_logs(calls)[0]["ai"]) - {"model_reported"}, {"provider", "model", "site", "model_calls"})

    def test_a_failing_provenance_log_never_loses_or_duplicates_the_draft(self):
        g, o = G({"compose": COMPOSE}), O({"compose": COMPOSE})
        out, calls = run_initial(router(g, o, "C"), rpc_fail_log=True)
        self.assertTrue(out["ok"])
        self.assertEqual(names(calls).count("intel_agent_upsert_draft"), 1)

    def test_plain_ollama_client_without_a_router_still_drafts_and_is_marked_no_router(self):
        o = O({"compose": COMPOSE})
        out, calls = run_initial(o)
        self.assertTrue(out["ok"])
        self.assertEqual(ai_logs(calls)[0]["ai"]["fallback_reason"], "no_router")

    def test_stamp_uses_only_the_latest_call_and_clears_between_attempts(self):
        rec = [{"provider": "gemini", "model": "m", "site": "s"}, {"provider": "ollama", "model": "o", "site": "s", "fallback_reason": "x"}]
        mail = ai_call.stamp({"model_written": True}, rec)
        self.assertEqual((mail["ai"]["provider"], mail["ai"]["model_calls"]), ("ollama", 2))
        self.assertEqual(rec, [])
        self.assertNotIn("ai", ai_call.stamp({"model_written": True}, rec))          # a regeneration never inherits the earlier attempt
        self.assertNotIn("ai", ai_call.stamp({"model_written": False}, [{"provider": "gemini"}]))


# ---- h_classify (reply drafting) ------------------------------------------------------------------------------------------------------
def run_reply(model):
    calls = []
    msg = {"id": "in1", "prospect_id": "p1", "from_email": "rina@pixelmoon.com", "subject": "Portfolio request", "body_text": "Could you send me a link to your portfolio?",
           "rfc_message_id": "<in1@pixelmoon.com>"}
    ctx = {"prospect": {**P, "status": "contacted", "contact_email": "rina@pixelmoon.com"}, "evidence": EV, "lead": {}, "messages": []}
    st = {**SETTINGS, "autonomy": "shadow"}
    def rpc(name, p=None):
        calls.append((name, p or {}))
        return {"intel_agent_context": ctx, "intel_agent_settings": st, "intel_agent_kb": KB_LIST, "intel_agent_recent_outbound": [],
                "intel_agent_unprocessed_inbound": [msg],
                "intel_agent_upsert_draft": {"ok": True, "message_id": "m9", "state": "pending_approval", "created": True}}.get(name, {})
    out = jobs.h_classify(jobs.Deps(cfg=CFG, rpc=rpc, fetcher=None, zoho=None, llm=model, clock=lambda: 1_800_000_000.0), {"payload": {}})
    return out, calls, [a for n, a in calls if n == "intel_agent_upsert_draft"]


def run_takeover(c, model, rpc=None):
    rpc = rpc or tk.Rpc(c)
    d = jobs.Deps(cfg=CFG, rpc=rpc, fetcher=None, zoho=None, llm=model)
    return takeover.handle(d, {"id": "job-12345678", "attempts": 1, "max_attempts": 5, "payload": {"prospect_id": tk.PID}}), rpc


class StillUnrouted(unittest.TestCase):
    def test_reply_drafting_is_routed_separately_from_classification(self):
        # Phase 6 tags classification (classification.inbound). With D1=C and a default=gemini_first policy both sites may use Gemini, as sites.
        g, o = G({"compose": REPLY, "label": LABEL}), O({"label": LABEL})
        run_reply(router(g, o, "C", policy="default=gemini_first"))
        self.assertEqual([s["site"] for s in g.sent], ["classification.inbound", "drafting.reply"])


if __name__ == "__main__":
    unittest.main()
