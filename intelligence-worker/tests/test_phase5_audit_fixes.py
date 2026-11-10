"""Regression tests for the Phase 5 audit (drafting routing under decision D1).

1. A draft written by Gemini and then refused by the composer's own validators gets ONE retry on Ollama before a person is asked.
2. Agent Chat never shows the planner summaries or subjects of private correspondence when the planner may be served by Gemini and D1 is not C.
3. A drafting/classification policy entry that D1 makes dead is reported at startup and in the router status.
4. A model outage during classification retries the job; a badly shaped answer still falls back to keywords and never blocks other messages.
"""
import json
import logging
import unittest

from kairflow_intel import ai_call, chat, jobs
from kairflow_intel.ai_types import AIResult, GeminiTransient, K_SERVER
from kairflow_intel.airouter import AIRouter, R_GEMINI_DRAFT_REJECTED, RouterSettings, settings_from_env, settings_warnings
from kairflow_intel.errors import InvalidModelOutput, PermanentError, RpcError, TransientError
from kairflow_intel.gemini import FallbackLLM
from .helpers import CFG
from .test_ai_router import Clock, FakeOllama, MODEL
from .test_logic import EV, P, SETTINGS
from .test_phase5_drafting_routing import (COMPOSE, G, KB_LIST, O, REPLY, ai_logs, names, router, run_initial, run_reply)
from .test_v1 import ChatRpc, deps

BAD_ID = {**COMPOSE, "evidence_ids": ["made-up-id"]}                                                   # well-formed, cites evidence that does not exist
BAD_CLAIM = {**COMPOSE, "body": COMPOSE["body"] + " Pixel Moon is hiring animators."}                  # an unsupported claim
OTHER = {"subject": "A thought on Pixel Moon's cinematic trailer", "evidence_ids": ["e0"],                # valid, and unlike COMPOSE
         "body": "A cinematic trailer for a hand-drawn adventure is coming soon, and we would love to help with it."}


def flagged(calls): return names(calls).count("intel_agent_flag_prospect")


