"""Qualification arithmetic. Pure, deterministic, explainable: every point is tied to a signal with stored evidence.
The model never produces a score."""
from __future__ import annotations

import re
from datetime import date, datetime
from dataclasses import dataclass, field
from urllib.parse import urlparse

from .signals import RECRUIT_CONTEXT
from .protected_accounts import match_protected

INDIE_MODEL = "indie-project-v2"
INDIE_MAX = {"anime_visual_identity": 30, "active_development": 25, "release_marketing_timing": 25, "indie_partnership_opportunity": 10, "project_identity_confidence": 10}
INDIE_QUALIFY_MIN = 75
INDIE_REVIEW_MIN = 55
assert sum(INDIE_MAX.values()) == 100
STUDIO_V1_MAX = {"active_production": 20, "recruit_outsource": 25, "pipeline_fit": 15, "workload": 10, "recurring": 10, "contact": 15, "region": 5}

# --- studio-v2 (Phase 1). Suitability only; contactability is NOT scored (Phase 5 owns it). -------------------------------
STUDIO_MODEL = "studio-v2"
STUDIO_QUALIFY_MIN = 70
STUDIO_REVIEW_MIN = 50
STUDIO_LEGACY_MODEL = "studio-v1"            # what every studio score written before Phase 1 was produced with
# Pipeline fit (65) = seven items, each tied to one detectable signal on the studio's own pages.
PIPELINE_ITEMS = [  # (item, signal, max)
    ("layout", "role_layout", 10), ("key_animation", "role_key", 10), ("in_between_douga", "role_inbetween", 10),
    ("coloring_finishing", "role_coloring", 10), ("character_animation", "role_character", 10),
    ("production_active", "production_active", 8), ("published_work", "multiple_titles", 7)]
CAPABILITY_ITEMS = ("layout", "key_animation", "in_between_douga", "coloring_finishing", "character_animation")
TWO_D_ITEMS = [("style_2d", "style_2d", 8), ("style_2d_anime", "style_2d_anime", 7)]
COLLAB_ITEMS = [("external_work", "external_collab", 9), ("business_inquiry", "business_inquiry", 3), ("outsourcing_announcement", "outsourcing", 3)]
STUDIO_MAX = {"pipeline_fit": 65, "animation_2d": 15, "external_collaboration": 15, "language_preference": 5}
assert sum(STUDIO_MAX.values()) == 100
assert sum(m for _, _, m in PIPELINE_ITEMS) == STUDIO_MAX["pipeline_fit"]
assert sum(m for _, _, m in TWO_D_ITEMS) == STUDIO_MAX["animation_2d"]
assert sum(m for _, _, m in COLLAB_ITEMS) == STUDIO_MAX["external_collaboration"]
MIN_CAPABILITIES_FOR_CERTAIN_PIPELINE = 2     # distinct production capabilities evidenced OUTSIDE recruitment wording
GENUINE_INQUIRY = re.compile(r"business (inquir|enquir)|ご依頼|お仕事|work with us|commission|依頼", re.I | re.U)   # plain "contact us" is not collaboration evidence


@dataclass
class Result:
    score: int
    decision: str                      # qualified | needs_review | rejected
    reason: str
    breakdown: list[dict] = field(default_factory=list)
    model: str = ""                    # scoring-model version
    suitability: str = ""              # deterministic suitability decision before downstream CRM actions
    uncertain: list = field(default_factory=list)
    held: bool = False                 # set by research.qualify when a legacy score was deliberately not overwritten
    write: dict = field(default_factory=dict)      # what the database answered to a reevaluation rescore (empty for ordinary qualification)
    contactability: dict = field(default_factory=dict)
    mandatory_gates: dict = field(default_factory=dict)


def _row(name, pts, mx, why):
    return {"criterion": name, "points": pts, "max": mx, "why": why}


def _contact_kind(contact: dict | None) -> str:
    """none | form_only | generic_email | business_email — from the prospect's OWN pages only."""
    if not contact or not contact.get("email"):
        return "form_only" if contact and contact.get("form_url") else "none"
    local = contact["email"].split("@")[0]
    return "generic_email" if local in {"info", "contact", "hello", "support", "admin", "office", "mail", "press", "sales"} else "business_email"


