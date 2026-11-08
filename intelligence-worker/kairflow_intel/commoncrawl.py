"""Common Crawl CDX index: public portfolio, production-credit and recruitment pages on KNOWN domains.
Finds pages to verify live; it never replaces the live check."""
from __future__ import annotations

import re
from urllib.parse import urlsplit

COLLINFO = "https://index.commoncrawl.org/collinfo.json"
PUBLIC_EVIDENCE_PATH = r".*(recruit|saiyo|saiyou|career|jobs?|freelanc|outsourc|staff|portfolio|works?|credits?|filmography|productions?|projects?|採用|求人|募集|制作実績|参加作品|作品|クレジット).*"
RECRUIT_PATH = PUBLIC_EVIDENCE_PATH


def latest_crawl(api) -> str | None:
    info = api.get_json(COLLINFO)
    return info[0].get("id") if isinstance(info, list) and info else None


def evidence_pages(api, crawl: str, domain: str, limit: int = 60) -> list[dict]:
    if not re.fullmatch(r"[a-z0-9.-]{3,100}", domain or "") or not re.fullmatch(r"CC-MAIN-\d{4}-\d{2}", crawl or ""):
        return []
    rows = api.get_ndjson(
        f"https://index.commoncrawl.org/{crawl}-index",
        {"url": f"{domain}/*", "output": "json", "limit": limit, "filter": f"url:{PUBLIC_EVIDENCE_PATH}", "fl": "url,timestamp,status"},
    )
    expected = domain.lower().removeprefix("www.").rstrip(".")
    accepted = []
    for row in rows:
        raw_url = str(row.get("url", ""))
        try:
            parsed = urlsplit(raw_url)
            host = (parsed.hostname or "").lower().rstrip(".")
        except ValueError:
            continue
        # CDX filters are not an authorization boundary: enforce the requested
        # host boundary locally so unrelated domains cannot be attributed to a prospect.
        if (parsed.scheme not in ("http", "https") or not host
                or not (host == expected or host.endswith("." + expected))
                or str(row.get("status", "200")) not in ("200", "")):
            continue
        accepted.append(row)
    return accepted


def recruit_pages(api, crawl: str, domain: str, limit: int = 60) -> list[dict]:
    """Backward-compatible name for callers/tests from the recruitment-only implementation."""
    return evidence_pages(api, crawl, domain, limit)
