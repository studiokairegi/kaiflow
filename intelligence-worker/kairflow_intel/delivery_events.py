"""Provider-neutral, idempotent delivery-event normalization and ingestion.

Adapters must authenticate/validate their provider evidence before calling this
module. SMTP has no standard delivery webhook; only trusted DSN/relay evidence
with a stable event id may be submitted.
"""
from __future__ import annotations

from datetime import datetime, timezone
import re
from typing import Any

_STATUS_RANK = {"pending": 0, "accepted": 10, "delayed": 20, "delivered": 30, "failed": 40, "bounced": 50, "complained": 60}


def is_forward_transition(current: str, incoming: str) -> bool:
    """Mirror the database monotonicity rule for deterministic adapter tests."""
    if current not in _STATUS_RANK or incoming not in _STATUS_RANK:
        raise ValueError("unknown delivery status")
    return _STATUS_RANK[incoming] > _STATUS_RANK[current]


_STATUS_ALIASES = {
    "accepted": "accepted", "sent": "accepted", "queued": "accepted",
    "delivery_delayed": "delayed", "delayed": "delayed", "deferred": "delayed",
    "delivered": "delivered", "delivery": "delivered",
    "failed": "failed", "rejected": "failed", "undeliverable": "failed",
    "bounced": "bounced", "bounce": "bounced", "hard_bounce": "bounced", "soft_bounce": "bounced",
    "complained": "complained", "complaint": "complained", "spam_complaint": "complained",
}


def normalize_status(event_type: str, status: str | None = None) -> str:
    """Map adapter vocabulary to the small canonical status set; reject unknowns."""
    for raw in (event_type, status):
        key = re.sub(r"[^a-z0-9_]+", "_", str(raw or "").strip().lower()).strip("_")
        if key in _STATUS_ALIASES:
            return _STATUS_ALIASES[key]
        # Provider event names commonly prefix the lifecycle name.
        if key:
            tail = key.rsplit(".", 1)[-1].rsplit("_", 1)[-1]
            if tail in _STATUS_ALIASES:
                return _STATUS_ALIASES[tail]
    raise ValueError("unsupported delivery event status")


def _iso(value: Any) -> str:
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, (int, float)):
        # Provider timestamps are seconds or milliseconds since epoch.
        dt = datetime.fromtimestamp(value / 1000 if value > 10_000_000_000 else value, tz=timezone.utc)
    elif isinstance(value, str) and value.strip():
        dt = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    else:
        dt = datetime.now(timezone.utc)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


def normalize_event(event: dict[str, Any]) -> dict[str, Any]:
    """Validate and reduce an adapter event to a safe database RPC payload."""
    if not isinstance(event, dict):
        raise ValueError("delivery event must be an object")
    provider = str(event.get("provider_key") or "").strip().lower()
    account_id = str(event.get("provider_account_id") or "").strip()
    message_id = str(event.get("provider_message_id") or "").strip()
    event_id = str(event.get("provider_event_id") or "").strip()
    event_type = str(event.get("event_type") or "").strip()
    recipient = str(event.get("recipient") or "").strip().lower()
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", provider):
        raise ValueError("invalid provider key")
    if not account_id or len(account_id) > 128:
        raise ValueError("missing provider account id")
    if not message_id or len(message_id) > 512:
        raise ValueError("missing provider message id")
    if not event_id or len(event_id) > 512:
        raise ValueError("missing stable provider event id")
    if not event_type or len(event_type) > 120:
        raise ValueError("missing or invalid event type")
    if recipient and (len(recipient) > 320 or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", recipient)):
        raise ValueError("invalid event recipient")
    status = normalize_status(event_type, event.get("status"))
    occurred_at = _iso(event.get("occurred_at"))
    # Keep only non-content diagnostics. Never persist arbitrary provider payloads.
    reason = re.sub(r"[\r\n\x00-\x1f]+", " ", str(event.get("reason") or ""))[:240]
    return {
        "p_provider_key": provider,
        "p_provider_account_id": account_id,
        "p_provider_message_id": message_id,
        "p_provider_event_id": event_id,
        "p_event_type": event_type,
        "p_status": status,
        "p_occurred_at": occurred_at,
        "p_recipient": recipient,
        "p_reason": reason,
    }


def apply_event(rpc, event: dict[str, Any]) -> dict[str, Any]:
    """Submit one already-authenticated event; database RPC owns idempotency."""
    payload = normalize_event(event)
    result = rpc("intel_agent_apply_delivery_event", payload)
    if not isinstance(result, dict) or result.get("ok") is not True or result.get("found") is not True:
        reason = result.get("reason", "invalid RPC response") if isinstance(result, dict) else "invalid RPC response"
        raise RuntimeError(f"delivery event was not durably accepted: {reason}")
    # A found event is safe to acknowledge only when the RPC explicitly reports
    # either a durable first application or an idempotent duplicate receipt.
    if result.get("duplicate") is not True and not isinstance(result.get("applied"), bool):
        raise RuntimeError("delivery event RPC omitted durable processing outcome")
    return result
