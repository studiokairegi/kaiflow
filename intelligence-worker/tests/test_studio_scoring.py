"""Phase 1: studio-v2 scoring. Text -> signals -> score on representative studios, so the whole evidence chain is exercised."""
import json
import unittest

from kairflow_intel import jobs, research, scoring, signals

EMAIL = {"email": "info@studio.example", "name": "", "role": ""}
SMALL_2D_NO_HIRING = (
    "Studio Hoshi is a small independent 2D animation studio in Osaka.\n"
    "We handle layout, key animation, in-betweens and coloring for TV anime series.\n"
    "Our works include three broadcast series and one feature film.\n"
    "Our current series is in production for next season.\n"
    "We take commissioned work from other studios.\n"
    "Business inquiries are welcome at the address below.")
RECRUIT_ONLY = ("We are hiring key animators, in-betweeners, layout artists and colorists. Join our team! Freelancers wanted. "
                "Apply for our 2D animation openings. Careers page.")
JA_STUDIO = ("当社は2Dアニメの制作会社です。\nレイアウト、原画、動画、仕上げまで一貫して手がけます。\nキャラクターの作画を得意としています。\n"
             "制作実績はこちら。TVアニメを多数制作しました。\n現在新作を制作中です。\n他社からの作画協力・受託も承ります。ご依頼はお問い合わせください。")
CG_ONLY = ("We are an animation studio. We do layout, key animation, in-betweens and coloring in 3DCG. Our works include Film A and Film B. "
           "Our series is in production. We take commissioned work from other studios. Business inquiries welcome.")


def run(text, lang="en", contact=EMAIL, **kw):
    found = {k: [v] for k, v in signals.detect_studio(text).items()}
    return scoring.score_studio(found, {"language": lang}, contact, **kw), found


class Weights(unittest.TestCase):
    def test_weights_total_exactly_100_and_items_add_up(self):
        self.assertEqual(sum(scoring.STUDIO_MAX.values()), 100)
        self.assertEqual(scoring.STUDIO_MAX, {"pipeline_fit": 65, "animation_2d": 15, "external_collaboration": 15, "language_preference": 5})
        self.assertEqual(sum(m for _, _, m in scoring.PIPELINE_ITEMS), 65)

    def test_every_awarded_point_is_explainable(self):
        for text, lang in ((SMALL_2D_NO_HIRING, "en"), (JA_STUDIO, "ja"), (RECRUIT_ONLY, "en"), (CG_ONLY, "en")):
            r, _ = run(text, lang)
            self.assertEqual(sum(b["points"] for b in r.breakdown), r.score)
            self.assertLessEqual(r.score, 100)
            for row in r.breakdown:
                self.assertEqual(row["model"], "studio-v2"); self.assertLessEqual(row["points"], row["max"])
                self.assertEqual(sum(i["points"] for i in row["items"]), row["points"])
                for i in row["items"]:
                    self.assertLessEqual(i["points"], i["max"])
                    if i["points"] and i["signal"] != "language":
                        self.assertTrue(i["evidence"] and i["evidence"] in text, i)      # evidence is a real sentence from the page
            json.dumps(r.breakdown)                                                       # storable as jsonb

    def test_empty_is_rejected(self):
        r = scoring.score_studio({}, {}, None)
        self.assertEqual((r.score, r.decision), (0, "rejected"))


