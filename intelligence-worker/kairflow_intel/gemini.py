"""Gemini client for Agent Chat planning, with Ollama as the fallback.

Scope: Agent Chat's planner call (`chat_json`) can use Gemini only when the shared router permits it; decision D1 keeps it on Ollama by default because history and CRM tool results may contain private data. `generate_json` / `generate_json_ex` (Phase 2) can also use Gemini, but ONLY for call sites that pass a `site` tag AND that the routing policy (airouter.py) sends to Gemini. The default policy
sends everything to the local Ollama model, and drafting, classification and Agent Chat (CRM contacts/history) stay on Ollama unless decision D1 is C.

What leaves the machine on a chat turn: the system prompt, the recent chat history, the administrator's request and the tool results
that the chat feeds back (prospect names, statuses, counts, short reply summaries). Nothing else.

Safety model is unchanged: Gemini returns {action, tool, args, reply}; chat.py validates the tool against its allowlist and the
database re-checks everything. Gemini has no tools, SQL, shell or file access here. The API key goes in a request header, never in
the URL, and is never put in an exception message.
"""
from __future__ import annotations

import json
import time

import requests

from .ai_types import (AIResult, GeminiPermanent, GeminiTransient, K_AUTH, K_BAD_REQUEST, K_BLOCKED, K_CONNECTION, K_EMPTY, K_INVALID_JSON, K_RATE_DAILY,
                       K_RATE_MINUTE, K_SCHEMA, K_SERVER, K_TIMEOUT, K_TRUNCATED)
from .airouter import AIRouter, PERMANENT_COOLDOWN_SECONDS, RouterSettings
from .errors import PermanentError, TransientError
from .ollama import MAX_UNTRUSTED_CHARS, UNTRUSTED_NOTICE, validate

GEMINI_HOST = "https://generativelanguage.googleapis.com"       # fixed; not configurable, so the key can only be sent here
DEFAULT_MODEL = "gemini-3.8-flash"      # Phase 6: one pinned stable ID for chat planning and structured output (decision D2); never an alias


