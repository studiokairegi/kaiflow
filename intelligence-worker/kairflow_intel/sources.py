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
    """Do not hide registry/budget failures; the caller must report them."""
    return fn(*a)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _safe_project_url(value: str, allowed_host_suffixes: tuple[str, ...]) -> str:
    value = (value or "").strip()
    p = urlparse(value)
    host = (p.hostname or "").lower()
    if p.scheme not in ("http", "https") or not host or not any(host == suffix or host.endswith("." + suffix) for suffix in allowed_host_suffixes):
        return ""
    return value.split("#", 1)[0]


def _steam_search_page(fetcher, keyword: str, start: int, count: int) -> tuple[list[str], int | None, str]:
    """Read one public Steam Store search results page. No login, private API, or access-control bypass."""
    from urllib.parse import urlencode
    params = urlencode({"term": keyword, "category1": "998", "supportedlang": "english", "ndl": "1", "start": start, "count": count})
    got = _safe(fetcher.fetch, f"https://store.steampowered.com/search/?{params}")
    if not got:
        return [], None, ""
    final, html = got
    if (urlparse(final).hostname or "").lower() != "store.steampowered.com":
        return [], None, ""
    soup = BeautifulSoup(html, "lxml")
    appids, seen = [], set()
    for row in soup.select("a.search_result_row[data-ds-appid], a.search_result_row[href]"):
        raw = row.get("data-ds-appid", "")
        if not raw:
            m = re.search(r"/app/(\d+)", row.get("href", ""))
            raw = m.group(1) if m else ""
        for appid in re.findall(r"\d+", str(raw)):
            if appid not in seen:
                seen.add(appid); appids.append(appid)
    total = None
    count_node = soup.select_one("#search_results_count")
    if count_node:
        digits = re.sub(r"[^0-9]", "", count_node.get_text(" ", strip=True))
        if digits:
            try: total = int(digits)
            except ValueError: pass
    return appids, total, final


def steam_candidate_from_html(html: str, appid: str, now: datetime | None = None) -> dict | None:
    """Extract facts from the public Steam app page; publisher and developer are distinct facts."""
    soup = BeautifulSoup(html or "", "lxml")
    title_node = soup.select_one(".apphub_AppName") or soup.select_one('meta[property="og:title"]')
    title = (title_node.get("content", "") if title_node and title_node.name == "meta" else title_node.get_text(" ", strip=True) if title_node else "").strip()
    if not title:
        return None
    def names(selector):
        out = []
        for node in soup.select(selector):
            value = node.get_text(" ", strip=True)
            if value and value not in out: out.append(value)
        return out
    developers = names("#developers_list a")
    publishers = names("#publishers_list a")
    if not developers:
        # JSON-LD is a public page representation and is used only when its author is explicit.
        for node in soup.select('script[type="application/ld+json"]'):
            try:
                data = json.loads(node.string or node.get_text())
            except (ValueError, TypeError):
                continue
            records = data if isinstance(data, list) else [data]
            for record in records:
                author = record.get("author") if isinstance(record, dict) else None
                author = author if isinstance(author, list) else [author]
                for item in author:
                    if isinstance(item, dict) and isinstance(item.get("name"), str) and item["name"].strip():
                        developers.append(item["name"].strip())
    developers = list(dict.fromkeys(developers))
    if not developers:
        return None
    release_node = soup.select_one(".release_date .date") or soup.select_one(".release_date")
    release_date = release_node.get_text(" ", strip=True) if release_node else ""
    coming_soon = bool(soup.select_one(".game_area_comingsoon, .coming_soon_title")) or bool(re.search(r"coming soon|to be announced", release_date, re.I))
    desc_node = soup.select_one(".game_description_snippet") or soup.select_one('meta[property="og:description"]')
    description = (desc_node.get("content", "") if desc_node and desc_node.name == "meta" else desc_node.get_text(" ", strip=True) if desc_node else "")[:1000]
    genres = list(dict.fromkeys(a.get_text(" ", strip=True) for a in soup.select('a[href*="/genre/"]') if a.get_text(" ", strip=True)))
    tags = list(dict.fromkeys(a.get_text(" ", strip=True) for a in soup.select(".app_tag") if a.get_text(" ", strip=True)))
    external_website = ""
    for a in soup.select("a[href]"):
        label = a.get_text(" ", strip=True)
        href = a.get("href", "")
        if re.search(r"official website|visit the website|website|ホームページ|公式サイト", label, re.I):
            candidate = urlparse(href)
            if candidate.scheme in ("http", "https") and candidate.hostname and not candidate.hostname.endswith("steampowered.com"):
                external_website = href; break
    now = now or datetime.now(timezone.utc)
    project_url = f"https://store.steampowered.com/app/{appid}/"
    return {
        "name": developers[0], "website": external_website, "contact_email": "", "contact_source_url": "",
        "meta": {
            "source": "steam", "source_key": "steam", "source_url": project_url,
            "project_url": project_url, "project_source_url": project_url,
            "project_id": f"steam:{appid}", "steam_appid": str(appid),
            "project_title": title, "game": title, "developer_name": developers[0],
            "developer_names": developers, "publisher_name": publishers[0] if publishers else "",
            "publisher_names": publishers, "developer_website": external_website,
            "developer_identity_status": "store_listed_developer",
            "release_date": release_date, "coming_soon": coming_soon,
            "short": description, "genres": genres[:20], "tags": tags[:30],
            "has_trailer": bool(soup.select(".highlight_movie, video")),
            "artwork_url": (soup.select_one('meta[property="og:image"]') or {}).get("content", ""),
            "discovered_at": _utc_now(),
            # Deliberately no recent_activity/latest_activity_date: discovery is not development evidence.
        },
    }


