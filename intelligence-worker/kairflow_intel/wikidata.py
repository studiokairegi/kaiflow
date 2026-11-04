"""Studios with official websites from Wikidata (CC0). Entity-level discovery: no URL has to be supplied."""
from __future__ import annotations

import re

from .entity import is_social_or_platform

WDQS = "https://query.wikidata.org/sparql"
DEFAULT_CLASSES = ["animation studio", "anime studio", "animation production company"]
PAGE = 100
STUDIO_WORDS = re.compile(r"anim|anime|studio|production|アニメ|制作|スタジオ|プロダクション", re.I)


def studios_query(classes: list[str], limit: int = PAGE, offset: int = 0) -> str:
    values = " ".join(f'"{c.replace(chr(34), "")}"@en' for c in classes if re.fullmatch(r"[A-Za-z0-9 \-]{3,60}", c))
    return f"""SELECT ?item ?itemLabel ?ja ?site ?countryLabel WHERE {{
  VALUES ?clsLabel {{ {values} }}
  ?cls rdfs:label ?clsLabel .
  ?item wdt:P31 ?c . ?c wdt:P279? ?cls .
  ?item wdt:P856 ?site .
  FILTER NOT EXISTS {{ ?item wdt:P576 [] }}
  OPTIONAL {{ ?item wdt:P17 ?country . }}
  OPTIONAL {{ ?item rdfs:label ?ja . FILTER(LANG(?ja) = "ja") }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,ja". }}
}} ORDER BY ?item LIMIT {int(limit)} OFFSET {int(offset)}"""


def parse_studios(result: dict) -> list[dict]:
    out, seen = [], set()
    for b in (result.get("results") or {}).get("bindings", []):
        site = (b.get("site") or {}).get("value", "").strip()
        qid = (b.get("item") or {}).get("value", "")
        name = (b.get("itemLabel") or {}).get("value", "").strip()
        if not site.startswith(("http://", "https://")) or is_social_or_platform(site) or not name or re.fullmatch(r"Q\d+", name) or qid in seen:
            continue
        seen.add(qid)
        out.append({"name": name, "name_ja": (b.get("ja") or {}).get("value", ""), "website": site, "country": (b.get("countryLabel") or {}).get("value", ""),
                    "wikidata": qid, "meta": {"source": "wikidata", "wikidata": qid}})
    return out


def fetch_page(api, classes: list[str] | None = None, offset: int = 0) -> tuple[list[dict], int]:
    """(candidates, raw row count). The raw count tells the caller whether another page exists (parsing drops some rows)."""
    res = api.get_json(WDQS, {"query": studios_query(classes or DEFAULT_CLASSES, PAGE, offset), "format": "json"}, accept="application/sparql-results+json")
    return parse_studios(res), len(((res or {}).get("results") or {}).get("bindings", []))


def fetch_studios(api, classes: list[str] | None = None, offset: int = 0) -> list[dict]:
    return fetch_page(api, classes, offset)[0]


def lookup_website(api, name: str) -> dict | None:
    """Find a studio's official website from its name. Accepts a hit only if its description looks like a studio/production company."""
    if not name or len(name) < 3:
        return None
    s = api.get_json("https://www.wikidata.org/w/api.php", {"action": "wbsearchentities", "search": name[:100], "language": "en", "uselang": "en", "limit": 3, "format": "json"})
    for hit in s.get("search", []):
        label = (hit.get("label") or "").strip()
        if not STUDIO_WORDS.search(hit.get("description") or "") or not hit.get("id"):
            continue
        ent = api.get_json(f"https://www.wikidata.org/wiki/Special:EntityData/{hit['id']}.json")
        claims = (ent.get("entities", {}).get(hit["id"], {}).get("claims") or {}).get("P856") or []
        for c in claims:
            url = (((c.get("mainsnak") or {}).get("datavalue") or {}).get("value") or "").strip()
            if url.startswith(("http://", "https://")) and not is_social_or_platform(url):
                return {"name": label or name, "website": url, "wikidata": hit["id"]}
    return None
