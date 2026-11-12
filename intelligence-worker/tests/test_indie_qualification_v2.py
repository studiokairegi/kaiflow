import unittest
from datetime import date, timedelta

from kairflow_intel import jobs, research, scoring, signals
from kairflow_intel.contactability import assess


def ev(kind, url="https://game.example/page", snippet=None):
    return {"id": kind, "fact_type": kind, "url": url, "snippet": snippet or f"Verified {kind} evidence", "verified": True}


def strong_meta(**extra):
    return {
        "developer_name": "Tiny Moon Studio", "prospect_name": "Tiny Moon Studio",
        "contact_email": "maker@game.example", "project_title": "Moonlit Blade", "project_url": "https://game.example/",
        "steam_appid": "12345", "source": "steam", "indie_status_verified": True,
        "team_size": 3, "coming_soon": True,
        "project_latest_activity_date": (date.today() - timedelta(days=30)).isoformat(),
        "project_expected_release_date": (date.today() + timedelta(days=120)).isoformat(),
        **extra,
    }


def good_contact():
    return {"status": "pass", "reason": "human confirmed and deliverable", "verified_email": "maker@game.example",
            "evidence": {"source_url": "https://game.example/contact", "deliverability": "human_confirmed"}}


def no_suppression():
    return {"suppressed": False, "bounced": False, "complained": False, "suppression_reason": ""}


