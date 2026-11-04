"""RSS / Atom reading. XML from the web is untrusted: no entity expansion, no DTD loading, no network access."""
from __future__ import annotations

import re
from lxml import etree

PARSER = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False, huge_tree=False, recover=True, dtd_validation=False)


def _text(el) -> str:
    return re.sub(r"\s+", " ", "".join(el.itertext())).strip() if el is not None else ""


def parse_feed(xml: str, max_entries: int = 40) -> list[dict]:
    try:
        root = etree.fromstring(xml.encode("utf-8", "replace")[:2_000_000], PARSER)
    except etree.XMLSyntaxError:
        return []
    if root is None:
        return []
    ns = {"a": "http://www.w3.org/2005/Atom"}
    out = []
    items = root.findall(".//item") + root.findall(".//a:entry", ns)
    for it in items[:max_entries]:
        title = _text(it.find("title")) or _text(it.find("a:title", ns))
        link = (it.findtext("link") or "").strip()
        if not link:
            a = it.find("a:link", ns)
            link = (a.get("href") if a is not None else "") or ""
        summary = _text(it.find("description")) or _text(it.find("a:summary", ns)) or _text(it.find("a:content", ns))
        date = (it.findtext("pubDate") or it.findtext("a:updated", namespaces=ns) or it.findtext("a:published", namespaces=ns) or "").strip()
        if title or link:
            out.append({"title": title[:300], "link": link[:500], "summary": summary[:600], "date": date})
    return out


def feed_links(html: str, base: str) -> list[str]:
    from urllib.parse import urljoin
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, "lxml")
    out = []
    for l in soup.find_all("link", href=True):
        t = (l.get("type") or "").lower()
        if "alternate" in (l.get("rel") or []) and ("rss" in t or "atom" in t):
            u = urljoin(base, l["href"])
            if u not in out:
                out.append(u)
    return out[:3]