class Qualification(unittest.TestCase):
    def test_suitable_small_studio_without_hiring_or_outsourcing_qualifies(self):
        r, found = run(SMALL_2D_NO_HIRING)
        self.assertNotIn("recruit_page", found); self.assertNotIn("outsourcing", found)
        self.assertEqual(r.decision, "qualified"); self.assertGreaterEqual(r.score, 70); self.assertEqual(r.uncertain, [])

    def test_japanese_studio_qualifies(self):
        r, found = run(JA_STUDIO, "ja")
        self.assertEqual((r.decision, r.uncertain), ("qualified", [])); self.assertGreaterEqual(r.score, 70)

    def test_recruitment_alone_cannot_qualify(self):
        r, found = run(RECRUIT_ONLY)
        self.assertIn("recruit_page", found)
        self.assertNotEqual(r.decision, "qualified"); self.assertLess(r.score, 70)
        r2, _ = run(RECRUIT_ONLY, contact={"email": "x@studio.example", "name": "A", "role": "Producer"})
        self.assertNotEqual(r2.decision, "qualified")

    def test_recruitment_wording_adds_no_full_capability_credit(self):
        hire = {"role_key": "We are hiring key animators.", "role_layout": "Layout artists wanted.", "style_2d": "2D animators wanted."}
        r = scoring.score_studio(hire, {"language": "en"}, EMAIL)
        pipe = next(b for b in r.breakdown if b["criterion"] == "pipeline_fit")
        self.assertTrue(all(i["points"] <= 3 for i in pipe["items"])); self.assertEqual(pipe["status"], "uncertain")

    def test_uncertain_2d_forces_review_even_above_70(self):
        r, _ = run(CG_ONLY)
        self.assertGreaterEqual(r.score, 70); self.assertEqual(r.decision, "needs_review"); self.assertIn("animation_2d", r.uncertain)
        self.assertEqual(r.suitability, "needs_review")

    def test_uncertain_collaboration_forces_review_even_above_70(self):
        text = "Studio Q is a 2D animation studio making TV anime series. We produce hand-drawn 2D anime. We do layout, key animation, in-betweens and coloring. Our works include Series A and Series B. Our series is in production."
        r, _ = run(text)
        self.assertGreaterEqual(r.score, 70); self.assertEqual((r.decision, r.uncertain), ("needs_review", ["external_collaboration"]))

    def test_uncertain_pipeline_forces_review_even_above_70(self):
        sig = {"role_key": "Studio Z does key animation.", "role_layout": "Layout artists wanted.", "role_inbetween": "In-betweeners wanted.", "role_coloring": "Colorists wanted.",
               "role_character": "Character animation staff wanted.", "production_active": "Season 2 is in production.", "multiple_titles": "Our works include A and B.",
               "style_2d": "We make 2D animation.", "style_2d_anime": "We make hand-drawn 2D anime.", "external_collab": "We take client work.", "outsourcing": "We use partner studios.",
               "business_inquiry": "Business inquiries welcome."}
        r = scoring.score_studio(sig, {"language": "en"}, EMAIL)
        self.assertGreaterEqual(r.score, 70); self.assertEqual((r.decision, r.uncertain), ("needs_review", ["pipeline_fit"]))

    def test_plain_contact_us_is_not_collaboration_evidence(self):
        r = scoring.score_studio({"business_inquiry": "Contact us for anything."}, {}, EMAIL)
        coll = next(b for b in r.breakdown if b["criterion"] == "external_collaboration")
        self.assertEqual(coll["points"], 0)

    def test_language_is_a_preference_not_a_requirement(self):
        a, _ = run(SMALL_2D_NO_HIRING, "en"); b, _ = run(SMALL_2D_NO_HIRING, "fr")
        self.assertEqual(a.score - b.score, 5); self.assertEqual(b.decision, "qualified")      # still qualifies, no minimum size / volume either

    def test_bands_and_contact_gate(self):
        r, _ = run(SMALL_2D_NO_HIRING, contact=None)
        self.assertEqual((r.suitability, r.decision), ("qualified", "qualified"))           # suitability is independent of contactability
        self.assertEqual(run(SMALL_2D_NO_HIRING, contact={"form_url": "https://x"})[0].decision, "qualified")
        # Campaign-level threshold overrides are ignored for studio-v2.
        borderline = {
            "role_layout": "We do layout.", "role_key": "We do key animation.",
            "style_2d": "We make 2D animation.",
            "external_collab": "We take client work.",
        }
        fixed = scoring.score_studio(borderline, {"language": "other"}, None, qualify_min=30, review_min=20)
        self.assertEqual(fixed.score, 37)
        self.assertEqual(fixed.decision, "rejected")
        self.assertEqual((scoring.STUDIO_QUALIFY_MIN, scoring.STUDIO_REVIEW_MIN), (70, 50))


