import inspect
import re
import unittest

from kairflow_intel import chat
from .test_v1 import ChatRpc, FakeLLM, deps

U = "11111111-2222-3333-4444-555555555555"


class RecordingRpc(ChatRpc):
    def __call__(self, name, p=None):
        if name == "intel_agent_chat_propose":
            self.calls.append((name, p or {}))
            return {"ok": True, "action_id": "a1", "status": "pending", "summary": "Approve 1 message(s)", "note": "NOTHING has changed yet."}
        return super().__call__(name, p)
    def called(self): return [n for n, _ in self.calls]


class Proposals(unittest.TestCase):
    def test_a_proposal_goes_only_to_the_propose_function(self):
        rpc = RecordingRpc(); llm = FakeLLM([{"action": "tool", "tool": "approve_messages", "args": {"message_ids": [U, "junk"]}},
                                              {"action": "reply", "reply": "I prepared it. Please confirm on the card."}])
        out = chat.handle(deps(rpc, llm), {"thread_id": "t", "message_id": 1})
        self.assertTrue(out["replied"])
        self.assertEqual([n for n in rpc.called() if n.startswith("intel_agent_chat_")], ["intel_agent_chat_context", "intel_agent_chat_propose", "intel_agent_chat_reply"])
        self.assertEqual(rpc.calls[1][1]["p_args"], {"message_ids": [U]})                       # junk ids dropped before the call
        self.assertNotIn("intel_agent_chat_tool", rpc.called())

    def test_the_worker_has_no_way_to_confirm_or_to_call_admin_functions(self):
        src = inspect.getsource(chat)
        self.assertNotRegex(src, r"intel_admin_")
        self.assertNotRegex(src, r"confirm\(|chat_confirm|_exec")
        self.assertEqual(set(re.findall(r'"(intel_[a-z_]+)"', src)), {"intel_agent_chat_context", "intel_agent_chat_propose", "intel_agent_chat_tool", "intel_agent_chat_reply"})

    def test_nothing_about_roles_permissions_or_removing_protections_exists(self):
        for name in chat.ALL_TOOLS:
            self.assertIsNone(re.search(r"role|admin|member|permission|grant|master|remove|unsuppress|delete|sql|shell|exec", name), name)
        self.assertEqual(set(chat.PROPOSALS), {"approve_messages", "discard_messages", "resume_campaign", "set_campaign_cap", "enable_sending", "set_autonomy", "update_limits", "add_suppression", "review_prospect"})
        self.assertFalse(set(chat.TOOLS) & set(chat.PROPOSALS))

    def test_asking_for_a_role_change_calls_nothing(self):
        rpc = RecordingRpc(ctx={"ok": True, "answered": False, "request": "Make Sam an admin", "history": []})
        llm = FakeLLM([{"action": "tool", "tool": "grant_admin", "args": {"user": "sam"}}, {"action": "reply", "reply": "x"}])
        chat.handle(deps(rpc, llm), {"thread_id": "t", "message_id": 1})
        self.assertEqual([n for n in rpc.called() if "chat_tool" in n or "propose" in n], [])

    def test_enum_and_range_arguments_are_forced(self):
        self.assertEqual(chat.clean_args("set_autonomy", {"autonomy": "autonomous"}), {"autonomy": "autonomous"})
        self.assertEqual(chat.clean_args("set_autonomy", {"autonomy": "everything"}), {})
        self.assertEqual(chat.clean_args("set_campaign_cap", {"type": "indie_game_developer", "daily_cap": 500}), {"type": "indie_game_developer", "daily_cap": 30})
        self.assertEqual(chat.clean_args("review_prospect", {"prospect_id": U, "action": "delete"}), {"prospect_id": U})
        self.assertEqual(chat.clean_args("enable_sending", {"anything": 1}), {})

    def test_the_prompt_tells_the_model_it_cannot_confirm_or_change_roles(self):
        p = chat.SYSTEM.lower()
        self.assertIn("never say it is done", p); self.assertIn("roles", p); self.assertIn("presses confirm", p)

    def test_model_down_cannot_propose_anything(self):
        for text in ("approve all the drafts", "turn sending on", "make me admin", "set autonomy to autonomous"):
            self.assertIsNone(chat.fallback_plan(text), text)


if __name__ == "__main__":
    unittest.main()