def steam_page(fetcher, keywords: list[str], cursor: dict | None = None, limit: int = 12) -> tuple[list[dict], dict | None]:
    """Discover one bounded page from the public Steam Store search UI, with resumable keyword/offset cursor."""
    if not keywords:
        return [], None
    cursor = cursor if isinstance(cursor, dict) else {}
    index = max(0, int(cursor.get("keyword_index", 0) or 0))
    start = max(0, int(cursor.get("start", 0) or 0))
    while index < len(keywords):
        keyword = str(keywords[index]).strip()
        if not keyword:
            index += 1; start = 0; continue
        appids, total, _ = _steam_search_page(fetcher, keyword, start, max(1, min(int(limit), 25)))
        out = []
        for appid in appids:
            got = _safe(fetcher.fetch, f"https://store.steampowered.com/app/{appid}/")
            if not got or (urlparse(got[0]).hostname or "").lower() != "store.steampowered.com":
                continue
            candidate = steam_candidate_from_html(got[1], appid)
            if candidate:
                out.append(candidate)
        has_more = (total is not None and start + len(appids) < total) or (total is None and len(appids) >= max(1, min(int(limit), 25)))
        if has_more:
            return out, {"keyword_index": index, "start": start + max(1, min(int(limit), 25))}
        index += 1; start = 0
        if out:
            return out, ({"keyword_index": index, "start": 0} if index < len(keywords) else None)
    return [], None


