"""Call-site helper: run a structured extraction through the AI router (when there is one) and return provenance with the result.

Provenance is a small, secret-free dict stored next to what the model produced (source-item meta, job results):
  {"provider": "gemini"|"ollama", "model": exact model ID, "site": "discovery.news", "fallback_reason": "..."?, "model_reported": "..."?}
`fallback_reason` is present only when Ollama served a call that was meant to try Gemini first, or was configured to use Ollama.
"""
from __future__ import annotations

import logging

from .errors import PermanentError

log = logging.getLogger("kairflow_intel.ai_call")


def provenance(res) -> dict:
    out = {"provider": res.provider, "model": res.model, "site": res.site}
    if res.route_reason:
        out["fallback_reason"] = res.route_reason
    if res.model_reported and res.model_reported != res.model:
        out["model_reported"] = res.model_reported
    return out


def call_json(llm, site: str, instruction: str, untrusted: str, schema: dict, *, fast: bool = False, prefer_ollama: bool = False,
              **kw) -> tuple[dict, dict]:
    """Returns (data, provenance). Errors propagate exactly as Ollama's would (TransientError / PermanentError).
    `prefer_ollama` skips Gemini for this one call (a client with no router is Ollama already)."""
    ex = getattr(llm, "generate_json_ex", None)
    if callable(ex):
        res = ex(site, instruction, untrusted, schema, fast=fast, **({"prefer_ollama": True} if prefer_ollama else {}), **kw)
        return res.data, provenance(res)
    data = llm.generate_json(instruction, untrusted, schema, fast=fast, **kw)          # a plain client with no router: Ollama
    cfg = getattr(llm, "cfg", None)
    model = getattr(cfg, "ollama_fast_model" if fast else "ollama_model", None) or "ollama"
    return data, {"provider": "ollama", "model": model, "site": site, "fallback_reason": "no_router"}


def routed(llm, site: str, rec: list | None = None, *, prefer_ollama: bool = False):
    """An (instruction, payload, schema) -> data callable for the composers in drafting.py, routed through `site`.
    Each call's provenance is appended to `rec` (when given) so the caller can stamp the draft that the call produced.
    Errors propagate exactly as Ollama's would."""
    def call(instruction, payload, schema, **kw):
        data, prov = call_json(llm, site, instruction, payload, schema, prefer_ollama=prefer_ollama, **kw)
        if rec is not None:
            rec.append(prov)
        return data
    return call


def stamp(mail, rec: list):
    """Attach the provenance of the model call that wrote this draft (mail[\"ai\"]). Template drafts get nothing. Clears `rec`, so a
    regenerated draft never inherits an earlier attempt's provenance."""
    if isinstance(mail, dict) and mail.get("model_written") and rec:
        mail["ai"] = {**rec[-1], "model_calls": len(rec)}
    rec.clear()
    return mail


def composed(llm, site: str, rec: list, run):
    """Run one draft composition and stamp its provenance. `run(llm_callable)` calls a composer in drafting.py with the callable as its `llm`.

    A provider failure already falls back to Ollama inside the router. A draft that Gemini wrote but the composer's own validators then refuse
    (an evidence id that does not exist, wrong language, a name or claim not in the evidence, ...) is a different failure that the router never
    sees: it raised PermanentError and the prospect went to manual review although Ollama might have written a valid draft. So, when the model
    call that wrote the refused draft was Gemini, the composition is retried ONCE on Ollama (the same validators apply), and only then is the
    PermanentError allowed through. Never more than one retry; a refusal raised before any model call (missing knowledge base, a consequential
    inbound message) and a refusal of an Ollama draft both go straight through. TransientError (Ollama down) propagates so the job retries."""
    rec.clear()                                  # nothing from an earlier, failed composition counts as this one's provenance
    try:
        mail = run(routed(llm, site, rec))
    except PermanentError:
        if not (rec and rec[-1].get("provider") == "gemini"):
            raise
        log.info("ai retry site=%s: the draft written by Gemini was refused by the composer; one attempt on Ollama", site)
        mail = run(routed(llm, site, rec, prefer_ollama=True))
    return stamp(mail, rec)
