"""Job handlers, scheduler and the worker loop. State lives in the database (leased jobs), so a crash, reboot or outage loses
nothing: expired leases return to the queue, sends are settled by the message state machine, and every enqueue is idempotent."""
from __future__ import annotations

import random
import re
import threading
import time
import traceback
from dataclasses import dataclass
from typing import Callable

from . import classify as cls, discovery, drafting, mailops, policy, research, sources, studio_reeval
from .errors import PermanentError, RpcError, TransientError
from .safety import MeteredFetcher

DEFER = {"daily_cap", "followup_cap", "campaign_cap", "followup_not_due", "campaign_paused", "kill_switch", "needs_reconcile", "send_spacing", "send_window_deferred", "provider_account_quota"}


@dataclass
class Deps:
    cfg: object
    rpc: Callable            # rpc(name, params)
    fetcher: object
    zoho: object
    llm: object              # OllamaClient, or FallbackLLM (Gemini for Agent Chat planning, Ollama for everything else)
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
    # All h_discover paths, including admin-seeded studio URLs and indie
    # Steam/itch adapters, must pass the organization-scoped source registry.
    registry = d.rpc("intel_agent_sources", {}) or {}
    enabled_sources = set(registry.keys())
    reserve_source = lambda key: int(d.rpc("intel_agent_source_use", {"p_key": key, "p_n": 1}) or 0) == 1
    report_source = lambda key, ok, err="": d.rpc("intel_agent_source_report", {"p_key": key, "p_ok": ok, "p_error": str(err)[:250]})
    configured = camp.get("criteria")
    if not isinstance(configured, dict):
        return {"skipped": "discovery criteria must be an object"}
    if t == "indie_game_developer":
        requested = configured.get("sources")
        keywords = configured.get("keywords")
        if (not isinstance(requested, list) or not requested or
                any(not isinstance(key, str) or key not in ("steam", "itch") for key in requested) or
                not isinstance(keywords, list) or not any(isinstance(k, str) and k.strip() for k in keywords)):
            return {"skipped": "indie discovery requires valid explicitly configured sources and non-empty keywords"}
        if not any(key in enabled_sources for key in requested):
            return {"skipped": "no requested indie source is registry-authorized"}
    else:
        seed_urls = configured.get("seed_urls")
        if seed_urls is not None and (not isinstance(seed_urls, list) or any(not isinstance(u, str) or not u.strip() for u in seed_urls)):
            return {"skipped": "seed_urls must be a list of non-empty strings"}
        if seed_urls and "site_crawler" not in enabled_sources:
            return {"skipped": "site_crawler source is not registry-authorized"}
    new = 0
    for c in sources.discover(d.fetcher, t, configured, enabled_sources=enabled_sources, reserve_source=reserve_source, report_source=report_source):
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
    registry = d.rpc("intel_agent_sources", {}) or {}
    if "site_crawler" not in registry:
        return {"skipped": "site_crawler source is disabled, terms-unconfirmed, over budget or circuit-open"}
    fetcher = MeteredFetcher(d.fetcher, lambda: int(d.rpc("intel_agent_source_use", {"p_key": "site_crawler", "p_n": 1}) or 0) == 1)
    out = research.research(d.rpc, fetcher, llm, ctx)
    _enq(d, "analyze_site", {"prospect_id": pid}, f"analyze:{pid}")      # deeper site look, then qualification
    return out