# ---- 1. Gemini's refusal gets one Ollama attempt -----------------------------------------------------------------------------------------
class GeminiDraftRetriedOnOllama(unittest.TestCase):

    def test_a_gemini_draft_citing_unknown_evidence_is_rewritten_by_ollama_and_stored(self):
        g, o = G({"compose": BAD_ID}), O({"compose": COMPOSE})
        out, calls = run_initial(router(g, o, "C"))
        self.assertEqual((out["ok"], out["state"]), (True, "pending_approval"))
        self.assertEqual((len(g.sent), len(o.sent)), (1, 1))                       # Gemini once, Ollama once, no loop
        self.assertEqual(flagged(calls), 0)
        [log] = ai_logs(calls)
        self.assertEqual((log["ai"]["provider"], log["ai"]["fallback_reason"], log["ai"]["model_calls"]), ("ollama", R_GEMINI_DRAFT_REJECTED, 2))
        [up] = [a for n, a in calls if n == "intel_agent_upsert_draft"]
        self.assertFalse(up["p_auto_ok"])                                           # still waits for a person

    def test_an_unsupported_claim_from_gemini_is_retried_the_same_way(self):
        g, o = G({"compose": BAD_CLAIM}), O({"compose": COMPOSE})
        out, calls = run_initial(router(g, o, "C"))
        self.assertTrue(out["ok"]); self.assertEqual((len(g.sent), len(o.sent)), (1, 1)); self.assertEqual(ai_logs(calls)[0]["ai"]["provider"], "ollama")

    def test_when_ollama_is_refused_too_a_person_is_asked_after_exactly_one_retry(self):
        g, o = G({"compose": BAD_ID}), O({"compose": BAD_ID})
        out, calls = run_initial(router(g, o, "C"))
        self.assertEqual(out, {"skipped": "manual_review_required"})
        self.assertEqual((len(g.sent), len(o.sent)), (1, 1))
        self.assertEqual(flagged(calls), 1); self.assertNotIn("intel_agent_upsert_draft", names(calls)); self.assertEqual(ai_logs(calls), [])

    def test_an_ollama_draft_that_is_refused_is_not_retried(self):
        for label, g, o, d1, env in (("d1_a", G({"compose": COMPOSE}), O({"compose": BAD_ID}), "A", {}),
                                      ("gemini_down", G(exc=GeminiTransient("x", K_SERVER)), O({"compose": BAD_ID}), "C", {}),
                                      ("rollback", G({"compose": COMPOSE}), O({"compose": BAD_ID}), "C", {"KAIRFLOW_AI_FORCE_OLLAMA": "1"})):
            with self.subTest(case=label):
                out, calls = run_initial(router(g, o, d1, **env))
                self.assertEqual(out, {"skipped": "manual_review_required"}); self.assertEqual(len(o.sent), 1)

    def test_the_retry_never_reaches_gemini_and_never_beats_the_rollback_reason(self):
        g, o = G({"compose": BAD_ID}), O({"compose": COMPOSE})
        m = router(g, o, "C")
        res = m.generate_json_ex("drafting.initial", "i", "u", {"type": "object", "properties": {"evidence_ids": {}}}, prefer_ollama=True)
        self.assertEqual((res.provider, res.route_reason, len(g.sent)), ("ollama", R_GEMINI_DRAFT_REJECTED, 0))
        forced = router(G({"compose": BAD_ID}), O({"compose": COMPOSE}), "C", KAIRFLOW_AI_FORCE_OLLAMA="1")
        self.assertEqual(forced.generate_json_ex("drafting.initial", "i", "u", {"type": "object", "properties": {"evidence_ids": {}}},
                                                 prefer_ollama=True).route_reason, "forced_ollama")

    def test_a_reply_draft_is_retried_too(self):
        g, o = G({"compose": {**REPLY, "evidence_ids": ["made-up-id"]}, "label": {"label": "portfolio_request", "confidence": 0.9, "summary": "s"}}), \
               O({"compose": REPLY, "label": {"label": "portfolio_request", "confidence": 0.9, "summary": "s"}})
        out, calls, up = run_reply(router(g, o, "C"))
        self.assertEqual(out, {"classified": 1}); self.assertEqual(len(up), 1); self.assertFalse(up[0]["p_auto_ok"])
        self.assertEqual(flagged(calls), 0)
        self.assertEqual(ai_logs(calls)[0]["ai"]["fallback_reason"], R_GEMINI_DRAFT_REJECTED)

    def test_the_regeneration_step_is_covered(self):
        """First draft is valid but too similar to earlier mail; Gemini's regenerated draft is refused; Ollama's second attempt is used."""
        answers = iter([COMPOSE, BAD_ID])
        g = G({"compose": lambda payload: next(answers)}); o = O({"compose": OTHER})
        calls = []
        ctx = {"prospect": {**P, "status": "lead_linked", "contact_email": "rina@pixelmoon.com"}, "evidence": EV, "lead": {}, "messages": []}
        def rpc(name, p=None):
            calls.append((name, p or {}))
            return {"intel_agent_context": ctx, "intel_agent_settings": {**SETTINGS, "autonomy": "shadow"}, "intel_agent_kb": KB_LIST,
                    "intel_agent_recent_outbound": [{"subject": COMPOSE["subject"], "body_text": COMPOSE["body"], "state": "sent", "idempotency_key": "other"}],
                    "intel_agent_upsert_draft": {"ok": True, "message_id": "m1", "state": "pending_approval", "created": True}}.get(name, {})
        out = jobs.h_draft(jobs.Deps(cfg=CFG, rpc=rpc, fetcher=None, zoho=None, llm=router(g, o, "C"), clock=lambda: 1_800_000_000.0),
                           {"payload": {"prospect_id": "p1", "kind": "initial"}})
        self.assertTrue(out["ok"], out)
        self.assertEqual((len(g.sent), len(o.sent)), (2, 1))
        self.assertEqual(ai_logs(calls)[0]["ai"]["provider"], "ollama")


