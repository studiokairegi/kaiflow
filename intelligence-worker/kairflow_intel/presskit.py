"""Press-kit reading: a deterministic parser for a game's press kit or media page.

A press kit is often the most reliable single page for a small game: it normally names the developer and publisher, links the
official site and stores, lists the release date and platforms, and gives a press or business contact. This module only reads
what the page itself says. It never calls a model, never guesses an address, and never fetches anything: callers pass HTML in.

Rules, as everywhere else in the worker:
  * every fact is a "Label: value" line that really appears in the page text, and is marked verified only after that is re-checked here
  * an email is reported only when it sits in a labelled press / business / contact field. A stray address elsewhere on the page is ignored
  * a press address is a PRESS contact. It is never promoted to a verified business contact here; contactability.py decides what it allows
  * social and store links are recorded as plain text for a human. Nothing in this module follows them (Kickstarter stays manual-only)

The format of the free "presskit()" tool (a Factsheet block of bold labels and values), plain /press pages with "Label: value" lines,
and dt/dd or table layouts are handled. The fixtures in tests/ are synthetic: selectors are untested against live pages.
"""
from __future__ import annotations

import re
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from .entity import registrable_domain
from .safety import EMAIL_RE, extract_emails, html_to_text

# Fact types written to the evidence table (fact_type is free text there; research_report.REPORTABLE lists them).
FACT_TYPES = {
    "developer": "presskit_developer", "publisher": "presskit_publisher", "website": "presskit_website",
    "release": "presskit_release", "platforms": "presskit_platforms", "founded": "presskit_founded",
    "press_contact": "presskit_contact",
}
MAX_VALUE = 160
MAX_LABEL = 40
KIT_TEXT = re.compile(r"press[\s-]?kit|presskit|media[\s-]?kit|fact\s?sheet", re.I)
KIT_PATH = re.compile(r"press[\s-]?kit|presskit|media[\s-]?kit|/media(?:/|$|\?)|/press(?:[-_][\w-]+)?(?:/|$|\?)", re.I)
PAGE_EXT = {"", "html", "htm", "shtml", "php", "asp", "aspx", "jsp", "cfm"}
COMMON_PATHS = ("/presskit/", "/press/", "/press-kit/")
LABEL_LINE = re.compile(r"^([A-Za-z][A-Za-z /&\-]{1,%d}):\s*(.*)$" % (MAX_LABEL - 1))
# Hosts whose links are worth showing a human. Only recorded, never fetched.
LINK_HOSTS = {
    "store.steampowered.com": "steam", "steampowered.com": "steam", "itch.io": "itch", "twitter.com": "twitter", "x.com": "x",
    "bsky.app": "bluesky", "discord.gg": "discord", "discord.com": "discord", "youtube.com": "youtube", "youtu.be": "youtube",
    "kickstarter.com": "kickstarter", "gog.com": "gog", "store.epicgames.com": "epic",
}


def _squash(text: str) -> str:
    """Whitespace- and colon-insensitive form, so "Developer:\\nTiny Moon" and "Developer: Tiny Moon" compare equal."""
    return re.sub(r"\s+", " ", str(text or "").replace(":", " ")).strip().casefold()


def _label_key(label: str) -> str | None:
    lab = re.sub(r"\s+", " ", label).strip().casefold()
    if not lab or len(lab) > MAX_LABEL:
        return None
    if re.search(r"\bsocial\b|\bquotes?\b|\btrailer\b|\bawards?\b|\breviews?\b", lab):
        return None
    if re.search(r"publish", lab):
        return "publisher"
    if re.search(r"contact|e-?mail|enquir|inquir", lab) or re.fullmatch(r"press|media|business|(press|media) (relations|office|team|room)", lab):
        return "press_contact"
    if re.search(r"\bdevelop(er|ers)\b|\bdeveloped by\b|\bstudio\b|\bcompany\b|\bcreators?\b|\bmade by\b", lab):
        return "developer"
    if re.search(r"web ?site|homepage|official site|^web$", lab):
        return "website"
    if re.search(r"platform|available (on|at|for)|\bstores?\b", lab):
        return "platforms"
    if re.search(r"release|^launch( date)?$|^launching|^available( date| from| in| since)?$", lab):
        return "release"
    if re.search(r"found(ed|ing)|established", lab):
        return "founded"
    return None


