"""GDELT DOC 2.0: news that mentions animation studios (production announcements, expansion). News metadata only; GDELT must be cited."""
from __future__ import annotations

import re

DOC = "https://api.gdeltproject.org/api/v2/doc/doc"
ATTRIBUTION = "Source: GDELT Project (gdeltproject.org)"


def _quote(term: str) -> str:
    t = re.sub(r'["()]', " ", term).strip()
    return f'"{t}"' if " " in t else t


def build_queries(terms_en: list[str], terms_ja: list[str]) -> list[tuple[str, str]]:
    """[(language, query)]. Only APPROVED profile terms are used. Short OR-lists keep queries within GDELT's limits."""
    out = []
    en = [_quote(t) for t in terms_en if t.strip()][:8]
    ja = [_quote(t) for t in terms_ja if t.strip()][:8]
    if en:
        out.append(("en", "(" + " OR ".join(en) + ") sourcelang:english"))
    if ja:
        out.append(("ja", "(" + " OR ".join(ja) + ") sourcelang:japanese"))
    return out


def fetch_articles(api, query: str, timespan: str = "7d", maxrecords: int = 40) -> list[dict]:
    res = api.get_json(DOC, {"query": query, "mode": "artlist", "format": "json", "maxrecords": maxrecords, "timespan": timespan, "sort": "datedesc"})
    if "_text" in res:
        return []
    return [{"url": a.get("url", ""), "title": (a.get("title") or "")[:300], "domain": a.get("domain", ""), "seen": a.get("seendate", ""), "language": a.get("language", "")}
            for a in res.get("articles", []) if a.get("url") and a.get("title")]
