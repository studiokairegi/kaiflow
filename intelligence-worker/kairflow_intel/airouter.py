"""Gemini-first AI router with a local Ollama fallback (Phase 2).

Nothing in the worker is routed through this unless a call site passes a `site` tag AND the configured policy sends that site to Gemini.
The default policy is `ollama` for everything, so the worker behaves as before until a later phase changes configuration.

Rules enforced here (the AI never decides any of them):
  * One Gemini attempt, then at most ONE Ollama attempt per operation. No loops. Partial Gemini output is never used.
  * Both providers' output goes through the same schema validator (`ollama.validate`); Ollama's path is unchanged.
  * If both fail, Ollama's own exception propagates, so worker retry behaviour is identical to today.
  * Per-minute limits and short outages open a brief backoff window (no sleeping inside a call); daily exhaustion opens a long cooldown;
    permanent errors (bad key, unknown model, 403) open the existing 600-second cooldown.
  * KAIRFLOW_AI_FORCE_OLLAMA=1 sends everything to Ollama (rollback).
  * `prefer_ollama=True` on a call skips Gemini for that one call (route_reason "gemini_draft_rejected"). The draft path uses it for its single
    Ollama retry when a draft written by Gemini is refused by the composer's validators (grounding, language, names, ...): a provider failure is not
    the only way a Gemini attempt can fail, and a Gemini-only rejection should not cost a human review when Ollama can write a valid draft.
  * Decision D1: the `drafting`, `classification` and `chat` groups read private correspondence or CRM personal data, so they stay on Ollama unless KAIRFLOW_AI_D1=C.
    D1 option B (redaction) is not built yet and is rejected at startup rather than silently treated as C.

No secret is ever logged: log lines carry only the site tag, a failure kind and timings.
"""
from __future__ import annotations

import dataclasses
import logging
import re
import threading
import time
from collections import deque
from dataclasses import dataclass, field

from .ai_types import (AIResult, GeminiPermanent, GeminiTransient, K_AUTH, K_CONNECTION, K_RATE_DAILY, K_RATE_MINUTE, K_SERVER,
                       K_TIMEOUT, K_UNEXPECTED)
from .errors import PermanentError, TransientError

log = logging.getLogger("kairflow_intel.airouter")

GROUPS = ("discovery", "research", "drafting", "classification", "chat", "health")
PRIVATE_GROUPS = frozenset({"drafting", "classification", "chat"})      # private correspondence, CRM contact data and chat history (decision D1)
ROUTES = ("ollama", "gemini_first")
THINKING_LEVELS = ("low", "medium", "high")                       # Gemini 3.x cannot disable thinking; low, medium and high are supported
GEMINI_TIMEOUT = 60
PERMANENT_COOLDOWN_SECONDS = 600
AVAILABILITY_KINDS = {K_TIMEOUT, K_CONNECTION, K_SERVER}
DEFAULT_POLICY = {"discovery": "gemini_first", "research": "gemini_first"}   # Phases 3-4: public prospect data only. Every other group stays on Ollama until its phase.
SITE_DEFAULTS = {"health.gemini": "gemini_first", "health.ollama": "ollama"}   # Phase 6: the selftest pins one check to each provider (no private data is sent)
KNOWN_SITES = frozenset({                                        # every call-site tag the worker passes; a typo in KAIRFLOW_AI_POLICY is rejected at startup
    "discovery.news", "discovery.manual_post", "discovery.studio_profile", "research.entity", "research.studio_reeval",
    "drafting.initial", "drafting.followup", "drafting.reply", "drafting.takeover", "drafting.takeover_followup", "drafting.takeover_reply",
    "drafting.takeover_analysis", "classification.inbound", "chat.plan", "health.chat", "health.gemini", "health.ollama"})
R_GEMINI_DRAFT_REJECTED = "gemini_draft_rejected"               # route_reason of the Ollama retry after a Gemini-written draft failed validation
CHAT_DEFAULT_ROUTE = "gemini_first"                              # D1 gates this private group; Gemini is possible only when D1=C
DEFAULT_JSON_MODEL = "gemini-3.8-flash"                         # exact pinned ID for generate_json (decision D2); never an alias


