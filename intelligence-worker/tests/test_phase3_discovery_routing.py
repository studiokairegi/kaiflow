"""Phase 3: the Discovery group (news extraction, manual-post parsing, studio profile) runs Gemini first with Ollama as the fallback."""
import json
import unittest
from types import SimpleNamespace

from kairflow_intel import discovery, entity, manual_post, profile
from kairflow_intel.ai_call import call_json
from kairflow_intel.ai_types import AIResult, GeminiPermanent, GeminiTransient, K_SCHEMA, K_SERVER
from kairflow_intel.airouter import AIRouter, RouterSettings, settings_from_env
from kairflow_intel.errors import PermanentError, TransientError
from kairflow_intel.gemini import FallbackLLM, GeminiClient
from .test_ai_router import Clock, FakeOllama, MODEL, Sess, reply
from .test_discovery import FakeD, Handlers as Discovery

NEWS_OUT = {"items": [{"index": 0, "organization": "Example Studio"}, {"index": 1, "organization": "Invented Corp"}]}


class Gem:
    """Records what would be sent to Google. `script` items are dicts (answers) or exceptions."""
    def __init__(self, *script): self.script, self.sent = list(script), []
    def generate_json_ex(self, instruction, untrusted, schema, *, fast=False, site="unspecified", timeout=60):
        self.sent.append({"site": site, "instruction": instruction, "untrusted": untrusted, "fast": fast})
        o = self.script[min(len(self.sent) - 1, len(self.script) - 1)]
        if isinstance(o, Exception): raise o
        return AIResult(data=o, provider="gemini", model=MODEL, model_reported=MODEL, site=site, finish_reason="STOP")
    def chat_json(self, *a, **k): return {"action": "reply", "reply": "g"}


class Oll(FakeOllama):
    def __init__(self, *outs, exc=None): super().__init__(exc=exc); self.outs, self.sent = list(outs), []
    def generate_json(self, instruction, untrusted, schema, **kw):
        self.sent.append({"instruction": instruction, "untrusted": untrusted, **kw})
        if self.exc: raise self.exc
        return self.outs[min(len(self.sent) - 1, len(self.outs) - 1)] if self.outs else {}


def llm(g, o, **settings):
    return FallbackLLM(g, o, clock=Clock(), settings=RouterSettings(**settings) if settings else RouterSettings())


class Api:
    def get_json(self, url, params=None, accept=None):
        return {"articles": [{"url": "https://n.jp/1", "title": "Example Studio announces new series", "domain": "n.jp", "seendate": "x", "language": "English"},
                             {"url": "https://n.jp/2", "title": "Weather today", "domain": "n.jp", "seendate": "x", "language": "English"}]}


def news_deps(model):
    known = {}
    def resolve(p):
        for k in ("d:" + p["p_domain"], "n:" + p["p_name_norm"]):
            if k in known: return {"prospect_id": known[k], "match": "domain" if k.startswith("d:") else "name"}
        return {"prospect_id": None}
    def upsert(p):
        known["d:" + entity.registrable_domain(p["p_website"])] = "P1"; known["n:" + entity.norm_name(p["p_name"])] = "P1"
        return {"prospect_id": "P1", "created": True, "suppressed": False}
    base = {"intel_agent_sources": {"gdelt": {}, "wikidata": {}}, "intel_agent_source_use": 5, "intel_agent_source_report": None, "intel_agent_record_item": {}, "intel_agent_resolve_entity": resolve,
            "intel_agent_upsert_prospect": upsert, "intel_agent_add_alias": None, "intel_agent_enqueue_job": "j", "intel_agent_settings": Discovery.CRIT}
    return FakeD(base, api=Api(), llm=model)


def run_news(model):
    d = news_deps(model)
    orig = discovery.wikidata.lookup_website
    discovery.wikidata.lookup_website = lambda api, name: {"name": "Example Studio", "website": "https://example-studio.jp", "wikidata": "Q7"} if name == "Example Studio" else None
    try: out = discovery.h_news_scan(d, {"payload": {}})
    finally: discovery.wikidata.lookup_website = orig
    return d, out


