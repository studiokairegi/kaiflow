"""Phase 6: ambiguous-evidence review helper. This never changes a score or decision; it only ever
adds an explanation next to an already-decided needs_review result, and always degrades to a
deterministic explanation when there is no model, the model fails, or its answer is not grounded."""
import unittest

from kairflow_intel import qualification_review as qr
from kairflow_intel.ai_types import AIResult
from kairflow_intel.airouter import AIRouter, RouterSettings
from .test_ai_router import Clock, FakeGemini, FakeOllama

MODEL = "gemini-3.8-flash"


def result(decision="needs_review", score=60, reason="Partial evidence of active development.",
           uncertain=None, breakdown=None):
    from kairflow_intel.scoring import Result
    # `or` would silently swap an explicitly-empty [] back to the default, which is not what a caller
    # testing the empty case means; check for None instead so [] stays [].
    if breakdown is None:
        breakdown = [{"criterion": "active_development", "items": [
            {"item": "recent_update", "points": 5, "max": 15, "why": "one unverified mention of a recent update"}]}]
    if uncertain is None:
        uncertain = ["recent_update"]
    return Result(score=score, decision=decision, reason=reason, breakdown=breakdown, model="indie-project-v2", uncertain=uncertain)


EVIDENCE = [{"fact_type": "recent_update", "snippet": "The team posted a devlog update last month.", "verified": True}]


class FakeLLM:
    def __init__(self, answer=None, exc=None):
        self.answer, self.exc, self.sent = answer, exc, []

    def generate_json_ex(self, site, instruction, untrusted, schema, *, fast=False, **kw):
        self.sent.append({"site": site, "instruction": instruction, "untrusted": untrusted})
        if self.exc:
            raise self.exc
        return AIResult(data=self.answer, provider="gemini", model=MODEL, model_reported=MODEL, site=site)


def setUpModule():
    qr._calls.clear()


class ConfidenceIndicatorTests(unittest.TestCase):
    def test_gate_failure_rejection_is_high_confidence(self):
        res = result(decision="rejected", score=30, uncertain=[])
        res.mandatory_gates = {"verifiable_project": {"passed": False}}
        self.assertEqual(qr.confidence_indicator(res, 75, 55)["level"], "high")

    def test_levels_follow_margin_and_uncertainty(self):
        self.assertEqual(qr.confidence_indicator(result(decision="qualified", score=95, uncertain=[]), 75, 55)["level"], "high")
        self.assertEqual(qr.confidence_indicator(result(decision="qualified", score=83, uncertain=["a"]), 75, 55)["level"], "medium")
        self.assertEqual(qr.confidence_indicator(result(decision="qualified", score=76, uncertain=[]), 75, 55)["level"], "low")
        self.assertEqual(qr.confidence_indicator(result(decision="rejected", score=20, uncertain=[]), 75, 55)["level"], "high")
        self.assertEqual(qr.confidence_indicator(result(decision="needs_review", score=65, uncertain=["a", "b", "c"]), 75, 55)["level"], "low")

    def test_never_raises_on_garbage(self):
        self.assertEqual(qr.confidence_indicator(object(), 75, 55)["level"], "low")


