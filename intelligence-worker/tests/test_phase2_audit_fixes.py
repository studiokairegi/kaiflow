"""Regression tests for the Phase 2 audit findings (high/medium)."""
import json
import unittest
from unittest.mock import patch

from kairflow_intel import drafting, jobs, policy
from kairflow_intel.errors import PermanentError, TransientError
from kairflow_intel.ollama import OllamaClient
from .helpers import CFG
from .test_logic import EV, KB, P, SETTINGS

FOOTER = policy.compliance_footer(SETTINGS)
TH = drafting.SIMILARITY_THRESHOLD


def tmpl(opener):
    return (opener + "\nWe do 2D animation, cleanup and in-betweening for indie teams. Our pipeline keeps revisions fast and predictable.\n"
            "If useful, I can send a short reel and a sample timeline for your next milestone.")


def compose(body, subject="A thought on Pixel Moon's hand-drawn adventure", ev=None, ids=("e0",), kind="initial", **kw):
    ev = EV if ev is None else ev
    return drafting.compose_english(P, ev, KB, SETTINGS, lambda i, p, s: {"subject": subject, "body": body, "evidence_ids": list(ids)}, kind=kind, **kw)


class ReusedTemplate(unittest.TestCase):          # audit #1
    def test_template_reused_across_three_priors_is_still_a_duplicate(self):
        priors = [{"subject": "Hello", "body": tmpl(o) + "\n" + FOOTER} for o in ("Hi Ana, saw your trailer.", "Hi Ben, saw your demo.", "Hi Cy, saw your site.")]
        new = {"subject": "Hello", "body": tmpl("Hi Dee, saw your page.") + "\n" + FOOTER}
        self.assertFalse(drafting.uniqueness_check(new, priors[:1], TH, footer=FOOTER)["ok"])
        self.assertFalse(drafting.uniqueness_check(new, priors, TH, footer=FOOTER)["ok"])

    def test_shared_footer_alone_does_not_cause_a_false_positive(self):
        a = {"subject": "A", "body": "Your cinematic trailer has a quiet, painterly mood that caught my eye today.\n" + FOOTER}
        b = {"subject": "B", "body": "Congratulations on the Kickstarter milestone; the rewards tiers look carefully planned.\n" + FOOTER}
        self.assertTrue(drafting.uniqueness_check(a, [b, b, b], TH, footer=FOOTER)["ok"])


class FabricatedClaims(unittest.TestCase):         # audit #2
    def test_untriggered_sentences_cannot_carry_fabricated_claims(self):
        for sentence in ("Pixel Moon is hiring animators.", "Pixel Moon is outsourcing its animation work this year.",
                         "Pixel Moon recently secured publisher funding.", "Pixel Moon won the Independent Games Festival grand prize.",
                         "Nintendo has praised the hand-drawn 2D adventure."):
            body = "The hand-drawn 2D adventure and cinematic trailer seem like a distinctive direction. " + sentence
            with self.subTest(sentence), self.assertRaises(PermanentError):
                compose(body)

    def test_grounded_draft_still_passes(self):
        mail = compose("The hand-drawn 2D adventure and cinematic trailer seem like a distinctive direction. We make 2D character animation and trailers for indie games.")
        self.assertTrue(mail["model_written"])


class TransientModelFailure(unittest.TestCase):    # audit #4
    def test_transient_error_is_not_converted_to_permanent(self):
        def down(i, p, s): raise TransientError("ollama down")
        with self.assertRaises(TransientError):
            drafting.compose_english(P, EV, KB, SETTINGS, down, kind="initial")

    def test_h_draft_propagates_transient_without_flagging(self):
        calls = []
        ctx = {"prospect": {**P, "status": "lead_linked", "contact_email": "a@b.test"}, "evidence": EV, "lead": {}, "messages": []}
        kb = [{"key": k, "body": v["body"]} for k, v in KB.items()] if isinstance(KB, dict) else KB
        st = {**SETTINGS, "autonomy": "shadow"}
        def rpc(name, p=None):
            calls.append(name)
            return {"intel_agent_context": ctx, "intel_agent_settings": st, "intel_agent_kb": kb}.get(name)
        class Llm:
            def generate_json(self, *a, **k): raise TransientError("ollama down")
        with self.assertRaises(TransientError):
            jobs.h_draft(jobs.Deps(cfg=CFG, rpc=rpc, fetcher=None, zoho=None, llm=Llm()), {"payload": {"prospect_id": "p1", "kind": "initial"}})
        self.assertNotIn("intel_agent_flag_prospect", calls)


