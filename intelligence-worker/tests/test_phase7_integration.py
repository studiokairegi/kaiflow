"""Phase 7: whole-system verification of the Gemini-first routing (Phases 2-6). Providers are mocked; no network, no real key.

Every REAL call site is driven through the real handler (news scan, research, initial draft, reply draft, takeover, classification,
Agent Chat), all behind ONE shared router, so these tests prove how the pieces behave together rather than one at a time:
  * every group tries Gemini first and falls back to Ollama on its own, and one failing pipeline never breaks another;
  * both providers down surfaces the worker's existing error classes, and the worker retry system treats them as before;
  * the rollback flag sends every call site to Ollama end to end, loaded through the real configuration path;
  * nothing the AI layer does can send, change autonomy or the kill switch, or leak a secret;
  * configuration, documentation and call-site coverage cannot drift apart silently.
"""
import contextlib
import io
import json
import logging
import re
import unittest
from pathlib import Path

import requests

from kairflow_intel import chat, config as cfgmod, jobs, main
from kairflow_intel.ai_types import AIResult, GeminiPermanent, GeminiTransient, K_AUTH, K_RATE_DAILY, K_SCHEMA, K_SERVER
from kairflow_intel.airouter import settings_from_env, DEFAULT_POLICY
from kairflow_intel.errors import PermanentError, TransientError
from kairflow_intel.gemini import FallbackLLM, GeminiClient
from .helpers import CFG
from .test_ai_router import Clock, FakeOllama, MODEL, Sess, reply
from .test_phase3_discovery_routing import NEWS_OUT, run_news
from .test_phase4_research_routing import GOOD, run as run_research
from .test_phase5_drafting_routing import COMPOSE, REPLY, LABEL, run_initial, run_reply, run_takeover, names
from .test_phase6_routing import run_classify
from .test_v1 import ChatRpc, deps
from . import test_takeover as tk

WORKER = Path(__file__).resolve().parent.parent
PKG = WORKER / "kairflow_intel"
SECRET = "AIzaSyINTEGRATIONSECRET0123456789"
PRIVATE_GROUPS = frozenset({"drafting", "classification", "chat"})      # restated on purpose: a change to the router constant must fail these tests
PLAN = {"action": "reply", "reply": "Chat answer."}
ANALYSIS = {"summary": "No reply yet.", "intent": "no_response", "open_questions": [], "language": "en"}
PARAGRAPH = {"paragraph": "Following our note about character animation for Pixel Moon, I wanted to check whether the timing suits your team."}


def answer(schema, untrusted):
    """One answer table for every site, chosen by the shape of the schema the call site asked for."""
    p = schema.get("properties", {})
    if "items" in p: return NEWS_OUT
    if "contact_name" in p: return GOOD
    if "label" in p: return LABEL
    if "intent" in p: return ANALYSIS
    if "paragraph" in p: return PARAGRAPH
    if "evidence_ids" in p: return REPLY if "in1" in untrusted else COMPOSE
    if "action" in p: return PLAN
    return {"ok": True}


class Prov:
    """Stand-in for either provider. `fail_for` maps a site prefix to the exception Gemini raises there; `exc` fails every call."""
    def __init__(self, name, exc=None, fail_for=None):
        self.name, self.exc, self.fail_for, self.sent, self.model = name, exc, fail_for or {}, [], MODEL
    cfg = FakeOllama.cfg
    def _maybe_fail(self, site):
        if self.exc: raise self.exc
        for prefix, e in self.fail_for.items():
            if site.startswith(prefix): raise e
    # Gemini side
    def generate_json_ex(self, instruction, untrusted, schema, *, fast=False, site="unspecified", timeout=60):
        self.sent.append(site); self._maybe_fail(site)
        return AIResult(data=answer(schema, untrusted), provider="gemini", model=MODEL, model_reported=MODEL, site=site, finish_reason="STOP")
    def chat_json_ex(self, system, messages, schema, *, timeout=45, site="chat.plan"):
        self.sent.append(site); self._maybe_fail(site)
        return AIResult(data=answer(schema, ""), provider="gemini", model=MODEL, model_reported=MODEL, site=site, finish_reason="STOP")
    # Ollama side
    def generate_json(self, instruction, untrusted, schema, **kw):
        self.sent.append(kw.get("site", "ollama")); self._maybe_fail("ollama")
        return answer(schema, untrusted)
    def chat_json(self, system, messages, schema, **kw):
        self.sent.append("chat"); self._maybe_fail("ollama")
        return answer(schema, "")
    def is_up(self): return True


