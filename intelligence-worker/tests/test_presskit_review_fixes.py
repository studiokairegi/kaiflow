"""Regression tests for the press-kit review pass: each test pins a defect found by running the update against realistic pages."""
import unittest

from bs4 import BeautifulSoup

from kairflow_intel import presskit, scoring
from .test_indie_campaign_audit_fixes import contact, ev, meta


def kit(extra_head="", body=""):
    return f"<html><head>{extra_head}</head><body><h1>Press kit</h1>{body}</body></html>"


class IdentityGate(unittest.TestCase):
    ROWS = [ev("project_description"), ev("devlog", "https://game.example/devlog"), ev("anime_visual_screenshot", "https://cdn.example/a.png")]

    def _gates(self, status="presskit_listed_developer"):
        m = meta(source="presskit", source_key="presskit", project_url="https://game.example/presskit/", developer_identity_status=status)
        return scoring.score_indie({}, m, None, evidence_rows=self.ROWS, contactability_result=contact(), suppression={}).mandatory_gates

    def test_press_kit_listed_developer_is_not_a_confirmed_identity(self):
        self.assertFalse(self._gates()["project_identity"]["passed"])

    def test_press_kit_developer_passes_once_independently_verified(self):
        self.assertTrue(self._gates("independently_verified")["project_identity"]["passed"])


class OwnDomain(unittest.TestCase):
    def test_other_co_uk_domain_is_not_the_sites_own_domain(self):
        html = kit(body="<p>Developer: Tiny Moon</p><p>Press contact: press@other.co.uk</p><a href='mailto:press@other.co.uk'>m</a>")
        k = presskit.parse(html, "https://tinymoon.co.uk/press/", site_host="tinymoon.co.uk")
        self.assertFalse(k["press_emails"][0]["on_site_domain"])

    def test_same_co_uk_domain_is_own_domain(self):
        html = kit(body="<p>Developer: Tiny Moon</p><p>Press contact: hi@tinymoon.co.uk</p><a href='mailto:hi@tinymoon.co.uk'>m</a>")
        k = presskit.parse(html, "https://tinymoon.co.uk/press/", site_host="tinymoon.co.uk")
        self.assertTrue(k["press_emails"][0]["on_site_domain"])


class CandidateLinks(unittest.TestCase):
    HOME = ('<a href="/presskit.zip">Download press kit</a><a href="/media/hero.png">hero</a><a href="/media/trailer.mp4">t</a>'
            '<a href="/pressure-washers/">x</a><a href="/press/">Press</a>')

    def test_downloads_assets_and_lookalike_paths_are_not_press_kit_pages(self):
        self.assertEqual(presskit.candidate_urls("https://tinymoon.com/", self.HOME, limit=5), ["https://tinymoon.com/press/"])

    def test_zip_pdf_and_images_are_never_press_kit_urls(self):
        for u in ("https://x.com/presskit.zip", "https://x.com/press/kit.pdf", "https://x.com/media/logo.svg", "https://x.com/press-kit/shot.jpg"):
            self.assertFalse(presskit.looks_like_presskit_url(u, "press kit"), u)

    def test_real_press_paths_still_match(self):
        for u in ("https://x.com/presskit/", "https://x.com/press", "https://x.com/press-kit/", "https://x.com/press-room/", "https://x.com/media-kit", "https://x.com/presskit/index.html"):
            self.assertTrue(presskit.looks_like_presskit_url(u), u)

    def test_www_variant_of_the_same_site_is_accepted(self):
        got = presskit.candidate_urls("https://tinymoon.com/", '<a href="https://www.tinymoon.com/press/">Press</a>', limit=2)
        self.assertEqual(got, ["https://www.tinymoon.com/press/"])

    def test_other_site_is_still_rejected(self):
        self.assertEqual(presskit.candidate_urls("https://tinymoon.com/", '<a href="https://evil.example/press/">Press</a>', limit=1, probe=False), [])


