"""Take-over of an existing CRM lead from a conversation the administrator pasted.

Earlier emails were sent by hand or from another mailbox, so Intelligence cannot read them from its own mailbox. The administrator
pastes them in KairFlow; this module reads them and decides ONE next step, then prepares at most ONE draft. It never sends.

Order of authority (each layer can only make the outcome MORE cautious):
  1. Deterministic rules decide whether anything may be written at all: the lead must have an email in the CRM and the prospect must
     be open; a pasted "unsubscribe" or complaint suppresses the address; a decline, a price/contract/meeting/deadline/availability
     message, an out-of-office reply or a finished sequence stops or hands over to the person. The model cannot override these.
  2. The local model only summarises the thread and writes ONE middle paragraph. Everything else in the email (greeting, studio
     facts, links, opt-out sentence, postal address, sign-off) comes from approved text. The paragraph is rejected if it carries a
     link, price, unverifiable claim or nothing from the conversation, and a safe template is used instead.
  3. The draft is saved through intel_agent_upsert_draft, which forces approval for take-over leads and re-checks the CRM email.
     intel_agent_reserve_send checks it again at the moment of sending.
The pasted text is written by people outside the studio: it is only ever shown to the model inside <untrusted> tags.
"""
from __future__ import annotations

import re
from datetime import date, timedelta

from . import drafting, policy
from .errors import PermanentError, RpcError, TransientError

MAX_EMAILS_IN_SEQUENCE = 4          # initial + 3 follow-ups, the same ceiling the CRM review uses
GREEN_INTENTS = {"interested"}

ANALYSIS_SCHEMA = {
    "type": "object", "required": ["summary", "intent"],
    "properties": {
        "summary": {"type": "string", "maxLength": 700},
        "intent": {"type": "string", "enum": ["interested", "asked_question", "negotiating", "declined", "out_of_office", "no_response", "unclear"]},
        "open_questions": {"type": "array", "items": {"type": "string", "maxLength": 200}},
        "language": {"type": "string", "enum": ["en", "ja", "other"]},
    },
}
PARAGRAPH_SCHEMA = {"type": "object", "required": ["paragraph"], "properties": {"paragraph": {"type": "string", "maxLength": 700}}}

ANALYSIS_INSTRUCTION = (
    "Read this email conversation between a small animation studio (US) and a lead (THEM). In at most three sentences say where it stands. "
    "intent: interested = they want to talk or see more; asked_question = they asked something; negotiating = price, terms, contract, deadline, "
    "availability or a meeting; declined = they said no; out_of_office = automatic reply; no_response = we wrote last and they never answered; "
    "unclear = none of these. open_questions = questions THEY asked that are still unanswered (at most five, short). language = the language of the emails."
)
FOLLOWUP_INSTRUCTION = (
    "Write the middle paragraph of a short, polite follow-up email from the studio (US) to THEM that continues the conversation below. "
    "Two or three sentences, at most 400 characters. Mention one concrete thing that was actually said. No greeting, no sign-off, no links, no prices, "
    "no claims about calls, meetings or people we know, and no facts about the studio."
)
REPLY_INSTRUCTION = (
    "Write the middle paragraph of a short, warm reply from the studio (US) to THEM. Thank them and respond only to what THEY wrote last. "
    "Two to four sentences, at most 500 characters. Do not answer detailed questions, do not promise dates, prices or availability, no greeting, "
    "no sign-off, no links. The only facts you may state about the studio are these: {about}"
)
STOP_WORDS = {"studio", "game", "games", "animation", "looking", "would", "about", "while", "which", "there", "their", "thank", "thanks", "email", "please", "hello", "great", "again"}


# ---- dates -----------------------------------------------------------------------------------------------------------------
def to_date(value) -> date | None:
    try:
        return date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError):
        return None


def business_days_between(a: date, b: date) -> int:
    """Same count as the database function intel_business_days_between: weekdays in (a, b]."""
    n, d = 0, a
    while d < b:
        d += timedelta(days=1)
        if d.weekday() < 5:
            n += 1
    return n


def add_business_days(a: date, n: int) -> date:
    d = a
    while n > 0:
        d += timedelta(days=1)
        if d.weekday() < 5:
            n -= 1
    return d


