"""Studio vs individual. A freelancer advertising their own availability is NOT a studio looking for outside capacity.
Deterministic cues only; anything unclear goes to a person."""
from __future__ import annotations

import re

from . import entity

I = re.I | re.U
STUDIO_CUES = {
    "legal form": re.compile(r"株式会社|有限会社|合同会社|㈱|\bco\.?,?\s*ltd\b|\bltd\b|\bllc\b|\binc\b|\bgmbh\b", I),
    "we-form": re.compile(r"\b(we are (hiring|looking|recruiting)|our (team|studio|staff|productions?)|join (us|our team)|当社|弊社|私たちは|スタッフ募集|制作会社)", I),
    "production words": re.compile(r"\b(production|studio|animation (studio|company)|制作|スタジオ|プロダクション)\b|制作進行|制作会社", I),
    "recruit for roles": re.compile(r"(原画|動画|レイアウト|\bLO\b|仕上げ|彩色|key animator|in-?between|layout animator)\w*\s*(募集|求む|wanted|needed|hiring)|(募集|hiring|wanted|looking for)\W{0,12}(原画|動画|レイアウト|\bLO\b|key animators?|in-?betweens?)", I),
}
INDIVIDUAL_CUES = {
    "freelancer": re.compile(r"フリーランス|フリーのアニメーター|freelance(r)? (animator|artist)|個人(で|として|制作)", I),
    "own availability": re.compile(r"(commissions?|requests?|お仕事|依頼)\s*(are\s*)?(open|受付|募集中|お待ち)|available for (hire|work|commissions?)|お仕事(の)?(ご依頼|募集)|my (commissions?|portfolio)|依頼受付|skeb", I),
    "first person": re.compile(r"\b(i am|i'm|i can|my work)\b|私は|自分の|ポートフォリオ", I),
}


def classify(text: str, name: str = "", host: str = "") -> dict:
    t = text or ""
    s = [k for k, p in STUDIO_CUES.items() if p.search(t)]
    i = [k for k, p in INDIVIDUAL_CUES.items() if p.search(t)]
    if name and entity.looks_like_company(name) and "legal form" not in s:
        s.append("legal form")
    if host and entity.is_social_or_platform(host):
        i.append("personal platform")
    ws, wi = len(s) + (1 if "legal form" in s else 0), len(i) + (1 if "own availability" in i else 0)
    if "recruit for roles" in s and wi <= 1 and "own availability" not in i:
        return {"kind": "studio", "reasons": s}
    if ws >= 2 and wi == 0:
        return {"kind": "studio", "reasons": s}
    if wi >= 2 and ws <= 1:
        return {"kind": "individual", "reasons": i}
    if "own availability" in i and "recruit for roles" not in s:
        return {"kind": "individual", "reasons": i}
    return {"kind": "unclear", "reasons": s + ["vs"] + i}
