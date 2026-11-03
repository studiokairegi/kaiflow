"""Job handlers, scheduler and the worker loop. State lives in the database (leased jobs), so a crash, reboot or outage loses
nothing: expired leases return to the queue, sends are settled by the message state machine, and every enqueue is idempotent."""
from __future__ import annotations

import random
import threading
import time
import traceback
from dataclasses import dataclass
from typing import Callable

from . import classify as cls, drafting, mailops, policy, research, sources
from .errors import PermanentError, RpcError, TransientError

DEFER = {"daily_cap", "followup_cap", "campaign_cap", "followup_not_due", "campaign_paused", "kill_switch", "needs_reconcile"}


@dataclass
class Deps:
    cfg: object
    rpc: Callable            # rpc(name, params)
    fetcher: object
    zoho: object
    llm: object              # OllamaClient
    sleep: Callable = time.sleep
    clock: Callable = time.time
    rand: Callable = random.uniform


def _enq(d: Deps, kind, payload, key, delay=0, priority=0):
    run_after = None if not delay else time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(d.clock() + delay))
    return d.rpc("intel_agent_enqueue_job", {"p_kind": kind, "p_payload": payload, "p_idempotency_key": key, "p_run_after": run_after, "p_priority": priority})


def _kb(d):  # approved entries only; the database never returns the rest
    return drafting.kb_map(d.rpc("intel_agent_kb", {}) or [])


def h_discover(d: Deps, job):
    t = job["payload"]["type"]
    st = d.rpc("intel_agent_settings", {})
    camp = next((c for c in st["campaigns"] if c["type"] == t), None)
    if not camp or camp["status"] != "active":
        return {"skipped": "campaign paused"}
    new = 0
    for c in sources.discover(d.fetcher, t, camp["criteria"]):
        meta = c.get("meta", {})
        r = d.rpc("intel_agent_upsert_prospect", {"p_type": t, "p_name": c["name"], "p_website": c["website"], "p_contact_name": "", "p_contact_email": c.get("contact_email", ""),
                                                  "p_contact_source_url": c.get("contact_source_url", ""), "p_country": c.get("country", ""), "p_language": meta.get("language", "en"), "p_verified": meta})
        if r["created"] and not r.get("suppressed"):
            new += 1
            _enq(d, "research", {"prospect_id": r["prospect_id"]}, f"research:{r['prospect_id']}")
    return {"new": new}


def h_research(d: Deps, job):
    pid = job["payload"]["prospect_id"]
    ctx = d.rpc("intel_agent_context", {"p_prospect_id": pid})
    if not ctx or ctx["prospect"]["status"] not in ("discovered", "researched"):
        return {"skipped": "not researchable"}
    llm = lambda text: d.llm.generate_json(research.ENTITY_INSTRUCTION, text, research.ENTITY_SCHEMA, fast=True)
    out = research.research(d.rpc, d.fetcher, llm, ctx)
    _enq(d, "qualify", {"prospect_id": pid}, f"qualify:{pid}")
    return out


def h_qualify(d: Deps, job):
    pid = job["payload"]["prospect_id"]
    ctx = d.rpc("intel_agent_context", {"p_prospect_id": pid})
    camp = next((c for c in d.rpc("intel_agent_settings", {})["campaigns"] if c["type"] == ctx["prospect"]["type"]), {"criteria": {}})
    res = research.qualify(d.rpc, ctx, camp["criteria"])
    if res.decision == "qualified":
        _enq(d, "resolve", {"prospect_id": pid}, f"resolve:{pid}")
    return {"score": res.score, "decision": res.decision}


def h_resolve(d: Deps, job):
    pid = job["payload"]["prospect_id"]
    r = d.rpc("intel_agent_resolve_lead", {"p_prospect_id": pid})
    if r["action"] in ("created", "linked_ai", "linked_manual") and not r.get("already_contacted"):
        _enq(d, "draft", {"prospect_id": pid, "kind": "initial"}, f"draft:{pid}:initial")
    return r


