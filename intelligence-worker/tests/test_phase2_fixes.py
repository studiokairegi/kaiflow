"""Regression tests for the Phase 2 review fixes."""
import json
import unittest
from types import SimpleNamespace

from kairflow_intel import drafting, jobs, policy
from kairflow_intel.errors import PermanentError, RpcError

KB = [{"key": "studio.about", "body": "Studio Kairegi is a small 2D animation studio."},
      {"key": "portfolio.main", "body": "Our reel is at https://studiokairegi.com/reel."},
      {"key": "services.indie_game_developer", "body": "We make anime-style promotional animation for game teams."}]
ST = {"sender_email": "a@studiokairegi.com", "sender_name": "Alex", "physical_address": "1 Main St, Nairobi",
      "opt_out_text": "Reply STOP to opt out.", "kill_switch": False, "today": "2026-11-07", "campaigns": []}
PROSPECT = {"id": "p1", "name": "Frostbyte Games", "type": "indie_game_developer", "contact_name": "Sam Lee", "status": "replied", "domain": "frostbyte.example"}
EVIDENCE = [{"verified": True, "snippet": "Frostbyte released Ember Trail in 2023 on Steam.", "fact_type": "about", "url": "https://frostbyte.example"}]


def compose(body, *, subject="Ember Trail", kind="initial", inbound=None, evidence=EVIDENCE):
    cat = drafting._evidence_catalog(evidence, inbound=inbound, history=[], kind=kind)
    ids = [e["id"] for e in cat if e["fact_type"] != "sent_outreach_history"]
    llm = lambda i, p, s: {"subject": subject, "body": body, "evidence_ids": ids}
    return drafting.compose_english(PROSPECT, evidence, drafting.kb_map(KB), ST, llm, kind=kind, inbound=inbound, history=[])


class GreetingAndNumbers(unittest.TestCase):
    def test_greeting_does_not_force_or_break_first_sentence(self):
        # Before the fix: rejected (capital "Your" after the greeting; name forced the personalized check).
        compose("Hello Sam,\n\nYour release Ember Trail is on Steam.")
        compose("Hello Sam,\n\nThanks to the Steam page I saw Ember Trail.")

    def test_service_sentence_after_greeting(self):
        inbound = {"id": "m1", "subject": "Re: hi", "body": "Thanks, could you send your portfolio link?", "class": "positive", "summary": ""}
        compose("Hello Sam,\n\nI can share our portfolio: https://studiokairegi.com/reel.", subject="Re: hi", kind="reply", inbound=inbound)

    def test_sourced_year_allowed_unsourced_year_rejected(self):
        compose("Hello Sam,\n\nI saw your 2023 release Ember Trail on Steam.")
        with self.assertRaises(PermanentError):
            compose("Hello Sam,\n\nI saw your 2025 release Ember Trail on Steam.")

    def test_unsupported_claim_still_rejected_after_greeting(self):
        with self.assertRaises(PermanentError):
            compose("Hello Sam,\n\nCongratulations on the record funding round for Frostbyte.")

    def test_signoff_not_treated_as_claim(self):
        compose("Hello Sam,\n\nI saw your release Ember Trail on Steam.\n\nBest,\nAlex")


class ReplyRelevance(unittest.TestCase):
    INBOUND = {"id": "m9", "subject": "Re: 2D animation for Frostbyte Games", "body": "Do you work with Unity? Could you send a portfolio link?", "class": "positive", "summary": ""}

    def test_echoing_the_subject_is_not_an_answer(self):
        inbound = {**self.INBOUND, "body": "Which engines have you shipped on, and what is your pipeline like?"}
        self.assertFalse(drafting._reply_addresses_inbound("Thanks for the note about 2D animation for Frostbyte Games.", inbound))

    def test_substring_does_not_count(self):
        self.assertFalse(drafting._reply_addresses_inbound("Our sender is Alex, linked below.", self.INBOUND))

    def test_real_answer_passes(self):
        self.assertTrue(drafting._reply_addresses_inbound("Here is our portfolio link: https://studiokairegi.com/reel", self.INBOUND))