def h_qualify(d: Deps, job):
    pid = job["payload"]["prospect_id"]
    ctx = d.rpc("intel_agent_context", {"p_prospect_id": pid})
    camp = next((c for c in d.rpc("intel_agent_settings", {})["campaigns"] if c["type"] == ctx["prospect"]["type"]), {"criteria": {}})
    res = research.qualify(d.rpc, ctx, camp["criteria"])
    if res.decision == "qualified" and res.contactability.get("status") == "pass" and not res.held:       # suitability and contactability are independent gates
        _enq(d, "resolve", {"prospect_id": pid}, f"resolve:{pid}")
    return {"score": res.score, "decision": res.decision, "contactability": res.contactability, **({"held": "older scoring model kept; candidate recorded"} if res.held else {})}


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
    footer = policy.compliance_footer(st, opt_out_text=opt_out_text)
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
    force_review = bool((job.get("payload") or {}).get("force_review", False))
    language_override = (job.get("payload") or {}).get("language")
    stored_kind = kind
    compose = None   # set for English model-written drafts; lets the vetting step regenerate once
    ctx = d.rpc("intel_agent_context", {"p_prospect_id": pid})
    p = ctx["prospect"]
    if kind == "initial":
        existing = next((m for m in reversed(ctx.get("messages") or [])
                         if m.get("direction") == "outbound" and m.get("idempotency_key") == f"draft:{pid}:initial"), None)
        if existing:
            return {"ok": True, "message_id": existing["id"], "created": False, "state": existing.get("state")}
    st, kb = d.rpc("intel_agent_settings", {}), _kb(d)
    if not p.get("contact_email"):
        return {"skipped": "no verified contact email"}
    # Fail early on unsafe approved KB copy. This is independent of prospect
    # research availability and must remain a hard, logged policy failure.
    use_japanese = language_override == "ja" or drafting.should_use_japanese(p, ctx.get("messages") or [])
    relevant_kb_keys = {"studio.about", "portfolio.main", drafting.TYPE_KEY.get(p.get("type"), "")}
    if use_japanese:
        relevant_kb_keys.update(drafting.japanese_kb_keys(p))
    unsafe_kb = []
    for key in relevant_kb_keys:
        entry = kb.get(key) or {}
        text = str(entry.get("body") or "")
        if policy.PRICE_IN_DRAFT.search(text) or (use_japanese and policy.PRICE_IN_DRAFT_JA.search(text)):
            unsafe_kb.append(f"{key}: prohibited price/guarantee language")
        match = policy.FALSE_CLAIMS.search(text)
        if match:
            unsafe_kb.append(f"{key}: unsupported claim {match.group(0)!r}")
        if use_japanese and (re.search(r"以前(?:ご相談|お話し)|お話しした通り|外注先をお探し|人手不足|これまでに多く|数多く|豊富な経験|多数の作品|多くの作品|幅広い実績|数々の作品", text) or policy.FALSE_CLAIMS_JA.search(text)):
            unsafe_kb.append(f"{key}: unsupported Japanese history, experience, volume, interest or staffing claim")
    if unsafe_kb:
        reason = "approved knowledge-base content violates outbound policy: " + "; ".join(unsafe_kb)
        d.rpc("intel_agent_log", {"p_action": "draft_blocked", "p_entity_type": "prospect", "p_entity_id": pid,
            "p_detail": {"reason": reason[:300], "kind": kind}})
        raise PermanentError(reason)
    if kind == "initial":
        if p["status"] != "lead_linked":
            return {"skipped": f"status {p['status']}"}
        composer = drafting.compose_japanese if use_japanese else drafting.compose_english
        compose = lambda feedback=None: composer(p, ctx["evidence"], kb, st,
            llm=lambda instruction, payload, schema: d.llm.generate_json(instruction, payload, schema),
            kind="initial", history=ctx.get("messages") or [], feedback=feedback)
        try:
            mail = compose()
        except PermanentError as exc:
            d.rpc("intel_agent_log", {"p_action": "draft_review_required", "p_entity_type": "prospect", "p_entity_id": pid, "p_detail": {"reason": str(exc)[:300], "kind": kind}})
            d.rpc("intel_agent_flag_prospect", {"p_prospect_id": pid, "p_reason": "Individualized draft requires manual review: " + str(exc)[:220]})
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
        composer = drafting.compose_japanese if drafting.should_use_japanese(p, msgs) else drafting.compose_english
        compose = lambda feedback=None: composer(p, ctx.get("evidence") or [], kb, st,
            llm=lambda instruction, payload, schema: d.llm.generate_json(instruction, payload, schema),
            kind=kind, history=msgs, sent_on=anchor, parent_subject=(parent or {}).get("subject"), feedback=feedback)
        try:
            mail = compose()
        except PermanentError as exc:
            d.rpc("intel_agent_log", {"p_action": "draft_review_required", "p_entity_type": "prospect", "p_entity_id": pid, "p_detail": {"reason": str(exc)[:300], "kind": kind}})
            d.rpc("intel_agent_flag_prospect", {"p_prospect_id": pid, "p_reason": "Individualized draft requires manual review: " + str(exc)[:220]})
            return {"skipped": "manual_review_required"}
        thread = parent
    else:
        return {"skipped": f"unsupported draft kind {kind}"}
    prior = None
    if mail.get("model_written"):
        # Compare against persisted organization-wide outbound history, not only this
        # prospect's thread. This catches template reuse across different recipients.
        history = d.rpc("intel_agent_recent_outbound", {"p_limit": 500}) or []
        prior = [_prior_row(m) for m in history
                 if m.get("state") not in ("discarded", "failed") and m.get("idempotency_key") != key]   # not our own earlier copy (retry)
    localized_opt_out = kb.get("policy.opt_out.ja", {}).get("body", "").strip() if use_japanese else None
    mail, problem = _vet_draft(d, st, kb, mail, compose, prior, kind=kind, stored_kind=stored_kind, domain=p.get("domain", ""), pid=pid,
                               names=_recipient_names(p), opt_out_text=localized_opt_out)
    if problem and problem["type"] == "review":
        d.rpc("intel_agent_log", {"p_action": "draft_review_required", "p_entity_type": "prospect", "p_entity_id": pid, "p_detail": {"reason": problem["reason"][:300], "kind": kind}})
        d.rpc("intel_agent_flag_prospect", {"p_prospect_id": pid, "p_reason": "Individualized draft requires manual review: " + problem["reason"][:220]})
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
                                           "p_in_reply_to": (thread or {}).get("in_reply_to"), "p_references": (thread or {}).get("references"),
                                           "p_force_review": force_review})
    if r.get("ok"):
        _store_evidence_trace(d, r.get("message_id"), mail)
    if r.get("ok") and r.get("state") == "approved":
        _enq(d, "send", {"message_id": r["message_id"]}, f"send:{r['message_id']}:{int(d.clock() // 900)}")
    return r