def steam_candidate(d: dict, appid: str, now: datetime | None = None) -> dict | None:
    """Normalize public app-details data when a compatible cached/fixture payload is available.

    Deliberately does not filter by publisher, release date, wishlist, or apparent activity.
    """
    if d.get("type") != "game" or not d.get("developers"):
        return None
    developers = [str(x).strip() for x in d.get("developers", []) if str(x).strip()]
    if not developers:
        return None
    publishers = [str(x).strip() for x in (d.get("publishers") or []) if str(x).strip()]
    release = d.get("release_date") or {}
    project_url = f"https://store.steampowered.com/app/{appid}/"
    support = d.get("support_info") or {}
    website = (d.get("website") or "").strip()
    email = (support.get("email") or "").strip().lower()
    return {"name": developers[0], "website": website, "contact_email": email,
        "contact_source_url": project_url if email else "", "meta": {
            "source": "steam", "source_key": "steam", "source_url": project_url,
            "project_url": project_url, "project_source_url": project_url,
            "project_id": f"steam:{appid}", "steam_appid": str(appid),
            "project_title": d.get("name", ""), "game": d.get("name", ""),
            "developer_name": developers[0], "developer_names": developers,
            "publisher_name": publishers[0] if publishers else "", "publisher_names": publishers,
            "developer_website": website, "developer_identity_status": "store_listed_developer",
            "coming_soon": bool(release.get("coming_soon")), "release_date": release.get("date", ""),
            "price_present": bool(d.get("price_overview")) or bool(d.get("is_free") is False),
            "has_trailer": bool(d.get("movies")),
            "genres": [g.get("description", "") for g in d.get("genres", []) if isinstance(g, dict)][:20],
            "tags": [c.get("description", "") for c in d.get("categories", []) if isinstance(c, dict)][:20],
            "short": (d.get("short_description") or "")[:1000], "discovered_at": _utc_now(),
        }}

def steam(fetcher, keywords: list[str], limit: int = MAX_PER_RUN) -> list[dict]:
    return steam_page(fetcher, keywords, None, limit)[0]


def _itch_page(fetcher, keyword: str, page: int) -> tuple[list[dict], bool]:
    tag = re.sub(r"[^a-z0-9\-]+", "-", keyword.lower()).strip("-")
    if not tag:
        return [], False
    url = f"https://itch.io/games/newest/tag-{tag}?page={max(1, page)}"
    got = _safe(fetcher.fetch, url)
    if not got:
        return [], False
    final, html = got
    soup = BeautifulSoup(html, "lxml")
    rows, seen = [], set()
    for cell in soup.select("div.game_cell"):
        author = cell.select_one(".game_author a[href]")
        title = cell.select_one(".game_title a[href], a.title[href]")
        if not author or not title:
            continue
        project_url = _safe_project_url(urljoin(final, title.get("href", "")), ("itch.io",))
        profile_url = _safe_project_url(urljoin(final, author.get("href", "")), ("itch.io",))
        if not project_url or not profile_url or project_url in seen:
            continue
        seen.add(project_url)
        host = (urlparse(project_url).hostname or "").lower()
        slug = urlparse(project_url).path.strip("/")
        game = title.get_text(" ", strip=True)
        creator = author.get_text(" ", strip=True) or (urlparse(profile_url).hostname or "").split(".")[0]
        tags = list(dict.fromkeys(a.get_text(" ", strip=True) for a in cell.select(".game_genre a, .game_tag a") if a.get_text(" ", strip=True)))
        rows.append({"name": creator, "website": "", "contact_email": "", "contact_source_url": "", "meta": {
            "source": "itch", "source_key": "itch", "source_url": project_url, "project_url": project_url,
            "project_source_url": project_url, "project_id": f"itch:{host}/{slug}",
            "itch_project_id": f"{host}/{slug}", "project_title": game, "game": game,
            "developer_name": creator, "creator_name": creator, "developer_profile_url": profile_url,
            "developer_identity_status": "platform_creator_unverified", "genres": tags[:20], "tags": tags[:30],
            "discovered_at": _utc_now(),
            # Creator attribution and activity are research questions, not discovery assumptions.
        }})
    next_link = soup.select_one('a[rel="next"], a.next_page, .pagination a[aria-label="Next"]')
    if not next_link:
        next_link = next((a for a in soup.select(".pagination a[href]") if a.get_text(" ", strip=True).lower() in {"next", "›", "→"}), None)
    return rows, bool(next_link)


