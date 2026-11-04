"""'Add from X post': the administrator pastes a post they found. Nothing is fetched from X. The agent works out which studio it names,
tells a studio from an individual, and investigates the studio on its own website."""
from __future__ import annotations

import re
from urllib.parse import urlparse

from . import classify_org, entity, wikidata
from .errors import PermanentError, TransientError
from .safety import norm, quote_in_text

URL = re.compile(r"https?://[^\s<>\"')\]]+", re.I)
SCHEMA = {"type": "object", "required": ["organization", "recruiting_for_studio"], "properties": {
    "organization": {"type": ["string", "null"], "maxLength": 100},
    "recruiting_for_studio": {"type": "boolean"}}}
INSTRUCTION = ("This is a social media post. Name the animation studio or production company that is recruiting or seeking outside animation help, "
               "exactly as written in the post, or null if no company is named (for example an individual offering their own services). "
               "recruiting_for_studio is true only if a company is looking for animators or outside production help.")


def external_sites(text: str) -> list[str]:
    out = []
    for u in URL.findall(text or ""):
        u = u.rstrip(".,)")
        if not entity.is_social_or_platform(u):
            p = urlparse(u)
            site = f"{p.scheme}://{p.netloc}"
            if site not in out:
                out.append(site)
    return out


def analyze(d, item: dict, ptype: str, llm, api) -> dict:
    text = ((item.get("meta") or {}).get("text") or item.get("snippet") or "")[:4000]
    url = item.get("url") or ""
    verdict = classify_org.classify(text)
    if verdict["kind"] == "individual":
        d.rpc("intel_agent_record_item", {"p_source": "x_manual", "p_type": "manual_post", "p_url": url, "p_title": "", "p_snippet": text[:500], "p_language": "", "p_prospect_id": None,
                                          "p_meta": {"result": "individual", "reasons": verdict["reasons"], "text": text}})
        return {"result": "individual"}
    org = None
    try:
        out = llm(text)
        cand = (out.get("organization") or "").strip()
        if cand and (norm(cand) in norm(text)) and out.get("recruiting_for_studio"):
            org = cand
    except (TransientError, PermanentError):
        pass
    sites = external_sites(text)
    site = sites[0] if sites else ""
    if not site and org:
        try:
            hit = wikidata.lookup_website(api, org)
            site = hit["website"] if hit else ""
        except (TransientError, PermanentError):
            site = ""
    if not (org or site):
        d.rpc("intel_agent_record_item", {"p_source": "x_manual", "p_type": "manual_post", "p_url": url, "p_title": "", "p_snippet": text[:500], "p_language": "", "p_prospect_id": None,
                                          "p_meta": {"result": "no_studio_found", "text": text}})
        return {"result": "no_studio_found"}
    from .discovery import ingest
    pid, _ = ingest(d, ptype, {"name": org or entity.registrable_domain(site), "website": site, "meta": {"source": "x_manual", "x_post_url": url, "verified_by": "administrator"}}, via="x_manual")
    if pid:
        d.rpc("intel_agent_add_evidence", {"p_prospect_id": pid, "p_source": "x_manual", "p_url": url, "p_fact_type": "manual_post", "p_snippet": text[:600], "p_content_hash": norm(text)[:40] or "post", "p_verified": True})
        d.rpc("intel_agent_record_item", {"p_source": "x_manual", "p_type": "manual_post", "p_url": url, "p_title": org or "", "p_snippet": text[:500], "p_language": "", "p_prospect_id": pid,
                                          "p_meta": {"result": "studio", "text": text}})
    return {"result": "studio", "prospect_id": pid}