class GeminiClient:
    def __init__(self, api_key: str, model: str = DEFAULT_MODEL, session: requests.Session | None = None, *,
                 thinking: str = "low", max_output_fast: int = 2048, max_output: int = 4096, json_model: str | None = None):
        if not api_key:
            raise PermanentError("Gemini API key is not set")
        if thinking == "minimal":
            raise ValueError("thinking level 'minimal' is not supported by gemini-3.8-flash")
        if thinking == "off":
            raise ValueError("Gemini 3.x thinking cannot be disabled; use 'low' to minimize reasoning effort")
        if thinking not in ("low", "medium", "high"):
            raise ValueError("thinking must be one of: low, medium, high")
        self._key, self.model, self.s = api_key, model or DEFAULT_MODEL, session or requests.Session()
        self.thinking, self.max_output_fast, self.max_output = thinking, max_output_fast, max_output
        self.json_model = json_model or self.model          # generate_json uses this pinned ID; chat_json keeps `model`

    @staticmethod
    def _contents(messages: list[dict]) -> list[dict]:
        """Map user/assistant turns to Gemini's user/model turns, merging consecutive turns of the same role."""
        out: list[dict] = []
        for m in messages:
            role = "model" if m.get("role") == "assistant" else "user"
            text = str(m.get("content", ""))
            if out and out[-1]["role"] == role:
                out[-1]["parts"][0]["text"] += "\n\n" + text
            else:
                out.append({"role": role, "parts": [{"text": text}]})
        if not out or out[0]["role"] != "user":
            out.insert(0, {"role": "user", "parts": [{"text": "(start of conversation)"}]})
        return out

    def _chat_generation_config(self) -> dict:
        """Agent Chat planning request settings. Gemini 3.x models get the same low thinking level and larger output budget as generate_json,
        because thinking tokens count toward maxOutputTokens and a 1,500 cap could truncate the plan. A model set explicitly to an older family
        (KAIRFLOW_GEMINI_MODEL=gemini-2.5-flash) keeps the original request exactly."""
        if self.model.startswith("gemini-3"):
            cfg = {"responseMimeType": "application/json", "maxOutputTokens": self.max_output_fast}
            if self.thinking:
                cfg["thinkingConfig"] = {"thinkingLevel": self.thinking}
            return cfg
        return {"temperature": 0, "responseMimeType": "application/json", "maxOutputTokens": 1500}

    def chat_json_ex(self, system: str, messages: list[dict], schema: dict, *, timeout: int = 45, site: str = "chat.plan", **_ignored) -> AIResult:
        # The schema goes in the instructions and is enforced by validate(). Gemini's own responseSchema is an OpenAPI subset that
        # rejects free-form objects such as `args`, so only JSON mode is requested from the API.
        instruction = (system + "\n\nReturn ONLY one JSON object that matches this JSON schema, with no other text:\n"
                       + json.dumps(schema, ensure_ascii=False))
        payload = {
            "systemInstruction": {"parts": [{"text": instruction}]},
            "contents": self._contents(messages),
            "generationConfig": self._chat_generation_config(),
        }
        return self._call(self.model, payload, schema, timeout, site)

    def chat_json(self, system: str, messages: list[dict], schema: dict, *, timeout: int = 45, **_ignored) -> dict:
        return self.chat_json_ex(system, messages, schema, timeout=timeout).data

    # ---- generate_json: the same contract as OllamaClient.generate_json, plus per-call provenance (Phase 2) --------------------------
    def _generation_config(self, fast: bool) -> dict:
        """`fast` has no separate Gemini model (Ollama uses a 1.5B and a 3B model; Gemini uses one). The mapping is: fast=True gets a smaller output
        budget, fast=False a larger one. Both use the configured thinking level (default low; never 'minimal'). Thinking tokens count toward
        maxOutputTokens, which is why the budget is far above the 1,500 used for chat planning. thinkingLevel is only sent to Gemini 3.x models."""
        cfg = {"responseMimeType": "application/json", "maxOutputTokens": self.max_output_fast if fast else self.max_output}
        if not self.json_model.startswith("gemini-3"):
            cfg["temperature"] = 0
        if self.thinking and self.json_model.startswith("gemini-3"):
            cfg["thinkingConfig"] = {"thinkingLevel": self.thinking}
        return cfg

    @staticmethod
    def _header(r, name: str):
        h = getattr(r, "headers", None) or {}
        for k in h:
            if str(k).lower() == name.lower():
                return h[k]
        return None

    @staticmethod
    def _error_obj(r) -> dict:
        try:
            body = r.json()
            err = body.get("error") if isinstance(body, dict) else None
            return err if isinstance(err, dict) else {}
        except Exception:
            return {}

    def _is_invalid_key(self, r) -> bool:
        """Google answers a bad API key with HTTP 400 (reason API_KEY_INVALID), not 401, so a 400 is permanent only when it says so."""
        err = self._error_obj(r)
        for d in err.get("details") or []:
            if isinstance(d, dict) and str(d.get("reason", "")).upper() in ("API_KEY_INVALID", "API_KEY_NOT_FOUND", "API_KEY_EXPIRED"):
                return True
        return "api key not valid" in str(err.get("message", "")).lower()

    def _rate_limit_error(self, r) -> GeminiTransient:
        """Tell a per-minute limit from daily exhaustion using Google's QuotaFailure details, and read Retry-After / RetryInfo."""
        err = self._error_obj(r)
        details = [d for d in (err.get("details") or []) if isinstance(d, dict)]
        daily = False
        retry_after = None
        for d in details:
            for v in d.get("violations") or []:
                text = (str(v.get("quotaId", "")) + str(v.get("quotaMetric", ""))).lower().replace("_", "")
                if "perday" in text or "daily" in text:
                    daily = True
            if str(d.get("@type", "")).endswith("RetryInfo"):
                try:
                    retry_after = float(str(d.get("retryDelay", "")).rstrip("s"))
                except ValueError:
                    pass
        h = self._header(r, "Retry-After")
        if h is not None:
            try:
                retry_after = float(h)
            except (TypeError, ValueError):
                pass
        if daily:
            return GeminiTransient("Gemini 429 (daily quota)", K_RATE_DAILY, retry_after)
        return GeminiTransient("Gemini 429 (rate limit)", K_RATE_MINUTE, retry_after)

    def generate_json_ex(self, instruction: str, untrusted: str, schema: dict, *, fast: bool = False, timeout: int = 60,
                         site: str = "unspecified", **_ignored) -> AIResult:
        """Same prompt layout and validation as Ollama's generate_json. Raises GeminiTransient (use the Ollama fallback) or GeminiPermanent
        (bad key / model; pause Gemini). Truncated, empty, blocked, non-JSON and schema-invalid answers are discarded and raised as transient."""
        untrusted = untrusted[:MAX_UNTRUSTED_CHARS]
        system = (UNTRUSTED_NOTICE + "\n\nReturn ONLY one JSON object that matches this JSON schema, with no other text:\n"
                  + json.dumps(schema, ensure_ascii=False))
        payload = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": f"{instruction}\n\n<untrusted>\n{untrusted}\n</untrusted>"}]}],
            "generationConfig": self._generation_config(fast),
        }
        return self._call(self.json_model, payload, schema, timeout, site)

    def _call(self, model: str, payload: dict, schema: dict, timeout: int, site: str) -> AIResult:
        """POST one generateContent request and turn the answer into a validated AIResult, or raise GeminiTransient / GeminiPermanent.
        Shared by generate_json_ex and chat_json_ex, so both classify every failure the same way and neither can return partial output."""
        try:
            r = self.s.post(f"{GEMINI_HOST}/v1beta/models/{model}:generateContent", json=payload, timeout=timeout,
                            headers={"x-goog-api-key": self._key, "Content-Type": "application/json"})
        except requests.Timeout:
            raise GeminiTransient("Gemini timed out", K_TIMEOUT) from None
        except requests.RequestException as exc:
            raise GeminiTransient(f"Gemini unavailable: {type(exc).__name__}", K_CONNECTION) from None   # not chained: could carry the URL
        if r.status_code == 429:
            raise self._rate_limit_error(r)
        if r.status_code == 408:
            raise GeminiTransient("Gemini 408", K_TIMEOUT)
        if r.status_code >= 500:
            raise GeminiTransient(f"Gemini {r.status_code}", K_SERVER)
        if r.status_code in (401, 403, 404) or (r.status_code == 400 and self._is_invalid_key(r)):
            raise GeminiPermanent(f"Gemini rejected the request ({r.status_code}); check the API key and model name {model!r}", K_AUTH)
        if r.status_code >= 400:                  # one odd request (e.g. a 400 on this prompt) must not pause Gemini for every call site
            raise GeminiTransient(f"Gemini rejected this request ({r.status_code})", K_BAD_REQUEST)
        try:
            body = r.json()
        except ValueError:
            raise GeminiTransient("Gemini returned a non-JSON response", K_INVALID_JSON) from None
        if not isinstance(body, dict):
            raise GeminiTransient("Gemini returned an unusable response", K_EMPTY)
        usage = body.get("usageMetadata") if isinstance(body.get("usageMetadata"), dict) else {}
        cands = body.get("candidates")
        if not isinstance(cands, list) or not cands or not isinstance(cands[0], dict):
            blocked = (body.get("promptFeedback") or {}).get("blockReason") if isinstance(body.get("promptFeedback"), dict) else None
            raise GeminiTransient("Gemini blocked the prompt" if blocked else "Gemini returned no candidates", K_BLOCKED if blocked else K_EMPTY)
        cand = cands[0]
        finish = cand.get("finishReason")
        if finish == "MAX_TOKENS":
            raise GeminiTransient("Gemini output was truncated (MAX_TOKENS)", K_TRUNCATED)
        if finish not in (None, "STOP"):
            raise GeminiTransient(f"Gemini stopped early ({str(finish)[:40]})", K_BLOCKED)
        parts = (cand.get("content") or {}).get("parts") if isinstance(cand.get("content"), dict) else None
        text = "".join(p.get("text", "") for p in (parts or []) if isinstance(p, dict) and not p.get("thought")).strip()
        if not text:
            raise GeminiTransient("Gemini returned empty output", K_EMPTY)
        try:
            out = json.loads(text)
        except ValueError:
            raise GeminiTransient("Gemini returned text that is not JSON", K_INVALID_JSON) from None
        try:
            validate(schema, out)
        except (ValueError, KeyError, TypeError, AttributeError):
            raise GeminiTransient("Gemini output does not match the schema", K_SCHEMA) from None
        if not isinstance(out, dict):
            raise GeminiTransient("Gemini output is not a JSON object", K_SCHEMA)
        reported = body.get("modelVersion") if isinstance(body.get("modelVersion"), str) else None
        return AIResult(data=out, provider="gemini", model=model, model_reported=reported, site=site, finish_reason=finish or "STOP",
                        usage={"promptTokens": usage.get("promptTokenCount"), "outputTokens": usage.get("candidatesTokenCount"),
                               "thoughtsTokens": usage.get("thoughtsTokenCount"), "totalTokens": usage.get("totalTokenCount")})


    def generate_json(self, instruction: str, untrusted: str, schema: dict, *, fast: bool = False, timeout: int = 60, **kw) -> dict:
        return self.generate_json_ex(instruction, untrusted, schema, fast=fast, timeout=timeout, **kw).data