class IndieV2Weights(unittest.TestCase):
    def test_requested_weights_total_exactly_100(self):
        self.assertEqual(scoring.INDIE_MAX, {
            "anime_visual_identity": 30,
            "active_development": 25,
            "release_marketing_timing": 25,
            "indie_partnership_opportunity": 10,
            "project_identity_confidence": 10,
        })
        self.assertEqual(sum(scoring.INDIE_MAX.values()), 100)

    def test_all_gates_and_score_qualify_a_small_first_time_team(self):
        rows = [ev("project_description"), ev("devlog", "https://game.example/devlog"),
                ev("anime_visual_screenshot", "https://cdn.game.example/screenshot.png")]
        r = scoring.score_indie({"anime_style_description": ["anime-inspired character designs"]}, strong_meta(), {"email": "owner@gmail.com"},
                                evidence_rows=rows, contactability_result=good_contact(), suppression={})
        self.assertEqual(r.score, 100)
        self.assertEqual(r.decision, "qualified")
        self.assertTrue(all(g["passed"] for g in r.mandatory_gates.values()))
        self.assertEqual(sum(x["points"] for x in r.breakdown), 100)

    def test_visual_style_text_does_not_substitute_for_visual_evidence(self):
        rows = [ev("project_description"), ev("devlog", "https://game.example/devlog")]
        r = scoring.score_indie({"anime_style_description": ["anime-style art"]}, strong_meta(), None,
                                evidence_rows=rows, contactability_result=good_contact(), suppression={})
        self.assertEqual(next(x for x in r.breakdown if x["criterion"] == "anime_visual_identity")["points"], 12)
        self.assertFalse(r.mandatory_gates["anime_visual_identity"]["passed"])
        self.assertNotEqual(r.decision, "qualified")

    def test_explicit_anime_style_on_official_project_page_can_verify_identity(self):
        rows = [ev("project_description"), ev("devlog", "https://game.example/devlog"),
                ev("anime_style_description", "https://game.example/", "Anime-inspired art direction and anime character designs.")]
        r = scoring.score_indie({"anime_style_description": ["Anime-inspired art direction and anime character designs."]},
                                strong_meta(), None, evidence_rows=rows, contactability_result=good_contact(), suppression={})
        self.assertTrue(r.mandatory_gates["anime_visual_identity"]["passed"])
        self.assertEqual(next(x for x in r.breakdown if x["criterion"] == "anime_visual_identity")["points"], 24)
        self.assertEqual(r.decision, "qualified")

    def test_placeholder_project_or_developer_identity_does_not_pass(self):
        for meta in (strong_meta(project_title="Unknown Game"), strong_meta(developer_name="Unknown Developer")):
            r = scoring.score_indie({}, meta, None, evidence_rows=[ev("project_description"), ev("devlog", "https://game.example/devlog"), ev("anime_visual_screenshot", "https://cdn.example/a.png")],
                                    contactability_result=good_contact(), suppression={})
            self.assertFalse(r.mandatory_gates["project_identity"]["passed"])

    def test_kickstarter_creator_attribution_cannot_satisfy_developer_identity_gate_until_verified(self):
        rows = [ev("project_description"), ev("devlog", "https://game.example/devlog"),
                ev("anime_visual_screenshot", "https://cdn.example/a.png")]
        unverified = strong_meta(source="kickstarter_manual", source_key="kickstarter_manual",
                                 developer_identity_status="admin_attributed_unverified", project_url="https://www.kickstarter.com/projects/moondev/moonlit-blade/")
        result = scoring.score_indie({}, unverified, None, evidence_rows=rows,
                                     contactability_result=good_contact(), suppression={})
        self.assertFalse(result.mandatory_gates["project_identity"]["passed"])
        self.assertIn("independently verified", result.mandatory_gates["project_identity"]["reason"])
        verified = {**unverified, "developer_identity_status": "independently_verified"}
        result_verified = scoring.score_indie({}, verified, None, evidence_rows=rows,
                                              contactability_result=good_contact(), suppression={})
        self.assertTrue(result_verified.mandatory_gates["project_identity"]["passed"])

    def test_itch_platform_creator_attribution_cannot_satisfy_identity_gate_until_verified(self):
        rows = [ev("project_description"), ev("devlog", "https://game.example/devlog"),
                ev("anime_visual_screenshot", "https://cdn.example/a.png")]
        unverified = strong_meta(source="itch", source_key="itch",
                                 developer_identity_status="platform_creator_unverified",
                                 project_url="https://tiny-moon.itch.io/moonlit-blade/")
        result = scoring.score_indie({}, unverified, None, evidence_rows=rows,
                                     contactability_result=good_contact(), suppression={})
        self.assertFalse(result.mandatory_gates["project_identity"]["passed"])
        verified = {**unverified, "developer_identity_status": "independently_verified"}
        result_verified = scoring.score_indie({}, verified, None, evidence_rows=rows,
                                              contactability_result=good_contact(), suppression={})
        self.assertTrue(result_verified.mandatory_gates["project_identity"]["passed"])

    def test_non_http_project_source_does_not_establish_project_identity(self):
        m = strong_meta(project_url="javascript:alert(1)", developer_website="https://tinymoon.dev", steam_appid="")
        rows = [ev("project_description", "https://fanwiki.example/moonlit-blade"),
                ev("devlog", "https://tinymoon.dev/devlog"), ev("anime_visual_screenshot", "https://cdn.example/a.png")]
        r = scoring.score_indie({}, m, None, evidence_rows=rows, contactability_result=good_contact(), suppression={})
        self.assertFalse(r.mandatory_gates["project_identity"]["passed"])

    def test_project_description_on_official_developer_site_can_identify_project(self):
        m = strong_meta(project_url="", developer_website="https://tinymoon.dev", steam_appid="")
        rows = [ev("project_description", "https://tinymoon.dev/games/moonlit-blade"),
                ev("devlog", "https://tinymoon.dev/devlog"), ev("anime_visual_screenshot", "https://cdn.example/a.png")]
        r = scoring.score_indie({}, m, None, evidence_rows=rows, contactability_result=good_contact(), suppression={})
        self.assertTrue(r.mandatory_gates["project_identity"]["passed"])

    def test_project_description_from_unofficial_domain_does_not_establish_project_source(self):
        m = strong_meta(project_url="", developer_website="https://tinymoon.dev", steam_appid="")
        rows = [ev("project_description", "https://fanwiki.example/moonlit-blade"),
                ev("devlog", "https://tinymoon.dev/devlog"), ev("anime_visual_screenshot", "https://cdn.example/a.png")]
        r = scoring.score_indie({}, m, None, evidence_rows=rows, contactability_result=good_contact(), suppression={})
        self.assertFalse(r.mandatory_gates["project_identity"]["passed"])

    def test_anime_style_description_from_unofficial_domain_does_not_pass_visual_gate(self):
        rows = [ev("project_description"), ev("devlog", "https://game.example/devlog"),
                ev("anime_style_description", "https://fanwiki.example/", "Anime-inspired art direction and anime character designs.")]
        r = scoring.score_indie({"anime_style_description": ["Anime-inspired art direction and anime character designs."]},
                                strong_meta(), None, evidence_rows=rows, contactability_result=good_contact(), suppression={})
        self.assertFalse(r.mandatory_gates["anime_visual_identity"]["passed"])
        self.assertEqual(next(x for x in r.breakdown if x["criterion"] == "anime_visual_identity")["points"], 12)

    def test_jrpg_and_visual_novel_labels_are_not_anime_visual_proof(self):
        detected = signals.detect_indie("A JRPG visual novel with branching dialogue.")
        self.assertNotIn("style_anime", detected)
        self.assertNotIn("anime_style_description", detected)
        r = scoring.score_indie(detected, strong_meta(), None, evidence_rows=[ev("project_description"), ev("devlog")],
                                contactability_result=good_contact(), suppression={})
        self.assertEqual(next(x for x in r.breakdown if x["criterion"] == "anime_visual_identity")["points"], 0)

    def test_discovery_recent_activity_boolean_is_not_activity_evidence(self):
        m = strong_meta(coming_soon=False, project_expected_release_date=None, recent_activity=True)
        r = scoring.score_indie({}, m, None, evidence_rows=[ev("project_description"), ev("store_page")],
                                contactability_result=good_contact(), suppression={})
        self.assertFalse(r.mandatory_gates["active_or_marketing_opportunity"]["passed"])
        self.assertEqual(next(x for x in r.breakdown if x["criterion"] == "active_development")["points"], 0)

    def test_overdue_expected_release_and_stale_coming_soon_do_not_create_opportunity(self):
        m = strong_meta(coming_soon=True, project_expected_release_date=(date.today() - timedelta(days=20)).isoformat(),
                        project_announcement_date=(date.today() - timedelta(days=180)).isoformat(),
                        project_latest_activity_date=None)
        rows = [ev("project_description"), ev("anime_visual_screenshot", "https://cdn.example/a.png")]
        r = scoring.score_indie({}, m, None, evidence_rows=rows, contactability_result=good_contact(), suppression={})
        self.assertFalse(r.mandatory_gates["active_or_marketing_opportunity"]["passed"])
        self.assertEqual(next(x for x in r.breakdown if x["criterion"] == "release_marketing_timing")["points"], 0)

    def test_unknown_release_date_can_pass_with_recent_dated_activity(self):
        m = strong_meta(coming_soon=False, project_expected_release_date=None)
        m["project_latest_activity_date"] = (date.today() - timedelta(days=60)).isoformat()
        rows = [ev("project_description"), ev("devlog", "https://game.example/devlog")]
        r = scoring.score_indie({}, m, None, evidence_rows=rows, contactability_result=good_contact(), suppression={})
        self.assertTrue(r.mandatory_gates["active_or_marketing_opportunity"]["passed"])
        self.assertEqual(next(x for x in r.breakdown if x["criterion"] == "release_marketing_timing")["points"], 12)

    def test_unknown_release_date_with_marketing_evidence_remains_reviewable(self):
        m = strong_meta(coming_soon=False, project_expected_release_date=None)
        m["project_latest_activity_date"] = None
        rows = [ev("project_description"), ev("anime_visual_screenshot", "https://cdn.example/a.png"),
                ev("marketing_campaign", "https://game.example/campaign", "Upcoming demo campaign for the next launch window.")]
        r = scoring.score_indie({}, m, None, evidence_rows=rows, contactability_result=good_contact(), suppression={})
        self.assertTrue(r.mandatory_gates["active_or_marketing_opportunity"]["passed"])
        self.assertEqual(next(x for x in r.breakdown if x["criterion"] == "release_marketing_timing")["points"], 12)
        self.assertEqual(r.decision, "needs_review")

    def test_year_only_release_date_uses_midyear_estimate(self):
        self.assertEqual(scoring._as_date("2027"), date(2027, 7, 1))
        self.assertEqual(scoring._as_date("2027-04"), date(2027, 4, 1))

    def test_six_month_announcement_window_is_a_real_prospecting_opportunity(self):
        m = strong_meta(coming_soon=False, project_expected_release_date=None,
                        project_announcement_date=(date.today() - timedelta(days=180)).isoformat(),
                        project_latest_activity_date=None)
        rows = [ev("project_description"), ev("anime_visual_screenshot", "https://cdn.example/a.png"),
                ev("contact_email", "https://game.example/contact")]
        r = scoring.score_indie({}, m, None, evidence_rows=rows, contactability_result=good_contact(), suppression={})
        self.assertTrue(r.mandatory_gates["active_or_marketing_opportunity"]["passed"])
        self.assertEqual(next(x for x in r.breakdown if x["criterion"] == "release_marketing_timing")["points"], 25)

    def test_release_beyond_twelve_months_is_deprioritized_not_discarded(self):
        m = strong_meta(coming_soon=False, project_expected_release_date=(date.today() + timedelta(days=500)).isoformat())
        m["project_latest_activity_date"] = (date.today() - timedelta(days=30)).isoformat()
        rows = [ev("project_description"), ev("devlog", "https://game.example/devlog"), ev("anime_visual_artwork", "https://cdn.example/art.png")]
        r = scoring.score_indie({}, m, None, evidence_rows=rows, contactability_result=good_contact(), suppression={})
        self.assertTrue(r.mandatory_gates["active_or_marketing_opportunity"]["passed"])
        self.assertEqual(next(x for x in r.breakdown if x["criterion"] == "release_marketing_timing")["points"], 5)


    def test_recently_released_game_needs_a_separate_marketing_opportunity(self):
        m = strong_meta(coming_soon=False, project_expected_release_date=None,
                        project_actual_release_date=(date.today() - timedelta(days=90)).isoformat())
        rows = [ev("project_description"), ev("devlog", "https://game.example/devlog"), ev("anime_visual_screenshot", "https://cdn.example/a.png")]
        r = scoring.score_indie({}, m, None, evidence_rows=rows, contactability_result=good_contact(), suppression={})
        self.assertFalse(r.mandatory_gates["active_or_marketing_opportunity"]["passed"])
        self.assertEqual(next(x for x in r.breakdown if x["criterion"] == "release_marketing_timing")["points"], 0)

    def test_recently_released_game_can_qualify_with_verified_dlc_or_campaign(self):
        milestone_date = (date.today() + timedelta(days=45)).isoformat()
        m = strong_meta(coming_soon=False, project_expected_release_date=None,
                        project_actual_release_date=(date.today() - timedelta(days=90)).isoformat(), new_dlc_or_update_verified=True,
                        project_marketing_milestones=[{"verified": True, "source_url": "https://game.example/dlc", "date": milestone_date}])
        rows = [ev("project_description"), ev("devlog", "https://game.example/devlog"), ev("anime_visual_screenshot", "https://cdn.example/a.png"), ev("dlc_announcement", "https://game.example/dlc")]
        r = scoring.score_indie({}, m, None, evidence_rows=rows, contactability_result=good_contact(), suppression={})
        self.assertTrue(r.mandatory_gates["active_or_marketing_opportunity"]["passed"])
        self.assertEqual(next(x for x in r.breakdown if x["criterion"] == "release_marketing_timing")["points"], 15)

    def test_larger_independent_team_is_deprioritized_not_disqualified(self):
        m = strong_meta(team_size=30)
        rows = [ev("project_description"), ev("devlog", "https://game.example/devlog"), ev("anime_visual_screenshot", "https://cdn.example/a.png")]
        r = scoring.score_indie({}, m, None, evidence_rows=rows, contactability_result=good_contact(), suppression={})
        self.assertEqual(next(x for x in r.breakdown if x["criterion"] == "indie_partnership_opportunity")["points"], 4)
        self.assertEqual(r.decision, "qualified")

    def test_discovery_source_or_team_size_alone_does_not_prove_indie_status(self):
        r = scoring.score_indie({}, strong_meta(indie_status_verified=False), None,
                                evidence_rows=[ev("project_description"), ev("devlog", "https://game.example/devlog"), ev("anime_visual_screenshot", "https://cdn.example/a.png")],
                                contactability_result=good_contact(), suppression={})
        row = next(x for x in r.breakdown if x["criterion"] == "indie_partnership_opportunity")
        self.assertEqual(row["points"], 0)
        self.assertIn("discovery source alone is not proof", row["why"])

    def test_publisher_does_not_add_points_or_disqualify(self):
        rows = [ev("project_description"), ev("devlog", "https://game.example/devlog"), ev("anime_visual_trailer", "https://game.example/trailer")]
        base = scoring.score_indie({}, strong_meta(), None, evidence_rows=rows, contactability_result=good_contact(), suppression={})
        published = scoring.score_indie({}, strong_meta(publisher="Large Publisher"), None, evidence_rows=rows,
                                        contactability_result=good_contact(), suppression={})
        self.assertEqual(base.score, published.score)
        self.assertEqual(base.decision, published.decision)

    def test_verified_suppression_flags_in_facts_are_hard_blocks(self):
        for flag in ("unsubscribed", "bounced", "complained", "do_not_contact"):
            r = scoring.score_indie({}, strong_meta(**{flag: True}), None,
                                    evidence_rows=[ev("project_description"), ev("devlog", "https://game.example/devlog"), ev("anime_visual_screenshot", "https://cdn.example/a.png")],
                                    contactability_result=good_contact(), suppression={})
            self.assertEqual(r.decision, "rejected", flag)
            self.assertFalse(r.mandatory_gates["suppression_clear"]["passed"], flag)

    def test_suppression_lookup_failure_always_holds_for_review_even_at_low_score(self):
        r = scoring.score_indie({}, {}, None, evidence_rows=[], contactability_result=good_contact(),
                                suppression={"lookup_unavailable": True})
        self.assertEqual(r.decision, "needs_review")
        self.assertFalse(r.mandatory_gates["suppression_clear"]["passed"])

    def test_protected_account_and_suppression_override_high_score(self):
        rows = [ev("project_description"), ev("devlog", "https://game.example/devlog"), ev("anime_visual_screenshot", "https://cdn.example/a.png")]
        protected = scoring.score_indie({}, strong_meta(project_title="Lie of Caelum: Spirit"), None, evidence_rows=rows,
                                        contactability_result=good_contact(), suppression={})
        self.assertEqual(protected.decision, "rejected")
        suppressed = scoring.score_indie({}, strong_meta(), None, evidence_rows=rows,
                                         contactability_result=good_contact(), suppression={"suppressed": True, "suppression_reason": "unsubscribe"})
        self.assertEqual(suppressed.decision, "rejected")

    def test_contactability_pass_requires_exact_prospect_email_and_source_url(self):
        rows = [ev("project_description"), ev("devlog", "https://game.example/devlog"), ev("anime_visual_screenshot", "https://cdn.example/a.png")]
        for result in (
            {"status": "pass", "verified_email": "other@game.example", "evidence": {"source_url": "https://game.example/contact"}},
            {"status": "pass", "verified_email": "maker@game.example", "evidence": {"source_url": "javascript:alert(1)"}},
        ):
            r = scoring.score_indie({}, strong_meta(), None, evidence_rows=rows, contactability_result=result, suppression={})
            self.assertFalse(r.mandatory_gates["verified_usable_email"]["passed"])
            self.assertEqual(r.decision, "needs_review")

    def test_project_and_evidence_gates_prevent_high_score_from_qualifying(self):
        rows = [ev("anime_visual_screenshot"), ev("devlog", "https://game.example/devlog")]
        r = scoring.score_indie({}, {**strong_meta(), "project_title": ""}, None, evidence_rows=rows,
                                contactability_result=good_contact(), suppression={})
        self.assertNotEqual(r.decision, "qualified")
        self.assertFalse(r.mandatory_gates["project_identity"]["passed"])