@dataclass(frozen=True)
class RouterSettings:
    policy: dict = field(default_factory=lambda: dict(DEFAULT_POLICY))   # "default" | group | "group.name" -> "ollama" | "gemini_first"
    model: str = DEFAULT_JSON_MODEL                     # exact model ID for generate_json; Agent Chat keeps KAIRFLOW_GEMINI_MODEL until Phase 6
    force_ollama: bool = False
    d1: str = "A"                                       # A: private groups stay on Ollama. C: everything may go to Gemini unredacted.
    thinking: str = "low"                               # thinkingLevel sent to Gemini 3.x models; thinking cannot be disabled
    max_output_fast: int = 2048                         # maxOutputTokens when the caller asked for fast=True
    max_output: int = 4096                              # maxOutputTokens otherwise (thinking tokens count toward this)
    rpm: int = 0                                        # local free-tier request caps; 0 = no local cap (rely on Google's 429s)
    rpd: int = 0
    draft_reserve: float = 0.25                         # share of the daily cap only drafting may use (ignored when rpd = 0)
    rate_backoff_default: float = 30.0                  # seconds to skip Gemini after a per-minute 429 with no Retry-After
    rate_backoff_max: float = 300.0
    daily_cooldown: float = 10800.0                     # seconds to skip Gemini after daily exhaustion before probing again
    outage_threshold: int = 3                           # consecutive timeouts/connection/5xx before a short pause
    outage_backoff: float = 60.0
    rate_streak_daily: int = 5                          # consecutive 429s with no quota details and no Retry-After, with no success between, are treated as daily exhaustion
    permanent_cooldown: float = PERMANENT_COOLDOWN_SECONDS


def _truthy(v) -> bool:
    return str(v or "").strip().lower() in ("1", "true", "yes", "on")


def parse_policy(text: str) -> dict:
    out: dict = {}
    for part in (text or "").split(","):
        part = part.strip()
        if not part:
            continue
        if "=" not in part:
            raise ValueError(f"KAIRFLOW_AI_POLICY entry {part!r} must look like group=ollama|gemini_first")
        key, route = (x.strip().lower() for x in part.split("=", 1))
        if route not in ROUTES:
            raise ValueError(f"KAIRFLOW_AI_POLICY: {route!r} is not one of {ROUTES}")
        if key != "default" and key.split(".", 1)[0] not in GROUPS:
            raise ValueError(f"KAIRFLOW_AI_POLICY: unknown group in {key!r}; groups are {GROUPS}")
        if "." in key and key not in KNOWN_SITES:
            raise ValueError(f"KAIRFLOW_AI_POLICY: unknown call site {key!r}; sites are {sorted(KNOWN_SITES)}")
        out[key] = route
    return out


def settings_warnings(settings: RouterSettings) -> list[str]:
    """Settings that parse cleanly but cannot do what they say. Today: an explicit private-group policy entry that sends private data to
    Gemini while D1 keeps it on Ollama. (`default=gemini_first` is not reported: it still moves the groups that are not private.) Never contains a secret."""
    if settings.force_ollama or settings.d1 == "C":
        return []
    dead = sorted(k for k, v in settings.policy.items()
                  if v == "gemini_first" and k != "default" and k.split(".", 1)[0] in PRIVATE_GROUPS)
    if not dead:
        return []
    return [f"KAIRFLOW_AI_POLICY sends {', '.join(dead)} to Gemini, but KAIRFLOW_AI_D1={settings.d1} keeps private data on Ollama, so "
            "this entry has no effect: drafting, classification and Agent Chat still use Ollama only. Set KAIRFLOW_AI_D1=C to allow Gemini for them."]


def _int(e, name: str, default: int, lo: int, hi: int) -> int:
    raw = (e.get(name) or "").strip()
    if not raw:
        return default
    try:
        v = int(raw)
    except ValueError:
        raise ValueError(f"{name} must be a whole number") from None
    if not lo <= v <= hi:
        raise ValueError(f"{name} must be between {lo} and {hi}")
    return v