def _mail_paused(d: Deps) -> bool:
    return bool(getattr(d.zoho, "disabled", False))


def _defer_outside_send_window(d: Deps, message_id: str):
    status = d.rpc("intel_agent_send_window_status", {"p_message_id": message_id}) or {}
    if status.get("allowed") is True:
        return None
    reason = status.get("reason", "send_window_status_unavailable")
    if reason != "outside_send_window" or not status.get("next_open_at"):
        return {"sent": False, "reason": reason}
    raw = str(status["next_open_at"])
    try:
        next_open = __import__("datetime").datetime.fromisoformat(raw.replace("Z", "+00:00"))
        delay = max(30, min(int(next_open.timestamp() - d.clock()) + 1, 8 * 86_400))
    except (TypeError, ValueError, OverflowError):
        return {"sent": False, "reason": "send_window_schedule_invalid"}
    _enq(d, "send", {"message_id": message_id}, f"send-window:{message_id}:{next_open.isoformat()}", delay=delay)
    return {"sent": False, "reason": "send_window_deferred", "retry_after": delay, "next_open_at": raw, "deferred": True}


def h_send(d: Deps, job):
    if _mail_paused(d):
        return {"sent": False, "reason": "mail_provider_paused"}

    # Fail closed: never send if settings cannot confirm sending is enabled.
    st = d.rpc("intel_agent_settings", {})
    if st.get("kill_switch", True):
        return {"sent": False, "reason": "kill_switch"}

    message_id = job["payload"]["message_id"]
    deferred = _defer_outside_send_window(d, message_id)
    if deferred is not None:
        return deferred

    # Spacing is reserved atomically in Supabase so multiple worker processes
    # cannot bypass the studio-wide throttle. The final DB gate rechecks the
    # send window; if it closes between preflight and send, defer once more.
    r = mailops.send_message(d.rpc, d.zoho, message_id)
    if r.get("reason") == "not_reserved_or_send_stopped":
        deferred = _defer_outside_send_window(d, message_id)
        if deferred is not None and deferred.get("reason") == "outside_send_window":
            return deferred
        if deferred is not None and deferred.get("reason") == "send_window_deferred":
            return deferred
    if r.get("reason") in ("send_spacing", "provider_account_quota"):
        delay = max(5, min(int(r.get("retry_after", 60)), 86_400))
        _enq(d, "send", {"message_id": message_id}, f"send-slot:{message_id}:{int(d.clock() // 60)}", delay=delay)
    return r