class PersonalEmailVerification(unittest.TestCase):
    def test_gmail_from_official_developer_site_can_pass_when_exact_address_human_confirmed(self):
        r = assess(email="creator@gmail.com", official_domain="tinymoon.dev", source_url="https://tinymoon.dev/contact",
                   verification="human_confirmed", verified_email="creator@gmail.com", allow_personal_email=True)
        self.assertEqual(r["status"], "pass")
        self.assertTrue(r["evidence"]["personal_email_affiliation_documented"])

    def test_proton_personal_email_from_external_profile_requires_documented_affiliation(self):
        r = assess(email="maker@proton.me", official_domain="tinymoon.dev", source_url="https://profile.example/maker",
                   verification="human_confirmed", verified_email="maker@proton.me", employee_affiliation=True,
                   affiliation_evidence="maker@proton.me is the founder and developer of Tiny Moon Studio.",
                   affiliation_source_url="https://profile.example/maker", allow_personal_email=True)
        self.assertEqual(r["status"], "pass")

    def test_bare_personal_email_affiliation_boolean_is_not_enough(self):
        r = assess(email="maker@gmail.com", official_domain="tinymoon.dev", source_url="https://profile.example/maker",
                   verification="human_confirmed", verified_email="maker@gmail.com", employee_affiliation=True, allow_personal_email=True)
        self.assertEqual(r["status"], "needs_review")

    def test_personal_email_still_needs_deliverability(self):
        r = assess(email="maker@gmail.com", official_domain="tinymoon.dev", source_url="https://tinymoon.dev/contact",
                   verification="website_extracted", verified_email="maker@gmail.com", allow_personal_email=True)
        self.assertEqual(r["status"], "needs_review")

    def test_unsubscribe_suppression_rejects_personal_email(self):
        r = assess(email="maker@gmail.com", suppressed=True, suppression_reason="unsubscribe", allow_personal_email=True)
        self.assertEqual(r["status"], "rejected")


