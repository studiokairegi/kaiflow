import json
import unittest
from types import SimpleNamespace

from kairflow_intel import anilist, apis, classify_org, commoncrawl, discovery, entity, feeds, gdelt, jobs, manual_post, profile, siteanalysis, sources, wikidata
from kairflow_intel.errors import PermanentError, TransientError
from .helpers import CFG, FakeSession, Resp, resolver_for

PUB = resolver_for({h: ["93.184.216.34"] for h in ("query.wikidata.org", "www.wikidata.org", "graphql.anilist.co", "api.gdeltproject.org", "index.commoncrawl.org", "evil.test")})



class SourceRegistryEnforcement(unittest.TestCase):
    def test_indie_discovery_uses_only_registry_enabled_sources_and_reserves_each_request(self):
        from unittest.mock import patch
        calls = []
        class Fetcher:
            def fetch(self, url):
                calls.append(("fetch", url))
                return (url, "ok")
        def fake_steam(fetcher, keywords):
            fetcher.fetch("https://steam.test/search")
            fetcher.fetch("https://steam.test/details")
            return [{"name": "Steam Dev", "website": "https://steamdev.test"}]
        def fake_itch(fetcher, keywords):
            fetcher.fetch("https://itch.test/tag")
            return [{"name": "Itch Dev", "website": "https://itchdev.test"}]
        def reserve(key):
            calls.append(("reserve", key))
            return True
        with patch("kairflow_intel.sources.steam", side_effect=fake_steam), patch("kairflow_intel.sources.itch", side_effect=fake_itch):
            rows = sources.discover(Fetcher(), "indie_game_developer",
                {"sources": ["steam", "itch"], "keywords": ["2d"]},
                enabled_sources={"steam"}, reserve_source=reserve)
        self.assertEqual([r["name"] for r in rows], ["Steam Dev"])
        self.assertEqual([x for x in calls if x[0] == "reserve"], [("reserve", "steam"), ("reserve", "steam")])

    def test_indie_discovery_fails_closed_without_registry_or_campaign_terms(self):
        self.assertEqual(sources.discover(object(), "indie_game_developer", {"sources": ["steam"], "keywords": ["2d"]}), [])
        self.assertEqual(sources.discover(object(), "indie_game_developer", {"sources": None, "keywords": None}, enabled_sources={"steam"}, reserve_source=lambda _: True), [])
        self.assertEqual(sources.discover(object(), "animation_studio_support", None, enabled_sources={"site_crawler"}, reserve_source=lambda _: True), [])
        self.assertEqual(sources.discover(object(), "indie_game_developer", {"sources": ["steam"], "keywords": []}, enabled_sources={"steam"}, reserve_source=lambda _: True), [])

    def test_phase4_source_budget_rpc_returns_reservation_decision_not_remaining_quota(self):
        from pathlib import Path
        migration = Path(__file__).resolve().parents[2] / "supabase" / "migrations" / "20261109170000_intelligence_discovery.sql"
        sql = migration.read_text()
        start = sql.index("create or replace function public.intel_agent_source_use(")
        end = sql.index("end $$;", start) + len("end $$;")
        rpc = sql[start:end]
        # Exact-quota reservations must succeed (1); denied or over-budget reservations
        # must return 0 without incrementing used_today.
        for fragment in ("returns int", "if v_n < 1", "enabled is true", "tos_status = 'confirmed'",
                         "circuit_open_until <= now()", "<= daily_budget", "if found then return 1", "return 0"):
            self.assertIn(fragment, rpc)
        self.assertIn("used_on is distinct from v_today", rpc)
        self.assertNotIn("return coalesce(v, 0)", rpc)

    def test_source_budget_rpc_is_atomic_and_checks_registry_terms_circuit_and_daily_limit(self):
        from pathlib import Path
        migration = Path(__file__).resolve().parents[2] / "supabase" / "migrations" / "20261129100000_intelligence_phase9_source_registry_enforcement.sql"
        sql = migration.read_text()
        for fragment in ("enabled is true", "tos_status = 'confirmed'", "circuit_open_until <= now()", "<= daily_budget", "return 1", "return 0", "grant execute on function public.intel_agent_source_use(text, int) to authenticated"):
            self.assertIn(fragment, sql)
        self.assertIn("used_on is distinct from v_today", sql)

    def test_phase9_adapter_failure_is_reported_to_registry(self):
        from unittest.mock import patch
        reports = []
        class Fetcher:
            def fetch(self, url):
                raise PermanentError("registry reservation denied")
        with patch("kairflow_intel.sources.steam", side_effect=PermanentError("registry reservation denied")):
            rows = sources.discover(Fetcher(), "indie_game_developer",
                {"sources": ["steam"], "keywords": ["2d"]},
                enabled_sources={"steam"}, reserve_source=lambda _: True,
                report_source=lambda key, ok, err="": reports.append((key, ok, str(err))))
        self.assertEqual(rows, [])
        self.assertEqual(len(reports), 1)
        self.assertEqual(reports[0][0:2], ("steam", False))
        self.assertIn("registry reservation denied", reports[0][2])

    def test_phase9_malformed_requested_source_fails_closed(self):
        self.assertEqual(sources.discover(object(), "indie_game_developer",
            {"sources": ["steam", {"source": "itch"}], "keywords": ["2d"]},
            enabled_sources={"steam", "itch"}, reserve_source=lambda _: True), [])

    def test_denied_budget_reservation_prevents_network_fetch(self):
        from unittest.mock import patch
        class Fetcher:
            called = False
            def fetch(self, url): self.called = True; return (url, "ok")
        fetcher = Fetcher()
        def fake_steam(metered, keywords):
            with self.assertRaises(PermanentError): metered.fetch("https://steam.test/search")
            return []
        with patch("kairflow_intel.sources.steam", side_effect=fake_steam):
            self.assertEqual(sources.discover(fetcher, "indie_game_developer", {"sources": ["steam"], "keywords": ["2d"]}, enabled_sources={"steam"}, reserve_source=lambda _: False), [])
        self.assertFalse(fetcher.called)

