"""Emma uses the full model with business and app context. Code never second-guesses meaning with keywords; it only refuses an immediate action
that is not grounded in the administrator's own words, so a message the model did not understand cannot cause a random execution."""
import unittest

from kairflow_intel import chat, chat_context
from kairflow_intel.errors import InvalidModelOutput
from .test_v1 import ChatRpc, FakeLLM, deps


class SpyLLM(FakeLLM):
    def __init__(self, plans):
        super().__init__(plans); self.systems = []
    def chat_json(self, system, messages, schema, **kw):
        self.systems.append(system); return super().chat_json(system, messages, schema, **kw)


def run(request, plans, history=None, llm=None):
    rpc = ChatRpc(ctx={"ok": True, "answered": False, "request": request, "history": history or []})
    llm = llm or FakeLLM(plans)
    chat.handle(deps(rpc, llm), {"thread_id": "t", "message_id": 1})
    return rpc, llm


def tool(name, quote=None, **args):
    p = {"action": "tool", "tool": name, "args": args}
    if quote is not None: p["intent_quote"] = quote
    return p


class Context(unittest.TestCase):
    def test_model_receives_business_and_app_context(self):
        rpc, llm = run("how does outreach work here?", [{"action": "reply", "reply": "ok"}], llm=SpyLLM([{"action": "reply", "reply": "ok"}]))
        sys = llm.systems[0]
        for needle in ("Studio Kairegi", "Nairobi", "Existing Leads", "Agent Activity Logs", "WAITS FOR THE ADMINISTRATOR'S APPROVAL", "intent_quote", "ONE short question"):
            self.assertIn(needle, sys)
        self.assertNotRegex(chat_context.APP_GUIDE, r"\$\s?\d|USD|KES")          # no prices or commitments in static text: those live in the knowledge base

    def test_how_to_questions_are_answered_in_words_with_no_tool(self):
        rpc, _ = run("what happens after a draft is approved?", [{"action": "reply", "reply": "It is sent by the worker inside the send window."}])
        self.assertEqual(rpc.tools_called(), []); self.assertIn("send window", rpc.replies[0]["p_text"])


class UngroundedActions(unittest.TestCase):
    def test_action_without_a_quote_is_not_run(self):
        for name in ("emergency_stop", "set_campaign_status", "start_discovery", "prepare_followups", "prepare_introductions", "adopt_crm_leads", "research_prospect"):
            rpc, _ = run("asdf qwerty hmm", [tool(name), tool(name)])
            self.assertEqual(rpc.tools_called(), [], name)
            self.assertIn("did nothing", rpc.replies[0]["p_text"])

    def test_invented_quote_is_not_run(self):
        rpc, _ = run("hmm what about it", [tool("start_discovery", "find ten indie developers", type="indie_game_developer"), tool("start_discovery", "find ten indie developers")])
        self.assertEqual(rpc.tools_called(), [])

    def test_model_gets_one_chance_to_ask_a_question_instead(self):
        rpc, llm = run("hmm what about it", [tool("emergency_stop"), {"action": "reply", "reply": "Do you want me to stop sending, or show the status?"}])
        self.assertEqual(rpc.tools_called(), [])
        self.assertEqual(rpc.replies[0]["p_text"], "Do you want me to stop sending, or show the status?")
        self.assertIn("Not run", llm.calls[1][-1]["content"])

    def test_model_can_retry_with_the_real_quote(self):
        rpc, _ = run("get the indie devs going again", [tool("start_discovery", type="indie_game_developer"),
                                                       tool("start_discovery", "get the indie devs going again", type="indie_game_developer"),
                                                       {"action": "reply", "reply": "Started."}])
        self.assertEqual(rpc.tools_called(), ["start_discovery"])

    def test_questions_and_negations_never_stop_or_pause(self):
        for text in ("why did we stop sending?", "should I pause the campaign?", "don't pause anything", "what does emergency stop do?"):
            rpc, _ = run(text, [tool("emergency_stop", text), tool("set_campaign_status", text, status="paused")])
            self.assertEqual(rpc.tools_called(), [], text)


