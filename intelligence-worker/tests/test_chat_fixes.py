"""Regression tests for the Agent Chat bug report (items 2, 3, 5, 6, 7)."""
import unittest
from unittest.mock import patch

from kairflow_intel import chat
from kairflow_intel.errors import PermanentError
from .test_v1 import ChatRpc, FakeLLM, deps, U

CTX = lambda request: {"ok": True, "answered": False, "request": request, "history": []}
JOB = {"thread_id": "t", "message_id": 1}


class DraftClassification(unittest.TestCase):
    def test_looking_at_a_draft_is_not_ordering_one(self):
        for r in ("Show me the draft email for Andraft", "Where is the draft email for Andraft?", "What does the outreach email to Andraft say?"):
            with self.subTest(r=r):
                self.assertFalse(chat._is_explicit_draft_request(r))

    def test_negation_only_cancels_its_own_clause(self):
        r = "Don't write to Pixel Moon, but draft an email for Andraft"
        self.assertTrue(chat._is_explicit_draft_request(r))
        self.assertEqual(chat._draft_target(chat._draft_clause(r)), "Andraft")
        self.assertFalse(chat._is_explicit_draft_request("Don't draft an email to Andraft"))
        self.assertFalse(chat._is_explicit_draft_request("Don’t draft an email to Andraft"))

    def test_orders_with_commas_still_count(self):
        self.assertTrue(chat._is_explicit_draft_request("Draft a natural, professional outreach email to Andraft on behalf of Studio Kairegi."))


class DraftTarget(unittest.TestCase):
    def test_trailing_topic_is_not_part_of_the_name(self):
        for r, want in (("Draft an email to Andraft about our new animation services", "Andraft"),
                        ("Draft an email to Andraft regarding rates", "Andraft"),
                        ("Draft an email to Andraft to introduce our services", "Andraft")):
            with self.subTest(r=r):
                self.assertEqual(chat._draft_target(r), want)

    def test_and_inside_a_name_is_kept(self):
        self.assertEqual(chat._draft_target("Draft an email to Black and White Studio"), "Black and White Studio")
        self.assertEqual(chat._draft_candidates("Andraft and mention rates")[-1], "Andraft")


class DraftHandler(unittest.TestCase):
    def _run(self, request, prospects, llm=None):
        class R(ChatRpc):
            def __call__(s, name, p=None):
                p = p or {}; s.calls.append((name, p))
                if name == "intel_agent_chat_context": return CTX(request)
                if name == "intel_agent_chat_tool": return {"ok": True, "prospects": prospects}
                if name == "intel_agent_chat_reply": s.replies.append(p); return {"ok": True}
                raise AssertionError(name)
        rpc = R()
        with patch("kairflow_intel.jobs.h_draft", return_value={"ok": True, "message_id": 7, "state": "pending_approval"}) as h:
            out = chat.handle(deps(rpc, llm or FakeLLM(down=True)), JOB)
        return rpc, out, h

    def test_name_followed_by_a_topic_still_drafts(self):
        rpc, out, h = self._run("Write an email to Andraft about our new animation services", [{"id": U, "name": "Andraft", "status": "lead_linked"}])
        self.assertTrue(out.get("draft_saved")); h.assert_called_once()

    def test_name_with_and_drafts_for_the_whole_name(self):
        rpc, out, h = self._run("Draft an email to Black and White Studio", [{"id": U, "name": "Black and White Studio", "status": "lead_linked"}])
        self.assertTrue(out.get("draft_saved")); h.assert_called_once()

    def test_a_role_is_answered_by_the_model_not_blocked(self):
        llm = FakeLLM([{"action": "reply", "reply": "Here is a draft: ..."}])
        rpc, out, h = self._run("Can you write an email to my accountant about the invoice?", [], llm)
        h.assert_not_called()
        self.assertEqual(rpc.replies[0]["p_text"], "Here is a draft: ...")
        self.assertNotEqual(rpc.replies[0]["p_status"], "error")

    def test_showing_a_draft_does_not_create_one(self):
        llm = FakeLLM([{"action": "reply", "reply": "It is in Outreach."}])
        rpc, out, h = self._run("Show me the draft email for Andraft", [{"id": U, "name": "Andraft", "status": "lead_linked"}], llm)
        h.assert_not_called()


class AlwaysAnswers(unittest.TestCase):
    def test_unexpected_crash_leaves_an_error_reply(self):
        rpc = ChatRpc(ctx=CTX("hi"))
        llm = FakeLLM(); llm.chat_json = lambda *a, **k: (_ for _ in ()).throw(KeyError("boom"))
        with self.assertRaises(KeyError):
            chat.handle(deps(rpc, llm), JOB)
        self.assertEqual(len(rpc.replies), 1); self.assertEqual(rpc.replies[0]["p_status"], "error")

    def test_bad_job_payload_still_raises_without_a_reply(self):
        rpc = ChatRpc()
        with self.assertRaises(PermanentError):
            chat.handle(deps(rpc, FakeLLM()), {"thread_id": None})
        self.assertEqual(rpc.replies, [])


class OversizedNumbers(unittest.TestCase):
    def test_infinity_and_nan_are_dropped_not_fatal(self):
        for bad in ("1e999", "inf", "-inf", "nan", float("inf"), float("nan")):
            with self.subTest(bad=bad):
                self.assertEqual(chat.clean_args("list_prospects", {"limit": bad, "query": "x"}), {"query": "x"})
        self.assertEqual(chat.clean_args("stats", {"days": "7"}), {"days": 7})


class FallbackWording(unittest.TestCase):
    def test_prepared_changes_never_read_as_done(self):
        for tool in chat.PROPOSALS:
            with self.subTest(tool=tool):
                text = chat.render(tool, {"ok": True, "proposed": True})
                self.assertNotIn("Done", text); self.assertIn("Confirm", text)

    def test_prospect_detail_is_summarised(self):
        r = {"ok": True, "prospect": {"name": "Andraft", "status": "lead_linked", "score": 82}, "evidence_count": 3}
        self.assertEqual(chat.render("prospect_detail", r), "Andraft is lead_linked, score 82. 3 piece(s) of evidence on file.")


if __name__ == "__main__":
    unittest.main()