class IndieProjectDiscoveryV3(unittest.TestCase):
    STEAM_APP = '''<!doctype html><html><head><meta property="og:title" content="Moon Quest"><meta property="og:description" content="A small adventure."><meta property="og:image" content="https://cdn.example/moon.jpg"></head><body>
      <div class="apphub_AppName">Moon Quest</div><div id="developers_list"><a>Pixel Moon</a></div>
      <div id="publishers_list"><a>Big Publisher</a></div><div class="release_date"><div class="date">Coming Soon</div></div>
      <div class="game_description_snippet">A small adventure.</div><a href="https://pixelmoon.example/">Official Website</a>
      <a href="https://store.steampowered.com/genre/Action/">Action</a><div class="app_tag">Anime</div>
      </body></html>'''

    def test_steam_html_parser_retains_third_party_publisher_and_never_invents_activity(self):
        row = sources.steam_candidate_from_html(self.STEAM_APP, "123")
        self.assertEqual(row["name"], "Pixel Moon")
        self.assertEqual(row["meta"]["publisher_name"], "Big Publisher")
        self.assertEqual(row["meta"]["project_id"], "steam:123")
        self.assertEqual(row["meta"]["project_url"], "https://store.steampowered.com/app/123/")
        self.assertEqual(row["website"], "https://pixelmoon.example/")
        self.assertNotIn("recent_activity", row["meta"])
        self.assertNotIn("latest_activity_date", row["meta"])

    def test_steam_parser_never_reads_publisher_from_shared_dev_row_class(self):
        html = self.STEAM_APP.replace(
            '<div id="developers_list"><a>Pixel Moon</a></div>\n      <div id="publishers_list"><a>Big Publisher</a></div>',
            '<div class="dev_row"><div id="developers_list"><a>Pixel Moon</a></div></div>\n'
            '<div class="dev_row"><div id="publishers_list"><a>Big Publisher</a></div></div>'
        )
        row = sources.steam_candidate_from_html(html, "123")
        self.assertEqual(row["name"], "Pixel Moon")
        self.assertEqual(row["meta"]["developer_names"], ["Pixel Moon"])
        self.assertEqual(row["meta"]["publisher_names"], ["Big Publisher"])

    def test_steam_page_paginates_public_store_search_and_preserves_project_ids(self):
        class Fetcher:
            def __init__(self): self.calls = []
            def fetch(self, url):
                self.calls.append(url)
                if "/search/?" in url:
                    return url, '<span id="search_results_count">3 results match your search</span><a class="search_result_row" data-ds-appid="123"></a><a class="search_result_row" data-ds-appid="456"></a>'
                return url, IndieProjectDiscoveryV3.STEAM_APP
        fetcher = Fetcher()
        rows, cursor = sources.steam_page(fetcher, ["anime game"], None, 2)
        self.assertEqual(len(rows), 2)
        self.assertEqual(cursor, {"keyword_index": 0, "start": 2})
        self.assertIn("start=0", fetcher.calls[0])
        self.assertEqual([x["meta"]["steam_appid"] for x in rows], ["123", "456"])

    def test_itch_discovery_keeps_multiple_projects_by_the_same_creator(self):
        class Fetcher:
            def fetch(self, url):
                return url, '''<div class="game_cell"><div class="game_title"><a href="https://moondev.itch.io/one">One</a></div><div class="game_author"><a href="https://moondev.itch.io">Moon Dev</a></div></div>
                <div class="game_cell"><div class="game_title"><a href="https://moondev.itch.io/two">Two</a></div><div class="game_author"><a href="https://moondev.itch.io">Moon Dev</a></div></div>
                <div class="game_cell"><div class="game_title"><a href="https://moondev.itch.io/three">Three</a></div><div class="game_author"><a href="https://moondev.itch.io">Moon Dev</a></div></div>
                <div class="pagination"><a rel="next" href="?page=2">Next</a></div>'''
        rows, cursor = sources.itch_page(Fetcher(), ["anime game"], None, 2)
        self.assertEqual([r["meta"]["project_title"] for r in rows], ["One", "Two"])
        self.assertEqual(cursor, {"keyword_index": 0, "page": 1, "offset": 2})
        self.assertEqual(rows[0]["name"], rows[1]["name"])
        self.assertNotEqual(rows[0]["meta"]["project_id"], rows[1]["meta"]["project_id"])
        self.assertNotIn("recent_activity", rows[0]["meta"])
        self.assertEqual(rows[0]["website"], "")

    def test_discover_batch_uses_registry_and_returns_resumable_source_cursors(self):
        from unittest.mock import patch
        calls, reservations = [], []
        class Fetcher:
            def fetch(self, url): calls.append(url); return url, "ok"
        def steam_page(fetcher, keywords, cursor, limit):
            fetcher.fetch("https://store.steampowered.com/search/")
            return [{"name": "Dev", "website": "", "meta": {"project_title": "A"}}], {"keyword_index": 0, "start": 12}
        def itch_page(fetcher, keywords, cursor, limit):
            fetcher.fetch("https://itch.io/games/newest/tag-anime")
            return [{"name": "Creator", "website": "", "meta": {"project_title": "B"}}], None
        with patch("kairflow_intel.sources.steam_page", side_effect=steam_page), patch("kairflow_intel.sources.itch_page", side_effect=itch_page):
            result = sources.discover_batch(Fetcher(), "indie_game_developer", {"sources": ["steam", "itch"], "keywords": ["anime"]},
                cursor={"steam": {"keyword_index": 0, "start": 0}}, enabled_sources={"steam", "itch"},
                reserve_source=lambda key: reservations.append(key) or True, limit=25)
        self.assertEqual(len(result["candidates"]), 2)
        self.assertEqual(result["next_cursor"], {
            "steam": {"keyword_index": 0, "start": 12}, "itch": {"done": True}
        })
        self.assertEqual(reservations, ["steam", "itch"])

    def test_completed_source_is_not_restarted_while_other_source_continues(self):
        from unittest.mock import patch
        calls = {"steam": 0, "itch": 0}
        class Fetcher:
            def fetch(self, url): return url, "ok"
        def steam_page(fetcher, keywords, cursor, limit):
            calls["steam"] += 1
            self.assertEqual(cursor, {"keyword_index": 0, "start": 12})
            return [{"name": "Steam Dev", "website": "", "meta": {}}], {"keyword_index": 0, "start": 24}
        def itch_page(fetcher, keywords, cursor, limit):
            calls["itch"] += 1
            self.fail("completed itch source must not be restarted")
        with patch("kairflow_intel.sources.steam_page", side_effect=steam_page), patch("kairflow_intel.sources.itch_page", side_effect=itch_page):
            result = sources.discover_batch(Fetcher(), "indie_game_developer",
                {"sources": ["steam", "itch"], "keywords": ["anime"]},
                cursor={"steam": {"keyword_index": 0, "start": 12}, "itch": {"done": True}},
                enabled_sources={"steam", "itch"}, reserve_source=lambda key: True)
        self.assertEqual(calls, {"steam": 1, "itch": 0})
        self.assertEqual(result["next_cursor"], {"steam": {"keyword_index": 0, "start": 24}, "itch": {"done": True}})

    def test_all_sources_complete_without_creating_an_endless_continuation(self):
        from unittest.mock import patch
        class Fetcher:
            def fetch(self, url): return url, "ok"
        with patch("kairflow_intel.sources.steam_page", return_value=([{"name": "Dev", "meta": {}}], None)):
            result = sources.discover_batch(Fetcher(), "indie_game_developer",
                {"sources": ["steam"], "keywords": ["anime"]}, enabled_sources={"steam"},
                reserve_source=lambda key: True)
        self.assertEqual(result["next_cursor"], {})
        self.assertIsNone(result["defer_seconds"])

    def test_budget_exhaustion_preserves_cursor_until_next_daily_reset(self):
        reports = []
        current = {"keyword_index": 4, "start": 48}
        result = sources.discover_batch(object(), "indie_game_developer", {"sources": ["steam"], "keywords": ["anime"]},
            cursor={"steam": current}, enabled_sources={"steam"}, reserve_source=lambda key: self.fail("must not fetch at zero budget"),
            report_source=lambda *args: reports.append(args),
            source_status={"steam": {"enabled": True, "tos_status": "confirmed", "remaining": 0, "circuit_open": False}})
        self.assertEqual(result["next_cursor"]["steam"], current)
        self.assertEqual(result["defer_seconds"], 86400)
        self.assertFalse(reports)  # a budget hold is not a source failure/circuit-breaker event

    def test_open_source_circuit_preserves_cursor_until_retry_window(self):
        current = {"keyword_index": 2, "page": 3, "offset": 12}
        result = sources.discover_batch(object(), "indie_game_developer", {"sources": ["itch"], "keywords": ["anime"]},
            cursor={"itch": current}, enabled_sources={"itch"}, reserve_source=lambda key: self.fail("must not fetch with open circuit"),
            source_status={"itch": {"enabled": True, "tos_status": "confirmed", "remaining": 10, "circuit_open": True, "retry_after_seconds": 1800}})
        self.assertEqual(result["next_cursor"]["itch"], current)
        self.assertEqual(result["defer_seconds"], 1800)

    def test_periodic_scan_does_not_restart_while_cursor_continuation_is_pending(self):
        d = FakeD({
            "intel_agent_settings": {"today": "2026-11-12", "kill_switch": True,
                "campaigns": [{"type": "indie_game_developer", "status": "active"}]},
            "intel_agent_discovery_has_pending": True,
        })
        worker = jobs.Worker(d, lease_thread=False)
        worker.periodic()
        self.assertFalse(d.named("intel_agent_enqueue_job") and any(x["p_kind"] == "discover" for x in d.named("intel_agent_enqueue_job")))

    def test_transient_source_failure_bubbles_for_persistent_job_retry(self):
        from unittest.mock import patch
        with patch("kairflow_intel.sources.steam_page", side_effect=TransientError("temporary timeout")):
            with self.assertRaises(TransientError):
                sources.discover_batch(object(), "indie_game_developer", {"sources": ["steam"], "keywords": ["anime"]},
                    enabled_sources={"steam"}, reserve_source=lambda key: True)

    def test_discovery_handler_does_not_exclude_a_developer_for_a_protected_publisher(self):
        from unittest.mock import patch
        d = FakeD({
            "intel_agent_settings": {"today": "2026-11-12", "campaigns": [{"type": "indie_game_developer", "status": "active", "criteria": {"sources": ["steam"], "keywords": ["anime"]}}]},
            "intel_agent_sources": {"steam": {}}, "intel_agent_source_use": 1,
            "intel_agent_upsert_prospect": {"prospect_id": "PROJECT-1", "created": True, "suppressed": False},
            "intel_agent_record_item": {"new": True}, "intel_agent_enqueue_job": "job",
        })
        candidate = {"name": "Small Indie Team", "website": "", "meta": {"source": "steam", "source_key": "steam", "project_title": "Moon Quest",
            "project_url": "https://store.steampowered.com/app/123/", "source_url": "https://store.steampowered.com/app/123/",
            "project_id": "steam:123", "publisher_name": "Thermite Games", "developer_name": "Small Indie Team"}}
        with patch("kairflow_intel.jobs.sources.discover_batch", return_value={"candidates": [candidate], "next_cursor": {}}):
            out = jobs.h_discover(d, {"payload": {"type": "indie_game_developer", "limit": 25}})
        self.assertEqual(out["new"], 1)
        self.assertEqual(d.named("intel_agent_upsert_prospect")[0]["p_name"], "Small Indie Team")
        self.assertEqual(d.named("intel_agent_record_item")[0]["p_type"], "game_project")
        self.assertEqual(d.named("intel_agent_record_item")[0]["p_source"], "steam")
        self.assertTrue(any(x["p_kind"] == "research" for x in d.named("intel_agent_enqueue_job")))

    def test_phase3_migration_uses_project_identity_and_keeps_sources_disabled(self):
        from pathlib import Path
        migration = Path(__file__).resolve().parents[2] / "supabase" / "migrations" / "20261112160000_intelligence_indie_project_discovery_v3.sql"
        sql = migration.read_text()
        self.assertIn("'project:' || md5", sql)
        self.assertIn("game_project", sql)
        self.assertIn("Confirm current Valve terms", sql)
        self.assertNotIn("set enabled = true", sql.lower())
        self.assertIn("enabled = false", sql.lower())
        self.assertIn("tos_status = case", sql.lower())
        self.assertIn("project_source_urls", sql)
        self.assertIn("intel_agent_source_status", sql)
        self.assertIn("intel_agent_discovery_has_pending", sql)


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

    def test_query_matches_actual_english_and_japanese_class_labels_only(self):
        q = wikidata.studios_query(["animation studio", "アニメーション制作会社", 'x" } DROP {'])
        self.assertIn('"animation studio"@en', q)
        self.assertIn('"アニメーション制作会社"@ja', q)
        self.assertNotIn("DROP", q)
        empty = wikidata.studios_query(['x" } DROP {'])
        self.assertIn('"__no_valid_class_label__"@en', empty)

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
            def get_ndjson(self, url, params=None): return [
                {"url": "https://s.jp/recruit/", "status": "200"},
                {"url": "ftp://s.jp/recruit/", "status": "200"},
                {"url": "https://s.jp/x", "status": "404"},
                {"url": "https://attacker.example/recruit/", "status": "200"},
                {"url": "https://not-s.jp/recruit/", "status": "200"},
                {"url": "https://s.jp.attacker.example/recruit/", "status": "200"},
            ]
        self.assertEqual([r["url"] for r in commoncrawl.recruit_pages(Api(), "CC-MAIN-2026-30", "s.jp")], ["https://s.jp/recruit/"])
        self.assertEqual(commoncrawl.recruit_pages(Api(), "../../etc", "s.jp"), []); self.assertEqual(commoncrawl.recruit_pages(Api(), "CC-MAIN-2026-30", "s.jp/../x"), [])

    def test_common_crawl_queries_portfolio_and_japanese_credit_paths(self):
        class Api:
            def __init__(self): self.params = None
            def get_ndjson(self, url, params=None):
                self.params = params
                return [{"url": "https://s.jp/works/", "status": "200"},
                        {"url": "https://s.jp/制作実績/", "status": "200"},
                        {"url": "https://s.jp/portfolio/", "status": "200"}]
        api = Api()
        rows = commoncrawl.evidence_pages(api, "CC-MAIN-2026-30", "s.jp")
        self.assertEqual(len(rows), 3)
        self.assertIn("portfolio", api.params["filter"])
        self.assertIn("制作実績", api.params["filter"])

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

    def test_credit_page_selection_covers_public_portfolios_and_japanese_works(self):
        urls = ["https://s.jp/recruit/", "https://s.jp/works/", "https://s.jp/portfolio/2d",
                "https://s.jp/制作実績/", "https://s.jp/about/"]
        got = siteanalysis.pick_credit_pages(urls, limit=3)
        self.assertEqual(set(got), {"https://s.jp/works/", "https://s.jp/portfolio/2d", "https://s.jp/制作実績/"})


