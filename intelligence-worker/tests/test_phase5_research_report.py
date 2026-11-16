"""Phase 5: the research report (confirmed vs inferred vs missing) and per-source discovery yield. Mocked fixtures only: no live source was fetched."""
import json
import unittest
from datetime import date
from unittest.mock import patch

from kairflow_intel import jobs, research, research_report
from .test_discovery import FakeD

TODAY = date(2026, 11, 13)


def prospect(**kw):
    return {"id": "i1", "type": "indie_game_developer", "origin": "discovered", "status": "discovered", "website": "https://studio.example/",
            "domain": "studio.example", "name": "Tiny Moon Studio", "project_title": "Moonlit Blade", "contact_email": "", "contact_name": "",
            "facts": {"verified": {"project_title": "Moonlit Blade"}}, **kw}


def ev(fact, snippet, url="https://studio.example/news", verified=True):
    return {"fact_type": fact, "snippet": snippet, "url": url, "verified": verified, "source": "web"}


class ReportContent(unittest.TestCase):
    def test_inference_is_labelled_and_lists_the_facts_it_rests_on(self):
        rows = [ev("trailer", "Our trailer is out."), ev("upcoming_release", "Demo coming soon."), ev("style_anime", "An anime-inspired RPG.")]
        r = research_report.build(prospect(), {}, rows, today=TODAY)
        need = next(i for i in r["inferences"] if i["statement"] == "animation need")
        self.assertEqual(need["level"], "plausible")
        self.assertEqual(set(need["basis"]), {"trailer", "upcoming_release", "style_anime"})
        self.assertIn("has not said", need["note"])

    def test_evidenced_need_requires_the_team_to_say_so(self):
        r = research_report.build(prospect(), {}, [ev("seeking_animation", "We are looking for an animator.")], today=TODAY)
        self.assertEqual(r["inferences"][0]["level"], "evidenced")
        r = research_report.build(prospect(), {}, [ev("style_anime", "Anime style.")], today=TODAY)
        self.assertEqual(r["inferences"][0]["level"], "possible")
        r = research_report.build(prospect(), {}, [], today=TODAY)
        self.assertEqual(r["inferences"][0]["level"], "unknown")

    def test_unverified_candidates_never_count_as_confirmed(self):
        rows = [ev("visual_asset_candidate", "Unverified image candidate: https://cdn.example/a.jpg | art", verified=False), ev("trailer", "x", verified=False)]
        r = research_report.build(prospect(), {}, rows, today=TODAY)
        self.assertEqual(r["confirmed_facts"], [])
        self.assertEqual(r["evidence_counts"], {"confirmed": 0, "unverified": 2, "pages_read": 0})
        self.assertEqual(len(r["unverified_for_review"]), 2)
        self.assertEqual(r["inferences"][0]["level"], "unknown")

    def test_missing_contact_identity_and_activity_are_reported_as_gaps_not_filled(self):
        r = research_report.build(prospect(website=""), {"developer_identity_status": "platform_creator_unverified"}, [], pages_read=0, today=TODAY)
        self.assertEqual(r["contact"]["contact_email"], "")
        self.assertFalse(r["identity"]["confirmed"])
        for gap in ("no official website recorded", "no verified contact email", "no explicit dated development update found", "no pages were read"):
            self.assertIn(gap, r["gaps"])
        self.assertTrue(any("identity" in g for g in r["gaps"]))

    def test_identity_is_confirmed_by_the_platform_listing_or_by_the_official_site_naming_both(self):
        self.assertTrue(research_report.build(prospect(), {"developer_identity_status": "store_listed_developer"}, [], today=TODAY)["identity"]["confirmed"])
        both = [ev("developer_identity", "Tiny Moon Studio is developing"), ev("project_identity", "Moonlit Blade, an RPG")]
        self.assertTrue(research_report.build(prospect(), {"developer_identity_status": "platform_creator_unverified"}, both, today=TODAY)["identity"]["confirmed"])
        one = [ev("developer_identity", "Tiny Moon Studio is developing")]
        self.assertFalse(research_report.build(prospect(), {"developer_identity_status": "platform_creator_unverified"}, one, today=TODAY)["identity"]["confirmed"])

    def test_stale_activity_is_called_out_with_its_age(self):
        r = research_report.build(prospect(), {"project_latest_activity_date": "2026-01-01"}, [], today=TODAY)
        self.assertEqual(r["activity"]["days_since_latest_update"], 316)
        self.assertTrue(any("316 days old" in g for g in r["gaps"]))

    def test_studio_report_uses_outsourcing_evidence(self):
        studio = prospect(type="animation_studio_support", project_title="", name="Example Studio")
        r = research_report.build(studio, {}, [ev("external_collab", "We take commissioned work."), ev("anime_production", "anime series")], today=TODAY)
        self.assertEqual(r["inferences"][0]["statement"], "outsourcing capacity")
        self.assertEqual(r["inferences"][0]["level"], "evidenced")

    def test_report_is_json_safe_bounded_and_has_a_plain_summary(self):
        rows = [ev("style_2d", "x" * 5000, url=f"https://studio.example/p{i}") for i in range(60)]
        r = research_report.build(prospect(), {}, rows, today=TODAY)
        json.dumps(r)
        self.assertLessEqual(len(r["confirmed_facts"]), 16)
        self.assertTrue(all(len(f["evidence"]) <= 240 for f in r["confirmed_facts"]))
        self.assertLessEqual(len(r["sources"]), 30)
        self.assertIn("identity NOT confirmed", r["summary"])
        self.assertLess(len(json.dumps(r)), 20000)

    def test_report_never_contains_an_address_or_name_that_is_not_already_on_record(self):
        r = research_report.build(prospect(), {"contact_role": "Producer"}, [ev("style_2d", "2D art")], today=TODAY)
        dumped = json.dumps(r)
        self.assertNotIn("@", dumped)
        self.assertEqual(r["contact"]["named_contact"], "")