def h_draft(d: Deps, job):
    pid, kind = job["payload"]["prospect_id"], job["payload"].get("kind", "initial")
    ctx = d.rpc("intel_agent_context", {"p_prospect_id": pid})
    p = ctx["prospect"]
    st, kb = d.rpc("intel_agent_settings", {}), _kb(d)
    if not p.get("contact_email"):
        return {"skipped": "no verified contact email"}
    if kind == "initial":
        if p["status"] != "lead_linked":
            return {"skipped": f"status {p['status']}"}
        mail = drafting.build_initial(p, ctx["evidence"], kb, st, llm=lambda name, snips: d.llm.generate_json(
            f"Write ONE friendly sentence (30 to 200 characters) from an animation studio introducing itself to {name}. Refer to something in the snippets. No numbers, no links, no claim that anyone played, watched or reviewed anything.",
            snips, drafting.HOOK_SCHEMA))
        step, key = 0, f"draft:{pid}:initial"
    else:
        if p["status"] != "contacted":
            return {"skipped": f"status {p['status']}"}
        prev = [m for m in ctx["messages"] if m["kind"] == "followup" and m["state"] not in ("discarded", "failed")]
        initial = next((m for m in ctx["messages"] if m["kind"] == "initial" and m["state"] == "sent"), None)
        step, key = 1 + len(prev), f"draft:{pid}:fu{1 + len(prev)}"
        mail = drafting.build_followup(p, kb, st, (initial or {}).get("created_at", "")[:10] or "recently")
    bad = policy.validate_outbound(mail["subject"], mail["body"], st, drafting.approved_urls(kb), kind, p.get("domain", ""))
    if bad:
        d.rpc("intel_agent_log", {"p_action": "draft_blocked", "p_entity_type": "prospect", "p_entity_id": pid, "p_detail": {"violations": bad}})
        raise PermanentError("draft failed policy: " + "; ".join(bad))
    r = d.rpc("intel_agent_upsert_draft", {"p_prospect_id": pid, "p_kind": kind, "p_step": step, "p_subject": mail["subject"], "p_body": mail["body"],
                                           "p_idempotency_key": key, "p_to_email": p["contact_email"], "p_auto_ok": False, "p_in_reply_to": None, "p_references": None})
    if r.get("ok") and r.get("state") == "approved":
        _enq(d, "send", {"message_id": r["message_id"]}, f"send:{r['message_id']}:{int(d.clock() // 900)}")
    return r


def h_send(d: Deps, job):
    # Gentle pacing between sends so 30 a day never goes out as a burst.
    last = getattr(d, "_last_send", 0)
    gap = d.rand(45, 120)
    if d.clock() - last < gap:
        d.sleep(max(0, gap - (d.clock() - last)))
    r = mailops.send_message(d.rpc, d.zoho, job["payload"]["message_id"])
    d._last_send = d.clock()
    return r


def h_sync_mail(d: Deps, job):
    st = d.rpc("intel_agent_settings", {})
    try:
        return mailops.sync_inbox(d.rpc, d.zoho, {st["sender_email"].lower()} if st["sender_email"] else set())
    except PermanentError as exc:
        return {"skipped": str(exc)}


def h_classify(d: Deps, job):
    st, kb = d.rpc("intel_agent_settings", {}), _kb(d)
    own = {st["sender_email"].lower()} if st["sender_email"] else set()
    llm = lambda subject, body: d.llm.generate_json("Classify this email reply to a cold introduction from an animation studio. Labels: " + ", ".join(cls.LABELS) + ".",
                                                    f"Subject: {subject}\n{body}", cls.SCHEMA, fast=True)
    done = 0
    for m in d.rpc("intel_agent_unprocessed_inbound", {"p_limit": 20}) or []:
        r = cls.classify(m, own, llm)
        d.rpc("intel_agent_classify_inbound", {"p_message_id": m["id"], "p_class": r["class"], "p_confidence": r["confidence"], "p_escalate": r["escalate"], "p_summary": r["summary"], "p_related_email": r["related_email"]})
        done += 1
        if r["auto_ok"] and m.get("prospect_id"):
            ctx = d.rpc("intel_agent_context", {"p_prospect_id": m["prospect_id"]})
            reply = drafting.build_auto_reply(r["class"], ctx["prospect"], kb, st, m.get("subject", ""))
            if reply and not policy.validate_outbound(reply["subject"], reply["body"], st, drafting.approved_urls(kb), "reply", ctx["prospect"].get("domain", "")):
                out = d.rpc("intel_agent_upsert_draft", {"p_prospect_id": m["prospect_id"], "p_kind": "reply", "p_step": 0, "p_subject": reply["subject"], "p_body": reply["body"],
                                                         "p_idempotency_key": f"reply:{m['id']}", "p_to_email": m["from_email"], "p_auto_ok": True, "p_in_reply_to": None, "p_references": None})
                if out.get("ok") and out.get("state") == "approved":
                    _enq(d, "send", {"message_id": out["message_id"]}, f"send:{out['message_id']}:{int(d.clock() // 900)}", priority=3)
    return {"classified": done}


def h_reconcile(d: Deps, job):
    try:
        return mailops.reconcile(d.rpc, d.zoho)
    except PermanentError as exc:
        return {"skipped": str(exc)}


def h_followup_scan(d: Deps, job):
    n = 0
    for c in d.rpc("intel_agent_followup_candidates", {"p_limit": 20}) or []:
        _enq(d, "draft", {"prospect_id": c["prospect_id"], "kind": "followup"}, f"fuscan:{c['prospect_id']}:{int(d.clock() // 86400)}")
        n += 1
    return {"candidates": n}


