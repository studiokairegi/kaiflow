"""Pure policy for job failure handling (Phase 4). No I/O, no clock, no database: everything here is unit-testable.

Why this is a separate module: the retry schedule, the transient/permanent split and the error scrubbing used to be inline in
Worker.run_job. They are the rules an operator needs to read and change, so they live in one small file with no dependencies.
"""
from __future__ import annotations

import re

from .errors import PermanentError, RpcError, TransientError

# Background work (discovery, research, drafting, mail sync ...) waits longer between tries, so a short Ollama restart, a provider outage or a
# Supabase maintenance window does not exhaust the five attempts. With the database default of 5 attempts the waits that actually occur are
# 60 s + 5 min + 15 min + 1 h = about 81 minutes before a job is declared dead (the old 30 s doubling schedule gave up after 7.5 minutes, and a
# job that dies stays dead for its whole idempotency bucket: one dead `discover:<type>:<day>` job blocked discovery until the next day).
# The fifth value only applies if max_attempts is ever raised.
BACKGROUND_BACKOFF = (60, 300, 900, 3600, 7200)
# Agent Chat has a person waiting for the answer: short, bounded delays.
INTERACTIVE_BACKOFF = (15, 30, 60, 120, 240)
INTERACTIVE_KINDS = frozenset({"chat"})
# Completion / failure RPCs are retried for about a minute on network errors before the worker gives up and lets lease expiry recover the job.
SETTLE_DELAYS = (2, 5, 10, 20, 30)

# PostgreSQL SQLSTATEs that mean "try again": serialization failure, deadlock, lock not available, statement timeout, too many connections.
RETRYABLE_SQLSTATE = frozenset({"40001", "40P01", "55P03", "57014", "53300"})


def settle_delays() -> tuple[int, ...]:
    return SETTLE_DELAYS


def transient_backoff(kind, attempts, rand=None) -> int:
    """Seconds to wait before the next try. `attempts` is the attempt number that just failed (1 for the first run).
    `rand(a, b)` supplies +-10% jitter (pass random.uniform); without it the delay is exact, which keeps tests deterministic."""
    table = INTERACTIVE_BACKOFF if kind in INTERACTIVE_KINDS else BACKGROUND_BACKOFF
    try:
        n = int(attempts)
    except (TypeError, ValueError):
        n = 1
    base = table[min(max(n, 1), len(table)) - 1]
    factor = rand(0.9, 1.1) if callable(rand) else 1.0
    return max(1, int(base * factor))


def classify_failure(exc: BaseException) -> tuple[str, bool]:
    """Returns (error_class, permanent).

    transient          network, 429/5xx, a provider that is down or rate limited          -> retry with backoff
    database_busy      an RpcError whose SQLSTATE says retry (deadlock, timeout ...)       -> retry with backoff
    permanent          PermanentError: bad input, policy refusal, missing approved data    -> dead at once, visible, recoverable by Requeue
    database_rejected  any other RpcError: the database definitively refused the request   -> dead at once
    unexpected         anything else (a bug, a library fault)                              -> retry with backoff; the class name is recorded
    """
    if isinstance(exc, TransientError):
        return "transient", False
    if isinstance(exc, PermanentError):
        return "permanent", True
    if isinstance(exc, RpcError):
        if str(getattr(exc, "code", "") or "") in RETRYABLE_SQLSTATE or getattr(exc, "status", 0) in (408, 425):
            return "database_busy", False
        return "database_rejected", True
    return "unexpected", False


_SECRET_PATTERNS = (
    (re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=\-]{8,}"), r"\1 [redacted]"),
    (re.compile(r"(?i)\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|token|authorization)(\"?\s*[:=]\s*\"?)[^\s\"',;&]{3,}"), r"\1\2[redacted]"),
    (re.compile(r"(?i)([?&](?:key|api_key|apikey|access_token|token|password|secret)=)[^&\s\"']+"), r"\1[redacted]"),
    (re.compile(r"\bAIza[0-9A-Za-z_\-]{20,}"), "[redacted]"),           # Google API key shape
    (re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"), "[redacted]"),   # JWT shape (Supabase tokens)
)


def scrub_error(text, limit: int = 400) -> str:
    """Defence in depth for `last_error` and the audit log, both of which are stored and shown in the app: remove anything shaped like a
    credential, collapse whitespace and bound the length. Provider clients already keep keys out of URLs and messages; this protects against a
    library exception or an upstream error body that echoes one."""
    s = " ".join(str(text if text is not None else "").split())
    for pattern, repl in _SECRET_PATTERNS:
        s = pattern.sub(repl, s)
    return s[:limit]