class ReportRegressions(unittest.TestCase):
    def test_a_legacy_or_unverified_email_is_not_presented_as_sourced(self):
        for status in ("unknown_legacy", "not_verified_this_run", ""):
            r = research_report.build(prospect(), {"contact_verification": status, "contact_email": "old@studio.example"}, [], today=TODAY)
            self.assertEqual(r["contact"]["contact_email"], "", status)
            self.assertIn("no verified contact email", r["gaps"])
            self.assertNotIn("old@studio.example", json.dumps(r))
        r = research_report.build(prospect(), {"contact_verification": "website_extracted", "contact_email": "hi@studio.example"}, [], today=TODAY)
        self.assertEqual(r["contact"]["contact_email"], "hi@studio.example")
        self.assertNotIn("no verified contact email", r["gaps"])

    def test_internal_bookkeeping_rows_are_not_reported_as_facts(self):
        rows = [ev("rescore_candidate_studio_v2", '{"score": 80}'), ev("website_recovery", "recovered"), ev("style_2d", "2D art.")]
        r = research_report.build(prospect(), {}, rows, today=TODAY)
        self.assertEqual([f["type"] for f in r["confirmed_facts"]], ["style_2d"])
        self.assertEqual(r["evidence_counts"]["confirmed"], 1)

    def test_events_are_listed_newest_first_with_undated_last(self):
        rows = [ev("development_update", "old [explicit page date: 2026-01-05]"), ev("development_update", "undated post"),
                ev("project_announcement", "new [structured datePublished: 2026-10-10]")]
        dates = [e["date"] for e in research_report.build(prospect(), {}, rows, today=TODAY)["activity"]["events"]]
        self.assertEqual(dates, ["2026-10-10", "2026-01-05", None])

    def test_publisher_and_identity_status_fall_back_to_discovery_time_facts(self):
        p = prospect(facts={"verified": {"publisher_name": "Thermite Games", "developer_identity_status": "store_listed_developer"}})
        r = research_report.build(p, {}, [], today=TODAY)
        self.assertEqual(r["identity"]["publisher"], "Thermite Games")
        self.assertTrue(r["identity"]["confirmed"])