class Labels(unittest.TestCase):
    def test_non_fact_labels_are_not_classified(self):
        for lab in ("Social media", "Press quotes", "Launch trailer", "Developed with", "Awards", "Reviews", "Engine"):
            self.assertIsNone(presskit._label_key(lab), lab)

    def test_real_labels_still_classified(self):
        want = {"Developer": "developer", "Studio": "developer", "Developed by": "developer", "Publisher": "publisher", "Press contact": "press_contact",
                "Press / Business contact": "press_contact", "Media inquiries": "press_contact", "Press": "press_contact", "Release date": "release",
                "Launch date": "release", "Available": "release", "Platforms": "platforms", "Available on": "platforms", "Website": "website",
                "Founded": "founded"}
        for lab, key in want.items():
            self.assertEqual(presskit._label_key(lab), key, lab)

    def test_social_media_line_is_not_stored_as_a_press_contact(self):
        k = presskit.parse(kit(body="<p>Developer: Tiny Moon</p><p>Social media: @tinymoon</p>"), "https://x.com/press/")
        self.assertEqual([f["fact_type"] for f in k["facts"]], ["presskit_developer"])


class Title(unittest.TestCase):
    def _t(self, raw):
        return presskit._title(BeautifulSoup(f"<html><head><title>{raw}</title></head><body></body></html>", "lxml"))

    def test_game_name_is_found_whichever_side_of_the_separator_it_is_on(self):
        for raw in ("Press Kit - Tiny Quest", "Press Kit | Tiny Quest", "Tiny Quest | Press Kit", "Tiny Quest - Press Kit", "Tiny Quest: Press Kit", "Press Kit: Tiny Quest"):
            self.assertEqual(self._t(raw), "Tiny Quest", raw)

    def test_a_bare_press_kit_title_is_empty(self):
        self.assertEqual(self._t("Press Kit"), "")


if __name__ == "__main__":
    unittest.main()


from kairflow_intel import research
from kairflow_intel.errors import PermanentError
from .test_presskit import KIT, prospect


def _run(fetch_fn, home):
    class Fetch:
        def fetch(self, url):
            return fetch_fn(url, home)
    calls = []

    def rpc(name, args):
        calls.append((name, args))
        return {"suppressed": False, "bounced": False, "complained": False, "suppression_reason": ""} if name == "intel_agent_indie_suppression_facts" else {}
    research.research(rpc, Fetch(), lambda _: {"contact_name": None, "contact_role": None}, {"prospect": prospect()})
    return calls


class ResearchStepReview(unittest.TestCase):
    def test_www_redirect_of_the_press_kit_page_is_accepted(self):
        def fetch(url, home):
            if url == "https://moon.example/":
                return url, home
            if url == "https://moon.example/presskit/":
                return "https://www.moon.example/presskit/", KIT           # apex redirects to www
            raise PermanentError("404")
        calls = _run(fetch, '<html><body><p>Moonlit Blade</p><a href="/presskit/">Press kit</a></body></html>')
        self.assertTrue(any(a["p_fact_type"] == "presskit_developer" for n, a in calls if n == "intel_agent_add_evidence"))

    def test_facts_come_from_the_same_press_page_as_the_recorded_url(self):
        a = KIT.replace("Tiny Moon Studio", "Alpha Studio").replace("Lantern Games", "Alpha Pub")
        b = KIT.replace("Tiny Moon Studio", "Beta Studio").replace("Lantern Games", "Beta Pub")
        pages = {"https://moon.example/press/": a, "https://moon.example/presskit/": b}

        def fetch(url, home):
            if url == "https://moon.example/":
                return url, home
            if url in pages:
                return url, pages[url]
            raise PermanentError("404")
        calls = _run(fetch, '<html><body><p>Moonlit Blade</p><a href="/press/">Press</a><a href="/presskit/">Press kit</a></body></html>')
        v = next(x["p_verified"] for n, x in calls if n == "intel_agent_upsert_prospect")
        first_dev = "Alpha Studio" if v["presskit_url"].endswith("/press/") else "Beta Studio"
        self.assertEqual(v["presskit_developer"], first_dev)
        self.assertEqual(v["presskit_publisher"], first_dev.replace("Studio", "Pub"))
