from __future__ import annotations

import signal
import sys
import os
import threading

from . import config as cfgmod
from .jobs import Deps, Worker
from .ollama import OllamaClient
from .gemini import FallbackLLM, GeminiClient
from .safety import Fetcher
from .supa import SupabaseAgent
from .apis import ApiClient
from .mail_disabled import DisabledMail
from .providers import build_registry, ProviderNotInstalled
from .providers.router import DynamicProviderRouter
from .worker_lock import WorkerAlreadyRunning, WorkerProcessLock


def build(cfg):
    supa = SupabaseAgent(cfg)
    # `Deps.zoho` is a historical dependency name; it now holds an adapter
    # created by the installed-provider registry. The provider key selects code,
    # while account_id selects one connection record; no provider branch lives here.
    if cfg.mail_provider == "none":
        mail = DisabledMail()  # safe default: no provider client or token request
    else:
        registry = build_registry()
        try:
            mail = registry.create(cfg.mail_provider, cfg=cfg, supa=supa,
                                   account_id=getattr(cfg, "mail_account_id", "") or None)
        except ProviderNotInstalled as exc:
            raise cfgmod.ConfigError(str(exc)) from exc
    zoho = DynamicProviderRouter(cfg, supa, fallback=mail)
    llm = OllamaClient(cfg)
    if getattr(cfg, "gemini_api_key", ""):
        llm = FallbackLLM(GeminiClient(cfg.gemini_api_key, getattr(cfg, "gemini_model", "")), llm)   # chat planning only; see gemini.py
    return supa, Deps(cfg=cfg, rpc=supa.rpc, fetcher=Fetcher(cfg), zoho=zoho, llm=llm, api=ApiClient(cfg))


def selftest(cfg, what: str) -> int:
    supa, d = build(cfg)
    ok = True
    def line(name, good, extra=""):
        nonlocal ok
        ok &= bool(good)
        print(("PASS " if good else "FAIL ") + name + (f": {extra}" if extra else ""))
    if what in ("all", "ollama"):
        try:
            installed = set(d.llm.list_models())
            line("ollama reachable on loopback", True)
            required = [(cfg.ollama_model, False), (cfg.ollama_fast_model, True)]
            seen = set()
            for model, fast in required:
                if model in seen:
                    continue
                seen.add(model)
                present = model in installed
                line(f"Ollama model installed: {model}", present)
                if present:
                    try:
                        schema = {"type": "object", "required": ["ok"], "properties": {"ok": {"type": "boolean"}}}
                        out = d.llm.generate_json("Return exactly {\"ok\":true}.", "health check only", schema, fast=fast, timeout=90)
                        line(f"Ollama structured output: {model}", out.get("ok") is True)
                    except Exception as exc:
                        line(f"Ollama structured output: {model}", False, str(exc)[:180])
        except Exception as exc:
            line("ollama reachable on loopback", False, str(exc)[:180])
    if what in ("all", "gemini"):
        if not getattr(cfg, "gemini_api_key", ""):
            print("SKIP gemini: KAIRFLOW_GEMINI_API_KEY not set (Agent Chat uses Ollama only)")
        else:
            try:
                schema = {"type": "object", "required": ["ok"], "properties": {"ok": {"type": "boolean"}}}
                out = d.llm.primary.chat_json("Return exactly {\"ok\":true}.", [{"role": "user", "content": "health check only"}], schema)
                line(f"Gemini structured output: {cfg.gemini_model}", out.get("ok") is True)
            except Exception as exc:
                line(f"Gemini structured output: {cfg.gemini_model}", False, str(exc)[:180])
    if what in ("all", "supabase"):
        try:
            st = d.rpc("intel_agent_settings", {})
            line("agent sign-in and settings", True, f"autonomy={st['autonomy']} sending={'OFF' if st['kill_switch'] else 'ON'}")
            # A deliberately nonexistent UUID exercises PostgREST function resolution and the
            # new 11th p_force_review argument. The SQL function must stop at its prospect
            # lookup, before any INSERT; this is a read-only schema/signature probe.
            from .errors import RpcError
            probe_id = "00000000-0000-4000-8000-000000000001"
            try:
                d.rpc("intel_agent_upsert_draft", {
                    "p_prospect_id": probe_id, "p_kind": "initial", "p_step": 0,
                    "p_subject": "", "p_body": "", "p_idempotency_key": "preflight:no-write",
                    "p_to_email": "", "p_auto_ok": False, "p_in_reply_to": None,
                    "p_references": None, "p_force_review": True,
                })
                line("draft RPC exposes p_force_review", False, "probe unexpectedly reached a result")
            except RpcError as exc:
                if "prospect not found" in str(exc).lower():
                    line("draft RPC exposes p_force_review", True, "11-argument signature resolved; no record written")
                else:
                    line("draft RPC exposes p_force_review", False, f"RPC rejected probe ({exc.code}): {str(exc)[:150]}")
        except Exception as exc:
            line("agent sign-in and settings", False, str(exc)[:180])
    if what in ("all", "mail", "zoho", "gmail", "resend"):
        label = f"{cfg.mail_provider} mailbox"
        if what in ("zoho", "gmail", "resend") and what != cfg.mail_provider:
            line(label, False, f"KAIRFLOW_MAIL_PROVIDER is {cfg.mail_provider}, not {what}")
        else:
            try:  # read-only: reads labels/folders and the newest inbox entry, never sends
                good, detail = d.zoho.check()
                line(label + " readable", good, detail)
            except Exception as exc:
                line(label + " readable", False, str(exc))
    return 0 if ok else 1


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    cmd = argv[0] if argv else "run"
    if cmd not in ("run", "once", "selftest", "reeval-studio"):
        print(f"unknown command: {cmd}")
        return 2

    if cmd in ("selftest", "reeval-studio"):
        try:
            cfg = cfgmod.load()
        except cfgmod.ConfigError as exc:
            print(f"configuration error: {exc}")
            return 2
        if cmd == "selftest":
            return selftest(cfg, argv[1] if len(argv) > 1 else "all")
        from . import studio_reeval
        return studio_reeval.cli(SupabaseAgent(cfg).rpc, argv[1:])

    log_path = os.environ.get("KAIRFLOW_WORKER_LOG_FILE", "").strip()
    try:
        lock = WorkerProcessLock()
        lock.acquire()
    except WorkerAlreadyRunning as exc:
        print(f"[worker] {exc}")
        return 73
    try:
        if log_path:
            from .logging_setup import configure_rotating_logs
            configure_rotating_logs(log_path)
        try:
            cfg = cfgmod.load()
        except cfgmod.ConfigError as exc:
            print(f"configuration error: {exc}")
            return 2
        _, deps = build(cfg)
        worker = Worker(deps)
        if cmd == "once":      # drain the queue once (useful for testing)
            while worker.tick():
                pass
            return 0
        stop = threading.Event()
        for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
            if hasattr(signal, name):
                signal.signal(getattr(signal, name), lambda *_: stop.set())
        print(f"KairFlow Intelligence worker {cfg.worker_id} started")
        worker.run_forever(stop)
        return 0
    finally:
        lock.release()

