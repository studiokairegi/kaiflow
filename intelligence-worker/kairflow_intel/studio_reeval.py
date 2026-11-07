"""Targeted reevaluation of REJECTED, DISCOVERED animation-studio prospects with the studio-v2 model.

One job per prospect (kind 'reeval_studio', payload {run_id, prospect_id}) does everything in a single pass: recover a missing official website
(cautiously), re-read the site, store the new evidence under the run, score only from evidence collected after the run began, and record the
outcome. The handler never enqueues another job, so a reevaluation cannot reach CRM resolution, drafting or sending. All writes go through
intel_agent_reeval_* functions, which re-check run, type and origin in the database. indie_game_developer prospects are unreachable.

Nothing here reads or writes kill_switch, autonomy, caps or sending permissions."""
from __future__ import annotations

import hashlib
import json
import re
from urllib.parse import urlparse

from bs4 import BeautifulSoup

from . import classify_org, entity, research, wikidata
from .errors import PermanentError, RpcError, TransientError
from .safety import html_to_text

REEVAL_TYPE = "animation_studio_support"
REEVAL_ORIGIN = "discovered"
JOB_KIND = "reeval_studio"
DEFAULT_RUN_NAME = "studio-v2-rejected-animation-reeval"
MIN_TEXT_CHARS = 200            # less readable text than this is "unreadable or empty", not "a studio with no signals"
MAX_CANDIDATES = 3
GENERIC_LABELS = {"studio", "studios", "anime", "animation", "production", "productions", "films", "pictures", "works", "group", "company"}
STUDIO_WORDS = re.compile(r"anim|animation|アニメ|動画|作画|制作|スタジオ|映像|studio|production", re.I | re.U)