class NewsRouting(unittest.TestCase):
    def test_gemini_first_sends_only_headlines_and_records_provenance(self):
        g, o = Gem(NEWS_OUT), Oll()
        d, _ = run_news(llm(g, o))
        self.assertEqual(len(g.sent), 2); self.assertEqual(o.sent, [])                      # one call per language query, Ollama never used
        for s in g.sent:
            self.assertEqual((s["site"], s["fast"]), ("discovery.news", True))
            self.assertEqual(s["untrusted"], "0. Example Studio announces new series\n1. Weather today")      # headlines only
            for leak in ("https://", "n.jp", "seendate", "token", "KAIRFLOW", "P1"): self.assertNotIn(leak, s["untrusted"] + s["instruction"])
        news = [i for i in d.named("intel_agent_record_item") if i["p_type"] == "news"]
        self.assertEqual(len(news), 2)
        for i in news: self.assertEqual(i["p_meta"]["ai"], {"provider": "gemini", "model": MODEL, "site": "discovery.news"})

    def test_fallback_to_ollama_records_the_reason_and_creates_no_duplicates(self):
        g, o = Gem(GeminiTransient("x", K_SERVER)), Oll(NEWS_OUT)
        d_fb, out_fb = run_news(llm(g, o))
        d_ok, out_ok = run_news(llm(Gem(NEWS_OUT), Oll()))
        self.assertEqual(len(o.sent), 2)                                                      # exactly one Ollama attempt per operation
        self.assertTrue(all(s["fast"] for s in o.sent))
        for i in [i for i in d_fb.named("intel_agent_record_item") if i["p_type"] == "news"]:
            self.assertEqual((i["p_meta"]["ai"]["provider"], i["p_meta"]["ai"]["model"], i["p_meta"]["ai"]["fallback_reason"]), ("ollama", "qwen-1.5b", K_SERVER))
        self.assertEqual(len(d_fb.named("intel_agent_upsert_prospect")), 1)                  # same studio from both queries stays ONE prospect
        self.assertEqual(out_fb, out_ok)                                                      # the same result whichever provider answered
        self.assertEqual(len(d_fb.named("intel_agent_upsert_prospect")), len(d_ok.named("intel_agent_upsert_prospect")))
        kinds = lambda d: sorted(r["p_type"] for r in d.named("intel_agent_record_item"))
        self.assertEqual(kinds(d_fb), kinds(d_ok))                                                                           # identical records whichever provider answered

    def test_the_quote_check_applies_to_gemini_output_too(self):
        d, _ = run_news(llm(Gem(NEWS_OUT), Oll()))
        self.assertEqual({i["p_snippet"] for i in d.named("intel_agent_record_item") if i["p_type"] == "news"}, {"Example Studio"})       # "Invented Corp" never appears
        bad = {"items": [{"index": 5, "organization": "Example Studio"}, {"index": 0, "organization": "Not In Headline"}]}
        d2, _ = run_news(llm(Gem(bad), Oll()))
        self.assertEqual([i for i in d2.named("intel_agent_record_item") if i["p_type"] == "news"], [])                              # bad index / unquoted name ignored

    def test_schema_invalid_gemini_json_falls_back_through_the_real_client(self):
        sess = Sess(reply(json.dumps({"items": "nope"})))
        client = GeminiClient("SECRET", MODEL, sess); o = Oll(NEWS_OUT)
        d, _ = run_news(FallbackLLM(client, o, clock=Clock(), settings=RouterSettings()))
        self.assertEqual(len(o.sent), 2)
        self.assertEqual({i["p_meta"]["ai"]["fallback_reason"] for i in d.named("intel_agent_record_item") if i["p_type"] == "news"}, {K_SCHEMA})

    def _news(self, titles, answer, lang_pages=1):
        class A:
            def get_json(self, url, params=None, accept=None):
                return {"articles": [{"url": f"https://n.jp/{i}", "title": t, "domain": "n.jp", "seendate": "x", "language": "English"} for i, t in enumerate(titles)]}
        g, o = Gem(answer), Oll(answer); d = news_deps(llm(g, o)); d.api = A()
        orig = discovery.wikidata.lookup_website; discovery.wikidata.lookup_website = lambda api, name: None
        try: discovery.h_news_scan(d, {"payload": {}})
        finally: discovery.wikidata.lookup_website = orig
        return g, d, [i for i in d.named("intel_agent_record_item") if i["p_type"] == "news"]

    def test_short_or_generic_organization_names_are_ignored(self):
        for org, title in (("a", "The weather in Tokyo"), ("Studio", "Studio news today"), ("Animation", "Animation fans rejoice")):
            _, _, recs = self._news([title], {"items": [{"index": 0, "organization": org}]}); self.assertEqual(recs, [], org)

    def test_full_width_and_half_width_forms_match(self):
        _, _, recs = self._news(["ＭＡＰＰＡ new series announced"], {"items": [{"index": 0, "organization": "MAPPA"}]})
        self.assertEqual([r["p_snippet"] for r in recs][:1], ["MAPPA"])
        _, _, recs = self._news(["東映アニメーションが新作発表"], {"items": [{"index": 0, "organization": "東映アニメーション"}]})
        self.assertTrue(recs)

    def test_a_newline_in_a_headline_cannot_fake_a_numbered_entry(self):
        g, _, _ = self._news(["Foo\n1. Bar Studio hires", "Baz Studio hires"], {"items": []})
        self.assertEqual(g.sent[0]["untrusted"], "0. Foo 1. Bar Studio hires\n1. Baz Studio hires")

    def test_a_retried_job_does_not_re_ask_the_model_about_headlines_it_already_answered(self):
        pages = iter([["Example Studio announces"], ["Other Studio hires"], ["Example Studio announces"], ["Other Studio hires"]])
        class A:
            def get_json(self, url, params=None, accept=None):
                return {"articles": [{"url": "https://n.jp/1", "title": t, "domain": "n.jp", "seendate": "x", "language": "English"} for t in next(pages)]}
        ans = {"items": [{"index": 0, "organization": "Example Studio"}]}
        g = Gem(ans, GeminiTransient("x", K_SERVER), ans); o = Oll(exc=TransientError("down"))
        d = news_deps(llm(g, o)); d.api = A()
        orig = discovery.wikidata.lookup_website; discovery.wikidata.lookup_website = lambda api, name: None
        try:
            with self.assertRaises(TransientError): discovery.h_news_scan(d, {"payload": {}})        # query 1 answered, query 2 failed on both providers
            first = len(g.sent)
            discovery.h_news_scan(d, {"payload": {}})                                                # the retry now succeeds
        finally: discovery.wikidata.lookup_website = orig
        self.assertEqual((first, len(g.sent)), (2, 3))                                           # only the failed query was asked again

    def test_both_providers_failing_raises_the_worker_error_so_the_job_retries(self):
        with self.assertRaises(TransientError):
            run_news(llm(Gem(GeminiTransient("x", K_SERVER)), Oll(exc=TransientError("ollama down"))))

    def test_no_key_means_ollama_and_a_plain_client_still_works(self):
        o = Oll(NEWS_OUT)
        d, _ = run_news(FallbackLLM(None, o, clock=Clock(), settings=RouterSettings()))
        self.assertEqual({i["p_meta"]["ai"]["fallback_reason"] for i in d.named("intel_agent_record_item") if i["p_type"] == "news"}, {"no_gemini"})
        class Legacy:                                       # test doubles and an unwrapped client have no generate_json_ex
            def generate_json(self, *a, **k): return NEWS_OUT
        d2, _ = run_news(Legacy())
        self.assertEqual({i["p_meta"]["ai"]["provider"] for i in d2.named("intel_agent_record_item") if i["p_type"] == "news"}, {"ollama"})