class ModelBudgetTests(unittest.TestCase):
    def setUp(self):
        qr._calls.clear()
        import os
        self._old = os.environ.get("KAIRFLOW_QUAL_REVIEW_MAX_PER_HOUR")

    def tearDown(self):
        import os
        qr._calls.clear()
        if self._old is None:
            os.environ.pop("KAIRFLOW_QUAL_REVIEW_MAX_PER_HOUR", None)
        else:
            os.environ["KAIRFLOW_QUAL_REVIEW_MAX_PER_HOUR"] = self._old

    def test_over_cap_uses_deterministic_note_without_calling_model(self):
        import os
        os.environ["KAIRFLOW_QUAL_REVIEW_MAX_PER_HOUR"] = "2"
        llm = FakeLLM(GROUNDED_ANSWER)
        outs = [qr.explain_ambiguous(llm, result(), EVIDENCE) for _ in range(4)]
        self.assertEqual([o["generated_by"] for o in outs], ["model", "model", "deterministic_fallback", "deterministic_fallback"])
        self.assertEqual(len(llm.sent), 2)

    def test_zero_disables_model_and_bad_value_uses_default(self):
        import os
        os.environ["KAIRFLOW_QUAL_REVIEW_MAX_PER_HOUR"] = "0"
        llm = FakeLLM(GROUNDED_ANSWER)
        self.assertEqual(qr.explain_ambiguous(llm, result(), EVIDENCE)["generated_by"], "deterministic_fallback")
        self.assertEqual(llm.sent, [])
        os.environ["KAIRFLOW_QUAL_REVIEW_MAX_PER_HOUR"] = "abc"
        self.assertEqual(qr.explain_ambiguous(llm, result(), EVIDENCE)["generated_by"], "model")

    def test_window_rolls_after_an_hour(self):
        import os
        os.environ["KAIRFLOW_QUAL_REVIEW_MAX_PER_HOUR"] = "1"
        self.assertTrue(qr._model_budget_allows(now=1000.0))
        self.assertFalse(qr._model_budget_allows(now=1100.0))
        self.assertTrue(qr._model_budget_allows(now=1000.0 + 3601))


class NotNeedsReviewTests(unittest.TestCase):
    def test_returns_none_for_qualified_or_rejected(self):
        self.assertIsNone(qr.explain_ambiguous(FakeLLM({}), result(decision="qualified"), EVIDENCE))
        self.assertIsNone(qr.explain_ambiguous(FakeLLM({}), result(decision="rejected"), EVIDENCE))

    def test_never_exposed_for_other_decisions_even_without_llm(self):
        self.assertIsNone(qr.explain_ambiguous(None, result(decision="qualified"), EVIDENCE))


class DeterministicFallbackTests(unittest.TestCase):
    def test_no_llm_gives_fallback_built_only_from_result(self):
        res = result()
        out = qr.explain_ambiguous(None, res, EVIDENCE)
        self.assertEqual(out["generated_by"], "deterministic_fallback")
        self.assertIn("recent_update", out["key_uncertainty"])
        self.assertIsNone(out["confidence"])      # not rated; never a made-up value
        self.assertIn(str(res.score), out["summary"])

    def test_model_exception_falls_back_and_never_raises(self):
        out = qr.explain_ambiguous(FakeLLM(exc=RuntimeError("boom")), result(), EVIDENCE)
        self.assertEqual(out["generated_by"], "deterministic_fallback")

    def test_bad_confidence_value_falls_back(self):
        out = qr.explain_ambiguous(
            FakeLLM({"summary": "ok", "key_uncertainty": "ok", "confidence": "certain", "recommended_human_action": "ok"}),
            result(), EVIDENCE)
        self.assertEqual(out["generated_by"], "deterministic_fallback")

    def test_ungrounded_answer_falls_back(self):
        # None of these words appear anywhere in the evidence, breakdown or reason.
        out = qr.explain_ambiguous(
            FakeLLM({"summary": "They confirmed signing a major Netflix anime licensing deal yesterday.",
                     "key_uncertainty": "Whether the Netflix contract covers worldwide distribution rights.",
                     "confidence": "high", "recommended_human_action": "Call their legal department about the contract."}),
            result(), EVIDENCE)
        self.assertEqual(out["generated_by"], "deterministic_fallback")

    def test_fallback_never_raises_on_empty_breakdown_or_uncertain(self):
        res = result(uncertain=[], breakdown=[])
        out = qr.explain_ambiguous(None, res, [])
        self.assertEqual(out["generated_by"], "deterministic_fallback")
        self.assertIn("evidence rows directly", out["recommended_human_action"])


