"""Research and qualification of one prospect. Facts come from deterministic reading of the prospect's own pages; the
model only helps identify a named contact, and its claims count only if the text literally appears on the page."""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import date, datetime, timezone
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from . import contactability, indie_evidence, scoring, signals
from .errors import PermanentError, TransientError
from .ai_call import call_json
from .ollama import validate
from .safety import extract_emails, html_to_text, quote_in_text_cjk, role_near_name

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
# Only the contact is asked for. The site language is decided from the pages themselves (_validated_language) and the country is never stored
# (the prospect upsert keeps the existing country), so asking the model for either would only cost output tokens.
ENTITY_SCHEMA = {"type": "object", "required": ["contact_name", "contact_role"], "properties": {
    "contact_name": {"type": ["string", "null"], "maxLength": 80},
    "contact_role": {"type": ["string", "null"], "maxLength": 80}}}
ENTITY_INSTRUCTION = ("From the page text, ONLY if a specific person responsible for business enquiries, production or recruitment is named, give their name "
                      "and role exactly as written on the page, with the role as written next to that person's name. Otherwise null. Do not guess.")


def entity_llm(llm, site: str):
    """The model call used by research and by the studio reevaluation: routed (Gemini first, Ollama fallback) when `llm` is the AI router,
    plain Ollama otherwise. Returns (data, provenance). Only the public page text is sent; the instruction and schema are fixed."""
    return lambda text: call_json(llm, site, ENTITY_INSTRUCTION, text, ENTITY_SCHEMA, fast=True)