class Detection(unittest.TestCase):
    def test_capability_sentence_preferred_over_hiring_sentence(self):
        t = "We are hiring key animators now. Studio X does key animation for TV series."
        self.assertEqual(signals.detect_studio(t)["role_key"], "Studio X does key animation for TV series.")

    def test_hiring_only_sentence_is_still_recorded_as_is(self):
        t = "We are hiring key animators."
        s = signals.detect_studio(t)["role_key"]; self.assertIn(s, t); self.assertTrue(signals.RECRUIT_CONTEXT.search(s))

    def test_japanese_clause_not_contaminated_by_neighbour(self):
        s = signals.detect_studio("原画、動画、仕上げまで制作します。採用情報はこちら。")["role_key"]
        self.assertNotIn("採用", s)

    def test_indie_table_detection_unchanged(self):
        self.assertIn("style_2d", signals.detect_indie("A hand-drawn 2D adventure. Coming soon."))

    def test_portfolio_heading_alone_is_not_published_work_evidence(self):
        for text in ("Our works page is available here.", "Filmography", "制作実績はこちら。"):
            self.assertNotIn("multiple_titles", signals.detect_studio(text), text)

    def test_multiple_identifiable_entries_are_published_work_evidence(self):
        for text in ("Our works include Title A and Title B.", "Filmography: Title A, Title B.", "制作実績：作品A、作品B"):
            self.assertIn("multiple_titles", signals.detect_studio(text), text)


def ctx(score=None, breakdown=None, estimates=None, ptype="animation_studio_support"):
    ev = [{"fact_type": k, "snippet": v, "verified": True} for k, v in {
        "role_layout": "We do layout.", "role_key": "We do key animation.", "role_inbetween": "We do in-betweens.", "role_coloring": "We do coloring.", "style_2d": "We are a 2D studio.", "anime_production": "We produce anime series.",
        "external_collab": "We take client work.", "production_active": "Our series is in production.", "multiple_titles": "Our works include A."}.items()]
    p = {"id": "p1", "type": ptype, "score": score, "score_breakdown": breakdown if breakdown is not None else {}, "facts": {"estimates": estimates or {}, "verified": {"language": "en"}},
         "contact_email": "info@studio.example", "contact_name": "", "language": "en", "domain": "studio.example"}
    return {"prospect": p, "evidence": ev}


class Rec:
    def __init__(self): self.calls = []
    def __call__(self, name, args): self.calls.append((name, args)); return None
    def named(self, n): return [a for k, a in self.calls if k == n]


