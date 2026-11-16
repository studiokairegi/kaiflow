"""Deterministic, source-backed extraction for Indie Game Developers research.

Only explicit dates attached to a page's own update/news content count as activity.
Page fetch time, newest-list position, generic modified timestamps, and release dates
are never converted into development activity. Visual media is queued as unverified
for a human reviewer; this module does not claim to recognize anime aesthetics.
"""
from __future__ import annotations

import json
import re
from datetime import date, datetime
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

ACTIVITY_RE = re.compile(
    r"\b(devlog|development update|progress update|development progress|patch notes?|"
    r"new build|build update|playtest update|demo update|demo released|update released|"
    r"major update|game update|bug[- ]fix update|content update)\b|"
    r"開発日記|開発進捗|開発アップデート|アップデート|パッチノート|体験版公開|デモ公開|更新情報",
    re.I | re.U,
)
ANNOUNCEMENT_RE = re.compile(r"\b(announced|announcement|revealed|unveiled|first look)\b|発表|公開決定|初公開", re.I | re.U)
MARKETING_RE = re.compile(
    r"\b(upcoming|launch(?:es|ing)?|release date|pre[- ]?order|wishlist|demo|early access|"
    r"DLC|expansion|console release|relaunch|campaign starts?|kickstarter campaign)\b|"
    r"発売予定|発売日|予約開始|体験版|デモ|早期アクセス|追加コンテンツ|大型アップデート|移植",
    re.I | re.U,
)


def _http_url(value: str) -> bool:
    p = urlparse(str(value or ""))
    return p.scheme in {"http", "https"} and bool(p.hostname and "." in p.hostname)


def _date(value: str) -> date | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        # Date-only and RFC3339/ISO timestamps. Reject fuzzy dates rather than inventing a day.
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).date()
    except ValueError:
        return None


def _context(node) -> str:
    parent = node.parent
    for _ in range(4):
        if parent is None:
            break
        text = re.sub(r"\s+", " ", parent.get_text(" ", strip=True))
        if len(text) >= 30:
            if len(text) <= 1200:
                return text
            # Long article bodies are clipped around an explicit event phrase, not around fetch time.
            match = ACTIVITY_RE.search(text) or ANNOUNCEMENT_RE.search(text) or MARKETING_RE.search(text)
            if match:
                start = max(0, match.start() - 420)
                return text[start:start + 1200]
            return text[:1200]
        parent = parent.parent
    return re.sub(r"\s+", " ", node.get_text(" ", strip=True))[:1200]



def _jsonld_article_nodes(value):
    """Yield article-like JSON-LD nodes from objects, arrays and nested @graph."""
    if isinstance(value, list):
        for item in value:
            yield from _jsonld_article_nodes(item)
    elif isinstance(value, dict):
        typ = value.get("@type")
        types = typ if isinstance(typ, list) else [typ]
        if any(str(t).casefold() in {"blogposting", "newsarticle", "article"} for t in types):
            yield value
        graph = value.get("@graph")
        if graph is not None:
            yield from _jsonld_article_nodes(graph)


