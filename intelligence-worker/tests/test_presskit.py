"""Press-kit reading (presskit.py), its research step, its report section and the optional discovery source.
Synthetic fixtures only: no live page was fetched, so selectors are untested against real press kits."""
import unittest
from datetime import date
from unittest.mock import patch

from kairflow_intel import jobs, presskit, research, research_report, sources
from kairflow_intel.errors import PermanentError
from .test_discovery import FakeD

KIT = '''<html lang="en"><head><title>Moonlit Blade - Press Kit</title></head><body><h1>Moonlit Blade</h1><p>Press kit</p>
<div id="factsheet"><h2>Factsheet</h2>
<p><strong>Developer:</strong><br><a href="https://moon.example">Tiny Moon Studio</a></p>
<p><strong>Publisher:</strong><br>Lantern Games</p>
<p><strong>Release date:</strong><br>March 3, 2027</p><p><strong>Platforms:</strong><br>Windows, Switch</p>
<p><strong>Website:</strong><br><a href="https://moon.example/">moon.example</a></p>
<p><strong>Press / Business contact:</strong><br><a href="mailto:press@moon.example">press@moon.example</a></p></div>
<footer>stray@elsewhere.example <a href="https://store.steampowered.com/app/1/">Steam</a> <a href="https://www.kickstarter.com/projects/x/y">KS</a></footer></body></html>'''
HOME = '<html><body><p>Tiny Moon Studio makes Moonlit Blade.</p><a href="/presskit/">Press kit</a><a href="https://other.example/press/">elsewhere</a></body></html>'
URL = "https://moon.example/presskit/"


class Parse(unittest.TestCase):
    def test_presskit_factsheet_is_read(self):
        k = presskit.parse(KIT, URL, site_host="moon.example")
        self.assertTrue(k["is_presskit"])
        self.assertEqual(k["title"], "Moonlit Blade")
        vals = {f["fact_type"]: f["value"] for f in k["facts"]}
        self.assertEqual(vals["presskit_developer"], "Tiny Moon Studio")
        self.assertEqual(vals["presskit_publisher"], "Lantern Games")
        self.assertEqual(vals["presskit_release"], "March 3, 2027")
        self.assertEqual(vals["presskit_platforms"], "Windows, Switch")
        self.assertEqual(k["website"], "https://moon.example")
        self.assertTrue(all(f["verified"] for f in k["facts"]))

    def test_email_only_from_a_labelled_contact_field(self):
        k = presskit.parse(KIT, URL, site_host="moon.example")
        self.assertEqual([e["email"] for e in k["press_emails"]], ["press@moon.example"])
        self.assertTrue(k["press_emails"][0]["on_site_domain"])
        self.assertNotIn("stray@elsewhere.example", str(k))

    def test_other_domain_press_address_is_flagged(self):
        html = KIT.replace("press@moon.example", "pr@agency.example")
        k = presskit.parse(html, URL, site_host="moon.example")
        self.assertFalse(k["press_emails"][0]["on_site_domain"])

    def test_links_are_recorded_not_followed(self):
        k = presskit.parse(KIT, URL, site_host="moon.example")
        self.assertEqual(k["links"]["steam"], "https://store.steampowered.com/app/1/")
        self.assertIn("kickstarter", k["links"])

    def test_plain_press_page_and_definition_lists(self):
        plain = "<html><body><h1>Press</h1><p>Game press kit</p><p>Developer: Pine Games</p><p>Release date: 2027</p><p>Contact: hi@pine.example</p></body></html>"
        k = presskit.parse(plain, "https://pine.example/press", site_host="pine.example")
        self.assertTrue(k["is_presskit"])
        self.assertEqual([e["email"] for e in k["press_emails"]], ["hi@pine.example"])
        dl = "<html><body><h1>Media kit</h1><dl><dt>Developer</dt><dd>Fern Works</dd><dt>Platforms</dt><dd>PC</dd></dl></body></html>"
        k = presskit.parse(dl, "https://fern.example/media/", site_host="fern.example")
        self.assertEqual({f["fact_type"]: f["value"] for f in k["facts"]}["presskit_developer"], "Fern Works")

    def test_ordinary_page_and_hidden_text_are_not_a_press_kit(self):
        self.assertFalse(presskit.parse("<html><body><p>Developer: Someone</p><p>Our blog.</p></body></html>", "https://x.example/blog")["is_presskit"])
        hidden = '<html><body><h1>Press kit</h1><p style="display:none">Developer: Fake Studio</p></body></html>'
        k = presskit.parse(hidden, "https://x.example/presskit/")
        self.assertFalse(k["is_presskit"])
        for junk in (None, "", 5, "<<<"):
            self.assertFalse(presskit.parse(junk, "https://x.example/presskit/")["is_presskit"])


