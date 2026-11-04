"""Phase 0 feasibility spike. READ-ONLY and free: a handful of polite GET/POST queries to public data services, then a plain-language report.
It writes nothing to Supabase and needs no keys, accounts or Ollama. Run it once on your own computer:

    python spikes/phase0_feasibility.py            (from the intelligence-worker folder; needs: pip install requests)

It uses a descriptive User-Agent (set KAIRFLOW_CONTACT_URL to your studio website so the services can reach you). Total traffic is about
60 small requests, paced at the services' published limits. Share phase0_report.json (or the printed summary) so the plan can be tuned to real numbers.
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone
from urllib.parse import quote, urlparse
from urllib.robotparser import RobotFileParser

import requests

CONTACT = os.environ.get("KAIRFLOW_CONTACT_URL", "")
UA = f"KairFlowResearchBot/1.0 (phase0 spike{'; +' + CONTACT if CONTACT else ''})"
S = requests.Session()
S.headers["User-Agent"] = UA
report: dict = {"run_at": datetime.now(timezone.utc).isoformat(), "user_agent": UA}


def get(url, params=None, accept="application/json", timeout=70):
    time.sleep(2.0)
    return S.get(url, params=params, headers={"Accept": accept}, timeout=timeout)


def section(name, fn):
    print(f"\n== {name}")
    try:
        report[name] = fn()
    except Exception as exc:  # a failing source is a finding, not a crash
        report[name] = {"error": f"{type(exc).__name__}: {exc}"}
    print(json.dumps(report[name], ensure_ascii=False, indent=2)[:1800])


def wikidata():
    out = {}
    for label in ("animation studio", "anime studio", "animation production company"):
        q = f'''SELECT (COUNT(DISTINCT ?item) AS ?n) (COUNT(DISTINCT ?site) AS ?with_site) WHERE {{
          ?cls rdfs:label "{label}"@en . ?item wdt:P31 ?c . ?c wdt:P279? ?cls .
          OPTIONAL {{ ?item wdt:P856 ?site }} FILTER NOT EXISTS {{ ?item wdt:P576 [] }} }}'''
        r = get("https://query.wikidata.org/sparql", {"query": q, "format": "json"}, "application/sparql-results+json")
        b = r.json()["results"]["bindings"][0] if r.ok else {}
        out[label] = {"http": r.status_code, "studios": b.get("n", {}).get("value"), "with_official_website": b.get("with_site", {}).get("value")}
    q = '''SELECT ?item ?itemLabel ?site ?countryLabel WHERE { ?cls rdfs:label "animation studio"@en . ?item wdt:P31 ?c . ?c wdt:P279? ?cls . ?item wdt:P856 ?site .
        ?item wdt:P17 wd:Q17 . FILTER NOT EXISTS { ?item wdt:P576 [] } SERVICE wikibase:label { bd:serviceParam wikibase:language "en,ja". } } LIMIT 15'''
    r = get("https://query.wikidata.org/sparql", {"query": q, "format": "json"}, "application/sparql-results+json")
    rows = r.json()["results"]["bindings"] if r.ok else []
    out["japanese_sample"] = [{"name": x["itemLabel"]["value"], "site": x["site"]["value"]} for x in rows]
    report["_sample_sites"] = [x["site"] for x in out["japanese_sample"]]
    return out


def anilist():
    query = "query($s:MediaStatus){ Page(page:1, perPage:50){ media(type:ANIME, status:$s){ studios(isMain:true){ nodes{ id name isAnimationStudio } } } } }"
    out = {}
    for status in ("RELEASING", "NOT_YET_RELEASED"):
        time.sleep(2.0)
        r = S.post("https://graphql.anilist.co", json={"query": query, "variables": {"s": status}}, timeout=40)
        studios = {n["id"]: n["name"] for m in (r.json().get("data", {}).get("Page", {}).get("media") or []) for n in m["studios"]["nodes"] if n.get("isAnimationStudio")} if r.ok else {}
        out[status] = {"http": r.status_code, "distinct_animation_studios_on_first_50_shows": len(studios), "examples": list(studios.values())[:8]}
    return out


def gdelt():
    out = {}
    for name, q in (("english", '("animation studio" OR "anime studio") (hiring OR outsourcing OR recruitment) sourcelang:english'),
                    ("japanese", '(アニメーター募集 OR 原画募集 OR アニメ制作会社) sourcelang:japanese')):
        time.sleep(6.0)
        r = get("https://api.gdeltproject.org/api/v2/doc/doc", {"query": q, "mode": "artlist", "format": "json", "maxrecords": 25, "timespan": "14d", "sort": "datedesc"})
        try:
            arts = r.json().get("articles", [])
        except ValueError:
            arts = []
            out[name + "_note"] = "non-JSON answer (throttled or query rejected): " + r.text[:100]
        out[name] = {"http": r.status_code, "articles_in_14_days": len(arts), "titles": [a.get("title", "")[:90] for a in arts[:5]]}
    return out


def common_crawl():
    info = get("https://index.commoncrawl.org/collinfo.json").json()
    crawl = info[0]["id"]
    out = {"latest_crawl": crawl, "crawl_name": info[0].get("name")}
    sample = [urlparse(u).hostname for u in report.get("_sample_sites", [])[:5] if urlparse(u).hostname]
    out["recruit_like_pages_found_per_known_domain"] = {}
    for d in sample:
        r = get(f"https://index.commoncrawl.org/{crawl}-index", {"url": f"{d}/*", "output": "json", "limit": 50, "filter": "url:.*(recruit|saiyo|career|jobs?|採用|求人|募集).*", "fl": "url"}, timeout=90)
        out["recruit_like_pages_found_per_known_domain"][d] = len([l for l in r.text.splitlines() if l.startswith("{")]) if r.ok else f"http {r.status_code}"
    return out


def robots_and_sitemaps():
    out = {}
    for site in report.get("_sample_sites", [])[:15]:
        host = urlparse(site).hostname
        if not host:
            continue
        origin = f"{urlparse(site).scheme}://{host}"
        rp = RobotFileParser()
        try:
            time.sleep(2.0)
            r = S.get(origin + "/robots.txt", timeout=20)
            if r.status_code == 200:
                rp.parse(r.text.splitlines())
                maps = rp.site_maps() or []
                out[host] = {"robots": "present", "home_allowed": rp.can_fetch(UA, origin + "/"), "recruit_allowed": rp.can_fetch(UA, origin + "/recruit/"), "sitemaps_declared": len(maps)}
            else:
                out[host] = {"robots": f"http {r.status_code} (no rules)"}
        except requests.RequestException as exc:
            out[host] = {"robots": f"unreachable: {type(exc).__name__}"}
    return out


if __name__ == "__main__":
    print("KairFlow Intelligence, Phase 0 feasibility spike (read-only). Takes about 3 minutes.")
    section("wikidata", wikidata)
    section("anilist", anilist)
    section("gdelt", gdelt)
    section("common_crawl", common_crawl)
    section("robots_and_sitemaps", robots_and_sitemaps)
    report.pop("_sample_sites", None)
    with open("phase0_report.json", "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print("\nSaved phase0_report.json. Please share it so the discovery plan can be tuned to real numbers.")