def _h(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()[:40]


def _rpc_ok(d, name, params):
    return d.rpc(name, params) or {}


# ---------------------------------------------------------------------------------------------------------------------
# Website recovery. Only ever for a prospect with NO website. Candidates come from places that already name the studio (domain aliases and
# source items stored by discovery, and an exact-name Wikidata hit). No search engine, no guessing of domains. A candidate is accepted only if
# the page itself says it is this studio. Anything ambiguous goes to a person.
# ---------------------------------------------------------------------------------------------------------------------
def _identity_strings(html: str, text: str) -> list[str]:
    soup = BeautifulSoup(html, "lxml")
    out: list[str] = []
    if soup.title and soup.title.string:
        out.append(soup.title.string)
    for m in soup.find_all("meta"):
        if (m.get("property") or m.get("name") or "").lower() in ("og:site_name", "og:title", "application-name") and m.get("content"):
            out.append(m["content"])
    out += [h.get_text(" ", strip=True) for h in soup.find_all(["h1"])][:3]
    for sc in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(sc.string or "")
        except ValueError:
            continue
        for node in (data if isinstance(data, list) else [data]):
            if isinstance(node, dict) and node.get("name") and str(node.get("@type", "")).lower() in ("organization", "corporation", "localbusiness", "website"):
                out.append(str(node["name"]))
    # Copyright/footer credits are not organization identity evidence.
    return [s for s in out if s]


def _name_forms(prospect: dict, name_aliases: list[str]) -> list[str]:
    forms = {entity.norm_name(prospect.get("name") or "")} | {entity.norm_name(a) for a in name_aliases or []}
    # too short a name matches half the internet; a CJK name carries more information per character
    keep = [f for f in forms if len(f) >= 5 or (len(f) >= 3 and re.search(r"[\u3040-\u30ff\u4e00-\u9fff]", f))]
    return sorted(keep, key=len, reverse=True)


def verify_candidate(d, url: str, names: list[str], method: str, prospect_name: str) -> dict:
    """{ok, ...}. ok only when the fetched page identifies itself as the prospect AND a second, independent cue agrees."""
    try:
        final, html = d.fetcher.fetch(url)
    except (PermanentError, TransientError) as exc:
        return {"ok": False, "url": url, "why": f"unreadable: {str(exc)[:80]}"}
    if entity.is_social_or_platform(final):
        return {"ok": False, "url": url, "why": "social or platform page"}
    text = html_to_text(html)
    host = urlparse(final).hostname or ""
    if classify_org.classify(text, prospect_name, host)["kind"] == "individual":
        return {"ok": False, "url": url, "why": "looks like an individual, not a studio"}
    if not STUDIO_WORDS.search(text):
        return {"ok": False, "url": url, "why": "no animation or studio wording"}
    identities = _identity_strings(html, text)
    hit = next(((n, s) for n in names for s in identities if n in entity.norm_name(s)), None)
    if not hit:
        return {"ok": False, "url": url, "why": "page does not identify itself as this studio"}
    label = entity.registrable_domain(final).split(".")[0]
    body = entity.norm_name(text)
    second = [cue for cue, good in (("domain_matches_name", len(label) >= 4 and label not in GENERIC_LABELS and (label in hit[0] or hit[0] in label)),
                                     ("name_repeated_in_body", body.count(hit[0]) >= 2),
                                     ("known_source", False)) if good]
    if not second:
        return {"ok": False, "url": url, "why": "only one identity cue; needs a second"}
    p = urlparse(final)
    return {"ok": True, "website": f"{p.scheme}://{p.netloc}", "final_url": final, "method": method, "matched": hit[1][:120], "cues": ["name_in_page_identity"] + second}


def _wikidata_candidate(d, name: str, names: list[str]) -> str | None:
    from . import discovery
    if d.api is None or "wikidata" not in (d.rpc("intel_agent_sources", {}) or {}) or not discovery._use(d, "wikidata"):
        return None
    try:
        hit = wikidata.lookup_website(d.api, name)
    except (TransientError, PermanentError):
        return None
    # lookup_website only checks the description; require the entity's own label to equal the prospect's name.
    return hit["website"] if hit and entity.norm_name(hit["name"]) in names else None


def recover_website(d, ctx: dict) -> dict:
    """{ok: True, website, method, ...} or {ok: False, reason, checked: [...]}. Never raises for 'nothing found'."""
    p = ctx["prospect"]
    names = _name_forms(p, ctx.get("name_aliases") or [])
    if not names:
        return {"ok": False, "reason": "name_too_short_to_verify", "checked": []}
    cands: list[tuple[str, str]] = []
    seen: set[str] = set()

    def add(url, method):
        dom = entity.registrable_domain(url)
        if dom and dom not in seen and not entity.is_social_or_platform(url) and urlparse(url if "://" in url else f"https://{url}").scheme in ("http", "https"):
            seen.add(dom)
            cands.append((url if "://" in url else f"https://{url}", method))

    for dom in ctx.get("domain_aliases") or []:
        add(dom, "domain_alias")
    for u in ctx.get("item_urls") or []:
        pu = urlparse(u)
        if pu.scheme in ("http", "https") and pu.netloc:
            add(f"{pu.scheme}://{pu.netloc}", "source_item")
    wd = _wikidata_candidate(d, p.get("name") or "", names)
    if wd:
        add(wd, "wikidata")
    checked, good = [], []
    for url, method in cands[:MAX_CANDIDATES]:
        v = verify_candidate(d, url, names, method, p.get("name") or "")
        checked.append({k: v[k] for k in ("url", "why", "ok") if k in v})
        if v["ok"]:
            good.append(v)
    if not cands:
        return {"ok": False, "reason": "no_candidate_source", "checked": []}
    if len({entity.registrable_domain(g["website"]) for g in good}) > 1:
        return {"ok": False, "reason": "ambiguous_candidates", "checked": checked}
    if not good:
        return {"ok": False, "reason": "no_candidate_verified", "checked": checked}
    return {"ok": True, **good[0], "checked": checked}


# ---------------------------------------------------------------------------------------------------------------------
# The job handler
# ---------------------------------------------------------------------------------------------------------------------
def _finish(d, run_id, pid, state, outcome, detail=None):
    d.rpc("intel_agent_reeval_finish_item", {"p_run_id": run_id, "p_prospect_id": pid, "p_state": state, "p_outcome": outcome, "p_detail": detail or {}})
    return {"state": state, "outcome": outcome}


def _skip_out_of_scope(d, run_id, pid, reason):
    reason = str(reason)
    # A terminal run or terminal/missing item must be a quiet no-op.
    # In particular, do not call another RPC after cancellation.
    if reason.startswith("run_") or reason in {
        "not_in_run", "item_not_queued", "prospect_not_found", "item_org_mismatch"
    }:
        return {"skipped": reason[:160]}

    # For an active run, the database rechecks eligibility and marks stale
    # queued items skipped. The database remains the authority.
    d.rpc("intel_agent_reeval_skip_item", {"p_run_id": run_id, "p_prospect_id": pid})
    return {"skipped": reason[:160]}


def _criteria(d, ptype):
    st = d.rpc("intel_agent_settings", {}) or {}
    return next((c.get("criteria") or {} for c in st.get("campaigns", []) if c.get("type") == ptype), {})


def h_reeval_studio(d, job):
    pl = job.get("payload") or {}
    run_id, pid = pl.get("run_id"), pl.get("prospect_id")
    if not run_id or not pid:
        raise PermanentError("reevaluation job needs run_id and prospect_id")
    try:
        return _reeval_one(d, job, str(run_id), str(pid))
    except RpcError as exc:
        message = str(exc)
        if "reevaluation refused:" in message:
            reason = message.split("reevaluation refused:", 1)[1].strip().splitlines()[0]
            scope_reasons = {
                "run_not_found", "run_cancelled", "run_completed",
                "not_in_run", "item_not_queued", "prospect_not_found",
                "item_org_mismatch", "out_of_scope_type", "out_of_scope_origin",
                "status_changed", "human_rejected", "prospect_linked",
                "prospect_contacted", "prospect_has_history", "prospect_suppressed",
            }
            if reason in scope_reasons:
                return _skip_out_of_scope(d, str(run_id), str(pid), reason)
        raise


def _reeval_one(d, job, run_id: str, pid: str):
    ctx = d.rpc("intel_agent_reeval_context", {"p_run_id": run_id, "p_prospect_id": pid})
    if not ctx:
        return {"skipped": "no context"}
    if ctx.get("out_of_scope"):
        return _skip_out_of_scope(d, str(run_id), str(pid), ctx["out_of_scope"])
    item, p, run = ctx["item"], ctx["prospect"], ctx["run"]
    if item["state"] != "queued":
        return {"skipped": f"already {item['state']}"}                      # repeated or duplicate job: harmless no-op
    if p.get("type") != REEVAL_TYPE or p.get("origin") != REEVAL_ORIGIN:
        return {"skipped": "out of scope"}                                  # defence in depth; the database refuses these too
    if p.get("status") != "rejected" or p.get("lead_id"):
        reason = "status_changed" if p.get("status") != "rejected" else "prospect_linked"
        return _skip_out_of_scope(d, run_id, pid, reason)
    final_attempt = int(job.get("attempts") or 1) >= int(job.get("max_attempts") or 5)
    stage = "recover"
    try:
        if not (p.get("website") or "").strip():
            rec = recover_website(d, ctx)
            if not rec["ok"]:
                return _finish(d, run_id, pid, "needs_manual", "website_not_recovered", {"reason": rec["reason"], "checked": rec.get("checked", [])})
            got = _rpc_ok(d, "intel_agent_reeval_set_website", {"p_run_id": run_id, "p_prospect_id": pid, "p_website": rec["website"],
                                                               "p_detail": {"method": rec["method"], "matched": rec["matched"], "cues": rec["cues"], "checked": rec.get("checked", [])}})
            if not got.get("ok"):
                return _finish(d, run_id, pid, "needs_manual", "website_not_recovered", {"reason": got.get("reason", "rejected"), "candidate": rec["website"]})
            d.rpc("intel_agent_reeval_add_evidence", {"p_run_id": run_id, "p_prospect_id": pid, "p_source": "website_recovery", "p_url": rec["final_url"], "p_fact_type": "website_recovery",
                                                      "p_snippet": f"{rec['matched']} ({rec['method']}; {', '.join(rec['cues'])})"[:300], "p_content_hash": _h(rec["final_url"]), "p_verified": True})
            p = {**p, "website": rec["website"], "domain": entity.registrable_domain(rec["website"])}
        llm = lambda text: d.llm.generate_json(research.ENTITY_INSTRUCTION, text, research.ENTITY_SCHEMA, fast=True)
        stage = "research"
        out = research.research(d.rpc, d.fetcher, llm, {"prospect": p}, run_id=run_id)
        stage = "score"
        if out["text_chars"] < MIN_TEXT_CHARS:
            return _finish(d, run_id, pid, "needs_manual", "site_unreadable_or_empty", {"pages": out["pages"], "text_chars": out["text_chars"]})
        fresh = d.rpc("intel_agent_reeval_context", {"p_run_id": run_id, "p_prospect_id": pid}) or {}
        if fresh.get("out_of_scope"):
            return _skip_out_of_scope(d, run_id, pid, fresh["out_of_scope"])
        res = research.qualify(d.rpc, {"prospect": fresh["prospect"], "evidence": fresh["evidence"]}, _criteria(d, REEVAL_TYPE),
                               reeval=research.ReevalScope(run_id=run_id, started_at=run["started_at"]))
        if res.write.get("ok") is False:
            return {"skipped": res.write.get("reason", "not written")}
        return {"decision": res.decision, "score": res.score, "status": res.write.get("status"), "already": res.write.get("already"), "pages": out["pages"], "signals": out["signals"]}
    except PermanentError as exc:                                           # research stage: robots refusal, 4xx, bad redirect = the site cannot be read
        return _finish(d, run_id, pid, "needs_manual", "site_unreadable" if stage == "research" else "permanent_error", {"error": str(exc)[:200], "stage": stage})
    except TransientError as exc:
        if final_attempt:                                                   # retries used up: record it instead of dying silently
            return _finish(d, run_id, pid, "failed", "transient_retries_exhausted", {"error": str(exc)[:200]})
        raise


# ---------------------------------------------------------------------------------------------------------------------
# Command line: python -m kairflow_intel reeval-studio preview | start | status | cancel
# ---------------------------------------------------------------------------------------------------------------------
USAGE = ("usage: reeval-studio preview\n"
         "       reeval-studio start [--name NAME] (--limit N | --all --expect COUNT) [--include-previous]\n"
         "       reeval-studio status [RUN_ID]\n"
         "       reeval-studio cancel RUN_ID")


def cli(rpc, argv: list[str], out=print) -> int:
    cmd, rest = (argv[0] if argv else ""), argv[1:]

    def opt(flag, default=None):
        return rest[rest.index(flag) + 1] if flag in rest and rest.index(flag) + 1 < len(rest) else default
    if cmd == "preview":
        out(json.dumps(rpc("intel_agent_reeval_start", {"p_name": DEFAULT_RUN_NAME, "p_limit": None, "p_dry_run": True, "p_include_previous": "--include-previous" in rest, "p_all": False, "p_expect_count": None}), indent=2))
        return 0
    if cmd == "start":
        name, limit, everything = opt("--name", DEFAULT_RUN_NAME), opt("--limit"), "--all" in rest
        if everything == (limit is not None) or (limit is not None and not str(limit).isdigit()) or (limit is not None and int(limit) < 1):
            out("refusing: give exactly one of --limit N (a pilot) or --all --expect COUNT\n" + USAGE)
            return 2
        include_prev = "--include-previous" in rest
        pre = rpc("intel_agent_reeval_start", {"p_name": name, "p_limit": None, "p_dry_run": True, "p_include_previous": include_prev, "p_all": False, "p_expect_count": None})
        if everything and str(opt("--expect")) != str(pre["eligible"]):
            out(f"refusing: --expect must equal the eligible count ({pre['eligible']}); run 'preview' and check it first")
            return 2
        out(json.dumps(rpc("intel_agent_reeval_start", {"p_name": name, "p_limit": int(limit) if limit is not None else None, "p_dry_run": False, "p_include_previous": include_prev, "p_all": everything, "p_expect_count": pre["eligible"] if everything else None}), indent=2, default=str))
        return 0
    if cmd == "status":
        out(json.dumps(rpc("intel_agent_reeval_status", {"p_run_id": rest[0] if rest else None}), indent=2, default=str))
        return 0
    if cmd == "cancel" and rest:
        out(json.dumps(rpc("intel_agent_reeval_cancel", {"p_run_id": rest[0]}), indent=2))
        return 0
    out(USAGE)
    return 2