def settings_from_env(e: dict) -> RouterSettings:
    """Build and validate router settings. Raises ValueError with a message that never contains a secret."""
    thinking = (e.get("KAIRFLOW_GEMINI_THINKING") or "low").strip().lower()
    if thinking == "minimal":
        raise ValueError("KAIRFLOW_GEMINI_THINKING=minimal is not supported by gemini-3.8-flash; use low, medium or high")
    if thinking == "off":
        raise ValueError("Gemini 3.x thinking cannot be disabled; use KAIRFLOW_GEMINI_THINKING=low to minimize reasoning effort")
    if thinking not in THINKING_LEVELS:
        raise ValueError(f"KAIRFLOW_GEMINI_THINKING must be one of {THINKING_LEVELS}")
    d1 = (e.get("KAIRFLOW_AI_D1") or "A").strip().upper()
    if d1 == "B":
        raise ValueError("KAIRFLOW_AI_D1=B (redacted) is not implemented until Phase 5; use A (private correspondence stays on Ollama) or C")
    if d1 not in ("A", "C"):
        raise ValueError("KAIRFLOW_AI_D1 must be A or C")
    model = (e.get("KAIRFLOW_GEMINI_JSON_MODEL") or DEFAULT_JSON_MODEL).strip()
    if not re.fullmatch(r"gemini-[a-z0-9][a-z0-9.\-]{1,60}", model) or "latest" in model:
        raise ValueError("KAIRFLOW_GEMINI_JSON_MODEL must be an exact Gemini model ID such as gemini-3.8-flash (no 'latest' alias)")
    reserve_raw = (e.get("KAIRFLOW_GEMINI_DRAFT_RESERVE") or "").strip()
    try:
        reserve = float(reserve_raw) if reserve_raw else 0.25
    except ValueError:
        raise ValueError("KAIRFLOW_GEMINI_DRAFT_RESERVE must be a number between 0 and 0.9") from None
    if not 0.0 <= reserve <= 0.9:
        raise ValueError("KAIRFLOW_GEMINI_DRAFT_RESERVE must be between 0 and 0.9")
    user_policy = parse_policy(e.get("KAIRFLOW_AI_POLICY") or "")
    # The environment overrides the built-in defaults per key. An explicit `default=` replaces the built-in group defaults: otherwise discovery
    # and research would keep their built-in route and `default=ollama` would not put them back on Ollama.
    base = {} if "default" in user_policy else DEFAULT_POLICY
    return RouterSettings(
        policy={**base, **user_policy},
        model=model,
        force_ollama=_truthy(e.get("KAIRFLOW_AI_FORCE_OLLAMA")),
        d1=d1, thinking=thinking,
        max_output_fast=_int(e, "KAIRFLOW_GEMINI_MAX_OUTPUT_FAST", 2048, 256, 65536),
        max_output=_int(e, "KAIRFLOW_GEMINI_MAX_OUTPUT", 4096, 256, 65536),
        rpm=_int(e, "KAIRFLOW_GEMINI_RPM", 0, 0, 100000),
        rpd=_int(e, "KAIRFLOW_GEMINI_RPD", 0, 0, 10_000_000),
        draft_reserve=reserve,
        daily_cooldown=float(_int(e, "KAIRFLOW_GEMINI_DAILY_COOLDOWN_SECONDS", 10800, 60, 86400)),
    )


class RequestBudget:
    """Local free-tier request counter over rolling windows (conservative: Google resets on its own clock). Every HTTP attempt counts,
    failed ones included. A share of the daily cap is reserved for drafting so discovery and research cannot use it up."""

    def __init__(self, rpm: int, rpd: int, draft_reserve: float, clock=time.monotonic):
        self.rpm, self.rpd, self.reserve, self.clock = rpm, rpd, draft_reserve, clock
        self._minute: deque = deque()
        self._day: deque = deque()

    def _trim(self, now: float) -> None:
        while self._minute and now - self._minute[0] >= 60:
            self._minute.popleft()
        while self._day and now - self._day[0] >= 86400:
            self._day.popleft()

    def try_acquire(self, group: str) -> str | None:
        """Record one attempt and return None, or return the reason it is not allowed (nothing recorded)."""
        now = self.clock()
        self._trim(now)
        if self.rpm and len(self._minute) >= self.rpm:
            return "budget_minute"
        if self.rpd:
            cap = self.rpd if group == "drafting" else int(self.rpd * (1.0 - self.reserve))
            if len(self._day) >= cap:
                return "budget_day"
        self._minute.append(now)
        self._day.append(now)
        return None

    def counts(self) -> dict:
        self._trim(self.clock())
        return {"last_minute": len(self._minute), "last_24h": len(self._day), "rpm": self.rpm, "rpd": self.rpd}


