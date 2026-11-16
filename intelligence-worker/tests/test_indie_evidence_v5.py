import unittest
from datetime import date, timedelta

from kairflow_intel import indie_evidence, research


class EvidenceExtraction(unittest.TestCase):
    def test_dated_devlog_is_activity_only_when_explicit_update_context_exists(self):
        html = '<article><time datetime="2026-10-10">October 10</time><h2>Development update</h2><p>We added a new build and fixed combat bugs.</p></article>'
        rows = indie_evidence.extract_dated_events([("https://studio.example/news/devlog", html)], today=date(2026, 11, 12))
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["fact_type"], rows[0]["date"]), ("development_update", "2026-10-10"))

    def test_generic_page_date_and_cms_modified_date_do_not_count_as_activity(self):
        html = '<html><head><meta property="article:modified_time" content="2026-11-10"></head><body><time datetime="2026-11-09">Updated</time><p>Welcome to our studio.</p></body></html>'
        self.assertEqual(indie_evidence.extract_dated_events([("https://studio.example/", html)], today=date(2026, 11, 12)), [])

    def test_long_article_context_is_clipped_around_event_phrase(self):
        html = '<article><time datetime="2026-10-10">Oct 10</time><p>' + ('Background. ' * 160) + 'Development update: we shipped a new build and fixed combat bugs.</p></article>'
        rows = indie_evidence.extract_dated_events([("https://studio.example/news", html)], today=date(2026, 11, 12))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["fact_type"], "development_update")

    def test_future_demo_is_a_marketing_opportunity_not_activity(self):
        html = '<article><time datetime="2027-02-01">Feb 1</time><p>Upcoming demo launch for our new game.</p></article>'
        rows = indie_evidence.extract_dated_events([("https://studio.example/news", html)], today=date(2026, 11, 12))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["fact_type"], "marketing_opportunity")
        self.assertEqual(rows[0]["date"], "2027-02-01")

    def test_announcement_date_is_separate_from_activity_date(self):
        html = '<article><time datetime="2026-09-01">Sep 1</time><p>We announced Moonlit Blade today.</p></article>'
        rows = indie_evidence.extract_dated_events([("https://studio.example/news", html)], today=date(2026, 11, 12))
        self.assertEqual(rows[0]["fact_type"], "project_announcement")

    def test_jsonld_article_requires_date_published_not_only_date_modified(self):
        html = '''<script type="application/ld+json">{"@type":"BlogPosting","headline":"Development update: new build","dateModified":"2026-11-01"}</script>'''
        self.assertEqual(indie_evidence.extract_dated_events([("https://studio.example/blog", html)], today=date(2026, 11, 12)), [])

    def test_jsonld_article_uses_explicit_published_date(self):
        html = '''<script type="application/ld+json">{"@type":"BlogPosting","headline":"Development update: new build","datePublished":"2026-10-01"}</script>'''
        rows = indie_evidence.extract_dated_events([("https://studio.example/blog", html)], today=date(2026, 11, 12))
        self.assertEqual(rows[0]["date"], "2026-10-01")

    def test_jsonld_announcement_is_not_filtered_out(self):
        html = """<script type="application/ld+json">{"@type":"NewsArticle","headline":"Moonlit Blade announced","datePublished":"2026-09-01"}</script>"""
        rows = indie_evidence.extract_dated_events([("https://studio.example/news", html)], today=date(2026, 11, 12))
        self.assertEqual([(r["fact_type"], r["date"]) for r in rows], [("project_announcement", "2026-09-01")])

    def test_jsonld_graph_nested_article_is_extracted(self):
        html = """<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage","name":"News"},{"@type":"NewsArticle","headline":"Moonlit Blade announced","datePublished":"2026-09-01"}]}</script>"""
        rows = indie_evidence.extract_dated_events([("https://studio.example/news", html)], today=date(2026, 11, 12))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["fact_type"], "project_announcement")

    def test_visual_assets_are_candidates_not_verified_anime_claims(self):
        html = '<meta property="og:image" content="https://cdn.example/key-art.jpg"><img src="/screenshot.png" alt="Game screenshot"><video poster="/poster.jpg"></video>'
        rows = indie_evidence.extract_visual_candidates([("https://studio.example/game", html)])
        self.assertGreaterEqual(len(rows), 3)
        self.assertTrue(all(x["fact_type"] == "visual_asset_candidate" for x in rows))
        self.assertTrue(all("Unverified" in x["snippet"] for x in rows))

    def test_identity_mentions_require_literal_developer_and_project_names(self):
        html = '<p>Tiny Moon Studio is developing Moonlit Blade, an upcoming action RPG.</p>'
        rows = indie_evidence.extract_identity_mentions([("https://studio.example/games", html)], "Tiny Moon Studio", "Moonlit Blade")
        self.assertEqual({x["fact_type"] for x in rows}, {"developer_identity", "project_identity"})

    def test_identity_mentions_do_not_infer_aliases_or_partial_names(self):
        html = '<p>Tiny Moon is building a fantasy RPG.</p>'
        self.assertEqual(indie_evidence.extract_identity_mentions([("https://studio.example/", html)], "Tiny Moon Studio", "Moonlit Blade"), [])


