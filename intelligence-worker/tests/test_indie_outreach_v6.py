from datetime import date
import unittest

from kairflow_intel import classify, drafting, indie_outreach, policy
from kairflow_intel.errors import PermanentError


class IndieReplyOutcomeTests(unittest.TestCase):
    def test_new_reply_labels_are_supported_by_model_schema(self):
        for label in ("not_now", "not_interested", "already_has_trailer", "wrong_person", "referral", "tell_me_more"):
            self.assertIn(label, classify.LABELS)
            self.assertIn(label, classify.SCHEMA["properties"]["label"]["enum"])

    def test_legacy_model_rejection_is_normalized_to_non_suppressing_decline(self):
        result = classify.classify({"subject": "Re: Proposal", "body_text": "Thanks for the note.", "from_email": "x@example.com"}, set(),
            lambda *_: {"label": "rejection", "confidence": 0.99})
        self.assertEqual(result["class"], "not_interested")
        self.assertNotEqual(indie_outreach.OUTCOME_ACTIONS[result["class"]], "permanent_suppression")

    def test_migration_versions_are_unique(self):
        from collections import Counter
        from pathlib import Path
        migrations = Path(__file__).resolve().parents[2] / "supabase" / "migrations"
        versions = [p.name[:14] for p in migrations.glob("*.sql")]
        duplicates = [version for version, count in Counter(versions).items() if count > 1]
        self.assertEqual(duplicates, [])

    def test_not_interested_is_not_unsubscribe_or_dnc(self):
        result = classify.classify({"subject": "Not interested", "body_text": "Thanks, we are not interested.", "from_email": "x@example.com"}, set())
        self.assertEqual(result["class"], "not_interested")
        self.assertNotEqual(indie_outreach.OUTCOME_ACTIONS[result["class"]], "permanent_suppression")

    def test_not_now_is_separate_from_not_interested(self):
        result = classify.classify({"subject": "Not right now", "body_text": "Maybe later this year.", "from_email": "x@example.com"}, set())
        self.assertEqual(result["class"], "not_now")

    def test_unsubscribe_precedes_other_positive_or_negative_signals(self):
        result = classify.classify({"subject": "Not now", "body_text": "Maybe later, but unsubscribe me.", "from_email": "x@example.com"}, set())
        self.assertEqual(result["class"], "unsubscribe")

    def test_tell_me_more_creates_human_approved_reply_path(self):
        result = classify.classify({"subject": "Tell me more", "body_text": "Could you send more details?", "from_email": "x@example.com"}, set())
        self.assertEqual(result["class"], "tell_me_more")
        self.assertTrue(result["auto_ok"])
        self.assertIn("tell_me_more", classify.AUTO_REPLY_OK)

    def test_wrong_person_and_referral_are_distinct(self):
        wrong = classify.classify({"subject": "Wrong person", "body_text": "I am not the right person for this.", "from_email": "x@example.com"}, set())
        referral = classify.classify({"subject": "Contact our producer", "body_text": "Please reach out to our producer instead.", "from_email": "x@example.com"}, set())
        self.assertEqual(wrong["class"], "wrong_person")
        self.assertEqual(referral["class"], "referral")


class IndieSequenceTests(unittest.TestCase):
    def test_day_five_followup(self):
        self.assertEqual(indie_outreach.due_sequence_stage(date(2026, 1, 5), date(2026, 1, 12), 0), "followup")

    def test_day_ten_followup(self):
        self.assertEqual(indie_outreach.due_sequence_stage(date(2026, 1, 5), date(2026, 1, 19), 1), "followup")

    def test_month_three_reengagement(self):
        self.assertEqual(indie_outreach.due_sequence_stage(date(2026, 1, 31), date(2026, 4, 30), 2), "reengagement")

    def test_month_six_reengagement(self):
        self.assertEqual(indie_outreach.due_sequence_stage(date(2026, 1, 31), date(2026, 7, 31), 3), "reengagement")

    def test_future_stage_not_due_and_fourth_stage_completes(self):
        self.assertIsNone(indie_outreach.due_sequence_stage(date(2026, 1, 5), date(2026, 1, 8), 0))
        self.assertIsNone(indie_outreach.due_sequence_stage(date(2026, 1, 5), date(2026, 12, 1), 4))

    def test_non_indie_campaign_keeps_three_step_cap(self):
        self.assertEqual(drafting.max_step({"type": "animation_studio_support"}), 3)
        self.assertEqual(drafting.max_step({"type": "indie_game_developer"}), 4)


