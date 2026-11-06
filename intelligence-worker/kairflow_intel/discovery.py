"""Autonomous discovery job handlers. Every handler checks the source registry first (enabled, terms confirmed, budget, circuit) and reports
success or failure back so a broken source stops itself instead of hammering a service."""
from __future__ import annotations

import time

from . import anilist, commoncrawl, entity, feeds, gdelt, manual_post, profile, signals, siteanalysis, wikidata
from .errors import PermanentError, TransientError
from .safety import norm

ITEM_SOURCE = {"credit_link": "site_crawler"}
NEWS_SCHEMA = {"type": "object", "required": ["items"], "properties": {"items": {"type": "array", "items": {"type": "object", "required": ["index", "organization"],
               "properties": {"index": {"type": "integer", "minimum": 0, "maximum": 99}, "organization": {"type": ["string", "null"], "maxLength": 100}}}}}}
NEWS_INSTRUCTION = ("Each numbered line is a news headline. For each, give the animation studio or production company it is about, exactly as written in the headline, "
                    "or null if none is named. Do not guess.")


def _enq(d, kind, payload, key, delay=0):
    run_after = None if not delay else time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(d.clock() + delay))
    return d.rpc("intel_agent_enqueue_job", {"p_kind": kind, "p_payload": payload, "p_idempotency_key": key, "p_run_after": run_after, "p_priority": 0})


def _week(d):
    return time.strftime("%G-W%V", time.gmtime(d.clock()))


def _criteria(d, ptype):
    st = d.rpc("intel_agent_settings", {})
    return next((c["criteria"] for c in st["campaigns"] if c["type"] == ptype), {})


def _report(d, key, ok, err=""):
    d.rpc("intel_agent_source_report", {"p_key": key, "p_ok": ok, "p_error": str(err)[:250]})


def _use(d, key, n=1) -> bool:
    return int(d.rpc("intel_agent_source_use", {"p_key": key, "p_n": n}) or 0) > 0


def ingest(d, ptype: str, cand: dict, via: str) -> tuple[str | None, bool]:
    """Turn a discovered organization into (prospect id, was it newly created). One studio found under several names or domains stays ONE prospect."""
    website = (cand.get("website") or "").strip()
    usable = bool(website) and not entity.is_social_or_platform(website)
    domain = entity.registrable_domain(website) if usable else ""
    name = (cand.get("name") or "").strip()[:200]
    if not name and not domain:
        return None, False
    nn = entity.norm_name(name)
    src = ITEM_SOURCE.get(via, via)
    hit = d.rpc("intel_agent_resolve_entity", {"p_domain": domain, "p_name_norm": nn}) or {}
    if hit.get("prospect_id"):
        pid = hit["prospect_id"]
        if domain and hit.get("match") not in ("domain", "domain_alias"):
            d.rpc("intel_agent_add_alias", {"p_prospect_id": pid, "p_kind": "domain", "p_value": domain})
        if nn and hit.get("match") != "name":
            d.rpc("intel_agent_add_alias", {"p_prospect_id": pid, "p_kind": "name", "p_value": nn})
        d.rpc("intel_agent_record_item", {"p_source": src, "p_type": "studio_entity", "p_url": website or "", "p_title": name, "p_snippet": "", "p_language": "", "p_prospect_id": pid, "p_meta": cand.get("meta") or {}})
        return pid, False
    raw_language = (cand.get("meta") or {}).get("language")
    language = raw_language if raw_language in ("en", "ja") else "other"
    res = d.rpc("intel_agent_upsert_prospect", {"p_type": ptype, "p_name": name or domain, "p_website": website if usable else "", "p_contact_name": "", "p_contact_email": "",
                                                "p_contact_source_url": "", "p_country": cand.get("country", ""), "p_language": language,
                                                "p_verified": {**(cand.get("meta") or {}), "discovered_via": via}})
    pid = res["prospect_id"]
    if nn:
        d.rpc("intel_agent_add_alias", {"p_prospect_id": pid, "p_kind": "name", "p_value": nn})
    if cand.get("name_ja"):
        d.rpc("intel_agent_add_alias", {"p_prospect_id": pid, "p_kind": "name", "p_value": entity.norm_name(cand["name_ja"])})
    if domain:
        d.rpc("intel_agent_add_alias", {"p_prospect_id": pid, "p_kind": "domain", "p_value": domain})
    d.rpc("intel_agent_record_item", {"p_source": src, "p_type": "studio_entity", "p_url": website if usable else "", "p_title": name, "p_snippet": "", "p_language": "", "p_prospect_id": pid, "p_meta": cand.get("meta") or {}})
    if not res.get("created") or res.get("suppressed"):
        return pid, False
    if usable:
        _enq(d, "research", {"prospect_id": pid}, f"research:{pid}")
    else:
        d.rpc("intel_agent_flag_prospect", {"p_prospect_id": pid, "p_reason": "official website not found; add it or reject"})
    return pid, True