class ComposedHelper(unittest.TestCase):
    """ai_call.composed in isolation: when it retries and when it does not."""

    class Llm:
        def __init__(self, providers): self.providers, self.seen = list(providers), []
        def generate_json_ex(self, site, instruction, untrusted, schema, *, fast=False, **kw):
            self.seen.append(kw)
            prov = self.providers.pop(0)
            return AIResult(data={"x": 1}, provider=prov, model=prov, site=site)

    def test_retries_once_only_when_the_refused_draft_came_from_gemini(self):
        for providers, expect_calls in ((["gemini", "ollama"], 2), (["ollama"], 1)):
            llm, rec = self.Llm(providers), []
            def run(model):
                model("i", "u", {}); raise PermanentError("refused")
            with self.subTest(first=providers[0]), self.assertRaises(PermanentError):
                ai_call.composed(llm, "drafting.initial", rec, run)
            self.assertEqual(len(llm.seen), expect_calls)
        self.assertEqual(llm.seen, [{}])                                             # a plain first attempt passes no prefer_ollama

    def test_the_retry_asks_for_ollama_and_a_refusal_before_any_model_call_is_not_retried(self):
        llm, rec = self.Llm(["gemini", "ollama"]), []
        attempts = []
        def run(model):
            attempts.append(1); model("i", "u", {})
            if len(attempts) == 1: raise PermanentError("refused")
            return {"model_written": True, "subject": "s", "body": "b"}
        mail = ai_call.composed(llm, "drafting.initial", rec, run)
        self.assertEqual(llm.seen, [{}, {"prefer_ollama": True}]); self.assertEqual(mail["ai"]["model_calls"], 2); self.assertEqual(rec, [])
        llm2, calls = self.Llm(["gemini"]), []
        def early(model): calls.append(1); raise PermanentError("approved knowledge base is incomplete")
        with self.assertRaises(PermanentError): ai_call.composed(llm2, "drafting.initial", [], early)
        self.assertEqual((len(calls), llm2.seen), (1, []))

    def test_stale_provenance_from_an_earlier_failed_composition_does_not_trigger_a_retry(self):
        llm, rec = self.Llm(["ollama"]), [{"provider": "gemini", "model": "m", "site": "s"}]
        def run(model): model("i", "u", {}); raise PermanentError("refused")
        with self.assertRaises(PermanentError): ai_call.composed(llm, "drafting.initial", rec, run)
        self.assertEqual(len(llm.seen), 1)

    def test_an_ollama_outage_on_the_retry_retries_the_job(self):
        llm, rec = self.Llm(["gemini"]), []
        state = []
        def run(model):
            state.append(1)
            if len(state) == 2: raise TransientError("ollama down")
            model("i", "u", {}); raise PermanentError("refused")
        with self.assertRaises(TransientError): ai_call.composed(llm, "drafting.initial", rec, run)


# ---- 2. Agent Chat and private correspondence --------------------------------------------------------------------------------------------
SECRET = "They want a quote for twelve episodes next spring"
OPPS = {"ok": True, "opportunities": [{"prospect_id": "p1", "name": "Pixel Moon", "type": "indie_game_developer", "class": "pricing",
                                         "summary": SECRET, "received_at": "2026-11-01", "lead_id": "l1", "lead_stage": "responded"}]}
DETAIL = {"ok": True, "prospect": {"id": "p1", "name": "Pixel Moon", "status": "replied"}, "evidence_count": 3, "lead": None,
          "recent_messages": [{"direction": "inbound", "kind": "reply", "state": "received", "subject": "Re: confidential budget", "classification": "pricing",
                               "summary": SECRET, "at": "2026-11-01"},
                              {"direction": "outbound", "kind": "initial", "state": "sent", "subject": "2D animation for Pixel Moon", "classification": None,
                               "summary": None, "at": "2026-10-20"}]}


