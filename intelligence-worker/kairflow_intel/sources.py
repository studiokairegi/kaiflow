"""Discovery adapters. Each yields candidate dicts {name, website, contact_email?, contact_source_url?, country?, meta{}}.
Only public pages and public store endpoints, fetched through the robots-respecting Fetcher. If a source disallows us or
changes shape, the adapter yields nothing: it never works around a block. Kickstarter and X are intentionally NOT
implemented (no free official API; terms not verified)."""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from urllib.parse import quote, urljoin, urlparse

from bs4 import BeautifulSoup

from .errors import PermanentError, TransientError

MAX_PER_RUN = 25


def _safe(fn, *a):
    try:
        return fn(*a)
    except PermanentError:
        return None


def steam(fetcher, keywords: list[str], limit: int = MAX_PER_RUN) -> list[dict]:
    """Steam storefront search + app details (public, unofficial JSON endpoints). Self-published, upcoming or recent 2D games."""
    seen, out = set(), []
    for kw in keywords[:8]:
        found = _safe(fetcher.fetch, f"https://store.steampowered.com/api/storesearch/?term={quote(kw)}&l=english&cc=us")
        if not found:
            continue
        try:
            items = json.loads(found[1]).get("items", [])
        except ValueError:
            continue
        for it in items[:12]:
            appid = str(it.get("id", ""))
            if not appid.isdigit() or appid in seen:
                continue
            seen.add(appid)
            got = _safe(fetcher.fetch, f"https://store.steampowered.com/api/appdetails?appids={appid}&l=english")
            if not got:
                continue
            try:
                d = (json.loads(got[1]).get(appid) or {}).get("data") or {}
            except ValueError:
                continue
            c = steam_candidate(d, appid)
            if c:
                out.append(c)
            if len(out) >= limit:
                return out
    return out


def steam_candidate(d: dict, appid: str, now: datetime | None = None) -> dict | None:
    if d.get("type") != "game" or not d.get("developers"):
        return None
    devs, pubs = d["developers"], d.get("publishers") or []
    if pubs and any(p.lower() not in {x.lower() for x in devs} for p in pubs) and len(pubs) > 0 and len(devs) == 0:
        return None
    rel = d.get("release_date") or {}
    now = now or datetime.now(timezone.utc)
    recent = False
    if rel.get("date"):
        for fmt in ("%b %d, %Y", "%d %b, %Y", "%b %Y", "%Y"):
            try:
                dt = datetime.strptime(rel["date"], fmt).replace(tzinfo=timezone.utc)
                recent = abs((now - dt).days) <= 365
                break
            except ValueError:
                continue
    if not (rel.get("coming_soon") or recent):
        return None
    sup = d.get("support_info") or {}
    site = (d.get("website") or sup.get("url") or "").strip()
    tags = [g.get("description", "") for g in (d.get("genres") or [])] + [c.get("description", "") for c in (d.get("categories") or [])]
    return {
        "name": devs[0], "website": site, "contact_email": (sup.get("email") or "").strip().lower(),
        "contact_source_url": f"https://store.steampowered.com/app/{appid}/" if sup.get("email") else "",
        "meta": {"game": d.get("name", ""), "steam_appid": appid, "coming_soon": bool(rel.get("coming_soon")), "recent_activity": True,
                 "release_date": rel.get("date", ""), "price_present": bool(d.get("price_overview")) or bool(d.get("is_free") is False),
                 "has_trailer": bool(d.get("movies")), "tags": tags[:12], "self_published": not pubs or {p.lower() for p in pubs} <= {x.lower() for x in devs},
                 "short": (d.get("short_description") or "")[:300], "source": "steam"},
    }


def itch(fetcher, keywords: list[str], limit: int = MAX_PER_RUN) -> list[dict]:
    """itch.io browse pages per tag. Yields the developer profile page; the research step finds their real site and contact."""
    out, seen = [], set()
    for kw in keywords[:6]:
        tag = re.sub(r"[^a-z0-9\-]+", "-", kw.lower()).strip("-")
        got = _safe(fetcher.fetch, f"https://itch.io/games/newest/tag-{tag}")
        if not got:
            continue
        soup = BeautifulSoup(got[1], "lxml")
        for cell in soup.select("div.game_cell")[:20]:
            a = cell.select_one(".game_author a[href]")
            t = cell.select_one(".game_title a, a.title")
            if not a or not t:
                continue
            prof = a["href"].split("?")[0].rstrip("/")
            host = urlparse(prof).hostname or ""
            if not host.endswith(".itch.io") or host in seen:
                continue
            seen.add(host)
            out.append({"name": a.get_text(strip=True) or host.split(".")[0], "website": prof, "contact_email": "", "contact_source_url": "",
                        "meta": {"game": t.get_text(strip=True), "recent_activity": True, "source": "itch"}})
            if len(out) >= limit:
                return out
    return out


def seeds(fetcher, urls: list[str], limit: int = MAX_PER_RUN) -> list[dict]:
    """Administrator-listed studio pages (recruitment / outsourcing / company pages)."""
    out, seen = [], set()
    for u in urls[:limit]:
        got = _safe(fetcher.fetch, u)
        if not got:
            continue
        final, html = got
        host = (urlparse(final).hostname or "").removeprefix("www.")
        if host in seen:
            continue
        seen.add(host)
        soup = BeautifulSoup(html, "lxml")
        og = soup.find("meta", property="og:site_name")
        name = (og["content"].strip() if og and og.get("content") else (soup.title.get_text(strip=True) if soup.title else host)).split("|")[0].split(" - ")[0].strip()[:120]
        lang = (soup.html.get("lang", "") if soup.html else "")[:2].lower()
        out.append({"name": name or host, "website": f"{urlparse(final).scheme}://{urlparse(final).netloc}", "contact_email": "", "contact_source_url": "",
                    "meta": {"language": lang if lang in ("en", "ja") else "other", "seed_url": final, "source": "seed"}})
    return out


def discover(fetcher, ptype: str, criteria: dict) -> list[dict]:
    kws = [k for k in criteria.get("keywords", []) if isinstance(k, str)]
    if ptype == "indie_game_developer":
        srcs = criteria.get("sources", ["steam", "itch"])
        out = []
        if "steam" in srcs:
            out += steam(fetcher, kws)
        if "itch" in srcs:
            out += itch(fetcher, kws)
        return out
    return seeds(fetcher, [u for u in criteria.get("seed_urls", []) if isinstance(u, str)])