class DeeperChecks(unittest.TestCase):
    STUDIO = dict(type="animation_studio_support", project_title="", name="Example Studio")

    def test_a_hiring_sentence_is_not_outsourcing_capability(self):
        rows = [ev("outsourcing", "We are hiring freelance animators to join our team."), ev("anime_production", "anime series")]
        r = research_report.build(prospect(**self.STUDIO), {}, rows, today=TODAY)
        self.assertNotEqual(r["inferences"][0]["level"], "evidenced")
        rows.append(ev("outsourcing", "We work with partner studios and freelancers on every cour."))
        self.assertEqual(research_report.build(prospect(**self.STUDIO), {}, rows, today=TODAY)["inferences"][0]["level"], "evidenced")

    def test_future_dated_activity_is_ignored_and_flagged(self):
        r = research_report.build(prospect(), {"project_latest_activity_date": "2027-03-01"}, [], today=TODAY)
        self.assertIsNone(r["activity"]["latest_development_update"])
        self.assertIsNone(r["activity"]["days_since_latest_update"])
        self.assertTrue(any("in the future" in g for g in r["gaps"]))
        self.assertNotIn("0 days ago", r["summary"])

    def test_malformed_stored_data_never_raises_and_always_serialises(self):
        import random
        rnd = random.Random(5)
        junk = [None, "", "x", 7, 3.5, [], [1, "a"], {}, {"a": None}, True, "2026-13-45", "9999-99-99", {"status": 5}]
        keys = ["facts", "name", "project_title", "website", "type", "contact_name", "contact_source_url"]
        vkeys = ["developer_identity_status", "contact_verification", "contact_email", "project_latest_activity_date", "project_announcement_date",
                 "team_size", "contactability", "publisher_name", "project_url", "source_key"]
        for _ in range(400):
            p = {k: rnd.choice(junk) for k in keys if rnd.random() < .7}
            p["type"] = rnd.choice(["indie_game_developer", "animation_studio_support", None, 5])
            v = {k: rnd.choice(junk) for k in vkeys if rnd.random() < .7}
            rows = [rnd.choice([None, 3, "x", {}, {"fact_type": rnd.choice(["style_2d", "trailer", "outsourcing", None, 4, "development_update"]),
                                                   "snippet": rnd.choice(junk), "url": rnd.choice(junk), "verified": rnd.choice(junk)}]) for _ in range(rnd.randint(0, 6))]
            r = research_report.build(rnd.choice([p, None, "bad"]), rnd.choice([v, None, []]), rnd.choice([rows, None]),
                                      contactability=rnd.choice([None, {}, "x", {"status": "ok"}]), pages_read=rnd.choice([0, 3, None, "2"]), today=TODAY)
            json.dumps(r)


class ResearchWritesTheReport(unittest.TestCase):
    HTML = '''<html lang="en"><body><p>Tiny Moon Studio is developing Moonlit Blade, an anime-inspired 2D action RPG. We are looking for an animator for our trailer.</p>
        <article><time datetime="2026-10-10">October 10</time><p>Development update: a new build is out.</p></article>
        <p>Write to hello@studio.example</p></body></html>'''

    def run_research(self, llm):
        html = self.HTML
        class Fetch:
            def fetch(self, url): return url, html
        calls = []
        def rpc(name, args):
            calls.append((name, args))
            if name == "intel_agent_indie_suppression_facts":
                return {"suppressed": False, "bounced": False, "complained": False, "suppression_reason": ""}
            return {}
        research.research(rpc, Fetch(), llm, {"prospect": prospect()})
        return next(a["p_verified"] for n, a in calls if n == "intel_agent_upsert_prospect")

    def test_report_is_stored_and_reflects_this_runs_evidence(self):
        v = self.run_research(lambda _: {"contact_name": None, "contact_role": None})
        rep = v["research_report"]
        self.assertEqual(rep["inferences"][0]["level"], "evidenced")
        self.assertEqual(rep["activity"]["latest_development_update"], "2026-10-10")
        self.assertEqual(rep["contact"]["contact_email"], "hello@studio.example")
        self.assertTrue(rep["identity"]["confirmed"] is False or rep["identity"]["confirmed"] is True)
        self.assertTrue(rep["sources"])
        self.assertIn("evidence", rep["summary"].lower())

    def test_report_does_not_depend_on_what_the_model_returned(self):
        a = self.run_research(lambda _: {"contact_name": None, "contact_role": None})["research_report"]
        b = self.run_research(lambda _: {"contact_name": "Hanako Sato", "contact_role": "Producer"})["research_report"]
        a.pop("generated_at"); b.pop("generated_at")
        self.assertEqual(a, b)

    def test_a_report_failure_cannot_lose_the_research(self):
        with patch("kairflow_intel.research.research_report.build", side_effect=RuntimeError("boom")):
            with self.assertLogs("kairflow_intel.research", level="WARNING"):
                v = self.run_research(lambda _: {"contact_name": None, "contact_role": None})
        self.assertEqual(v["research_report"]["error"], "RuntimeError")
        self.assertFalse(research_report.is_usable(v["research_report"]))
        self.assertTrue(research_report.summarize(v["research_report"]))
        self.assertIn("signals", v)


