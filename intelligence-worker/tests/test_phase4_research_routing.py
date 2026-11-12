"""Phase 4: research entity extraction and studio re-evaluation run Gemini first with Ollama as the fallback.

What these tests pin down:
  * routing and fallback for both research call sites (one Ollama attempt, no loops, provenance recorded);
  * the model's extraction is stored with provenance (facts.verified.ai_extraction) and nothing else about the prospect changes;
  * the model can never change evidence, scores or decisions, whichever provider answered (so a fallback cannot flip a qualification);
  * drafting, classification and Agent Chat are still not routed.
"""
import unittest
from types import SimpleNamespace

from kairflow_intel import jobs, research, scoring, studio_reeval
from kairflow_intel.ai_types import GeminiPermanent, GeminiTransient, K_AUTH, K_SERVER
from kairflow_intel.airouter import settings_from_env
from kairflow_intel.errors import PermanentError, TransientError
from kairflow_intel.gemini import FallbackLLM
from .test_ai_router import Clock
from .test_phase3_discovery_routing import Gem, Oll, llm

HOME = ('<html lang="en"><body><a href="/works">Works</a><a href="/recruit">Recruit</a>'
        '<p>We are hiring key animators and in-between artists for our 2D anime series.</p><p>info@studio.example</p>'
        '<p>Contact: Hanako Sato, Production Manager. ' + 'We produce hand-drawn 2D animation for television anime and outsource some work. ' * 6 + '</p></body></html>')
WORKS = '<html lang="en"><body><p>We produce 2D animation for television anime.</p><p>We do key animation for client projects.</p></body></html>'
GOOD = {"language": "en", "country_hint": "Japan", "contact_name": "Hanako Sato", "contact_role": "Production Manager"}
HOSTILE = {"language": "ja", "country_hint": "Atlantis", "contact_name": "Invented Person", "contact_role": "CEO"}   # not on the page, wrong language


class Fetch:
    def __init__(self): self.urls = []
    def fetch(self, url):
        self.urls.append(url)
        return (url, HOME if url.endswith("/") or url.endswith("studio.example") else WORKS)


def studio(pid="p1"):
    return {"id": pid, "type": "animation_studio_support", "origin": "discovered", "status": "discovered", "website": "https://studio.example/",
            "domain": "studio.example", "name": "Studio", "contact_email": "", "contact_source_url": "", "facts": {"verified": {}}}


def indie():
    return {"id": "i1", "type": "indie_game_developer", "origin": "discovered", "status": "discovered", "website": "https://indie.example/",
            "domain": "indie.example", "name": "Indie", "contact_email": "", "contact_source_url": "", "language": "en", "facts": {"verified": {}}}


def run(model, prospect=None, run_id=None, site="research.entity"):
    calls = []
    def rpc(name, args):
        calls.append((name, args))
        if name == "intel_agent_indie_suppression_facts":
            return {"suppressed": False, "bounced": False, "complained": False, "suppression_reason": ""}
        return {}
    out = research.research(rpc, Fetch(), research.entity_llm(model, site), {"prospect": prospect or studio()}, run_id=run_id)
    return out, calls


def verified_of(calls, name="intel_agent_upsert_prospect"):
    return next(a for n, a in calls if n == name)["p_verified"]


def evidence_of(calls):
    return [(a["p_fact_type"], a["p_url"], a["p_snippet"]) for n, a in calls if n in ("intel_agent_add_evidence", "intel_agent_reeval_add_evidence")]