# ---- reading the conversation ----------------------------------------------------------------------------------------------
def build_transcript(history: list[dict], messages: list[dict]) -> list[dict]:
    """Oldest first: [{who: 'us'|'them', at: 'YYYY-MM-DD'|None, subject, body}]. Pasted entries first, then what Intelligence itself sent or received."""
    out: list[dict] = []
    seen: set[tuple] = set()
    for h in sorted(history or [], key=lambda x: x.get("created_at") or ""):
        for e in h.get("entries") or []:
            who = "us" if e.get("direction") == "outbound" else "them" if e.get("direction") == "inbound" else None
            body = str(e.get("body") or "").strip()
            if not who or not body:
                continue
            key = (who, re.sub(r"\s+", " ", body)[:300])
            if key in seen:           # the same message pasted twice (overlapping threads)
                continue
            seen.add(key)
            out.append({"who": who, "at": to_date(e.get("at")) and str(e["at"])[:10], "subject": str(e.get("subject") or "").strip(), "body": body})
    for m in messages or []:
        if m.get("subject") == "Imported from CRM history":
            continue
        if m.get("direction") == "outbound" and m.get("state") == "sent":
            out.append({"who": "us", "at": (m.get("sent_at") or m.get("created_at") or "")[:10] or None, "subject": m.get("subject") or "", "body": m.get("body_text") or ""})
        elif m.get("direction") == "inbound":
            out.append({"who": "them", "at": (m.get("received_at") or m.get("created_at") or "")[:10] or None, "subject": m.get("subject") or "", "body": m.get("body_text") or ""})
    # stable by date; undated pasted messages keep their order and stay where they were pasted
    dated = [(i, t) for i, t in enumerate(out)]
    last = ""
    keyed = []
    for i, t in dated:
        last = t["at"] or last
        keyed.append((last, i, t))
    keyed.sort(key=lambda x: (x[0], x[1]))
    return [t for _, _, t in keyed]


def real_turns(transcript: list[dict]) -> list[dict]:
    """The conversation without automatic replies and bounces: those are not a person answering."""
    return [t for t in transcript if not (t["who"] == "them" and (policy.is_auto_reply(t["subject"], t["body"]) or policy.is_bounce("", t["subject"])))]


def render(transcript: list[dict], limit: int = 9000) -> str:
    """Text for the model. The newest messages are kept when the thread is long."""
    parts = []
    for t in transcript:
        body = policy.first_unquoted(t["body"]) or t["body"]
        head = f"[{t['at'] or 'date unknown'}] {'US' if t['who'] == 'us' else 'THEM'}" + (f" - subject: {t['subject']}" if t["subject"] else "")
        parts.append(f"{head}\n{body[:1400]}")
    text, total = [], 0
    for p in reversed(parts):
        if total + len(p) > limit and text:
            break
        text.append(p)
        total += len(p) + 2
    return "\n\n".join(reversed(text))


def _grounded(paragraph: str, source: str) -> bool:
    words = {w for w in re.findall(r"[a-z]{5,}", source.lower()) if w not in STOP_WORDS}
    mine = {w for w in re.findall(r"[a-z]{5,}", paragraph.lower()) if w not in STOP_WORDS}
    return bool(words & mine)


def valid_paragraph(text: str, source: str, kb: dict) -> str | None:
    s = re.sub(r"[ \t]+", " ", str(text or "")).strip()
    if not (30 <= len(s) <= 600) or "\n\n" in s or "@" in s:
        return None
    if policy.URL.search(s) or policy.PRICE_IN_DRAFT.search(s) or policy.FALSE_CLAIMS.search(s):
        return None
    if not _grounded(s, source):
        return None
    return s


