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

DEFER = {"daily_cap", "followup_cap", "campaign_cap", "followup_not_due", "campaign_paused", "kill_switch", "needs_reconcile", "send_spacing"}


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


def _recipient_names(p: dict) -> list[str]:
    return [str(p.get("name") or ""), str(p.get("contact_name") or "")]


def _prior_row(m: dict) -> dict:
    return {"subject": m.get("subject", ""), "body": m.get("body_text") or m.get("body") or "",
            "names": [m.get("prospect_name") or "", m.get("contact_name") or ""]}


def _vet_draft(d: Deps, st: dict, kb: dict, mail: dict, compose, prior, *, kind: str, stored_kind: str, domain: str, pid, names,
               opt_out_text: str | None = None) -> tuple[dict, dict | None]:
    """Similarity and outbound-policy checks with ONE regeneration.

    A model-written draft that is too similar to earlier mail or breaks policy is rewritten once, with the reason
    given to the model; if the second draft also fails the caller flags the prospect for a person. Template drafts
    (compose is None) are never regenerated. Returns (mail, None) when acceptable, else (mail, problem) where problem
    is {"type": "similar", "unique": ...} | {"type": "policy", "violations": [...]} | {"type": "review", "reason": ...}."""
    footer = policy.compliance_footer(st)
    regenerated = False
    while True:
        problem = None
        if prior is not None and mail.get("model_written"):
            unique = drafting.uniqueness_check(mail, prior, threshold=drafting.SIMILARITY_THRESHOLD, footer=footer, names=names)
            if not unique["ok"]:
                problem = {"type": "similar", "unique": unique}
        if problem is None:
            bad = policy.validate_outbound(mail["subject"], mail["body"], st, drafting.approved_urls(kb), stored_kind, domain, opt_out_text=opt_out_text)
            if bad:
                problem = {"type": "policy", "violations": bad}
        if problem is None:
            return mail, None
        if regenerated or compose is None or not mail.get("model_written"):
            return mail, problem
        regenerated = True
        if problem["type"] == "similar":
            feedback = (f"it was too similar ({problem['unique']['similarity']:.2f}, {problem['unique']['reason']}) to mail already written for other "
                        "recipients. Build the opening and collaboration angle from this recipient's own evidence.")
        else:
            feedback = "it broke outbound policy: " + "; ".join(problem["violations"])[:300]
        d.rpc("intel_agent_log", {"p_action": "draft_regenerating", "p_entity_type": "prospect", "p_entity_id": pid,
                                  "p_detail": {"kind": kind, "reason": feedback[:300]}})
        try:
            mail = compose(feedback)
        except PermanentError as exc:
            return mail, {"type": "review", "reason": str(exc)}


def _store_evidence_trace(d: Deps, message_id, mail: dict) -> None:
    """Record which evidence informed a model-written draft on the message row itself. Best effort: the draft is already
    stored, so a failure here (for example the migration not yet applied) is logged, never allowed to lose or duplicate it."""
    trace = mail.get("evidence_trace")
    if not (message_id and trace):
        return
    try:
        d.rpc("intel_agent_set_message_evidence", {"p_message_id": message_id, "p_evidence": trace})
    except RpcError as exc:
        try:
            d.rpc("intel_agent_log", {"p_action": "evidence_trace_not_stored", "p_entity_type": "message", "p_entity_id": str(message_id),
                                      "p_detail": {"reason": str(exc)[:200]}})
        except RpcError:
            pass