class RobustnessAndGroundingTests(unittest.TestCase):
    def test_fallback_handles_both_item_key_shapes_and_bad_rows(self):
        for key in ("item", "criterion", "name"):
            bd = [{"criterion": "g", "items": [{key: "recent_update", "points": 5, "max": 15}]}]
            out = qr.explain_ambiguous(None, result(breakdown=bd), EVIDENCE)
            self.assertIn("recent_update", out["recommended_human_action"])
        junk = [{"criterion": "g", "items": [{"points": 5, "max": 15}, {"item": "x", "points": None, "max": None}, "not-a-dict"]}, "bad-group"]
        out = qr.explain_ambiguous(None, result(breakdown=junk), EVIDENCE)     # must not raise
        self.assertEqual(out["generated_by"], "deterministic_fallback")

    def test_mixed_grounded_and_invented_claim_is_rejected(self):
        src = "The team posted a devlog update last month. Partial evidence of active development."
        self.assertFalse(qr._grounded("The team posted a devlog update last month and secured funding from a publisher.", src))

    def test_invented_number_or_name_is_rejected(self):
        src = "The team posted a devlog update last month."
        self.assertFalse(qr._grounded("The devlog update mentions a 50000 budget.", src))
        self.assertFalse(qr._grounded("The devlog update was written by Hiroshi.", src))

    def test_whole_word_match_not_substring(self):
        self.assertFalse(qr._grounded("Funding documents pending.", "The team is fundamentally documenting progress."))

    def test_breakdown_text_counts_as_grounding_source(self):
        res = result()
        ok = qr._grounded("Only one unverified mention of a recent update supports this.", qr._breakdown_text(res))
        self.assertTrue(ok)

    def test_contact_details_are_redacted_before_reaching_the_model(self):
        ev = [{"fact_type": "contact", "snippet": "Reach lead at jane@studio.example or +1 415 555 0100.", "verified": True}]
        llm = FakeLLM(GROUNDED_ANSWER)
        qr.explain_ambiguous(llm, result(), ev)
        sent = llm.sent[0]["untrusted"]
        self.assertNotIn("jane@studio.example", sent)
        self.assertNotIn("555 0100", sent)


class RealScoringShapeTests(unittest.TestCase):
    """Uses real scoring.score_studio / score_indie output, not hand-built fixtures: studio rows are groups with
    'item'-keyed sub-items, indie rows are flat criterion/points/max/why rows with mandatory gates."""

    @staticmethod
    def studio_pipeline_review():
        from kairflow_intel import scoring
        sig = {"role_key": "Studio Z does key animation.", "role_layout": "Layout artists wanted.", "role_inbetween": "In-betweeners wanted.",
               "role_coloring": "Colorists wanted.", "role_character": "Character animation staff wanted.", "production_active": "Season 2 is in production.",
               "multiple_titles": "Our works include A and B.", "style_2d": "We make 2D animation.", "style_2d_anime": "We make hand-drawn 2D anime.",
               "external_collab": "We take client work.", "outsourcing": "We use partner studios.", "business_inquiry": "Business inquiries welcome."}
        return scoring.score_studio(sig, {"language": "en"}, {"email": "info@studio.example", "name": "", "role": ""})

    @staticmethod
    def indie_gate_review():
        from kairflow_intel import scoring
        from .test_indie_qualification_v2 import ev, strong_meta, good_contact
        rows = [ev("project_description"), ev("devlog", "https://game.example/devlog")]
        res = scoring.score_indie({"anime_style_description": ["anime-style art"]}, strong_meta(), None,
                                  evidence_rows=rows, contactability_result=good_contact(), suppression={})
        return res, rows

    def test_real_studio_needs_review_with_partial_items_does_not_raise(self):
        # Regression: the previous version raised TypeError here (", ".join of None) and would have failed h_qualify.
        res = self.studio_pipeline_review()
        self.assertEqual(res.decision, "needs_review")
        out = qr.explain_ambiguous(None, res, [])
        self.assertEqual(out["generated_by"], "deterministic_fallback")
        self.assertIn("pipeline_fit", out["key_uncertainty"])
        self.assertNotIn("None", out["recommended_human_action"])
        self.assertIn("partially-credited", out["recommended_human_action"])

    def test_real_indie_flat_rows_and_failed_gate_are_explained(self):
        res, rows = self.indie_gate_review()
        self.assertEqual(res.decision, "needs_review")
        out = qr.explain_ambiguous(None, res, rows)
        self.assertIn("anime_visual_identity", out["recommended_human_action"])       # group-level partial credit (12/30)
        self.assertIn("mandatory gate", out["key_uncertainty"])
        self.assertIn("anime_visual_identity", out["key_uncertainty"])

    def test_payload_and_grounding_source_carry_real_why_text(self):
        res, rows = self.indie_gate_review()
        payload = qr._payload(res, rows)
        why = next(r["why"] for r in res.breakdown if r["criterion"] == "anime_visual_identity")
        self.assertIn(why[:30], payload)
        self.assertIn("anime_visual_identity", payload)
        self.assertIn("failed_mandatory_gates", payload)
        self.assertIn(why[:30].lower().split()[0], qr._breakdown_text(res).lower())

    def test_real_result_through_real_router_returns_note_and_leaves_result_untouched(self):
        res = self.studio_pipeline_review()
        before = (res.score, res.decision, res.reason, repr(res.breakdown), res.uncertain)
        qr._calls.clear()
        answer = {"summary": "The pipeline_fit criterion is only partially credited.",
                  "key_uncertainty": "Whether the pipeline_fit evidence shows real production capability.",
                  "confidence": "medium", "recommended_human_action": "Check the pipeline_fit evidence against the studio site."}
        router = AIRouter(FakeGemini(answer), FakeOllama(), RouterSettings(), Clock())
        out = qr.explain_ambiguous(router, res, [])
        self.assertEqual(out["generated_by"], "model")
        self.assertEqual(before, (res.score, res.decision, res.reason, repr(res.breakdown), res.uncertain))

    def test_confidence_indicator_on_real_results(self):
        from kairflow_intel import scoring
        res = self.studio_pipeline_review()
        c = qr.confidence_indicator(res, scoring.STUDIO_QUALIFY_MIN, scoring.STUDIO_REVIEW_MIN)
        self.assertIn(c["level"], ("low", "medium", "high"))
        res2, _ = self.indie_gate_review()
        c2 = qr.confidence_indicator(res2, scoring.INDIE_QUALIFY_MIN, scoring.INDIE_REVIEW_MIN)
        self.assertEqual(c2["generated_by"], "deterministic")


