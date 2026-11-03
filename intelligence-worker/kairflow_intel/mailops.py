"""Sending and reading mail with crash-safe, never-duplicating semantics.

Send is two-phase and the database is the arbiter:
  reserve (kill switch, caps, suppression, compliance all checked atomically)  ->  mark_sending  ->  Zoho  ->  confirm.
If the process dies or the network drops after Zoho may have accepted the message, the message stays `sending`/`unknown`.
It is NEVER resent: reconcile() looks for our token in Zoho's Sent folder and only then settles it."""
from __future__ import annotations

import re
import time
from datetime import datetime, timezone

from .errors import PermanentError, RpcError, TransientError
from .zoho import ZohoRejected

TOKEN_RE = re.compile(r"\bkf[0-9a-f]{32}\b")


def _iso(ms: int | None) -> str | None:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat() if ms else None


def with_ref(body: str, token: str) -> str:
    return body if token in body else body.rstrip() + f"\n\nRef: {token}\n"


def send_message(rpc, zoho, message_id: str) -> dict:
    res = rpc("intel_agent_reserve_send", {"p_message_id": message_id})
    if not res.get("ok"):
        return {"sent": False, "reason": res.get("reason", "denied")}
    m = res["message"]
    if not rpc("intel_agent_mark_sending", {"p_message_id": m["id"]}):
        return {"sent": False, "reason": "not_reserved"}
    try:
        out = zoho.send(m["from_email"], m["to_email"], m["subject"], with_ref(m["body_text"], m["token"]))
    except ZohoRejected as exc:                       # definitive: Zoho said no, nothing was sent
        permanent = bool(re.search(r"invalid|not a valid|mailbox|recipient", str(exc), re.I))
        rpc("intel_agent_fail_send", {"p_message_id": m["id"], "p_error": str(exc)[:300], "p_permanent": permanent})
        return {"sent": False, "reason": "rejected"}
    except (TransientError, Exception) as exc:        # outcome unknown: the message may have gone out
        rpc("intel_agent_mark_unknown", {"p_message_id": m["id"], "p_error": f"{type(exc).__name__}: {exc}"[:300]})
        return {"sent": False, "reason": "unknown"}
    rfc = ""
    try:
        found = zoho.find_sent(m["token"], m["to_email"], int(time.time() * 1000) - 600_000)
        rfc = (found or {}).get("rfc_message_id", "")
    except Exception:
        pass                                           # headers are an optional extra: the token still matches replies
    try:
        rpc("intel_agent_confirm_send", {"p_message_id": m["id"], "p_zoho_message_id": out["zoho_message_id"], "p_rfc_message_id": rfc,
                                         "p_thread_id": out["thread_id"], "p_sent_at": None})
    except Exception:
        return {"sent": True, "reason": "confirm_pending"}   # stays `sending`; reconcile() settles it without resending
    return {"sent": True, "reason": "ok"}


def reconcile(rpc, zoho) -> dict:
    """Settle messages stuck in sending/unknown by checking Zoho's Sent folder. Never resends."""
    counts = {"confirmed": 0, "absent": 0, "left": 0}
    for m in rpc("intel_agent_stale_sends", {"p_older_than_seconds": 600}) or []:
        try:
            since = int((datetime.fromisoformat(m["reserved_at"].replace("Z", "+00:00")).timestamp() - 300) * 1000) if m.get("reserved_at") else 0
            found = zoho.find_sent(m["token"], m["to_email"], since)
        except Exception:
            counts["left"] += 1                        # cannot verify: stays unknown, administrator is notified
            continue
        if found:
            rpc("intel_agent_confirm_send", {"p_message_id": m["id"], "p_zoho_message_id": found["zoho_message_id"], "p_rfc_message_id": found["rfc_message_id"],
                                             "p_thread_id": found["thread_id"], "p_sent_at": _iso(found["time_ms"])})
            counts["confirmed"] += 1
        else:
            rpc("intel_agent_fail_send", {"p_message_id": m["id"], "p_error": "verified absent from Sent folder", "p_permanent": False})
            counts["absent"] += 1
    return counts


def sync_inbox(rpc, zoho, own_addresses: set[str], overlap_ms: int = 3_600_000, limit: int = 50) -> dict:
    """Pull new inbox messages. Overlap + database idempotency make repeated or interrupted syncs harmless."""
    cursor = rpc("intel_agent_sync_state", {"p_set": None}) or {}
    since = int(cursor.get("last_time_ms", 0)) - overlap_ms
    newest, seen, fresh = int(cursor.get("last_time_ms", 0)), 0, 0
    for item in zoho.list_messages("inbox", limit=limit):
        if item["time_ms"] and item["time_ms"] < since:
            continue
        sender = re.sub(r".*<([^>]+)>.*", r"\1", item["from"]).strip().lower()
        if sender in own_addresses:
            continue
        seen += 1
        body = zoho.content_text(item["folder_id"], item["id"])
        hdr = zoho.rfc_headers(item["folder_id"], item["id"])
        tok = TOKEN_RE.search(f"{item['subject']}\n{body}")
        r = rpc("intel_agent_record_inbound", {
            "p_zoho_message_id": item["id"], "p_rfc_message_id": hdr.get("Message-ID", "").strip(), "p_in_reply_to": hdr.get("In-Reply-To", "").strip(),
            "p_references": hdr.get("References", "").strip(), "p_from_email": sender, "p_subject": item["subject"], "p_body_text": body,
            "p_received_at": _iso(item["time_ms"]), "p_thread_id": item["thread_id"], "p_token": tok.group(0) if tok else None})
        if not r.get("duplicate"):
            fresh += 1
            rpc("intel_agent_enqueue_job", {"p_kind": "classify", "p_payload": {"message_id": r["message_id"]}, "p_idempotency_key": f"classify:{item['id']}", "p_run_after": None, "p_priority": 5})
        newest = max(newest, item["time_ms"] or 0)
    rpc("intel_agent_sync_state", {"p_set": {"last_time_ms": newest}})
    return {"seen": seen, "new": fresh}