def itch_page(fetcher, keywords: list[str], cursor: dict | None = None, limit: int = 12) -> tuple[list[dict], dict | None]:
    """One public itch.io browse page, retaining project-level identity and a page/row cursor."""
    if not keywords:
        return [], None
    cursor = cursor if isinstance(cursor, dict) else {}
    index = max(0, int(cursor.get("keyword_index", 0) or 0))
    page = max(1, int(cursor.get("page", 1) or 1))
    offset = max(0, int(cursor.get("offset", 0) or 0))
    while index < len(keywords):
        rows, has_next = _itch_page(fetcher, str(keywords[index]), page)
        batch = rows[offset:offset + max(1, min(int(limit), 25))]
        next_offset = offset + len(batch)
        if next_offset < len(rows):
            return batch, {"keyword_index": index, "page": page, "offset": next_offset}
        if has_next:
            return batch, {"keyword_index": index, "page": page + 1, "offset": 0}
        index += 1; page = 1; offset = 0
        if batch:
            return batch, ({"keyword_index": index, "page": 1, "offset": 0} if index < len(keywords) else None)
    return [], None


def itch(fetcher, keywords: list[str], limit: int = MAX_PER_RUN) -> list[dict]:
    return itch_page(fetcher, keywords, None, limit)[0]