class CandidateUrls(unittest.TestCase):
    def test_links_first_same_host_only(self):
        self.assertEqual(presskit.candidate_urls("https://moon.example/", HOME), ["https://moon.example/presskit/"])

    def test_probes_conventional_paths_only_when_no_link(self):
        got = presskit.candidate_urls("https://moon.example/", "<html><body>hi</body></html>", limit=2)
        self.assertEqual(got, ["https://moon.example/presskit/", "https://moon.example/press/"])
        self.assertEqual(presskit.candidate_urls("https://moon.example/", "<html></html>", probe=False), [])

    def test_already_fetched_urls_are_skipped(self):
        self.assertEqual(presskit.candidate_urls("https://moon.example/", HOME, skip={"https://moon.example/presskit"}, probe=False), [])


def prospect():
    return {"id": "i1", "type": "indie_game_developer", "origin": "discovered", "status": "discovered", "website": "https://moon.example/",
            "domain": "moon.example", "name": "Tiny Moon Studio", "project_title": "Moonlit Blade", "contact_email": "", "contact_name": "",
            "facts": {"verified": {"project_title": "Moonlit Blade"}}}


class ResearchStep(unittest.TestCase):
    def run_research(self, pages):
        class Fetch:
            def fetch(self, url):
                if url in pages:
                    return url, pages[url]
                raise PermanentError("404")
        calls = []
        def rpc(name, args):
            calls.append((name, args))
            return {"suppressed": False, "bounced": False, "complained": False, "suppression_reason": ""} if name == "intel_agent_indie_suppression_facts" else {}
        research.research(rpc, Fetch(), lambda _: {"contact_name": None, "contact_role": None}, {"prospect": prospect()})
        return calls

    def test_linked_press_kit_becomes_evidence_facts_and_a_report_section(self):
        calls = self.run_research({"https://moon.example/": HOME, URL: KIT})
        facts = {a["p_fact_type"]: a["p_snippet"] for n, a in calls if n == "intel_agent_add_evidence"}
        self.assertEqual(facts["presskit_developer"], "Developer: Tiny Moon Studio")
        self.assertEqual(facts["presskit_publisher"], "Publisher: Lantern Games")
        v = next(a["p_verified"] for n, a in calls if n == "intel_agent_upsert_prospect")
        self.assertEqual(v["presskit_press_email"], "press@moon.example")
        rep = v["research_report"]
        self.assertTrue(rep["press_kit"]["found"])
        self.assertEqual(rep["press_kit"]["publisher"], "Lantern Games")
        self.assertEqual(rep["contact"]["press_contact_email"], "press@moon.example")
        self.assertIn("Press kit:", rep["summary"])
        # the home page links the kit, so the kit page is also an ordinary fetched page: its neither its press address nor its stray footer address may become the business contact
        self.assertNotEqual(v.get("contact_verification"), "website_extracted")
        self.assertEqual(rep["contact"]["contact_email"], "")

    def test_same_address_on_the_home_page_still_counts_as_the_contact(self):
        home = HOME.replace("</body>", '<p><a href="mailto:press@moon.example">press@moon.example</a></p></body>')
        calls = self.run_research({"https://moon.example/": home, URL: KIT})
        v = next(a["p_verified"] for n, a in calls if n == "intel_agent_upsert_prospect")
        self.assertEqual(v["research_report"]["contact"]["contact_email"], "press@moon.example")

    def test_conventional_path_is_probed_when_home_shows_no_link(self):
        calls = self.run_research({"https://moon.example/": "<html><body><p>Moonlit Blade</p></body></html>", "https://moon.example/presskit/": KIT})
        self.assertTrue(any(a["p_fact_type"] == "presskit_developer" for n, a in calls if n == "intel_agent_add_evidence"))

    def test_press_address_is_never_promoted_to_the_business_contact(self):
        calls = self.run_research({"https://moon.example/": "<html><body><p>Moonlit Blade</p></body></html>", "https://moon.example/presskit/": KIT})
        v = next(a["p_verified"] for n, a in calls if n == "intel_agent_upsert_prospect")
        self.assertNotEqual(v.get("contact_verification"), "website_extracted")
        self.assertEqual(v["research_report"]["contact"]["contact_email"], "")
        self.assertTrue(any("only a press contact address" in g for g in v["research_report"]["gaps"]))
        upsert = next(a for n, a in calls if n == "intel_agent_upsert_prospect")
        self.assertEqual(upsert["p_contact_email"], "")

    def test_no_press_kit_is_reported_as_a_gap(self):
        calls = self.run_research({"https://moon.example/": "<html><body><p>Moonlit Blade</p></body></html>"})
        v = next(a["p_verified"] for n, a in calls if n == "intel_agent_upsert_prospect")
        self.assertFalse(v["research_report"]["press_kit"]["found"])
        self.assertIn("no press kit found", v["research_report"]["gaps"])