def _clip(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:MAX_VALUE]


def _line_pairs(text: str) -> list[tuple[str, str]]:
    """Label/value pairs from page text: "Label: value" on one line, or "Label:" with the value on the next line."""
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    out = []
    for i, ln in enumerate(lines):
        m = LABEL_LINE.match(ln)
        if not m:
            continue
        label, value = m.group(1), m.group(2).strip()
        if not value and i + 1 < len(lines) and not LABEL_LINE.match(lines[i + 1]):
            value = lines[i + 1]
        if value:
            out.append((label, value))
    return out


def _markup_pairs(soup) -> list[tuple[str, str]]:
    """dt/dd and two-cell table rows, which html_to_text flattens without a colon."""
    out = []
    for dt in soup.find_all("dt"):
        dd = dt.find_next_sibling("dd")
        if dd:
            out.append((dt.get_text(" ", strip=True), dd.get_text(" ", strip=True)))
    for tr in soup.find_all("tr"):
        cells = tr.find_all(["th", "td"], recursive=False)
        if len(cells) == 2:
            out.append((cells[0].get_text(" ", strip=True), cells[1].get_text(" ", strip=True)))
    return out


def _title(soup, fallback_text: str = "") -> str:
    node = soup.find("meta", property="og:title")
    raw = (node.get("content") or "").strip() if node else ""
    if not raw:
        h1 = soup.find("h1")
        raw = h1.get_text(" ", strip=True) if h1 else (soup.title.get_text(" ", strip=True) if soup.title else "")
    kit_word = r"(press[\s-]?kit|presskit|media[\s-]?kit|press)"
    for seg in re.split(r"\s+[|–—]\s+|\s+-\s+", raw):
        seg = re.sub(r"\s*[:\-–—|]?\s*" + kit_word + r"\s*$", "", seg.strip(), flags=re.I)
        seg = re.sub(r"^" + kit_word + r"\s*[:\-–—|]\s*", "", seg, flags=re.I).strip()
        if seg:
            return seg[:120]          # "Press Kit - Tiny Quest" and "Tiny Quest | Press Kit" both give "Tiny Quest"
    return ""