# ---- the decision ----------------------------------------------------------------------------------------------------------
def decide(transcript: list[dict], ctx: dict, settings: dict, intent: str) -> dict:
    """Deterministic outcome: {next_action, reason, kind?, due_on?}. next_action: follow_up | reply | wait | needs_human | stop | none."""
    p, lead = ctx["prospect"], ctx.get("lead") or {}
    turns = real_turns(transcript)
    them = [t for t in turns if t["who"] == "them"]

    # hard stops written by the lead, anywhere in the thread
    for t in them:
        hits = policy.scan_inbound(t["subject"], t["body"])["hits"]
        if "unsubscribe" in hits or "complaint" in hits:
            return {"next_action": "stop", "reason": "They asked not to be contacted (or complained). The address was added to the suppression list.",
                    "suppress": "complaint" if "complaint" in hits and "unsubscribe" not in hits else "unsubscribe"}
    if not turns:
        return {"next_action": "none", "reason": "Only automatic replies were found in the pasted conversation."}

    last = turns[-1]
    anchor = max([d for d in [to_date((p.get("takeover") or {}).get("last_contact"))] + [to_date(t["at"]) for t in transcript] if d] or [None], default=None)
    if last["who"] == "them":
        hits = policy.scan_inbound(last["subject"], last["body"])["hits"]
        if "decline" in hits or intent == "declined":
            return {"next_action": "stop", "reason": "They said they are not interested. No follow-up was written."}
        sensitive = [h for h in ("pricing", "negotiation", "contract", "deadline", "availability", "meeting") if h in hits]
        if sensitive or intent == "negotiating":
            what = ", ".join(sensitive) if sensitive else "terms or scheduling"
            return {"next_action": "needs_human", "reason": f"Their last message is about {what}. A person should answer it."}
        if intent == "out_of_office":
            return {"next_action": "wait", "reason": "Their last message was an automatic reply."}
        if intent in GREEN_INTENTS or "portfolio" in hits or "interest" in hits:
            return {"next_action": "reply", "kind": "reply", "reason": "They replied with interest. A reply is ready for your approval."}
        return {"next_action": "needs_human", "reason": "They wrote last and the message needs a person to read it (a question or something unclear)."}

    # we wrote last
    ours = [t for t in turns if t["who"] == "us"]
    sent_total = max(len(ours), sum(1 for f in (lead.get("sent_flags") or []) if f))
    if sent_total >= MAX_EMAILS_IN_SEQUENCE:
        return {"next_action": "stop", "reason": f"{sent_total} emails were already sent: the sequence is finished."}
    intel_follow = [m for m in ctx.get("messages", []) if m.get("kind") == "followup" and m.get("state") not in ("discarded", "failed")]
    if len(intel_follow) >= int(settings.get("max_followups", 1)):
        return {"next_action": "none", "reason": f"Intelligence's own follow-up limit ({settings.get('max_followups', 1)}) is reached for this lead."}
    live = [m for m in intel_follow if m.get("state") in ("draft", "pending_approval", "approved", "reserved", "sending", "unknown")]
    if live:
        return {"next_action": "none", "reason": "A follow-up is already waiting for your approval."}
    days = int(settings.get("followup_business_days", 7))
    today = to_date(settings.get("today")) or date.today()
    if anchor is None:
        return {"next_action": "needs_human", "reason": "No date is known for the newest message."}
    waited = business_days_between(anchor, today)
    if waited < days:
        return {"next_action": "wait", "reason": f"Not due yet: {waited} of {days} business days since {anchor.isoformat()}.", "due_on": add_business_days(anchor, days).isoformat()}
    return {"next_action": "follow_up", "kind": "followup", "reason": f"{waited} business days since the last message and no reply."}


def next_slot(p: dict, lead: dict | None, transcript: list[dict]) -> int:
    """CRM email slot (1..3) this follow-up fills: after the emails already sent, by hand or by Intelligence."""
    ours = sum(1 for t in real_turns(transcript) if t["who"] == "us")
    try:
        first_free = drafting.next_step({**p, "origin": "crm_existing"}, lead, 0)
    except PermanentError:
        first_free = drafting.MAX_STEP + 1
    step = max(first_free, min(ours, drafting.MAX_STEP + 1), 1)
    if step > drafting.MAX_STEP:
        raise PermanentError("every follow-up slot on this lead was already used")
    return step


def _subject_for(thread: list[dict], p: dict, reply: bool) -> str | None:
    subs = [t["subject"] for t in reversed(thread) if t["subject"]]
    base = subs[0] if subs else None
    if reply and not base:
        base = drafting.SUBJECT[p["type"]].format(name=p["name"])
    if reply and base and not re.match(r"(?i)^re:", base):
        base = f"Re: {base}"
    return base


def draft_followup(d, p: dict, kb: dict, st: dict, thread: list[dict], convo: str) -> dict:
    last_out = next((t for t in reversed(thread) if t["who"] == "us"), None)
    sent_on = (last_out or {}).get("at") or "recently"
    subject = _subject_for(thread, p, reply=False)
    if not drafting.is_japanese_animation_prospect(p):
        try:
            para = d.llm.generate_json(FOLLOWUP_INSTRUCTION, convo, PARAGRAPH_SCHEMA)["paragraph"]
        except TransientError:
            raise
        except Exception:
            para = ""
        para = valid_paragraph(para, convo, kb)
        if para:
            body = "\n\n".join([drafting.greeting(p), para, kb["portfolio.main"]["body"].strip()]) + "\n" + policy.compliance_footer(st)
            subj = (subject if subject and re.match(r"(?i)^re:", subject) else f"Re: {subject}") if subject else drafting.SUBJECT[p["type"]].format(name=p["name"])
            return {"subject": subj[:120], "body": body, "model_written": True}
    mail = drafting.build_followup(p, kb, st, sent_on, subject)
    return {**mail, "model_written": False}


