"""Shared types for the Gemini-first AI router (Phase 2).

`AIResult` is the per-call provenance record: which provider produced the data and under which exact model ID. It travels with the
result, so it is safe under concurrency (unlike `FallbackLLM.last_backend`, which is one shared attribute).

`GeminiTransient` / `GeminiPermanent` subclass the worker's existing error classes, so any code that catches `TransientError` or
`PermanentError` keeps working. They add a `kind` so the router can tell a per-minute limit from daily exhaustion, a truncated answer from
a schema violation, and so on. Messages never contain the API key, the URL or any response body.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .errors import PermanentError, TransientError

# Failure kinds raised by the Gemini client (fallback triggers unless noted).
K_RATE_MINUTE = "rate_limit_minute"       # 429, per-minute: short backoff window, honour Retry-After
K_RATE_DAILY = "rate_limit_daily"         # 429, daily quota exhausted: long cooldown so later calls skip Gemini
K_TIMEOUT = "timeout"                     # 408 or client-side timeout
K_CONNECTION = "connection"               # DNS / TLS / reset
K_SERVER = "server_error"                 # 5xx
K_TRUNCATED = "truncated"                 # finishReason MAX_TOKENS: output discarded
K_EMPTY = "empty_output"                  # no candidate / no text
K_BLOCKED = "blocked"                     # promptFeedback.blockReason or a non-STOP finish reason (SAFETY, RECITATION, ...)
K_INVALID_JSON = "invalid_json"
K_SCHEMA = "schema_invalid"
K_UNEXPECTED = "unexpected"               # router safety net: an unexpected exception type inside the Gemini attempt
K_AUTH = "auth"                           # permanent: 401/403/404, or a 400 that names an invalid API key (bad key, unknown model)
K_BAD_REQUEST = "bad_request"             # any other 4xx (e.g. a 400 caused by one odd request): this call falls back, Gemini is NOT paused

TRANSIENT_KINDS = {K_RATE_MINUTE, K_RATE_DAILY, K_TIMEOUT, K_CONNECTION, K_SERVER, K_TRUNCATED, K_EMPTY, K_BLOCKED,
                   K_INVALID_JSON, K_SCHEMA, K_UNEXPECTED, K_BAD_REQUEST}


class GeminiTransient(TransientError):
    def __init__(self, message: str, kind: str, retry_after: float | None = None):
        super().__init__(message)
        self.kind, self.retry_after = kind, retry_after


class GeminiPermanent(PermanentError):
    def __init__(self, message: str, kind: str = K_AUTH):
        super().__init__(message)
        self.kind = kind


@dataclass(frozen=True)
class AIResult:
    data: dict
    provider: str                              # "gemini" | "ollama"
    model: str                                 # exact configured model ID that served this call
    model_reported: str | None = None          # what the provider said it served (Gemini `modelVersion`); None if not reported
    route_reason: str | None = None            # None = Gemini answered. Otherwise why Ollama served: policy_ollama, forced_ollama, d1_private,
                                               # no_gemini, gemini_cooldown_permanent, gemini_backoff_rate_limit, gemini_cooldown_daily,
                                               # budget_minute, budget_day, gemini_draft_rejected (the Ollama retry after a Gemini draft failed validation), or the failure kind of the Gemini attempt
    gemini_attempted: bool = False             # True when an HTTP request to Gemini was made for this call
    site: str = "unspecified"
    finish_reason: str | None = None
    usage: dict = field(default_factory=dict)  # promptTokens / outputTokens / thoughtsTokens / totalTokens when Gemini reports them