class ModelAnsweredTests(unittest.TestCase):
    def test_grounded_answer_is_accepted_and_provenance_recorded(self):
        answer = {"summary": "The only update evidence is one devlog update mention, which is not independently verified.",
                  "key_uncertainty": "Whether the devlog update reflects genuinely active development.",
                  "confidence": "medium", "recommended_human_action": "Check the devlog update source directly before deciding."}
        llm = FakeLLM(answer)
        rec = []
        out = qr.explain_ambiguous(llm, result(), EVIDENCE, rec=rec)
        self.assertEqual(out["generated_by"], "model")
        self.assertEqual(out["confidence"], "medium")
        self.assertEqual(out["summary"], answer["summary"])
        self.assertEqual(len(rec), 1)
        self.assertEqual(out["ai"]["provider"], "gemini")
        self.assertEqual(llm.sent[0]["site"], qr.SITE)

    def test_site_tag_is_stable_and_known_to_the_router(self):
        from kairflow_intel.airouter import KNOWN_SITES
        self.assertIn(qr.SITE, KNOWN_SITES)
        self.assertEqual(qr.SITE.split(".", 1)[0], "research")  # public prospect-evidence group, not a private-correspondence one


GROUNDED_ANSWER = {"summary": "The only update evidence is one devlog update mention, which is not independently verified.",
                   "key_uncertainty": "Whether the devlog update reflects genuinely active development.",
                   "confidence": "medium", "recommended_human_action": "Check the devlog update source directly before deciding."}