class GroundedActions(unittest.TestCase):
    def test_any_wording_works_when_the_model_quotes_it(self):
        for text, plan in (("bring me fresh indie devs to talk to", tool("start_discovery", "bring me fresh indie devs to talk to", type="indie_game_developer")),
                           ("hold the indie outreach for now please", tool("set_campaign_status", "hold the indie outreach for now please", type="indie_game_developer", status="paused")),
                           ("kill all sending right now", tool("emergency_stop", "kill all sending right now")),
                           ("who's due a nudge? prep them", tool("prepare_followups", "prep them")),
                           ("インディーゲーム開発者を10件探して", tool("start_discovery", "インディーゲーム開発者を10件探して", type="indie_game_developer"))):
            rpc, _ = run(text, [plan, {"action": "reply", "reply": "Done."}])
            self.assertEqual(len(rpc.tools_called()), 1, text)

    def test_quote_may_come_from_the_previous_message(self):
        hist = [{"role": "user", "content": "pause the indie campaign"}, {"role": "assistant", "content": "Which one?"}]
        rpc, _ = run("indie", [tool("set_campaign_status", "pause the indie campaign", type="indie_game_developer", status="paused"), {"action": "reply", "reply": "Paused."}], hist)
        self.assertEqual(rpc.tools_called(), ["set_campaign_status"])

    def test_yes_to_emmas_own_question_counts(self):
        hist = [{"role": "user", "content": "things look messy"}, {"role": "assistant", "content": "Should I pause the campaign?"}]
        rpc, _ = run("yes", [tool("set_campaign_status", "yes", type="all", status="paused"), {"action": "reply", "reply": "Paused."}], hist)
        self.assertEqual(rpc.tools_called(), ["set_campaign_status"])
        rpc, _ = run("yes", [tool("set_campaign_status", "yes", status="paused"), tool("set_campaign_status", "yes", status="paused")], [{"role": "assistant", "content": "Hello!"}])
        self.assertEqual(rpc.tools_called(), [])

    def test_lookups_need_no_quote_but_every_proposal_does(self):
        self.assertTrue(chat.action_grounded({"tool": "list_drafts"}, "x"))
        self.assertTrue(chat.action_grounded({"tool": "campaign_status"}, "x"))
        for t in chat.PROPOSALS:
            self.assertFalse(chat.action_grounded({"tool": t, "args": {}}, "What are my opportunities?"), t)


class NoKeywordGuessing(unittest.TestCase):
    def test_unusable_model_answer_is_not_turned_into_a_keyword_guess(self):
        for text in ("the campaign thing from this week is weird", "hmm follow ups?", "pause or not, I can't decide, campaign"):
            rpc, _ = run(text, [{"action": "reply", "reply": ""}])
            self.assertEqual(rpc.tools_called(), [], text)
            self.assertIn("did nothing", rpc.replies[0]["p_text"], text)

    def test_invalid_json_from_a_reachable_model_does_nothing(self):
        class Bad:
            def chat_json(self, *a, **k): raise InvalidModelOutput("model returned invalid JSON: x")
        rpc = ChatRpc(ctx={"ok": True, "answered": False, "request": "show me the campaign status", "history": []})
        chat.handle(deps(rpc, Bad()), {"thread_id": "t", "message_id": 1})
        self.assertEqual(rpc.tools_called(), []); self.assertEqual(rpc.replies[0]["p_status"], "error")

    def test_this_week_alone_is_not_a_stats_request(self):
        self.assertIsNone(chat.fallback_plan("let's meet this week"))
        self.assertEqual(chat.fallback_plan("how many responses this week")[0], "stats")


class LiveSnapshot(unittest.TestCase):
    SNAP = {"ok": True, "sending_stopped": False, "autonomy": "assisted", "send_window": {"start_hour": 9, "end_hour": 17, "timezone": "Africa/Nairobi", "weekdays_only": True},
            "limits": {"daily_initial_cap": 5, "daily_followup_cap": 8, "followup_business_days": 5, "max_followups": 3, "warmup_enabled": True},
            "campaigns": [{"type": "indie_game_developer", "name": "Indie", "status": "paused", "daily_cap": 5, "prospects": 40}],
            "prospects_by_status": {"qualified": 7, "contacted": 12}, "drafts_waiting_for_approval": 3, "failed_messages": 1, "knowledge_entries_approved": 9,
            "last_7_days": {"introductions_sent": 11, "followups_sent": 4, "replies_received": 2}}

    class Rpc(ChatRpc):
        snap = None
        def __call__(self, name, p=None):
            if name == "intel_agent_chat_snapshot":
                if isinstance(self.snap, Exception): raise self.snap
                return self.snap
            return super().__call__(name, p)

    def go(self, snap):
        rpc = self.Rpc(ctx={"ok": True, "answered": False, "request": "how are we doing?", "history": []}); rpc.snap = snap
        llm = SpyLLM([{"action": "reply", "reply": "ok"}])
        chat.handle(deps(rpc, llm), {"thread_id": "t", "message_id": 1})
        return rpc, llm.systems[0]

    def test_model_sees_live_state_without_any_tool_call(self):
        rpc, system = self.go(self.SNAP)
        for needle in ("LIVE STATE RIGHT NOW", "Sending is ON", "Indie (indie_game_developer): paused", "qualified 7", "Drafts waiting for approval: 3", "11 introductions"):
            self.assertIn(needle, system)
        self.assertEqual(rpc.tools_called(), [])

    def test_stopped_sending_is_stated_plainly(self):
        self.assertIn("STOPPED", self.go({**self.SNAP, "sending_stopped": True})[1])

    def test_older_database_or_failure_just_skips_the_snapshot(self):
        for snap in (RuntimeError("function not found"), {"ok": False, "reason": "snapshot_failed"}, None, []):
            rpc, system = self.go(snap)
            self.assertNotIn("LIVE STATE", system); self.assertEqual(rpc.replies[0]["p_text"], "ok")

    def test_snapshot_function_is_read_only_and_leaks_no_message_text(self):
        import pathlib
        sql = next(pathlib.Path(__file__).resolve().parents[2].glob("supabase/migrations/*intelligence_chat_snapshot.sql")).read_text(encoding="utf-8")
        sql = "\n".join(l for l in sql.splitlines() if not l.lstrip().startswith("--"))
        self.assertRegex(sql, r"(?i)language plpgsql stable security definer")
        self.assertNotRegex(sql, r"(?i)\b(insert|update|delete)\s+(into|public)|to_email|subject|body_text|contact_email")


