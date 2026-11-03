"""Deterministic signal detection. A signal is TRUE only when a sentence on the fetched page matches; that sentence
is stored as its evidence, so every signal is verifiable by construction. The model can add nothing here."""
from __future__ import annotations

import re

from .safety import sentence_around

I = re.I | re.U

INDIE = {
    "style_2d": r"\b2d\b|hand[- ]drawn|pixel ?art|sprite[- ]based|side[- ]scroll",
    "style_anime": r"\banime\b|\bmanga\b|visual novel|\bjrpg\b|anime[- ]inspired",
    "style_stylized": r"styli[sz]ed|cel[- ]?shad|painterly|hand[- ]painted|illustrated",
    "narrative": r"story[- ]rich|story[- ]driven|narrative|visual novel|branching story",
    "upcoming_release": r"coming soon|wishlist|release date|launch(ing)? (on|in|this|next)|early access|demo (is )?(available|out|now)|playable demo",
    "kickstarter": r"kickstarter",
    "publisher": r"published by|publisher|signed with",
    "seeking_animation": r"(looking for|seeking|hiring|need(ing)?|searching for) (an? )?(2d |freelance |anime )?animators?|animation (freelancer|support|partner|help)|animated (trailer|cutscene)s?",
    "trailer": r"\btrailer\b|cinematic|cutscene",
}
STUDIO = {
    "recruit_page": r"recruit|hiring|we are hiring|join (us|our team)|job openings?|careers?|求人|募集|採用",
    "outsourcing": r"outsourc|外注|partner studios?|freelanc(e|ers?)|協力会社|external (animators?|partners?)",
    "role_layout": r"\blayout\b|\bLO\b|レイアウト",
    "role_key": r"key animat\w*|genga|原画",
    "role_inbetween": r"in-?between\w*|douga|動画",
    "role_coloring": r"colou?ring|finishing|仕上げ|彩色",
    "production_active": r"in production|now airing|currently producing|upcoming (series|season|film)|season \d|制作中|放送中",
    "expansion": r"expand|expansion|new (studio|office|team)|scaling up|増員|拡大",
    "multiple_titles": r"our (works|productions|titles|projects)|filmography|works list|制作実績",
    "business_inquiry": r"business (inquir|enquir)|contact us|お問い合わせ|ご依頼|work with us",
}


def detect(text: str, table: dict[str, str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for name, pat in table.items():
        m = re.search(pat, text, I)
        if m:
            out[name] = sentence_around(text, m.start(), m.end())
    return out


def detect_indie(text: str) -> dict[str, str]:
    return detect(text, INDIE)


def detect_studio(text: str) -> dict[str, str]:
    return detect(text, STUDIO)