def _h(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()[:40]


def _iso_date(value) -> date | None:
    """Parse a stored ISO date without treating malformed values as evidence."""
    try:
        raw = str(value or "").strip()
        return date.fromisoformat(raw[:10]) if raw else None
    except (TypeError, ValueError):
        return None


def _visual_review_pending(evidence_rows: list[dict], new_candidates: list[dict]) -> int:
    """Count unique persisted visual assets that still lack a human review record.

    Candidate rows are unverified visual_asset_candidate evidence. A human review
    resolves a candidate only when a verified admin-review visual evidence row
    explicitly records that exact media URL.
    """
    import re
    candidates: dict[str, tuple[str, str]] = {}
    reviewed: set[str] = set()
    candidate_re = re.compile(r"Unverified\s+[^:]+\s+candidate:\s*(https?://\S+)", re.I)
    reviewed_re = re.compile(r"reviewed media:\s*(https?://\S+)", re.I)
    for row in evidence_rows or []:
        if not isinstance(row, dict):
            continue
        fact = str(row.get("fact_type") or "")
        snippet = str(row.get("snippet") or "")
        if fact == "visual_asset_candidate" and not row.get("verified"):
            match = candidate_re.search(snippet)
            if match:
                asset = match.group(1).rstrip("|,;.)]")
                candidates[asset.casefold()] = (asset, str(row.get("url") or ""))
        elif row.get("verified") and str(row.get("source") or "") == "admin_review" and fact in {
            "anime_visual_screenshot", "anime_visual_artwork", "anime_visual_trailer", "anime_character_art"
        }:
            match = reviewed_re.search(snippet)
            if match:
                reviewed.add(match.group(1).rstrip("|,;.)]").casefold())
    for row in new_candidates or []:
        snippet = str(row.get("snippet") or "")
        match = candidate_re.search(snippet)
        if match:
            asset = match.group(1).rstrip("|,;.)]")
            candidates[asset.casefold()] = (asset, str(row.get("url") or ""))
    return sum(1 for asset in candidates if asset not in reviewed)


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
    # Explicit HTML lang is authoritative; then the page text. The model's answer (model_value) is deliberately ignored: it is unverified.
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


def _evidence_writer(rpc, p: dict, run_id: str | None):
    """Ordinary research writes through intel_agent_add_evidence (unchanged). A reevaluation writes through the run-scoped function, which
    also refreshes fetched_at on a sentence that was already stored, so the row counts as collected in this run."""
    if run_id is None:
        return lambda url, fact, snippet, h, verified=True: rpc("intel_agent_add_evidence", {"p_prospect_id": p["id"], "p_source": "web", "p_url": url, "p_fact_type": fact, "p_snippet": snippet, "p_content_hash": h, "p_verified": bool(verified)})
    return lambda url, fact, snippet, h, verified=True: rpc("intel_agent_reeval_add_evidence", {"p_run_id": run_id, "p_prospect_id": p["id"], "p_source": "web", "p_url": url, "p_fact_type": fact, "p_snippet": snippet, "p_content_hash": h, "p_verified": bool(verified)})


def research(rpc, fetcher, llm, ctx: dict, *, run_id: str | None = None) -> dict:
    """Fetch, read, store evidence. Returns what was learned. Raises PermanentError when there is nothing to read.
    run_id is set ONLY by the studio reevaluation: evidence and the learned facts then go through the run-scoped functions."""
    p = ctx["prospect"]
    if run_id is not None and (p.get("type") != "animation_studio_support" or p.get("origin") != "discovered"):
        raise PermanentError("a reevaluation only researches discovered animation_studio_support prospects")
    add_evidence = _evidence_writer(rpc, p, run_id)
    website = str(p.get("website") or "").strip()
    project_source = ""
    if p.get("type") == "indie_game_developer":
        verified_source = ((p.get("facts") or {}).get("verified") or {})
        project_source = str(p.get("project_source_url") or verified_source.get("project_url") or verified_source.get("game_url") or "").strip()
        steam_appid = str(verified_source.get("steam_appid") or "").strip()
        if not project_source and steam_appid.isdigit():
            project_source = f"https://store.steampowered.com/app/{steam_appid}/"
    raw_site = website or project_source
    site = raw_site if raw_site.startswith(("http://", "https://")) else (f"https://{raw_site}" if raw_site else "")
    parsed_site = urlparse(site) if site else None
    research_host = (parsed_site.hostname or "").casefold().removeprefix("www.") if parsed_site else ""
    if p.get("type") == "indie_game_developer" and parsed_site and (research_host == "kickstarter.com" or research_host.endswith(".kickstarter.com")):
        raise PermanentError("Kickstarter is manual-only and must never be fetched; add a separate official developer website")
    if not parsed_site or parsed_site.scheme not in {"http", "https"} or not parsed_site.hostname or "." not in parsed_site.hostname:
        raise PermanentError("prospect has no valid official website or project/store page to research")
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
    indie_events: list[dict] = []
    indie_visual_candidates: list[dict] = []
    indie_identity_mentions: list[dict] = []
    if p["type"] == "indie_game_developer":
        verified_before = ((p.get("facts") or {}).get("verified") or {})
        project_title = str(p.get("project_title") or verified_before.get("project_title") or verified_before.get("game") or "")
        developer_name = str(p.get("name") or verified_before.get("developer_name") or "")
        indie_events = indie_evidence.extract_dated_events(pages)
        indie_visual_candidates = indie_evidence.extract_visual_candidates(pages)
        indie_identity_mentions = indie_evidence.extract_identity_mentions(pages, developer_name, project_title)
        for event in indie_events:
            add_evidence(event["url"], event["fact_type"], event["snippet"], _h(event["fact_type"] + event["date"] + event["snippet"]))
        # Visual references are intentionally UNVERIFIED until an administrator inspects the actual asset.
        for candidate in indie_visual_candidates:
            add_evidence(candidate["url"], candidate["fact_type"], candidate["snippet"], _h(candidate["snippet"]), verified=False)
        for mention in indie_identity_mentions:
            add_evidence(mention["url"], mention["fact_type"], mention["snippet"], _h(mention["fact_type"] + mention["snippet"]))
    emails = [dict(e, url=u) for u, h in pages for e in extract_emails(h)]
    preset = (p.get("contact_email") or "")
    contact = choose_contact(emails, p["domain"], preset if p["type"] == "indie_game_developer" else "")

    ent = {"contact_name": None, "contact_role": None}
    ai_extraction = {"status": "ok", "provider": "unrecorded"}          # provenance of the model's extraction; stored with the prospect, never read by scoring
    try:
        model_ent = llm(text[:9000])
        if isinstance(model_ent, tuple) and len(model_ent) == 2:         # (data, provenance) from entity_llm
            model_ent, prov = model_ent
            ai_extraction = {"status": "ok", **(prov if isinstance(prov, dict) else {})}
        if isinstance(model_ent, dict): ent = {**ent, **model_ent}
    except (TransientError, PermanentError, ValueError, TypeError) as exc:
        ai_extraction = {"status": "unavailable", "error": type(exc).__name__}     # both providers failed (or no model): deterministic extraction only
    language = _validated_language(ent.get("language"), pages)
    name = ent.get("contact_name") if ent.get("contact_name") and quote_in_text_cjk(ent["contact_name"], text, min_len=4) else None
    role = (ent.get("contact_role") if name and ent.get("contact_role") and quote_in_text_cjk(ent["contact_role"], text, min_len=3)
            and role_near_name(name, ent["contact_role"], text) else None)

    for sig, evidence_rows in found.items():
        for sent, url in evidence_rows:
            add_evidence(url, sig, sent, _h(sent))
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
        add_evidence(src, "contact_email", contact["email"], _h(contact["email"]))
    # Preserve explicitly documented contact-affiliation and verification facts
    # across a website refresh; ordinary extraction must not erase human evidence.
    preserve_keys = [
        "contact_verification", "contact_email", "contact_source_url",
        "contact_verification_method", "contact_verified_at", "contact_verified_by",
    ]
    if p["type"] == "indie_game_developer":
        preserve_keys.extend([
            "employee_affiliation_evidence", "employee_affiliation_snippet", "employee_affiliation_source_url",
            "personal_email_affiliation_evidence", "personal_email_affiliation_source_url", "delivery_evidence",
            "bounced", "complained", "complaint", "unsubscribed", "do_not_contact", "suppressed",
            "project_title", "project_source_url", "project_url", "game_url", "steam_appid", "coming_soon", "team_size", "developer_team_size",
            "indie_status_verified", "independent_developer_verified", "solo_developer_verified", "small_team_verified",
            "project_announcement_date", "announcement_date", "project_campaign_date", "campaign_date",
            "project_expected_release_date", "expected_release_date", "project_actual_release_date", "actual_release_date",
            "project_latest_activity_date", "latest_activity_date", "project_marketing_milestones", "marketing_milestones",
            "creator_name", "developer_name", "developer_identity_status", "developer_attribution_source",
            "developer_identity_source_url", "developer_identity_evidence_ids", "developer_identity_verified_at", "developer_identity_verified_by",
            "developer_identity_verification_method", "kickstarter_creator_role", "kickstarter_creator_role_verified",
            "discovery_method", "source", "source_key", "source_url", "project_id",
            "admin_notes", "qualification_evidence_status", "permission_confirmed_by_admin",
            "permission_reference", "permission_recorded_at",
        ])
    verified = {k: prior_verified[k] for k in preserve_keys if k in prior_verified}
    verified.update({"signals": sorted(found), "language": language, "contact_role": role or "", "pages_read": len(pages), "ai_extraction": ai_extraction})
    if p["type"] == "indie_game_developer":
        activity_dates = [e["date"] for e in indie_events if e["fact_type"] == "development_update"]
        prior_activity_dates = [
            p.get("project_latest_activity_date"), verified.get("project_latest_activity_date"),
            verified.get("latest_activity_date"),
        ]
        parsed_activity = [d for d in (_iso_date(v) for v in [*prior_activity_dates, *activity_dates]) if d]
        if parsed_activity:
            verified["project_latest_activity_date"] = max(parsed_activity).isoformat()
        announcement_dates = [e["date"] for e in indie_events if e["fact_type"] == "project_announcement"]
        prior_announcement_dates = [p.get("project_announcement_date"), verified.get("project_announcement_date"), verified.get("announcement_date")]
        parsed_announcements = [d for d in (_iso_date(v) for v in [*prior_announcement_dates, *announcement_dates]) if d]
        if parsed_announcements:
            verified["project_announcement_date"] = min(parsed_announcements).isoformat()
        milestones = list(verified.get("project_marketing_milestones") or [])
        for event in indie_events:
            if event["fact_type"] == "marketing_opportunity":
                item = {"date": event["date"], "source_url": event["url"], "kind": "marketing_opportunity", "verified": True}
                if item not in milestones:
                    milestones.append(item)
        if milestones:
            verified["project_marketing_milestones"] = milestones[-30:]
        verified["visual_review_pending_count"] = _visual_review_pending(ctx.get("evidence") or [], indie_visual_candidates)
        verified["identity_evidence_candidate_count"] = len(indie_identity_mentions)
        # Discovery/research evidence does not silently verify Kickstarter creator attribution.
        if verified.get("source_key") == "kickstarter_manual":
            verified["developer_identity_status"] = verified.get("developer_identity_status") or "admin_attributed_unverified"
    if contact and contact.get("how") == "store" and p["type"] == "indie_game_developer":
        src = p.get("contact_source_url") or ""
        verified.update({"contact_verification": "store_listing", "contact_email": contact["email"], "contact_source_url": src})
    if manually_verified:
        verified.update({"contact_verification": "human_confirmed", "contact_email": existing})
    elif website_verified:
        verified.update({"contact_verification": "website_extracted", "contact_email": contact["email"], "contact_source_url": src})
    elif existing:
        verified.update({"contact_verification": "unknown_legacy", "contact_email": existing})
    elif run_id is not None:       # a reevaluation must not inherit an older run's "website_extracted": nothing was re-verified now
        verified.update({"contact_verification": "not_verified_this_run", "contact_email": ""})
    suppression_facts = {"suppressed": False, "bounced": False, "complained": False, "suppression_reason": ""}
    if p.get("type") == "indie_game_developer":
        # Repeat the worker preflight at the assessment boundary. This protects
        # direct callers and future job paths that do not use h_research().
        try:
            result = rpc("intel_agent_indie_suppression_facts", {
                "p_email": verified.get("contact_email") or existing,
                "p_domain": p.get("domain") or "",
            })
        except Exception as exc:
            raise TransientError("indie suppression lookup failed during research contact assessment") from exc
        if not isinstance(result, dict) or not all(k in result for k in ("suppressed", "bounced", "complained")):
            raise TransientError("indie suppression lookup returned an incomplete result during research contact assessment")
        truthy = lambda value: value is True or str(value).strip().casefold() in {"true", "1", "yes"}
        suppression_facts = {**result, **{
            "suppressed": truthy(result.get("suppressed")),
            "bounced": truthy(result.get("bounced")),
            "complained": truthy(result.get("complained")),
        }}
    local_unsubscribe = any(
        p.get("status") == "suppressed" or scoring._is_true(verified.get(k))
        for k in ("suppressed", "unsubscribed", "do_not_contact", "bounced", "complained", "complaint")
    )
    suppressed_for_assessment = bool(suppression_facts.get("suppressed") or local_unsubscribe)
    suppression_reason = str(suppression_facts.get("suppression_reason") or "")
    if local_unsubscribe and not suppression_reason:
        suppression_reason = "prospect is opted out, suppressed, bounced or complained"
    contact_assessment = contactability.assess(
        email=verified.get("contact_email") or existing,
        official_domain=p.get("domain") or "",
        source_url=verified.get("contact_source_url") or p.get("contact_source_url") or
            ((verified.get("personal_email_affiliation_source_url") or verified.get("employee_affiliation_source_url") or "") if p.get("type") == "indie_game_developer" else ""),
        verification=verified.get("contact_verification") or "",
        verified_email=verified.get("contact_email") or "",
        employee_affiliation=bool(verified.get("employee_affiliation_evidence") or
            (p.get("type") == "indie_game_developer" and verified.get("personal_email_affiliation_evidence"))),
        delivery_evidence=verified.get("delivery_evidence") or "",
        bounced=bool(verified.get("bounced") or suppression_facts.get("bounced")),
        complained=bool(verified.get("complained") or verified.get("complaint") or suppression_facts.get("complained")),
        suppressed=suppressed_for_assessment,
        suppression_reason=suppression_reason,
        affiliation_evidence=verified.get("personal_email_affiliation_evidence") or verified.get("employee_affiliation_snippet") or "",
        affiliation_source_url=verified.get("personal_email_affiliation_source_url") or verified.get("employee_affiliation_source_url") or "",
        contact_name=p.get("contact_name") or name or "",
        allow_personal_email=p.get("type") == "indie_game_developer",
        contact_form_only=not bool(verified.get("contact_email")) and any(
            bool(BeautifulSoup(h, "lxml").find("form")) and re.search(r"contact|inquiry|お問い合わせ", url, re.I)
            for url, h in pages),
    )
    verified["contactability"] = contact_assessment
    if run_id is not None:
        # By id, never through the canonical-key upsert: after a website recovery that upsert would derive a different key and create a duplicate prospect.
        rpc("intel_agent_reeval_record_research", {"p_run_id": run_id, "p_prospect_id": p["id"], "p_verified": verified, "p_contact_name": name or "",
                                                   "p_contact_email": contact["email"] if contact and not existing else "", "p_contact_source_url": (src if website_verified else "")})
        return {"signals": sum(map(len, found.values())), "contact": bool(contact), "contact_verified": website_verified or manually_verified, "contactability": contact_assessment, "pages": len(pages), "text_chars": len(text),
                "dated_events": len(indie_events), "visual_review_pending": len(indie_visual_candidates), "identity_evidence_candidates": len(indie_identity_mentions)}
    rpc("intel_agent_upsert_prospect", {"p_type": p["type"], "p_name": p["name"], "p_website": p.get("website") or "", "p_contact_name": name or "", "p_contact_email": contact["email"] if contact and not existing else "",
                                        "p_contact_source_url": (src if website_verified else ""), "p_country": "", "p_language": language, "p_verified": verified})
    return {"signals": sum(map(len, found.values())), "contact": bool(contact), "contact_verified": website_verified or manually_verified, "contactability": contact_assessment, "pages": len(pages), "text_chars": len(text),
            "dated_events": len(indie_events), "visual_review_pending": len(indie_visual_candidates), "identity_evidence_candidates": len(indie_identity_mentions)}


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


@dataclass(frozen=True)
class ReevalScope:
    """Passing this to qualify() is the ONLY way to request a deliberate studio-v2 rescore over an older score. It names the run, and the
    run's start time, so that only evidence collected in that run after it began can decide the new score."""
    run_id: str
    started_at: str


def _ts(value) -> datetime | None:
    try:
        t = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def fresh_evidence(rows: list[dict], run_id: str, started_at: str) -> list[dict]:
    """Verified evidence this run collected after it began. Fails closed: a row without a readable timestamp or run id is stale."""
    t0 = _ts(started_at)
    if t0 is None:
        return []
    out = []
    for e in rows or []:
        t = _ts(e.get("fetched_at"))
        if e.get("verified") and e.get("reeval_run") == run_id and t is not None and t >= t0:
            out.append(e)
    return out


def _qualify_studio(rpc, ctx: dict, criteria: dict, reeval: ReevalScope | None = None) -> scoring.Result:
    p = ctx["prospect"]
    evidence = ctx["evidence"]
    if reeval is not None:
        if p.get("type") != "animation_studio_support" or p.get("origin") != "discovered":
            raise PermanentError("a studio-v2 reevaluation rescore is only allowed for discovered animation_studio_support prospects")
        evidence = fresh_evidence(evidence, reeval.run_id, reeval.started_at)
    sigs: dict[str, list[str]] = {}
    for e in evidence:                                 # every verified sentence, not just the last one per signal
        if e["verified"] and e.get("snippet"):
            sigs.setdefault(e["fact_type"], []).append(e["snippet"])
    verified = (p.get("facts") or {}).get("verified", {})
    meta = {"language": verified.get("language") or "other"}
    prospect_email = (p.get("contact_email") or "").strip().lower()
    verified_email = (verified.get("contact_email") or "").strip().lower()
    current_run_ok = reeval is None or verified.get("reeval_run") == reeval.run_id
    suppression = {}
    try:
        suppression = rpc("intel_agent_contactability_facts", {"p_email": prospect_email, "p_domain": p.get("domain") or ""}) or {}
    except Exception:
        # Missing/unavailable suppression lookup must never turn an address into Pass.
        suppression = {"lookup_unavailable": True}
    assessment = contactability.assess(
        email=prospect_email, official_domain=p.get("domain") or "",
        source_url=verified.get("contact_source_url") or p.get("contact_source_url") or "",
        verification=verified.get("contact_verification") or "",
        verified_email=verified_email,
        employee_affiliation=bool(verified.get("employee_affiliation_evidence")),
        delivery_evidence=verified.get("delivery_evidence") or "",
        bounced=bool(verified.get("bounced") or suppression.get("bounced")),
        complained=bool(verified.get("complained") or suppression.get("complained")),
    ) if current_run_ok and not suppression.get("lookup_unavailable") else {"status": "needs_review", "reason": "suppression status could not be verified", "evidence": {}}
    res = scoring.score_studio(sigs, meta, None, qualify_min=int(criteria.get("qualify_min", 70)), review_min=int(criteria.get("review_min", 50)))
    res.contactability = assessment
    if reeval is not None:
        # Deliberate studio-v2 rescore over whatever score was there (legacy or not). Written through the run-scoped function, which re-checks
        # scope, run and "research recorded in this run" in the database. Ordinary qualification never reaches this branch.
        res.write = rpc("intel_agent_reeval_set_score", {"p_run_id": reeval.run_id, "p_prospect_id": p["id"], "p_score": res.score, "p_breakdown": res.breakdown, "p_decision": res.decision,
                                                         "p_reason": res.reason, "p_estimates": {"decision_basis": "deterministic rubric over verified evidence collected in this reevaluation run",
                                                                                                 "scoring_model": res.model, "evidence_rows_used": len(evidence), "contactability": assessment}}) or {}
        return res
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
                                  "p_estimates": {"decision_basis": "deterministic rubric over verified evidence", "scoring_model": res.model, "contactability": assessment}})
    return res