class Routing(unittest.TestCase):
    def test_gemini_first_for_both_research_sites_and_success_never_calls_ollama(self):
        for site in ("research.entity", "research.studio_reeval"):
            with self.subTest(site=site):
                g, o = Gem(GOOD), Oll(GOOD)
                data, prov = research.entity_llm(llm(g, o), site)("page text")
                self.assertEqual(data, GOOD)
                self.assertEqual((prov["provider"], prov["model"], prov["site"]), ("gemini", "gemini-3.8-flash", site))
                self.assertNotIn("fallback_reason", prov)
                self.assertEqual((len(g.sent), len(o.sent)), (1, 0))
                self.assertTrue(g.sent[0]["fast"])

    def test_each_failure_kind_causes_exactly_one_ollama_attempt(self):
        for exc in (GeminiTransient("x", K_SERVER), GeminiPermanent("x", K_AUTH)):
            with self.subTest(exc=type(exc).__name__):
                g, o = Gem(exc), Oll(GOOD)
                data, prov = research.entity_llm(llm(g, o), "research.entity")("page text")
                self.assertEqual(data, GOOD)
                self.assertEqual(prov["provider"], "ollama")
                self.assertTrue(prov["fallback_reason"])
                self.assertEqual((len(g.sent), len(o.sent)), (1, 1))

    def test_both_failing_raises_the_existing_error_class_without_looping(self):
        g, o = Gem(GeminiTransient("x", K_SERVER)), Oll(exc=TransientError("ollama down"))
        with self.assertRaises(TransientError):
            research.entity_llm(llm(g, o), "research.entity")("page text")
        self.assertEqual((len(g.sent), len(o.sent)), (1, 1))

    def test_rollback_flag_and_policy_send_research_to_ollama(self):
        for env in ({"KAIRFLOW_AI_FORCE_OLLAMA": "1"}, {"KAIRFLOW_AI_POLICY": "research=ollama"}, {"KAIRFLOW_AI_POLICY": "research.studio_reeval=ollama"}):
            with self.subTest(env=env):
                g, o = Gem(GOOD), Oll(GOOD)
                m = FallbackLLM(g, o, clock=Clock(), settings=settings_from_env(env))
                _, prov = research.entity_llm(m, "research.studio_reeval")("page text")
                self.assertEqual(prov["provider"], "ollama")
                self.assertEqual(len(g.sent), 0)

    def test_private_groups_and_chat_are_still_not_routed(self):
        g, o = Gem(GOOD), Oll(GOOD)
        from kairflow_intel.ai_call import call_json
        for site in ("drafting.initial", "classification.inbound", "chat.plan"):
            self.assertEqual(call_json(llm(g, o), site, "i", "u", {"type": "object"}, fast=True)[1]["provider"], "ollama")
        self.assertEqual(len(g.sent), 0)

    def test_a_plain_ollama_client_still_works_and_is_marked_as_having_no_router(self):
        o = Oll(GOOD)
        data, prov = research.entity_llm(o, "research.entity")("page text")
        self.assertEqual((data, prov["provider"], prov["fallback_reason"]), (GOOD, "ollama", "no_router"))

    def test_only_page_text_and_the_fixed_instruction_are_sent_to_google(self):
        g, o = Gem(GOOD), Oll(GOOD)
        p = studio("secret-prospect-id-123")
        research.research(lambda n, a: {}, Fetch(), research.entity_llm(llm(g, o), "research.entity"), {"prospect": p})
        sent = g.sent[0]
        self.assertEqual(sent["instruction"], research.ENTITY_INSTRUCTION)
        self.assertLessEqual(len(sent["untrusted"]), 9000)
        self.assertNotIn("secret-prospect-id-123", sent["instruction"] + sent["untrusted"])
        self.assertIn("hiring key animators", sent["untrusted"])          # public page text only


class Provenance(unittest.TestCase):
    def test_gemini_extraction_is_recorded_on_the_prospect(self):
        _, calls = run(llm(Gem(GOOD), Oll(GOOD)))
        ai = verified_of(calls)["ai_extraction"]
        self.assertEqual((ai["status"], ai["provider"], ai["model"], ai["site"]), ("ok", "gemini", "gemini-3.8-flash", "research.entity"))

    def test_fallback_is_recorded_with_its_reason_and_the_ollama_model(self):
        cfg = SimpleNamespace(ollama_model="qwen-main", ollama_fast_model="qwen-fast")
        o = Oll(GOOD); o.cfg = cfg
        _, calls = run(llm(Gem(GeminiTransient("x", K_SERVER)), o))
        ai = verified_of(calls)["ai_extraction"]
        self.assertEqual((ai["provider"], ai["model"]), ("ollama", "qwen-fast"))
        self.assertTrue(ai["fallback_reason"])

    def test_both_providers_failing_records_unavailable_and_research_still_completes(self):
        out, calls = run(llm(Gem(GeminiTransient("x", K_SERVER)), Oll(exc=TransientError("down"))))
        self.assertEqual(verified_of(calls)["ai_extraction"], {"status": "unavailable", "error": "TransientError"})
        self.assertGreater(out["signals"], 0)                              # deterministic extraction is unaffected

    def test_studio_reeval_run_records_provenance_through_the_run_scoped_function(self):
        _, calls = run(llm(Gem(GOOD), Oll(GOOD)), run_id="run-1", site="research.studio_reeval")
        self.assertEqual(verified_of(calls, "intel_agent_reeval_record_research")["ai_extraction"]["site"], "research.studio_reeval")
        self.assertFalse(any(n == "intel_agent_upsert_prospect" for n, _ in calls))

    def test_legacy_callable_returning_plain_data_still_works(self):
        calls = []
        research.research(lambda n, a: calls.append((n, a)), Fetch(), lambda text: GOOD, {"prospect": studio()})
        self.assertEqual(verified_of(calls)["ai_extraction"], {"status": "ok", "provider": "unrecorded"})

    def test_provenance_holds_no_secret_or_page_text(self):
        _, calls = run(llm(Gem(GOOD), Oll(GOOD)))
        text = repr(verified_of(calls)["ai_extraction"])
        for needle in ("Hanako", "hiring", "KAIRFLOW", "key"):
            self.assertNotIn(needle, text.replace("model_reported", ""))


