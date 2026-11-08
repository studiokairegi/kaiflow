"""Provider-neutral crash-safe mail operations.

The database reserves and marks a message before the provider call. Uncertain outcomes
are never resent. Mailbox providers reconcile against Sent; Resend reconciles only by a
saved provider id through its server-side verification proxy, otherwise stays unknown."""
from __future__ import annotations

import re
import time
from datetime import datetime, timezone

from .errors import MailRejected, PermanentError, RpcError, ThreadingRejected, TransientError

TOKEN_RE = re.compile(r"\bkf[0-9a-f]{32}\b")


def _iso(ms: int | None) -> str | None:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat() if ms else None


def with_ref(body: str, token: str) -> str:
    return body if token in body else body.rstrip() + f"\n\nRef: {token}\n"


def parent_zoho_id(rpc, m: dict) -> str | None:
    """Return provider parent id. Lookup errors raise; a confirmed absence returns None."""
    ref = (m.get("in_reply_to") or "").strip()
    if not ref or not m.get("prospect_id"):
        return None
    try:
        ctx = rpc("intel_agent_context", {"p_prospect_id": m["prospect_id"]}) or {}
    except Exception as exc:
        raise TransientError(f"reply parent lookup failed ({type(exc).__name__})") from exc
    for x in ctx.get("messages", []):
        if x.get("rfc_message_id") == ref and x.get("zoho_message_id"):
            return str(x["zoho_message_id"])
    return None