class QuotedInbound(unittest.TestCase):            # audit #5
    INB = {"id": "m1", "subject": "Re: hello", "class": "interested", "summary": "",
           "body": "Sure, send me your portfolio link.\n\nOn Mon, Studio Kairegi wrote:\n> If you would rather not hear from us, reply \"unsubscribe\".\n"}

    def test_our_quoted_footer_does_not_make_a_reply_consequential(self):
        self.assertFalse(drafting._is_consequential_inbound(self.INB))

    def test_real_unquoted_optout_is_still_consequential(self):
        self.assertTrue(drafting._is_consequential_inbound({**self.INB, "body": "Please unsubscribe me.\n> quoted"}))

    def test_relevance_check_ignores_quoted_text(self):
        inb = {**self.INB, "body": "Can you send the portfolio link?\n\nOn Mon, X wrote:\n> we could also set up a call"}
        self.assertTrue(drafting._reply_addresses_inbound("Here is the portfolio link: https://studio.test/portfolio", inb))

    def test_bottom_posted_reply_is_not_read_as_empty(self):        # fail-open found on re-review
        inb = {**self.INB, "body": "On Mon, Alex wrote:\n> Hi Rina, we do 2D animation.\n\nWhat is your price per minute and can you sign an NDA?"}
        self.assertTrue(drafting._is_consequential_inbound(inb))

    def test_outlook_style_top_and_bottom_posts(self):
        top = {**self.INB, "body": "Please send the portfolio link.\n\n-----Original Message-----\nFrom: Alex\nreply unsubscribe"}
        self.assertFalse(drafting._is_consequential_inbound(top))
        bottom = {**self.INB, "body": "-----Original Message-----\nFrom: Alex\nSent: Monday\nHi Rina\n\nWhat does a project cost?"}
        self.assertTrue(drafting._is_consequential_inbound(bottom))


class NaturalPhrasing(unittest.TestCase):          # false positives found on re-review
    CORE = "The hand-drawn 2D adventure and cinematic trailer seem like a distinctive direction. "

    def test_sender_name_and_signoff_are_not_claims(self):
        for tail in ("Best, Alex", "Thanks, Rina."):
            with self.subTest(tail):
                self.assertTrue(compose(self.CORE + tail)["model_written"])

    def test_ascii_and_curly_wont_contractions_are_not_risky_claims(self):
        # Neither typographic form may be rejected by the high-specificity “won” guard.
        for contraction in ("won't", "won’t", "won‘t"):
            with self.subTest(contraction=contraction):
                try:
                    compose(self.CORE + f"We {contraction} take much of your time.")
                except PermanentError as exc:
                    self.assertNotIn("high-specificity", str(exc))

    def test_real_won_claim_still_blocked(self):
        with self.assertRaises(PermanentError):
            compose(self.CORE + "Your team won the grand prize.")