class LegacyPreservation(unittest.TestCase):
    def test_first_score_is_written_with_model_version(self):
        r = Rec(); res = research.qualify(r, ctx(), {})
        s = r.named("intel_agent_set_score")[0]
        self.assertEqual(s["p_estimates"]["scoring_model"], "studio-v2"); self.assertTrue(all(b["model"] == "studio-v2" for b in s["p_breakdown"]))
        self.assertFalse(res.held); self.assertEqual(res.decision, "qualified")  # suitability is independent; contactability is needs_review/rejected separately
        self.assertEqual(res.contactability["status"], "needs_review")

    def test_contactability_needs_review_blocks_resolve_even_when_suitable(self):
        dctx = ctx()
        dctx["prospect"]["facts"]["verified"].update({"contact_verification": "website_extracted", "contact_email": "info@studio.example", "contact_source_url": "https://studio.example/contact"})
        enq = []
        class D:
            def rpc(self, name, args=None):
                if name == "intel_agent_context": return dctx
                if name == "intel_agent_settings": return {"campaigns": [{"type": "animation_studio_support", "criteria": {}}]}
                return None
        orig = jobs._enq; jobs._enq = lambda *a, **k: enq.append(a[1])
        try:
            out = jobs.h_qualify(D(), {"payload": {"prospect_id": "p1"}})
        finally:
            jobs._enq = orig
        self.assertEqual(out["decision"], "qualified")
        self.assertEqual(out["contactability"]["status"], "needs_review")
        self.assertNotIn("resolve", enq)

    def test_contactability_pass_allows_resolve(self):
        dctx = ctx()
        dctx["prospect"]["facts"]["verified"].update({"contact_verification": "human_confirmed", "contact_email": "info@studio.example", "contact_source_url": "https://studio.example/contact"})
        enq = []
        class D:
            def rpc(self, name, args=None):
                if name == "intel_agent_context": return dctx
                if name == "intel_agent_settings": return {"campaigns": [{"type": "animation_studio_support", "criteria": {}}]}
                return None
        orig = jobs._enq; jobs._enq = lambda *a, **k: enq.append(a[1])
        try:
            out = jobs.h_qualify(D(), {"payload": {"prospect_id": "p1"}})
        finally:
            jobs._enq = orig
        self.assertEqual(out["contactability"]["status"], "pass")
        self.assertIn("resolve", enq)

    def test_legacy_score_is_not_overwritten_and_candidate_is_recorded(self):
        old = [{"criterion": "active_production", "points": 20, "max": 20, "why": "x"}]
        r = Rec(); res = research.qualify(r, ctx(score=88, breakdown=old), {})
        self.assertEqual(r.named("intel_agent_set_score"), []); self.assertTrue(res.held)
        ev = r.named("intel_agent_add_evidence")[0]
        self.assertFalse(ev["p_verified"]); self.assertEqual(ev["p_fact_type"], "rescore_candidate_studio-v2")
        self.assertEqual(json.loads(ev["p_snippet"])["model"], "studio-v2")
        self.assertEqual(research.prior_studio_model(ctx(score=88, breakdown=old)["prospect"]), "studio-v1")
        self.assertIsNone(research.prior_studio_model(ctx()["prospect"]))

    def test_same_model_refresh_is_written(self):
        r = Rec(); research.qualify(r, ctx(score=80, breakdown=[{"criterion": "pipeline_fit", "model": "studio-v2"}]), {})
        self.assertEqual(len(r.named("intel_agent_set_score")), 1)

    def test_held_prospect_does_not_enter_resolve(self):
        enq = []
        class D:
            def rpc(self, name, args=None):
                if name == "intel_agent_context": return ctx(score=88, breakdown=[{"criterion": "x"}])
                if name == "intel_agent_settings": return {"campaigns": [{"type": "animation_studio_support", "criteria": {}}]}
                return None
        orig = jobs._enq; jobs._enq = lambda d, kind, payload, key: enq.append(kind)
        try:
            out = jobs.h_qualify(D(), {"payload": {"prospect_id": "p1"}})
        finally:
            jobs._enq = orig
        self.assertEqual(enq, []); self.assertIn("held", out)

    def test_indie_path_uses_project_first_model(self):
        r = Rec(); res = research.qualify(r, ctx(ptype="indie_game_developer", score=75, breakdown=[{"criterion": "active_development"}]), {})
        self.assertEqual(len(r.named("intel_agent_set_score")), 1); self.assertFalse(res.held); self.assertEqual(res.model, scoring.INDIE_MODEL)