class ProviderCannotChangeOutcome(unittest.TestCase):
    """Evidence, scores and decisions come from deterministic signal detection over the page. The provider's answer must not move them,
    so a fallback result cannot change a qualification outcome (which is why Phase 4 needs no separate Needs-Review gate)."""
    PROVIDERS = {
        "gemini": lambda: llm(Gem(GOOD), Oll(GOOD)),
        "ollama_fallback": lambda: llm(Gem(GeminiTransient("x", K_SERVER)), Oll(HOSTILE)),
        "nothing_available": lambda: llm(Gem(GeminiTransient("x", K_SERVER)), Oll(exc=TransientError("down"))),
    }

    def qualify_for(self, prospect, make_model):
        out, calls = run(make_model(), prospect=prospect)
        ev = [{"fact_type": f, "snippet": s, "verified": True, "url": u} for f, u, s in evidence_of(calls)]
        up = next(a for n, a in calls if n == "intel_agent_upsert_prospect")
        p = {**prospect, "facts": {"verified": up["p_verified"]}, "language": up["p_language"], "contact_email": "", "contact_name": up["p_contact_name"]}
        rpc = lambda n, a: {} if n != "intel_agent_set_score" else None
        res = research.qualify(rpc, {"prospect": p, "evidence": ev}, {"qualify_min": 70, "review_min": 50})
        return up, ev, res

    def test_studio_evidence_language_score_and_decision_are_identical_for_every_provider(self):
        got = {k: self.qualify_for(studio(), m) for k, m in self.PROVIDERS.items()}
        base_up, base_ev, base_res = got["gemini"]
        for name, (up, ev, res) in got.items():
            with self.subTest(provider=name):
                self.assertEqual(ev, base_ev)
                self.assertEqual(up["p_language"], base_up["p_language"])
                model_fields = ("ai_extraction", "contact_role")          # the only verified fields the model can fill; contact_role is quote-checked against the page and no scorer reads it
                self.assertEqual({k: v for k, v in up["p_verified"].items() if k not in model_fields}, {k: v for k, v in base_up["p_verified"].items() if k not in model_fields})
                self.assertEqual((res.score, res.decision, res.model, res.suitability), (base_res.score, base_res.decision, base_res.model, base_res.suitability))
                self.assertEqual(res.model, scoring.STUDIO_MODEL)

    def test_indie_path_is_identical_for_every_provider(self):
        got = {k: self.qualify_for(indie(), m) for k, m in self.PROVIDERS.items()}
        _, base_ev, base_res = got["gemini"]
        for name, (_, ev, res) in got.items():
            with self.subTest(provider=name):
                self.assertEqual(ev, base_ev)
                self.assertEqual((res.score, res.decision), (base_res.score, base_res.decision))

    def test_unverified_names_and_roles_from_any_provider_are_dropped(self):
        for make in self.PROVIDERS.values():
            _, calls = run(make())
            up = next(a for n, a in calls if n == "intel_agent_upsert_prospect")
            self.assertNotIn(up["p_contact_name"], ("Invented Person",))
            self.assertNotEqual(up["p_verified"]["contact_role"], "CEO")

    def test_extraction_by_another_provider_never_overwrites_an_older_score(self):
        p = {**studio(), "score": 61, "status": "needs_review", "score_breakdown": [{"model": "studio-v1"}], "facts": {"verified": {"language": "en"}, "estimates": {}}}
        calls = []
        def rpc(n, a): calls.append((n, a)); return {}
        res = research.qualify(rpc, {"prospect": p, "evidence": [{"fact_type": "recruit_page", "snippet": "We are hiring key animators.", "verified": True}]}, {})
        self.assertTrue(res.held)
        self.assertFalse(any(n == "intel_agent_set_score" for n, _ in calls))
        self.assertTrue(any(n == "intel_agent_add_evidence" and a["p_verified"] is False for n, a in calls))


