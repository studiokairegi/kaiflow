"""Qualification arithmetic. Pure, deterministic, explainable: every point is tied to a signal with stored evidence.
The model never produces a score."""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .signals import RECRUIT_CONTEXT

INDIE_MAX = {"active_development": 20, "style_fit": 20, "release_promo": 20, "commercial": 15, "animation_need": 15, "contact": 10}
STUDIO_V1_MAX = {"active_production": 20, "recruit_outsource": 25, "pipeline_fit": 15, "workload": 10, "recurring": 10, "contact": 15, "region": 5}

# --- studio-v2 (Phase 1). Suitability only; contactability is NOT scored (Phase 5 owns it). -------------------------------
STUDIO_MODEL = "studio-v2"
STUDIO_LEGACY_MODEL = "studio-v1"            # what every studio score written before Phase 1 was produced with
# Pipeline fit (65) = seven items, each tied to one detectable signal on the studio's own pages.
PIPELINE_ITEMS = [  # (item, signal, max)
    ("layout", "role_layout", 10), ("key_animation", "role_key", 10), ("in_between_douga", "role_inbetween", 10),
    ("coloring_finishing", "role_coloring", 10), ("character_animation", "role_character", 10),
    ("production_active", "production_active", 8), ("published_work", "multiple_titles", 7)]
CAPABILITY_ITEMS = ("layout", "key_animation", "in_between_douga", "coloring_finishing", "character_animation")
TWO_D_ITEMS = [("style_2d", "style_2d", 8), ("anime_production", "anime_production", 7)]
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
    model: str = ""                    # scoring-model version (studio only)
    suitability: str = ""              # decision on score + uncertainty alone, before the contact gate (studio only)
    uncertain: list = field(default_factory=list)
    held: bool = False                 # set by research.qualify when a legacy score was deliberately not overwritten


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
    if total >= qualify_min and contact_kind in ("business_email", "generic_email"):
        return Result(total, "qualified", "meets threshold with a verified business contact", rows)
    if total >= qualify_min:
        return Result(total, "needs_review", "meets threshold but no verified business email (contact form or none)", rows)
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


def score_studio(signals: dict, meta: dict, contact: dict | None, *, qualify_min: int = 70, review_min: int = 50) -> Result:
    """studio-v2. 100 = pipeline fit 65 + 2D relevance 15 + external-collaboration suitability 15 + English/Japanese preference 5.
    Hiring / outsourcing wording is supplementary and cannot qualify a studio; nothing requires the studio to be hiring.
    `signals` maps signal name -> evidence sentence, or -> list of sentences (every verified sentence should be passed)."""
    uncertain: list[str] = []

    pi = _items(signals, PIPELINE_ITEMS)
    caps = [i["item"] for i in pi if i["item"] in CAPABILITY_ITEMS and i["evidence_context"] == "capability"]
    p_ok = len(caps) >= MIN_CAPABILITIES_FOR_CERTAIN_PIPELINE
    if not p_ok:
        uncertain.append("pipeline_fit")
    pipe = _group("pipeline_fit", pi, "confirmed" if p_ok else "uncertain",
                  f"{len(caps)} production capabilities evidenced outside recruitment text ({', '.join(caps) or 'none'})" + ("" if p_ok else f"; need {MIN_CAPABILITIES_FOR_CERTAIN_PIPELINE}"))

    di = _items(signals, TWO_D_ITEMS)
    d_ok = any(i["evidence_context"] == "capability" for i in di if i["signal"] == "style_2d") or any(not RECRUIT_CONTEXT.search(x) for x in _snips(signals, "style_2d_anime"))
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
    decision = suit
    if suit == "qualified" and kind not in ("business_email", "generic_email"):    # existing contact gate, unchanged until Phase 5 separates contactability
        decision, reason = "needs_review", f"suitable (score {total}) but no business email on the studio's own pages (contact form or none)"
    return Result(total, decision, reason, rows, model=STUDIO_MODEL, suitability=suit, uncertain=uncertain)
