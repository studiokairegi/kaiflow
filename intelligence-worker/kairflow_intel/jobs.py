"""Job handlers, scheduler and the worker loop. State lives in the database (leased jobs), so a crash, reboot or outage loses
nothing: expired leases return to the queue, sends are settled by the message state machine, and every enqueue is idempotent."""
from __future__ import annotations

import random
import threading
import time
import traceback
from dataclasses import dataclass
from typing import Callable

from . import classify as cls, discovery, drafting, mailops, policy, research, sources, studio_reeval
from .errors import PermanentError, RpcError, TransientError

DEFER = {"daily_cap", "followup_cap", "campaign_cap", "followup_not_due", "campaign_paused", "kill_switch", "needs_reconcile"}


@dataclass
class Deps:
    cfg: object
    rpc: Callable            # rpc(name, params)
    fetcher: object
    zoho: object
    llm: object              # OllamaClient
    api: object = None       # ApiClient for the documented discovery APIs
    sleep: Callable = time.sleep
    clock: Callable = time.time
    rand: Callable = random.uniform


def _enq(d: Deps, kind, payload, key, delay=0, priority=0):
    run_after = None if not delay else time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(d.clock() + delay))
    return d.rpc("intel_agent_enqueue_job", {"p_kind": kind, "p_payload": payload, "p_idempotency_key": key, "p_run_after": run_after, "p_priority": priority})


def _kb(d):  # approved entries only; the database never returns the rest
    return drafting.kb_map(d.rpc("intel_agent_kb", {}) or [])


def h_discover(d: Deps, job):
    pl = job["payload"]
    t = pl["type"]
    manual = bool(pl.get("manual"))                      # asked for from Agent Chat: finds and researches only, never sends
    limit = max(1, min(int(pl["limit"]), 25)) if pl.get("limit") else None
    st = d.rpc("intel_agent_settings", {})
    camp = next((c for c in st["campaigns"] if c["type"] == t), None)
    if not camp or (camp["status"] != "active" and not manual):
        return {"skipped": "campaign paused"}
    new = 0
    for c in sources.discover(d.fetcher, t, camp["criteria"]):
        if limit is not None and new >= limit:
            break
        meta = c.get("meta") or {}
        raw_language = meta.get("language")
        language = raw_language if raw_language in ("en", "ja") else "other"
        r = d.rpc("intel_agent_upsert_prospect", {"p_type": t, "p_name": c["name"], "p_website": c["website"], "p_contact_name": "", "p_contact_email": c.get("contact_email", ""),
                                                  "p_contact_source_url": c.get("contact_source_url", ""), "p_country": c.get("country", ""), "p_language": language, "p_verified": meta})
        if r["created"] and not r.get("suppressed"):
            new += 1
            _enq(d, "research", {"prospect_id": r["prospect_id"]}, f"research:{r['prospect_id']}")
    return {"new": new, "manual": manual}


def h_research(d: Deps, job):
    pid = job["payload"]["prospect_id"]
    ctx = d.rpc("intel_agent_context", {"p_prospect_id": pid})
    if not ctx or ctx["prospect"]["status"] not in ("discovered", "researched"):
        return {"skipped": "not researchable"}
    if not ctx["prospect"].get("website"):
        d.rpc("intel_agent_flag_prospect", {"p_prospect_id": pid, "p_reason": "official website not found; add it or reject"})
        return {"skipped": "no website"}
    llm = lambda text: d.llm.generate_json(research.ENTITY_INSTRUCTION, text, research.ENTITY_SCHEMA, fast=True)
    out = research.research(d.rpc, d.fetcher, llm, ctx)
    _enq(d, "analyze_site", {"prospect_id": pid}, f"analyze:{pid}")      # deeper site look, then qualification
    return out


def h_qualify(d: Deps, job):
    pid = job["payload"]["prospect_id"]
    ctx = d.rpc("intel_agent_context", {"p_prospect_id": pid})
    camp = next((c for c in d.rpc("intel_agent_settings", {})["campaigns"] if c["type"] == ctx["prospect"]["type"]), {"criteria": {}})
    res = research.qualify(d.rpc, ctx, camp["criteria"])
    if res.decision == "qualified" and not res.held:       # held = older-model score kept as is; Phase 6 re-evaluates it
        _enq(d, "resolve", {"prospect_id": pid}, f"resolve:{pid}")
    return {"score": res.score, "decision": res.decision, **({"held": "older scoring model kept; candidate recorded"} if res.held else {})}


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
        thread = None
    else:
        if p["status"] != "contacted":
            return {"skipped": f"status {p['status']}"}
        msgs = ctx["messages"]
        prev = [m for m in msgs if m["kind"] == "followup" and m["state"] not in ("discarded", "failed")]
        initial = next((m for m in msgs if m["kind"] == "initial" and m["state"] == "sent"), None)
        step = drafting.next_step(p, ctx.get("lead"), len(prev))
        key = f"draft:{pid}:fu{step}"
        parent = drafting.thread_parent(msgs)
        anchor = ((initial or {}).get("sent_at") or (initial or {}).get("created_at") or "")[:10] or "recently"
        mail = drafting.build_followup(p, kb, st, anchor, parent["subject"] if parent else None)
        thread = parent
    localized_opt_out = kb.get("policy.opt_out.ja", {}).get("body", "").strip() if drafting.is_japanese_animation_prospect(p) else None
    bad = policy.validate_outbound(mail["subject"], mail["body"], st, drafting.approved_urls(kb), kind, p.get("domain", ""), opt_out_text=localized_opt_out)
    if bad:
        d.rpc("intel_agent_log", {"p_action": "draft_blocked", "p_entity_type": "prospect", "p_entity_id": pid, "p_detail": {"violations": bad}})
        raise PermanentError("draft failed policy: " + "; ".join(bad))
    r = d.rpc("intel_agent_upsert_draft", {"p_prospect_id": pid, "p_kind": kind, "p_step": step, "p_subject": mail["subject"], "p_body": mail["body"],
                                           "p_idempotency_key": key, "p_to_email": p["contact_email"], "p_auto_ok": False,
                                           "p_in_reply_to": (thread or {}).get("in_reply_to"), "p_references": (thread or {}).get("references")})
    if r.get("ok") and r.get("state") == "approved":
        _enq(d, "send", {"message_id": r["message_id"]}, f"send:{r['message_id']}:{int(d.clock() // 900)}")
    return r