def h_draft(d: Deps, job):
    pid, kind = job["payload"]["prospect_id"], job["payload"].get("kind", "initial")
    stored_kind = kind
    compose = None   # set for English model-written drafts; lets the vetting step regenerate once
    ctx = d.rpc("intel_agent_context", {"p_prospect_id": pid})
    p = ctx["prospect"]
    st, kb = d.rpc("intel_agent_settings", {}), _kb(d)
    if not p.get("contact_email"):
        return {"skipped": "no verified contact email"}
    # Fail early on unsafe approved KB copy. This is independent of prospect
    # research availability and must remain a hard, logged policy failure.
    relevant_kb_keys = {"studio.about", "portfolio.main", drafting.TYPE_KEY.get(p.get("type"), "")}
    unsafe_kb = []
    for key in relevant_kb_keys:
        entry = kb.get(key) or {}
        text = str(entry.get("body") or "")
        if policy.PRICE_IN_DRAFT.search(text):
            unsafe_kb.append(f"{key}: prohibited price/guarantee language")
        match = policy.FALSE_CLAIMS.search(text)
        if match:
            unsafe_kb.append(f"{key}: unsupported claim {match.group(0)!r}")
    if unsafe_kb:
        reason = "approved knowledge-base content violates outbound policy: " + "; ".join(unsafe_kb)
        d.rpc("intel_agent_log", {"p_action": "draft_blocked", "p_entity_type": "prospect", "p_entity_id": pid,
            "p_detail": {"reason": reason[:300], "kind": kind}})
        raise PermanentError(reason)
    if kind == "initial":
        if p["status"] != "lead_linked":
            return {"skipped": f"status {p['status']}"}
        if drafting.is_japanese_animation_prospect(p):
            mail = drafting.build_initial(p, ctx["evidence"], kb, st, llm=None)
        else:
            compose = lambda feedback=None: drafting.compose_english(p, ctx["evidence"], kb, st,
                llm=lambda instruction, payload, schema: d.llm.generate_json(instruction, payload, schema),
                kind="initial", history=ctx.get("messages") or [], feedback=feedback)
            try:
                mail = compose()
            except PermanentError as exc:
                d.rpc("intel_agent_log", {"p_action": "draft_review_required", "p_entity_type": "prospect", "p_entity_id": pid, "p_detail": {"reason": str(exc)[:300], "kind": kind}})
                d.rpc("intel_agent_flag_prospect", {"p_prospect_id": pid, "p_reason": "Individualized English draft requires manual review: " + str(exc)[:220]})
                return {"skipped": "manual_review_required"}
        step, key = 0, f"draft:{pid}:initial"
        thread = None
    elif kind in ("followup", "reengagement"):
        if p["status"] != "contacted":
            return {"skipped": f"status {p['status']}"}
        msgs = ctx["messages"]
        prev = [m for m in msgs if m.get("kind") == "followup" and m.get("state") not in ("discarded", "failed")]
        initial = next((m for m in msgs if m["kind"] == "initial" and m["state"] == "sent"), None)
        step = drafting.next_step(p, ctx.get("lead"), len(prev))
        # The persisted message schema intentionally remains initial/followup/reply.
        # Re-engagement is a distinct composition mode occupying the final allowed
        # follow-up slot, so it uses the existing followup RPC and send safeguards.
        stored_kind = "followup" if kind == "reengagement" else kind
        key = f"draft:{pid}:fu{step}"
        parent = drafting.thread_parent(msgs)
        anchor = ((initial or {}).get("sent_at") or (initial or {}).get("created_at") or "")[:10] or "recently"
        if drafting.is_japanese_animation_prospect(p):
            mail = drafting.build_followup(p, kb, st, anchor, parent["subject"] if parent else None)
        else:
            compose = lambda feedback=None: drafting.compose_english(p, ctx.get("evidence") or [], kb, st,
                llm=lambda instruction, payload, schema: d.llm.generate_json(instruction, payload, schema),
                kind=kind, history=msgs, sent_on=anchor, parent_subject=(parent or {}).get("subject"), feedback=feedback)
            try:
                mail = compose()
            except PermanentError as exc:
                d.rpc("intel_agent_log", {"p_action": "draft_review_required", "p_entity_type": "prospect", "p_entity_id": pid, "p_detail": {"reason": str(exc)[:300], "kind": kind}})
                d.rpc("intel_agent_flag_prospect", {"p_prospect_id": pid, "p_reason": "Individualized English draft requires manual review: " + str(exc)[:220]})
                return {"skipped": "manual_review_required"}
        thread = parent
    else:
        return {"skipped": f"unsupported draft kind {kind}"}
    prior = None
    if mail.get("model_written") and not drafting.is_japanese_animation_prospect(p):
        # Compare against persisted organization-wide outbound history, not only this
        # prospect's thread. This catches template reuse across different recipients.
        history = d.rpc("intel_agent_recent_outbound", {"p_limit": 500}) or []
        prior = [_prior_row(m) for m in history
                 if m.get("state") not in ("discarded", "failed") and m.get("idempotency_key") != key]   # not our own earlier copy (retry)
    localized_opt_out = kb.get("policy.opt_out.ja", {}).get("body", "").strip() if drafting.is_japanese_animation_prospect(p) else None
    mail, problem = _vet_draft(d, st, kb, mail, compose, prior, kind=kind, stored_kind=stored_kind, domain=p.get("domain", ""), pid=pid,
                               names=_recipient_names(p), opt_out_text=localized_opt_out)
    if problem and problem["type"] == "review":
        d.rpc("intel_agent_log", {"p_action": "draft_review_required", "p_entity_type": "prospect", "p_entity_id": pid, "p_detail": {"reason": problem["reason"][:300], "kind": kind}})
        d.rpc("intel_agent_flag_prospect", {"p_prospect_id": pid, "p_reason": "Individualized English draft requires manual review: " + problem["reason"][:220]})
        return {"skipped": "manual_review_required"}
    if problem and problem["type"] == "similar":
        unique = problem["unique"]
        d.rpc("intel_agent_log", {"p_action": "draft_review_required", "p_entity_type": "prospect", "p_entity_id": pid,
            "p_detail": {"reason": unique["reason"], "similarity": unique["similarity"], "kind": kind}})
        d.rpc("intel_agent_flag_prospect", {"p_prospect_id": pid, "p_reason": "Draft is too similar to previous outreach; manual review required."})
        return {"skipped": "manual_review_required"}
    if mail.get("personalization"):
        d.rpc("intel_agent_log", {"p_action": "draft_personalization_evidence", "p_entity_type": "prospect", "p_entity_id": pid,
            "p_detail": {"kind": kind, "evidence_ids": mail["personalization"].get("evidence_ids", []), "evidence": mail.get("evidence_trace", []),
                         "grounding_overlap": mail["personalization"].get("grounding_overlap")}})
    if problem:   # policy
        bad = problem["violations"]
        d.rpc("intel_agent_log", {"p_action": "draft_blocked", "p_entity_type": "prospect", "p_entity_id": pid, "p_detail": {"violations": bad}})
        if mail.get("model_written"):
            # A model-written draft that fails policy must surface for a human, not sit silently at lead_linked / contacted.
            d.rpc("intel_agent_flag_prospect", {"p_prospect_id": pid, "p_reason": "Draft blocked by outbound policy; manual review required: " + "; ".join(bad)[:200]})
        raise PermanentError("draft failed policy: " + "; ".join(bad))
    r = d.rpc("intel_agent_upsert_draft", {"p_prospect_id": pid, "p_kind": stored_kind if kind in ("followup", "reengagement") else kind, "p_step": step, "p_subject": mail["subject"], "p_body": mail["body"],
                                           "p_idempotency_key": key, "p_to_email": p["contact_email"], "p_auto_ok": False,
                                           "p_in_reply_to": (thread or {}).get("in_reply_to"), "p_references": (thread or {}).get("references")})
    if r.get("ok"):
        _store_evidence_trace(d, r.get("message_id"), mail)
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

    # Spacing is reserved atomically in Supabase so multiple worker processes
    # cannot bypass the studio-wide throttle.
    r = mailops.send_message(d.rpc, d.zoho, job["payload"]["message_id"])
    if r.get("reason") == "send_spacing":
        delay = max(5, min(int(r.get("retry_after", 60)), 300))
        message_id = job["payload"]["message_id"]
        _enq(d, "send", {"message_id": message_id}, f"send-slot:{message_id}:{int(d.clock() // 60)}", delay=delay)
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
    requested_id = (job.get("payload") or {}).get("message_id")
    # Classify jobs are keyed per inbound message. Pull a larger bounded backlog
    # and select the matching row rather than repeatedly classifying the first 20.
    pending = d.rpc("intel_agent_unprocessed_inbound", {"p_limit": 100}) or []
    if requested_id:
        pending = [m for m in pending if str(m.get("id")) == str(requested_id)]
        if not pending:
            return {"done": 0, "skipped": "inbound_message_not_pending"}
    for m in pending:
        r = cls.classify(m, own, llm)
        def save_class(m=m, r=r):
            d.rpc("intel_agent_classify_inbound", {"p_message_id": m["id"], "p_class": r["class"], "p_confidence": r["confidence"], "p_escalate": r["escalate"], "p_summary": r["summary"], "p_related_email": r["related_email"]})
        # The classification is saved only after the reply draft is stored (or composition definitively fails), so a
        # model outage or a failed database call leaves the message pending and the whole job retries.
        if not (r["auto_ok"] and m.get("prospect_id")):
            save_class()
        done += 1
        if r["auto_ok"] and m.get("prospect_id"):
            ctx = d.rpc("intel_agent_context", {"p_prospect_id": m["prospect_id"]})
            compose = None   # English model-written replies only; lets the vetting step regenerate once
            if drafting.is_japanese_animation_prospect(ctx["prospect"]):
                reply = drafting.build_auto_reply(r["class"], ctx["prospect"], kb, st, m.get("subject", ""))
            else:
                compose = lambda feedback=None, m=m, r=r, ctx=ctx: drafting.compose_english(ctx["prospect"], ctx.get("evidence") or [], kb, st,
                    llm=lambda instruction, payload, schema: d.llm.generate_json(instruction, payload, schema),
                    kind="reply", inbound={"id": m.get("id"), "subject": m.get("subject", ""), "body": m.get("body_text", ""),
                        "class": r["class"], "summary": r.get("summary", "")},
                    history=ctx.get("messages") or [], feedback=feedback)
                try:
                    reply = compose()
                except PermanentError as exc:
                    # Classification is retained, but composition failure must be visible
                    # and actionable rather than silently dropping the reply draft.
                    d.rpc("intel_agent_log", {"p_action": "draft_review_required", "p_entity_type": "prospect",
                        "p_entity_id": m["prospect_id"], "p_detail": {"reason": str(exc)[:300], "kind": "reply", "inbound_message_id": m.get("id")}})
                    d.rpc("intel_agent_flag_prospect", {"p_prospect_id": m["prospect_id"],
                        "p_reason": "Incoming reply requires manual review because individualized reply drafting failed: " + str(exc)[:220]})
                    reply = None
            if reply:
                # Replies receive the same substantive near-duplicate/structural check
                # as outbound outreach, against actual sent messages in this thread.
                history = d.rpc("intel_agent_recent_outbound", {"p_limit": 500}) or []
                prior_replies = [_prior_row(x) for x in history
                    if x.get("state") in ("sent", "approved", "pending_approval", "reserved", "sending", "unknown")
                    and x.get("idempotency_key") != f"reply:{m['id']}"]   # not our own earlier copy (retry)
                pid_m = m["prospect_id"]
                reply, problem = _vet_draft(d, st, kb, reply, compose, prior_replies, kind="reply", stored_kind="reply",
                                            domain=ctx["prospect"].get("domain", ""), pid=pid_m, names=_recipient_names(ctx["prospect"]))
                bad_reply = []
                if problem and problem["type"] == "review":
                    d.rpc("intel_agent_log", {"p_action": "draft_review_required", "p_entity_type": "prospect", "p_entity_id": pid_m,
                        "p_detail": {"reason": problem["reason"][:300], "kind": "reply", "inbound_message_id": m.get("id")}})
                    d.rpc("intel_agent_flag_prospect", {"p_prospect_id": pid_m,
                        "p_reason": "Incoming reply requires manual review because individualized reply drafting failed: " + problem["reason"][:220]})
                    reply = None
                elif problem and problem["type"] == "similar":
                    unique = problem["unique"]
                    d.rpc("intel_agent_log", {"p_action": "draft_review_required", "p_entity_type": "prospect", "p_entity_id": pid_m,
                        "p_detail": {"reason": unique["reason"], "similarity": unique["similarity"], "kind": "reply", "inbound_message_id": m.get("id")}})
                    d.rpc("intel_agent_flag_prospect", {"p_prospect_id": pid_m, "p_reason": "Reply draft is too similar to previous sent communication; manual review required."})
                    reply = None
                elif problem:
                    bad_reply = problem["violations"]
            else:
                bad_reply = []
            if reply and bad_reply:
                d.rpc("intel_agent_log", {"p_action": "draft_blocked", "p_entity_type": "prospect", "p_entity_id": m["prospect_id"], "p_detail": {"violations": bad_reply, "kind": "reply", "inbound_message_id": m.get("id")}})
                d.rpc("intel_agent_flag_prospect", {"p_prospect_id": m["prospect_id"], "p_reason": "Reply draft blocked by outbound policy; manual review required: " + "; ".join(bad_reply)[:200]})
            if reply and not bad_reply:
                out = d.rpc("intel_agent_upsert_draft", {"p_prospect_id": m["prospect_id"], "p_kind": "reply", "p_step": 0, "p_subject": reply["subject"], "p_body": reply["body"],
                                                         "p_idempotency_key": f"reply:{m['id']}", "p_to_email": m["from_email"], "p_auto_ok": not reply.get("model_written"),   # model-written replies are always human-approved
                                                         "p_in_reply_to": m.get("rfc_message_id") or None,
                                                         "p_references": " ".join(x for x in [(m.get("references_ids") or "").strip(), m.get("rfc_message_id") or ""] if x)[-3900:] or None})
                if out.get("ok"):
                    _store_evidence_trace(d, out.get("message_id"), reply)
                if out.get("ok") and out.get("state") == "approved":
                    _enq(d, "send", {"message_id": out["message_id"]}, f"send:{out['message_id']}:{int(d.clock() // 900)}", priority=3)
            # Saved last: if the history lookup or the draft upsert fails, the message stays pending and the retry
            # produces the reply. Saving earlier marked it processed and the reply was lost for good.
            save_class()
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
            draft_kind = c.get("draft_kind") or "followup"
            if draft_kind not in ("followup", "reengagement"):
                draft_kind = "followup"
            _enq(d, "draft", {"prospect_id": c["prospect_id"], "kind": draft_kind}, f"fuscan:{c['prospect_id']}:{draft_kind}:{day}")
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