class RealRouterIntegrationTests(unittest.TestCase):
    """Exercises the actual AIRouter (policy resolution, D1, budget, one-Gemini-then-one-Ollama
    fallback) instead of only a bare fake llm, so a real routing or configuration bug for this new
    site tag would be caught here rather than only once it reaches production."""

    def test_default_policy_sends_research_qualification_review_to_gemini_first(self):
        gemini = FakeGemini(GROUNDED_ANSWER)
        router = AIRouter(gemini, FakeOllama(), RouterSettings(), Clock())
        out = qr.explain_ambiguous(router, result(), EVIDENCE)
        self.assertEqual(out["generated_by"], "model")
        self.assertEqual(gemini.n, 1)
        self.assertEqual(gemini.calls[0]["site"], qr.SITE)

    def test_gemini_failure_falls_back_to_ollama_and_still_produces_a_grounded_answer(self):
        gemini = FakeGemini(TimeoutError("boom"))
        ollama = FakeOllama(out=GROUNDED_ANSWER)
        router = AIRouter(gemini, ollama, RouterSettings(), Clock())
        out = qr.explain_ambiguous(router, result(), EVIDENCE)
        self.assertEqual(out["generated_by"], "model")
        self.assertEqual(ollama.n, 1)

    def test_ollama_fallback_answer_is_still_grounding_checked(self):
        gemini = FakeGemini(TimeoutError("boom"))
        ollama = FakeOllama(out={"summary": "A signed Netflix licensing deal was confirmed yesterday.",
                                 "key_uncertainty": "Contract territory scope.", "confidence": "high",
                                 "recommended_human_action": "Call their legal department."})
        router = AIRouter(gemini, ollama, RouterSettings(), Clock())
        out = qr.explain_ambiguous(router, result(), EVIDENCE)
        self.assertEqual(out["generated_by"], "deterministic_fallback")  # ungrounded even from Ollama -> still rejected

    def test_force_ollama_setting_never_reaches_gemini_for_this_site_either(self):
        gemini = FakeGemini(GROUNDED_ANSWER)
        router = AIRouter(gemini, FakeOllama(out=GROUNDED_ANSWER), RouterSettings(force_ollama=True), Clock())
        out = qr.explain_ambiguous(router, result(), EVIDENCE)
        self.assertEqual(out["generated_by"], "model")
        self.assertEqual(gemini.n, 0)

    def test_qualified_result_never_calls_the_router_at_all(self):
        gemini = FakeGemini(GROUNDED_ANSWER)
        router = AIRouter(gemini, FakeOllama(), RouterSettings(), Clock())
        out = qr.explain_ambiguous(router, result(decision="qualified"), EVIDENCE)
        self.assertIsNone(out)
        self.assertEqual(gemini.n, 0)


class RedactionKeepsEvidenceDatesTests(unittest.TestCase):
    def test_dates_and_year_ranges_survive_but_contacts_do_not(self):
        ev = [{"fact_type": "recent_update", "verified": True,
               "snippet": "Mail jo.doe@studio.com or +254 712 345 678 or (555) 123-4567; built 2019-2023, update 2023-05-17."}]
        payload = qr._payload(result(), ev)
        for kept in ("2019-2023", "2023-05-17"):
            self.assertIn(kept, payload)
        for gone in ("jo.doe@studio.com", "712 345 678", "123-4567"):
            self.assertNotIn(gone, payload)
        self.assertIn("[email]", payload)
        self.assertIn("[phone]", payload)

    def test_payload_is_valid_json_even_with_an_address_in_a_json_string(self):
        import json
        ev = [{"fact_type": "x", "verified": True, "snippet": "a@b.com"}]
        data = json.loads(qr._payload(result(), ev))
        self.assertEqual(data["evidence"][0]["snippet"], "[email]")


class NumbersGivenToTheModelAreGroundedTests(unittest.TestCase):
    def test_note_repeating_score_and_points_is_accepted(self):
        answer = {"summary": "Score 60 reflects one unverified devlog update, 5 of 15 points.",
                  "key_uncertainty": "The recent update is unverified.", "confidence": "low",
                  "recommended_human_action": "Check the devlog update against the source."}
        out = qr.explain_ambiguous(FakeLLM(answer), result(), EVIDENCE)
        self.assertEqual(out["generated_by"], "model")

    def test_invented_number_is_still_rejected(self):
        answer = {"summary": "Score 60 reflects one unverified devlog update, 200 of 15 points.",
                  "key_uncertainty": "The recent update is unverified.", "confidence": "low",
                  "recommended_human_action": "Check the devlog update against the source."}
        out = qr.explain_ambiguous(FakeLLM(answer), result(), EVIDENCE)
        self.assertEqual(out["generated_by"], "deterministic_fallback")


if __name__ == "__main__":
    unittest.main()