class FallbackLLM:
    """chat_json (Agent Chat) and generate_json / generate_json_ex all go through the one AIRouter (policy per call site; Agent Chat defaults to
    Gemini first, structured extraction defaults to Ollama unless a phase moved the site). Every other method is Ollama's, unchanged."""

    def __init__(self, primary, fallback, clock=time.monotonic, settings: RouterSettings | None = None):
        self.primary, self.fallback, self.clock = primary, fallback, clock
        self.router = AIRouter(primary, fallback, settings, clock)
        self.last_backend = "ollama"          # Agent Chat heartbeat only; per-call provenance is AIResult.provider
        self.last_chat: dict = {}

    @property
    def last_gemini_error(self) -> str | None:
        return self.router.last_gemini_error

    @last_gemini_error.setter
    def last_gemini_error(self, v: str | None) -> None:
        self.router.last_gemini_error = v

    @property
    def _disabled_until(self) -> float:    # one permanent-error cooldown shared by chat and generate_json
        return self.router.permanent_until

    @_disabled_until.setter
    def _disabled_until(self, v: float) -> None:
        self.router.permanent_until = v

    def chat_json(self, system: str, messages: list[dict], schema: dict, **kw) -> dict:
        """Agent Chat planning, through the shared router (site chat.plan): same policy, free-tier budget, backoff and cooldowns as every other call.
        Gemini first unless the policy or the rollback flag says Ollama; one Ollama attempt if Gemini fails or is skipped."""
        res = self.chat_json_ex("chat.plan", system, messages, schema, **kw)
        self.last_backend = res.provider                          # heartbeat convenience only; per-call provenance is the AIResult
        self.last_chat = {"provider": res.provider, "model": res.model, "route_reason": res.route_reason}
        return res.data

    def chat_json_ex(self, site: str, system: str, messages: list[dict], schema: dict, **kw) -> AIResult:
        return self.router.chat_json_ex(site, system, messages, schema, **kw)

    def generate_json(self, instruction: str, untrusted: str, schema: dict, **kw) -> dict:
        return self.router.generate_json(instruction, untrusted, schema, **kw)

    def generate_json_ex(self, site: str, instruction: str, untrusted: str, schema: dict, **kw) -> AIResult:
        return self.router.generate_json_ex(site, instruction, untrusted, schema, **kw)

    def ai_status(self) -> dict:
        return self.router.status()

    def private_text_allowed(self, site: str) -> bool:        # explicit: __getattr__ below would otherwise answer from the Ollama client
        return self.router.private_text_allowed(site)

    def __getattr__(self, name):                                   # list_models, is_up, ... stay on Ollama
        if name in ("router", "primary", "fallback", "clock"):     # not yet set (e.g. during unpickling/copy): avoid recursion
            raise AttributeError(name)
        return getattr(self.fallback, name)
