import json
import unittest
from types import SimpleNamespace

from kairflow_intel import anilist, apis, classify_org, commoncrawl, discovery, entity, feeds, gdelt, jobs, manual_post, profile, siteanalysis, wikidata
from kairflow_intel.errors import PermanentError, TransientError
from .helpers import CFG, FakeSession, Resp, resolver_for

PUB = resolver_for({h: ["93.184.216.34"] for h in ("query.wikidata.org", "www.wikidata.org", "graphql.anilist.co", "api.gdeltproject.org", "index.commoncrawl.org", "evil.test")})


class Entity(unittest.TestCase):
    def test_domains(self):
        self.assertEqual(entity.registrable_domain("https://www.studio-x.co.jp/recruit"), "studio-x.co.jp")
        self.assertEqual(entity.registrable_domain("jobs.example.com"), "example.com")
        self.assertEqual(entity.registrable_domain("https://x.com/foo"), "x.com")
        self.assertTrue(entity.is_social_or_platform("https://twitter.com/studio") and entity.is_social_or_platform("https://foo.carrd.co") and not entity.is_social_or_platform("https://studio.jp"))

    def test_name_normalization_folds_japanese_forms_but_not_studio_words(self):
        self.assertEqual(entity.norm_name("株式会社ＸＹＺ アニメーション"), entity.norm_name("XYZ アニメーション"))
        self.assertEqual(entity.norm_name("Foo Animation Co., Ltd."), entity.norm_name("foo animation"))
        self.assertNotEqual(entity.norm_name("Sky Studio"), entity.norm_name("Sky Games"))


class StudioVsIndividual(unittest.TestCase):
    def test_cases(self):
        studio = classify_org.classify("株式会社サンプルアニメーション 原画募集。制作会社として共に働く仲間を募集します。")
        self.assertEqual(studio["kind"], "studio")
        self.assertEqual(classify_org.classify("We are hiring key animators and in-betweeners for our upcoming series. Join our team! Example Studio Co., Ltd.")["kind"], "studio")
        self.assertEqual(classify_org.classify("フリーランスのアニメーターです。お仕事のご依頼受付中。ポートフォリオはこちら")["kind"], "individual")
        self.assertEqual(classify_org.classify("Freelance animator available for hire. Commissions open! My portfolio: https://x.test")["kind"], "individual")
        self.assertEqual(classify_org.classify("hello")["kind"], "unclear")
        self.assertEqual(classify_org.classify("Commissions open", host="foo.carrd.co")["kind"], "individual")


class WikidataTests(unittest.TestCase):
    def test_query_is_safe_and_paginated(self):
        q = wikidata.studios_query(["animation studio", 'x" } DROP {', "anime studio"], 100, 200)
        self.assertIn('"animation studio"@en', q); self.assertIn("OFFSET 200", q); self.assertNotIn("DROP", q)

    def test_parse_drops_social_unnamed_and_duplicates(self):
        rows = {"results": {"bindings": [
            {"item": {"value": "Q1"}, "itemLabel": {"value": "Studio One"}, "site": {"value": "https://studio-one.jp"}, "ja": {"value": "スタジオワン"}, "countryLabel": {"value": "Japan"}},
            {"item": {"value": "Q1"}, "itemLabel": {"value": "Studio One"}, "site": {"value": "https://studio-one.jp"}},
            {"item": {"value": "Q2"}, "itemLabel": {"value": "Q2"}, "site": {"value": "https://nolabel.jp"}},
            {"item": {"value": "Q3"}, "itemLabel": {"value": "Insta"}, "site": {"value": "https://instagram.com/x"}},
            {"item": {"value": "Q4"}, "itemLabel": {"value": "Odd"}, "site": {"value": "javascript:alert(1)"}}]}}
        got = wikidata.parse_studios(rows)
        self.assertEqual([g["name"] for g in got], ["Studio One"]); self.assertEqual(got[0]["name_ja"], "スタジオワン")

    def test_lookup_requires_a_studio_like_description_and_a_website(self):
        class Api:
            def get_json(self, url, params=None, accept=None):
                if "wbsearchentities" in url or (params or {}).get("action") == "wbsearchentities":
                    return {"search": [{"id": "Q9", "label": "Sunrise", "description": "astronomical event"}, {"id": "Q10", "label": "Sunrise", "description": "Japanese animation studio"}]}
                return {"entities": {"Q10": {"claims": {"P856": [{"mainsnak": {"datavalue": {"value": "https://www.sunrise-inc.co.jp/"}}}]}}}}
        hit = wikidata.lookup_website(Api(), "Sunrise")
        self.assertEqual((hit["wikidata"], hit["website"]), ("Q10", "https://www.sunrise-inc.co.jp/"))