class ProtectedDiscovery(unittest.TestCase):
    def test_h_discover_never_creates_protected_indie_prospect(self):
        calls = []
        settings = {"campaigns": [{"type": "indie_game_developer", "status": "active",
                                   "criteria": {"sources": ["steam"], "keywords": ["anime game"]}}]}
        def rpc(name, args):
            calls.append((name, args))
            if name == "intel_agent_settings": return settings
            if name == "intel_agent_sources": return {"steam": {"enabled": True}}
            if name == "intel_agent_source_use": return 1
            return None
        from unittest.mock import patch
        try:
            with patch("kairflow_intel.jobs.sources.discover_batch", return_value={"candidates": [
                {"name": "Brain Jar Games", "website": "", "meta": {"game": "Unannounced Game", "project_title": "Unannounced Game", "project_url": "https://store.steampowered.com/app/12345/", "source_url": "https://store.steampowered.com/app/12345/", "steam_appid": "12345", "source_key": "steam"}},
                {"name": "Small Studio", "website": "", "meta": {"game": "Lie of Caelum: Spirit", "project_title": "Lie of Caelum: Spirit", "project_url": "https://store.steampowered.com/app/54321/", "source_url": "https://store.steampowered.com/app/54321/", "steam_appid": "54321", "source_key": "steam"}},
            ], "next_cursor": {}}):
                d = jobs.Deps(cfg=None, rpc=rpc, fetcher=None, zoho=None, llm=None)
                result = jobs.h_discover(d, {"payload": {"type": "indie_game_developer"}})
        finally:
            pass
        self.assertEqual(result["new"], 0)
        self.assertFalse(any(name == "intel_agent_upsert_prospect" for name, _ in calls))