def send_message(rpc, zoho, message_id: str) -> dict:
    res = rpc("intel_agent_reserve_send", {"p_message_id": message_id})
    if not res.get("ok"):
        return {"sent": False, "reason": res.get("reason", "denied")}
    m = res["message"]
    # Assign a concrete mailbox and reserve its quota atomically. The SQL gate also
    # requires explicit prospecting consent or a genuine inbound correspondence thread.
    try:
        assigned = rpc("intel_agent_assign_provider_account", {"p_message_id": message_id}) or {}
    except Exception as exc:
        rpc("intel_agent_fail_send", {"p_message_id": message_id, "p_error": f"provider assignment failed: {type(exc).__name__}"[:300], "p_permanent": False})
        return {"sent": False, "reason": "provider_assignment_retry"}
    if not assigned:
        # Compatibility with pre-2.5 installations and lightweight test doubles; the
        # deployed migration always returns a structured result.
        assigned = {"ok": True, "legacy": True, "message": m}
    if not assigned.get("ok"):
        reason = assigned.get("reason", "provider_assignment_denied")
        if reason == "provider_account_quota":
            return {"sent": False, "reason": reason, "retry_after": int(assigned.get("retry_after", 60))}
        if reason in ("prospecting_consent_required", "business_correspondence_context_required", "no_eligible_provider_account", "assigned_account_disabled"):
            rpc("intel_agent_fail_send", {"p_message_id": message_id, "p_error": reason, "p_permanent": reason in ("prospecting_consent_required", "business_correspondence_context_required")})
        return {"sent": False, "reason": reason}
    m = assigned.get("message") or m
    provider = zoho.for_message(m) if hasattr(zoho, "for_message") else zoho
    # Complete all network/database preflight before taking the studio-wide slot.
    # In particular, resolve native reply threading before the final state transition
    # so the kill-switch/slot guard is the last RPC before provider submission.
    try:
        parent = parent_zoho_id(rpc, m)
    except TransientError as exc:
        rpc("intel_agent_fail_send", {"p_message_id": m["id"], "p_error": f"parent lookup failed: {exc}"[:300], "p_permanent": False})
        return {"sent": False, "reason": "parent_lookup_retry"}
    if m.get("in_reply_to") and not parent:
        try:
            rpc("intel_agent_log", {"p_action": "reply_parent_missing", "p_entity_type": "message", "p_entity_id": m["id"],
                                    "p_detail": {"provider": getattr(provider, "provider", "zoho"), "in_reply_to": m.get("in_reply_to")}})
        except Exception:
            pass
        if getattr(provider, "provider", "zoho") == "zoho":
            rpc("intel_agent_fail_send", {"p_message_id": m["id"], "p_error": "Zoho reply parent missing; manual review required", "p_permanent": True})
            return {"sent": False, "reason": "reply_parent_missing"}

    slot = rpc("intel_agent_acquire_send_slot", {"p_message_id": m["id"]})
    if not slot or not slot.get("ok"):
        return {"sent": False, "reason": (slot or {}).get("reason", "send_slot_unavailable"),
                "retry_after": int((slot or {}).get("retry_after", 60))}
    # This database transition revalidates kill-switch state and slot ownership.
    # Keep it adjacent to the provider call; do not insert further preflight RPCs.
    if not rpc("intel_agent_mark_sending", {"p_message_id": m["id"]}):
        return {"sent": False, "reason": "not_reserved_or_send_stopped"}
    send_args = {"reply_to_zoho_id": parent, "in_reply_to": m.get("in_reply_to") or None, "references": m.get("references_ids") or None}
    if getattr(provider, "provider", "") == "resend":
        send_args["message_id"] = m["id"]
    try:
        out = provider.send(m["from_email"], m["to_email"], m["subject"], with_ref(m["body_text"], m["token"]), **send_args)
        provider_id = str(out.get("zoho_message_id") or "").strip()
        if not provider_id:
            # Provider call returned without a durable id. Do not confirm a sent
            # state with an empty id; it requires provider reconciliation/manual review.
            raise TransientError("provider accepted/returned but message id is missing")
    except ThreadingRejected as exc:                  # definite refusal; never retry as an unthreaded reply
        rpc("intel_agent_fail_send", {"p_message_id": m["id"], "p_error": str(exc)[:300], "p_permanent": True})
        return {"sent": False, "reason": "threading_rejected"}
    except MailRejected as exc:                       # definitive: the provider said no, nothing was sent
        permanent = bool(re.search(r"invalid|not a valid|mailbox|recipient", str(exc), re.I))
        rpc("intel_agent_fail_send", {"p_message_id": m["id"], "p_error": str(exc)[:300], "p_permanent": permanent})
        return {"sent": False, "reason": "rejected"}
    except Exception as exc:                           # outcome unknown: provider may have accepted
        rpc("intel_agent_mark_unknown", {"p_message_id": m["id"], "p_error": f"{type(exc).__name__}: {exc}"[:300]})
        return {"sent": False, "reason": "unknown"}
    rfc = out.get("rfc_message_id") or ""
    if getattr(provider, "provider", "") == "resend":
        try:
            saved = rpc("intel_agent_record_resend_acceptance", {"p_message_id": m["id"], "p_provider_message_id": provider_id})
            if not saved:
                raise RuntimeError("provider id was not persisted")
        except Exception as exc:
            rpc("intel_agent_mark_unknown", {"p_message_id": m["id"], "p_error": f"Resend accepted but provider id could not be saved: {type(exc).__name__}"[:300]})
            return {"sent": False, "reason": "unknown"}
    try:
        found = None if rfc or getattr(provider, "provider", "") == "resend" else provider.find_sent(m["token"], m["to_email"], int(time.time() * 1000) - 600_000)
        rfc = rfc or (found or {}).get("rfc_message_id", "")
    except Exception:
        pass                                           # headers are an optional extra: the token still matches replies
    try:
        rpc("intel_agent_confirm_send", {"p_message_id": m["id"], "p_zoho_message_id": provider_id, "p_rfc_message_id": rfc,
                                         "p_thread_id": out["thread_id"], "p_sent_at": None})
    except Exception:
        return {"sent": True, "reason": "confirm_pending"}   # stays `sending`; reconcile() settles it without resending
    return {"sent": True, "reason": "ok"}


