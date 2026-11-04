"""Common Crawl CDX index: recruitment-style pages already archived on a KNOWN studio domain (monthly crawl, so weeks behind).
Finds pages to verify live; it never replaces the live check."""
from __future__ import annotations

import re

COLLINFO = "https://index.commoncrawl.org/collinfo.json"
RECRUIT_PATH = r".*(recruit|saiyo|saiyou|career|jobs?|freelanc|outsourc|staff|採用|求人|募集).*"


def latest_crawl(api) -> str | None:
    info = api.get_json(COLLINFO)
    return info[0].get("id") if isinstance(info, list) and info else None


def recruit_pages(api, crawl: str, domain: str, limit: int = 60) -> list[dict]:
    if not re.fullmatch(r"[a-z0-9.\-]{3,100}", domain or "") or not re.fullmatch(r"CC-MAIN-\d{4}-\d{2}", crawl or ""):
        return []
    rows = api.get_ndjson(f"https://index.commoncrawl.org/{crawl}-index", {"url": f"{domain}/*", "output": "json", "limit": limit, "filter": f"url:{RECRUIT_PATH}", "fl": "url,timestamp,status"})
    return [r for r in rows if str(r.get("url", "")).startswith(("http://", "https://")) and str(r.get("status", "200")) in ("200", "")]