class ProjectFirstResearchSource(unittest.TestCase):
    def test_indie_project_store_page_can_be_researched_without_developer_website(self):
        class Fetcher:
            def __init__(self): self.urls = []
            def fetch(self, url):
                self.urls.append(url)
                return url, "<html><title>Moonlit Blade</title><body>Anime-inspired fantasy action RPG.</body></html>"
        fetcher = Fetcher()
        calls = []
        prospect = {"id": "prospect-1", "type": "indie_game_developer", "name": "Tiny Moon Studio", "website": "", "status": "discovered",
                    "domain": "", "project_source_url": "https://store.steampowered.com/app/12345/",
                    "contact_email": "", "contact_name": "", "facts": {"verified": {
                        "steam_appid": "12345", "project_title": "Moonlit Blade",
                        "project_announcement_date": "2026-05-01", "project_expected_release_date": "2027",
                        "marketing_milestones": [{"title": "Demo launch", "date": "2026-12-01", "verified": True}],
                    }}}
        def rpc(name, args):
            calls.append((name, args))
            if name == "intel_agent_indie_suppression_facts":
                return {"suppressed": False, "bounced": False, "complained": False, "suppression_reason": ""}
            return {}
        result = research.research(rpc, fetcher, lambda text: {}, {"prospect": prospect})
        self.assertEqual(fetcher.urls[0], prospect["project_source_url"])
        self.assertEqual(result["pages"], 1)
        upsert = next(args for name, args in calls if name == "intel_agent_upsert_prospect")
        self.assertEqual(upsert["p_website"], "")
        self.assertEqual(upsert["p_verified"]["steam_appid"], "12345")
        self.assertEqual(upsert["p_verified"]["project_announcement_date"], "2026-05-01")
        self.assertEqual(upsert["p_verified"]["project_expected_release_date"], "2027")
        self.assertEqual(upsert["p_verified"]["marketing_milestones"][0]["title"], "Demo launch")


    def test_kickstarter_research_uses_only_separate_developer_site_and_preserves_manual_provenance(self):
        class Fetcher:
            def __init__(self): self.urls = []
            def fetch(self, url):
                self.urls.append(url)
                return url, "<html><title>Moon Studio</title><body>We develop Moonlit Blade, an anime-inspired action RPG.</body></html>"
        fetcher = Fetcher()
        calls = []
        website = "https://moonstudio.example/"
        project_url = "https://www.kickstarter.com/projects/moondev/moonlit-blade/"
        prospect = {"id": "prospect-ks", "type": "indie_game_developer", "name": "Moon Studio", "website": website,
                    "status": "discovered", "domain": "moonstudio.example", "project_source_url": project_url,
                    "contact_email": "", "contact_name": "", "facts": {"verified": {
                        "project_title": "Moonlit Blade", "project_url": project_url, "project_source_url": project_url,
                        "source_key": "kickstarter_manual", "creator_name": "Moon Dev", "developer_name": "Moon Studio",
                        "developer_identity_status": "admin_attributed_unverified", "kickstarter_creator_role": "unverified",
                        "permission_confirmed_by_admin": True, "permission_reference": "LEGAL-APPROVAL-42",
                        "permission_recorded_at": "2026-11-12T10:00:00Z", "discovery_method": "administrator_manual_url_import"}}}
        def rpc(name, args):
            calls.append((name, args))
            if name == "intel_agent_indie_suppression_facts":
                return {"suppressed": False, "bounced": False, "complained": False, "suppression_reason": ""}
            return {}
        result = research.research(rpc, fetcher, lambda text: {}, {"prospect": prospect})
        self.assertEqual(fetcher.urls[0], website)
        self.assertNotIn(project_url, fetcher.urls)
        upsert = next(args for name, args in calls if name == "intel_agent_upsert_prospect")
        for key, value in (("source_key", "kickstarter_manual"), ("creator_name", "Moon Dev"),
                           ("developer_identity_status", "admin_attributed_unverified"),
                           ("permission_reference", "LEGAL-APPROVAL-42"), ("project_source_url", project_url)):
            self.assertEqual(upsert["p_verified"][key], value)

    def test_h_research_stops_before_crawling_a_protected_account(self):
        calls = []
        prospect = {"id": "prospect-2", "type": "indie_game_developer", "name": "Brain Jar Games", "website": "https://example.dev",
                    "domain": "example.dev", "status": "discovered", "facts": {"verified": {}}}
        def rpc(name, args):
            calls.append((name, args))
            if name == "intel_agent_context": return {"prospect": prospect}
            return None
        class NeverFetch:
            def fetch(self, url): raise AssertionError("protected account must not be crawled")
        d = jobs.Deps(cfg=None, rpc=rpc, fetcher=NeverFetch(), zoho=None, llm=None)
        result = jobs.h_research(d, {"payload": {"prospect_id": "prospect-2"}})
        self.assertEqual(result["skipped"], "protected account")
        blocked = next(args for name, args in calls if name == "intel_agent_mark_indie_blocked")
        self.assertEqual(blocked["p_status"], "rejected")

    def test_h_research_holds_when_suppression_lookup_is_unavailable(self):
        prospect = {"id": "prospect-4", "type": "indie_game_developer", "name": "Tiny Moon Studio", "website": "https://game.example",
                    "domain": "game.example", "status": "discovered", "contact_email": "maker@game.example", "facts": {"verified": {}}}
        def rpc(name, args):
            if name == "intel_agent_context": return {"prospect": prospect}
            if name == "intel_agent_indie_suppression_facts": return {}
            return None
        class NeverFetch:
            def fetch(self, url): raise AssertionError("suppression lookup failure must hold research")
        d = jobs.Deps(cfg=None, rpc=rpc, fetcher=NeverFetch(), zoho=None, llm=None)
        with self.assertRaises(jobs.TransientError):
            jobs.h_research(d, {"payload": {"prospect_id": "prospect-4"}})

    def test_h_research_marks_suppressed_contact_and_does_not_crawl(self):
        calls = []
        prospect = {"id": "prospect-3", "type": "indie_game_developer", "name": "Tiny Moon Studio", "website": "https://game.example",
                    "domain": "game.example", "status": "discovered", "contact_email": "maker@game.example", "facts": {"verified": {}}}
        def rpc(name, args):
            calls.append((name, args))
            if name == "intel_agent_context": return {"prospect": prospect}
            if name == "intel_agent_indie_suppression_facts": return {"suppressed": True, "bounced": False, "complained": False, "suppression_reason": "unsubscribe"}
            return None
        class NeverFetch:
            def fetch(self, url): raise AssertionError("suppressed contact must not be crawled")
        d = jobs.Deps(cfg=None, rpc=rpc, fetcher=NeverFetch(), zoho=None, llm=None)
        result = jobs.h_research(d, {"payload": {"prospect_id": "prospect-3"}})
        self.assertEqual(result["skipped"], "suppressed contact")
        blocked = next(args for name, args in calls if name == "intel_agent_mark_indie_blocked")
        self.assertEqual(blocked["p_status"], "suppressed")

    def test_h_research_does_not_skip_indie_project_without_developer_website(self):
        class Fetcher:
            def __init__(self): self.urls = []
            def fetch(self, url):
                self.urls.append(url)
                return url, "<html><title>Moonlit Blade</title><body>Anime-inspired fantasy action RPG.</body></html>"
        class LLM:
            def generate_json(self, instruction, untrusted, schema, fast=False, **kwargs): return {}
        fetcher = Fetcher()
        prospect = {"id": "prospect-1", "type": "indie_game_developer", "name": "Tiny Moon Studio", "website": "", "status": "discovered",
                    "domain": "", "project_source_url": "https://store.steampowered.com/app/12345/",
                    "contact_email": "", "contact_name": "", "facts": {"verified": {
                        "steam_appid": "12345", "project_title": "Moonlit Blade",
                        "project_announcement_date": "2026-05-01", "project_expected_release_date": "2027",
                        "marketing_milestones": [{"title": "Demo launch", "date": "2026-12-01", "verified": True}],
                    }}}
        def rpc(name, args):
            if name == "intel_agent_context": return {"prospect": prospect}
            if name == "intel_agent_sources": return {"site_crawler": {"enabled": True}}
            if name == "intel_agent_source_use": return 1
            if name == "intel_agent_indie_suppression_facts": return no_suppression()
            return None
        d = jobs.Deps(cfg=None, rpc=rpc, fetcher=fetcher, zoho=None, llm=LLM())
        result = jobs.h_research(d, {"payload": {"prospect_id": "prospect-1"}})
        self.assertEqual(result["pages"], 1)
        self.assertEqual(fetcher.urls[0], prospect["project_source_url"])