class ResearchIntegration(unittest.TestCase):
    def test_research_records_dated_events_identity_mentions_and_unverified_visual_candidates(self):
        html = '''<html lang="en"><head><meta property="og:image" content="https://cdn.example/moonlit-art.jpg"></head><body>
        <p>Tiny Moon Studio is developing Moonlit Blade, an anime-inspired action RPG.</p>
        <article><time datetime="2026-10-10">October 10</time><h2>Development update</h2><p>We added a new build and updated combat animations.</p></article>
        <article><time datetime="2027-02-01">Feb 1</time><p>Upcoming demo launch for Moonlit Blade.</p></article>
        <p>owner@studio.example</p></body></html>'''
        class Fetch:
            def fetch(self, url): return url, html
        p = {"id":"i1","type":"indie_game_developer","origin":"discovered","status":"discovered",
             "website":"https://studio.example/","domain":"studio.example","name":"Tiny Moon Studio",
             "project_title":"Moonlit Blade","project_source_url":"https://store.steampowered.com/app/123/",
             "contact_email":"","facts":{"verified":{"project_title":"Moonlit Blade"}}}
        calls = []
        def rpc(name, args):
            calls.append((name,args))
            if name == "intel_agent_indie_suppression_facts":
                return {"suppressed": False, "bounced": False, "complained": False, "suppression_reason": ""}
            return {}
        out = research.research(rpc, Fetch(), lambda _: {"contact_name":None,"contact_role":None}, {"prospect":p})
        verified = next(a["p_verified"] for n,a in calls if n=="intel_agent_upsert_prospect")
        evidence = [(a["p_fact_type"],a["p_verified"],a["p_snippet"]) for n,a in calls if n=="intel_agent_add_evidence"]
        self.assertEqual(verified["project_latest_activity_date"], "2026-10-10")
        self.assertTrue(any(x["fact_type"] == "development_update" for x in indie_evidence.extract_dated_events([(p["website"],html)])))
        self.assertTrue(any(k=="development_update" and v for k,v,_ in evidence))
        self.assertTrue(any(k=="marketing_opportunity" and v for k,v,_ in evidence))
        self.assertTrue(any(k=="visual_asset_candidate" and not v for k,v,_ in evidence))
        self.assertTrue(any(k=="developer_identity" and v for k,v,_ in evidence))
        self.assertNotIn("developer_identity_status", verified)  # page mention is not independent human verification
        self.assertEqual(out["pages"], 1)