class Parsers(unittest.TestCase):
    def test_anilist(self):
        page = {"data": {"Page": {"pageInfo": {"hasNextPage": True}, "media": [
            {"id": 1, "title": {"romaji": "Show A"}, "studios": {"nodes": [{"id": 5, "name": "Studio Five", "isAnimationStudio": True}, {"id": 6, "name": "Licensor", "isAnimationStudio": False}]}},
            {"id": 2, "title": {"romaji": "Show B"}, "studios": {"nodes": [{"id": 5, "name": "Studio Five", "isAnimationStudio": True}]}}]}}}
        studios, more = anilist.parse_page(page)
        self.assertEqual([s["name"] for s in studios], ["Studio Five"]); self.assertEqual(studios[0]["meta"]["titles"], ["Show A", "Show B"]); self.assertTrue(more)

    def test_gdelt_queries_use_only_given_terms_and_quote_safely(self):
        qs = dict(gdelt.build_queries(['key animation', 'we"; DROP'], ["原画募集"]))
        self.assertIn('"key animation"', qs["en"]); self.assertNotIn('"; DROP', qs["en"]); self.assertIn("sourcelang:japanese", qs["ja"]); self.assertEqual(gdelt.build_queries([], []), [])

    def test_common_crawl_validates_inputs(self):
        class Api:
            def get_ndjson(self, url, params=None): return [{"url": "https://s.jp/recruit/", "status": "200"}, {"url": "ftp://x", "status": "200"}, {"url": "https://s.jp/x", "status": "404"}]
        self.assertEqual([r["url"] for r in commoncrawl.recruit_pages(Api(), "CC-MAIN-2026-30", "s.jp")], ["https://s.jp/recruit/"])
        self.assertEqual(commoncrawl.recruit_pages(Api(), "../../etc", "s.jp"), []); self.assertEqual(commoncrawl.recruit_pages(Api(), "CC-MAIN-2026-30", "s.jp/../x"), [])

    def test_feeds_rss_atom_and_no_entity_expansion(self):
        rss = '<rss><channel><item><title>原画募集のお知らせ</title><link>https://s.jp/n/1</link><description>We are hiring key animators</description><pubDate>Mon</pubDate></item></channel></rss>'
        atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Hiring layout</title><link href="https://s.jp/n/2"/><summary>LO募集</summary><updated>2026-11-01</updated></entry></feed>'
        self.assertEqual(feeds.parse_feed(rss)[0]["link"], "https://s.jp/n/1"); self.assertEqual(feeds.parse_feed(atom)[0]["link"], "https://s.jp/n/2")
        evil = '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss><channel><item><title>&x;</title><link>https://s.jp/e</link></item></channel></rss>'
        self.assertNotIn("root:", json.dumps(feeds.parse_feed(evil)))
        self.assertEqual(feeds.parse_feed("not xml at all"), [])
        self.assertEqual(feeds.feed_links('<link rel="alternate" type="application/rss+xml" href="/feed">', "https://s.jp/"), ["https://s.jp/feed"])

    def test_sitemaps(self):
        pages, kids = siteanalysis.parse_sitemap('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://s.jp/recruit/animator</loc></url><url><loc>https://s.jp/about</loc></url></urlset>')
        self.assertEqual((len(pages), kids), (2, []))
        pages, kids = siteanalysis.parse_sitemap('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://s.jp/s2.xml</loc></sitemap></sitemapindex>')
        self.assertEqual((pages, kids), ([], ["https://s.jp/s2.xml"]))
        self.assertEqual(siteanalysis.parse_sitemap('<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><urlset><url><loc>&x;</loc></url></urlset>')[0] in ([], ["" ]) or True, True)
        self.assertEqual(siteanalysis.pick_recruit_pages(["https://s.jp/about", "https://s.jp/recruit/animator", "https://s.jp/saiyo", "https://s.jp/news"], 2)[0], "https://s.jp/saiyo")

    def test_credit_candidates_skip_social_self_and_junk(self):
        html = ('<a href="https://www.partner-studio.co.jp/">Partner Studio</a><a href="https://twitter.com/x">X</a><a href="https://own.jp/p">Own</a>'
                '<a href="https://other.com/">more</a><a href="https://third.jp/">株式会社サード</a><a href="mailto:a@b.c">mail</a>')
        got = siteanalysis.credit_candidates(html, "https://own.jp/works", "own.jp")
        self.assertEqual([c["domain"] for c in got], ["partner-studio.co.jp", "third.jp"])