def h_sync_mail(d: Deps, job):
    provider_key = str(getattr(d.zoho, "provider", "") or "").lower()
    if provider_key == "resend":
        return {"skipped": "Resend is a separate transactional integration, not an Intelligence mailbox adapter"}
    try:
        # The account registry is authoritative after multi-account dispatch. It
        # must be checked before the legacy fallback's `disabled` flag: with the
        # safe `KAIRFLOW_MAIL_PROVIDER=none` default, registered Gmail/Zoho accounts
        # still need to receive replies through their account-scoped adapters.
        accounts = d.rpc("intel_agent_receive_accounts", {}) or []
        if accounts:
            st = d.rpc("intel_agent_settings", {})
            own = {st["sender_email"].lower()} if st.get("sender_email") else set()
            return mailops.sync_provider_accounts(d.rpc, d.zoho, own, accounts=accounts)
        if provider_key == "smtp":
            return {"skipped": "SMTP is send-only; connect Gmail or Zoho Mail to synchronize inbound replies"}
        if _mail_paused(d):
            return {"skipped": "mail provider paused"}
        st = d.rpc("intel_agent_settings", {})
        own = {st["sender_email"].lower()} if st.get("sender_email") else set()
        # Legacy single-mailbox bridge for installations with no registry accounts.
        return mailops.sync_inbox(d.rpc, d.zoho, own)
    except PermanentError as exc:
        return {"skipped": str(exc)}


def h_classify(d: Deps, job):
    st, kb = d.rpc("intel_agent_settings", {}), _kb(d)
    own = {st["sender_email"].lower()} if st["sender_email"] else set()
    def llm(subject, body):
        if drafting._has_japanese_text(str(subject or "") + " " + str(body or "")):
            instruction = ("次の日本語メールを分類してください。ラベルは " + ", ".join(cls.LABELS)
                + " のいずれかです。ポートフォリオ送付依頼は portfolio_request、一般的な前向きな返答は positive、"
                  "料金・契約・交渉・納期・稼働状況・苦情・配信停止は該当する要確認ラベルにしてください。"
                  " 曖昧な場合は ambiguous を選んでください。JSONのみを返してください。")
        else:
            instruction = "Classify this email reply to a cold introduction from an animation studio. Labels: " + ", ".join(cls.LABELS) + "."
        return d.llm.generate_json(instruction, f"Subject: {subject}\n{body}", cls.SCHEMA, fast=True)
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
            inbound_context = {"id": m.get("id"), "subject": m.get("subject", ""), "body": m.get("body_text", ""),
                               "class": r["class"], "summary": r.get("summary", "")}
            composer = drafting.compose_japanese if drafting.should_use_japanese(ctx["prospect"], ctx.get("messages") or [], inbound_context) else drafting.compose_english
            compose = lambda feedback=None, m=m, r=r, ctx=ctx, inbound_context=inbound_context, composer=composer: composer(
                ctx["prospect"], ctx.get("evidence") or [], kb, st,
                llm=lambda instruction, payload, schema: d.llm.generate_json(instruction, payload, schema),
                kind="reply", inbound=inbound_context, history=ctx.get("messages") or [], feedback=feedback)
            try:
                reply = compose()
            except PermanentError as exc:
                # Classification is retained, but composition failure must be visible
                # and actionable rather than silently dropping the reply draft.
                d.rpc("intel_agent_log", {"p_action": "draft_review_required", "p_entity_type": "prospect",
                    "p_entity_id": m["prospect_id"], "p_detail": {"reason": str(exc)[:300], "kind": "reply", "inbound_message_id": m.get("id")}})
                d.rpc("intel_agent_flag_prospect", {"p_prospect_id": m["prospect_id"],
                    "p_reason": "Incoming reply requires manual review because individualized drafting failed: " + str(exc)[:220]})
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
                                            domain=ctx["prospect"].get("domain", ""), pid=pid_m, names=_recipient_names(ctx["prospect"]),
                                            opt_out_text=(kb.get("policy.opt_out.ja", {}).get("body", "").strip()
                                                if drafting.should_use_japanese(ctx["prospect"], ctx.get("messages") or [], inbound_context) else None))
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
    """Renews a claimed lease and records any loss/uncertain renewal."""
    def __init__(self, rpc, job, worker_id, every=60, heartbeat=None):
        self.rpc, self.job, self.wid, self.every, self.heartbeat = rpc, job, worker_id, every, heartbeat
        self.stop, self.lost = threading.Event(), threading.Event()
        self.error = None
    def __enter__(self):
        if self.heartbeat:
            try:
                self.heartbeat()
            except Exception:
                pass
        def beat():
            while not self.stop.wait(self.every):
                try:
                    owned = self.rpc("intel_agent_extend_lease", {"p_job_id": self.job["id"], "p_worker_id": self.wid, "p_seconds": 300})
                    if owned is not True:
                        self.error = "lease renewal rejected"
                        self.lost.set()
                        return
                    if self.heartbeat:
                        try:
                            self.heartbeat()
                        except Exception:
                            # Health telemetry must not invalidate a still-owned job lease.
                            pass
                except Exception as exc:
                    self.error = f"lease renewal uncertain ({type(exc).__name__})"
                    self.lost.set()
                    return
        self.t = threading.Thread(target=beat, daemon=True); self.t.start(); return self
    def __exit__(self, *a):
        self.stop.set()
        self.t.join(timeout=1)


