"""Research and qualification of one prospect. Facts come from deterministic reading of the prospect's own pages; the
model only helps identify a named contact, and its claims count only if the text literally appears on the page."""
from __future__ import annotations

import hashlib
import json
import re
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from . import scoring, signals
from .errors import PermanentError, TransientError
from .ollama import validate
from .safety import extract_emails, html_to_text, quote_in_text

PAGE_HINT = re.compile(r"contact|about|career|recruit|job|press|news|team|company|studio|outsourc|freelanc|採用|求人|募集|お問い合わせ|会社", re.I | re.U)
ENTITY_SCHEMA = {"type": "object", "required": ["language", "contact_name", "contact_role"], "properties": {
    "language": {"type": "string", "enum": ["en", "ja", "other"]},
    "country_hint": {"type": ["string", "null"], "maxLength": 60},
    "contact_name": {"type": ["string", "null"], "maxLength": 80},
    "contact_role": {"type": ["string", "null"], "maxLength": 80}}}
ENTITY_INSTRUCTION = ("From the page text, give: the main language of the site (en, ja or other); the country if stated; and, ONLY if a specific person "
                      "responsible for business enquiries, production or recruitment is named, their name and role. Otherwise null. Do not guess.")


def _h(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()[:40]


def candidate_pages(home_url: str, html: str, limit: int = 4) -> list[str]:
    base = urlparse(home_url)
    soup, out = BeautifulSoup(html, "lxml"), []
    for a in soup.find_all("a", href=True):
        u = urljoin(home_url, a["href"]).split("#")[0]
        p = urlparse(u)
        if p.scheme in ("http", "https") and p.hostname == base.hostname and u != home_url and PAGE_HINT.search(f"{a.get_text(' ', strip=True)} {p.path}") and u not in out:
            out.append(u)
        if len(out) >= limit:
            break
    return out


def choose_contact(emails: list[dict], domain: str, preset: str = "") -> dict | None:
    """Every address here came from the prospect's own pages or store listing. Prefer one on their own domain."""
    pool = list(emails)
    if preset:
        pool.insert(0, {"email": preset, "how": "store"})
    def rank(e):
        d = e["email"].split("@")[1]
        own = domain and (d == domain or d.endswith("." + domain) or domain.endswith("." + d))
        return (0 if own else 1 if e["how"] == "store" else 2, 0 if e["how"] in ("mailto", "store") else 1)
    pool = [e for e in pool if re.fullmatch(r"[^@\s]+@[^@\s]+\.[a-z]{2,}", e["email"])]
    return sorted(pool, key=rank)[0] if pool else None


def research(rpc, fetcher, llm, ctx: dict) -> dict:
    """Fetch, read, store evidence. Returns what was learned. Raises PermanentError when there is nothing to read."""
    p = ctx["prospect"]
    site = p["website"] if p["website"].startswith("http") else (f"https://{p['website']}" if p["website"] else "")
    if not site:
        raise PermanentError("prospect has no website to research")
    final, html = fetcher.fetch(site)
    pages = [(final, html)]
    for u in candidate_pages(final, html):
        try:
            pages.append(fetcher.fetch(u))
        except (PermanentError, TransientError):
            continue
    text = "\n".join(html_to_text(h) for _, h in pages)
    table = signals.INDIE if p["type"] == "indie_game_developer" else signals.STUDIO
    found: dict[str, tuple[str, str]] = {}
    for url, h in pages:
        for name, sent in signals.detect(html_to_text(h), table).items():
            found.setdefault(name, (sent, url))
    emails = [dict(e, url=u) for u, h in pages for e in extract_emails(h)]
    preset = (p.get("contact_email") or "")
    contact = choose_contact(emails, p["domain"], preset)

    ent = {"language": "en", "country_hint": None, "contact_name": None, "contact_role": None}
    try:
        ent = llm(text[:9000])
    except (TransientError, PermanentError):
        pass                                           # the model is optional here: deterministic facts still stand
    name = ent.get("contact_name") if ent.get("contact_name") and quote_in_text(ent["contact_name"], text, min_len=4) else None
    role = ent.get("contact_role") if name and ent.get("contact_role") and quote_in_text(ent["contact_role"], text, min_len=3) else None

    for sig, (sent, url) in found.items():
        rpc("intel_agent_add_evidence", {"p_prospect_id": p["id"], "p_source": "web", "p_url": url, "p_fact_type": sig, "p_snippet": sent, "p_content_hash": _h(sent), "p_verified": True})
    if contact:
        src = next((e["url"] for e in emails if e["email"] == contact["email"]), p.get("contact_source_url") or final)
        rpc("intel_agent_add_evidence", {"p_prospect_id": p["id"], "p_source": "web", "p_url": src, "p_fact_type": "contact_email", "p_snippet": contact["email"], "p_content_hash": _h(contact["email"]), "p_verified": True})
    verified = {"signals": sorted(found), "language": ent.get("language") or "en", "contact_role": role or "", "pages_read": len(pages)}
    rpc("intel_agent_upsert_prospect", {"p_type": p["type"], "p_name": p["name"], "p_website": p["website"], "p_contact_name": name or "", "p_contact_email": contact["email"] if contact else "",
                                        "p_contact_source_url": (src if contact else ""), "p_country": ent.get("country_hint") or "", "p_language": ent.get("language") or "en", "p_verified": verified})
    return {"signals": len(found), "contact": bool(contact), "pages": len(pages)}


def prior_studio_model(p: dict) -> str | None:
    """Which model produced the score already stored on a studio prospect (None = never scored). Scores written before
    Phase 1 carry no version marker and are studio-v1."""
    if p.get("score") is None:
        return None
    rows = p.get("score_breakdown")
    for r in rows if isinstance(rows, list) else []:
        if isinstance(r, dict) and r.get("model"):
            return r["model"]
    return ((p.get("facts") or {}).get("estimates") or {}).get("scoring_model") or scoring.STUDIO_LEGACY_MODEL


def _qualify_studio(rpc, ctx: dict, criteria: dict) -> scoring.Result:
    p = ctx["prospect"]
    sigs: dict[str, list[str]] = {}
    for e in ctx["evidence"]:                          # every verified sentence, not just the last one per signal
        if e["verified"] and e.get("snippet"):
            sigs.setdefault(e["fact_type"], []).append(e["snippet"])
    verified = (p.get("facts") or {}).get("verified", {})
    meta = {"language": verified.get("language") or p.get("language")}
    contact = {"email": p.get("contact_email") or "", "name": p.get("contact_name") or "", "role": verified.get("contact_role", "")} if p.get("contact_email") else None
    res = scoring.score_studio(sigs, meta, contact, qualify_min=int(criteria.get("qualify_min", 70)), review_min=int(criteria.get("review_min", 50)))
    prior = prior_studio_model(p)
    if prior is not None and prior != scoring.STUDIO_MODEL:
        # A score from an older model is never overwritten here. The new result is appended as UNVERIFIED evidence (append-only,
        # never read by drafting or scoring) so it can be compared later; Phase 6 owns the actual re-evaluation.
        snap = json.dumps({"model": res.model, "score": res.score, "decision": res.decision, "suitability": res.suitability, "uncertain": res.uncertain,
                           "reason": res.reason, "points": {i["item"]: i["points"] for r in res.breakdown for i in r["items"]}}, sort_keys=True)
        rpc("intel_agent_add_evidence", {"p_prospect_id": p["id"], "p_source": "scoring", "p_url": "", "p_fact_type": f"rescore_candidate_{scoring.STUDIO_MODEL}",
                                         "p_snippet": snap, "p_content_hash": _h(snap), "p_verified": False})
        res.held = True
        return res
    rpc("intel_agent_set_score", {"p_prospect_id": p["id"], "p_score": res.score, "p_breakdown": res.breakdown, "p_decision": res.decision, "p_reason": res.reason,
                                  "p_estimates": {"decision_basis": "deterministic rubric over verified evidence", "scoring_model": res.model}})
    return res


def qualify(rpc, ctx: dict, criteria: dict) -> scoring.Result:
    p = ctx["prospect"]
    if p["type"] != "indie_game_developer":
        return _qualify_studio(rpc, ctx, criteria)
    sigs = {e["fact_type"]: e["snippet"] for e in ctx["evidence"] if e["verified"]}
    verified = (p.get("facts") or {}).get("verified", {})
    meta = {"recent_activity": bool(verified.get("recent_activity", False)), "coming_soon": verified.get("coming_soon", False),
            "price_present": verified.get("price_present", False), "language": verified.get("language") or p.get("language")}
    contact = {"email": p.get("contact_email") or "", "name": p.get("contact_name") or "", "role": verified.get("contact_role", "")} if p.get("contact_email") else None
    fn = scoring.score_indie
    res = fn(sigs, meta, contact, qualify_min=int(criteria.get("qualify_min", 70)), review_min=int(criteria.get("review_min", 50)))
    rpc("intel_agent_set_score", {"p_prospect_id": p["id"], "p_score": res.score, "p_breakdown": res.breakdown, "p_decision": res.decision, "p_reason": res.reason,
                                  "p_estimates": {"decision_basis": "deterministic rubric over verified evidence"}})
    return res