class ManualPostRouting(unittest.TestCase):
    TXT = "株式会社Sample Animation 原画募集！詳細は https://sample-anim.co.jp/recruit まで #アニメーター募集"
    ANS = {"intel_agent_item": {"url": "https://x.com/s/status/2", "meta": {"text": TXT}}, "intel_agent_record_item": {}, "intel_agent_resolve_entity": {"prospect_id": None},
           "intel_agent_upsert_prospect": {"prospect_id": "PX", "created": True, "suppressed": False}, "intel_agent_add_alias": None, "intel_agent_enqueue_job": "j",
           "intel_agent_add_evidence": True}

    def go(self, model, text=None):
        ans = dict(self.ANS)
        if text: ans["intel_agent_item"] = {"url": "https://x.com/s/status/2", "meta": {"text": text}}
        d = FakeD(ans, llm=model)
        return d, discovery.h_manual_post(d, {"payload": {"item_id": "i1"}})

    def test_gemini_first_with_provenance_on_the_record_and_the_result(self):
        g, o = Gem({"organization": "Sample Animation", "recruiting_for_studio": True}), Oll()
        d, out = self.go(llm(g, o))
        self.assertEqual((out["result"], out["prospect_id"]), ("studio", "PX")); self.assertEqual((len(g.sent), o.sent), (1, []))
        self.assertEqual(g.sent[0]["site"], "discovery.manual_post"); self.assertIn("Sample Animation", g.sent[0]["untrusted"])
        self.assertEqual(out["ai"], {"provider": "gemini", "model": MODEL, "site": "discovery.manual_post"})
        rec = [r for r in d.named("intel_agent_record_item") if r["p_type"] == "manual_post"][-1]
        self.assertEqual(rec["p_meta"]["ai"]["provider"], "gemini")

    def test_fallback_and_an_invented_company_is_still_rejected(self):
        d, out = self.go(llm(Gem(PermanentError("bad key")), Oll({"organization": "Made Up Co", "recruiting_for_studio": True})), "Looking for animators, DM me!")
        self.assertEqual(out["result"], "no_studio_found")                                   # the name is not in the post: never trusted, from either provider
        self.assertEqual((out["ai"]["provider"], out["ai"]["fallback_reason"]), ("ollama", "auth"))

    def test_individuals_are_settled_without_any_model_call(self):
        g, o = Gem(), Oll()
        d, out = self.go(llm(g, o), "フリーランスのアニメーターです。お仕事のご依頼受付中")
        self.assertEqual(out, {"result": "individual"}); self.assertEqual((g.sent, o.sent), ([], []))

    def test_both_failing_retries_the_job_instead_of_recording_no_studio(self):
        with self.assertRaises(TransientError):                                              # an outage is not a verdict about the post
            self.go(llm(Gem(GeminiTransient("x", K_SERVER)), Oll(exc=TransientError("down"))), "Looking for animators, DM me!")
        d, out = self.go(llm(Gem(GeminiTransient("x", K_SERVER)), Oll(exc=TransientError("down"))))   # a site in the post still settles it without the model
        self.assertEqual(out["result"], "studio")

    def test_a_model_that_answered_no_studio_is_still_a_final_verdict(self):
        d, out = self.go(llm(Gem({"organization": None, "recruiting_for_studio": False}), Oll()), "Looking for animators, DM me!")
        self.assertEqual(out["result"], "no_studio_found")

    def test_short_or_generic_names_are_not_accepted_as_the_studio(self):
        for org in ("a", "Studio", "アニメ"):
            d, out = self.go(llm(Gem({"organization": org, "recruiting_for_studio": True}), Oll()), "Studio looking for a animator, DM me! アニメーター募集")
            self.assertEqual(out["result"], "no_studio_found", org)