def draft_reply(d, p: dict, kb: dict, st: dict, thread: list[dict], convo: str, hits: set[str]) -> dict | None:
    subject = _subject_for(thread, p, reply=True)
    if not drafting.is_japanese_animation_prospect(p) and kb.get("studio.about") and kb.get("portfolio.main"):
        try:
            para = d.llm.generate_json(REPLY_INSTRUCTION.format(about=kb["studio.about"]["body"].strip()[:600]), convo, PARAGRAPH_SCHEMA)["paragraph"]
        except TransientError:
            raise
        except Exception:
            para = ""
        para = valid_paragraph(para, convo, kb)
        if para:
            body = "\n\n".join([drafting.greeting(p), para, kb["portfolio.main"]["body"].strip(),
                                f"I will follow up personally on anything specific.\n\n{st.get('sender_name', '').strip()}"]) + "\n"
            return {"subject": subject[:120], "body": body, "model_written": True}
    label = "portfolio_request" if "portfolio" in hits else "positive"
    mail = drafting.build_auto_reply(label, p, kb, st, subject or "")
    return {**mail, "model_written": False} if mail else None


# ---- the job ---------------------------------------------------------------------------------------------------------------
def _save(d, pid: str, result: dict, notify: str | None = None, suppress: str | None = None):
    return d.rpc("intel_agent_takeover_result", {"p_prospect_id": pid, "p_takeover": result, "p_notify": notify, "p_suppress": suppress})


def handle(d, job: dict) -> dict:
    pl = job["payload"]
    pid = pl["prospect_id"]
    manual = bool(pl.get("manual"))
    ctx = d.rpc("intel_agent_context", {"p_prospect_id": pid})
    if not ctx or not ctx.get("prospect"):
        return {"skipped": "prospect not found"}
    p, lead = ctx["prospect"], ctx.get("lead") or {}
    history = ctx.get("history") or []
    if not history:
        return {"skipped": "no pasted conversation"}
    hid = history[-1]["id"]
    base = {"history_id": hid, "last_contact": (p.get("takeover") or {}).get("last_contact") or history[-1].get("last_contact"), "messages": sum(len(h.get("entries") or []) for h in history)}
    if p["status"] in ("closed", "rejected", "suppressed"):
        return {"skipped": f"prospect is {p['status']}"}
    try:
        return _run(d, job, ctx, p, lead, history, hid, base, manual)
    except TransientError as exc:
        if job.get("attempts", 1) >= job.get("max_attempts", 5):      # out of retries: tell the person instead of leaving "Reading…" forever
            _save(d, pid, {**base, "state": "failed", "error": f"Could not reach the local model after several tries: {exc}"[:300]})
        raise
    except PermanentError as exc:
        _save(d, pid, {**base, "state": "failed", "error": str(exc)[:300]})
        raise
    except RpcError:
        raise