class AIRouter:
    def __init__(self, primary, fallback, settings: RouterSettings | None = None, clock=time.monotonic):
        self.primary, self.fallback, self.clock = primary, fallback, clock
        self.settings = settings or RouterSettings()
        for warning in settings_warnings(self.settings):
            log.warning("ai settings: %s", warning)
        # The draft reserve only makes sense when drafting can actually reach Gemini; otherwise it would strand a share of the daily cap.
        self.budget = RequestBudget(self.settings.rpm, self.settings.rpd,
                                    self.settings.draft_reserve if self._drafting_can_use_gemini() else 0.0, clock)
        self._lock = threading.Lock()
        self.permanent_until = 0.0        # shared with chat_json through FallbackLLM
        self._rate_until = 0.0
        self._daily_until = 0.0
        self._outage_until = 0.0
        self._outage_count = 0
        self._rate_streak = 0
        self.last_gemini_error: str | None = None

    def _drafting_can_use_gemini(self) -> bool:
        s = self.settings
        if s.force_ollama or s.d1 != "C":
            return False
        return any(v == "gemini_first" for k, v in s.policy.items() if k == "default" or k == "drafting" or k.startswith("drafting."))

    # ---- policy -------------------------------------------------------------------------------------------------------------------
    def resolve(self, site: str, default_route: str = "ollama") -> tuple[str, str | None]:
        """Return ("gemini_first", None) or ("ollama", reason) for a call-site tag such as "discovery.news".
        Precedence: exact site, built-in site pin (health.gemini / health.ollama, so a group entry cannot move a selftest check), group,
        the policy's `default`, then `default_route`
        (generate_json: ollama; Agent Chat: gemini_first, which is what it did before the router existed)."""
        s = self.settings
        if s.force_ollama:
            return "ollama", "forced_ollama"
        site = (site or "unspecified").lower()
        group = site.split(".", 1)[0]
        route = (s.policy.get(site) or SITE_DEFAULTS.get(site) or s.policy.get(group)
                 or (s.policy.get("default") if group in GROUPS else None) or default_route)
        if route != "gemini_first":
            return "ollama", "policy_ollama"
        if group in PRIVATE_GROUPS and s.d1 != "C":
            return "ollama", "d1_private"
        return "gemini_first", None

    def private_text_allowed(self, site: str) -> bool:
        """May private correspondence, CRM contact data or chat history be sent to this call site? Under D1=A Agent Chat is routed to Ollama as a whole; D1=C explicitly permits Gemini."""
        if self.settings.d1 == "C":
            return True
        return self.resolve(site, CHAT_DEFAULT_ROUTE if (site or "").lower().startswith("chat.") else "ollama")[0] != "gemini_first"

    def _gemini_block_reason(self, now: float) -> str | None:
        if self.primary is None:
            return "no_gemini"
        if now < self.permanent_until:
            return "gemini_cooldown_permanent"
        if now < self._daily_until:
            return "gemini_cooldown_daily"
        if now < self._rate_until:
            return "gemini_backoff_rate_limit"
        if now < self._outage_until:
            return "gemini_backoff_outage"
        return None

    # ---- main entry points --------------------------------------------------------------------------------------------------------
    def _run(self, site: str, default_route: str, gemini_call, ollama_call, ollama_model, default_timeout: int, *, prefer_ollama: bool = False) -> AIResult:
        """One Gemini attempt (only if the policy and the shared state allow it), then at most ONE Ollama attempt. Shared by generate_json
        and chat_json so both obey the same policy, budget, backoff and cooldowns. `prefer_ollama` skips the Gemini attempt for this call."""
        site = (site or "unspecified").lower()
        route, reason = self.resolve(site, default_route)
        gemini_attempted = False
        if prefer_ollama and not self.settings.force_ollama:
            route, reason = "ollama", R_GEMINI_DRAFT_REJECTED
        if route == "gemini_first":
            with self._lock:
                reason = self._gemini_block_reason(self.clock())
                if reason is None:
                    reason = self.budget.try_acquire(site.split(".", 1)[0])
            if reason is None:
                gemini_attempted = True
                try:
                    res = gemini_call(min(default_timeout, GEMINI_TIMEOUT), site)
                except Exception as exc:                          # classified below; the message is never logged (it could carry a URL)
                    reason = self._note_failure(exc, site)
                else:
                    self._note_success()
                    return dataclasses.replace(res, site=site, route_reason=None, gemini_attempted=True)
        # Exactly one Ollama attempt. Anything the Gemini attempt produced has been discarded. Its errors propagate unchanged.
        log.debug("ai route site=%s provider=ollama reason=%s", site, reason)
        data = ollama_call()
        return AIResult(data=data, provider="ollama", model=ollama_model(), route_reason=reason, gemini_attempted=gemini_attempted, site=site)

    def _ollama_model(self, fast: bool) -> str:
        cfg = getattr(self.fallback, "cfg", None)
        return getattr(cfg, "ollama_fast_model" if fast else "ollama_model", None) or "ollama"

    def generate_json_ex(self, site: str, instruction: str, untrusted: str, schema: dict, *, fast: bool = False, prefer_ollama: bool = False,
                         **kw) -> AIResult:
        def gem(timeout, site_):
            return self.primary.generate_json_ex(instruction, untrusted, schema, fast=fast, site=site_, timeout=timeout)
        return self._run(site, "ollama", gem, lambda: self.fallback.generate_json(instruction, untrusted, schema, fast=fast, **kw),
                         lambda: self._ollama_model(fast), kw.get("timeout") or GEMINI_TIMEOUT, prefer_ollama=prefer_ollama)

    def chat_json_ex(self, site: str, system: str, messages: list[dict], schema: dict, **kw) -> AIResult:
        """Agent Chat planning (and the chat health check) through the same policy, budget and cooldowns as generate_json.
        Without a policy entry for the site the route is gemini_first, as Agent Chat has always been. The planner always uses
        Ollama's main model (there is no `fast` for chat)."""
        def gem(timeout, site_):
            ex = getattr(self.primary, "chat_json_ex", None)
            if callable(ex):
                return ex(system, messages, schema, timeout=timeout, site=site_)
            data = self.primary.chat_json(system, messages, schema, timeout=timeout)       # a client without provenance support
            return AIResult(data=data, provider="gemini", model=getattr(self.primary, "model", None) or "gemini", site=site_)
        return self._run(site, CHAT_DEFAULT_ROUTE, gem, lambda: self.fallback.chat_json(system, messages, schema, **kw),
                         lambda: self._ollama_model(False), kw.get("timeout") or 45)

    def generate_json(self, instruction: str, untrusted: str, schema: dict, *, site: str = "unspecified", fast: bool = False, **kw) -> dict:
        """Drop-in for OllamaClient.generate_json (plus an optional `site` tag). Returns the data only; use generate_json_ex for provenance."""
        return self.generate_json_ex(site, instruction, untrusted, schema, fast=fast, **kw).data

    # ---- state --------------------------------------------------------------------------------------------------------------------
    def note_permanent(self, message: str = "") -> None:
        with self._lock:
            self.permanent_until = self.clock() + self.settings.permanent_cooldown
            self.last_gemini_error = (message or "permanent error")[:200]
        log.warning("gemini paused for %ds after a permanent error", int(self.settings.permanent_cooldown))

    def _note_success(self) -> None:
        with self._lock:
            self._outage_count = 0
            self._rate_streak = 0
            self.last_gemini_error = None

    def _note_failure(self, exc: Exception, site: str) -> str:
        now = self.clock()
        if isinstance(exc, PermanentError):
            kind = getattr(exc, "kind", K_AUTH)
            self.note_permanent(str(exc))
            log.warning("ai fallback site=%s kind=%s", site, kind)
            return kind
        if isinstance(exc, TransientError):
            kind = getattr(exc, "kind", K_UNEXPECTED)
            retry_after = getattr(exc, "retry_after", None)
            msg = str(exc)[:200]
        else:                                                      # safety net: a bug or an unknown exception must not stop the worker
            kind, retry_after, msg = K_UNEXPECTED, None, f"unexpected {type(exc).__name__}"
        s = self.settings
        with self._lock:
            self.last_gemini_error = msg
            if kind == K_RATE_DAILY:
                self._daily_until = now + s.daily_cooldown
                log.warning("gemini daily quota exhausted; skipping Gemini for %ds", int(s.daily_cooldown))
            elif kind == K_RATE_MINUTE:
                if retry_after is not None:                        # Google said how long to wait: believe it
                    self._rate_streak = 0
                    wait = min(max(retry_after, 1.0), s.rate_backoff_max)
                    self._rate_until = now + wait
                else:                                              # no guidance: back off harder each time, and after a streak assume the daily quota is gone
                    self._rate_streak += 1
                    if s.rate_streak_daily and self._rate_streak >= s.rate_streak_daily:
                        self._daily_until = now + s.daily_cooldown
                        self._rate_streak = 0
                        log.warning("gemini 429 repeated with no quota details; treating as daily exhaustion, skipping Gemini for %ds", int(s.daily_cooldown))
                    else:
                        self._rate_until = now + min(max(s.rate_backoff_default * 2 ** (self._rate_streak - 1), 1.0), s.rate_backoff_max)
            if kind in AVAILABILITY_KINDS:
                self._outage_count += 1
                if self._outage_count >= s.outage_threshold:
                    self._outage_until = now + s.outage_backoff
                    self._outage_count = 0
            else:                                                  # "consecutive" means consecutive: any other failure breaks the run
                self._outage_count = 0
        log.info("ai fallback site=%s kind=%s", site, kind)
        return kind

    def status(self) -> dict:
        """Secret-free snapshot for health checks."""
        now = self.clock()
        with self._lock:
            return {"forced_ollama": self.settings.force_ollama, "d1": self.settings.d1, "policy": dict(self.settings.policy),
                    "gemini_configured": self.primary is not None, "gemini_block": self._gemini_block_reason(now),
                    "last_gemini_error": self.last_gemini_error, "budget": self.budget.counts(),
                    "warnings": settings_warnings(self.settings)}
