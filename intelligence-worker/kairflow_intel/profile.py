"""The administrator's customer profile -> bilingual search terms. The model proposes, the administrator approves, only approved terms are used."""
from __future__ import annotations

DEFAULT_TERMS = {
    "animation_studio_support": {
        "terms_en": ["animation studio", "anime studio", "animation production company", "animation studio portfolio", "animation production credits", "key animation", "layout animation", "in-between animation", "animation outsourcing", "animation production support"],
        "terms_ja": ["アニメーション制作会社", "アニメ制作会社", "作画スタジオ", "制作実績", "参加作品", "アニメーター募集", "原画募集", "第二原画募集", "作画協力", "アニメ制作会社 外注"],
        "exclude": ["school", "course", "tutorial", "スクール", "専門学校", "講座"],
    },
    "indie_game_developer": {
        "terms_en": ["2d indie game", "anime style game", "hand-drawn game", "visual novel", "game trailer animation"],
        "terms_ja": ["同人ゲーム", "インディーゲーム 2D", "ビジュアルノベル"],
        "exclude": ["asset pack", "tutorial"],
    },
}
SCHEMA = {"type": "object", "required": ["terms_en", "terms_ja", "exclude"], "properties": {
    "terms_en": {"type": "array", "items": {"type": "string", "maxLength": 60}},
    "terms_ja": {"type": "array", "items": {"type": "string", "maxLength": 40}},
    "exclude": {"type": "array", "items": {"type": "string", "maxLength": 40}}}}
INSTRUCTION = ("The studio owner describes the kind of client they want. Propose short search phrases (2 to 4 words each, at most 10 per list) in English and Japanese "
               "that such a client would publish (recruitment, outsourcing, production news), and phrases that indicate NOT a client (schools, tutorials, individuals). Do not invent company names.")


def approved_terms(criteria: dict) -> dict | None:
    prof = (criteria or {}).get("profile") or {}
    if not prof.get("approved"):
        return None
    return {"terms_en": [t for t in prof.get("terms_en", []) if isinstance(t, str)], "terms_ja": [t for t in prof.get("terms_ja", []) if isinstance(t, str)],
            "exclude": [t for t in prof.get("exclude", []) if isinstance(t, str)]}


def clean(lst, n=10):
    out = []
    for t in lst or []:
        t = " ".join(str(t).split())[:60]
        if len(t) >= 2 and t.lower() not in {x.lower() for x in out}:
            out.append(t)
    return out[:n]