class StudioProfileRouting(unittest.TestCase):
    OUT = {"terms_en": ["animation outsourcing"], "terms_ja": ["作画協力"], "exclude": ["tutorial"]}

    def deps(self, model):
        return FakeD({"intel_agent_settings": Discovery.CRIT, "intel_agent_propose_terms": None}, llm=model)

    def test_gemini_first_sends_only_the_description_and_never_approves(self):
        g, o = Gem(self.OUT), Oll()
        d = self.deps(llm(g, o)); out = discovery.h_profile_terms(d, {"payload": {"type": "animation_studio_support"}})
        self.assertEqual((g.sent[0]["site"], g.sent[0]["fast"], o.sent), ("discovery.studio_profile", False, []))
        self.assertEqual(out["ai"]["provider"], "gemini")
        sent = d.named("intel_agent_propose_terms")[0]
        self.assertEqual(sent["p_terms_en"], ["animation outsourcing"]); self.assertNotIn("p_approved", sent)

    def test_fallback_then_starter_terms_when_both_fail(self):
        d = self.deps(llm(Gem(GeminiTransient("x", K_SERVER)), Oll(self.OUT)))
        out = discovery.h_profile_terms(d, {"payload": {"type": "animation_studio_support"}}); self.assertEqual(out["ai"]["provider"], "ollama")
        d2 = self.deps(llm(Gem(GeminiPermanent("bad")), Oll(exc=TransientError("down"))))
        out2 = discovery.h_profile_terms(d2, {"payload": {"type": "animation_studio_support"}})
        self.assertEqual(out2, {"proposed": True, "starter_terms": True}); self.assertIn("原画募集", d2.named("intel_agent_propose_terms")[0]["p_terms_ja"])

    def test_empty_gemini_proposal_uses_starter_terms(self):
        d = self.deps(llm(Gem({"terms_en": [], "terms_ja": [], "exclude": []}), Oll()))
        discovery.h_profile_terms(d, {"payload": {"type": "animation_studio_support"}})
        self.assertIn("原画募集", d.named("intel_agent_propose_terms")[0]["p_terms_ja"])