class CurlyQuotes(unittest.TestCase):
    def test_unsubscribe_with_curly_apostrophe(self):
        self.assertIn("unsubscribe", policy.scan_inbound("Re: hi", "Please don\u2019t contact us again.")["hits"])
        self.assertTrue(drafting._is_consequential_inbound({"subject": "Re: hi", "body": "Please don\u2019t contact us again."}))


class ClassifyOrdering(unittest.TestCase):
    def _run(self, failing):
        calls = []
        inbound = {"id": "m1", "prospect_id": "p1", "from_email": "sam@frostbyte.example", "subject": "Re: 2D animation for Frostbyte Games",
                   "body_text": "Thanks, could you send your portfolio link?", "rfc_message_id": "<x@y>"}
        def rpc(name, params):
            calls.append(name)
            if name == failing:
                raise RpcError("network blip")
            return {"intel_agent_settings": ST, "intel_agent_kb": KB, "intel_agent_unprocessed_inbound": [inbound],
                    "intel_agent_context": {"prospect": PROSPECT, "evidence": EVIDENCE, "messages": []},
                    "intel_agent_recent_outbound": [],
                    "intel_agent_upsert_draft": {"ok": True, "message_id": "d-1", "state": "pending_approval"}}.get(name, {})
        class LLM:
            def generate_json(self, instr, payload, schema, fast=False, **k):
                if "Labels:" in instr:
                    return {"label": "portfolio_request", "confidence": 0.9, "summary": "asks for portfolio"}
                pl = json.loads(payload)
                return {"subject": "Re: 2D animation for Frostbyte Games", "body": "Hello Sam,\n\nI can share our portfolio: https://studiokairegi.com/reel.",
                        "evidence_ids": [pl["incoming_message"]["id"]] + [e["id"] for e in pl["verified_evidence"] if e["fact_type"] == "about"]}
        d = jobs.Deps(cfg=SimpleNamespace(worker_id="w"), rpc=rpc, fetcher=None, zoho=None, llm=LLM())
        try:
            jobs.h_classify(d, {"payload": {"message_id": "m1"}})
            err = None
        except RpcError as exc:
            err = exc
        return calls, err

    def test_failed_draft_store_leaves_message_pending(self):
        calls, err = self._run("intel_agent_upsert_draft")
        self.assertIsNotNone(err)
        self.assertNotIn("intel_agent_classify_inbound", calls)

    def test_failed_history_lookup_leaves_message_pending(self):
        calls, err = self._run("intel_agent_recent_outbound")
        self.assertIsNotNone(err)
        self.assertNotIn("intel_agent_classify_inbound", calls)

    def test_success_saves_classification_after_draft(self):
        calls, err = self._run(None)
        self.assertIsNone(err)
        self.assertLess(calls.index("intel_agent_upsert_draft"), calls.index("intel_agent_classify_inbound"))


class RetryDoesNotFlagItself(unittest.TestCase):
    def test_own_earlier_copy_is_excluded(self):
        calls = []
        own = {"id": "d1", "prospect_id": "p1", "kind": "initial", "state": "pending_approval", "idempotency_key": "draft:p1:initial",
               "subject": "Ember Trail", "body_text": "Hello Sam,\n\nI saw your release Ember Trail on Steam, and we make anime-style promotional animation for game teams.\n" + policy.compliance_footer(ST)}
        prospect = {**PROSPECT, "status": "lead_linked", "contact_email": "sam@frostbyte.example"}
        def rpc(name, params):
            calls.append((name, params))
            return {"intel_agent_settings": ST, "intel_agent_kb": KB,
                    "intel_agent_context": {"prospect": prospect, "evidence": EVIDENCE, "messages": []},
                    "intel_agent_recent_outbound": [own]}.get(name, {"ok": True, "state": "pending_approval", "message_id": "d1"})
        class LLM:
            def generate_json(self, instr, payload, schema, **k):
                pl = json.loads(payload)
                return {"subject": "Ember Trail", "body": "Hello Sam,\n\nI saw your release Ember Trail on Steam, and we make anime-style promotional animation for game teams.",
                        "evidence_ids": [e["id"] for e in pl["verified_evidence"]]}
        d = jobs.Deps(cfg=SimpleNamespace(worker_id="w"), rpc=rpc, fetcher=None, zoho=None, llm=LLM())
        out = jobs.h_draft(d, {"payload": {"prospect_id": "p1", "kind": "initial"}})
        self.assertNotEqual(out.get("skipped"), "manual_review_required")
        self.assertIn("intel_agent_upsert_draft", [c[0] for c in calls])