class ResearchIntegrityRegression(unittest.TestCase):
    HTML = "<html lang='en'><body><p>Tiny Moon Studio develops Moonlit Blade.</p><p>owner@studio.example</p></body></html>"

    class Fetch:
        def fetch(self, url):
            return url, ResearchIntegrityRegression.HTML

    def _run(self, verified=None, *, evidence=None, suppression=None, status="discovered"):
        p = {"id":"i2","type":"indie_game_developer","origin":"discovered","status":status,
             "website":"https://studio.example/","domain":"studio.example","name":"Tiny Moon Studio",
             "project_title":"Moonlit Blade","project_source_url":"https://store.steampowered.com/app/123/",
             "contact_email":"owner@studio.example","facts":{"verified":verified or {}}}
        calls = []
        def rpc(name, args):
            calls.append((name,args))
            if name == "intel_agent_indie_suppression_facts":
                if isinstance(suppression, Exception): raise suppression
                return suppression if suppression is not None else {"suppressed":False,"bounced":False,"complained":False,"suppression_reason":""}
            return {}
        out = research.research(rpc, self.Fetch(), lambda _: {"contact_name":None,"contact_role":None},
                                {"prospect":p,"evidence":evidence or []})
        stored = next(args["p_verified"] for name,args in calls if name=="intel_agent_upsert_prospect")
        return out, stored, calls

    def test_activity_date_never_moves_backwards(self):
        _, stored, _ = self._run({"project_latest_activity_date":"2026-11-05"})
        self.assertEqual(stored["project_latest_activity_date"], "2026-11-05")

    def test_creator_role_and_contact_verification_audit_fields_survive_refresh(self):
        prior = {"kickstarter_creator_role":"developer","kickstarter_creator_role_verified":True,
                 "contact_verification":"human_confirmed","contact_email":"owner@studio.example",
                 "contact_verification_method":"admin_reviewed_external_affiliation",
                 "contact_verified_at":"2026-11-12T10:00:00+00:00","contact_verified_by":"admin-1"}
        _, stored, _ = self._run(prior)
        for key in prior:
            self.assertEqual(stored[key], prior[key])

    def test_suppressed_email_never_reports_contactability_pass(self):
        prior = {"contact_verification":"human_confirmed","contact_email":"owner@studio.example"}
        _, stored, _ = self._run(prior, suppression={"suppressed":True,"bounced":False,"complained":False,"suppression_reason":"unsubscribe"})
        self.assertEqual(stored["contactability"]["status"], "rejected")
        self.assertEqual(stored["contactability"]["reason"], "unsubscribe")

    def test_local_unsubscribe_flag_never_reports_contactability_pass(self):
        prior = {"contact_verification":"human_confirmed","contact_email":"owner@studio.example","unsubscribed":True}
        _, stored, _ = self._run(prior)
        self.assertEqual(stored["contactability"]["status"], "rejected")

    def test_kickstarter_only_project_is_never_fetched_by_research(self):
        class NeverFetch:
            called = False
            def fetch(self, url):
                self.called = True
                raise AssertionError("Kickstarter fetch must not occur")
        fetcher = NeverFetch()
        prospect = {"id": "ks", "type": "indie_game_developer", "name": "Moon Studio",
                    "project_title": "Moon Quest", "project_source_url": "https://www.kickstarter.com/projects/moon/quest",
                    "website": "", "facts": {"verified": {"source_key": "kickstarter_manual"}}}
        from kairflow_intel.errors import PermanentError
        with self.assertRaises(PermanentError):
            research.research(lambda *_: {}, fetcher, lambda *_: {}, {"prospect": prospect})
        self.assertFalse(fetcher.called)

    def test_suppression_lookup_failure_holds_research(self):
        from kairflow_intel.errors import TransientError
        with self.assertRaises(TransientError):
            self._run({}, suppression=RuntimeError("database unavailable"))

    def test_visual_pending_count_uses_persisted_unresolved_candidates(self):
        prior_evidence = [
            {"source":"web","fact_type":"visual_asset_candidate","verified":False,
             "snippet":"Unverified image candidate: https://cdn.example/a.png | cover art"},
            {"source":"web","fact_type":"visual_asset_candidate","verified":False,
             "snippet":"Unverified image candidate: https://cdn.example/b.png | screenshot"},
            {"source":"admin_review","fact_type":"anime_visual_artwork","verified":True,
             "snippet":"Human inspected artwork | reviewed media: https://cdn.example/a.png"},
        ]
        html = "<html><head><meta property='og:image' content='https://cdn.example/c.png'></head><body>Studio site</body></html>"
        class Fetch:
            def fetch(self, url): return url, html
        p = {"id":"i3","type":"indie_game_developer","origin":"discovered","status":"discovered",
             "website":"https://studio.example/","domain":"studio.example","name":"Tiny Moon Studio",
             "project_title":"Moonlit Blade","project_source_url":"https://store.steampowered.com/app/123/",
             "contact_email":"","facts":{"verified":{}}}
        calls=[]
        def rpc(name,args):
            calls.append((name,args))
            if name == "intel_agent_indie_suppression_facts": return {"suppressed":False,"bounced":False,"complained":False}
            return {}
        research.research(rpc,Fetch(),lambda _:{"contact_name":None,"contact_role":None},{"prospect":p,"evidence":prior_evidence})
        stored=next(a["p_verified"] for n,a in calls if n=="intel_agent_upsert_prospect")
        self.assertEqual(stored["visual_review_pending_count"],2)  # b.png and newly discovered c.png
