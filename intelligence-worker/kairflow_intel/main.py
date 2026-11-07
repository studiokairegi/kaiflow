from __future__ import annotations

import signal
import sys
import threading

from . import config as cfgmod
from .jobs import Deps, Worker
from .ollama import OllamaClient
from .safety import Fetcher
from .supa import SupabaseAgent
from .apis import ApiClient
from .gmail import GmailClient
from .zoho import EdgeTokenProvider, ZohoClient
from .mail_disabled import DisabledMail
from .resend import ResendClient


def build(cfg):
    supa = SupabaseAgent(cfg)
    # `Deps.zoho` is a historical dependency name; it is the selected provider adapter.
    if cfg.mail_provider == "none":
        zoho = DisabledMail()          # No provider client is created and no token is requested
    elif cfg.mail_provider == "gmail":
        zoho = GmailClient(EdgeTokenProvider(cfg, supa, function="intel-gmail-token"))
    elif cfg.mail_provider == "resend":
        zoho = ResendClient(cfg, supa)
    else:
        zoho = ZohoClient(EdgeTokenProvider(cfg, supa))
    return supa, Deps(cfg=cfg, rpc=supa.rpc, fetcher=Fetcher(cfg), zoho=zoho, llm=OllamaClient(cfg), api=ApiClient(cfg))


def selftest(cfg, what: str) -> int:
    supa, d = build(cfg)
    ok = True
    def line(name, good, extra=""):
        nonlocal ok
        ok &= bool(good)
        print(("PASS " if good else "FAIL ") + name + (f": {extra}" if extra else ""))
    if what in ("all", "ollama"):
        up = d.llm.is_up()
        line("ollama reachable on loopback", up)
    if what in ("all", "supabase"):
        try:
            st = d.rpc("intel_agent_settings", {})
            line("agent sign-in and settings", True, f"autonomy={st['autonomy']} sending={'OFF' if st['kill_switch'] else 'ON'}")
        except Exception as exc:
            line("agent sign-in and settings", False, str(exc))
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
    try:
        cfg = cfgmod.load()
    except cfgmod.ConfigError as exc:
        print(f"configuration error: {exc}")
        return 2
    if cmd == "selftest":
        return selftest(cfg, argv[1] if len(argv) > 1 else "all")
    if cmd == "reeval-studio":           # queue / inspect the studio-v2 reevaluation; does not run the worker and cannot send anything
        from . import studio_reeval
        return studio_reeval.cli(SupabaseAgent(cfg).rpc, argv[1:])
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