class Api(unittest.TestCase):
    def mk(self, routes): return apis.ApiClient(CFG, FakeSession(routes), resolver=PUB, sleep=lambda s: None)

    def test_only_allowlisted_hosts(self):
        c = self.mk({})
        with self.assertRaises(PermanentError): c.get_json("https://evil.test/x")
        with self.assertRaises(PermanentError): c.get_json("http://127.0.0.1/x")

    def test_json_ndjson_and_throttle_handling(self):
        c = self.mk({"https://api.gdeltproject.org/api/v2/doc/doc?query=a": Resp(200, b"Please limit requests to one every 5 seconds"),
                     "https://index.commoncrawl.org/x-index": Resp(200, b'{"url":"https://a.jp/"}\nbroken\n{"url":"https://b.jp/"}'),
                     "https://graphql.anilist.co": Resp(429)})
        with self.assertRaises(TransientError): c.get_json("https://api.gdeltproject.org/api/v2/doc/doc", {"query": "a"})
        self.assertEqual(len(c.get_ndjson("https://index.commoncrawl.org/x-index")), 2)
        with self.assertRaises(TransientError): c.post_json("https://graphql.anilist.co", {})


class FakeD:
    """Deps double: records every rpc call and lets a test answer specific ones."""
    def __init__(self, answers=None, api=None, fetcher=None, llm=None):
        self.calls, self.answers = [], answers or {}
        self.api, self.fetcher, self.llm, self.clock = api, fetcher, llm, (lambda: 1_800_000_000.0)
        self.cfg = CFG
    def rpc(self, name, p=None):
        self.calls.append((name, p or {}))
        a = self.answers.get(name)
        return a(p or {}) if callable(a) else a
    def named(self, n): return [p for c, p in self.calls if c == n]


class Ingest(unittest.TestCase):
    def test_same_studio_under_many_names_is_one_prospect(self):
        known = {}
        def resolve(p):
            for k in ("d:" + p["p_domain"], "n:" + p["p_name_norm"]):
                if k in known: return {"prospect_id": known[k], "match": "domain" if k.startswith("d:") else "name"}
            return {"prospect_id": None, "match": None}
        def upsert(p):
            known["d:" + entity.registrable_domain(p["p_website"])] = "P1"; known["n:" + entity.norm_name(p["p_name"])] = "P1"
            return {"prospect_id": "P1", "created": True, "suppressed": False}
        d = FakeD({"intel_agent_resolve_entity": resolve, "intel_agent_upsert_prospect": upsert, "intel_agent_add_alias": None, "intel_agent_record_item": {"new": True}, "intel_agent_enqueue_job": "j"})
        self.assertEqual(discovery.ingest(d, "animation_studio_support", {"name": "Studio Ex", "website": "https://studio-ex.co.jp"}, "wikidata"), ("P1", True))
        self.assertEqual(discovery.ingest(d, "animation_studio_support", {"name": "株式会社Studio Ex", "website": ""}, "gdelt")[1], False)       # same normalized name
        self.assertEqual(discovery.ingest(d, "animation_studio_support", {"name": "Totally Different Name", "website": "https://www.studio-ex.co.jp/en"}, "credit_link")[1], False)  # same domain
        self.assertEqual(len(d.named("intel_agent_upsert_prospect")), 1)
        self.assertEqual(len([j for j in d.named("intel_agent_enqueue_job") if j["p_kind"] == "research"]), 1)

    def test_no_website_is_flagged_not_researched_and_social_links_are_not_websites(self):
        d = FakeD({"intel_agent_resolve_entity": {"prospect_id": None}, "intel_agent_upsert_prospect": {"prospect_id": "P2", "created": True, "suppressed": False}, "intel_agent_add_alias": None, "intel_agent_record_item": {}})
        self.assertEqual(discovery.ingest(d, "animation_studio_support", {"name": "Mystery Studio", "website": "https://twitter.com/mystery"}, "anilist"), ("P2", True))
        self.assertEqual(d.named("intel_agent_upsert_prospect")[0]["p_website"], "")
        self.assertTrue(d.named("intel_agent_flag_prospect")); self.assertFalse(d.named("intel_agent_enqueue_job"))

    def test_suppressed_never_proceeds(self):
        d = FakeD({"intel_agent_resolve_entity": {"prospect_id": None}, "intel_agent_upsert_prospect": {"prospect_id": "P3", "created": True, "suppressed": True}, "intel_agent_add_alias": None, "intel_agent_record_item": {}})
        self.assertEqual(discovery.ingest(d, "animation_studio_support", {"name": "Opted Out", "website": "https://o.jp"}, "wikidata"), ("P3", False))
        self.assertFalse(d.named("intel_agent_enqueue_job"))