class DiscoveryYield(unittest.TestCase):
    def test_discovery_reports_new_known_and_suppressed_per_source(self):
        results = iter([{"prospect_id": "A", "created": True, "suppressed": False}, {"prospect_id": "B", "created": False, "suppressed": False},
                        {"prospect_id": "C", "created": True, "suppressed": True}, {"prospect_id": "D", "created": True, "suppressed": False}])
        d = FakeD({
            "intel_agent_settings": {"today": "2026-11-13", "campaigns": [{"type": "indie_game_developer", "status": "active", "criteria": {"sources": ["steam", "itch"], "keywords": ["anime"]}}]},
            "intel_agent_sources": {"steam": {}, "itch": {}}, "intel_agent_source_use": 1, "intel_agent_record_item": {"new": True}, "intel_agent_enqueue_job": "job",
        })
        d.answers["intel_agent_upsert_prospect"] = lambda args: next(results)
        cands = []
        for n, (src, name) in enumerate([("steam", "A"), ("steam", "B"), ("itch", "C"), ("itch", "D")]):
            host = "store.steampowered.com/app" if src == "steam" else "dev.itch.io"
            url = f"https://{host}/{n}/"
            cands.append({"name": name, "website": "", "meta": {"source": src, "source_key": src, "project_title": f"Game {n}", "project_url": url, "source_url": url,
                                                              "project_id": f"{src}:{n}", "developer_name": name}})
        with patch("kairflow_intel.jobs.sources.discover_batch", return_value={"candidates": cands, "next_cursor": {}}):
            out = jobs.h_discover(d, {"payload": {"type": "indie_game_developer", "limit": 25}})
        self.assertEqual(out["by_source"]["steam"], {"seen": 2, "new": 1, "already_known": 1, "suppressed": 0, "skipped": 0})
        self.assertEqual(out["by_source"]["itch"], {"seen": 2, "new": 1, "already_known": 0, "suppressed": 1, "skipped": 0})
        self.assertEqual(out["new"], 2)
        self.assertEqual(out["duplicate_rate"], 0.25)



class Phase5BugfixRegression(unittest.TestCase):
    def _need(self, snippet):
        r = research_report.build(prospect(), {}, [ev("seeking_animation", snippet)], today=TODAY)
        return next(i for i in r["inferences"] if i["statement"] == "animation need")["level"]

    def test_negated_or_ended_seeking_sentences_are_not_detected(self):
        from kairflow_intel import signals
        for text in ["We are NOT looking for an animator right now.", "We are no longer looking for animators.",
                     "We already hired an animator.", "We do not need animation support.",
                     "We are not hiring animators and do not need animation support."]:
            self.assertNotIn("seeking_animation", signals.detect_indie(text), text)
        self.assertIn("seeking_animation", signals.detect_indie("We are looking for an animator for our trailer."))
        # a later, affirmative match is still found even when an earlier one is negated
        self.assertIn("seeking_animation", signals.detect_indie("We are not hiring animators. But we are seeking an animation partner."))

    def test_report_does_not_call_negated_or_animated_trailer_evidence_strong(self):
        self.assertNotEqual(self._need("We are NOT looking for an animator right now."), "evidenced")
        self.assertNotEqual(self._need("Our new animated trailer is out!"), "evidenced")
        self.assertEqual(self._need("We are looking for an animator for our trailer."), "evidenced")

    def test_failure_stub_is_safe_for_every_consumer(self):
        stub = research_report.failure_stub(ValueError("x"))
        self.assertFalse(research_report.is_usable(stub))
        self.assertEqual(research_report.summarize(stub), "Research report unavailable (ValueError).")
        self.assertTrue(stub["gaps"] and stub["summary"])
        self.assertTrue(research_report.is_usable(research_report.build(prospect(), {}, [], today=TODAY)))
        self.assertEqual(research_report.summarize({}), "Research report unavailable.")

    def test_string_false_is_not_verified(self):
        rows = [{"fact_type": "trailer", "snippet": "t", "url": "u", "verified": "false"}]
        self.assertEqual(research_report.build(prospect(), {}, rows, today=TODAY)["evidence_counts"]["confirmed"], 0)
        rows[0]["verified"] = True
        self.assertEqual(research_report.build(prospect(), {}, rows, today=TODAY)["evidence_counts"]["confirmed"], 1)

    def test_default_today_is_utc(self):
        self.assertEqual(research_report._today_utc(), __import__("datetime").datetime.now(__import__("datetime").timezone.utc).date())


if __name__ == "__main__":
    unittest.main()