class ResearchQualificationIntegration(unittest.TestCase):
    def make_context(self, visual=True):
        from datetime import date, timedelta
        p = {
            "id": "p-v2", "type": "indie_game_developer", "status": "researched", "name": "Tiny Moon Studio",
            "domain": "tinymoon.dev", "contact_name": "Mika", "contact_email": "mika@tinymoon.dev",
            "contact_source_url": "https://tinymoon.dev/contact", "project_title": "Moonlit Blade",
            "project_source_url": "https://store.steampowered.com/app/12345/",
            "project_expected_release_date": date.today() + timedelta(days=120),
            "project_announcement_date": date.today() - timedelta(days=180),
            "project_latest_activity_date": date.today() - timedelta(days=30),
            "facts": {"verified": {"game": "Moonlit Blade", "source": "steam", "steam_appid": "12345",
                        "contact_verification": "human_confirmed", "contact_email": "mika@tinymoon.dev",
                        "contact_source_url": "https://tinymoon.dev/contact", "team_size": 3}},
        }
        evidence = [ev("project_description"), ev("devlog", "https://game.example/devlog")]
        if visual:
            evidence.append(ev("anime_visual_screenshot", "https://cdn.game.example/screenshot.png"))
        return {"prospect": p, "evidence": evidence}

    def test_qualification_persists_model_gates_and_evidence_ids(self):
        calls = []
        def rpc(name, args):
            calls.append((name, args))
            if name == "intel_agent_indie_suppression_facts": return no_suppression()
            return None
        ctx = self.make_context()
        result = research.qualify(rpc, ctx, {})
        self.assertEqual(result.decision, "qualified")
        write = next(args for name, args in calls if name == "intel_agent_set_score")
        q = write["p_estimates"]["qualification_v2"]
        self.assertEqual(q["model"], scoring.INDIE_MODEL)
        self.assertTrue(all(g["passed"] for g in q["mandatory_gates"].values()))
        self.assertEqual(q["evidence_count"], 3)
        self.assertEqual(len(q["evidence_ids"]), 3)
        self.assertFalse(write["p_estimates"]["suppression"]["suppressed"])
        self.assertIn("bounced", write["p_estimates"]["suppression"])

    def test_contact_form_without_email_is_not_verified_contactability(self):
        def rpc(name, args):
            if name == "intel_agent_indie_suppression_facts": return no_suppression()
            return None
        ctx = self.make_context()
        ctx["prospect"]["contact_email"] = ""
        ctx["prospect"]["contact_source_url"] = "https://tinymoon.dev/contact"
        ctx["prospect"]["facts"]["verified"].update({"contact_email": "", "contact_source_url": "https://tinymoon.dev/contact"})
        result = research.qualify(rpc, ctx, {})
        self.assertEqual(result.decision, "rejected")
        self.assertFalse(result.mandatory_gates["verified_usable_email"]["passed"])

    def test_missing_email_remains_rejected_when_suppression_lookup_is_unavailable(self):
        def rpc(name, args):
            if name == "intel_agent_indie_suppression_facts": raise RuntimeError("unavailable")
            return None
        ctx = self.make_context()
        ctx["prospect"]["contact_email"] = ""
        ctx["prospect"]["facts"]["verified"]["contact_email"] = ""
        result = research.qualify(rpc, ctx, {})
        self.assertEqual(result.decision, "rejected")
        self.assertFalse(result.mandatory_gates["verified_usable_email"]["passed"])

    def test_documented_personal_developer_email_passes_the_indie_research_path(self):
        calls = []
        def rpc(name, args):
            calls.append((name, args))
            if name == "intel_agent_indie_suppression_facts": return no_suppression()
            return None
        ctx = self.make_context()
        p = ctx["prospect"]
        p["contact_email"] = "mika@gmail.com"
        p["contact_source_url"] = ""
        p["facts"]["verified"].update({
            "contact_email": "mika@gmail.com", "contact_verification": "human_confirmed",
            "contact_source_url": "", "employee_affiliation_evidence": True,
            "personal_email_affiliation_evidence": "mika@gmail.com is the founder and game developer at Tiny Moon Studio.",
            "personal_email_affiliation_source_url": "https://profile.example/mika",
        })
        result = research.qualify(rpc, ctx, {})
        self.assertEqual(result.decision, "qualified")
        self.assertEqual(result.contactability["status"], "pass")
        self.assertTrue(result.contactability["evidence"]["personal_email_affiliation_documented"])

    def test_verified_unsubscribe_or_bounce_overrides_empty_suppression_lookup(self):
        for flag in ("unsubscribed", "bounced", "complained", "do_not_contact"):
            calls = []
            def rpc(name, args):
                calls.append((name, args))
                if name == "intel_agent_indie_suppression_facts": return no_suppression()
                return None
            ctx = self.make_context()
            ctx["prospect"]["facts"]["verified"][flag] = True
            result = research.qualify(rpc, ctx, {})
            self.assertEqual(result.decision, "rejected", flag)
            self.assertFalse(result.mandatory_gates["suppression_clear"]["passed"], flag)

    def test_previously_suppressed_prospect_cannot_be_requalified(self):
        calls = []
        def rpc(name, args):
            calls.append((name, args))
            if name == "intel_agent_indie_suppression_facts": return no_suppression()
            return None
        ctx = self.make_context()
        ctx["prospect"]["status"] = "suppressed"
        result = research.qualify(rpc, ctx, {})
        self.assertEqual(result.decision, "rejected")
        self.assertFalse(result.mandatory_gates["suppression_clear"]["passed"])

    def test_suppression_lookup_failure_fails_closed_to_review(self):
        calls = []
        def rpc(name, args):
            calls.append((name, args))
            if name == "intel_agent_indie_suppression_facts": raise RuntimeError("unavailable")
            return None
        result = research.qualify(rpc, self.make_context(), {})
        self.assertEqual(result.decision, "needs_review")
        self.assertEqual(result.contactability["status"], "needs_review")

    def test_incomplete_suppression_rpc_result_fails_closed(self):
        def rpc(name, args):
            if name == "intel_agent_indie_suppression_facts": return {}
            return None
        result = research.qualify(rpc, self.make_context(), {})
        self.assertEqual(result.decision, "needs_review")
        self.assertEqual(result.contactability["status"], "needs_review")

    def test_fully_qualified_indie_project_enqueues_resolve(self):
        ctx = self.make_context(visual=True)
        enqueued = []
        class D:
            def rpc(self, name, args=None):
                if name == "intel_agent_context": return ctx
                if name == "intel_agent_indie_context": return ctx
                if name == "intel_agent_settings": return {"campaigns": [{"type": "indie_game_developer", "criteria": {}}]}
                if name == "intel_agent_indie_suppression_facts": return no_suppression()
                if name == "intel_agent_set_score": return None
                return None
        original = jobs._enq
        jobs._enq = lambda d, kind, payload, key: enqueued.append(kind)
        try:
            out = jobs.h_qualify(D(), {"payload": {"prospect_id": "p-v2"}})
        finally:
            jobs._enq = original
        self.assertEqual(out["decision"], "qualified")
        self.assertIn("resolve", enqueued)

    def test_missing_anime_visual_evidence_cannot_enqueue_resolve(self):
        ctx = self.make_context(visual=False)
        enqueued = []
        class D:
            def rpc(self, name, args=None):
                if name == "intel_agent_context": return ctx
                if name == "intel_agent_indie_context": return ctx
                if name == "intel_agent_settings": return {"campaigns": [{"type": "indie_game_developer", "criteria": {}}]}
                if name == "intel_agent_indie_suppression_facts": return no_suppression()
                return None
        original = jobs._enq
        jobs._enq = lambda d, kind, payload, key: enqueued.append(kind)
        try:
            out = jobs.h_qualify(D(), {"payload": {"prospect_id": "p-v2"}})
        finally:
            jobs._enq = original
        self.assertEqual(out["decision"], "needs_review")
        self.assertNotIn("resolve", enqueued)


if __name__ == "__main__":
    unittest.main()