class Worker:
    def __init__(self, deps: Deps, lease_thread: bool = True):
        self.d, self.lease_thread, self._hb = deps, lease_thread, 0.0
        self._active_job = None
        self._last_job_completed_at = None
        self._last_job_error = None

    def _heartbeat(self) -> None:
        d = self.d
        info = {
            "ollama": bool(getattr(d.llm, "is_up", lambda: False)()),
            "chat_llm": getattr(d.llm, "last_backend", "ollama"),
            "worker_version": "1.1.0",
            "pid": __import__("os").getpid(),
            "active_job": self._active_job,
            "last_job_completed_at": self._last_job_completed_at,
            "last_job_error": self._last_job_error,
        }
        d.rpc("intel_agent_heartbeat", {"p_worker_id": d.cfg.worker_id, "p_info": info})

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
            self._heartbeat()
            self.periodic()
            self._hb = d.clock()
        job = d.rpc("intel_agent_claim_job", {"p_worker_id": d.cfg.worker_id, "p_kinds": None, "p_lease_seconds": 300})
        if not job:
            return False
        self.run_job(job)
        return True

    def run_job(self, job) -> None:
        d, h = self.d, HANDLERS.get(job["kind"])
        self._active_job = {"id": job.get("id"), "kind": job.get("kind")}
        lease = _Lease(d.rpc, job, d.cfg.worker_id, heartbeat=self._heartbeat) if self.lease_thread else None
        try:
            if h is None:
                raise PermanentError(f"unknown job kind {job['kind']}")
            if lease:
                lease.__enter__()
            try:
                result = h(d, job)
            finally:
                if lease:
                    lease.__exit__()
            if lease and lease.lost.is_set():
                # The database may already have reclaimed this job. Never mark it
                # complete or failed as the former owner; the new lease owner decides.
                self._last_job_error = "lease lost"
                try:
                    d.rpc("intel_agent_log", {"p_action": "job_lease_lost", "p_entity_type": "job",
                        "p_entity_id": str(job.get("id", "")), "p_detail": {"kind": job.get("kind"), "reason": self._last_job_error}})
                except Exception:
                    pass
                return
            if isinstance(result, dict) and result.get("reason") in DEFER:
                result = {**result, "deferred": True}
            completed = d.rpc("intel_agent_complete_job", {"p_job_id": job["id"], "p_worker_id": d.cfg.worker_id,
                "p_result": result if isinstance(result, dict) else {"value": result}})
            if completed is not True:
                self._last_job_error = "job completion rejected because lease ownership was lost"
                return
            self._last_job_completed_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(d.clock()))
            self._last_job_error = None
        except TransientError as exc:
            if lease and lease.lost.is_set():
                self._last_job_error = "lease lost during transient failure"
                return
            d.rpc("intel_agent_fail_job", {"p_job_id": job["id"], "p_worker_id": d.cfg.worker_id,
                "p_error": f"transient: {exc}", "p_retry_seconds": min(30 * 2 ** max(job["attempts"] - 1, 0), 3600)})
            self._last_job_error = type(exc).__name__
        except (PermanentError, RpcError) as exc:
            if lease and lease.lost.is_set():
                self._last_job_error = "lease lost during failure"
                return
            d.rpc("intel_agent_fail_job", {"p_job_id": job["id"], "p_worker_id": d.cfg.worker_id,
                "p_error": f"permanent: {exc}", "p_retry_seconds": 86400})
            self._last_job_error = type(exc).__name__
        except Exception as exc:  # never let one bad job stop the worker
            if lease and lease.lost.is_set():
                self._last_job_error = "lease lost during unexpected failure"
                return
            d.rpc("intel_agent_fail_job", {"p_job_id": job["id"], "p_worker_id": d.cfg.worker_id,
                "p_error": f"unexpected {type(exc).__name__}: {exc}"[:400], "p_retry_seconds": 300})
            self._last_job_error = type(exc).__name__
            traceback.print_exc()
        finally:
            self._active_job = None

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
