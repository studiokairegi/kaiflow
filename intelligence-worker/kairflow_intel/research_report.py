"""Phase 5: a concise, deterministic research report for one prospect.

The report is built ONLY from data the worker already holds: the prospect's stored facts and its evidence rows. No model is called and nothing is
guessed, so it cannot invent an email address, contact name, budget, production requirement or business relationship. Every statement is one of:

  confirmed   a verified evidence row (a sentence read from a fetched page, with its URL), or a store-listed / human-confirmed fact
  unverified  a candidate that still needs a human (for example a visual asset nobody has looked at)
  inference   a rule-based reading of confirmed facts. Always labelled, always lists the facts it rests on, and never used as a gate.
  gap         something the research looked for and did not find

Qualification and contactability stay in scoring.py / contactability.py. This report explains; it never decides.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timezone

from . import presskit, signals

REPORT_VERSION = 1
MAX_ITEMS_PER_SECTION = 8
MAX_SNIPPET = 240

# Evidence fact types that are plain page signals (signals.py) versus dated events and identity (indie_evidence.py).
EVENT_TYPES = {"development_update", "project_announcement", "marketing_opportunity"}
IDENTITY_TYPES = {"developer_identity", "project_identity"}
UNVERIFIED_TYPES = {"visual_asset_candidate"}
# Only these evidence types are reportable. Internal rows (rescore_candidate_*, website_recovery, ...) are bookkeeping, not facts about the prospect.
PRESSKIT_TYPES = set(presskit.FACT_TYPES.values())
REPORTABLE = EVENT_TYPES | IDENTITY_TYPES | UNVERIFIED_TYPES | PRESSKIT_TYPES | set(signals.INDIE) | set(signals.STUDIO) | {"contact_email", "manual_post"}
# contact_verification values that mean a person or a page really supplied the address. "unknown_legacy" and "not_verified_this_run" do not.
SOURCED_CONTACT = {"store_listing", "human_confirmed", "website_extracted"}
# Identity statuses that come from the source platform or a person, not from our own guess.
CONFIRMED_IDENTITY = {"store_listed_developer", "human_confirmed", "admin_verified", "official_site_verified"}
# What each animation-need inference may rest on (indie campaign). Names match signals.INDIE and indie_evidence event types.
NEED_STRONG = {"seeking_animation"}
NEED_SUPPORTING = {"trailer", "upcoming_release", "kickstarter", "marketing_opportunity", "project_announcement"}
STYLE_FIT = {"style_2d", "style_anime", "anime_style_description", "style_stylized"}
STUDIO_CAPACITY = {"outsourcing", "external_collab", "recruit_page", "expansion", "production_active"}
STUDIO_FIT = {"style_2d", "style_2d_anime", "anime_production", "role_key", "role_inbetween", "role_layout", "role_coloring", "role_character"}


def _clip(text, n=MAX_SNIPPET) -> str:
    t = re.sub(r"\s+", " ", str(text or "")).strip()
    return t if len(t) <= n else t[: n - 1].rstrip() + "…"


def _truthy(value) -> bool:
    """Strict: only a real true (or the strings true/1/yes/t) is verified. bool("false") would wrongly be True."""
    return value is True or str(value).strip().casefold() in {"true", "1", "yes", "t"}


def _today_utc() -> date:
    return datetime.now(timezone.utc).date()


def _dict(x) -> dict:
    return x if isinstance(x, dict) else {}


def _iso(value) -> str | None:
    try:
        raw = str(value or "").strip()
        return date.fromisoformat(raw[:10]).isoformat() if raw else None
    except (TypeError, ValueError):
        return None


def _rows(evidence) -> list[dict]:
    out, seen = [], set()
    for row in evidence or []:
        if not isinstance(row, dict):
            continue
        fact = str(row.get("fact_type") or "").strip()
        if fact not in REPORTABLE:
            continue
        key = (fact, str(row.get("url") or ""), re.sub(r"\s+", " ", str(row.get("snippet") or "")).strip().casefold()[:160])
        if key in seen:
            continue
        seen.add(key)
        out.append({"fact_type": fact, "url": str(row.get("url") or ""), "snippet": str(row.get("snippet") or ""),
                    "verified": _truthy(row.get("verified")), "source": str(row.get("source") or "")})
    return out


def _item(row: dict) -> dict:
    return {"type": row["fact_type"], "source_url": row["url"], "evidence": _clip(row["snippet"])}


def build(prospect: dict, verified: dict, evidence: list[dict] | None, *, contactability: dict | None = None,
          pages_read: int = 0, today: date | None = None) -> dict:
    """Return the report as a plain JSON-safe dict (stored under facts.verified.research_report)."""
    today = today or _today_utc()
    p, v = _dict(prospect), _dict(verified)
    ptype = p.get("type") or ""
    rows = _rows(evidence)
    ver = [r for r in rows if r["verified"] and r["fact_type"] not in UNVERIFIED_TYPES]
    unver = [r for r in rows if (not r["verified"]) or r["fact_type"] in UNVERIFIED_TYPES]
    fact_names = {r["fact_type"] for r in ver}

    # ---- identity ------------------------------------------------------------------------------------------------------------------
    prior = _dict(_dict(p.get("facts")).get("verified"))       # research rebuilds `verified` from a keep-list; discovery-time fields live only here
    status = str(v.get("developer_identity_status") or prior.get("developer_identity_status") or "").strip()
    identity_rows = [r for r in ver if r["fact_type"] in IDENTITY_TYPES]
    name = str(p.get("name") or v.get("developer_name") or "").strip()
    identity = {
        "name": name,
        "project_title": str(p.get("project_title") or v.get("project_title") or "") if ptype == "indie_game_developer" else "",
        "project_url": str(v.get("project_url") or v.get("project_source_url") or ""),
        "publisher": str(v.get("publisher_name") or prior.get("publisher_name") or ""),
        "discovered_via": str(v.get("source_key") or v.get("source") or v.get("discovered_via") or ""),
        "attribution_status": status or "unrecorded",
        # Confirmed only when the platform listed this developer, a person verified it, or the official site itself names both developer and project.
        "confirmed": bool(status in CONFIRMED_IDENTITY or
                          {"developer_identity", "project_identity"} <= {r["fact_type"] for r in identity_rows}),
    }

    # ---- website and contact -------------------------------------------------------------------------------------------------------
    website = str(p.get("website") or "").strip()
    ca = _dict(contactability) or _dict(v.get("contactability"))
    contact = {
        "official_website": website,
        "contact_email": str(v.get("contact_email") or "") if str(v.get("contact_verification") or "") in SOURCED_CONTACT else "",
        "contact_verification": str(v.get("contact_verification") or "none"),
        "contact_source_url": str(v.get("contact_source_url") or p.get("contact_source_url") or ""),
        # Only a contact already stored on the prospect (entered by a person or an earlier verified step). The model's extracted name and role are
        # deliberately NOT repeated here: the report must be identical whichever provider answered (see test_phase4_research_routing).
        "named_contact": str(p.get("contact_name") or ""),
        # A press / business address read from the game's own press kit. Labelled as a press contact; it is NOT a verified business contact.
        "press_contact_email": str(v.get("presskit_press_email") or prior.get("presskit_press_email") or ""),
        "press_contact_on_site_domain": bool(v.get("presskit_press_email_on_site_domain") if v.get("presskit_press_email") else prior.get("presskit_press_email_on_site_domain")),
        "contactability": str(ca.get("status") or "unknown"),
        "contactability_reason": _clip(ca.get("reason") or ca.get("message") or "", 200),
    }

    # ---- activity ------------------------------------------------------------------------------------------------------------------
    dated = []
    for r in (r for r in ver if r["fact_type"] in EVENT_TYPES):
        m = re.search(r"\[(?:explicit page date|structured datePublished):\s*(\d{4}-\d{2}-\d{2})\]", r["snippet"])
        dated.append({**_item(r), "date": m.group(1) if m else None})
    dated.sort(key=lambda e: e["date"] or "", reverse=True)          # newest first; undated last
    latest = _iso(v.get("project_latest_activity_date") or v.get("latest_activity_date"))
    future_latest = None
    if latest and date.fromisoformat(latest) > today:     # a page date after today is a parsing or typo problem, not recent activity
        future_latest, latest = latest, None
    activity = {
        "latest_development_update": latest,
        "days_since_latest_update": max(0, (today - date.fromisoformat(latest)).days) if latest else None,
        "announcement_date": _iso(v.get("project_announcement_date") or v.get("announcement_date")),
        "events": dated[:MAX_ITEMS_PER_SECTION],
    }

    # ---- confirmed facts (page signals with their sentence and URL) -----------------------------------------------------------------
    signal_rows = [r for r in ver if r["fact_type"] not in EVENT_TYPES | IDENTITY_TYPES | {"contact_email"}]
    confirmed = [_item(r) for r in signal_rows][: MAX_ITEMS_PER_SECTION * 2]

    # ---- press kit -----------------------------------------------------------------------------------------------------------------
    def _kit(key: str) -> str:
        return str(v.get(key) or prior.get(key) or "")
    kit_rows = [r for r in ver if r["fact_type"] in PRESSKIT_TYPES]
    kit_links = _dict(v.get("presskit_links")) or _dict(prior.get("presskit_links"))
    kit = {
        "found": bool(kit_rows or _kit("presskit_url")),
        "url": _kit("presskit_url"), "title": _kit("presskit_title"), "developer": _kit("presskit_developer"),
        "publisher": _kit("presskit_publisher"), "release_text": _kit("presskit_release_text"),
        "platforms": _kit("presskit_platforms"), "website": _kit("presskit_website"),
        "links": {str(k): str(u) for k, u in list(kit_links.items())[:12]},
    } if ptype == "indie_game_developer" else {"found": False}

    # ---- inferences (labelled; never a gate) ---------------------------------------------------------------------------------------
    inferences: list[dict] = []
    if ptype == "indie_game_developer":
        # seeking_animation is strong only when the sentence is an explicit, non-negated request; "animated trailer" alone is supporting.
        explicit = {r["fact_type"] for r in ver if r["fact_type"] in NEED_STRONG and signals.SEEKING_EXPLICIT.search(r["snippet"])
                    and not signals._NEGATION.search(r["snippet"][: signals.SEEKING_EXPLICIT.search(r["snippet"]).start()][-40:])}
        weak_seek = {"trailer"} if (fact_names & NEED_STRONG) and not explicit else set()
        strong, support, fit = explicit, (fact_names & NEED_SUPPORTING) | weak_seek, fact_names & STYLE_FIT
        if strong:
            level, why = "evidenced", sorted(strong)
        elif support and fit:
            level, why = "plausible", sorted(support | fit)
        elif support or fit:
            level, why = "possible", sorted(support | fit)
        else:
            level, why = "unknown", []
        inferences.append({"statement": "animation need", "level": level, "basis": why,
                           "note": ("The page says the team is looking for animation help." if level == "evidenced" else
                                    "Inferred from release or marketing activity plus a visual style that fits; the team has not said it needs animation."
                                    if level == "plausible" else
                                    "Only one weak signal; treat as a lead to check, not as a need." if level == "possible" else
                                    "No evidence either way.")})
        if v.get("team_size") or v.get("developer_team_size"):
            inferences.append({"statement": "team size", "level": "stated", "basis": ["team_size"],
                               "note": f"Recorded team size: {_clip(v.get('team_size') or v.get('developer_team_size'), 40)}."})
    else:
        cap, fit = fact_names & STUDIO_CAPACITY, fact_names & STUDIO_FIT
        # A sentence that is a vacancy or call for people is not capability evidence; the scorer treats it as supplementary, so the report does too.
        capability = {r["fact_type"] for r in ver if r["fact_type"] in {"outsourcing", "external_collab"} and not signals.RECRUIT_CONTEXT.search(r["snippet"])}
        if capability:
            level, why = "evidenced", sorted(capability)
        elif cap and fit:
            level, why = "plausible", sorted(cap | fit)
        elif cap or fit:
            level, why = "possible", sorted(cap | fit)
        else:
            level, why = "unknown", []
        inferences.append({"statement": "outsourcing capacity", "level": level, "basis": why,
                           "note": ("The studio's own pages mention outside collaborators or contract work." if level == "evidenced" else
                                    "Inferred from hiring or production signals plus relevant production roles." if level == "plausible" else
                                    "Weak signal only." if level == "possible" else "No evidence either way.")})

    # ---- gaps: what is missing, so nobody fills it with a guess --------------------------------------------------------------------
    gaps: list[str] = []
    if not website:
        gaps.append("no official website recorded" + (f" (the press kit lists {_clip(kit.get('website'), 80)}; not yet confirmed)" if kit.get("website") else ""))
    if not contact["contact_email"]:
        gaps.append("no verified contact email")
    if contact["press_contact_email"] and not contact["contact_email"]:
        gaps.append("only a press contact address from the press kit is on record, not a verified business contact")
    if not contact["named_contact"]:
        gaps.append("no named contact person on record")
    if not identity["confirmed"]:
        gaps.append("developer or studio identity is not confirmed beyond the discovery source")
    if ptype == "indie_game_developer":
        if future_latest:
            gaps.append(f"latest dated update ({future_latest}) is in the future and was ignored")
        elif latest is None:
            gaps.append("no explicit dated development update found")
        elif activity["days_since_latest_update"] is not None and activity["days_since_latest_update"] > 180:
            gaps.append(f"latest dated update is {activity['days_since_latest_update']} days old")
        if not kit["found"]:
            gaps.append("no press kit found")
        if not v.get("team_size") and not v.get("developer_team_size") and not v.get("indie_status_verified"):
            gaps.append("independent status and team size not verified")
    if not signal_rows and not dated:
        gaps.append("no relevant signals found on the pages read")
    if pages_read == 0:
        gaps.append("no pages were read")
    review = [_item(r) for r in unver][:MAX_ITEMS_PER_SECTION]

    sources = sorted({r["url"] for r in ver if r["url"]} | ({identity["project_url"]} if identity["project_url"] else set()))
    report = {
        "version": REPORT_VERSION,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "prospect_type": ptype,
        "identity": identity,
        "contact": contact,
        "activity": activity,
        "press_kit": kit,
        "confirmed_facts": confirmed,
        "inferences": inferences,
        "unverified_for_review": review,
        "gaps": gaps,
        "sources": sources[:30],
        "evidence_counts": {"confirmed": len(ver), "unverified": len(unver), "pages_read": int(pages_read or 0)},
    }
    report["summary"] = summarize(report)
    return report


def is_usable(report) -> bool:
    """False for the failure stub stored when build() raised, or for anything that is not a full report."""
    return isinstance(report, dict) and not report.get("error") and all(k in report for k in ("identity", "contact", "activity", "inferences", "gaps", "evidence_counts", "sources"))


def failure_stub(exc: BaseException) -> dict:
    """Stored in place of a report when build() fails. Safe for every consumer: it has a summary and gaps, and is_usable() is False."""
    return {"version": REPORT_VERSION, "error": type(exc).__name__, "summary": "Research report unavailable.",
            "gaps": ["research report could not be built"], "confirmed_facts": [], "inferences": [], "sources": []}


def summarize(r: dict) -> str:
    """A short plain-text rendering of the report, for the prospect panel and for the drafting step to read."""
    if not is_usable(r):
        return "Research report unavailable" + (f" ({r.get('error')})" if isinstance(r, dict) and r.get("error") else "") + "."
    idn, con, act = r["identity"], r["contact"], r["activity"]
    lines = []
    head = idn["name"] or "Unnamed prospect"
    if idn.get("project_title"):
        head += f" — {idn['project_title']}"
    lines.append(head + f" [{'identity confirmed' if idn['confirmed'] else 'identity NOT confirmed'}]")
    for inf in r["inferences"]:
        lines.append(f"{inf['statement'].capitalize()}: {inf['level']} (inference). {inf['note']}")
    if act["latest_development_update"]:
        lines.append(f"Latest dated development update: {act['latest_development_update']} ({act['days_since_latest_update']} days ago).")
    kit = r.get("press_kit") or {}
    if kit.get("found"):
        bits = [f"{label} {kit[k]}" for label, k in (("developer", "developer"), ("publisher", "publisher"), ("release", "release_text"), ("platforms", "platforms")) if kit.get(k)]
        press = con.get("press_contact_email")
        if press:
            bits.append(f"press contact {press} ({'own domain' if con.get('press_contact_on_site_domain') else 'other domain'})")
        lines.append("Press kit: " + ("; ".join(bits) if bits else "found, no labelled facts") + ".")
    lines.append(f"Contact: {'email sourced via ' + con['contact_verification'] if con['contact_email'] else 'no sourced email'}; contactability {con['contactability']}.")
    lines.append(f"Evidence: {r['evidence_counts']['confirmed']} confirmed, {r['evidence_counts']['unverified']} awaiting review, "
                 f"{len(r['sources'])} source URL(s).")
    if r["gaps"]:
        lines.append("Not found: " + "; ".join(r["gaps"][:6]) + ".")
    return "\n".join(lines)