def build(g, o, d1="A", policy="default=gemini_first", **env):
    e = {"KAIRFLOW_AI_D1": d1, "KAIRFLOW_AI_POLICY": policy, **env}
    return FallbackLLM(g, o, clock=Clock(), settings=settings_from_env(e))


class Seen:
    """Wraps a model so every call's provenance (provider, reason, site) is recorded, whichever handler made it."""
    def __init__(self, llm):
        self.llm, self.results = llm, []
    def __getattr__(self, n): return getattr(self.llm, n)
    def generate_json_ex(self, site, *a, **k):
        r = self.llm.generate_json_ex(site, *a, **k); self.results.append(r); return r
    def chat_json_ex(self, site, *a, **k):
        r = self.llm.chat_json_ex(site, *a, **k); self.results.append(r); return r
    def chat_json(self, *a, **k):
        r = self.llm.chat_json_ex("chat.plan", *a, **k); self.results.append(r); return r.data
    def by_site(self):                      # first result per site (a handler may call the same site more than once)
        out = {}
        for r in self.results: out.setdefault(r.site, r)
        return out


def run_chat(model):
    rpc = ChatRpc()
    out = chat.handle(deps(rpc, model), {"thread_id": "t", "message_id": 1})
    return out, rpc


def run_takeover_followup(model):
    c = tk.ctx([tk.OUT1], last_contact="2026-10-05")
    from .test_logic import EV
    c["evidence"] = EV
    return run_takeover(c, model)


# Every real call site, driven through its real handler. Each runner returns (output, rpc calls) so safety checks can read what was written.
RUNNERS = {
    "discovery.news": lambda m: (run_news(m)[1], []),
    "research.entity": lambda m: run_research(m),
    "drafting.initial": lambda m: run_initial(m),
    "drafting.reply": lambda m: run_reply(m)[:2],
    "drafting.takeover_followup": lambda m: (lambda out, rpc: (out, rpc.calls))(*run_takeover_followup(m)),
    "classification.inbound": lambda m: run_reply(m)[:2],
    "chat.plan": lambda m: (lambda out, rpc: (out, rpc.calls))(*run_chat(m)),
}
GROUP_OF = lambda site: site.split(".", 1)[0]