class ChatGemini:
    """Gemini planner stand-in: asks for one tool, then replies. Records every planner payload."""
    def __init__(self, tool): self.tool, self.sent = tool, []
    def chat_json_ex(self, system, messages, schema, *, timeout=45, site="chat.plan"):
        self.sent.append(json.dumps(messages))
        data = {"action": "tool", "tool": self.tool, "args": {}} if len(self.sent) == 1 else {"action": "reply", "reply": "Done."}
        return AIResult(data=data, provider="gemini", model=MODEL, site=site)
    def generate_json_ex(self, *a, **k): raise AssertionError("not used")


class ChatOllama(FakeOllama):
    def __init__(self, tool): super().__init__(); self.tool, self.sent = tool, []
    def chat_json(self, system, messages, schema, **kw):
        self.sent.append(json.dumps(messages))
        return {"action": "tool", "tool": self.tool, "args": {}} if len(self.sent) == 1 else {"action": "reply", "reply": "Done."}


def run_chat(tool, result, llm, ctx=None):
    rpc = ChatRpc(tool_result=result)
    if ctx is not None: rpc.ctx = ctx
    out = chat.handle(deps(rpc, llm), {"thread_id": "t", "message_id": 1})
    return out, rpc


def model(g, o, d1="A", policy="", **env):
    return FallbackLLM(g, o, clock=Clock(), settings=settings_from_env({"KAIRFLOW_AI_D1": d1, **({"KAIRFLOW_AI_POLICY": policy} if policy else {}), **env}))


class ChatKeepsPrivateTextAway(unittest.TestCase):

    def test_under_d1_a_entire_agent_chat_context_stays_on_ollama(self):
        for tool, result in (("opportunities", OPPS), ("prospect_detail", DETAIL)):
            with self.subTest(tool=tool):
                g, o = ChatGemini(tool), ChatOllama(tool)
                out, rpc = run_chat(tool, result, model(g, o, "A"))
                self.assertEqual(out["tools"], [tool])
                self.assertEqual(g.sent, [])
                self.assertTrue(any("twelve episodes" in item or "confidential budget" in item for item in o.sent))

    def test_crm_contact_records_never_reach_gemini_under_d1_a(self):
        crm = {"ok": True, "counts": {"follow_up_due": 1}, "leads": [{"lead_id": "l1", "company_name": "Pixel Moon",
                "contact_person": "Rina Sato", "email": "rina@pixelmoon.example", "stage": "responded"}]}
        g, o = ChatGemini("crm_followup_review"), ChatOllama("crm_followup_review")
        run_chat("crm_followup_review", crm, model(g, o, "A"))
        self.assertEqual(g.sent, [])
        self.assertTrue(any("rina@pixelmoon.example" in item and "Rina Sato" in item for item in o.sent))
        scrubbed = chat.scrub_private("crm_followup_review", crm)
        self.assertNotIn("email", scrubbed["leads"][0]); self.assertNotIn("contact_person", scrubbed["leads"][0])
        self.assertEqual(crm["leads"][0]["email"], "rina@pixelmoon.example")  # no mutation

    def test_historical_chat_messages_never_reach_gemini_under_d1_a(self):
        private_history = [{"role": "user", "content": "My direct contact is Rina at rina@pixelmoon.example"},
                           {"role": "assistant", "content": "I will follow up with Rina about the confidential budget."}]
        ctx = {"ok": True, "answered": False, "request": "Show my follow-ups", "history": private_history}
        g, o = ChatGemini("crm_followup_review"), ChatOllama("crm_followup_review")
        run_chat("crm_followup_review", {"ok": True, "counts": {}, "leads": []}, model(g, o, "A"), ctx=ctx)
        self.assertEqual(g.sent, [])
        self.assertTrue(any("rina@pixelmoon.example" in item and "confidential budget" in item for item in o.sent))

    def test_d1_c_explicitly_allows_full_agent_chat_context_to_gemini(self):
        g = ChatGemini("opportunities")
        run_chat("opportunities", OPPS, model(g, ChatOllama("opportunities"), "C", "chat=gemini_first"))
        self.assertIn("twelve episodes", g.sent[1])

    def test_chat_router_marks_d1_a_as_local_even_if_policy_requests_gemini(self):
        for env in ({}, {"KAIRFLOW_AI_POLICY": "default=gemini_first"}, {"KAIRFLOW_AI_POLICY": "chat=gemini_first"}):
            r = AIRouter(None, None, settings_from_env({"KAIRFLOW_AI_D1": "A", **env}), Clock())
            self.assertEqual(r.resolve("chat.plan", "gemini_first"), ("ollama", "d1_private"))
            self.assertTrue(r.private_text_allowed("chat.plan"))
        self.assertEqual(AIRouter(None, None, settings_from_env({"KAIRFLOW_AI_D1": "C", "KAIRFLOW_AI_POLICY": "chat=gemini_first"}), Clock()).resolve("chat.plan", "gemini_first"), ("gemini_first", None))

    def test_scrubbers_are_non_mutating_and_preserve_non_private_tool_results(self):
        self.assertEqual(chat.scrub_private("opportunities", OPPS)["opportunities"][0].keys() & {"summary"}, set())
        self.assertIn("summary", OPPS["opportunities"][0])
        self.assertIn("summary", DETAIL["recent_messages"][0]); self.assertEqual(chat.scrub_private("stats", {"ok": True, "days": 7}), {"ok": True, "days": 7})
        self.assertEqual(chat.render("opportunities", OPPS), "Active opportunities: Pixel Moon (pricing).")


