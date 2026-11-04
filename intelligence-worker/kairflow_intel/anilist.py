"""Studios behind anime that are airing or announced (an 'active production' signal). AniList gives names, not company websites."""
from __future__ import annotations

ENDPOINT = "https://graphql.anilist.co"
QUERY = """query($page:Int,$status:MediaStatus){ Page(page:$page, perPage:50){ pageInfo{ hasNextPage }
  media(type:ANIME, status:$status, sort:POPULARITY_DESC){ id title{ romaji native }
    studios(isMain:true){ nodes{ id name isAnimationStudio } } } } }"""


def parse_page(data: dict) -> tuple[list[dict], bool]:
    page = ((data or {}).get("data") or {}).get("Page") or {}
    studios: dict[int, dict] = {}
    for m in page.get("media") or []:
        title = ((m.get("title") or {}).get("romaji") or "")
        for n in ((m.get("studios") or {}).get("nodes") or []):
            if n.get("isAnimationStudio") and n.get("id") and n.get("name"):
                s = studios.setdefault(n["id"], {"name": n["name"], "website": "", "meta": {"source": "anilist", "anilist_id": n["id"], "titles": []}})
                if title and len(s["meta"]["titles"]) < 5:
                    s["meta"]["titles"].append(title)
    return list(studios.values()), bool((page.get("pageInfo") or {}).get("hasNextPage"))


def fetch_studios(api, status: str = "RELEASING", pages: int = 3) -> list[dict]:
    out: dict[int, dict] = {}
    for p in range(1, pages + 1):
        res = api.post_json(ENDPOINT, {"query": QUERY, "variables": {"page": p, "status": status}})
        found, more = parse_page(res)
        for s in found:
            out.setdefault(s["meta"]["anilist_id"], s)
        if not more:
            break
    return list(out.values())