class Handlers(unittest.TestCase):
    def deps_for(self, model, calls, p=None):
        p = p or studio()
        def rpc(name, args):
            calls.append((name, args))
            if name == "intel_agent_context": return {"prospect": p, "evidence": []}
            if name == "intel_agent_sources": return {"site_crawler": {}}
            if name == "intel_agent_source_use": return 1
            return {}
        return jobs.Deps(cfg=SimpleNamespace(worker_id="w"), rpc=rpc, fetcher=Fetch(), zoho=None, llm=model, clock=lambda: 1_800_000_000.0)

    def test_h_research_routes_through_the_router_and_queues_one_follow_up(self):
        calls = []
        g, o = Gem(GeminiTransient("x", K_SERVER)), Oll(GOOD)
        out = jobs.h_research(self.deps_for(llm(g, o), calls), {"payload": {"prospect_id": "p1"}})
        self.assertGreater(out["signals"], 0)
        self.assertEqual((len(g.sent), len(o.sent)), (1, 1))
        self.assertEqual(g.sent[0]["site"], "research.entity")
        self.assertEqual(verified_of(calls)["ai_extraction"]["provider"], "ollama")
        self.assertEqual(sum(n == "intel_agent_upsert_prospect" for n, _ in calls), 1)             # no duplicate prospect on fallback
        enq = [a for n, a in calls if n == "intel_agent_enqueue_job"]
        self.assertEqual([(a["p_kind"], a["p_idempotency_key"]) for a in enq], [("analyze_site", "analyze:p1")])
        self.assertFalse(any(n in ("intel_agent_send", "intel_agent_set_score") for n, _ in calls))   # research alone never scores or sends

    def test_h_research_with_a_working_gemini_never_touches_ollama(self):
        calls = []
        g, o = Gem(GOOD), Oll(GOOD)
        jobs.h_research(self.deps_for(llm(g, o), calls), {"payload": {"prospect_id": "p1"}})
        self.assertEqual((len(g.sent), len(o.sent)), (1, 0))

    def test_h_research_when_both_providers_fail_still_completes_deterministically(self):
        calls = []
        out = jobs.h_research(self.deps_for(llm(Gem(GeminiTransient("x", K_SERVER)), Oll(exc=PermanentError("bad"))), calls), {"payload": {"prospect_id": "p1"}})
        self.assertGreater(out["signals"], 0)
        self.assertEqual(verified_of(calls)["ai_extraction"]["status"], "unavailable")

    def test_studio_reevaluation_uses_the_research_group_and_records_provenance(self):
        calls = []
        started = "2026-11-09T10:00:00+00:00"
        p = {**studio(), "status": "needs_review"}
        def rpc(name, args):
            calls.append((name, args))
            if name == "intel_agent_reeval_context": return {"item": {"state": "queued"}, "prospect": p, "run": {"started_at": started}, "evidence": []}
            if name == "intel_agent_sources": return {"site_crawler": {}}
            if name == "intel_agent_source_use": return 1
            if name == "intel_agent_settings": return {"campaigns": [{"type": "animation_studio_support", "criteria": {}}]}
            if name == "intel_agent_reeval_set_score": return {"ok": True, "status": "needs_review"}
            return {}
        g, o = Gem(GeminiTransient("x", K_SERVER)), Oll(GOOD)
        d = jobs.Deps(cfg=SimpleNamespace(worker_id="w"), rpc=rpc, fetcher=Fetch(), zoho=None, llm=llm(g, o), clock=lambda: 1_800_000_000.0)
        out = studio_reeval._reeval_one(d, {"attempts": 1, "max_attempts": 5}, "run-1", "p1")
        self.assertIn("decision", out)
        self.assertEqual(g.sent[0]["site"], "research.studio_reeval")
        self.assertEqual((len(g.sent), len(o.sent)), (1, 1))
        ai = verified_of(calls, "intel_agent_reeval_record_research")["ai_extraction"]
        self.assertEqual((ai["provider"], ai["site"]), ("ollama", "research.studio_reeval"))
        scored = [a for n, a in calls if n == "intel_agent_reeval_set_score"]
        self.assertEqual(len(scored), 1)
        self.assertEqual(scored[0]["p_estimates"]["scoring_model"], scoring.STUDIO_MODEL)          # the scoring-model version is unchanged