def extract_dated_events(pages: list[tuple[str, str]], *, today: date | None = None) -> list[dict]:
    """Return explicit, contextual date events from same-site fetched pages."""
    today = today or date.today()
    out, seen = [], set()
    for page_url, html in pages:
        soup = BeautifulSoup(html, "lxml")
        for node in soup.find_all("time"):
            when = _date(node.get("datetime") or node.get_text(" ", strip=True))
            if not when:
                continue
            snippet = _context(node)
            if ACTIVITY_RE.search(snippet) and when <= today:
                kind = "development_update"
            elif ANNOUNCEMENT_RE.search(snippet) and when <= today:
                kind = "project_announcement"
            elif MARKETING_RE.search(snippet):
                kind = "marketing_opportunity"
            else:
                continue
            snippet = f"{snippet} [explicit page date: {when.isoformat()}]"
            key = (kind, when.isoformat(), page_url, snippet[:180])
            if key in seen:
                continue
            seen.add(key)
            out.append({"fact_type": kind, "date": when.isoformat(), "url": page_url, "snippet": snippet})
        # JSON-LD dates are used only for explicitly typed articles/news posts with matching activity, announcement or marketing language.
        for script in soup.find_all("script", attrs={"type": "application/ld+json"}):
            try:
                raw = json.loads(script.string or script.get_text())
            except (ValueError, TypeError):
                continue
            for obj in _jsonld_article_nodes(raw):
                body = " ".join(str(obj.get(k) or "") for k in ("headline", "name", "description", "articleBody"))
                if not ACTIVITY_RE.search(body) and not ANNOUNCEMENT_RE.search(body) and not MARKETING_RE.search(body):
                    continue
                when = _date(obj.get("datePublished"))  # dateModified alone is not meaningful activity.
                if not when:
                    continue
                if ACTIVITY_RE.search(body) and when <= today:
                    kind = "development_update"
                elif ANNOUNCEMENT_RE.search(body) and when <= today:
                    kind = "project_announcement"
                elif MARKETING_RE.search(body):
                    kind = "marketing_opportunity"
                else:
                    continue
                snippet = re.sub(r"\s+", " ", body)[:1100] + f" [structured datePublished: {when.isoformat()}]"
                key = (kind, when.isoformat(), page_url, snippet[:180])
                if key not in seen:
                    seen.add(key)
                    out.append({"fact_type": kind, "date": when.isoformat(), "url": page_url, "snippet": snippet})
    return sorted(out, key=lambda x: (x["date"], x["url"]), reverse=True)[:30]


def extract_visual_candidates(pages: list[tuple[str, str]], *, limit: int = 30) -> list[dict]:
    """Find public image/video references for human review; never labels their visual style."""
    out, seen = [], set()
    for page_url, html in pages:
        soup = BeautifulSoup(html, "lxml")
        candidates = []
        for meta in soup.find_all("meta"):
            if (meta.get("property") or meta.get("name") or "").casefold() in {"og:image", "twitter:image"}:
                candidates.append((meta.get("content"), "image", "social preview"))
        for img in soup.find_all("img"):
            candidates.append((img.get("src") or img.get("data-src"), "image", img.get("alt") or "image without alt text"))
        for video in soup.find_all("video"):
            candidates.append((video.get("poster"), "video_poster", "video poster"))
            for source in video.find_all("source"):
                candidates.append((source.get("src"), "video", "video source"))
        for href in soup.find_all("a", href=True):
            if re.search(r"\.(?:png|jpe?g|webp|gif|mp4|webm)(?:$|\?)", href["href"], re.I):
                candidates.append((href["href"], "media_link", href.get_text(" ", strip=True)[:120] or "linked media"))
        for raw, kind, label in candidates:
            if not raw:
                continue
            url = urljoin(page_url, str(raw).strip())
            parsed = urlparse(url)
            if not _http_url(url) or parsed.scheme not in {"http", "https"} or url in seen:
                continue
            seen.add(url)
            out.append({"fact_type": "visual_asset_candidate", "url": page_url,
                        "snippet": f"Unverified {kind} candidate: {url} | {label}"})
            if len(out) >= limit:
                return out
    return out


def extract_identity_mentions(pages: list[tuple[str, str]], developer_name: str, project_title: str) -> list[dict]:
    """Create evidence candidates only when exact names literally occur on the official site."""
    developer_name = re.sub(r"\s+", " ", str(developer_name or "")).strip()
    project_title = re.sub(r"\s+", " ", str(project_title or "")).strip()
    if len(developer_name) < 2 or len(project_title) < 2:
        return []
    out, seen = [], set()
    for url, html in pages:
        text = re.sub(r"\s+", " ", BeautifulSoup(html, "lxml").get_text(" ", strip=True))
        for label, value, kind in (("developer", developer_name, "developer_identity"), ("project", project_title, "project_identity")):
            match = re.search(re.escape(value), text, re.I)
            if not match:
                continue
            start, end = max(0, match.start() - 180), min(len(text), match.end() + 220)
            snippet = text[start:end].strip()
            key = (kind, url, snippet.casefold())
            if key not in seen:
                seen.add(key)
                out.append({"fact_type": kind, "url": url, "snippet": snippet})
    return out
