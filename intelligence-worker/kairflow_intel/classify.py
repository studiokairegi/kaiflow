"""Reply classification. Order: auto-reply and bounce detection, hard deterministic rules, then the model for the rest.
The model can only choose among the allowed labels, and it can never downgrade a hard rule."""
from __future__ import annotations

from . import policy

LABELS = ["positive", "meeting_request", "pricing", "negotiation", "portfolio_request", "project_opportunity", "rejection", "unsubscribe", "ambiguous", "complaint", "other"]
SCHEMA = {"type": "object", "required": ["label", "confidence", "summary"], "properties": {
    "label": {"type": "string", "enum": LABELS},
    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
    "summary": {"type": "string", "maxLength": 240}}}
AUTO_REPLY_OK = {"positive", "portfolio_request"}      # simple, approved-content replies only
MIN_CONFIDENCE = 0.7


def classify(msg: dict, own_addresses: set[str], llm=None) -> dict:
    """Returns {class, confidence, escalate, summary, related_email, auto_ok}. `llm` is a callable(subject, body)->dict or None."""
    subject, body, frm = msg.get("subject", ""), msg.get("body_text", ""), msg.get("from_email", "")
    if policy.is_bounce(frm, subject):
        rel, perm = policy.bounce_details(body, own_addresses)
        return _r("bounce", 1.0, False, "Delivery failed" + (f" for {rel}" if rel else ""), related=rel if perm else None)
    if policy.is_auto_reply(subject, body, msg.get("headers")):
        return _r("out_of_office", 1.0, False, "Automatic reply")
    hits = policy.scan_inbound(subject, body)["hits"]
    hard = policy.hard_class(hits)
    if hard == "unsubscribe":
        return _r("unsubscribe", 1.0, False, "Asked not to be contacted")
    if hard == "complaint":
        return _r("complaint", 1.0, True, "Complaint or privacy request: needs you")
    if hard:
        return _r({"contract": "negotiation", "meeting": "meeting_request"}.get(hard, hard), 0.95, True, f"Mentions {hard}: needs you")
    if "decline" in hits and not hits & {"interest", "portfolio", "meeting"}:
        return _r("rejection", 0.9, False, "Declined")
    label, conf, summary = None, 0.0, ""
    if llm:
        try:
            out = llm(subject, policy.first_unquoted(body))
            label, conf, summary = out["label"], float(out["confidence"]), out.get("summary", "")
        except Exception:
            label = None
    if label is None:  # model unavailable or invalid: fall back to simple keyword reading, conservatively
        if "portfolio" in hits: label, conf = "portfolio_request", 0.75
        elif "meeting" in hits: label, conf = "meeting_request", 0.75
        elif "interest" in hits: label, conf = "positive", 0.7
        else: label, conf = "ambiguous", 0.0
    if conf < MIN_CONFIDENCE:
        label = "ambiguous"
    if label in ("rejection",) and ("interest" in hits or "portfolio" in hits):
        label = "ambiguous"            # the words disagree with the model: a person decides
    esc = label in policy.ESCALATE_CLASSES
    return _r(label, conf, esc, summary or label.replace("_", " ").capitalize())


def _r(c, conf, esc, summary, related=None):
    return {"class": c, "confidence": conf, "escalate": esc, "summary": summary, "related_email": related, "auto_ok": c in AUTO_REPLY_OK and not esc}