def discover_batch(fetcher, ptype: str, criteria: dict, *, cursor=None, enabled_sources=None,
                   reserve_source=None, report_source=None, source_status=None, limit: int = 25) -> dict:
    """One resumable discovery slice per authorized source. Budget/circuit holds retain cursors; transient errors bubble up."""
    if ptype != "indie_game_developer":
        return {"candidates": [], "next_cursor": {}}
    criteria = criteria if isinstance(criteria, dict) else {}
    requested = criteria.get("sources")
    raw_keywords = criteria.get("keywords")
    keywords = [k.strip() for k in raw_keywords if isinstance(k, str) and k.strip()] if isinstance(raw_keywords, list) else []
    if not isinstance(requested, list) or not requested or not keywords or enabled_sources is None or reserve_source is None:
        return {"candidates": [], "next_cursor": {}}
    if any(not isinstance(key, str) or key not in ("steam", "itch") for key in requested):
        return {"candidates": [], "next_cursor": {}}
    state = cursor if isinstance(cursor, dict) else {}
    status_map = source_status if isinstance(source_status, dict) else {}
    candidates, next_state, deferred = [], {}, {}
    quota = max(1, min(25, int(limit) // max(1, len(requested))))

    def initial_cursor(key):
        return ({"keyword_index": 0, "start": 0} if key == "steam" else {"keyword_index": 0, "page": 1, "offset": 0})

    for key, adapter in (("steam", steam_page), ("itch", itch_page)):
        if key not in requested:
            continue
        if key not in enabled_sources:
            if report_source:
                report_source(key, False, "requested source is not registry-authorized")
            continue
        current = state.get(key) if isinstance(state.get(key), dict) else initial_cursor(key)
        # A source can finish while another source still has pages or is waiting for
        # its budget/circuit reset. Persist an explicit terminal marker so an absent
        # page cursor is never mistaken for a request to restart at page one.
        if current.get("done") is True:
            next_state[key] = {"done": True}
            continue
        source_info = status_map.get(key) if isinstance(status_map.get(key), dict) else {}
        if source_info and (source_info.get("enabled") is not True or source_info.get("tos_status") != "confirmed"):
            continue
        if source_info.get("circuit_open") is True:
            next_state[key] = current
            deferred[key] = max(60, int(source_info.get("retry_after_seconds") or 3600))
            continue
        if source_info and int(source_info.get("remaining", 0) or 0) <= 0:
            next_state[key] = current
            deferred[key] = 86400
            continue

        class MeteredFetcher:
            def fetch(self, url):
                if not reserve_source(key):
                    raise PermanentError(f"{key} source budget reservation denied")
                return fetcher.fetch(url)
        try:
            rows, nxt = adapter(MeteredFetcher(), keywords, current, quota)
        except PermanentError as exc:
            if "budget reservation denied" in str(exc).lower():
                # The source is still authorized but its remaining daily budget was consumed
                # during this page. Preserve the exact cursor and resume after the daily reset.
                next_state[key] = current
                deferred[key] = 86400
                continue
            if report_source: report_source(key, False, exc)
            continue
        except TransientError as exc:
            if report_source: report_source(key, False, exc)
            raise
        if report_source: report_source(key, True, "")
        candidates.extend(rows)
        next_state[key] = nxt if nxt is not None else {"done": True}

    # Keep active sources moving quickly while a different source is waiting for its
    # budget reset or circuit recovery. If only deferred cursors remain, sleep until
    # the earliest source can resume rather than polling every few seconds. Terminal
    # markers are retained only while at least one other source needs continuation.
    active_more = any(
        key not in deferred and isinstance(value, dict) and value.get("done") is not True
        for key, value in next_state.items()
    )
    has_deferred = bool(deferred)
    if not active_more and not has_deferred:
        next_state = {}
    defer_seconds = 30 if active_more else (min(deferred.values()) if has_deferred else 30)
    return {"candidates": candidates, "next_cursor": next_state, "defer_seconds": defer_seconds if next_state else None}

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


def discover(fetcher, ptype: str, criteria: dict, *, enabled_sources=None, reserve_source=None, report_source=None) -> list[dict]:
    """Discover only through explicitly configured and registry-authorized sources.

    Indie adapters receive a per-request metered fetcher: every Steam search/details
    request and every itch tag page reserves one source-budget unit immediately
    before network access. Missing registry/reservation callbacks fail closed.
    """
    criteria = criteria if isinstance(criteria, dict) else {}
    raw_keywords = criteria.get("keywords")
    kws = [k.strip() for k in raw_keywords if isinstance(k, str) and k.strip()] if isinstance(raw_keywords, list) else []
    if ptype == "indie_game_developer":
        requested = criteria.get("sources")
        if not isinstance(requested, list) or not kws or enabled_sources is None or reserve_source is None:
            return []
        out = []
        # Validate requested source values instead of silently treating malformed
        # configuration as an empty/partially authorized request.
        if any(not isinstance(key, str) or key not in ("steam", "itch") for key in requested):
            return []
        for key, adapter in (("steam", steam), ("itch", itch)):
            if key not in requested:
                continue
            if key not in enabled_sources:
                if report_source:
                    report_source(key, False, "requested source is not registry-authorized")
                continue
            class MeteredFetcher:
                def fetch(self, url):
                    if not reserve_source(key):
                        raise PermanentError(f"{key} source is disabled, unconfirmed, over budget or circuit-open")
                    return fetcher.fetch(url)
            try:
                out.extend(adapter(MeteredFetcher(), kws))
            except (PermanentError, TransientError) as exc:
                if report_source:
                    report_source(key, False, exc)
                continue
            if report_source:
                report_source(key, True, "")
        return out
    raw_seed_urls = criteria.get("seed_urls")
    seed_urls = [u for u in raw_seed_urls if isinstance(u, str) and u.strip()] if isinstance(raw_seed_urls, list) else []
    if not seed_urls or enabled_sources is None or reserve_source is None or "site_crawler" not in enabled_sources:
        return []
    class MeteredSeedFetcher:
        def fetch(self, url):
            if not reserve_source("site_crawler"):
                raise PermanentError("site_crawler source is disabled, unconfirmed, over budget or circuit-open")
            return fetcher.fetch(url)
    try:
        out = seeds(MeteredSeedFetcher(), seed_urls)
    except (PermanentError, TransientError) as exc:
        if report_source:
            report_source("site_crawler", False, exc)
        return []
    if report_source:
        report_source("site_crawler", True, "")
    return out