class EverySiteTogether(unittest.TestCase):
    def test_default_policy_d1_a_public_groups_and_chat_use_gemini_private_groups_never_do(self):
        g, o = Prov("g"), Prov("o")
        m = Seen(build(g, o, "A"))
        for site, run in RUNNERS.items(): run(m)
        got = {s: (r.provider, r.route_reason) for s, r in m.by_site().items()}
        for site in RUNNERS:
            with self.subTest(site=site):
                if GROUP_OF(site) in PRIVATE_GROUPS: self.assertEqual(got[site], ("ollama", "d1_private"))
                else: self.assertEqual(got[site], ("gemini", None))
        self.assertTrue(PRIVATE_GROUPS.isdisjoint({GROUP_OF(s) for s in g.sent}), "private groups must never reach the Gemini client under D1=A")

    def test_d1_c_every_call_site_tries_gemini_first_and_success_never_calls_ollama(self):
        g, o = Prov("g"), Prov("o")
        m = Seen(build(g, o, "C"))
        for site, run in RUNNERS.items(): run(m)
        self.assertEqual(sorted(g.sent), sorted(r.site for r in m.results))      # one Gemini request per model call, none repeated
        self.assertTrue(set(RUNNERS) <= {r.site for r in m.results})
        self.assertEqual(o.sent, [])
        self.assertTrue(all(r.provider == "gemini" and r.model == MODEL for r in m.results))

    def test_each_group_falls_back_to_ollama_alone_and_the_others_keep_using_gemini(self):
        for failing in RUNNERS:
            with self.subTest(failing=failing):
                g = Prov("g", fail_for={failing: GeminiTransient("x", K_SCHEMA)})      # schema-invalid: opens no cooldown, so it can only hit this site
                o = Prov("o")
                m = Seen(build(g, o, "C"))
                for site, run in RUNNERS.items(): run(m)
                fell_back = [r for r in m.results if r.provider == "ollama"]
                self.assertTrue(fell_back)
                self.assertTrue(all(r.site == failing and r.route_reason == K_SCHEMA for r in fell_back), "only the failing site may fall back")
                self.assertEqual(len(o.sent), len(fell_back), "exactly one Ollama attempt per failed Gemini call")
                self.assertTrue(all(r.provider == "gemini" for r in m.results if r.site != failing), "every other site keeps using Gemini")

    def test_daily_exhaustion_is_shared_so_later_sites_skip_gemini_and_still_complete(self):
        g = Prov("g", fail_for={"discovery": GeminiTransient("x", K_RATE_DAILY)}); o = Prov("o")
        m = Seen(build(g, o, "C"))
        for site, run in RUNNERS.items(): out = run(m)
        by = m.by_site()
        self.assertEqual(g.sent, ["discovery.news"], "after daily exhaustion no later call may pay a Gemini attempt")
        self.assertEqual((by["discovery.news"].provider, by["discovery.news"].route_reason), ("ollama", K_RATE_DAILY))
        for site in RUNNERS:
            if site != "discovery.news": self.assertEqual((by[site].provider, by[site].route_reason), ("ollama", "gemini_cooldown_daily"))

    def test_permanent_error_pauses_gemini_for_everyone_with_one_attempt_total(self):
        g = Prov("g", exc=GeminiPermanent("bad key", K_AUTH)); o = Prov("o")
        m = Seen(build(g, o, "C"))
        for site, run in RUNNERS.items(): run(m)
        self.assertEqual(len(g.sent), 1)
        self.assertTrue(all(r.provider == "ollama" for r in m.results))

    def test_a_transient_failure_does_not_stay_attached_to_the_next_operation(self):
        g = Prov("g", fail_for={"research": GeminiTransient("x", K_SERVER)}); o = Prov("o")
        m = Seen(build(g, o, "C"))
        run_research(m)
        first = m.results[-1]
        self.assertEqual((first.provider, first.route_reason), ("ollama", K_SERVER))
        run_news(m)
        self.assertEqual(m.results[-1].provider, "gemini")               # one 5xx is below the outage threshold: no pause

    def test_both_providers_down_drafting_raises_transient_so_the_job_retries(self):
        g, o = Prov("g", exc=GeminiTransient("x", K_SERVER)), Prov("o", exc=TransientError("ollama down"))
        with self.assertRaises(TransientError):
            RUNNERS["drafting.initial"](build(g, o, "C", "drafting=gemini_first"))
        self.assertEqual((len(g.sent), len(o.sent)), (1, 1), "one attempt on each provider, no loop")

    def test_both_providers_down_with_a_permanent_ollama_error_sends_drafting_to_manual_review_with_no_draft(self):
        g, o = Prov("g", exc=GeminiTransient("x", K_SERVER)), Prov("o", exc=PermanentError("no model"))
        out, calls = RUNNERS["drafting.initial"](build(g, o, "C", "drafting=gemini_first"))
        self.assertEqual(out, {"skipped": "manual_review_required"})
        self.assertIn("intel_agent_flag_prospect", names(calls)); self.assertNotIn("intel_agent_upsert_draft", names(calls))

    def test_both_providers_down_research_degrades_without_inventing_anything(self):
        g, o = Prov("g", exc=GeminiTransient("x", K_SERVER)), Prov("o", exc=TransientError("down"))
        out, calls = RUNNERS["research.entity"](build(g, o, "C"))
        self.assertEqual((len(g.sent), len(o.sent)), (1, 1))
        verified = next(a["p_verified"] for n, a in calls if n == "intel_agent_upsert_prospect")
        self.assertEqual(verified["ai_extraction"]["status"], "unavailable")
        self.assertFalse(verified.get("contact_name"), "no model output means no model-derived contact is stored")

    def test_chat_has_its_deterministic_fallback_and_classification_retries_when_both_are_down(self):
        out, rpc = RUNNERS["chat.plan"](build(Prov("g", exc=GeminiTransient("x", K_SERVER)), Prov("o", exc=TransientError("down")), "C"))
        self.assertTrue(out.get("unparsed") or out.get("fallback"))
        # Classification: an outage of both providers retries the job (the message stays pending) instead of saving a keyword guess for good.
        with self.assertRaises(TransientError):
            run_classify(build(Prov("g", exc=GeminiTransient("x", K_SERVER)), Prov("o", exc=TransientError("down")), "C", "classification=gemini_first"))


