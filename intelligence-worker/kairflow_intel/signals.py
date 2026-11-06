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
    # Phase 1 (studio-v2 scoring): evidence of what the studio actually produces and whether it works with outside parties.
    "role_character": r"character animation|characters? animators?|キャラクターアニメーション|作画",
    "style_2d": r"\b2d\b|hand[- ]drawn|traditional animation|cel animation|セルアニメ|手描き|2Dアニメ|二次元アニメーション",
    "style_2d_anime": r"2d.{0,24}anime|anime.{0,24}2d|2Dアニメ|手描き.{0,20}アニメ|セルアニメ",
    "style_3d": r"\b3d\b|3dcg|cg animation|cgアニメ",
    "anime_production": r"\banime (production|studio|series|film|episode|title)s?|anime[- ]style|テレビアニメ|TVアニメ|劇場アニメ|アニメ(の)?(制作|作品|スタジオ|シリーズ)|アニメーション制作|アニメ作品",
    "external_collab": r"commissioned (work|projects?)|client work|work(ed|ing)? (for|with) (other )?(studios|clients|companies)|service animation|contract animation|animation services?|production (support|assistance)|受託|制作協力|作画協力|グロス請け|元請|下請",
}

# A sentence like this describes a vacancy or call for people, not the studio's own capability. Used only for the studio table.
RECRUIT_CONTEXT = re.compile(r"recruit|hiring|we are hiring|join (us|our team)|job openings?|careers?|\bapply\b|wanted|looking for|求人|募集|採用|応募", I)


def _clip_ja(sentence: str, pat: str) -> str:
    """sentence_around only splits on Western punctuation; cut a Japanese run at 。 so one matched term cannot borrow another clause's words."""
    if "。" not in sentence:
        return sentence
    m = re.search(pat, sentence, I)
    if not m:
        return sentence
    a = sentence.rfind("。", 0, m.start()) + 1
    b = sentence.find("。", m.end())
    return sentence[a: (b + 1) if b != -1 else len(sentence)].strip() or sentence


def _studio_sentence(text: str, pat: str, scan: int = 25) -> str | None:
    """Best evidence sentence for a studio signal: the first one that is NOT recruitment wording (that is capability evidence);
    if every match is recruitment wording, the first match (the scorer treats it as supplementary)."""
    first = None
    for i, m in enumerate(re.finditer(pat, text, I)):
        if i >= scan:
            break
        sent = _clip_ja(sentence_around(text, m.start(), m.end()), pat)
        if first is None:
            first = sent
        if not RECRUIT_CONTEXT.search(sent):
            return sent
    return first


def detect(text: str, table: dict[str, str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for name, pat in table.items():
        if table is STUDIO:
            sent = _studio_sentence(text, pat)
            if sent:
                out[name] = sent
            continue
        m = re.search(pat, text, I)
        if m:
            out[name] = sentence_around(text, m.start(), m.end())
    return out


def detect_indie(text: str) -> dict[str, str]:
    return detect(text, INDIE)


def detect_studio(text: str) -> dict[str, str]:
    return detect(text, STUDIO)