class DiscoverySource(unittest.TestCase):
    def test_url_list_validation(self):
        self.assertEqual(sources.presskit_urls_from({"presskit_urls": [URL, URL, "https://a.example/press"]}), [URL, "https://a.example/press"])
        for bad in (None, [], "x", [5], ["ftp://a.example/p"], ["https://localhost/p"], [URL, "https://www.kickstarter.com/projects/a/b"]):
            self.assertIsNone(sources.presskit_urls_from({"presskit_urls": bad}))
        self.assertIsNone(sources.presskit_urls_from(None))

    def test_candidate_needs_developer_and_title_and_is_unverified_identity(self):
        c = sources.presskit_candidate(KIT, URL)
        self.assertEqual((c["name"], c["website"], c["contact_email"]), ("Tiny Moon Studio", "https://moon.example", ""))
        m = c["meta"]
        self.assertEqual((m["source_key"], m["project_title"], m["project_url"], m["developer_identity_status"]),
                         ("presskit", "Moonlit Blade", URL, "presskit_listed_developer"))
        self.assertIsNone(sources.presskit_candidate(KIT.replace("<strong>Developer:</strong>", "<strong>Misc:</strong>"), URL))
        self.assertIsNone(sources.presskit_candidate("<html><body>nothing</body></html>", URL))

    def test_page_slices_and_continues(self):
        urls = [f"https://s{i}.example/presskit/" for i in range(3)]
        class F:
            def fetch(self, u): return u, KIT.replace("Tiny Moon Studio", f"Dev {u[8:10]}")
        rows, nxt = sources.presskit_page(F(), urls, None, 2)
        self.assertEqual(len(rows), 2); self.assertEqual(nxt, {"index": 2})
        rows, nxt = sources.presskit_page(F(), urls, nxt, 2)
        self.assertEqual(len(rows), 1); self.assertIsNone(nxt)

    def test_blocked_page_yields_nothing_but_budget_denial_propagates(self):
        class Blocked:
            def fetch(self, u): raise PermanentError("robots disallow")
        self.assertEqual(sources.presskit_page(Blocked(), [URL], None, 5), ([], None))
        class Budget:
            def fetch(self, u): raise PermanentError("presskit source budget reservation denied")
        with self.assertRaises(PermanentError):
            sources.presskit_page(Budget(), [URL], None, 5)

    def test_discover_batch_is_registry_gated_and_metered(self):
        reserved = []
        class F:
            def fetch(self, u): return u, KIT
        crit = {"sources": ["presskit"], "presskit_urls": [URL]}
        status = {"presskit": {"enabled": True, "tos_status": "confirmed", "remaining": 5, "circuit_open": False}}
        off = sources.discover_batch(F(), "indie_game_developer", crit, enabled_sources=set(), reserve_source=lambda k: reserved.append(k) or True, source_status=status)
        self.assertEqual((off["candidates"], reserved), ([], []))
        out = sources.discover_batch(F(), "indie_game_developer", crit, enabled_sources={"presskit"}, reserve_source=lambda k: reserved.append(k) or True, source_status=status)
        self.assertEqual([c["name"] for c in out["candidates"]], ["Tiny Moon Studio"])
        self.assertEqual(reserved, ["presskit"])
        self.assertEqual(out["next_cursor"], {})

    def test_missing_or_bad_url_list_runs_nothing(self):
        reports = []
        class F:
            def fetch(self, u): raise AssertionError("must not fetch")
        out = sources.discover_batch(F(), "indie_game_developer", {"sources": ["presskit"]}, enabled_sources={"presskit"}, reserve_source=lambda k: True,
                                     report_source=lambda *a: reports.append(a))
        self.assertEqual(out["candidates"], [])
        self.assertTrue(reports and reports[0][1] is False)

    def test_h_discover_accepts_presskit_without_keywords_and_tallies_it(self):
        d = FakeD({
            "intel_agent_settings": {"today": "2026-11-13", "campaigns": [{"type": "indie_game_developer", "status": "active", "criteria": {"sources": ["presskit"], "presskit_urls": [URL]}}]},
            "intel_agent_sources": {"presskit": {}},
            "intel_agent_source_status": {"presskit": {"enabled": True, "tos_status": "confirmed", "remaining": 5, "circuit_open": False}},
            "intel_agent_source_use": 1, "intel_agent_record_item": {"new": True}, "intel_agent_enqueue_job": "job",
            "intel_agent_upsert_prospect": {"prospect_id": "P1", "created": True, "suppressed": False},
        })
        class F:
            def fetch(self, u): return u, KIT
        d.fetcher = F()
        out = jobs.h_discover(d, {"payload": {"type": "indie_game_developer", "limit": 25}})
        self.assertEqual(out["by_source"]["presskit"]["new"], 1)
        up = d.named("intel_agent_upsert_prospect")[0]
        self.assertEqual((up["p_name"], up["p_contact_email"]), ("Tiny Moon Studio", ""))

    def test_other_sources_still_require_keywords(self):
        d = FakeD({"intel_agent_settings": {"campaigns": [{"type": "indie_game_developer", "status": "active", "criteria": {"sources": ["steam"], "keywords": []}}]},
                   "intel_agent_sources": {}, "intel_agent_source_status": {}})
        self.assertIn("skipped", jobs.h_discover(d, {"payload": {"type": "indie_game_developer"}}))


if __name__ == "__main__":
    unittest.main()