class ReviewFixes(unittest.TestCase):
    def test_null_intent_quote_is_valid_in_the_plan_schema(self):
        from kairflow_intel.ollama import validate
        validate(chat.PLAN_SCHEMA, {"action": "reply", "reply": "hi", "intent_quote": None})
        validate(chat.PLAN_SCHEMA, {"action": "tool", "tool": "campaign_status", "args": {}, "intent_quote": "x"})

    def test_malformed_plans_do_not_crash_the_chat(self):
        for bad in ([], "text", {"tool": "campaign_status"}, {"action": "tool", "tool": ["x"]}, {"action": "reply", "reply": None}, {"action": "tool", "tool": None}):
            rpc, _ = run("hello there", [bad])
            self.assertEqual(rpc.tools_called(), [], repr(bad)); self.assertEqual(len(rpc.replies), 1, repr(bad))

    def test_bare_yes_needs_a_question_and_a_real_clause_is_not_a_bare_yes(self):
        g = chat.action_grounded
        self.assertFalse(g({"tool": "start_discovery", "intent_quote": "yes"}, "yes", [], "Hello!"))
        self.assertTrue(g({"tool": "start_discovery", "intent_quote": "yes"}, "yes", [], "Want me to find more indie developers?"))
        self.assertFalse(g({"tool": "set_campaign_status", "intent_quote": "yes"}, "yes", [], "Want me to list the drafts?"), "yes to an unrelated question must not pause")
        self.assertTrue(g({"tool": "set_campaign_status", "intent_quote": "yes"}, "yes", [], "Should I pause the campaign?"))
        self.assertTrue(g({"tool": "set_campaign_status", "intent_quote": "yes pause it"}, "yes pause it", [], ""), "a clear order is not a bare yes")

    def test_japanese_and_fullwidth_questions_are_not_stop_orders(self):
        for q in ("送信を停止しますか？", "全部停止しますか", "停止しましょうか"):
            self.assertFalse(chat.action_grounded({"tool": "emergency_stop", "intent_quote": q}, q), q)
        self.assertTrue(chat.action_grounded({"tool": "emergency_stop", "intent_quote": "全部停止して"}, "全部停止して"))

    def test_ollama_window_grows_with_the_prompt_so_the_role_is_never_cut_off(self):
        import json as _json
        from kairflow_intel.ollama import OllamaClient
        sent = []
        class Resp:
            status_code = 200
            def json(self): return {"message": {"content": _json.dumps({"action": "reply", "reply": "ok"})}}
        class Sess:
            def post(self, url, json=None, timeout=None): sent.append(json["options"]["num_ctx"]); return Resp()
        class Cfg: ollama_model = "m"; ollama_url = "http://127.0.0.1:11434"
        c = OllamaClient.__new__(OllamaClient); c.cfg, c.s = Cfg(), Sess()
        c.chat_json("s" * 1000, [{"role": "user", "content": "hi"}], chat.PLAN_SCHEMA)
        c.chat_json("s" * 30000, [{"role": "user", "content": "hi"}], chat.PLAN_SCHEMA)
        c.chat_json("s" * 200000, [{"role": "user", "content": "hi"}], chat.PLAN_SCHEMA)
        self.assertEqual(sent[0], 8192); self.assertGreater(sent[1], 8192); self.assertEqual(sent[2], 16384)

    def test_real_prompt_fits_the_window_without_history(self):
        from kairflow_intel import chat_kb
        text = chat.SYSTEM.replace("{tools}", chat.catalogue()) + chat_context.APP_GUIDE + chat_kb.KB_RULES
        self.assertLess(len(text), 16000, "the fixed part of the prompt grew too large for a small local model")
