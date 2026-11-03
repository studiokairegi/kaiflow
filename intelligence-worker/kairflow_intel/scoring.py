"""Qualification arithmetic. Pure, deterministic, explainable: every point is tied to a signal with stored evidence.
The model never produces a score."""
from __future__ import annotations

from dataclasses import dataclass, field

INDIE_MAX = {"active_development": 20, "style_fit": 20, "release_promo": 20, "commercial": 15, "animation_need": 15, "contact": 10}
STUDIO_MAX = {"active_production": 20, "recruit_outsource": 25, "pipeline_fit": 15, "workload": 10, "recurring": 10, "contact": 15, "region": 5}


@dataclass
class Result:
    score: int
    decision: str                      # qualified | needs_review | rejected
    reason: str
    breakdown: list[dict] = field(default_factory=list)


def _row(name, pts, mx, why):
    return {"criterion": name, "points": pts, "max": mx, "why": why}


def _contact_kind(contact: dict | None) -> str:
    """none | form_only | generic_email | business_email — from the prospect's OWN pages only."""
    if not contact or not contact.get("email"):
        return "form_only" if contact and contact.get("form_url") else "none"
    local = contact["email"].split("@")[0]
    return "generic_email" if local in {"info", "contact", "hello", "support", "admin", "office", "mail", "press", "sales"} else "business_email"


def score_indie(signals: dict, meta: dict, contact: dict | None, *, qualify_min: int = 70, review_min: int = 50) -> Result:
    b = []
    recent = bool(meta.get("recent_activity"))
    b.append(_row("active_development", 20 if recent else 8 if signals.get("upcoming_release") else 0, 20,
                  "recent store/devlog activity" if recent else "release language on page" if signals.get("upcoming_release") else "no activity evidence"))
    styles = [k for k in ("style_2d", "style_anime", "style_stylized") if k in signals]
    b.append(_row("style_fit", min(20, 8 * len(styles) + (4 if "narrative" in signals else 0)), 20, ", ".join(styles + (["narrative"] if "narrative" in signals else [])) or "no matching style evidence"))
    promo = (12 if "upcoming_release" in signals or meta.get("coming_soon") else 0) + (8 if "kickstarter" in signals or "trailer" in signals else 0)
    b.append(_row("release_promo", min(20, promo), 20, "upcoming release / campaign / trailer evidence" if promo else "none seen"))
    comm = (8 if "kickstarter" in signals else 0) + (7 if "publisher" in signals else 0) + (7 if meta.get("price_present") else 0)
    b.append(_row("commercial", min(15, comm), 15, "commercial signals from page/store" if comm else "none seen (budget is NOT assumed)"))
    b.append(_row("animation_need", 15 if "seeking_animation" in signals else 5 if "trailer" in signals else 0, 15,
                  "page asks for animation help" if "seeking_animation" in signals else "has trailer/cutscene content" if "trailer" in signals else "no stated need"))
    kind = _contact_kind(contact)
    b.append(_row("contact", {"business_email": 10, "generic_email": 7}.get(kind, 0), 10, kind))
    return _decide(b, kind, qualify_min, review_min)


def score_studio(signals: dict, meta: dict, contact: dict | None, *, qualify_min: int = 70, review_min: int = 50) -> Result:
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
    if total >= qualify_min and contact_kind in ("business_email", "generic_email"):
        return Result(total, "qualified", "meets threshold with a verified business contact", rows)
    if total >= qualify_min:
        return Result(total, "needs_review", "meets threshold but no verified business email (contact form or none)", rows)
    if total >= review_min:
        return Result(total, "needs_review", "between review and qualify thresholds", rows)
    return Result(total, "rejected", "below review threshold", rows)