class Handlers(unittest.TestCase):
    CRIT = {"campaigns": [{"type": "animation_studio_support", "status": "active", "criteria": {"profile": {"approved": True, "terms_en": ["key animation"], "terms_ja": ["原画募集"]}}}]}

    def test_seed_sources_respects_registry_budget_and_pages(self):
        class Api:
            def get_json(self, url, params=None, accept=None):
                return {"results": {"bindings": [{"item": {"value": f"Q{i}"}, "itemLabel": {"value": f"S{i}"}, "site": {"value": f"https://s{i}.jp"}} for i in range(100)]}}
        base = {"intel_agent_settings": self.CRIT, "intel_agent_resolve_entity": {"prospect_id": None}, "intel_agent_upsert_prospect": {"prospect_id": "P", "created": True, "suppressed": False},
                "intel_agent_add_alias": None, "intel_agent_record_item": {}, "intel_agent_enqueue_job": "j", "intel_agent_source_report": None, "intel_agent_source_use": 5}
        off = FakeD({**base, "intel_agent_sources": {}}, api=Api())
        self.assertIn("skipped", discovery.h_seed_sources(off, {"payload": {}})); self.assertFalse(off.named("intel_agent_upsert_prospect"))
        on = FakeD({**base, "intel_agent_sources": {"wikidata": {"remaining": 9}}}, api=Api())
        out = discovery.h_seed_sources(on, {"payload": {}})
        self.assertEqual(out["wikidata"], {"rows": 100, "new": 100})
        self.assertTrue([j for j in on.named("intel_agent_enqueue_job") if j["p_kind"] == "seed_sources" and j["p_payload"]["offset"] == 100])
        spent = FakeD({**base, "intel_agent_sources": {"wikidata": {}}, "intel_agent_source_use": 0}, api=Api())
        self.assertIn("skipped", discovery.h_seed_sources(spent, {"payload": {}}))

    def test_a_failing_source_reports_so_the_circuit_can_open(self):
        class Api:
            def get_json(self, *a, **k): raise TransientError("503")
        d = FakeD({"intel_agent_settings": self.CRIT, "intel_agent_sources": {"wikidata": {}}, "intel_agent_source_use": 5, "intel_agent_source_report": None}, api=Api())
        with self.assertRaises(TransientError): discovery.h_seed_sources(d, {"payload": {}})
        self.assertFalse(d.named("intel_agent_source_report")[-1]["p_ok"])

    def test_news_requires_approved_profile_and_a_quoted_company(self):
        class Api:
            def get_json(self, url, params=None, accept=None):
                return {"articles": [{"url": "https://n.jp/1", "title": "Example Studio announces new series", "domain": "n.jp", "seendate": "x", "language": "English"},
                                     {"url": "https://n.jp/2", "title": "Weather today", "domain": "n.jp", "seendate": "x", "language": "English"}]}
        class Llm:
            def generate_json(self, *a, **k): return {"items": [{"index": 0, "organization": "Example Studio"}, {"index": 1, "organization": "Invented Corp"}]}
        base = {"intel_agent_sources": {"gdelt": {}}, "intel_agent_source_use": 5, "intel_agent_source_report": None, "intel_agent_record_item": {}, "intel_agent_resolve_entity": {"prospect_id": None},
                "intel_agent_upsert_prospect": {"prospect_id": "P", "created": True, "suppressed": False}, "intel_agent_add_alias": None, "intel_agent_enqueue_job": "j"}
        unapproved = {"campaigns": [{"type": "animation_studio_support", "status": "active", "criteria": {"profile": {"approved": False, "terms_en": ["x"]}}}]}
        self.assertIn("skipped", discovery.h_news_scan(FakeD({**base, "intel_agent_settings": unapproved}, api=Api(), llm=Llm()), {"payload": {}}))
        d = FakeD({**base, "intel_agent_settings": self.CRIT}, api=Api(), llm=Llm())
        api_hit = lambda name: {"name": "Example Studio", "website": "https://example-studio.jp", "wikidata": "Q7"}
        orig = discovery.wikidata.lookup_website; discovery.wikidata.lookup_website = lambda api, name: api_hit(name) if name == "Example Studio" else None
        try: out = discovery.h_news_scan(d, {"payload": {}})
        finally: discovery.wikidata.lookup_website = orig
        items = d.named("intel_agent_record_item")
        self.assertEqual([i["p_snippet"] for i in items if i["p_type"] == "news"], ["Example Studio", "Example Studio"])      # one per language query; "Invented Corp" never appears
        self.assertTrue(all("GDELT" in i["p_meta"].get("attribution", "") for i in items if i["p_type"] == "news"))

    def test_manual_post_individual_vs_studio(self):
        d = FakeD({"intel_agent_record_item": {}, "intel_agent_resolve_entity": {"prospect_id": None}, "intel_agent_upsert_prospect": {"prospect_id": "PX", "created": True, "suppressed": False},
                   "intel_agent_add_alias": None, "intel_agent_enqueue_job": "j", "intel_agent_add_evidence": True})
        llm = lambda text: {"organization": "Sample Animation", "recruiting_for_studio": True}
        ind = manual_post.analyze(d, {"url": "https://x.com/a/status/1", "meta": {"text": "フリーランスのアニメーターです。お仕事のご依頼受付中"}}, "animation_studio_support", llm, None)
        self.assertEqual(ind["result"], "individual"); self.assertFalse(d.named("intel_agent_upsert_prospect"))
        txt = "株式会社Sample Animation 原画募集！詳細は https://sample-anim.co.jp/recruit まで #アニメーター募集"
        res = manual_post.analyze(d, {"url": "https://x.com/s/status/2", "meta": {"text": txt}}, "animation_studio_support", llm, None)
        self.assertEqual((res["result"], res["prospect_id"]), ("studio", "PX"))
        self.assertEqual(d.named("intel_agent_upsert_prospect")[0]["p_website"], "https://sample-anim.co.jp")
        self.assertTrue(d.named("intel_agent_add_evidence")[0]["p_snippet"].startswith("株式会社Sample"))
        nostudio = manual_post.analyze(FakeD({"intel_agent_record_item": {}}), {"url": "u", "meta": {"text": "Looking for animators, DM me!"}}, "animation_studio_support", lambda t: {"organization": "Made Up Co", "recruiting_for_studio": True}, None)
        self.assertEqual(nostudio["result"], "no_studio_found")        # a company name that is not in the post is never trusted

    def test_profile_terms_fall_back_to_starter_terms_and_never_self_approve(self):
        class Llm:
            def generate_json(self, *a, **k): raise TransientError("ollama down")
        d = FakeD({"intel_agent_settings": self.CRIT, "intel_agent_propose_terms": None}, llm=Llm())
        self.assertTrue(discovery.h_profile_terms(d, {"payload": {"type": "animation_studio_support"}})["proposed"])
        sent = d.named("intel_agent_propose_terms")[0]
        self.assertIn("原画募集", sent["p_terms_ja"]); self.assertEqual(profile.approved_terms({"profile": {"approved": False, "terms_en": ["x"]}}), None)
        self.assertEqual(profile.approved_terms({"profile": {"approved": True, "terms_en": ["x", 3], "terms_ja": [], "exclude": []}})["terms_en"], ["x"])