def _mail_paused(d: Deps) -> bool:
    return bool(getattr(d.zoho, "disabled", False))


def h_send(d: Deps, job):
    if _mail_paused(d):
        return {"sent": False, "reason": "mail_provider_paused"}

    # Fail closed: never send if settings cannot confirm sending is enabled.
    st = d.rpc("intel_agent_settings", {})
    if st.get("kill_switch", True):
        return {"sent": False, "reason": "kill_switch"}

    # Gentle pacing between sends so 30 a day never goes out as a burst.
    last = getattr(d, "_last_send", 0)
    gap = d.rand(45, 120)
    if d.clock() - last < gap:
        d.sleep(max(0, gap - (d.clock() - last)))

    r = mailops.send_message(d.rpc, d.zoho, job["payload"]["message_id"])
    d._last_send = d.clock()
    return r

def h_sync_mail(d: Deps, job):
    if getattr(d.zoho, "provider", "") == "resend":
        return {"skipped": "Resend inbound is handled by the signed Supabase webhook"}
    if _mail_paused(d):
        return {"skipped": "mail provider paused"}
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
                                                         "p_idempotency_key": f"reply:{m['id']}", "p_to_email": m["from_email"], "p_auto_ok": True,
                                                         "p_in_reply_to": m.get("rfc_message_id") or None,
                                                         "p_references": " ".join(x for x in [(m.get("references_ids") or "").strip(), m.get("rfc_message_id") or ""] if x)[-3900:] or None})
                if out.get("ok") and out.get("state") == "approved":
                    _enq(d, "send", {"message_id": out["message_id"]}, f"send:{out['message_id']}:{int(d.clock() // 900)}", priority=3)
    return {"classified": done}


def h_chat(d: Deps, job):
    from . import chat
    return chat.handle(d, job["payload"])


def h_reconcile(d: Deps, job):
    if _mail_paused(d):
        return {"skipped": "mail provider paused"}
    try:
        return mailops.reconcile(d.rpc, d.zoho)
    except PermanentError as exc:
        return {"skipped": str(exc)}


def h_followup_scan(d: Deps, job):
    n = 0
    for c in d.rpc("intel_agent_followup_candidates", {"p_limit": 20}) or []:
        day = int(d.clock() // 86400)
        if c.get("takeover"):      # a pasted conversation exists: the follow-up must continue THAT conversation, not use the generic template
            _enq(d, "takeover", {"prospect_id": c["prospect_id"], "scheduled": True}, f"takeover-scan:{c['prospect_id']}:{day}")
        else:
            _enq(d, "draft", {"prospect_id": c["prospect_id"], "kind": "followup"}, f"fuscan:{c['prospect_id']}:{day}")
        n += 1
    return {"candidates": n}


def h_takeover(d: Deps, job):
    from . import takeover
    return takeover.handle(d, job)


def h_retention(d: Deps, job):
    return {"pruned": d.rpc("intel_agent_prune", {"p_evidence_days": 45})}


HANDLERS = {"seed_sources": discovery.h_seed_sources, "analyze_site": discovery.h_analyze_site, "news_scan": discovery.h_news_scan,
            "feed_poll": discovery.h_feed_poll, "crawl_index": discovery.h_crawl_index, "manual_post": discovery.h_manual_post,
            "profile_terms": discovery.h_profile_terms, "discover": h_discover, "research": h_research, "qualify": h_qualify, "resolve": h_resolve, "draft": h_draft, "send": h_send,
            "sync_mail": h_sync_mail, "classify": h_classify, "reconcile": h_reconcile, "followup_scan": h_followup_scan, "retention": h_retention, "chat": h_chat, "takeover": h_takeover,
            "reeval_studio": studio_reeval.h_reeval_studio}


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
                if c["type"] == "animation_studio_support":     # autonomous discovery: weekly seed, daily news, 6-hourly feeds, monthly archive check
                    wk, mo = time.strftime("%G-W%V", time.gmtime(now)), time.strftime("%Y-%m", time.gmtime(now))
                    _enq(d, "seed_sources", {"type": c["type"]}, f"seed:{wk}")
                    _enq(d, "news_scan", {}, f"news:{today}")
                    _enq(d, "feed_poll", {}, f"feeds:{int(now // 21600)}")
                    _enq(d, "crawl_index", {}, f"crawl:{mo}")
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