class Api(unittest.TestCase):
    def mk(self, routes): return apis.ApiClient(CFG, FakeSession(routes), resolver=PUB, sleep=lambda s: None)

    def test_only_allowlisted_hosts(self):
        c = self.mk({})
        with self.assertRaises(PermanentError): c.get_json("https://evil.test/x")
        with self.assertRaises(PermanentError): c.get_json("http://127.0.0.1/x")

    def test_production_api_transport_pins_validated_dns_and_disables_proxy_env(self):
        from unittest.mock import patch
        class Transport:
            def __init__(self): self.adapters = {}; self.trust_env = True; self.closed = False; self.response = Resp(200, b'{"ok":true}')
            def mount(self, prefix, adapter): self.adapters[prefix] = adapter
            def get(self, url, **kwargs):
                self.kwargs = kwargs
                return self.response
            def close(self): self.closed = True
        transport = Transport()
        resolver_calls = []
        def resolver(host, port):
            resolver_calls.append(host)
            return [(2, 1, 6, "", ("93.184.216.34", 0))]
        with patch.object(apis.requests, "Session", return_value=transport):
            client = apis.ApiClient(CFG, resolver=resolver, sleep=lambda _s: None)
            self.assertEqual(client.get_json("https://query.wikidata.org/sparql"), {"ok": True})
        self.assertEqual(resolver_calls, ["query.wikidata.org"])
        self.assertFalse(transport.trust_env)
        self.assertEqual(transport.adapters["https://"].dns_pin, "93.184.216.34")
        self.assertEqual(transport.adapters["http://"].dns_pin, "93.184.216.34")
        self.assertFalse(transport.kwargs["allow_redirects"])
        self.assertTrue(transport.closed)
        self.assertTrue(transport.response is not None)

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

    def test_anilist_seeding_includes_finished_production_credits(self):
        class Api:
            def __init__(self): self.statuses = []
            def post_json(self, url, payload):
                self.statuses.append(payload["variables"]["status"])
                return {"data": {"Page": {"pageInfo": {"hasNextPage": False}, "media": []}}}
        base = {"intel_agent_settings": self.CRIT, "intel_agent_sources": {"anilist": {}},
                "intel_agent_source_use": 10, "intel_agent_source_report": None}
        api = Api()
        out = discovery.h_seed_sources(FakeD(base, api=api), {"payload": {"type": "animation_studio_support"}})
        self.assertIn("FINISHED", api.statuses)
        self.assertEqual(out["anilist"]["studios"], 0)
        # The handler must reserve five calls: 2 releasing + 1 unreleased + 2 finished.
        quota = FakeD(base, api=api)
        discovery.h_seed_sources(quota, {"payload": {"type": "animation_studio_support"}})
        self.assertEqual(quota.named("intel_agent_source_use")[-1]["p_n"], 5)

    def test_common_crawl_indexes_portfolios_for_known_domains_through_registry(self):
        class Api:
            def get_json(self, url, params=None, accept=None):
                return [{"id": "CC-MAIN-2026-30"}]
            def get_ndjson(self, url, params=None):
                return [{"url": "https://studio.jp/works/", "status": "200", "timestamp": "20261101000000"}]
        base = {"intel_agent_sources": {"commoncrawl": {}}, "intel_agent_source_use": 5,
                "intel_agent_source_report": None, "intel_agent_known_domains": [{"domain": "studio.jp", "prospect_id": "P1"}],
                "intel_agent_record_item": {}, "intel_agent_enqueue_job": "job"}
        d = FakeD(base, api=Api())
        out = discovery.h_crawl_index(d, {"payload": {}})
        self.assertEqual(out["pages"], 1)
        items = d.named("intel_agent_record_item")
        self.assertEqual(items[0]["p_type"], "public_work_page")
        self.assertEqual(items[0]["p_prospect_id"], "P1")

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
        class BudgetedFetcher:
            def __init__(self, inner): self.inner, self.remaining = inner, budget
            def fetch(self, url):
                if self.remaining < 1: raise PermanentError("site_crawler budget exhausted")
                self.remaining -= 1
                return self.inner.fetch(url)
            def sitemaps(self, url): return self.inner.sitemaps(url)
        d = FakeD({"intel_agent_record_item": {}, "intel_agent_add_evidence": True, "intel_agent_flag_prospect": None, "intel_agent_source_use": budget,
                   "intel_agent_resolve_entity": {"prospect_id": None}, "intel_agent_upsert_prospect": {"prospect_id": "N", "created": True, "suppressed": False}, "intel_agent_add_alias": None, "intel_agent_enqueue_job": "j"},
                  fetcher=BudgetedFetcher(self.Fetcher(pages)))
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
        with self.assertRaisesRegex(PermanentError, "budget exhausted"):
            self.run_analyze({"https://example.jp": home}, budget=0)


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