if __name__ == "__main__":
    unittest.main()


class ContactChecks(unittest.TestCase):
    """Names and roles from any provider count only if they are on the page, and a role only if it is written with that person."""
    def go(self, html, name, role):
        class F:
            def fetch(self, u): return (u, html)
        calls = []
        def rpc(n, a): calls.append((n, a)); return {}
        research.research(rpc, F(), lambda t: ({"contact_name": name, "contact_role": role}, {"provider": "gemini"}), {"prospect": studio()})
        up = next(a for n, a in calls if n == "intel_agent_upsert_prospect")
        return up["p_contact_name"], up["p_verified"]["contact_role"], up

    PAD = "We produce 2D animation for television anime and outsource work. " * 6

    def page(self, *lines): return '<html lang="ja"><body>' + "".join(f"<p>{x}</p>" for x in lines) + f"<p>{self.PAD}</p></body></html>"

    def test_short_japanese_names_and_titles_are_accepted(self):
        self.assertEqual(self.go(self.page("佐藤花", "代表"), "佐藤花", "代表")[:2], ("佐藤花", "代表"))
        self.assertEqual(self.go(self.page("田中太　社長"), "田中太", "社長")[:2], ("田中太", "社長"))

    def test_japanese_names_match_with_or_without_a_space_and_in_full_width_forms(self):
        self.assertEqual(self.go(self.page("山田 太郎", "制作担当"), "山田太郎", "制作担当")[:2], ("山田太郎", "制作担当"))
        self.assertEqual(self.go(self.page("山田太郎", "制作担当"), "山田 太郎", "制作担当")[0], "山田 太郎")
        self.assertEqual(self.go(self.page("Taro Yamada, Producer"), "Ｔａｒｏ　Ｙａｍａｄａ", "Producer")[:2], ("Ｔａｒｏ　Ｙａｍａｄａ", "Producer"))

    def test_names_and_roles_that_are_not_on_the_page_are_still_dropped(self):
        self.assertEqual(self.go(self.page("佐藤花", "代表"), "鈴木一", "代表")[0], "")
        self.assertEqual(self.go(self.page("Jo Li"), "Jo", "CEO")[:2], ("", ""))                    # too short to count as evidence

    def test_a_role_written_with_someone_else_is_not_attached_to_the_contact(self):
        html = self.page("Hanako Sato, Intern", "Taro Yamada, CEO")
        self.assertEqual(self.go(html, "Hanako Sato", "CEO")[:2], ("Hanako Sato", ""))              # the name is real; the role is Taro's
        self.assertEqual(self.go(html, "Taro Yamada", "CEO")[:2], ("Taro Yamada", "CEO"))
        self.assertEqual(self.go(html, "Hanako Sato", "Intern")[1], "Intern")

    def test_a_role_on_the_neighbouring_line_counts_when_the_line_holds_only_the_name(self):
        self.assertEqual(self.go(self.page("Hanako Sato", "Production Manager"), "Hanako Sato", "Production Manager")[1], "Production Manager")
        self.assertEqual(self.go(self.page("Production Manager", "Hanako Sato"), "Hanako Sato", "Production Manager")[1], "Production Manager")
        self.assertEqual(self.go(self.page("Hanako Sato", "Taro Yamada, CEO"), "Hanako Sato", "CEO")[1], "CEO")   # known limit: a bare-name line takes the next line's role

    def test_the_model_is_asked_only_for_the_contact_and_no_country_is_sent_on(self):
        self.assertEqual(set(research.ENTITY_SCHEMA["properties"]), {"contact_name", "contact_role"})
        self.assertNotIn("country", research.ENTITY_INSTRUCTION.lower())
        _, _, up = self.go(self.page("佐藤花"), "佐藤花", None)
        self.assertEqual(up["p_country"], "")

    def test_a_reevaluation_that_finds_the_prospect_ineligible_closes_its_run_item(self):
        calls = []
        def rpc(name, args):
            calls.append(name)
            if name == "intel_agent_reeval_context":
                p = {**studio(), "status": "contacted"}
                return {"item": {"state": "queued"}, "prospect": p, "run": {"started_at": "2026-11-09T00:00:00Z"}}
            return {}
        out = studio_reeval._reeval_one(SimpleNamespace(rpc=rpc), {"attempts": 1}, "r1", "p1")
        self.assertEqual(out, {"skipped": "status_changed"}); self.assertIn("intel_agent_reeval_skip_item", calls)