class MigrationContract(unittest.TestCase):
    SQL = open(__import__("pathlib").Path(__file__).resolve().parents[2] / "supabase/migrations/20261121090000_intelligence_phase2_fixes.sql", encoding="utf-8").read()

    def test_reengagement_needs_more_than_one_followup(self):
        self.assertIn("s.max_followups >= 2", self.SQL)
        self.assertIn(">= s.max_followups - 1", self.SQL)

    def test_flagged_prospects_excluded(self):
        self.assertIn("p.review_reason !~", self.SQL)

    def test_recent_outbound_returns_key(self):
        self.assertIn("idempotency_key, created_at", self.SQL)


class BottomPostedReplies(unittest.TestCase):
    QUOTE = "On Mon, Nov 2, 2026 at 9:00 AM Alex <a@studiokairegi.com> wrote:\n> Hello Sam, we make anime-style promo animation.\n"

    def test_scan_inbound_sees_reply_below_quote(self):
        body = self.QUOTE + "\nPlease unsubscribe me, and what are your rates?"
        hits = policy.scan_inbound("Re: hi", body)["hits"]
        self.assertIn("unsubscribe", hits)

    def test_top_posted_still_ignores_quoted_history(self):
        body = "Sounds interesting, send the reel.\n\n" + self.QUOTE + "> our rates are low\n"
        self.assertNotIn("pricing", policy.scan_inbound("Re: hi", body)["hits"])
        self.assertEqual(policy.first_unquoted(body), "Sounds interesting, send the reel.")

    def test_outlook_block_with_reply_below(self):
        body = "-----Original Message-----\nFrom: Alex\nSent: Monday\n\nPlease stop emailing us."
        self.assertIn("unsubscribe", policy.scan_inbound("Re: hi", body)["hits"])


class NameSwapWithOddNames(unittest.TestCase):
    A = "Hello Tim,\n\nI saw 2K Games shipped a hand painted adventure, and we make anime-style promotional animation for game teams.\n"
    B = "Hello Rae,\n\nI saw id Software shipped a hand painted adventure, and we make anime-style promotional animation for game teams.\n"

    def test_swapped_names_caught_when_names_known(self):
        res = drafting.uniqueness_check({"subject": "s", "body": self.A}, [{"subject": "s2", "body": self.B, "names": ["id Software", "Rae"]}],
                                        threshold=drafting.SIMILARITY_THRESHOLD, names=["2K Games", "Tim"])
        self.assertFalse(res["ok"])

    def test_structural_skeleton_masks_lowercase_names(self):
        a = "Hello Tim,\n\nthe studio called id software released a great adventure last year and we can help with layout.\n"
        b = "Hello Rae,\n\nthe studio called nova forge released a great adventure last year and we can help with layout.\n"
        res = drafting.uniqueness_check({"subject": "x", "body": a}, [{"subject": "y", "body": b, "names": ["Nova Forge", "Rae"]}],
                                        threshold=0.99, names=["id Software", "Tim"])
        self.assertFalse(res["ok"])

    def test_genuinely_different_messages_still_pass(self):
        a = "Hello Tim,\n\nYour puzzle game uses gravity-based movement across compact levels.\n"
        b = "Hello Rae,\n\nYour team publishes developer diaries about narrative design and worldbuilding.\n"
        self.assertTrue(drafting.uniqueness_check({"subject": "x", "body": a}, [{"subject": "y", "body": b, "names": ["Nova Forge", "Rae"]}],
                                                  threshold=drafting.SIMILARITY_THRESHOLD, names=["id Software", "Tim"])["ok"])

    def test_masking_does_not_eat_substrings(self):
        self.assertEqual(drafting._mask_names("The 2Kings crew", ["2K Games"]), "The 2Kings crew")