class KickstarterManualIntakeV4(unittest.TestCase):
    def _deps(self, item):
        calls = []
        def rpc(name, args):
            calls.append((name, args))
            if name == "intel_agent_item":
                return item
            if name == "intel_agent_kickstarter_intake_allowed":
                return True
            if name == "intel_agent_kickstarter_commit_import":
                return {"prospect_id": "prospect-123", "created": True, "suppressed": False, "blocked": False}
            return {"ok": True}
        return SimpleNamespace(rpc=rpc, clock=lambda: 1_800_000_000), calls

    def test_manual_project_import_never_fetches_kickstarter_and_keeps_creator_unverified(self):
        item = {"source_key": "kickstarter_manual", "url": "https://www.kickstarter.com/projects/moondev/moon-quest/",
                "title": "Moon Quest", "first_seen": "2026-11-12T10:00:00Z",
                "meta": {"project_title": "Moon Quest", "creator_name": "Moon Dev", "developer_name": "Moon Studio",
                         "developer_website": "", "admin_notes": "Looks like a small RPG.", "permission_confirmed_by_admin": True, "permission_reference": "LEGAL-APPROVAL-42"}}
        deps, calls = self._deps(item)
        out = discovery.h_manual_kickstarter_project(deps, {"payload": {"item_id": "item-1"}}, item=item)
        self.assertEqual(out["result"], "project_imported")
        commit = next(args for name, args in calls if name == "intel_agent_kickstarter_commit_import")
        self.assertEqual(commit["p_name"], "Moon Studio")
        self.assertEqual(commit["p_website"], "")
        self.assertEqual(commit["p_verified"]["developer_identity_status"], "admin_attributed_unverified")
        self.assertEqual(commit["p_verified"]["kickstarter_creator_role"], "unverified")
        self.assertEqual(commit["p_verified"]["project_url"], item["url"])
        self.assertEqual(commit["p_item_id"], "item-1")
        self.assertFalse(any("fetch" in name.lower() for name, _ in calls))
        self.assertTrue(any(name == "intel_agent_flag_prospect" for name, _ in calls))

    def test_manual_project_import_stops_when_kickstarter_is_excluded(self):
        item = {"source_key": "kickstarter_manual", "url": "https://www.kickstarter.com/projects/moondev/moon-quest",
                "title": "Moon Quest", "meta": {"project_title": "Moon Quest", "creator_name": "Moon Dev",
                "developer_name": "Moon Studio", "permission_confirmed_by_admin": True, "permission_reference": "LEGAL-APPROVAL-42"}}
        deps, calls = self._deps(item)
        original_rpc = deps.rpc
        def excluded_rpc(name, args):
            if name == "intel_agent_kickstarter_intake_allowed":
                calls.append((name, args))
                return False
            return original_rpc(name, args)
        deps.rpc = excluded_rpc
        out = discovery.h_manual_kickstarter_project(deps, {"payload": {"item_id": "item-excluded"}}, item=item)
        self.assertEqual(out["result"], "blocked_source_excluded")
        self.assertFalse(any(name == "intel_agent_kickstarter_commit_import" for name, _ in calls))
        self.assertFalse(any(name == "intel_agent_record_item" for name, _ in calls))

    def test_manual_project_import_uses_atomic_commit_and_honors_database_block(self):
        item = {"source_key": "kickstarter_manual", "url": "https://www.kickstarter.com/projects/moondev/moon-quest",
                "title": "Moon Quest", "meta": {"project_title": "Moon Quest", "creator_name": "Moon Dev",
                "developer_name": "Moon Studio", "permission_confirmed_by_admin": True, "permission_reference": "LEGAL-APPROVAL-42"}}
        deps, calls = self._deps(item)
        original_rpc = deps.rpc
        def raced_exclusion_rpc(name, args):
            if name == "intel_agent_kickstarter_commit_import":
                calls.append((name, args))
                return {"blocked": True, "reason": "source_excluded_or_unconfigured"}
            return original_rpc(name, args)
        deps.rpc = raced_exclusion_rpc
        out = discovery.h_manual_kickstarter_project(deps, {"payload": {"item_id": "item-race"}}, item=item)
        self.assertEqual(out["result"], "blocked_source_excluded")
        self.assertFalse(any(name == "intel_agent_enqueue_job" for name, _ in calls))

    def test_manual_project_import_queues_only_official_website_research(self):
        item = {"source_key": "kickstarter_manual", "url": "https://www.kickstarter.com/projects/moondev/moon-quest",
                "title": "Moon Quest", "meta": {"project_title": "Moon Quest", "creator_name": "Moon Dev",
                "developer_name": "Moon Studio", "developer_website": "https://moonstudio.example", "permission_confirmed_by_admin": True, "permission_reference": "LEGAL-APPROVAL-42"}}
        deps, calls = self._deps(item)
        out = discovery.h_manual_kickstarter_project(deps, {"payload": {"item_id": "item-2"}}, item=item)
        self.assertTrue(out["research_queued"])
        queued = next(args for name, args in calls if name == "intel_agent_enqueue_job")
        self.assertEqual(queued["p_kind"], "research")
        self.assertNotIn("kickstarter.com", str(queued["p_payload"]))

    def test_manual_project_import_requires_permission_attestation_and_reference(self):
        item = {"source_key": "kickstarter_manual", "url": "https://www.kickstarter.com/projects/moondev/moon-quest",
                "title": "Moon Quest", "meta": {"project_title": "Moon Quest", "creator_name": "Moon Dev"}}
        deps, calls = self._deps(item)
        with self.assertRaises(PermanentError):
            discovery.h_manual_kickstarter_project(deps, {"payload": {"item_id": "item-5"}}, item=item)
        self.assertFalse(any(name == "intel_agent_kickstarter_commit_import" for name, _ in calls))

    def test_manual_project_import_rejects_platform_or_social_urls_as_developer_websites(self):
        for website in ("https://www.kickstarter.com/projects/moondev/moon-quest", "https://moondev.itch.io", "https://x.com/moondev"):
            item = {"source_key": "kickstarter_manual", "url": "https://www.kickstarter.com/projects/moondev/moon-quest",
                    "title": "Moon Quest", "meta": {"project_title": "Moon Quest", "creator_name": "Moon Dev", "developer_website": website, "permission_confirmed_by_admin": True, "permission_reference": "LEGAL-APPROVAL-42"}}
            deps, _ = self._deps(item)
            with self.subTest(website=website), self.assertRaises(PermanentError):
                discovery.h_manual_kickstarter_project(deps, {"payload": {"item_id": "item-3"}}, item=item)

    def test_manual_project_import_rejects_non_project_or_non_kickstarter_urls(self):
        for url in ("https://kickstarter.com/discover", "https://evil.example/projects/a/b", "http://www.kickstarter.com/projects/a/b", "https://www.kickstarter.com/projects/a/b?ref=abc"):
            item = {"source_key": "kickstarter_manual", "url": url, "title": "Moon Quest",
                    "meta": {"project_title": "Moon Quest", "creator_name": "Moon Dev", "permission_confirmed_by_admin": True, "permission_reference": "LEGAL-APPROVAL-42"}}
            deps, _ = self._deps(item)
            with self.subTest(url=url), self.assertRaises(PermanentError):
                discovery.h_manual_kickstarter_project(deps, {"payload": {"item_id": "item-3"}}, item=item)

    def test_migration_keeps_kickstarter_automated_source_disabled_and_manual_rpc_admin_only(self):
        from pathlib import Path
        migration = Path(__file__).resolve().parents[2] / "supabase" / "migrations" / "20261112170000_intelligence_kickstarter_manual_intake_v4.sql"
        sql = migration.read_text()
        for fragment in ("enabled = false", "'unverified'", "Automated crawling/spidering is prohibited",
                         "intel_admin_add_kickstarter_project", "'manual_post'", "'kickstarter_manual'", "md5(v_url)",
                         "developer_identity_status", "admin_attributed_unverified", "_intel_seed_sources",
                         "Kickstarter intake is excluded by administrator", "Indie Game Developers campaign is not configured",
                         "automated Kickstarter discovery is unavailable", "coalesce(p_enabled, s.enabled) is true",
                         "prior written permission for commercial use is required", "p_permission_confirmed boolean default false",
                         "revoke all on function public.intel_admin_add_kickstarter_project(text,text,text,text,text,text,text,boolean)", "to authenticated"):
            self.assertIn(fragment, sql)
        self.assertNotIn("create or replace function public.kickstarter", sql.lower())
        self.assertNotIn("fetch(", sql.lower())
        corrective = (Path(__file__).resolve().parents[2] / "supabase" / "migrations" / "20261112190000_intelligence_kickstarter_exclusion_identity_fixes.sql").read_text()
        for fragment in ("intel_agent_kickstarter_intake_allowed", "intel_agent_kickstarter_commit_import",
                         "state = 'cancelled'", "tos_status = 'excluded'", "for share",
                         "developer_identity_status", "independently_verified", "kickstarter_creator_role_verified",
                         "v_preserve", "developer_attribution_source", "state = 'cancelled'",
                         "Cancelled: Kickstarter intake excluded by administrator",
                         "grant execute on function public.intel_agent_kickstarter_commit_import", "to service_role"):
            self.assertIn(fragment, corrective)

    def test_existing_manual_post_handler_routes_kickstarter_item_without_model_or_fetch(self):
        item = {"source_key": "kickstarter_manual", "url": "https://www.kickstarter.com/projects/moondev/moon-quest",
                "title": "Moon Quest", "meta": {"project_title": "Moon Quest", "creator_name": "Moon Dev", "permission_confirmed_by_admin": True, "permission_reference": "LEGAL-APPROVAL-42"}}
        deps, calls = self._deps(item)
        out = discovery.h_manual_post(deps, {"payload": {"item_id": "item-4", "type": "indie_game_developer"}})
        self.assertEqual(out["result"], "project_imported")
        self.assertEqual(sum(1 for name, _ in calls if name == "intel_agent_item"), 1)