class WorkerRetries(unittest.TestCase):
    """The worker's retry system sees the same error classes it always did."""

    def _tick(self, model):
        calls = []
        job = {"id": "j1", "kind": "draft", "attempts": 1, "max_attempts": 5, "payload": {"prospect_id": "p1", "kind": "initial"}, "lease_token": None}
        from .test_phase5_drafting_routing import P, EV, KB_LIST, SETTINGS
        ctx = {"prospect": {**P, "status": "lead_linked", "contact_email": "rina@pixelmoon.com"}, "evidence": EV, "lead": {}, "messages": []}
        def rpc(name, p=None):
            calls.append((name, p or {}))
            return {"intel_agent_claim_job": job, "intel_agent_context": ctx, "intel_agent_settings": {**SETTINGS, "autonomy": "shadow"},
                    "intel_agent_kb": KB_LIST, "intel_agent_recent_outbound": [], "intel_agent_complete_job": True,
                    "intel_agent_upsert_draft": {"ok": True, "message_id": "m1", "state": "pending_approval", "created": True}}.get(name, {})
        d = jobs.Deps(cfg=CFG, rpc=rpc, fetcher=None, zoho=None, llm=model, clock=lambda: 1_800_000_000.0)
        w = jobs.Worker(d, lease_thread=False); w._hb = d.clock()
        w.tick()
        return calls

    def test_both_down_marks_the_job_failed_with_a_retry_delay_and_completes_nothing(self):
        g, o = Prov("g", exc=GeminiTransient("x", K_SERVER)), Prov("o", exc=TransientError("down"))
        calls = self._tick(build(g, o, "C", "drafting=gemini_first"))
        fails = [a for n, a in calls if n == "intel_agent_fail_job"]
        self.assertEqual(len(fails), 1)
        self.assertTrue(fails[0]["p_error"].startswith("transient"))
        self.assertGreater(fails[0]["p_retry_seconds"], 0)
        self.assertNotIn("intel_agent_complete_job", names(calls)); self.assertNotIn("intel_agent_upsert_draft", names(calls))

    def test_gemini_failure_alone_completes_the_job_once_with_one_draft(self):
        g, o = Prov("g", exc=GeminiTransient("x", K_SERVER)), Prov("o")
        calls = self._tick(build(g, o, "C", "drafting=gemini_first"))
        self.assertEqual(names(calls).count("intel_agent_upsert_draft"), 1)
        self.assertEqual(names(calls).count("intel_agent_complete_job"), 1)
        self.assertNotIn("intel_agent_fail_job", names(calls))