def _site_for(d, avail, name):
    if "wikidata" not in avail or not _use(d, "wikidata"):
        return None
    try:
        return wikidata.lookup_website(d.api, name)
    except (TransientError, PermanentError):
        return None


def h_seed_sources(d, job):
    ptype = (job["payload"] or {}).get("type", "animation_studio_support")
    avail, crit, out = d.rpc("intel_agent_sources", {}) or {}, _criteria(d, ptype), {}
    if "wikidata" in avail and _use(d, "wikidata"):
        offset = int(job["payload"].get("offset", 0))
        try:
            studios, raw = wikidata.fetch_page(d.api, crit.get("wikidata_classes"), offset)
            _report(d, "wikidata", True)
        except (TransientError, PermanentError) as exc:
            _report(d, "wikidata", False, exc)
            raise
        new = sum(1 for s in studios if ingest(d, ptype, s, "wikidata")[1])
        out["wikidata"] = {"rows": raw, "new": new}
        if raw >= wikidata.PAGE and offset < 3000:
            _enq(d, "seed_sources", {"type": ptype, "offset": offset + wikidata.PAGE}, f"seed:wikidata:{offset + wikidata.PAGE}:{_week(d)}", delay=90)
    if "anilist" in avail and _use(d, "anilist", 2):
        try:
            studios = anilist.fetch_studios(d.api, "RELEASING", 2) + anilist.fetch_studios(d.api, "NOT_YET_RELEASED", 1)
            _report(d, "anilist", True)
        except (TransientError, PermanentError) as exc:
            _report(d, "anilist", False, exc)
            studios = []
        new = 0
        for s in studios[:60]:
            hit = _site_for(d, avail, s["name"])
            if hit:
                s = {**s, "website": hit["website"], "meta": {**s["meta"], "wikidata": hit["wikidata"]}}
            new += 1 if ingest(d, ptype, s, "anilist")[1] else 0
        out["anilist"] = {"studios": len(studios), "new": new}
    return out or {"skipped": "no source available (disabled, terms unconfirmed, over budget or circuit open)"}


def h_analyze_site(d, job):
    pid = job["payload"]["prospect_id"]
    ctx = d.rpc("intel_agent_context", {"p_prospect_id": pid})
    if not ctx or ctx["prospect"]["status"] not in ("discovered", "researched"):
        return {"skipped": "not analyzable"}
    avail = d.rpc("intel_agent_sources", {}) or {}
    out = {}
    if "site_crawler" in avail and _use(d, "site_crawler", 3):
        try:
            out = siteanalysis.analyze(d, ctx)
        except PermanentError as exc:
            d.rpc("intel_agent_flag_prospect", {"p_prospect_id": pid, "p_reason": f"site could not be read: {exc}"[:280]})
            return {"unreadable": str(exc)[:120]}
    d.rpc("intel_agent_enqueue_job", {"p_kind": "qualify", "p_payload": {"prospect_id": pid}, "p_idempotency_key": f"qualify:{pid}", "p_run_after": None, "p_priority": 0})
    return out


def h_news_scan(d, job):
    ptype = "animation_studio_support"
    avail, crit = d.rpc("intel_agent_sources", {}) or {}, _criteria(d, ptype)
    terms = profile.approved_terms(crit)
    if "gdelt" not in avail or not terms:
        return {"skipped": "GDELT unavailable or the discovery profile is not approved"}
    n_new = 0
    for lang, q in gdelt.build_queries(profile.clean(terms["terms_en"]), profile.clean(terms["terms_ja"])):
        if not _use(d, "gdelt"):
            break
        try:
            arts = gdelt.fetch_articles(d.api, q)[:15]
            _report(d, "gdelt", True)
        except (TransientError, PermanentError) as exc:
            _report(d, "gdelt", False, exc)
            raise
        if not arts:
            continue
        found = d.llm.generate_json(NEWS_INSTRUCTION, "\n".join(f"{i}. {a['title']}" for i, a in enumerate(arts)), NEWS_SCHEMA, fast=True)
        for it in found["items"]:
            if not (0 <= it["index"] < len(arts)):
                continue
            a, org = arts[it["index"]], (it.get("organization") or "").strip()
            if not org or norm(org) not in norm(a["title"]):
                continue              # the model must quote the headline; otherwise it is ignored
            hit = _site_for(d, avail, org)
            pid = None
            if hit:
                pid, created = ingest(d, ptype, {"name": hit["name"], "website": hit["website"], "meta": {"source": "gdelt", "wikidata": hit["wikidata"]}}, "gdelt")
                n_new += 1 if created else 0
            d.rpc("intel_agent_record_item", {"p_source": "gdelt", "p_type": "news", "p_url": a["url"], "p_title": a["title"], "p_snippet": org, "p_language": lang, "p_prospect_id": pid,
                                              "p_meta": {"domain": a["domain"], "seen": a["seen"], "attribution": gdelt.ATTRIBUTION}})
    return {"new": n_new}