def _as_date(value) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    raw = str(value or "").strip()
    if not raw:
        return None
    if re.fullmatch(r"\d{4}", raw):
        try:
            return date(int(raw), 7, 1)  # a year-only release estimate uses a neutral midpoint
        except ValueError:
            return None
    for fmt in ("%Y-%m-%d", "%Y-%m", "%Y/%m/%d", "%b %d, %Y", "%d %b, %Y", "%b %Y", "%B %Y"):
        try:
            return datetime.strptime(raw, fmt).date()
        except ValueError:
            pass
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).date()
    except ValueError:
        return None


def _is_true(value) -> bool:
    return value is True or str(value).strip().casefold() in {"true", "1", "yes"}


def _evidence_rows(signals: dict, rows: list[dict] | None) -> list[dict]:
    if rows is not None:
        return [r for r in rows if isinstance(r, dict) and _is_true(r.get("verified")) and str(r.get("snippet") or "").strip()]
    # Compatibility for direct scorer callers: signal snippets are not source-backed
    # enough to satisfy mandatory gates, but still support transparent category math.
    out = []
    for kind, value in (signals or {}).items():
        for snippet in (value if isinstance(value, (list, tuple)) else [value]):
            if snippet:
                out.append({"fact_type": kind, "snippet": str(snippet), "url": "", "verified": True})
    return out


ANIME_VISUAL_FACT_TYPES = frozenset({
    "anime_visual_evidence", "anime_visual_screenshot", "anime_visual_artwork",
    "anime_visual_trailer", "anime_character_art", "official_anime_visuals_verified",
})
ANIME_DESCRIPTION_FACT_TYPES = frozenset({"anime_style_description", "official_anime_style_description", "official_visual_style"})
ANIME_STYLE_DESCRIPTION_RE = re.compile(r"\b(anime|manga)\b.{0,60}\b(style|inspired|art|visuals?|aesthetics?|character design|illustration)\b|\b(style|art|visuals?|aesthetics?)\b.{0,60}\b(anime|manga)\b", re.I | re.S)
UPCOMING_MARKETING_RE = re.compile(r"\b(upcoming|coming soon|launch(?:es|ed)?|pre[- ]?orders?|wishlists?|demos?|early access|campaigns?|DLC|major updates?|console releases?|relaunch(?:es|ed)?|expansions?)\b", re.I)
ACTIVITY_FACT_TYPES = frozenset({
    "devlog", "development_log", "itch_devlog", "steam_devlog", "kickstarter_development_update",
    "developer_progress_update", "development_update", "project_update",
    "demo_update", "playtest_update", "build_update", "patch_update",
})


def _has_fact(rows: list[dict], allowed: set[str] | frozenset[str]) -> bool:
    return any(str(r.get("fact_type") or "").casefold() in allowed and _http_url_host(str(r.get("url") or ""))
               and bool(str(r.get("snippet") or "").strip()) for r in rows)


