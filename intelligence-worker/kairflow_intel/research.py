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

PAGE_HINT = re.compile(r"portfolio|works|productions?|projects?|animation|services?|2d|anime|studio|profile|about|company|clients?|partners?|process|contact|business|career|recruit|job|press|news|team|採用|求人|募集|お問い合わせ|会社|作品|実績|制作|事業|業務|会社概要", re.I | re.U)
PAGE_LIMIT = 8

def _page_rank(url: str, anchor: str) -> tuple[int, str]:
    value = f"{anchor} {urlparse(url).path}".lower()
    if re.search(r"portfolio|works|productions?|projects?|作品|実績", value): return (0, url)
    if re.search(r"animation|services?|2d|anime|制作|事業|業務", value): return (1, url)
    if re.search(r"profile|about|company|clients?|partners?|process|会社概要", value): return (2, url)
    if re.search(r"contact|business|お問い合わせ|ご依頼", value): return (3, url)
    if re.search(r"career|recruit|job|採用|求人|募集", value): return (4, url)
    return (5, url)
ENTITY_SCHEMA = {"type": "object", "required": ["language", "contact_name", "contact_role"], "properties": {
    "language": {"type": "string", "enum": ["en", "ja", "other"]},
    "country_hint": {"type": ["string", "null"], "maxLength": 60},
    "contact_name": {"type": ["string", "null"], "maxLength": 80},
    "contact_role": {"type": ["string", "null"], "maxLength": 80}}}
ENTITY_INSTRUCTION = ("From the page text, give: the main language of the site (en, ja or other); the country if stated; and, ONLY if a specific person "
                      "responsible for business enquiries, production or recruitment is named, their name and role. Otherwise null. Do not guess.")


