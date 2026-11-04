"""Deeper look at one studio site: sitemap -> recruitment/outsourcing pages, feeds, and credits links to other studios (the snowball).
Everything is fetched through the robots-respecting Fetcher. Evidence is the page's own sentence."""
from __future__ import annotations

import hashlib
import re
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup
from lxml import etree

from . import classify_org, entity, feeds, signals
from .errors import PermanentError, TransientError
from .safety import html_to_text

RECRUIT_URL = re.compile(r"recruit|saiyo|saiyou|careers?|jobs?|join|freelanc|outsourc|partner|staff|採用|求人|募集|協力|外注|パートナー", re.I | re.U)
CREDIT_URL = re.compile(r"works?|credits?|staff|partner|cooperation|協力|制作実績|取引先|関連会社|パートナー", re.I | re.U)
XML = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False, huge_tree=False, recover=True)
MAX_SITEMAP_URLS = 2000
MAX_SNOWBALL_PER_SITE = 8
MAX_DEPTH = 2


def _h(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()[:40]


def parse_sitemap(xml: str) -> tuple[list[str], list[str]]:
    """(page urls, child sitemap urls). Untrusted XML: no entities, no DTD."""
    try:
        root = etree.fromstring(xml.encode("utf-8", "replace")[:3_000_000], XML)
    except etree.XMLSyntaxError:
        return [], []
    if root is None:
        return [], []
    locs = [(e.text or "").strip() for e in root.iter() if isinstance(e.tag, str) and e.tag.endswith("loc")]
    kind = etree.QName(root).localname if isinstance(root.tag, str) else ""
    return ([], locs) if kind == "sitemapindex" else (locs, [])


def sitemap_urls(fetcher, base_url: str) -> list[str]:
    p = urlparse(base_url)
    origin = f"{p.scheme}://{p.netloc}"
    queue = (fetcher.sitemaps(base_url) or [origin + "/sitemap.xml"])[:3]
    urls: list[str] = []
    fetched = 0
    while queue and fetched < 6 and len(urls) < MAX_SITEMAP_URLS:
        u = queue.pop(0)
        if urlparse(u).hostname != p.hostname or u.endswith(".gz"):
            continue
        try:
            _, xml = fetcher.fetch(u)
        except (PermanentError, TransientError):
            continue
        fetched += 1
        pages, children = parse_sitemap(xml)
        urls += [x for x in pages if urlparse(x).hostname == p.hostname]
        queue += children[:5]
    return urls[:MAX_SITEMAP_URLS]


def pick_recruit_pages(urls: list[str], limit: int = 4) -> list[str]:
    scored = []
    for u in urls:
        path = urlparse(u).path or "/"
        hits = len(RECRUIT_URL.findall(path))
        if hits:
            scored.append((-hits, len(path), u))
    return [u for _, _, u in sorted(scored)[:limit]]


def credit_candidates(html: str, page_url: str, own_domain: str, limit: int = MAX_SNOWBALL_PER_SITE) -> list[dict]:
    """Other companies linked from a works/credits/partner page: studios worth investigating. Social and platform links are ignored."""
    soup, out, seen = BeautifulSoup(html, "lxml"), [], set()
    for a in soup.find_all("a", href=True):
        u = urljoin(page_url, a["href"])
        if urlparse(u).scheme not in ("http", "https"):
            continue
        d = entity.registrable_domain(u)
        if not d or d == own_domain or d in seen or entity.is_social_or_platform(u):
            continue
        name = re.sub(r"\s+", " ", a.get_text(" ", strip=True))[:60]
        if len(name) < 2 or re.fullmatch(r"https?://\S+|[\W_]+|more|link|click here|詳細|こちら|公式サイト", name, re.I):
            continue
        seen.add(d)
        p = urlparse(u)
        out.append({"name": name, "website": f"{p.scheme}://{p.netloc}", "domain": d})
        if len(out) >= limit:
            break
    return out


def analyze(d, ctx: dict) -> dict:
    """Run for one prospect. Returns counts. Raises PermanentError only when the site itself cannot be read."""
    p = ctx["prospect"]
    site = p["website"] if p["website"].startswith("http") else f"https://{p['website']}"
    table = signals.INDIE if p["type"] == "indie_game_developer" else signals.STUDIO
    final, home = d.fetcher.fetch(site)
    home_text = html_to_text(home)
    own = entity.registrable_domain(final)
    verdict = classify_org.classify(home_text, p["name"], urlparse(final).hostname or "")
    if verdict["kind"] == "individual" and p["type"] == "animation_studio_support":
        d.rpc("intel_agent_flag_prospect", {"p_prospect_id": p["id"], "p_reason": "looks like an individual, not a studio: " + ", ".join(verdict["reasons"])[:200]})
        return {"classified": "individual"}

    for f in feeds.feed_links(home, final):
        d.rpc("intel_agent_record_item", {"p_source": "rss", "p_type": "feed", "p_url": f, "p_title": "feed", "p_snippet": "", "p_language": "", "p_prospect_id": p["id"], "p_meta": {}})

    found, pages_read = 0, 0
    for u in pick_recruit_pages(sitemap_urls(d.fetcher, final)):
        try:
            url, html = d.fetcher.fetch(u)
        except (PermanentError, TransientError):
            continue
        pages_read += 1
        for sig, sent in signals.detect(html_to_text(html), table).items():
            found += 1
            d.rpc("intel_agent_add_evidence", {"p_prospect_id": p["id"], "p_source": "web", "p_url": url, "p_fact_type": sig, "p_snippet": sent, "p_content_hash": _h(sent), "p_verified": True})
            d.rpc("intel_agent_record_item", {"p_source": "site_crawler", "p_type": "recruit_page", "p_url": url, "p_title": sig, "p_snippet": sent[:500], "p_language": "", "p_prospect_id": p["id"], "p_meta": {"signal": sig}})

    spawned = 0
    depth = int(((p.get("facts") or {}).get("verified") or {}).get("depth", 0))
    if depth < MAX_DEPTH and p["type"] == "animation_studio_support":
        credit_pages = [u for u in [final] + [x for x in sitemap_urls(d.fetcher, final) if CREDIT_URL.search(urlparse(x).path or "")][:2]]
        for cu in credit_pages[:3]:
            try:
                url, html = (final, home) if cu == final else d.fetcher.fetch(cu)
            except (PermanentError, TransientError):
                continue
            if cu == final and not CREDIT_URL.search(home_text[:2000]):
                pass
            for c in credit_candidates(html, url, own):
                if spawned >= MAX_SNOWBALL_PER_SITE:
                    break
                if int(d.rpc("intel_agent_source_use", {"p_key": "site_crawler", "p_n": 1}) or 0) <= 0:
                    return {"signals": found, "pages": pages_read, "spawned": spawned, "budget": "exhausted"}
                from .discovery import ingest
                _, created = ingest(d, p["type"], {**c, "meta": {"source": "credit_link", "depth": depth + 1, "found_on": p["domain"]}}, via="credit_link")
                spawned += 1 if created else 0
    return {"signals": found, "pages": pages_read, "spawned": spawned}