class RollbackEndToEnd(unittest.TestCase):
    ENV = {"KAIRFLOW_SUPABASE_URL": "https://p.supabase.co", "KAIRFLOW_SUPABASE_ANON_KEY": "anon", "KAIRFLOW_AGENT_EMAIL": "a@b.c",
           "KAIRFLOW_AGENT_PASSWORD": "pw-not-real", "KAIRFLOW_GEMINI_API_KEY": SECRET, "KAIRFLOW_AI_D1": "C", "KAIRFLOW_AI_POLICY": "default=gemini_first"}

    def test_flag_loaded_through_the_real_config_path_sends_every_call_site_to_ollama(self):
        cfg = cfgmod.load({**self.ENV, "KAIRFLOW_AI_FORCE_OLLAMA": "1"})
        self.assertTrue(cfg.ai_router.force_ollama)
        g, o = Prov("g"), Prov("o")
        m = Seen(FallbackLLM(g, o, clock=Clock(), settings=cfg.ai_router))
        for site, run in RUNNERS.items(): run(m)
        self.assertEqual(g.sent, [], "with the rollback flag set Google must receive nothing")
        self.assertTrue(all(r.provider == "ollama" and r.route_reason == "forced_ollama" for r in m.results))

    def test_same_environment_without_the_flag_does_use_gemini(self):
        cfg = cfgmod.load(self.ENV)
        self.assertFalse(cfg.ai_router.force_ollama)
        g, o = Prov("g"), Prov("o")
        m = Seen(FallbackLLM(g, o, clock=Clock(), settings=cfg.ai_router))
        for site, run in RUNNERS.items(): run(m)
        self.assertEqual(len(g.sent), len(m.results))
        self.assertGreaterEqual(len(g.sent), len(RUNNERS))

    def test_flag_beats_every_policy_and_every_d1_setting(self):
        for d1 in ("A", "C"):
            for policy in ("default=gemini_first", "discovery=gemini_first,research=gemini_first,chat=gemini_first"):
                with self.subTest(d1=d1, policy=policy):
                    g, o = Prov("g"), Prov("o")
                    m = build(g, o, d1, policy, KAIRFLOW_AI_FORCE_OLLAMA="true")
                    for run in RUNNERS.values(): run(m)
                    self.assertEqual(g.sent, [])


class SafetyBoundaries(unittest.TestCase):
    ALL_GEMINI = dict(d1="C", policy="default=gemini_first")

    def test_running_every_call_site_never_sends_changes_autonomy_or_touches_the_kill_switch(self):
        forbidden = re.compile(r"^intel_admin_|^intel_agent_(mark_sending|confirm_send|reserve_send|fail_send|acquire_send_slot|record_resend|chat_propose|flag_suppress|add_suppress)")
        for label, (g, o) in (("gemini_ok", (Prov("g"), Prov("o"))), ("fallback", (Prov("g", exc=GeminiTransient("x", K_SERVER)), Prov("o")))):
            m = build(g, o, **self.ALL_GEMINI)
            for site, run in RUNNERS.items():
                with self.subTest(label=label, site=site):
                    _, calls = run(m)
                    writes = [n for n, _ in calls if forbidden.search(n)]
                    self.assertEqual(writes, [])
                    enq = [a for n, a in calls if n == "intel_agent_enqueue_job"]
                    self.assertFalse([e for e in enq if str(e.get("p_kind", "")) == "send"], "no send job may be queued by any AI-driven handler")

    def test_drafts_made_by_either_provider_stay_pending_approval(self):
        for label, g in (("gemini", Prov("g")), ("fallback", Prov("g", exc=GeminiTransient("x", K_SERVER)))):
            with self.subTest(label=label):
                out, calls = run_initial(build(g, Prov("o"), "C", "drafting=gemini_first"))
                self.assertEqual(out["state"], "pending_approval")
                up = [a for n, a in calls if n == "intel_agent_upsert_draft"]
                self.assertEqual(len(up), 1)

    def test_the_ai_layer_has_no_path_to_sending_or_to_settings_writes(self):
        for f in ("airouter.py", "gemini.py", "ai_call.py", "ai_types.py"):
            src = (PKG / f).read_text(encoding="utf-8")
            with self.subTest(file=f):
                self.assertNotRegex(src, r"\brpc\b|intel_agent_|kill_switch|autonomy|\.send\(|mailops|zoho|resend")

    def test_a_model_that_asks_for_sending_or_autonomy_only_ever_gets_a_prepared_proposal(self):
        class ProposeRpc(ChatRpc):
            def __call__(self, name, p=None):
                if name == "intel_agent_chat_propose": self.calls.append((name, p or {})); return {"ok": True, "summary": "prepared"}
                return super().__call__(name, p)
        for tool, args in (("enable_sending", {}), ("set_autonomy", {"autonomy": "autonomous"}), ("approve_messages", {"message_ids": []})):
            with self.subTest(tool=tool):
                class Evil(Prov):
                    def chat_json_ex(self, system, messages, schema, **kw):
                        return AIResult(data={"action": "tool", "tool": tool, "args": args}, provider="gemini", model=MODEL, site="chat.plan")
                rpc = ProposeRpc()
                chat.handle(deps(rpc, build(Evil("g"), Prov("o"), **self.ALL_GEMINI)), {"thread_id": "t", "message_id": 1})
                called = [n for n, _ in rpc.calls]
                self.assertEqual([n for n in called if n.startswith("intel_admin_")], [], "the model can never run an admin setting")
                self.assertEqual(rpc.tools_called(), [], "a proposal is never executed as a tool")

    def test_a_forbidden_tool_name_is_refused(self):
        class Evil(Prov):
            def chat_json_ex(self, system, messages, schema, **kw):
                return AIResult(data={"action": "tool", "tool": "send_email", "args": {"to": "x@y.z"}}, provider="gemini", model=MODEL, site="chat.plan")
        rpc = ChatRpc()
        chat.handle(deps(rpc, build(Evil("g"), Prov("o"), **self.ALL_GEMINI)), {"thread_id": "t", "message_id": 1})
        self.assertEqual(rpc.tools_called(), [])

    def test_repo_defaults_keep_sending_off_and_autonomy_shadow(self):
        sql = "\n".join(p.read_text(encoding="utf-8", errors="ignore") for p in (WORKER.parent / "supabase" / "migrations").glob("*intelligence_core_tables.sql"))
        self.assertRegex(sql, r"kill_switch boolean not null default true")
        self.assertRegex(sql, r"autonomy text not null default 'shadow'")


