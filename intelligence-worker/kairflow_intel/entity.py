"""Naming and domain helpers for entity resolution (English and Japanese company names)."""
from __future__ import annotations

import re
import unicodedata
from urllib.parse import urlparse

# Multi-part public suffixes seen on studio sites. Small on purpose: no dependency, and unknown suffixes fall back to "last two labels".
MULTI_SUFFIXES = {"co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp", "gr.jp", "ed.jp", "co.uk", "org.uk", "ac.uk", "com.au", "net.au", "co.kr", "or.kr",
                  "com.cn", "com.tw", "com.hk", "co.nz", "com.br", "co.in", "com.sg", "com.my", "co.th", "co.id"}
SOCIAL_HOSTS = {"x.com", "twitter.com", "t.co", "facebook.com", "instagram.com", "youtube.com", "youtu.be", "tiktok.com", "pixiv.net", "note.com", "linktr.ee",
                "carrd.co", "bsky.app", "skeb.jp", "fanbox.cc", "booth.pm", "wikipedia.org", "wikidata.org", "anilist.co", "myanimelist.net", "linkedin.com",
                "github.com", "steampowered.com", "store.steampowered.com", "itch.io", "kickstarter.com", "google.com", "amazon.co.jp", "amazon.com", "apple.com"}
COMPANY_WORDS = re.compile(r"(株式会社|有限会社|合同会社|㈱|㈲|\bco\.?,?\s*ltd\.?|\bltd\.?|\bllc\b|\binc\.?|\bcorp\.?|\bcorporation\b|\bcompany\b|\bgmbh\b)", re.I)


def registrable_domain(host_or_url: str) -> str:
    host = (urlparse(host_or_url if "://" in host_or_url else f"//{host_or_url}").hostname or "").lower().strip(".")
    host = host.removeprefix("www.")
    parts = host.split(".")
    if len(parts) <= 2:
        return host
    if ".".join(parts[-2:]) in MULTI_SUFFIXES:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


def is_social_or_platform(host_or_url: str) -> bool:
    d = registrable_domain(host_or_url)
    host = (urlparse(host_or_url if "://" in host_or_url else f"//{host_or_url}").hostname or "").lower()
    return d in SOCIAL_HOSTS or host in SOCIAL_HOSTS or any(host.endswith("." + s) for s in SOCIAL_HOSTS)


def norm_name(name: str) -> str:
    """Comparable form of a company name. NFKC folds full-width forms; legal-form words and punctuation are dropped.
    Deliberately keeps words like 'studio' and 'animation': two studios named 'Sky Studio' and 'Sky Games' must not merge."""
    s = unicodedata.normalize("NFKC", name or "").lower()
    s = COMPANY_WORDS.sub(" ", s)
    s = re.sub(r"[\s\-_・･·\.,'’\"()（）\[\]【】「」『』&/]+", "", s)
    return s


def looks_like_company(name: str) -> bool:
    return bool(COMPANY_WORDS.search(unicodedata.normalize("NFKC", name or "")))