# ---- 3. A dead policy entry is reported ---------------------------------------------------------------------------------------------------
class DeadPolicyEntryIsReported(unittest.TestCase):

    def test_drafting_gemini_first_under_d1_a_warns_at_startup_and_shows_in_status(self):
        s = settings_from_env({"KAIRFLOW_AI_D1": "A", "KAIRFLOW_AI_POLICY": "drafting=gemini_first,classification.inbound=gemini_first,chat=gemini_first,discovery=gemini_first"})
        with self.assertLogs("kairflow_intel.airouter", level="WARNING") as cap:
            r = AIRouter(None, None, s, Clock())
        text = "\n".join(cap.output)
        self.assertIn("drafting", text); self.assertIn("classification.inbound", text); self.assertIn("chat", text); self.assertIn("KAIRFLOW_AI_D1=C", text)
        self.assertNotIn("discovery", text)
        [w] = r.status()["warnings"]; self.assertIn("no effect", w)
        self.assertEqual(r.resolve("drafting.initial"), ("ollama", "d1_private")); self.assertEqual(r.resolve("chat.plan", "gemini_first"), ("ollama", "d1_private"))             # and it really does nothing

    def test_no_warning_when_it_can_take_effect_or_is_not_about_a_private_group(self):
        for env in ({"KAIRFLOW_AI_D1": "C", "KAIRFLOW_AI_POLICY": "drafting=gemini_first"},
                    {"KAIRFLOW_AI_D1": "C", "KAIRFLOW_AI_POLICY": "chat=gemini_first"},
                    {"KAIRFLOW_AI_D1": "A", "KAIRFLOW_AI_POLICY": "default=gemini_first"},
                    {"KAIRFLOW_AI_D1": "A", "KAIRFLOW_AI_POLICY": "drafting=ollama"},
                    {"KAIRFLOW_AI_D1": "A", "KAIRFLOW_AI_POLICY": "drafting=gemini_first", "KAIRFLOW_AI_FORCE_OLLAMA": "1"},
                    {"KAIRFLOW_AI_D1": "A"}):
            with self.subTest(env=env):
                self.assertEqual(settings_warnings(settings_from_env(env)), [])
                r = AIRouter(None, None, settings_from_env(env), Clock())
                self.assertEqual(r.status()["warnings"], [])

    def test_the_warning_holds_no_secret(self):
        self.assertNotIn("AIza", "".join(settings_warnings(settings_from_env({"KAIRFLOW_AI_POLICY": "drafting=gemini_first"}))))