class RegenerationAndTrace(unittest.TestCase):
    DUP = "Hello Sam,\n\nI saw your release Ember Trail on Steam, and we make anime-style promotional animation for game teams."
    FRESH = "Hello Sam,\n\nFrostbyte released Ember Trail on Steam in 2023. Our reel is at https://studiokairegi.com/reel."

    def _run(self, bodies, rpc_fail=None):
        calls, prompts = [], []
        prospect = {**PROSPECT, "status": "lead_linked", "contact_email": "sam@frostbyte.example"}
        other = {"id": "d9", "prospect_id": "p2", "kind": "initial", "state": "sent", "idempotency_key": "draft:p2:initial", "subject": "Ember Trail",
                 "body_text": self.DUP + "\n" + policy.compliance_footer(ST), "prospect_name": "Other Games", "contact_name": "Lee"}
        def rpc(name, params):
            calls.append((name, params))
            if name == rpc_fail:
                raise RpcError("boom")
            return {"intel_agent_settings": ST, "intel_agent_kb": KB,
                    "intel_agent_context": {"prospect": prospect, "evidence": EVIDENCE, "messages": []},
                    "intel_agent_recent_outbound": [other]}.get(name, {"ok": True, "state": "pending_approval", "message_id": "d1"})
        outputs = list(bodies)
        class LLM:
            def generate_json(self, instr, payload, schema, **k):
                prompts.append(instr)
                pl = json.loads(payload)
                return {"subject": "Ember Trail", "body": outputs.pop(0), "evidence_ids": [e["id"] for e in pl["verified_evidence"]]}
        d = jobs.Deps(cfg=SimpleNamespace(worker_id="w"), rpc=rpc, fetcher=None, zoho=None, llm=LLM())
        out = jobs.h_draft(d, {"payload": {"prospect_id": "p1", "kind": "initial"}})
        return out, calls, prompts

    def test_duplicate_is_regenerated_once_and_then_stored(self):
        out, calls, prompts = self._run([self.DUP, self.FRESH])
        names = [c[0] for c in calls]
        self.assertEqual(len(prompts), 2)
        self.assertIn("rejected", prompts[1])
        self.assertIn("draft_regenerating", [c[1].get("p_action") for c in calls if c[0] == "intel_agent_log"])
        drafts = [c[1] for c in calls if c[0] == "intel_agent_upsert_draft"]
        self.assertEqual(len(drafts), 1)
        self.assertIn("released Ember Trail on Steam in 2023", drafts[0]["p_body"])
        self.assertNotIn("intel_agent_flag_prospect", names)

    def test_second_failure_goes_to_manual_review_without_a_third_try(self):
        out, calls, prompts = self._run([self.DUP, self.DUP])
        names = [c[0] for c in calls]
        self.assertEqual(len(prompts), 2)
        self.assertEqual(out.get("skipped"), "manual_review_required")
        self.assertIn("intel_agent_flag_prospect", names)
        self.assertNotIn("intel_agent_upsert_draft", names)

    def test_clean_first_draft_is_not_regenerated(self):
        out, calls, prompts = self._run([self.FRESH])
        self.assertEqual(len(prompts), 1)
        self.assertNotIn("draft_regenerating", [c[1].get("p_action") for c in calls if c[0] == "intel_agent_log"])

    def test_evidence_trace_stored_on_the_message(self):
        out, calls, _ = self._run([self.FRESH])
        sets = [c[1] for c in calls if c[0] == "intel_agent_set_message_evidence"]
        self.assertEqual(len(sets), 1)
        self.assertEqual(sets[0]["p_message_id"], "d1")
        self.assertTrue(sets[0]["p_evidence"] and "Ember Trail" in sets[0]["p_evidence"][0]["snippet"])
        names = [c[0] for c in calls]
        self.assertLess(names.index("intel_agent_upsert_draft"), names.index("intel_agent_set_message_evidence"))

    def test_trace_failure_does_not_lose_the_draft(self):
        out, calls, _ = self._run([self.FRESH], rpc_fail="intel_agent_set_message_evidence")
        self.assertTrue(out.get("ok"))
        self.assertIn("evidence_trace_not_stored", [c[1].get("p_action") for c in calls if c[0] == "intel_agent_log"])

    def test_database_evidence_id_is_used_when_present(self):
        ev = [{**EVIDENCE[0], "id": "11111111-2222-3333-4444-555555555555"}]
        cat = drafting._evidence_catalog(ev, kind="initial")
        self.assertEqual(cat[0]["id"], "11111111-2222-3333-4444-555555555555")


