"""Gemini client for Agent Chat planning, with Ollama as the fallback.

Scope: ONLY Agent Chat's planner call (`chat_json`) can use Gemini. Research, classification and drafting keep using the local
Ollama model, so prospect pages and inbound email bodies are not sent to Google by this module.

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

from .errors import PermanentError, TransientError
from .ollama import validate

GEMINI_HOST = "https://generativelanguage.googleapis.com"       # fixed; not configurable, so the key can only be sent here
DEFAULT_MODEL = "gemini-2.5-flash"
PERMANENT_COOLDOWN_SECONDS = 600                                 # after a bad key / unknown model, stop trying Gemini for a while


class GeminiClient:
    def __init__(self, api_key: str, model: str = DEFAULT_MODEL, session: requests.Session | None = None):
        if not api_key:
            raise PermanentError("Gemini API key is not set")
        self._key, self.model, self.s = api_key, model or DEFAULT_MODEL, session or requests.Session()

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

    def chat_json(self, system: str, messages: list[dict], schema: dict, *, timeout: int = 45, **_ignored) -> dict:
        # The schema goes in the instructions and is enforced by validate() below. Gemini's own responseSchema is an OpenAPI subset that
        # rejects free-form objects such as `args`, so only JSON mode is requested from the API.
        instruction = (system + "\n\nReturn ONLY one JSON object that matches this JSON schema, with no other text:\n"
                       + json.dumps(schema, ensure_ascii=False))
        payload = {
            "systemInstruction": {"parts": [{"text": instruction}]},
            "contents": self._contents(messages),
            "generationConfig": {"temperature": 0, "responseMimeType": "application/json", "maxOutputTokens": 1500},
        }
        try:
            r = self.s.post(f"{GEMINI_HOST}/v1beta/models/{self.model}:generateContent", json=payload, timeout=timeout,
                            headers={"x-goog-api-key": self._key, "Content-Type": "application/json"})
        except requests.RequestException as exc:
            raise TransientError(f"Gemini unavailable: {type(exc).__name__}") from None   # not chained: the message could carry the URL
        if r.status_code in (408, 429) or r.status_code >= 500:
            raise TransientError(f"Gemini {r.status_code}")
        if r.status_code >= 400:
            raise PermanentError(f"Gemini rejected the request ({r.status_code}); check the API key and model name {self.model!r}")
        try:
            body = r.json()
            cand = body["candidates"][0]
            text = "".join(p.get("text", "") for p in cand["content"]["parts"])
            out = json.loads(text)
            validate(schema, out)
        except (ValueError, KeyError, IndexError, TypeError, AttributeError) as exc:
            raise TransientError(f"Gemini returned an unusable answer: {type(exc).__name__}") from None
        return out


class FallbackLLM:
    """Gemini first for chat_json, Ollama if Gemini fails. Every other method is Ollama's, unchanged."""

    def __init__(self, primary, fallback, clock=time.monotonic):
        self.primary, self.fallback, self.clock = primary, fallback, clock
        self.last_backend = "ollama"
        self.last_gemini_error: str | None = None
        self._disabled_until = 0.0

    def chat_json(self, system: str, messages: list[dict], schema: dict, **kw) -> dict:
        if self.primary is not None and self.clock() >= self._disabled_until:
            try:
                out = self.primary.chat_json(system, messages, schema, **{k: v for k, v in kw.items() if k == "timeout"})
                self.last_backend, self.last_gemini_error = "gemini", None
                return out
            except PermanentError as exc:
                self._disabled_until = self.clock() + PERMANENT_COOLDOWN_SECONDS
                self.last_gemini_error = str(exc)[:200]
            except TransientError as exc:
                self.last_gemini_error = str(exc)[:200]
        self.last_backend = "ollama"
        return self.fallback.chat_json(system, messages, schema, **kw)

    def __getattr__(self, name):                                   # generate_json, list_models, is_up, ... stay on Ollama
        return getattr(self.fallback, name)