def _http_url_host(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    parsed = urlparse(raw if "://" in raw else "https://" + raw)
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        return ""
    host = parsed.hostname.lower().removeprefix("www.")
    if "." not in host:
        return ""
    return host


def _identifiable(value: str) -> bool:
    normalized = re.sub(r"[^a-z0-9]+", "", str(value or "").casefold())
    return bool(normalized and normalized not in {"unknown", "unknowndeveloper", "unknowngame", "tbd", "na", "notavailable", "unannounced", "anonymous"})


def _official_source_hosts(meta: dict) -> set[str]:
    official_urls = [meta.get("developer_website"), meta.get("project_url"), *(meta.get("official_project_urls") or [])]
    return {host for host in (_http_url_host(value) for value in official_urls) if host}


def _same_official_host(url: str, official_hosts: set[str]) -> bool:
    host = _http_url_host(url)
    return any(host == base or host.endswith("." + base) for base in official_hosts) if host else False


def _official_project_source_rows(meta: dict, rows: list[dict]) -> list[dict]:
    official_hosts = _official_source_hosts(meta)
    official_types = {"game_store_page", "steam_project", "itch_project", "kickstarter_project"}
    found = []
    for row in rows:
        kind, url = str(row.get("fact_type") or "").casefold(), str(row.get("url") or "")
        if _http_url_host(url) and (kind in official_types or (kind in {"project_identity", "project_description"} and _same_official_host(url, official_hosts))):
            found.append(row)
    return found


def _official_anime_description_rows(meta: dict, rows: list[dict]) -> list[dict]:
    official_hosts = _official_source_hosts(meta)
    found = []
    for row in rows:
        kind = str(row.get("fact_type") or "").casefold()
        url = str(row.get("url") or "")
        snippet = str(row.get("snippet") or "")
        official = _same_official_host(url, official_hosts)
        if kind in ANIME_DESCRIPTION_FACT_TYPES and _http_url_host(url) and official and ANIME_STYLE_DESCRIPTION_RE.search(snippet):
            found.append(row)
    return found


MARKETING_FACT_TYPES = frozenset({
    "dlc_announcement", "major_update_announcement", "relaunch_announcement",
    "console_release_announcement", "marketing_campaign", "marketing_opportunity",
})


def _has_marketing_milestone(meta: dict, evidence_rows: list[dict], today: date, *, require_date: bool = False) -> bool:
    source_backed = [r for r in evidence_rows
                     if str(r.get("fact_type") or "").casefold() in MARKETING_FACT_TYPES
                     and _http_url_host(str(r.get("url") or ""))
                     and str(r.get("snippet") or "").strip()]
    if not source_backed:
        return False
    milestones = meta.get("project_marketing_milestones") or meta.get("marketing_milestones") or []
    if not require_date and any(UPCOMING_MARKETING_RE.search(str(r.get("snippet") or "")) for r in source_backed):
        return True
    if not isinstance(milestones, list) or not milestones:
        return False
    for milestone in milestones:
        if not isinstance(milestone, dict) or not _is_true(milestone.get("verified")):
            continue
        source_url = str(milestone.get("source_url") or milestone.get("url") or "")
        when = _as_date(milestone.get("date") or milestone.get("start_date") or milestone.get("campaign_date"))
        source_match = any(str(r.get("url") or "").rstrip("/") == source_url.rstrip("/") for r in source_backed)
        if source_url and when and -30 <= (when - today).days <= 365 and source_match:
            return True
    return False


def indie_mandatory_gates(meta: dict, evidence_rows: list[dict], contactability_result: dict,
                          suppression: dict | None = None) -> dict:
    """Mandatory V2 qualification gates. Every pass must be supported by verified, source-backed facts."""
    suppression = suppression if isinstance(suppression, dict) else {}
    title = str(meta.get("project_title") or meta.get("game") or "").strip()
    developer_name = str(meta.get("developer_name") or meta.get("prospect_name") or "").strip()
    project_url = str(meta.get("project_url") or "").strip()
    has_project_source = bool(_http_url_host(project_url)) or bool(_official_project_source_rows(meta, evidence_rows))
    if not has_project_source and re.fullmatch(r"\d+", str(meta.get("steam_appid") or "")):
        has_project_source = True  # Steam app IDs are stable project identifiers; the DB sync derives the store URL.
    identity_source = str(meta.get("source_key") or meta.get("source") or "").casefold()
    identity_status = str(meta.get("developer_identity_status") or "").casefold()
    identity_unverified = (
        identity_source in {"kickstarter_manual", "itch"}
        and identity_status not in {"independently_verified", "human_confirmed", "verified"}
    )
    project_identity = _identifiable(title) and _identifiable(developer_name) and has_project_source and not identity_unverified

    today = date.today()
    latest = _as_date(meta.get("project_latest_activity_date") or meta.get("latest_activity_date"))
    expected = _as_date(meta.get("project_expected_release_date") or meta.get("expected_release_date"))
    actual = _as_date(meta.get("project_actual_release_date") or meta.get("actual_release_date"))
    announcement = _as_date(meta.get("project_announcement_date") or meta.get("announcement_date"))
    campaign = _as_date(meta.get("project_campaign_date") or meta.get("campaign_date"))
    activity_evidence = _has_fact(evidence_rows, ACTIVITY_FACT_TYPES)
    recent_activity = bool(activity_evidence and latest and 0 <= (today - latest).days <= 365)
    expected_window = bool(expected and 0 <= (expected - today).days <= 365)
    campaign_window = bool(campaign and -30 <= (campaign - today).days <= 365)
    announcement_window = bool(announcement and (expected is None or expected >= today)
                               and 120 <= (today - announcement).days <= 240)
    coming_soon_window = bool(_is_true(meta.get("coming_soon")) and (expected is None or expected_window))
    upcoming_marketing = bool(expected_window or campaign_window or announcement_window or coming_soon_window
                              or _has_marketing_milestone(meta, evidence_rows, today))
    released = bool(actual and actual <= today)
    meaningful_post_release_opportunity = bool(campaign_window or _has_marketing_milestone(meta, evidence_rows, today, require_date=True))
    activity_or_opportunity = meaningful_post_release_opportunity if released else (recent_activity or upcoming_marketing)

    visual_rows = [r for r in evidence_rows
                   if str(r.get("fact_type") or "").casefold() in ANIME_VISUAL_FACT_TYPES
                   and _http_url_host(str(r.get("url") or ""))]
    official_style_rows = _official_anime_description_rows(meta, evidence_rows)
    visual_verified = bool(visual_rows or official_style_rows)
    verified_rows = [r for r in evidence_rows if _http_url_host(str(r.get("url") or ""))]
    verified_types = {str(r.get("fact_type") or "").casefold() for r in verified_rows}
    source_urls = {str(r.get("url") or "").split("#", 1)[0].rstrip("/") for r in verified_rows}
    evidence_sufficient = len(verified_types) >= 2 and bool(source_urls)

    protected = match_protected(developer_name, title, meta.get("prospect_name", ""))
    suppression_conflict = any(_is_true(value) for value in (
        suppression.get("suppressed"), suppression.get("bounced"), suppression.get("complained"),
        suppression.get("unsubscribe"), suppression.get("complaint"), meta.get("suppressed"),
        meta.get("unsubscribed"), meta.get("do_not_contact"), meta.get("bounced"), meta.get("complained"), meta.get("complaint")
    ))
    suppression_verified = not bool(suppression.get("lookup_unavailable"))
    contact_result = contactability_result or {}
    contact_status = str(contact_result.get("status") or "needs_review")
    contact_verified_email = re.sub(r"\s+", "", str(contact_result.get("verified_email") or "")).casefold()
    prospect_email = re.sub(r"\s+", "", str(meta.get("contact_email") or meta.get("email") or "")).casefold()
    contact_source_url = str((contact_result.get("evidence") or {}).get("source_url") or "")
    contact_pass = bool(contact_status == "pass" and contact_verified_email and prospect_email
                        and contact_verified_email == prospect_email and _http_url_host(contact_source_url))
    return {
        "project_identity": {"passed": bool(project_identity), "reason": "identifiable game title and developer linked to a valid official project source" if project_identity else "Platform creator/developer attribution must be independently verified before project identity can pass" if identity_unverified else "an identifiable game title, developer, or valid official project source is missing"},
        "active_or_marketing_opportunity": {"passed": bool(activity_or_opportunity), "reason": "dated development activity or credible upcoming marketing opportunity found" if activity_or_opportunity else "no dated recent development activity or credible upcoming marketing opportunity"},
        "anime_visual_identity": {"passed": visual_verified, "reason": "verified anime-compatible visual asset" if visual_rows else "explicit anime visual-style description verified on the official developer/project page" if official_style_rows else "no verified anime-compatible visual or explicit official style evidence"},
        "verified_usable_email": {"passed": contact_pass, "reason": contact_result.get("reason", "contact verification unavailable") if contact_pass else "exact verified email and source URL must match the prospect contact address"},
        "suppression_clear": {"passed": not suppression_conflict and suppression_verified, "reason": "no email/domain suppression conflict found" if not suppression_conflict and suppression_verified else ("suppression status could not be verified" if not suppression_verified else str(suppression.get("suppression_reason") or "email or domain is suppressed"))},
        "protected_account_clear": {"passed": not bool(protected), "reason": "not a protected account" if not protected else f"protected account: {protected}"},
        "sufficient_evidence": {"passed": evidence_sufficient, "reason": f"{len(verified_types)} verified evidence types across {len(source_urls)} source URL(s)" if evidence_sufficient else "need at least two distinct verified evidence types with valid source URLs"},
    }


def _indie_timing_points(meta: dict, today: date, evidence_rows: list[dict] | None = None) -> tuple[int, str]:
    rows = evidence_rows or []
    announcement = _as_date(meta.get("project_announcement_date") or meta.get("announcement_date"))
    expected = _as_date(meta.get("project_expected_release_date") or meta.get("expected_release_date"))
    actual = _as_date(meta.get("project_actual_release_date") or meta.get("actual_release_date"))
    campaign = _as_date(meta.get("project_campaign_date") or meta.get("campaign_date"))
    latest = _as_date(meta.get("project_latest_activity_date") or meta.get("latest_activity_date"))
    if actual and actual <= today:
        meaningful = bool((campaign and -30 <= (campaign - today).days <= 365)
                          or _has_marketing_milestone(meta, rows, today, require_date=True))
        if not meaningful:
            return 0, "game is already released; no separate DLC, major update, relaunch, console or campaign opportunity verified"
        if campaign and -30 <= (campaign - today).days <= 365:
            return 18, "released project has a verified upcoming campaign or marketing milestone"
        return 15, "released project has a verified dated DLC, update, relaunch or console opportunity"
    if expected and (expected - today).days > 365:
        return 5, "expected release is more than twelve months away; deprioritized, not rejected"
    if announcement and (expected is None or expected >= today):
        age = (today - announcement).days
        if 120 <= age <= 240:
            return 25, "announcement is approximately six months old: timely promotional window"
    if expected:
        days = (expected - today).days
        if 0 <= days <= 183:
            return 25, "expected release within approximately six months"
        if 184 <= days <= 365:
            return 18, "expected release within approximately twelve months"
    if campaign and -30 <= (campaign - today).days <= 365:
        return 20, "verified upcoming marketing campaign date"
    activity_evidence = _has_fact(rows, ACTIVITY_FACT_TYPES)
    if latest and activity_evidence and 0 <= (today - latest).days <= 365:
        return 12, "release date unknown; recent dated development evidence supports review"
    if _has_marketing_milestone(meta, rows, today):
        return 12, "release date unknown; source-backed marketing opportunity supports review"
    return 0, "release timing and marketing milestone unknown"


def score_indie(signals: dict, meta: dict, contact: dict | None, *, evidence_rows: list[dict] | None = None,
                contactability_result: dict | None = None, suppression: dict | None = None,
                qualify_min: int = INDIE_QUALIFY_MIN, review_min: int = INDIE_REVIEW_MIN) -> Result:
    """Project-first indie-game V2 scoring. Thresholds are fixed at 75/55; mandatory gates always override the numeric score."""
    rows = _evidence_rows(signals, evidence_rows)
    today = date.today()
    visual = [r for r in rows if str(r.get("fact_type") or "").casefold() in ANIME_VISUAL_FACT_TYPES
              and _http_url_host(str(r.get("url") or ""))]
    official_style = _official_anime_description_rows(meta, rows)
    described = any(bool((signals or {}).get(k)) for k in ("anime_style_description", "style_anime"))
    anime_points = 30 if visual else 24 if official_style else 12 if described else 0
    anime_why = "verified anime-compatible visual asset" if visual else "explicit anime visual-style description on official project/developer page" if official_style else "anime-style wording only; official visual evidence remains unverified" if described else "no anime visual evidence"

    latest = _as_date(meta.get("project_latest_activity_date") or meta.get("latest_activity_date"))
    dated_activity = _has_fact(rows, ACTIVITY_FACT_TYPES)
    age = (today - latest).days if latest else None
    if dated_activity and age is not None and 0 <= age <= 180:
        active_points, active_why = 25, f"dated development evidence {age} days old"
    elif dated_activity and age is not None and 181 <= age <= 365:
        active_points, active_why = 18, f"dated development evidence {age} days old"
    else:
        active_points, active_why = 0, "no dated development-progress evidence; store/release metadata is not proof of active development"

    timing_points, timing_why = _indie_timing_points(meta, today, rows)
    team_value = meta.get("team_size") if meta.get("team_size") is not None else meta.get("developer_team_size")
    try:
        team_size = int(team_value) if team_value is not None else None
    except (TypeError, ValueError):
        team_size = None
    indie_verified = any(_is_true(meta.get(k)) for k in (
        "indie_status_verified", "independent_developer_verified", "solo_developer_verified", "small_team_verified"
    ))
    if indie_verified and team_size is not None and 0 < team_size <= 10:
        indie_points, indie_why = 10, f"verified small independent team ({team_size})"
    elif indie_verified and team_size is not None and 10 < team_size <= 25:
        indie_points, indie_why = 8, f"verified independent team ({team_size})"
    elif indie_verified and team_size is not None and team_size > 25:
        indie_points, indie_why = 4, "verified independent developer/team larger than the priority small-team range"
    elif indie_verified:
        indie_points, indie_why = 6, "independent developer verified; team size unknown"
    else:
        indie_points, indie_why = 0, "independent-team status not established; discovery source alone is not proof"

    verified_rows = [r for r in rows if _http_url_host(str(r.get("url") or ""))]
    verified_types = {str(r.get("fact_type") or "").casefold() for r in verified_rows}
    source_urls = {str(r.get("url") or "").split("#", 1)[0].rstrip("/") for r in verified_rows}
    project_title = str(meta.get("project_title") or meta.get("game") or "").strip()
    project_url = str(meta.get("project_url") or "").strip()
    has_source = bool(_http_url_host(project_url) or _official_project_source_rows(meta, rows)
                      or re.fullmatch(r"\d+", str(meta.get("steam_appid") or "")))
    if len(verified_types) >= 3 and len(source_urls) >= 2:
        confidence_points, confidence_why = 10, "three or more verified evidence types across multiple source URLs"
    elif len(verified_types) >= 2 and source_urls:
        confidence_points, confidence_why = 7, "multiple verified evidence types with source provenance"
    elif _identifiable(project_title) and has_source:
        confidence_points, confidence_why = 4, "identifiable project title and official project source/identifier are present"
    else:
        confidence_points, confidence_why = 0, "project identity and corroborating evidence are incomplete"

    gate_values = indie_mandatory_gates(meta, rows, contactability_result or {}, suppression)
    gates_pass = all(v.get("passed") is True for v in gate_values.values())
    protected_failed = not gate_values["protected_account_clear"]["passed"]
    suppression_failed = any(_is_true(value) for value in (
        (suppression or {}).get("suppressed"), (suppression or {}).get("bounced"),
        (suppression or {}).get("complained"), (suppression or {}).get("unsubscribe"),
        (suppression or {}).get("complaint"), meta.get("suppressed"), meta.get("unsubscribed"),
        meta.get("do_not_contact"), meta.get("bounced"), meta.get("complained"), meta.get("complaint")
    ))
    contact_rejected = str((contactability_result or {}).get("status")) == "rejected"
    suppression_unknown = _is_true((suppression or {}).get("lookup_unavailable"))

    breakdown = [
        _row("anime_visual_identity", anime_points, 30, anime_why),
        _row("active_development", active_points, 25, active_why),
        _row("release_marketing_timing", timing_points, 25, timing_why),
        _row("indie_partnership_opportunity", indie_points, 10, indie_why),
        _row("project_identity_confidence", confidence_points, 10, confidence_why),
    ]
    for row in breakdown:
        row["model"] = INDIE_MODEL
    total = sum(r["points"] for r in breakdown)
    if protected_failed or suppression_failed or contact_rejected:
        decision = "rejected"
        reason = "; ".join(g["reason"] for k, g in gate_values.items() if not g["passed"] and k in {"protected_account_clear", "suppression_clear", "verified_usable_email"})
    elif suppression_unknown:
        decision, reason = "needs_review", "suppression status could not be verified; qualification is blocked until the lookup succeeds"
    elif total >= INDIE_QUALIFY_MIN and gates_pass:
        decision, reason = "qualified", "score meets 75-point threshold and every mandatory qualification gate passes"
    elif total >= INDIE_REVIEW_MIN:
        decision = "needs_review"
        failed = [k for k, g in gate_values.items() if not g["passed"]]
        reason = f"score {total}; mandatory evidence needs review: {', '.join(failed)}" if failed else f"score {total} is in the 55–74 review band"
    else:
        decision, reason = "rejected", f"score {total} is below the 55-point review threshold"
    return Result(total, decision, reason, breakdown, model=INDIE_MODEL, suitability=decision,
                  mandatory_gates=gate_values)


def score_studio_v1(signals: dict, meta: dict, contact: dict | None, *, qualify_min: int = 70, review_min: int = 50) -> Result:
    """LEGACY studio-v1 model, kept verbatim so old scores stay reproducible. Not used for new scoring."""
    b = []
    b.append(_row("active_production", 20 if "production_active" in signals else 6 if "multiple_titles" in signals else 0, 20, "production language on page" if "production_active" in signals else "past work only" if "multiple_titles" in signals else "no production evidence"))
    roles = [k for k in ("role_layout", "role_key", "role_inbetween", "role_coloring") if k in signals]
    ro = (10 if "recruit_page" in signals else 0) + (5 if "outsourcing" in signals else 0) + (5 * len(roles) if "recruit_page" in signals else 0)
    b.append(_row("recruit_outsource", min(25, ro), 25, "recruitment/outsourcing evidence" if ro else "none seen"))
    b.append(_row("pipeline_fit", min(15, 5 * len(roles)), 15, ", ".join(roles) or "no matching roles"))
    b.append(_row("workload", 10 if "production_active" in signals and "expansion" in signals else 5 if "expansion" in signals or "production_active" in signals else 0, 10, "workload/expansion language" if ("expansion" in signals or "production_active" in signals) else "none seen"))
    b.append(_row("recurring", 10 if "multiple_titles" in signals else 0, 10, "multiple productions listed" if "multiple_titles" in signals else "unknown"))
    kind = _contact_kind(contact)
    named = 8 if contact and contact.get("name") and contact.get("role") else 0
    b.append(_row("contact", min(15, named + {"business_email": 7, "generic_email": 7}.get(kind, 0)), 15, f"{kind}{' + named person' if named else ''}"))
    b.append(_row("region", 5 if meta.get("language") in ("en", "ja") else 0, 5, f"language {meta.get('language') or 'unknown'}"))
    return _decide(b, kind, qualify_min, review_min)


def _decide(rows: list[dict], contact_kind: str, qualify_min: int, review_min: int) -> Result:
    total = sum(r["points"] for r in rows)
    if total >= qualify_min:
        return Result(total, "qualified", "meets suitability threshold", rows)
    if total >= review_min:
        return Result(total, "needs_review", "between review and qualify thresholds", rows)
    return Result(total, "rejected", "below review threshold", rows)


# ----------------------------------------------------------------------------------------------------------------------
def _snips(signals: dict, key: str) -> list[str]:
    v = signals.get(key)
    if not v:
        return []
    return [x for x in (v if isinstance(v, (list, tuple)) else [v]) if x]


def _credit(maxp: int, snippets: list[str]) -> tuple[int, str, str]:
    """Full points need a sentence that is not recruitment wording. Recruitment-only wording is supplementary: ~30% of the item."""
    good = [s for s in snippets if not RECRUIT_CONTEXT.search(s)]
    if good:
        return maxp, good[0], "capability"
    if snippets:
        return -(-maxp * 3 // 10), snippets[0], "recruitment_only"
    return 0, "", "none"


def _items(signals: dict, spec: list[tuple[str, str, int]], genuine_only: set[str] = frozenset()) -> list[dict]:
    out = []
    for item, sig, mx in spec:
        sn = _snips(signals, sig)
        if sig in genuine_only:
            sn = [s for s in sn if GENUINE_INQUIRY.search(s)]
        pts, ev, ctx = _credit(mx, sn)
        out.append({"item": item, "signal": sig, "points": pts, "max": mx, "evidence_context": ctx, "evidence": ev})
    return out


def _group(name: str, items: list[dict], status: str, why: str) -> dict:
    return {"criterion": name, "points": sum(i["points"] for i in items), "max": STUDIO_MAX[name], "why": why, "status": status, "model": STUDIO_MODEL, "items": items}


def score_studio(signals: dict, meta: dict, contact: dict | None, *, qualify_min: int = STUDIO_QUALIFY_MIN, review_min: int = STUDIO_REVIEW_MIN) -> Result:
    """studio-v2 with immutable Phase 1 decision bands (70 qualified, 50 review).

    The threshold keyword arguments remain accepted for compatibility with older callers,
    but are intentionally ignored: campaign criteria must not override studio-v2 policy.
    Hiring / outsourcing wording is supplementary and cannot qualify a studio; nothing
    requires the studio to be hiring. `signals` maps signal names to verified evidence.
    """
    qualify_min = STUDIO_QUALIFY_MIN
    review_min = STUDIO_REVIEW_MIN
    uncertain: list[str] = []

    pi = _items(signals, PIPELINE_ITEMS)
    caps = [i["item"] for i in pi if i["item"] in CAPABILITY_ITEMS and i["evidence_context"] == "capability"]
    p_ok = len(caps) >= MIN_CAPABILITIES_FOR_CERTAIN_PIPELINE
    if not p_ok:
        uncertain.append("pipeline_fit")
    pipe = _group("pipeline_fit", pi, "confirmed" if p_ok else "uncertain",
                  f"{len(caps)} production capabilities evidenced outside recruitment text ({', '.join(caps) or 'none'})" + ("" if p_ok else f"; need {MIN_CAPABILITIES_FOR_CERTAIN_PIPELINE}"))

    di = _items(signals, TWO_D_ITEMS)
    d_ok = any(
        i["evidence_context"] == "capability"
        for i in di
        if i["signal"] in {"style_2d", "style_2d_anime"}
    )
    if not d_ok:
        uncertain.append("animation_2d")
    why2d = "explicit 2D / hand-drawn or 2D anime production evidence" if d_ok else ("3D/CG wording only, no 2D evidence" if signals.get("style_3d") else "no explicit 2D evidence")
    d2 = _group("animation_2d", di, "confirmed" if d_ok else "uncertain", why2d)

    ci = _items(signals, COLLAB_ITEMS, genuine_only={"business_inquiry"})
    c_ok = any(i["evidence_context"] == "capability" and i["points"] > 0 for i in ci if i["signal"] == "external_collab" or (i["signal"] == "business_inquiry" and i["evidence"] and GENUINE_INQUIRY.search(i["evidence"])))
    if not c_ok:
        uncertain.append("external_collaboration")
    coll = _group("external_collaboration", ci, "confirmed" if c_ok else "uncertain",
                  "evidence the studio works with outside parties" if c_ok else "no evidence either way on working with outside parties")

    lang = meta.get("language") if meta.get("language") in ("en", "ja", "other") else "other"
    lp = 5 if lang in ("en", "ja") else 0
    lan = _group("language_preference", [{"item": "language", "signal": "language", "points": lp, "max": 5, "evidence_context": "capability" if lp else "none",
                                         "evidence": f"site language {lang}" if lp else ""}], "confirmed", f"site language {lang or 'unknown'} (a preference, never a requirement)")

    rows = [pipe, d2, coll, lan]
    total = sum(r["points"] for r in rows)
    kind = _contact_kind(contact)
    if total >= qualify_min and uncertain:
        suit, reason = "needs_review", f"score {total} but uncertain: {', '.join(uncertain)} — a person must confirm"
    elif total >= qualify_min:
        suit, reason = "qualified", f"score {total}, all three evidence criteria confirmed"
    elif total >= review_min:
        suit, reason = "needs_review", f"score {total} is in the review band"
    else:
        suit, reason = "rejected", f"score {total} is below the review threshold"
    # Suitability is deliberately independent of contactability. Phase 5 records
    # a separate contactability decision and the job handler gates progression.
    return Result(total, suit, reason, rows, model=STUDIO_MODEL, suitability=suit, uncertain=uncertain)