class NoSecretsAnywhere(unittest.TestCase):
    def _failures(self):
        from .helpers import Resp
        yield Sess(Resp(403, b'{"error":{"message":"key ' + SECRET.encode() + b' rejected"}}', {"Content-Type": "application/json"}))
        yield Sess(Resp(429, b'{"error":{"message":"quota ' + SECRET.encode() + b'"}}', {"Content-Type": "application/json", "Retry-After": "7"}))
        yield Sess(Resp(500, SECRET.encode(), {}))
        yield Sess(requests.ConnectionError(f"https://generativelanguage.googleapis.com/x?key={SECRET}"))
        yield Sess(requests.Timeout(f"read timed out key={SECRET}"))
        yield Sess(reply('{"label": "posi', finish="MAX_TOKENS"))
        yield Sess(reply("not json at all " + SECRET))

    def test_no_log_line_exception_provenance_or_status_ever_contains_the_key(self):
        blob = []
        class Cap(logging.Handler):
            def emit(self, rec): blob.append(rec.getMessage())
        h = Cap(); root = logging.getLogger(); root.addHandler(h); old = root.level; root.setLevel(logging.DEBUG)
        try:
            for sess in self._failures():
                m = Seen(build(GeminiClient(SECRET, MODEL, sess), Prov("o"), "C"))
                for site, run in RUNNERS.items():
                    try: run(m)
                    except Exception as exc: blob.append(str(exc)); blob.append(repr(exc))
                blob.append(json.dumps([vars(r) for r in m.results], default=str))
                blob.append(json.dumps(m.llm.ai_status(), default=str))
        finally:
            root.removeHandler(h); root.setLevel(old)
        self.assertTrue(blob)
        self.assertNotIn(SECRET, "\n".join(blob))

    def test_router_status_holds_no_key(self):
        st = json.dumps(build(GeminiClient(SECRET, MODEL), Prov("o"), "C").ai_status(), default=str)
        self.assertNotIn(SECRET, st)