def _run(d, job, ctx, p, lead, history, hid, base, manual) -> dict:
    pid = p["id"]
    st, kb = d.rpc("intel_agent_settings", {}), drafting.kb_map(d.rpc("intel_agent_kb", {}) or [])
    thread = build_transcript(history, ctx.get("messages") or [])
    turns = real_turns(thread)
    last_speaker = turns[-1]["who"] if turns else None
    base = {**base, "last_speaker": "inbound" if last_speaker == "them" else "outbound" if last_speaker == "us" else None}

    # The email rule, first: no CRM email, no analysis-driven contact.
    crm_email = str(lead.get("email") or "").strip().lower()
    if not crm_email or "@" not in crm_email or crm_email != str(p.get("contact_email") or "").strip().lower():
        res = {**base, "state": "ready", "next_action": "stop", "reason": "This lead has no email address in the CRM (or it differs from the one Intelligence has). Add or fix the email on the lead, then press Re-analyse."}
        _save(d, pid, res, notify=res["reason"])
        return {"next_action": "stop", "why": "no_crm_email"}

    # Scheduled runs must not repeat work for the same conversation.
    convo = render(thread)
    hard = decide(thread, ctx, st, intent="unclear")      # deterministic stops come before any model call
    if hard["next_action"] == "stop" and hard.get("suppress"):
        res = {**base, "state": "ready", "next_action": "stop", "reason": hard["reason"], "summary": ""}
        _save(d, pid, res, notify=hard["reason"], suppress=hard["suppress"])
        return {"next_action": "stop", "suppressed": True}

    try:
        a = d.llm.generate_json(ANALYSIS_INSTRUCTION, convo, ANALYSIS_SCHEMA)
    except PermanentError:
        raise
    summary, intent = str(a.get("summary") or "")[:700], a.get("intent", "unclear")
    questions = [str(q)[:200] for q in (a.get("open_questions") or [])][:5]
    # the model's read of intent can only add caution: re-decide with it
    out = decide(thread, ctx, st, intent=intent)
    res = {**base, "state": "ready", "summary": summary, "intent": intent, "open_questions": questions, "language": a.get("language", "en"),
           "next_action": out["next_action"], "reason": out["reason"]}
    if out.get("due_on"):
        res["due_on"] = out["due_on"]

    if out["next_action"] not in ("follow_up", "reply"):
        _save(d, pid, res, notify=out["reason"] if out["next_action"] == "needs_human" else None)
        return {"next_action": out["next_action"]}

    kind = out["kind"]
    step = 0
    if kind == "followup":
        step = next_slot(p, lead, thread)
    key = f"takeover:{hid}:{kind}:{step}" + (f":{str(job.get('id', ''))[:8]}" if manual else "")
    if not manual and any(m.get("idempotency_key") == key for m in ctx.get("messages") or []):
        res.update({"next_action": "none", "reason": "A draft for this conversation was already prepared. Re-analyse to write a new one."})
        _save(d, pid, {**res, **{k: v for k, v in (p.get("takeover") or {}).items() if k in ("draft_message_id",)}})
        return {"skipped": "already drafted"}

    try:
        drafting.require_kb(kb, p["type"])
    except PermanentError as exc:
        res.update({"next_action": "needs_human", "reason": f"A draft could not be written: {exc}"})
        _save(d, pid, res, notify=res["reason"])
        return {"next_action": "needs_human"}

    if kind == "followup":
        mail = draft_followup(d, p, kb, st, thread, convo)
        email_kind = "followup"
    else:
        hits = policy.scan_inbound(turns[-1]["subject"], turns[-1]["body"])["hits"]
        mail = draft_reply(d, p, kb, st, thread, convo, hits)
        email_kind = "reply"
        if mail is None:
            res.update({"next_action": "needs_human", "reason": "A safe reply could not be written automatically. A person should answer."})
            _save(d, pid, res, notify=res["reason"])
            return {"next_action": "needs_human"}

    localized = kb.get("policy.opt_out.ja", {}).get("body", "").strip() if drafting.is_japanese_animation_prospect(p) else None
    bad = policy.validate_outbound(mail["subject"], mail["body"], st, drafting.approved_urls(kb), email_kind, p.get("domain", ""), opt_out_text=localized)
    if bad:
        d.rpc("intel_agent_log", {"p_action": "draft_blocked", "p_entity_type": "prospect", "p_entity_id": pid, "p_detail": {"violations": bad, "source": "takeover"}})
        res.update({"next_action": "needs_human", "reason": "The draft failed the safety checks (" + "; ".join(bad)[:160] + "). A person should write this one."})
        _save(d, pid, res, notify=res["reason"])
        return {"next_action": "needs_human", "violations": bad}

    r = d.rpc("intel_agent_upsert_draft", {"p_prospect_id": pid, "p_kind": email_kind, "p_step": step, "p_subject": mail["subject"], "p_body": mail["body"],
                                           "p_idempotency_key": key, "p_to_email": p["contact_email"], "p_auto_ok": False, "p_in_reply_to": None, "p_references": None})
    if not r.get("ok"):
        res.update({"next_action": "needs_human", "reason": f"The draft was refused: {r.get('reason', 'unknown')}."})
        _save(d, pid, res, notify=res["reason"])
        return {"next_action": "needs_human", "refused": r.get("reason")}
    res.update({"draft_message_id": r.get("message_id"), "drafted_by_model": bool(mail.get("model_written")), "step": step})
    _save(d, pid, res)
    return {"next_action": out["next_action"], "message_id": r.get("message_id"), "created": r.get("created")}