class PolicyPhrasing(unittest.TestCase):           # audit #6
    def test_feel_free_is_not_a_price_mention(self):
        self.assertFalse(policy.PRICE_IN_DRAFT.search("Feel free to reply anytime."))

    def test_real_free_offers_still_blocked(self):
        for t in ("We offer a free trial.", "Happy to do it for free.", "A free quote is on us.", "Complimentary samples."):
            self.assertTrue(policy.PRICE_IN_DRAFT.search(t), t)

    def test_composer_and_policy_share_one_length_limit(self):
        long_body = "The hand-drawn 2D adventure and cinematic trailer seem like a distinctive direction. " + "x" * (policy.MAX_BODY_CHARS - len(FOOTER) - 60)
        with self.assertRaises(PermanentError):
            compose(long_body + " y" * 200)

    def test_policy_failure_flags_prospect_instead_of_silent_failure(self):
        calls = []
        ctx = {"prospect": {**P, "status": "lead_linked", "contact_email": "a@b.test"}, "evidence": EV, "lead": {}, "messages": []}
        kb = [{"key": k, "body": v["body"]} for k, v in KB.items()] if isinstance(KB, dict) else KB
        st = {**SETTINGS, "autonomy": "shadow"}
        def rpc(name, p=None):
            calls.append((name, p or {}))
            return {"intel_agent_context": ctx, "intel_agent_settings": st, "intel_agent_kb": kb, "intel_agent_recent_outbound": []}.get(name)
        mail = {"subject": "Hi", "body": "Body", "model_written": True}
        with patch("kairflow_intel.drafting.compose_english", return_value=mail), patch("kairflow_intel.policy.validate_outbound", return_value=["mentions price"]):
            with self.assertRaises(PermanentError):
                jobs.h_draft(jobs.Deps(cfg=CFG, rpc=rpc, fetcher=None, zoho=None, llm=None), {"payload": {"prospect_id": "p1", "kind": "initial"}})
        self.assertIn("intel_agent_flag_prospect", [n for n, _ in calls])


class PayloadBudget(unittest.TestCase):            # audit #7
    def test_schema_bearing_facts_lead_and_payload_fits_the_budget(self):
        evidence = [{"verified": True, "id": f"r{i}", "snippet": ("Research detail %d about the hand-drawn game. " % i) * 11, "url": "https://x.test/" + "a" * 200} for i in range(35)]
        seen = {}
        def writer(i, payload, s):
            seen["payload"] = payload
            return {"subject": "A thought on Pixel Moon's hand-drawn game", "body": "Research detail 0 about the hand-drawn game.", "evidence_ids": ["r0"]}
        drafting.compose_english(P, evidence, KB, SETTINGS, writer, kind="initial")
        self.assertLessEqual(len(seen["payload"]), drafting.PAYLOAD_BUDGET)
        data = json.loads(seen["payload"])
        self.assertEqual(list(data)[:2], ["message_kind", "approved_studio_facts"])
        self.assertTrue(data["approved_studio_facts"]); self.assertEqual(data["message_kind"], "initial")

    def test_reply_payload_keeps_the_message_being_answered(self):
        seen = {}
        inbound = {"id": "m9", "subject": "Re: hi", "body": "Could you send your portfolio link please?", "class": "interested", "summary": ""}
        def writer(i, payload, s):
            seen["p"] = json.loads(payload)
            return {"subject": "Re: hi", "body": "Here is our portfolio link: https://studio.test/portfolio", "evidence_ids": ["m9", "e0"]}
        drafting.compose_english(P, EV, KB, SETTINGS, writer, kind="reply", inbound=inbound)
        self.assertIn("portfolio link", seen["p"]["incoming_message"]["body"])

    def test_ollama_no_longer_cuts_a_normal_payload(self):
        sent = {}
        class R:
            status_code = 200
            def json(self): return {"message": {"content": "{}"}}
        class S:
            def post(self, url, json=None, timeout=None): sent["p"] = json; return R()
        OllamaClient(CFG, S()).generate_json("i", "x" * 16600, {"type": "object"})
        content = sent["p"]["messages"][1]["content"]
        self.assertTrue(content.count("x") == 16600)
        self.assertGreater(sent["p"]["options"]["num_ctx"], 4096)


