"""Seven-phase roadmap, Phase 7: run the validation matrix and print what actually happened.

Maps each Phase 7 task to the automated tests that cover it, runs them, and reports REAL counts. Tasks that can only be checked against a live
system (shadow mode, real Gemini, real mailbox, production metrics) are listed as NOT RUN with the owner step that closes them; this script
never pretends a mocked test is a live validation, and it never contacts the network, a database or a mail provider.

    python scripts/phase7_validation.py                 # from intelligence-worker/ : the matrix (about 20 s)
    python scripts/phase7_validation.py --full          # also the two complete suites (Python worker + Node app)
    python scripts/phase7_validation.py --controller    # also scripts/controller_acceptance.py (real local processes, POSIX, ~2 min)
    python scripts/phase7_validation.py --json out.json # machine-readable copy

Exit status is 0 only if every test that was run passed.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

WORKER = Path(__file__).resolve().parents[1]
REPO = WORKER.parent

# (roadmap task, what it proves, python test modules, node test files relative to the repo root, kind of evidence)
MATRIX = [
    ("1", "Integration across Agent Chat, providers, controller, worker, discovery, CRM and Inbox",
     ["test_phase7_integration", "test_chat_fixes", "test_phase3_chat_knowledge", "test_proposals", "test_emma_actions", "test_discovery",
      "test_phase3_discovery_routing", "test_phase4_research_routing", "test_phase5_drafting_routing", "test_phase5_research_report",
      "test_phase6_routing", "test_qualification_review", "test_studio_reevaluation_phase6", "test_takeover", "test_multi_account_sync_audit",
      "test_delivery_events"],
     ["src/intelligence/emma-shared-chat.test.mjs", "src/intelligence/lead-email-sync.test.mjs", "src/intelligence/intel-resend-webhook.test.mjs",
      "src/intelligence/conversation.test.mjs", "src/intelligence/indie-qualification-v2-contract.test.mjs"],
     "mocked providers, fake RPC, source-level"),
    ("2", "Gemini success and every important fallback scenario",
     ["test_gemini", "test_ai_router", "test_provider_router", "test_phase2_provider_infra", "test_phase2_audit_fixes", "test_phase2_fixes",
      "test_ollama_preflight", "test_phase7_integration"],
     [], "mocked HTTP; no real Gemini request"),
    ("3", "Job retries, worker restarts, duplicate prevention and recovery",
     ["test_phase4_job_reliability", "test_worker_lock", "test_controller", "test_controller_audit", "test_controller_shutdown",
      "test_phase7_production_validation"],
     [], "mocked database; the controller tests use the real controller code"),
    ("4", "Permissions, organization boundaries, suppression and email approval controls",
     ["test_phase7_production_validation", "test_contactability", "test_campaign_followup_send_cap_migration", "test_mail_paused", "test_safety",
      "test_phase3_bugfixes", "test_indie_campaign_audit_fixes", "test_resend", "test_smtp_adapter", "test_gmail", "test_zoho"],
     ["src/intelligence/intelligence-authorization.test.mjs", "src/intelligence/legacy-mailbox-removal.test.mjs"],
     "source-level over the migrations and code; SQL is never executed"),
    ("5", "Provider quotas, usage budgets and operational limits",
     ["test_phase2_provider_infra", "test_ai_router", "test_phase13_capacity", "test_qualification_review", "test_safety"],
     [], "mocked clocks and counters"),
]

NOT_RUN = [
    ("6", "Run prospect discovery in shadow mode", "Owner: start the worker with sending OFF, run discovery, then SHADOW_MODE_METRICS.sql queries 6-9."),
    ("7", "Review actual prospect quality and research accuracy", "Owner: label the 20-report sample from query 9b (method in PRODUCTION_READINESS_REPORT.md)."),
    ("8", "Draft-only outreach tests without sending", "Owner: generate drafts for approved test prospects; query 10 and 11 must show drafts and no sent rows."),
    ("9", "Validate inbound replies and conversation synchronization", "Owner: send yourself a reply to a test thread, then query 12 / 12b."),
    ("10", "Review execution logs and provider attribution", "Owner: queries 3 and 14, plus the Logs view in the app."),
    ("11", "Measure operational performance and remaining bottlenecks", "Owner: queries 2, 4, 5 and 15 after at least a week of shadow running."),
    ("12", "Limited production workloads after the owner approves the rollout", "Blocked by design until the owner approves a stage in PRODUCTION_ROLLOUT_PLAN.md."),
]


def run_unittest(modules: list[str]) -> dict:
    mods = [f"tests.{m}" for m in dict.fromkeys(modules)]
    started = time.time()
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    p = subprocess.run([sys.executable, "-m", "unittest", *mods], cwd=WORKER, capture_output=True, text=True, env=env, timeout=900)
    out = p.stderr + p.stdout
    ran = re.search(r"Ran (\d+) tests? in", out)
    failed = re.search(r"FAILED \((.*?)\)", out)
    return {"runner": "python unittest", "modules": len(mods), "ran": int(ran.group(1)) if ran else 0, "ok": p.returncode == 0 and bool(ran),
            "detail": failed.group(1) if failed else "", "seconds": round(time.time() - started, 1), "tail": out.strip().splitlines()[-6:]}


def run_node(files: list[str]) -> dict:
    started = time.time()
    p = subprocess.run(["node", "--experimental-strip-types", "--test", *files] if files else ["node", "--experimental-strip-types", "--test"],
                       cwd=REPO, capture_output=True, text=True, timeout=1800)
    out = p.stdout + p.stderr

    def num(name):
        m = re.search(rf"(?m)^[ℹ#]\s*{name}\s+(\d+)", out)
        return int(m.group(1)) if m else 0
    return {"runner": "node --test", "files": len(files) or "all", "ran": num("tests"), "passed": num("pass"), "failed": num("fail"),
            "ok": p.returncode == 0 and num("tests") > 0, "seconds": round(time.time() - started, 1), "tail": out.strip().splitlines()[-8:]}


def run_controller_acceptance() -> dict:
    started = time.time()
    if os.name != "posix":
        return {"runner": "controller_acceptance.py", "ok": False, "detail": "POSIX only", "seconds": 0, "tail": []}
    p = subprocess.run([sys.executable, "scripts/controller_acceptance.py"], cwd=WORKER, capture_output=True, text=True, timeout=900,
                       env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))
    m = re.search(r"(\d+)/(\d+) checks passed", p.stdout)
    return {"runner": "controller_acceptance.py", "ran": int(m.group(2)) if m else 0, "passed": int(m.group(1)) if m else 0,
            "ok": p.returncode == 0 and bool(m) and m.group(1) == m.group(2), "seconds": round(time.time() - started, 1),
            "tail": p.stdout.strip().splitlines()[-3:]}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--full", action="store_true", help="also run the complete Python worker suite and the complete Node suite")
    ap.add_argument("--controller", action="store_true", help="also run scripts/controller_acceptance.py")
    ap.add_argument("--json", metavar="PATH", help="write the results as JSON")
    args = ap.parse_args(argv)

    results, all_ok = [], True
    print("PHASE 7 VALIDATION MATRIX (offline: no network, no database, no mail provider, no real model call)\n")
    for task, title, py, js, evidence in MATRIX:
        r = {"task": task, "title": title, "evidence": evidence, "python": run_unittest(py)}
        if js:
            r["node"] = run_node(js)
        ok = r["python"]["ok"] and r.get("node", {"ok": True})["ok"]
        all_ok &= ok
        node_txt = f" + node {r['node']['passed']}/{r['node']['ran']}" if "node" in r else ""
        print(f"[{'PASS' if ok else 'FAIL'}] task {task}: {title}\n       python {r['python']['ran']} tests{node_txt}  ({evidence})")
        if not ok:
            for line in r["python"]["tail"] + r.get("node", {}).get("tail", []):
                print("       |", line)
        results.append(r)

    extra = {}
    if args.full:
        extra["python_full"] = run_unittest([p.stem for p in sorted((WORKER / "tests").glob("test_*.py"))])
        extra["node_full"] = run_node([])
        for k, v in extra.items():
            all_ok &= v["ok"]
            print(f"[{'PASS' if v['ok'] else 'FAIL'}] {k}: {v['ran']} tests in {v['seconds']} s")
    if args.controller:
        extra["controller_acceptance"] = run_controller_acceptance()
        v = extra["controller_acceptance"]
        all_ok &= v["ok"]
        print(f"[{'PASS' if v['ok'] else 'FAIL'}] controller_acceptance: {v.get('passed', 0)}/{v.get('ran', 0)} local-process checks in {v['seconds']} s")

    print("\nNOT RUN - these need a live system or the owner's approval:")
    for task, title, step in NOT_RUN:
        print(f"[NOT RUN] task {task}: {title}\n          {step}")
    print("\nOverall (of what was run): " + ("ALL PASSED" if all_ok else "FAILURES PRESENT"))
    print("Production readiness: NOT ESTABLISHED by this script; see PRODUCTION_READINESS_REPORT.md.")

    if args.json:
        Path(args.json).write_text(json.dumps({"matrix": results, "extra": extra, "not_run": [{"task": t, "title": ti, "owner_step": s} for t, ti, s in NOT_RUN],
                                               "all_run_passed": all_ok}, indent=2), encoding="utf-8")
    return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