def reconcile(rpc, zoho) -> dict:
    """Settle unresolved sends using provider-specific evidence. Never resends."""
    counts = {"confirmed": 0, "absent": 0, "left": 0}
    for m in rpc("intel_agent_stale_sends", {"p_older_than_seconds": 600}) or []:
        provider = zoho.for_message(m) if hasattr(zoho, "for_message") else zoho
        try:
            if getattr(provider, "provider", "") == "resend":
                provider_id = m.get("provider_message_id") or m.get("zoho_message_id")
                if not provider_id:
                    rpc("intel_agent_mark_unknown", {"p_message_id": m["id"], "p_error": "Resend may have accepted the message, but no provider id was saved; manual resolution required"})
                    counts["left"] += 1
                    continue
                found = provider.verify_sent(provider_id, m["id"])
            elif getattr(provider, "provider", "") == "smtp":
                # SMTP has no standard Sent-folder API. A provider acceptance response
                # is recorded at send time; a crash/timeout remains ambiguous and is
                # never converted into an automatic retry without external evidence.
                rpc("intel_agent_mark_unknown", {"p_message_id": m["id"], "p_error": "SMTP outcome cannot be independently verified from a Sent folder; manual resolution required"})
                counts["left"] += 1
                continue
            else:
                since = int((datetime.fromisoformat(m["reserved_at"].replace("Z", "+00:00")).timestamp() - 300) * 1000) if m.get("reserved_at") else 0
                found = provider.find_sent(m["token"], m["to_email"], since)
        except Exception as exc:
            if getattr(provider, "provider", "") == "resend":
                try:
                    rpc("intel_agent_mark_unknown", {"p_message_id": m["id"], "p_error": f"Resend verification unavailable: {type(exc).__name__}; manual resolution required"})
                except Exception:
                    pass
            counts["left"] += 1                        # cannot verify: stays unknown, administrator is notified
            continue
        if found:
            rpc("intel_agent_confirm_send", {"p_message_id": m["id"], "p_zoho_message_id": found["zoho_message_id"], "p_rfc_message_id": found["rfc_message_id"],
                                             "p_thread_id": found["thread_id"], "p_sent_at": _iso(found["time_ms"])})
            counts["confirmed"] += 1
        elif getattr(provider, "provider", "") == "resend":
            rpc("intel_agent_mark_unknown", {"p_message_id": m["id"], "p_error": "Resend provider id could not be verified; manual resolution required"})
            counts["left"] += 1
        else:
            rpc("intel_agent_fail_send", {"p_message_id": m["id"], "p_error": "verified absent from Sent folder", "p_permanent": False})
            counts["absent"] += 1
    return counts



def _rfc_header(headers: dict, name: str) -> str:
    """RFC field names are case-insensitive; provider APIs may preserve any casing."""
    target = name.casefold()
    for key, value in (headers or {}).items():
        if str(key).casefold() == target:
            return str(value or "").strip()
    return ""


def sync_inbox(rpc, zoho, own_addresses: set[str], overlap_ms: int = 3_600_000, limit: int = 50) -> dict:
    """Pull new inbox messages. Overlap + database idempotency make repeated or interrupted syncs harmless."""
    cursor = rpc("intel_agent_sync_state", {"p_set": None}) or {}
    since = int(cursor.get("last_time_ms", 0)) - overlap_ms
    newest, seen, fresh = int(cursor.get("last_time_ms", 0)), 0, 0
    items = zoho.iter_messages("inbox", page_size=limit) if hasattr(zoho, "iter_messages") else iter(zoho.list_messages("inbox", limit=limit))
    for item in items:
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
            "p_zoho_message_id": item["id"], "p_rfc_message_id": _rfc_header(hdr, "Message-ID"), "p_in_reply_to": _rfc_header(hdr, "In-Reply-To"),
            "p_references": _rfc_header(hdr, "References"), "p_from_email": sender, "p_subject": item["subject"], "p_body_text": body,
            "p_received_at": _iso(item["time_ms"]), "p_thread_id": item["thread_id"], "p_token": tok.group(0) if tok else None})
        if not r.get("duplicate"):
            fresh += 1
            rpc("intel_agent_enqueue_job", {"p_kind": "classify", "p_payload": {"message_id": r["message_id"]}, "p_idempotency_key": f"classify:{item['id']}", "p_run_after": None, "p_priority": 5})
        newest = max(newest, item["time_ms"] or 0)
    rpc("intel_agent_sync_state", {"p_set": {"last_time_ms": newest}})
    return {"seen": seen, "new": fresh}