# ---- 4. Classification outage -------------------------------------------------------------------------------------------------------------
def run_batch(llm_fn, msgs):
    calls = []
    def rpc(name, p=None):
        calls.append((name, p or {}))
        return {"intel_agent_settings": {**SETTINGS, "autonomy": "shadow"}, "intel_agent_kb": [], "intel_agent_unprocessed_inbound": msgs}.get(name, {})
    class Llm:
        def generate_json_ex(self, site, instruction, untrusted, schema, *, fast=False, **kw):
            return AIResult(data=llm_fn(untrusted), provider="ollama", model="m", site=site)
    try:
        out = jobs.h_classify(jobs.Deps(cfg=CFG, rpc=rpc, fetcher=None, zoho=None, llm=Llm(), clock=lambda: 1_800_000_000.0), {"payload": {}})
    except TransientError as exc:
        out = exc
    return out, [a["p_message_id"] for n, a in calls if n == "intel_agent_classify_inbound"]


def msg(i, body): return {"id": f"in{i}", "prospect_id": None, "from_email": f"a{i}@x.com", "subject": "Re: hello", "body_text": body, "rfc_message_id": f"<{i}@x>"}


class ClassificationOutage(unittest.TestCase):
    OK = {"label": "positive", "confidence": 0.9, "summary": "Interested"}

    def test_an_outage_leaves_the_message_pending_and_the_job_retries(self):
        def down(_): raise TransientError("ollama down")
        out, saved_ids = run_batch(down, [msg(1, "Sounds interesting, tell me more.")])
        self.assertIsInstance(out, TransientError); self.assertEqual(saved_ids, [])

    def test_messages_before_the_outage_stay_saved_and_none_after_it_is_guessed(self):
        seen = []
        def flaky(untrusted):
            seen.append(untrusted)
            if len(seen) == 2: raise TransientError("ollama down")
            return self.OK
        out, saved_ids = run_batch(flaky, [msg(1, "Sounds interesting."), msg(2, "Please tell me more."), msg(3, "Happy to chat.")])
        self.assertIsInstance(out, TransientError); self.assertEqual(saved_ids, ["in1"]); self.assertEqual(len(seen), 2)

    def test_after_recovery_the_same_message_is_classified_by_the_model(self):
        out, saved_ids = run_batch(lambda _: self.OK, [msg(1, "Sounds interesting, tell me more.")])
        self.assertEqual((out, saved_ids), ({"classified": 1}, ["in1"]))

    def test_a_badly_shaped_answer_never_blocks_the_messages_behind_it(self):
        def poison(untrusted):
            if "first" in untrusted: raise InvalidModelOutput("model returned invalid JSON: x")
            return self.OK
        out, saved_ids = run_batch(poison, [msg(1, "first message, no keywords"), msg(2, "second one")])
        self.assertEqual(out, {"classified": 2}); self.assertEqual(saved_ids, ["in1", "in2"])

    def test_other_model_errors_keep_the_keyword_fallback(self):
        def broken(_): raise ValueError("bad payload")
        out, saved_ids = run_batch(broken, [msg(1, "Could you send your portfolio?")])
        self.assertEqual((out, saved_ids), ({"classified": 1}, ["in1"]))

    def test_deterministic_rules_never_need_the_model_so_an_outage_does_not_touch_them(self):
        def down(_): raise TransientError("ollama down")
        out, saved_ids = run_batch(down, [msg(1, "Please unsubscribe me and do not contact me again.")])
        self.assertEqual((out, saved_ids), ({"classified": 1}, ["in1"]))


if __name__ == "__main__":
    unittest.main()