class StableEvidenceIds(unittest.TestCase):        # audit #8
    def test_ids_do_not_depend_on_position(self):
        a = {"verified": True, "snippet": "Hand-drawn adventure with a trailer", "fact_type": "x", "url": "u"}
        b = {"verified": True, "snippet": "Kickstarter planned for spring", "fact_type": "y", "url": "v"}
        ids1 = {e["snippet"]: e["id"] for e in drafting._evidence_catalog([a, b])}
        ids2 = {e["snippet"]: e["id"] for e in drafting._evidence_catalog([{"verified": False, "snippet": "dropped"}, b, a])}
        self.assertEqual(ids1, ids2)
        self.assertFalse(any(i.startswith("e") and i[1:].isdigit() for i in ids1.values()))

    def test_database_id_is_preferred_and_audit_trace_keeps_the_text(self):
        mail = compose("The hand-drawn 2D adventure and cinematic trailer seem like a distinctive direction.")
        self.assertEqual(mail["evidence_trace"][0]["id"], "e0")
        self.assertIn("Hand-drawn", mail["evidence_trace"][0]["snippet"])


if __name__ == "__main__":
    unittest.main()


class ReplyPath(unittest.TestCase):                # audit #3 and the #4 reply case
    def _run(self, llm, calls=None):
        calls = [] if calls is None else calls
        ctx = {"prospect": {**P, "status": "contacted", "contact_email": "rina@pixelmoon.com"}, "evidence": EV, "lead": {}, "messages": []}
        kb = [{"key": k, "body": v["body"]} for k, v in KB.items()] if isinstance(KB, dict) else KB
        msg = {"id": "m1", "prospect_id": "p1", "from_email": "rina@pixelmoon.com", "subject": "Re: hi", "rfc_message_id": "<a@b>",
               "body_text": "Thanks, could you send your portfolio link?\n\nOn Mon, Alex wrote:\n> reply unsubscribe"}
        def rpc(name, p=None):
            calls.append((name, p or {}))
            return {"intel_agent_settings": {**SETTINGS, "autonomy": "assisted"}, "intel_agent_kb": kb, "intel_agent_context": ctx,
                    "intel_agent_unprocessed_inbound": [msg], "intel_agent_recent_outbound": [],
                    "intel_agent_upsert_draft": {"ok": True, "message_id": "r1", "state": "pending_approval"}}.get(name)
        return calls, jobs.h_classify(jobs.Deps(cfg=CFG, rpc=rpc, fetcher=None, zoho=None, llm=llm), {"payload": {}})

    def test_model_written_reply_is_never_auto_approved(self):
        class Llm:
            def generate_json(self, instruction, payload, schema, **kw):
                if "label" in schema.get("properties", {}):
                    return {"label": "portfolio_request", "confidence": 0.95, "summary": "asks for portfolio link"}
                return {"subject": "Re: hi", "body": "Here is our portfolio link: https://studio.test/portfolio", "evidence_ids": ["m1", "e0"]}
        calls, _ = self._run(Llm())
        drafts = [p for n, p in calls if n == "intel_agent_upsert_draft"]
        self.assertEqual(len(drafts), 1)
        self.assertFalse(drafts[0]["p_auto_ok"])
        names = [n for n, _ in calls]
        # classification is saved only after the draft is stored, so a failed store retries the whole job
        self.assertLess(names.index("intel_agent_upsert_draft"), names.index("intel_agent_classify_inbound"))

    def test_transient_outage_leaves_message_unclassified_so_the_job_retries(self):
        class Llm:
            def generate_json(self, instruction, payload, schema, **kw):
                if "label" in schema.get("properties", {}):
                    return {"label": "portfolio_request", "confidence": 0.95, "summary": "asks for portfolio link"}
                raise TransientError("ollama down")
        calls = []
        with self.assertRaises(TransientError):
            self._run(Llm(), calls)
        names = [n for n, _ in calls]
        self.assertNotIn("intel_agent_classify_inbound", names)
        self.assertNotIn("intel_agent_flag_prospect", names)