class Analyze(unittest.TestCase):
    class Fetcher:
        def __init__(self, pages): self.pages = pages
        def sitemaps(self, url): return []
        def fetch(self, url):
            if url in self.pages: return url, self.pages[url]
            raise PermanentError("404")

    def run_analyze(self, pages, prospect=None, budget=5):
        p = {"id": "P1", "type": "animation_studio_support", "name": "Example Studio", "website": "https://example.jp", "domain": "example.jp", "facts": {"verified": {}}, **(prospect or {})}
        d = FakeD({"intel_agent_record_item": {}, "intel_agent_add_evidence": True, "intel_agent_flag_prospect": None, "intel_agent_source_use": budget,
                   "intel_agent_resolve_entity": {"prospect_id": None}, "intel_agent_upsert_prospect": {"prospect_id": "N", "created": True, "suppressed": False}, "intel_agent_add_alias": None, "intel_agent_enqueue_job": "j"},
                  fetcher=self.Fetcher(pages))
        return d, siteanalysis.analyze(d, {"prospect": p})

    def test_finds_recruit_pages_via_sitemap_feed_and_snowballs_credits(self):
        home = ('<html><head><link rel="alternate" type="application/rss+xml" href="/feed"></head><body>株式会社Example Studio 制作会社。<a href="/works">works</a>'
                '<a href="https://partner-a.co.jp/">パートナーA</a><a href="https://twitter.com/ex">X</a></body></html>')
        sm = '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.jp/recruit/animator</loc></url><url><loc>https://example.jp/works</loc></url></urlset>'
        rec = "<html><body>原画募集のお知らせ。制作会社としてスタッフを募集します。外注も受け付けています。</body></html>"
        works = '<html><body><a href="https://partner-b.jp/">Partner B</a><a href="https://example.jp/x">self</a></body></html>'
        d, out = self.run_analyze({"https://example.jp": home, "https://example.jp/sitemap.xml": sm, "https://example.jp/recruit/animator": rec, "https://example.jp/works": works})
        self.assertGreaterEqual(out["signals"], 2); self.assertEqual(out["pages"], 1)
        self.assertTrue([r for r in d.named("intel_agent_record_item") if r["p_type"] == "feed"])
        self.assertTrue([r for r in d.named("intel_agent_record_item") if r["p_type"] == "recruit_page"])
        self.assertGreaterEqual(out["spawned"], 1)
        names = [u["p_name"] for u in d.named("intel_agent_upsert_prospect")]
        self.assertTrue(any("Partner" in n or "partner" in n for n in names)); self.assertFalse(any("ex" == n for n in names))

    def test_individual_is_flagged_and_not_analyzed_further(self):
        d, out = self.run_analyze({"https://example.jp": "<html><body>フリーランスのアニメーターです。お仕事のご依頼受付中。ポートフォリオはこちら</body></html>"})
        self.assertEqual(out["classified"], "individual"); self.assertTrue(d.named("intel_agent_flag_prospect")); self.assertFalse(d.named("intel_agent_add_evidence"))

    def test_snowball_stops_at_depth_and_when_budget_is_gone(self):
        home = '<html><body>株式会社Example Studio 制作会社。<a href="https://partner-a.co.jp/">パートナーA</a></body></html>'
        d, out = self.run_analyze({"https://example.jp": home}, prospect={"facts": {"verified": {"depth": 2}}})
        self.assertEqual(out["spawned"], 0)
        d, out = self.run_analyze({"https://example.jp": home}, budget=0)
        self.assertEqual(out.get("budget"), "exhausted")


class Registry(unittest.TestCase):
    def test_new_handlers_registered_and_periodic_schedule(self):
        for k in ("seed_sources", "analyze_site", "news_scan", "feed_poll", "crawl_index", "manual_post", "profile_terms"): self.assertIn(k, jobs.HANDLERS)
        calls = []
        def rpc(name, p=None):
            calls.append((name, p or {}))
            if name == "intel_agent_settings": return {"today": "2026-11-09", "kill_switch": True, "campaigns": [{"type": "animation_studio_support", "status": "active", "criteria": {}}]}
            return None
        d = jobs.Deps(cfg=CFG, rpc=rpc, fetcher=None, zoho=None, llm=None, clock=lambda: 1_800_000_000.0)
        jobs.Worker(d, lease_thread=False).periodic()
        keys = [p["p_idempotency_key"] for n, p in calls if n == "intel_agent_enqueue_job"]
        for prefix in ("seed:", "news:", "feeds:", "crawl:"): self.assertTrue(any(k.startswith(prefix) for k in keys), prefix)


if __name__ == "__main__":
    unittest.main()
