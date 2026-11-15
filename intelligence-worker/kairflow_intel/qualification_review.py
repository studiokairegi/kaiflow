"""Phase 6 - ambiguous-evidence review helper for qualification.

scoring.py is and remains the only thing that produces a score, a decision or a breakdown ("The model
never produces a score."). This module never touches any of those. It only ever runs for a result
scoring.py already decided is "needs_review", and only ever adds a short, human-readable note next to
that decision explaining what is ambiguous and what a reviewer should check - it cannot requalify,
reject, approve or score anything.

With no model available (llm is None), or when a model call fails, times out, or its answer cannot be
grounded in the same verified evidence that produced the score, this degrades to a deterministic
explanation built only from the breakdown and the `uncertain` list scoring.py already produced. The
feature therefore works with or without Gemini (Global Implementation Rule: "Gemini must not be forced
into every operation") and a reviewer is never shown a claim that is not already backed by evidence on
the prospect's own record.

This is read-only with respect to safeguards: it never calls any RPC, never touches suppression,
kill-switch, sending limits or CRM records, and a failure here can never fail, retry or block the
qualification job that calls it (every code path returns a dict; nothing raises).
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from collections import deque

from . import ai_call

SITE = "research.qualification_review"
CONFIDENCE_LEVELS = ("low", "medium", "high")
MAX_FIELD_CHARS = 400
MAX_EVIDENCE_ROWS = 20

INSTRUCTION = (
    "You are helping a human reviewer understand why an automated prospect-qualification score landed in "
    "the needs-review range, between the reject and qualify thresholds. You are given the deterministic "
    "score breakdown, the criteria scoring.py flagged as uncertain, and the verified evidence snippets that "
    "produced the score. Write a short, neutral note on what is genuinely ambiguous in that evidence. Ground "
    "every sentence only in the breakdown, uncertain list and evidence given to you. Never invent a fact, a "
    "contact person, a budget, a production capability or a business relationship that is not already there. "
    "Never recommend qualifying or rejecting outright - only say what a human should check next. Return "
    "strict JSON matching the schema and nothing else."
)

SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string", "description": "One or two sentences on what is ambiguous."},
        "key_uncertainty": {"type": "string", "description": "The single most important open question."},
        "confidence": {"type": "string", "enum": list(CONFIDENCE_LEVELS), "description": "How confident a human should be that this evidence, once resolved, points toward qualifying."},
        "recommended_human_action": {"type": "string", "description": "What the reviewer should look at or verify next."},
    },
    "required": ["summary", "key_uncertainty", "confidence", "recommended_human_action"],
}

_STOPWORDS = frozenset({
    "score", "review", "would", "could", "evidence", "studio", "criterion", "criteria", "needs", "human",
    "action", "before", "deciding", "direct", "directly", "should", "these", "which", "there", "their", "about",
    "between", "qualify", "reject", "decide", "check", "verify", "given", "fallen", "falls", "range",
    "whether", "only", "verified", "unverified", "independently", "source", "sources", "genuinely",
    "partial", "partially", "credited", "appears", "remains", "unclear",
    "points", "point", "scored", "credit", "credits",
    "against", "shows", "show", "shown", "indicate", "indicates", "suggest", "suggests", "enough", "further", "reflects",
})
_EMAIL = re.compile(r"[^@\s]+@[^@\s]+\.[A-Za-z]{2,}")
_PHONE = re.compile(r"\+?\d[\d\s().-]{7,}\d")
_TOKEN = re.compile(r"[a-z0-9]+")


DEFAULT_MAX_MODEL_NOTES_PER_HOUR = 30
_calls: deque = deque()
_calls_lock = threading.Lock()


def _model_budget_allows(now: float | None = None) -> bool:
    """Process-wide cap on model-written notes per rolling hour (env KAIRFLOW_QUAL_REVIEW_MAX_PER_HOUR; 0 turns the
    model path off). A backlog re-score therefore cannot spend unbounded requests on explanations; over the cap the
    deterministic note is used. Invalid env values fall back to the default."""
    try:
        limit = int(os.environ.get("KAIRFLOW_QUAL_REVIEW_MAX_PER_HOUR", DEFAULT_MAX_MODEL_NOTES_PER_HOUR))
    except ValueError:
        limit = DEFAULT_MAX_MODEL_NOTES_PER_HOUR
    if limit <= 0:
        return False
    t = time.time() if now is None else now
    with _calls_lock:
        while _calls and t - _calls[0] > 3600:
            _calls.popleft()
        if len(_calls) >= limit:
            return False
        _calls.append(t)
        return True


def confidence_indicator(res, qualify_min: int | float, review_min: int | float) -> dict:
    """Deterministic confidence in a decision of ANY kind (qualified / needs_review / rejected), from the score's
    distance to the nearest threshold and how many criteria scoring.py flagged uncertain. No model. Never raises.
    A rejection caused by a failed mandatory gate is high confidence: no score could have changed it."""
    try:
        score, decision = _num(res.score), getattr(res, "decision", None)
        uncertain = len(res.uncertain or [])
        gates = getattr(res, "mandatory_gates", None) or {}
        if decision == "rejected" and any(isinstance(v, dict) and not v.get("passed") for v in gates.values()):
            return {"level": "high", "basis": "a mandatory gate failed; the score cannot change this outcome", "margin": None, "uncertain_count": uncertain, "generated_by": "deterministic"}
        margin = (score - qualify_min if decision == "qualified" else review_min - score if decision == "rejected"
                  else min(score - review_min, qualify_min - score))
        level = "high" if margin >= 15 and uncertain <= 1 else "medium" if margin >= 7 and uncertain <= 2 else "low"
        return {"level": level, "basis": f"{abs(margin):g} points from the nearest threshold, {uncertain} uncertain criteria", "margin": margin, "uncertain_count": uncertain, "generated_by": "deterministic"}
    except Exception:
        return {"level": "low", "basis": "confidence could not be computed", "margin": None, "uncertain_count": None, "generated_by": "deterministic"}


_ISO_DATE_START = re.compile(r"^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}")


def _phone_sub(m: "re.Match") -> str:
    """Only a real phone-sized number is redacted. Dates (2023-05-17), year ranges (2019-2023) and similar digit runs are the
    evidence the note is about (release / update dates), so they are kept: a phone has >= 9 digits (>= 8 with a leading +)
    and does not start like an ISO date."""
    tok = m.group(0)
    digits = sum(c.isdigit() for c in tok)
    if _ISO_DATE_START.match(tok.lstrip("+")) or digits < (8 if tok.startswith("+") else 9):
        return tok
    return "[phone]"


def _redact(text: str) -> str:
    """Contact details never go to the cloud model: the note explains scoring ambiguity, it does not need them."""
    return _PHONE.sub(_phone_sub, _EMAIL.sub("[email]", str(text or "")))


def _redact_obj(v):
    """Redact every string BEFORE JSON encoding (redacting the encoded text could consume JSON quotes around an address)."""
    if isinstance(v, str):
        return _redact(v)
    if isinstance(v, dict):
        return {k: _redact_obj(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_redact_obj(x) for x in v]
    return v


def _stem(w: str) -> str:
    if len(w) > 5 and w.endswith("ies"):
        return w[:-3] + "y"           # capabilities -> capability
    for suf in ("ing", "ed", "es", "s"):
        if len(w) > len(suf) + 3 and w.endswith(suf):
            return w[: -len(suf)]
    return w


def _tokens(text: str) -> set[str]:
    return {_stem(t) for t in _TOKEN.findall(str(text or "").lower().replace("_", " "))}


def _item_name(item) -> str:
    """scoring.py names a studio sub-item under 'item' and a group/indie row under 'criterion'; accept both
    (and 'name') and never return None."""
    if not isinstance(item, dict):
        return ""
    return str(item.get("item") or item.get("criterion") or item.get("name") or "").strip()


def _num(v, default=0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _failed_gates(res) -> list[tuple[str, str]]:
    gates = getattr(res, "mandatory_gates", None) or {}
    return [(str(k), str((v or {}).get("reason") or "")) for k, v in gates.items() if isinstance(v, dict) and v.get("passed") is not True]


def _breakdown_text(res) -> str:
    """Everything scoring.py recorded about WHY, at group level (indie rows are flat: criterion/points/max/why;
    studio rows are groups with sub-items) and for failed mandatory gates. This is the grounding source."""
    parts = []
    for row in (getattr(res, "breakdown", None) or []):
        if not isinstance(row, dict):
            continue
        parts += [_item_name(row), str(row.get("why") or ""), str(row.get("status") or "")]
        for item in (row.get("items") or []):
            if isinstance(item, dict):
                parts += [_item_name(item), str(item.get("signal") or ""), str(item.get("evidence") or ""), str(item.get("why") or "")]
    for name, reason in _failed_gates(res):
        parts += [name, reason]
    return " ".join(parts)


def _numbers_text(res) -> str:
    """The score and the per-row points/max are part of what the model is given, so a note that repeats them ("5 of 15
    points", "scored 60") is grounded. Thresholds are NOT given to the model, so a note citing them stays ungrounded."""
    parts = [str(getattr(res, "score", ""))]
    for row in (getattr(res, "breakdown", None) or []):
        if not isinstance(row, dict):
            continue
        parts += [str(row.get("points", "")), str(row.get("max", ""))]
        for item in (row.get("items") or []):
            if isinstance(item, dict):
                parts += [str(item.get("points", "")), str(item.get("max", ""))]
    return " ".join(p for p in parts if p not in ("", "None"))


def _deterministic_fallback(res) -> dict:
    """Built only from what scoring.py already decided. No model, no network, never ungrounded.
    Tolerant of any breakdown shape: a malformed row is skipped, never an exception."""
    try:
        uncertain_names = [str(u) for u in (res.uncertain or [])]
        gate_names = [k for k, _ in _failed_gates(res)]
        if uncertain_names:
            uncertain = ", ".join(uncertain_names)
        elif gate_names:
            uncertain = "mandatory gate(s) not passed: " + ", ".join(gate_names)
        else:
            uncertain = "no single criterion was flagged as uncertain"
        partial: list[str] = []
        for row in (res.breakdown or []):
            if not isinstance(row, dict):
                continue
            name = _item_name(row)
            if name and 0 < _num(row.get("points")) < _num(row.get("max")):
                partial.append(name)
            for item in (row.get("items") or []):
                iname = _item_name(item)
                if iname and 0 < _num(item.get("points")) < _num(item.get("max")) and iname not in partial:
                    partial.append(iname)
        action = (
            "Check the partially-credited criteria (" + ", ".join(partial[:5]) + ") against the source evidence before deciding."
            if partial else "Review the evidence rows directly before deciding."
        )
        summary = f"Score {res.score} fell between the review and qualify thresholds. {res.reason or ''}".strip()
    except Exception:
        uncertain, action, summary = "see the score breakdown", "Review the evidence rows directly before deciding.", "This prospect fell in the needs-review range."
    return {
        "summary": summary[:MAX_FIELD_CHARS],
        "key_uncertainty": uncertain[:MAX_FIELD_CHARS],
        "confidence": None,           # not rated: a fixed value here would look like a judgement nobody made
        "recommended_human_action": action[:MAX_FIELD_CHARS],
        "generated_by": "deterministic_fallback",
    }


def _evidence_text(evidence_rows: list[dict] | None) -> str:
    return " ".join(str(e.get("snippet") or "") for e in (evidence_rows or []) if e.get("verified"))


def _grounded(text: str, source_text: str, *, min_ratio: float = 0.7) -> bool:
    """Whole-word (lightly stemmed) check against the verified evidence, reason, uncertain list and breakdown.
    Fails when: any number in the note is absent from the source; any mid-sentence capitalised name is absent;
    or fewer than `min_ratio` of its content words (5+ letters) appear in the source."""
    source_tokens = _tokens(source_text)
    for num in re.findall(r"\d+", text):
        if num not in {t for t in _TOKEN.findall(source_text.lower())}:
            return False
    for name in re.findall(r"(?<![.!?]\s)(?<!^)\b[A-Z][a-zA-Z]{2,}", text):
        if _stem(name.lower()) not in source_tokens:
            return False
    words = [w for w in re.findall(r"[a-z]{5,}", text.lower()) if w not in _STOPWORDS]
    if not words:
        return True
    hits = sum(1 for w in words if _stem(w) in source_tokens)
    return (hits / len(words)) >= min_ratio


def _payload(res, evidence_rows: list[dict] | None) -> str:
    breakdown = []
    for row in (res.breakdown or []):
        if not isinstance(row, dict):
            continue
        breakdown.append({
            "criterion": _item_name(row), "points": row.get("points"), "max": row.get("max"),
            "why": row.get("why"), "status": row.get("status"),
            "items": [{"item": _item_name(i), "points": i.get("points"), "max": i.get("max"), "evidence": str(i.get("evidence") or "")[:200]}
                      for i in (row.get("items") or []) if isinstance(i, dict)],
        })
    evidence = [
        {"fact_type": e.get("fact_type"), "snippet": _redact(e.get("snippet"))}
        for e in (evidence_rows or []) if e.get("verified") and e.get("snippet")
    ][:MAX_EVIDENCE_ROWS]
    data = {"score": res.score, "reason": res.reason, "uncertain": res.uncertain, "failed_mandatory_gates": [{"gate": k, "reason": r} for k, r in _failed_gates(res)],
            "breakdown": breakdown, "evidence": evidence}
    return json.dumps(_redact_obj(data), sort_keys=True, default=str)


def explain_ambiguous(llm, res, evidence_rows: list[dict] | None = None, *, rec: list | None = None) -> dict | None:
    """Returns an explanation dict, or None when `res.decision` is not "needs_review".

    Never raises. `rec`, when given, receives the model call's provenance the same way drafting.py's
    `rec` lists do, so a caller can stamp which provider/model (if any) wrote the note.
    """
    if getattr(res, "decision", None) != "needs_review":
        return None
    fallback = _deterministic_fallback(res)
    if llm is None or not _model_budget_allows():
        return fallback
    try:
        data, prov = ai_call.call_json(llm, SITE, INSTRUCTION, _payload(res, evidence_rows), SCHEMA, fast=True)
    except Exception:
        return fallback
    try:
        if not isinstance(data, dict) or data.get("confidence") not in CONFIDENCE_LEVELS:
            return fallback
        source = " ".join([_evidence_text(evidence_rows), _breakdown_text(res), _numbers_text(res), str(res.reason or ""), " ".join(str(u) for u in (res.uncertain or []))])
        out = {}
        for field in ("summary", "key_uncertainty", "recommended_human_action"):
            value = str(data.get(field) or "").strip()
            if not value or len(value) > MAX_FIELD_CHARS or not _grounded(value, source):
                return fallback
            out[field] = value
        out["confidence"] = data["confidence"]
        out["generated_by"] = "model"
        if rec is not None:
            rec.append(prov)
            out["ai"] = prov
        return out
    except Exception:
        return fallback