def qualify(rpc, ctx: dict, criteria: dict, *, reeval: ReevalScope | None = None) -> scoring.Result:
    p = ctx["prospect"]
    if p["type"] != "indie_game_developer":
        return _qualify_studio(rpc, ctx, criteria, reeval)
    if reeval is not None:
        raise PermanentError("a reevaluation never applies to indie_game_developer prospects")
    evidence = [e for e in ctx.get("evidence", []) if e.get("verified") and e.get("snippet")]
    sigs: dict[str, list[str]] = {}
    for e in evidence:  # retain every verified snippet; do not collapse repeated fact types
        sigs.setdefault(str(e.get("fact_type") or ""), []).append(str(e.get("snippet") or ""))
    verified = (p.get("facts") or {}).get("verified", {})
    meta = {
        **verified,
        "developer_name": p.get("name") or "",
        "prospect_name": p.get("name") or "",
        "developer_website": p.get("website") or "",
        "project_title": p.get("project_title") or verified.get("project_title") or verified.get("game") or "",
        "project_url": p.get("project_source_url") or verified.get("project_url") or verified.get("game_url") or "",
        "official_project_urls": [e.get("url") for e in evidence if e.get("url") and str(e.get("fact_type") or "").casefold() in {"game_store_page", "steam_project", "itch_project", "kickstarter_project"}], 
        "project_announcement_date": p.get("project_announcement_date") or verified.get("project_announcement_date") or verified.get("announcement_date"),
        "project_campaign_date": p.get("project_campaign_date") or verified.get("project_campaign_date") or verified.get("campaign_date"),
        "project_expected_release_date": p.get("project_expected_release_date") or verified.get("project_expected_release_date") or verified.get("expected_release_date"),
        "project_actual_release_date": p.get("project_actual_release_date") or verified.get("project_actual_release_date") or verified.get("actual_release_date"),
        "project_latest_activity_date": p.get("project_latest_activity_date") or verified.get("project_latest_activity_date") or verified.get("latest_activity_date"),
        "project_marketing_milestones": p.get("project_marketing_milestones") or verified.get("marketing_milestones") or [],
        "language": verified.get("language") or p.get("language"),
    }
    indie_email = (p.get("contact_email") or "").strip().lower()
    try:
        suppression = rpc("intel_agent_indie_suppression_facts", {"p_email": indie_email, "p_domain": p.get("domain") or ""})
        if not isinstance(suppression, dict) or not all(k in suppression for k in ("suppressed", "bounced", "complained")):
            raise RuntimeError("suppression lookup returned no complete structured result")
    except Exception:
        suppression = {"lookup_unavailable": True}
    if p.get("status") == "suppressed" or any(scoring._is_true(verified.get(k)) for k in ("suppressed", "unsubscribed", "do_not_contact", "bounced", "complained", "complaint")):
        known_reason = ("unsubscribe" if scoring._is_true(verified.get("unsubscribed")) else "do not contact" if scoring._is_true(verified.get("do_not_contact"))
                        else "bounce" if scoring._is_true(verified.get("bounced")) else "complaint" if scoring._is_true(verified.get("complained") or verified.get("complaint"))
                        else "prospect is already marked suppressed")
        suppression = {"suppressed": bool(p.get("status") == "suppressed" or any(scoring._is_true(verified.get(k)) for k in ("suppressed", "unsubscribed", "do_not_contact"))),
                       "bounced": scoring._is_true(verified.get("bounced")),
                       "complained": scoring._is_true(verified.get("complained") or verified.get("complaint")), "suppression_reason": known_reason}
    assessment = contactability.assess(
        email=indie_email, official_domain=p.get("domain") or "",
        source_url=verified.get("contact_source_url") or p.get("contact_source_url") or
            (verified.get("personal_email_affiliation_source_url") or verified.get("employee_affiliation_source_url") or ""),
        verification=verified.get("contact_verification") or "", verified_email=verified.get("contact_email") or "",
        employee_affiliation=bool(verified.get("employee_affiliation_evidence") or verified.get("personal_email_affiliation_evidence")),
        delivery_evidence=verified.get("delivery_evidence") or "",
        bounced=scoring._is_true(verified.get("bounced") or suppression.get("bounced")),
        complained=scoring._is_true(verified.get("complained") or verified.get("complaint") or suppression.get("complained")),
        suppressed=any(scoring._is_true(v) for v in (suppression.get("suppressed"), verified.get("unsubscribed"), verified.get("do_not_contact"), verified.get("suppressed"))),
        suppression_reason=suppression.get("suppression_reason") or ("unsubscribe" if scoring._is_true(verified.get("unsubscribed")) else "do not contact" if scoring._is_true(verified.get("do_not_contact")) else ""),
        affiliation_evidence=verified.get("personal_email_affiliation_evidence") or verified.get("employee_affiliation_snippet") or "",
        affiliation_source_url=verified.get("personal_email_affiliation_source_url") or verified.get("employee_affiliation_source_url") or "",
        contact_name=p.get("contact_name") or "",
        allow_personal_email=p.get("type") == "indie_game_developer",
    )
    if suppression.get("lookup_unavailable") and assessment.get("status") != "rejected":
        assessment = {"status": "needs_review", "reason": "suppression status could not be verified", "evidence": assessment.get("evidence", {})}
    elif suppression.get("suppressed"):
        assessment = {"status": "rejected", "reason": suppression.get("suppression_reason") or "email or domain is suppressed", "evidence": assessment.get("evidence", {})}
    res = scoring.score_indie(sigs, meta, {"email": indie_email} if indie_email else None,
                              evidence_rows=evidence, contactability_result=assessment,
                              suppression=suppression)
    res.contactability = assessment
    qualification = {
        "model": scoring.INDIE_MODEL,
        "score": res.score,
        "decision": res.decision,
        "thresholds": {"qualified": scoring.INDIE_QUALIFY_MIN, "review": scoring.INDIE_REVIEW_MIN},
        "mandatory_gates": res.mandatory_gates,
        "failed_gates": [k for k, v in res.mandatory_gates.items() if not v.get("passed")],
        "evidence_ids": [str(e.get("id")) for e in evidence if e.get("id")],
        "evidence_count": len(evidence),
        "contactability": assessment,
    }
    rpc("intel_agent_set_score", {"p_prospect_id": p["id"], "p_score": res.score, "p_breakdown": res.breakdown,
                                  "p_decision": res.decision, "p_reason": res.reason,
                                  "p_estimates": {"decision_basis": "deterministic project-first rubric over verified evidence",
                                                  "scoring_model": scoring.INDIE_MODEL, "qualification_v2": qualification,
                                                  "contactability": assessment, "suppression": suppression}})
    return res