def h_feed_poll(d, job):
    avail = d.rpc("intel_agent_sources", {}) or {}
    if "rss" not in avail:
        return {"skipped": "rss unavailable"}
    hits = 0
    for f in d.rpc("intel_agent_feeds", {"p_limit": 30}) or []:
        if not _use(d, "rss"):
            break
        try:
            _, xml = d.fetcher.fetch(f["url"])
        except (PermanentError, TransientError):
            continue
        ctx = d.rpc("intel_agent_context", {"p_prospect_id": f["prospect_id"]})
        if not ctx:
            continue
        table = signals.INDIE if ctx["prospect"]["type"] == "indie_game_developer" else signals.STUDIO
        for e in feeds.parse_feed(xml):
            found = signals.detect(f"{e['title']}. {e['summary']}", table)
            if not found or not e["link"]:
                continue
            for sig, sent in found.items():
                d.rpc("intel_agent_add_evidence", {"p_prospect_id": f["prospect_id"], "p_source": "rss", "p_url": e["link"], "p_fact_type": sig, "p_snippet": sent, "p_content_hash": norm(sent)[:40], "p_verified": True})
            r = d.rpc("intel_agent_record_item", {"p_source": "rss", "p_type": "feed_entry", "p_url": e["link"], "p_title": e["title"], "p_snippet": e["summary"][:500], "p_language": "", "p_prospect_id": f["prospect_id"], "p_meta": {"date": e["date"]}})
            if r.get("new"):
                hits += 1
                _enq(d, "qualify", {"prospect_id": f["prospect_id"]}, f"qualify:{f['prospect_id']}:{int(d.clock() // 86400)}")
    return {"new_entries": hits}


def h_crawl_index(d, job):
    avail = d.rpc("intel_agent_sources", {}) or {}
    if "commoncrawl" not in avail or not _use(d, "commoncrawl"):
        return {"skipped": "commoncrawl unavailable"}
    try:
        crawl = commoncrawl.latest_crawl(d.api)
        _report(d, "commoncrawl", True)
    except (TransientError, PermanentError) as exc:
        _report(d, "commoncrawl", False, exc)
        raise
    found = 0
    for k in d.rpc("intel_agent_known_domains", {"p_limit": 25}) or []:
        if not crawl or not _use(d, "commoncrawl"):
            break
        try:
            rows = commoncrawl.recruit_pages(d.api, crawl, k["domain"])
        except (TransientError, PermanentError):
            continue
        for r in rows[:10]:
            d.rpc("intel_agent_record_item", {"p_source": "commoncrawl", "p_type": "recruit_page", "p_url": r["url"], "p_title": "archived page", "p_snippet": "", "p_language": "", "p_prospect_id": k["prospect_id"], "p_meta": {"crawl": crawl, "timestamp": r.get("timestamp", "")}})
            found += 1
        if rows:
            _enq(d, "analyze_site", {"prospect_id": k["prospect_id"]}, f"analyze:{k['prospect_id']}:{crawl}")
    return {"crawl": crawl, "pages": found}


def h_manual_post(d, job):
    item = d.rpc("intel_agent_item", {"p_item_id": job["payload"]["item_id"]})
    if not item:
        raise PermanentError("post not found")
    llm = lambda text: d.llm.generate_json(manual_post.INSTRUCTION, text, manual_post.SCHEMA, fast=True)
    return manual_post.analyze(d, item, job["payload"].get("type", "animation_studio_support"), llm, d.api)


def h_profile_terms(d, job):
    ptype = job["payload"].get("type", "animation_studio_support")
    desc = ((_criteria(d, ptype).get("profile") or {}).get("description") or "").strip()
    base = profile.DEFAULT_TERMS[ptype]
    try:
        out = d.llm.generate_json(profile.INSTRUCTION, desc or "animation studios that outsource work", profile.SCHEMA, fast=False)
        terms = {"terms_en": profile.clean(out["terms_en"]), "terms_ja": profile.clean(out["terms_ja"]), "exclude": profile.clean(out["exclude"])}
        if not terms["terms_en"] and not terms["terms_ja"]:
            raise TransientError("empty proposal")
    except (TransientError, PermanentError):
        terms = base                                 # model unavailable: the built-in starter terms (still need your approval)
    d.rpc("intel_agent_propose_terms", {"p_type": ptype, "p_terms_en": terms["terms_en"], "p_terms_ja": terms["terms_ja"], "p_exclude": terms["exclude"]})
    return {"proposed": True}