class ReplyRegeneration(unittest.TestCase):
    BODY = "Hello Sam,\n\nI can share our portfolio: https://studiokairegi.com/reel."

    def test_duplicate_reply_is_regenerated_once_then_flagged(self):
        calls, gens = [], []
        inbound = {"id": "m1", "prospect_id": "p1", "from_email": "sam@frostbyte.example", "subject": "Re: 2D animation for Frostbyte Games",
                   "body_text": "Thanks, could you send your portfolio link?", "rfc_message_id": "<x@y>"}
        prior = {"id": "r9", "prospect_id": "p2", "kind": "reply", "state": "sent", "idempotency_key": "reply:other", "subject": "Re: x",
                 "body_text": self.BODY + "\n" + policy.compliance_footer(ST), "prospect_name": "Other Games", "contact_name": "Lee"}
        def rpc(name, params):
            calls.append(name)
            return {"intel_agent_settings": ST, "intel_agent_kb": KB, "intel_agent_unprocessed_inbound": [inbound],
                    "intel_agent_context": {"prospect": PROSPECT, "evidence": EVIDENCE, "messages": []},
                    "intel_agent_recent_outbound": [prior]}.get(name, {})
        class LLM:
            def generate_json(self, instr, payload, schema, fast=False, **k):
                if "Labels:" in instr:
                    return {"label": "portfolio_request", "confidence": 0.9, "summary": "asks for portfolio"}
                gens.append(instr)
                pl = json.loads(payload)
                return {"subject": "Re: 2D animation for Frostbyte Games", "body": ReplyRegeneration.BODY,
                        "evidence_ids": [pl["incoming_message"]["id"]] + [e["id"] for e in pl["verified_evidence"] if e["fact_type"] == "about"]}
        d = jobs.Deps(cfg=SimpleNamespace(worker_id="w"), rpc=rpc, fetcher=None, zoho=None, llm=LLM())
        jobs.h_classify(d, {"payload": {"message_id": "m1"}})
        self.assertEqual(len(gens), 2)
        self.assertIn("rejected", gens[1])
        self.assertIn("intel_agent_flag_prospect", calls)
        self.assertNotIn("intel_agent_upsert_draft", calls)
        self.assertIn("intel_agent_classify_inbound", calls)   # still classified once the reply has been dealt with


class EvidenceTraceMigration(unittest.TestCase):
    SQL = open(__import__("pathlib").Path(__file__).resolve().parents[2] / "supabase/migrations/20261122090000_intelligence_phase2_evidence_trace.sql", encoding="utf-8").read()

    def test_column_rpc_and_grants(self):
        self.assertIn("add column if not exists evidence_trace jsonb", self.SQL)
        self.assertIn("and evidence_trace is null", self.SQL)   # write-once
        self.assertIn("revoke all on function public.intel_agent_set_message_evidence(uuid, jsonb) from public, anon", self.SQL)
        self.assertIn("grant execute on function public.intel_agent_set_message_evidence(uuid, jsonb) to authenticated", self.SQL)

    def test_context_returns_evidence_id_and_recent_outbound_names(self):
        self.assertIn("jsonb_build_object('id', e.id, 'source', e.source", self.SQL)
        self.assertIn("p.name as prospect_name, p.contact_name", self.SQL)
        self.assertIn("m.idempotency_key", self.SQL)


if __name__ == "__main__":
    unittest.main()