def _links(soup, base_url: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for a in soup.find_all("a", href=True):
        url = urljoin(base_url, a["href"]).split("#")[0]
        p = urlparse(url)
        host = (p.hostname or "").lower().removeprefix("www.")
        if p.scheme not in ("http", "https") or not host:
            continue
        for suffix, kind in LINK_HOSTS.items():
            if host == suffix or host.endswith("." + suffix):
                out.setdefault(kind, url[:300])
    return out


def _registrable(host: str) -> str:
    """Registrable domain, with multi-part suffixes (co.uk, co.jp) handled by the shared entity helper."""
    return registrable_domain(host or "")


def _same_host(a: str, b: str) -> bool:
    """Same site ignoring a leading www. (apex and www are the same site for press-kit link and redirect checks)."""
    norm = lambda h: (h or "").lower().removeprefix("www.")
    return bool(norm(a)) and norm(a) == norm(b)


def _first_http(value: str, base_url: str, soup, label: str) -> str:
    """The website value as an absolute http(s) URL: the visible text if it is one, else the link inside that field."""
    m = re.search(r"https?://[^\s<>\"']+", value)
    if m:
        return m.group(0).rstrip(".,;)")
    bare = re.fullmatch(r"(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:/\S*)?", value.strip(), re.I)
    if bare:
        return "https://" + value.strip()
    for a in soup.find_all("a", href=True):
        if a.get_text(" ", strip=True).casefold() == value.casefold():
            url = urljoin(base_url, a["href"])
            if urlparse(url).scheme in ("http", "https"):
                return url
    return ""


def parse(html: str, url: str, *, site_host: str = "") -> dict:
    """Read one page. Returns {"is_presskit", "url", "title", "facts", "press_emails", "website", "links"}.

    facts: [{fact_type, label, value, snippet, verified}]; snippet is "Label: value" exactly as the page says it.
    press_emails: [{email, how, on_site_domain, snippet}] only from a labelled press / business / contact field.
    """
    empty = {"is_presskit": False, "url": url, "title": "", "facts": [], "press_emails": [], "website": "", "links": {}}
    if not html or not isinstance(html, str):
        return empty
    try:
        soup = BeautifulSoup(html, "lxml")
        text = html_to_text(html)
    except Exception:
        return empty
    squashed = _squash(text)
    pairs = _markup_pairs(soup) + _line_pairs(text)
    facts, seen, press_values = [], set(), []
    for label, value in pairs:
        key = _label_key(label)
        value = _clip(value)
        if not key or not value:
            continue
        label_clean = re.sub(r"\s+", " ", label).strip()
        snippet = f"{label_clean}: {value}"
        # Re-check against the visible text: a fact that is not really on the page is dropped, never reported.
        ok = _squash(snippet) in squashed or (_squash(label) in squashed and _squash(value) in squashed)
        if not ok:
            continue
        ident = (key, _squash(value))
        if ident in seen:
            continue
        seen.add(ident)
        facts.append({"fact_type": FACT_TYPES[key], "label": label.strip(), "value": value, "snippet": snippet[:240], "verified": True, "_key": key})
        if key == "press_contact":
            press_values.append((value, snippet[:240]))
    kit_signal = bool(KIT_TEXT.search(text[:4000]) or KIT_PATH.search(urlparse(url).path or ""))
    useful = {f["_key"] for f in facts} & {"developer", "publisher", "release", "website", "press_contact", "platforms"}
    if not (kit_signal and useful):
        return empty
    # Press emails: only addresses that appear inside a labelled contact value. A page-wide scrape is deliberately not used.
    page_emails = {e["email"]: e["how"] for e in extract_emails(html)}
    host = (urlparse(site_host if "://" in site_host else f"https://{site_host}").hostname or site_host or urlparse(url).hostname or "")
    site_reg = _registrable(host)
    emails, got = [], set()
    for value, snippet in press_values:
        for m in EMAIL_RE.finditer(value):
            addr = m.group(0).lower()
            if addr in got or addr not in page_emails:
                continue
            got.add(addr)
            emails.append({"email": addr, "how": page_emails[addr], "on_site_domain": _registrable(addr.split("@")[1]) == site_reg,
                           "snippet": snippet})
    website = ""
    for f in facts:
        if f["_key"] == "website":
            website = _first_http(f["value"], url, soup, f["label"])
            break
    for f in facts:
        f.pop("_key", None)
    return {"is_presskit": True, "url": url, "title": _title(soup), "facts": facts, "press_emails": emails, "website": website,
            "links": _links(soup, url)}


def _is_page_url(url: str) -> bool:
    """False for a download or asset (/presskit.zip, /media/hero.png, a PDF, a video): those are never fetched as press-kit pages."""
    last = (urlparse(url or "").path or "").rsplit("/", 1)[-1]
    ext = last.rsplit(".", 1)[-1].lower() if "." in last else ""
    return ext in PAGE_EXT


def looks_like_presskit_url(url: str, anchor: str = "") -> bool:
    return _is_page_url(url) and bool(KIT_PATH.search(urlparse(url or "").path or "") or KIT_TEXT.search(anchor or ""))


def candidate_urls(home_url: str, html: str, *, skip: set[str] | None = None, limit: int = 2, probe: bool = True) -> list[str]:
    """Same-host press-kit URLs worth fetching. Links the page itself shows come first. Only when the page shows none are the
    few conventional paths probed (at most `limit` in total). `skip` holds URLs already fetched."""
    skip = {u.rstrip("/") for u in (skip or set())}
    base = urlparse(home_url)
    found: list[str] = []
    try:
        soup = BeautifulSoup(html or "", "lxml")
    except Exception:
        soup = None
    if soup is not None:
        for a in soup.find_all("a", href=True):
            u = urljoin(home_url, a["href"]).split("#")[0]
            p = urlparse(u)
            if p.scheme not in ("http", "https") or not _same_host(p.hostname or "", base.hostname or ""):
                continue
            if looks_like_presskit_url(u, a.get_text(" ", strip=True)) and u.rstrip("/") not in skip and u not in found:
                found.append(u)
    if not found and probe and base.scheme in ("http", "https") and base.hostname:
        origin = f"{base.scheme}://{base.netloc}"
        found = [origin + path for path in COMMON_PATHS if (origin + path).rstrip("/") not in skip]
    return found[: max(0, limit)]