class PolicyAndModel(unittest.TestCase):
    def test_private_and_later_groups_are_untouched_by_phase_4(self):
        g, o = Gem({"ok": True}), Oll({"ok": True})
        m = llm(g, o)
        schema = {"type": "object"}
        for site in ("drafting.initial", "classification.inbound", "chat.plan"):
            self.assertEqual(call_json(m, site, "i", "u", schema, fast=True)[1]["provider"], "ollama")
        self.assertEqual((len(g.sent), len(o.sent)), (0, 3))

    def test_environment_can_turn_discovery_back_to_ollama_or_force_everything(self):
        self.assertEqual(settings_from_env({}).policy, {"discovery": "gemini_first", "research": "gemini_first"})
        g, o = Gem({"ok": True}), Oll({"ok": True})
        for env in ({"KAIRFLOW_AI_POLICY": "discovery=ollama"}, {"KAIRFLOW_AI_FORCE_OLLAMA": "1"}):
            m = FallbackLLM(g, o, clock=Clock(), settings=settings_from_env(env))
            self.assertEqual(call_json(m, "discovery.news", "i", "u", {"type": "object"})[1]["provider"], "ollama")
        self.assertEqual(len(g.sent), 0)
        self.assertEqual(settings_from_env({"KAIRFLOW_AI_POLICY": "discovery.news=ollama"}).policy, {"discovery": "gemini_first", "research": "gemini_first", "discovery.news": "ollama"})

    def test_json_model_is_pinned_separately_from_the_chat_model(self):
        self.assertEqual(settings_from_env({}).model, "gemini-3.8-flash")
        for bad in ("gemini-flash-latest", "gpt-4", "gemini-3.8-flash/../x", ""):
            if bad:
                with self.assertRaises(ValueError, msg=bad): settings_from_env({"KAIRFLOW_GEMINI_JSON_MODEL": bad})
        sess = Sess(reply())
        c = GeminiClient("SECRET", "gemini-2.5-flash", sess, json_model="gemini-3.8-flash")
        res = c.generate_json_ex("i", "u", {"type": "object", "required": ["ok"], "properties": {"ok": {"type": "boolean"}}})
        self.assertTrue(sess.calls[0][0].endswith("/models/gemini-3.8-flash:generateContent")); self.assertEqual(res.model, "gemini-3.8-flash")
        self.assertEqual(sess.calls[0][1]["json"]["generationConfig"]["thinkingConfig"], {"thinkingLevel": "low"})
        self.assertEqual(c.model, "gemini-2.5-flash")                                          # Agent Chat model unchanged until Phase 6

    def test_build_passes_the_pinned_model_to_the_client(self):
        from kairflow_intel import main
        cfg = SimpleNamespace(supabase_url="https://x.supabase.co", supabase_anon_key="a", agent_email="w@x.com", agent_password="p", worker_id="w",
                              ollama_url="http://127.0.0.1:11434", ollama_model="m", ollama_fast_model="f", gemini_api_key="SECRET", gemini_model="gemini-2.5-flash",
                              mail_provider="none", mail_account_id="", user_agent="ua", fetch_timeout=5, max_fetch_bytes=1000, per_host_delay=0.0, ai_router=RouterSettings())
        _, d = main.build(cfg)
        self.assertEqual((d.llm.primary.model, d.llm.primary.json_model), ("gemini-2.5-flash", "gemini-3.8-flash"))


if __name__ == "__main__":
    unittest.main()