class ResearchCorrections(unittest.TestCase):
    def test_portfolio_and_services_rank_ahead_of_recruitment(self):
        html = '''<a href="/careers">Careers</a><a href="/news">News</a>
        <a href="/services">Services</a><a href="/works#top">Works</a><a href="https://other.example/portfolio">External portfolio</a>'''
        pages = research.candidate_pages("https://studio.example/", html, limit=2)
        self.assertEqual(pages, ["https://studio.example/works", "https://studio.example/services"])

    def test_language_detection_does_not_default_missing_or_unknown_to_english(self):
        self.assertEqual(research._page_language('<html><body><p>Hello world this is an animation studio website.</p></body></html>'), "en")
        self.assertEqual(research._page_language('<html lang="ja"><body>アニメーション制作</body></html>'), "ja")
        self.assertIsNone(research._page_language('<html><body>Studio</body></html>'))
        self.assertEqual(research._validated_language("bad", [("https://x", '<html><body>Studio</body></html>')]), "other")

    def test_language_model_failure_does_not_award_language_points(self):
        r = scoring.score_studio({}, {"language": None}, None)
        self.assertEqual(next(x for x in r.breakdown if x["criterion"] == "language_preference")["points"], 0)

    def test_outsourcing_only_is_supplementary_not_confirmed(self):
        r = scoring.score_studio({"outsourcing": "We work with outsourcing partner studios."}, {"language": "other"}, None)
        row = next(x for x in r.breakdown if x["criterion"] == "external_collaboration")
        self.assertEqual(row["status"], "uncertain")

    def test_generic_japanese_tv_anime_does_not_confirm_2d(self):
        detected = signals.detect_studio("\u30c6\u30ec\u30d3\u30a2\u30cb\u30e1\u306e\u4f5c\u753b\u3092\u62c5\u5f53\u3057\u3066\u3044\u307e\u3059\u3002")
        self.assertNotIn("style_2d_anime", detected)
        found = {k: [v] for k, v in detected.items()}
        r = scoring.score_studio(found, {"language": "ja"}, None)
        row = next(x for x in r.breakdown if x["criterion"] == "animation_2d")
        self.assertEqual(row["status"], "uncertain")

    def test_documented_2d_anime_is_scored_and_confirms_2d(self):
        r = scoring.score_studio({"style_2d_anime": "当社は手描きのテレビアニメを制作しています。", "anime_production": "当社はテレビアニメを制作しています。"}, {"language": "ja"}, None)
        row = next(x for x in r.breakdown if x["criterion"] == "animation_2d")
        self.assertEqual(row["status"], "confirmed")
        self.assertEqual(row["points"], 7)
        self.assertEqual(row["items"][1]["signal"], "style_2d_anime")

    def test_generic_anime_or_3d_cg_does_not_receive_2d_points(self):
        found = {k: [v] for k, v in signals.detect_studio("We produce anime series entirely in 3DCG.").items()}
        r = scoring.score_studio(found, {"language": "en"}, None)
        row = next(x for x in r.breakdown if x["criterion"] == "animation_2d")
        self.assertEqual(row["points"], 0)
        self.assertEqual(row["status"], "uncertain")

    def test_2d_anime_evidence_awards_points_without_generic_anime_double_count(self):
        r = scoring.score_studio({"style_2d_anime": "We produce hand-drawn 2D anime.", "anime_production": "We produce anime series."}, {"language": "en"}, None)
        row = next(x for x in r.breakdown if x["criterion"] == "animation_2d")
        self.assertEqual(row["points"], 7)

    def test_existing_email_not_relabelled_verified_and_evidence_keeps_page_urls(self):
        home = '<html><body><a href="/works">Works</a><p>We are hiring key animators.</p><p>info@studio.example</p></body></html>'
        works = '<html lang="en"><body><p>We produce 2D animation for television anime.</p><p>We do key animation for client projects.</p></body></html>'
        class Fetch:
            def fetch(self, url):
                return (url, home if url.endswith("/") else works)
        calls = []
        def rpc(name, args): calls.append((name, args))
        prospect = {"id":"p1", "type":"animation_studio_support", "website":"https://studio.example/", "domain":"studio.example", "name":"Studio", "contact_email":"old@studio.example", "contact_source_url":"https://old.example/contact", "facts":{"verified":{}}}
        result = research.research(rpc, Fetch(), lambda _: {"language":"en"}, {"prospect":prospect})
        evidence = [a for n,a in calls if n == "intel_agent_add_evidence"]
        email_evidence = [e for e in evidence if e["p_fact_type"] == "contact_email"]
        self.assertEqual(email_evidence, [])
        self.assertTrue(any(e["p_url"] == "https://studio.example/works" for e in evidence if e["p_fact_type"] == "style_2d"))
        upsert = next(a for n,a in calls if n == "intel_agent_upsert_prospect")
        self.assertEqual(upsert["p_contact_email"], "")
        self.assertEqual(upsert["p_verified"]["contact_verification"], "unknown_legacy")
        self.assertEqual(result["contact_verified"], False)

if __name__ == "__main__":
    unittest.main()