def h_retention(d: Deps, job):
    return {"pruned": d.rpc("intel_agent_prune", {"p_evidence_days": 45})}


HANDLERS = {"discover": h_discover, "research": h_research, "qualify": h_qualify, "resolve": h_resolve, "draft": h_draft, "send": h_send,
            "sync_mail": h_sync_mail, "classify": h_classify, "reconcile": h_reconcile, "followup_scan": h_followup_scan, "retention": h_retention}


class _Lease:
    """Keeps the job's lease alive while a long handler (model call, slow site) runs."""
    def __init__(self, rpc, job, worker_id, every=60):
        self.rpc, self.job, self.wid, self.every, self.stop = rpc, job, worker_id, every, threading.Event()
    def __enter__(self):
        def beat():
            while not self.stop.wait(self.every):
                try:
                    self.rpc("intel_agent_extend_lease", {"p_job_id": self.job["id"], "p_worker_id": self.wid, "p_seconds": 300})
                except Exception:
                    pass
        self.t = threading.Thread(target=beat, daemon=True); self.t.start(); return self
    def __exit__(self, *a):
        self.stop.set()


class Worker:
    def __init__(self, deps: Deps, lease_thread: bool = True):
        self.d, self.lease_thread, self._hb = deps, lease_thread, 0.0

    def periodic(self) -> None:
        d, now = self.d, self.d.clock()
        st = d.rpc("intel_agent_settings", {})
        today = st["today"]
        for kind, secs in (("sync_mail", 120), ("reconcile", 300), ("classify", 120), ("followup_scan", 3600)):
            _enq(d, kind, {}, f"{kind}:{int(now // secs)}")
        _enq(d, "retention", {}, f"retention:{today}")
        for c in st["campaigns"]:
            if c["status"] == "active":
                _enq(d, "discover", {"type": c["type"]}, f"discover:{c['type']}:{today}")
        if not st["kill_switch"]:
            for i, m in enumerate(d.rpc("intel_agent_approved_outbound", {"p_limit": 10}) or []):
                _enq(d, "send", {"message_id": m["id"]}, f"send:{m['id']}:{int(now // 900)}", delay=i * 60)

    def tick(self) -> bool:
        d = self.d
        if d.clock() - self._hb > 30:
            d.rpc("intel_agent_heartbeat", {"p_worker_id": d.cfg.worker_id, "p_info": {"ollama": bool(getattr(d.llm, "is_up", lambda: False)())}})
            self.periodic()
            self._hb = d.clock()
        job = d.rpc("intel_agent_claim_job", {"p_worker_id": d.cfg.worker_id, "p_kinds": None, "p_lease_seconds": 300})
        if not job:
            return False
        self.run_job(job)
        return True

    def run_job(self, job) -> None:
        d, h = self.d, HANDLERS.get(job["kind"])
        try:
            if h is None:
                raise PermanentError(f"unknown job kind {job['kind']}")
            ctx = _Lease(d.rpc, job, d.cfg.worker_id) if self.lease_thread else None
            if ctx:
                ctx.__enter__()
            try:
                result = h(d, job)
            finally:
                if ctx:
                    ctx.__exit__()
            if isinstance(result, dict) and result.get("reason") in DEFER:
                result = {**result, "deferred": True}
            d.rpc("intel_agent_complete_job", {"p_job_id": job["id"], "p_worker_id": d.cfg.worker_id, "p_result": result if isinstance(result, dict) else {"value": result}})
        except TransientError as exc:
            d.rpc("intel_agent_fail_job", {"p_job_id": job["id"], "p_worker_id": d.cfg.worker_id, "p_error": f"transient: {exc}", "p_retry_seconds": min(30 * 2 ** max(job["attempts"] - 1, 0), 3600)})
        except (PermanentError, RpcError) as exc:
            d.rpc("intel_agent_fail_job", {"p_job_id": job["id"], "p_worker_id": d.cfg.worker_id, "p_error": f"permanent: {exc}", "p_retry_seconds": 86400})
        except Exception as exc:  # never let one bad job stop the worker
            d.rpc("intel_agent_fail_job", {"p_job_id": job["id"], "p_worker_id": d.cfg.worker_id, "p_error": f"unexpected {type(exc).__name__}: {exc}"[:400], "p_retry_seconds": 300})
            traceback.print_exc()

    def run_forever(self, stop: threading.Event) -> None:
        backoff = 0
        while not stop.is_set():
            try:
                busy = self.tick()
                backoff = 0
                stop.wait(0.5 if busy else self.d.cfg.poll_seconds)
            except (TransientError, RpcError) as exc:          # Supabase unreachable: wait and try again, forever
                backoff = min(backoff * 2 or 15, 300)
                print(f"[worker] waiting {backoff}s: {exc}")
                stop.wait(backoff)