def _h(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()[:40]


def candidate_pages(home_url: str, html: str, limit: int = PAGE_LIMIT) -> list[str]:
    base = urlparse(home_url)
    soup, ranked, seen = BeautifulSoup(html, "lxml"), [], {home_url.split("#")[0]}
    for a in soup.find_all("a", href=True):
        u = urljoin(home_url, a["href"]).split("#")[0]
        p = urlparse(u)
        if p.scheme not in ("http", "https") or p.hostname != base.hostname or u in seen:
            continue
        anchor = a.get_text(" ", strip=True)
        if not PAGE_HINT.search(f"{anchor} {p.path}"):
            continue
        seen.add(u); ranked.append((_page_rank(u, anchor), u))
    ranked.sort(key=lambda x: x[0])
    return [u for _, u in ranked[:max(0, limit)]]


def _page_language(html: str) -> str | None:
    soup = BeautifulSoup(html, "lxml")
    raw = (soup.html.get("lang") or "").strip().lower() if soup.html else ""
    if raw:
        code = raw.split("-")[0]
        return code if code in ("en", "ja") else "other"
    body = soup.get_text(" ", strip=True)
    if re.search(r"[\u3040-\u30ff]", body):
        return "ja"
    words = re.findall(r"[A-Za-z]{2,}", body)
    if len(words) >= 5 and any(w.lower() in {"the", "and", "we", "our", "studio", "animation", "production", "services"} for w in words):
        return "en"
    return None


def _validated_language(model_value, pages) -> str:
    # Explicit HTML lang on the homepage is authoritative; then use page text; the optional model is last resort.
    for _, html in pages:
        soup = BeautifulSoup(html, "lxml")
        raw = (soup.html.get("lang") or "").strip().lower() if soup.html else ""
        if raw:
            code = raw.split("-")[0]
            return code if code in ("en", "ja") else "other"
    detected = [_page_language(html) for _, html in pages]
    detected = [x for x in detected if x]
    if detected:
        return max(set(detected), key=detected.count)
    return "other"


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
    for u in candidate_pages(final, html, PAGE_LIMIT):
        try:
            fetched = fetcher.fetch(u)
            if urlparse(fetched[0]).hostname == urlparse(final).hostname:
                pages.append(fetched)
        except (PermanentError, TransientError):
            continue
    text = "\n".join(html_to_text(h) for _, h in pages)
    table = signals.INDIE if p["type"] == "indie_game_developer" else signals.STUDIO
    found: dict[str, list[tuple[str, str]]] = {}
    for url, h in pages:
        for name, sent in signals.detect(html_to_text(h), table).items():
            bucket = found.setdefault(name, [])
            if all(_h(old_sent) != _h(sent) for old_sent, _ in bucket):
                bucket.append((sent, url))
                if len(bucket) > 8: bucket.pop()
    emails = [dict(e, url=u) for u, h in pages for e in extract_emails(h)]
    preset = (p.get("contact_email") or "")
    contact = choose_contact(emails, p["domain"], preset if p["type"] == "indie_game_developer" else "")

    ent = {"language": None, "country_hint": None, "contact_name": None, "contact_role": None}
    try:
        model_ent = llm(text[:9000])
        if isinstance(model_ent, dict): ent = {**ent, **model_ent}
    except (TransientError, PermanentError, ValueError, TypeError):
        pass
    language = _validated_language(ent.get("language"), pages)
    name = ent.get("contact_name") if ent.get("contact_name") and quote_in_text(ent["contact_name"], text, min_len=4) else None
    role = ent.get("contact_role") if name and ent.get("contact_role") and quote_in_text(ent["contact_role"], text, min_len=3) else None

    for sig, evidence_rows in found.items():
        for sent, url in evidence_rows:
            rpc("intel_agent_add_evidence", {"p_prospect_id": p["id"], "p_source": "web", "p_url": url, "p_fact_type": sig, "p_snippet": sent, "p_content_hash": _h(sent), "p_verified": True})
    existing = (p.get("contact_email") or "").strip().lower()
    prior_verified = ((p.get("facts") or {}).get("verified") or {})
    prior_verified_email = (prior_verified.get("contact_email") or "").strip().lower()
    manually_verified = (
        prior_verified.get("contact_verification") == "human_confirmed"
        and bool(existing)
        and prior_verified_email == existing
    )
    selected_is_existing = bool(contact and existing and contact["email"] == existing)
    # Never re-label a pre-existing address as website evidence unless this exact address was re-extracted.
    website_verified = bool(contact and contact.get("how") != "store" and (not existing or selected_is_existing))
    src = next((e["url"] for e in emails if contact and e["email"] == contact["email"]), "") if website_verified else ""
    if website_verified:
        rpc("intel_agent_add_evidence", {"p_prospect_id": p["id"], "p_source": "web", "p_url": src, "p_fact_type": "contact_email", "p_snippet": contact["email"], "p_content_hash": _h(contact["email"]), "p_verified": True})
    verified = {"signals": sorted(found), "language": language, "contact_role": role or "", "pages_read": len(pages)}
    if contact and contact.get("how") == "store" and p["type"] == "indie_game_developer":
        src = p.get("contact_source_url") or ""
        verified.update({"contact_verification": "store_listing", "contact_email": contact["email"], "contact_source_url": src})
    if manually_verified:
        verified.update({"contact_verification": "human_confirmed", "contact_email": existing})
    elif website_verified:
        verified.update({"contact_verification": "website_extracted", "contact_email": contact["email"], "contact_source_url": src})
    elif existing:
        verified.update({"contact_verification": "unknown_legacy", "contact_email": existing})
    rpc("intel_agent_upsert_prospect", {"p_type": p["type"], "p_name": p["name"], "p_website": p["website"], "p_contact_name": name or "", "p_contact_email": contact["email"] if contact and not existing else "",
                                        "p_contact_source_url": (src if website_verified else ""), "p_country": ent.get("country_hint") or "", "p_language": language, "p_verified": verified})
    return {"signals": sum(map(len, found.values())), "contact": bool(contact), "contact_verified": website_verified or manually_verified, "pages": len(pages)}


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
    meta = {"language": verified.get("language") or "other"}
    email_status = verified.get("contact_verification")
    prospect_email = (p.get("contact_email") or "").strip().lower()
    verified_email = (verified.get("contact_email") or "").strip().lower()
    email_is_verified = (
        email_status in ("website_extracted", "human_confirmed")
        and bool(prospect_email)
        and verified_email == prospect_email
    )
    contact = {"email": prospect_email, "name": p.get("contact_name") or "", "role": verified.get("contact_role", "")} if email_is_verified else None
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