class ConfigurationAndDocs(unittest.TestCase):
    def test_defaults_are_the_safe_ones(self):
        s = settings_from_env({})
        self.assertEqual((s.d1, s.force_ollama, s.model, s.thinking), ("A", False, "gemini-3.8-flash", "low"))
        self.assertEqual(s.policy, DEFAULT_POLICY)
        self.assertEqual(set(DEFAULT_POLICY), {"discovery", "research"})              # drafting, classification, health stay off Gemini by default
        self.assertEqual(cfgmod.Config.__dataclass_fields__["gemini_model"].default, "gemini-3.8-flash")

    def test_floating_aliases_and_the_unsupported_thinking_level_are_refused(self):
        for bad in ({"KAIRFLOW_GEMINI_JSON_MODEL": "gemini-flash-latest"}, {"KAIRFLOW_GEMINI_THINKING": "minimal"}, {"KAIRFLOW_AI_D1": "B"}, {"KAIRFLOW_AI_POLICY": "billing=gemini_first"}):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError): settings_from_env(bad)

    def test_no_paid_or_billing_path_exists_in_the_code(self):
        for f in PKG.glob("*.py"):
            src = f.read_text(encoding="utf-8")
            with self.subTest(file=f.name):
                self.assertNotRegex(src, r"(?i)enable[_ ]billing|cloudbilling|serviceusage")

    def test_every_ai_environment_variable_the_code_reads_is_documented_in_env_example(self):
        env_doc = (WORKER / ".env.example").read_text(encoding="utf-8")
        read = set()
        for f in ("airouter.py", "config.py", "gemini.py", "main.py"):
            read |= set(re.findall(r"KAIRFLOW_(?:AI|GEMINI)_[A-Z0-9_]+", (PKG / f).read_text(encoding="utf-8")))
        read.discard("KAIRFLOW_GEMINI_")
        missing = sorted(v for v in read if v not in env_doc)
        self.assertEqual(missing, [])

    def test_env_example_and_readme_contain_no_credentials(self):
        for f in (WORKER / ".env.example", WORKER / "README.md"):
            text = f.read_text(encoding="utf-8")
            with self.subTest(file=f.name):
                self.assertNotRegex(text, r"AIza[0-9A-Za-z_\-]{20,}")
                self.assertNotRegex(text, r"(?im)^KAIRFLOW_(GEMINI_API_KEY|AGENT_PASSWORD)[ \t]*=[ \t]*\S+")

    def test_readme_documents_model_policy_rollback_and_d1(self):
        text = (WORKER / "README.md").read_text(encoding="utf-8")
        for needle in ("gemini-3.8-flash", "KAIRFLOW_AI_FORCE_OLLAMA", "KAIRFLOW_AI_D1", "KAIRFLOW_AI_POLICY"):
            with self.subTest(needle=needle): self.assertIn(needle, text)


class CallSiteCoverage(unittest.TestCase):
    """Guards against a new or forgotten AI call that bypasses the router."""

    def test_no_model_call_outside_the_router_and_the_clients(self):
        allowed = {"airouter.py", "gemini.py", "ollama.py", "ai_call.py"}
        raw = re.compile(r"\.(generate_json|chat_json)\(")
        offenders = []
        for f in PKG.glob("*.py"):
            if f.name in allowed: continue
            for i, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
                if raw.search(line) and "site=" not in line and "chat_json_ex" not in line:
                    offenders.append(f"{f.name}:{i}")
        self.assertEqual([o.split(":")[0] for o in offenders], ["chat.py", "chat.py"],      # file and count, not line numbers: edits above them must not break this
                         "only Agent Chat may call chat_json directly (the call and its one retry), and it is routed as chat.plan by FallbackLLM")

    def test_every_site_in_the_selftest_list_is_used_by_a_real_call_site(self):
        code = "\n".join(f.read_text(encoding="utf-8") for f in PKG.glob("*.py") if f.name != "main.py")
        for site in main.ROUTED_SITES:
            with self.subTest(site=site): self.assertIn(site if site != "chat.plan" else "chat.plan", code)

    def test_every_group_in_the_router_has_a_real_call_site(self):
        used = {GROUP_OF(s) for s in main.ROUTED_SITES}
        self.assertEqual(used, {"discovery", "research", "drafting", "classification", "chat"})


if __name__ == "__main__":
    unittest.main()