class IndieInitialDraftSafetyTests(unittest.TestCase):
    def setUp(self):
        self.prospect = {"type": "indie_game_developer", "name": "Example Studio", "project_title": "Moon Harbor"}
        self.catalog = [
            {"id": "p1", "fact_type": "project_identity", "snippet": "Moon Harbor is an action adventure game with a hand-drawn world.", "url": "https://example.test/moon-harbor"},
            {"id": "v1", "fact_type": "official_anime_style_description", "snippet": "The visual direction uses anime-inspired character art and expressive effects.", "url": "https://example.test/moon-harbor"},
        ]
        self.body = ("Hello,\n\nMoon Harbor's hand-drawn world and expressive character art suggest a cinematic teaser "
                     "could highlight its visual direction. Studio Kairegi is an anime animation studio. "
                     "Would a short discussion about that direction be useful?")

    def test_valid_project_specific_intro(self):
        drafting._validate_indie_initial(self.prospect, self.catalog, self.catalog, "Moon Harbor teaser", self.body, language="en")

    def test_missing_project_title_is_not_accepted_by_the_v2_validator(self):
        with self.assertRaises(PermanentError):
            drafting._validate_indie_initial({"type": "indie_game_developer", "name": "Example Studio"}, self.catalog, self.catalog,
                                             "A teaser", self.body, language="en")

    def test_requires_both_project_and_visual_evidence(self):
        with self.assertRaises(PermanentError):
            drafting._validate_indie_initial(self.prospect, self.catalog, self.catalog[:1], "Moon Harbor teaser", self.body, language="en")

    def test_blocks_any_url_and_em_dash(self):
        with self.assertRaises(PermanentError):
            drafting._validate_indie_initial(self.prospect, self.catalog, self.catalog, "Moon Harbor", self.body + " https://studio.test", language="en")
        with self.assertRaises(PermanentError):
            drafting._validate_indie_initial(self.prospect, self.catalog, self.catalog, "Moon Harbor", self.body + " — thank you", language="en")

    def test_em_dash_is_blocked_in_subject_and_body_for_every_cold_kind(self):
        settings = {"sender_name": "Alex", "physical_address": "1 Road", "opt_out_text": "Reply unsubscribe"}
        for kind in ("initial", "followup", "reengagement"):
            self.assertTrue(any("em dashes" in v for v in policy.validate_outbound(
                "A subject — with dash", "Body", settings, set(), kind)))
            self.assertTrue(any("em dashes" in v for v in policy.validate_outbound(
                "A subject", "Body — with dash", settings, set(), kind)))
        self.assertEqual(policy.validate_outbound("A subject — allowed in reply", "Body", settings, set(), "reply"), [])

    def test_phase6_corrective_migration_contains_reply_and_sequence_guards(self):
        from pathlib import Path
        path = Path(__file__).resolve().parents[2] / "supabase" / "migrations" / "20261231100000_intelligence_phase6_reply_outreach_corrections.sql"
        sql = path.read_text()
        for token in ("'not_now'", "'not_interested'", "'already_has_trailer'", "'wrong_person'", "'referral'", "'tell_me_more'",
                      "p_class in ('unsubscribe','complaint')", "max_followups set default 3", "s.max_followups >= 2",
                      "coalesce(p.review_reason, '')", "interval '3 months'", "interval '6 months'", "direction = 'inbound'"):
            self.assertIn(token, sql)
        self.assertNotIn("p_class in ('unsubscribe','rejection')", sql)

    def test_final_policy_blocks_portfolio_links_and_mentions_in_cold_outreach(self):
        settings = {"sender_name": "Alex", "physical_address": "1 Road", "opt_out_text": "Reply unsubscribe"}
        for body in ("See our reel at https://studio.test/reel\n1 Road\nReply unsubscribe", "Our portfolio is available on request.\n1 Road\nReply unsubscribe"):
            violations = policy.validate_outbound("Hello", body, settings, {"https://studio.test/reel"}, "initial")
            self.assertTrue(any("portfolio" in x or "links" in x for x in violations))
        # A reply can share the approved portfolio only after an explicit request.
        self.assertEqual(policy.validate_outbound("Re: samples", "Here is our reel: https://studio.test/reel", settings,
                                                   {"https://studio.test/reel"}, "reply"), [])

    def test_requires_explicit_studio_positioning_and_question(self):
        with self.assertRaises(PermanentError):
            drafting._validate_indie_initial(self.prospect, self.catalog, self.catalog, "Moon Harbor", "Moon Harbor is interesting. We make animation. Contact us.", language="en")


class ReengagementEvidenceTests(unittest.TestCase):
    def test_requires_verified_dated_project_evidence_newer_than_initial_intro(self):
        from kairflow_intel.jobs import _indie_reengagement_evidence_is_new
        prospect = {"type": "indie_game_developer", "meta": {"project_latest_activity_date": "2026-11-05"}}
        good = [{"verified": True, "fact_type": "development_update", "url": "https://game.test/devlog", "snippet": "A dated development update."}]
        old = {"type": "indie_game_developer", "meta": {"project_latest_activity_date": "2026-10-01"}}
        self.assertTrue(_indie_reengagement_evidence_is_new(prospect, good, "2026-10-01"))
        self.assertFalse(_indie_reengagement_evidence_is_new(old, good, "2026-10-01"))
        self.assertFalse(_indie_reengagement_evidence_is_new(prospect, [{**good[0], "verified": False}], "2026-10-01"))


class MigrationContractTests(unittest.TestCase):
    def test_sequence_migration_has_four_indie_stages_and_reply_stop(self):
        from pathlib import Path
        path = Path(__file__).resolve().parents[2] / "supabase" / "migrations" / "20261112192000_intelligence_indie_outreach_v6.sql"
        sql = path.read_text()
        for token in ("alter column max_followups set default 4", ">= 5", ">= 10", "interval '3 months'", "interval '6 months'", "f.sent_followups < least(4, s.max_followups)", "f.sent_followups < least(3, s.max_followups)", "direction = 'inbound'"):
            self.assertIn(token, sql)

    def test_no_auto_portfolio_for_initial_composition(self):
        from pathlib import Path
        source = Path(drafting.__file__).read_text()
        self.assertIn('allow_portfolio = kind == "reply" and (str((inbound or {}).get("class") or "") == "portfolio_request"', source)
        self.assertIn("initial outreach must not contain portfolio or studio website links", source)


if __name__ == "__main__":
    unittest.main()
