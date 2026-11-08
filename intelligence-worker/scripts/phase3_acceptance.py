"""Opt-in live acceptance for a real Andraft initial-outreach draft.

This script is intentionally not run by the worker. It never sends mail. It creates a
real draft only when --create-draft is supplied and verifies the persisted row via
intel_agent_context. Run from intelligence-worker with the same environment as Emma.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from pathlib import Path

# Allow `python scripts/phase3_acceptance.py` from the worker directory.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from kairflow_intel import config as cfgmod, jobs  # noqa: E402
from kairflow_intel.mail_disabled import DisabledMail  # noqa: E402
from kairflow_intel.ollama import OllamaClient  # noqa: E402
from kairflow_intel.safety import Fetcher  # noqa: E402
from kairflow_intel.supa import SupabaseAgent  # noqa: E402


def fail(message: str) -> int:
    print(f"FAIL {message}", file=sys.stderr)
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify Phase 3 against a real Andraft prospect; never sends email.")
    parser.add_argument("--prospect-id", required=True, help="Exact UUID copied from the Andraft prospect record")
    parser.add_argument("--create-draft", action="store_true", help="Explicitly authorize creating a pending-review draft if none exists")
    parser.add_argument("--env-file", default=os.environ.get("KAIRFLOW_WORKER_ENV_FILE"), help="Optional private worker.env path")
    args = parser.parse_args()

    try:
        env = os.environ.copy()
        if args.env_file:
            import importlib.util
            controller_path = Path(__file__).resolve().parents[1] / "controller.py"
            spec = importlib.util.spec_from_file_location("kairflow_acceptance_controller", controller_path)
            controller = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(controller)
            env.update(controller.read_env_file(Path(args.env_file)))
        cfg = cfgmod.load(env)
        supa = SupabaseAgent(cfg)
        llm = OllamaClient(cfg)
        if not llm.is_up():
            return fail("Ollama is not reachable at the configured loopback URL")
        installed = set(llm.list_models())
        missing = [name for name in {cfg.ollama_model, cfg.ollama_fast_model} if name not in installed]
        if missing:
            return fail("Ollama models missing: " + ", ".join(sorted(missing)))
        schema = {"type": "object", "required": ["ok"], "properties": {"ok": {"type": "boolean"}}}
        for model, fast in ((cfg.ollama_model, False), (cfg.ollama_fast_model, True)):
            out = llm.generate_json("Return exactly {\"ok\":true}.", "health check only", schema, fast=fast, timeout=120)
            if out.get("ok") is not True:
                return fail(f"Ollama structured-output probe failed for {model}")
        print("PASS Ollama main and fast models respond with schema-valid JSON")

        settings_before = supa.rpc("intel_agent_settings", {})
        # Probe the 11-argument function without writing: an impossible prospect ID must
        # fail at prospect lookup. PGRST202 means the migration/signature is not deployed.
        from kairflow_intel.errors import RpcError
        try:
            supa.rpc("intel_agent_upsert_draft", {
                "p_prospect_id": str(uuid.uuid4()), "p_kind": "initial", "p_step": 0,
                "p_subject": "", "p_body": "", "p_idempotency_key": "preflight:no-write",
                "p_to_email": "", "p_auto_ok": False, "p_in_reply_to": None,
                "p_references": None, "p_force_review": True,
            })
            return fail("draft RPC probe unexpectedly returned; expected missing-prospect guard")
        except RpcError as exc:
            if "prospect not found" not in str(exc).lower():
                return fail(f"draft RPC signature/migration not confirmed ({exc.code}): {exc}")
        print("PASS deployed draft RPC accepts p_force_review; probe wrote no record")

        calls: list[tuple[str, dict]] = []
        def rpc(name: str, params: dict | None = None):
            params = params or {}
            calls.append((name, params))
            return supa.rpc(name, params)

        deps = jobs.Deps(cfg=cfg, rpc=rpc, fetcher=Fetcher(cfg), zoho=DisabledMail(), llm=llm)
        context = rpc("intel_agent_context", {"p_prospect_id": args.prospect_id})
        prospect = (context or {}).get("prospect") or {}
        if str(prospect.get("name", "")).strip().casefold() != "andraft":
            return fail(f"prospect UUID does not resolve to exact Andraft (got {prospect.get('name')!r})")
        if prospect.get("status") != "lead_linked":
            return fail(f"Andraft must be lead_linked for initial outreach (current: {prospect.get('status')!r})")
        if not prospect.get("contact_email"):
            return fail("Andraft has no verified contact email; refusing to create a draft")
        idem = f"draft:{args.prospect_id}:initial"
        existing = [m for m in context.get("messages", []) if m.get("direction") == "outbound" and m.get("idempotency_key") == idem]
        if not existing and not args.create_draft:
            return fail("No initial draft exists. Re-run with --create-draft to explicitly create a pending-review draft.")
        if existing and any(m.get("state") != "pending_approval" for m in existing):
            return fail("An initial draft already exists but is not pending_approval; refusing to change its state")

        if not existing:
            result = jobs.h_draft(deps, {"payload": {"prospect_id": args.prospect_id, "kind": "initial", "force_review": True, "language": "ja"}})
            if not isinstance(result, dict) or not result.get("ok") or not result.get("message_id"):
                return fail("draft creation did not persist: " + json.dumps(result, ensure_ascii=False))
            if result.get("state") != "pending_approval":
                return fail(f"draft state is not pending_approval: {result.get('state')!r}")
            message_id = result["message_id"]
            print("PASS draft creation returned durable message ID", message_id)
        else:
            message_id = existing[0].get("id")
            print("PASS existing pending-review draft found; no second draft created")

        persisted_context = rpc("intel_agent_context", {"p_prospect_id": args.prospect_id})
        rows = [m for m in persisted_context.get("messages", []) if str(m.get("id")) == str(message_id)]
        if len(rows) != 1:
            return fail(f"expected one persisted message row for {message_id}; found {len(rows)}")
        row = rows[0]
        if row.get("kind") != "initial" or row.get("direction") != "outbound" or row.get("state") != "pending_approval":
            return fail("persisted row has incorrect kind, direction or approval state: " + json.dumps(row, ensure_ascii=False))
        if row.get("prospect_id") not in (None, args.prospect_id):
            return fail("persisted message is linked to a different prospect")
        print("PASS persisted row is retrievable against Andraft and remains pending_approval")
        print("SUBJECT:", row.get("subject", ""))
        print("BODY:\n" + (row.get("body_text") or row.get("body") or ""))

        retry = jobs.h_draft(deps, {"payload": {"prospect_id": args.prospect_id, "kind": "initial", "force_review": True, "language": "ja"}})
        if retry.get("message_id") != message_id or retry.get("created") is not False:
            return fail("retry did not return the same existing message without creating a duplicate")
        print("PASS retry returns the same durable ID without duplicate creation")

        send_jobs = [p for name, p in calls if name == "intel_agent_enqueue_job" and p.get("p_kind") == "send"]
        if send_jobs:
            return fail("a send job was enqueued; this acceptance test must never send")
        settings_after = supa.rpc("intel_agent_settings", {})
        for key in ("autonomy", "kill_switch", "initial_cap", "followup_cap"):
            if settings_before.get(key) != settings_after.get(key):
                return fail(f"safety setting {key} changed during acceptance test")
        print("PASS no send job queued; autonomy, kill switch and caps unchanged")
        print("ACCEPTANCE PASS — saved draft is available in Outreach → Waiting for your approval")
        return 0
    except Exception as exc:
        return fail(f"{type(exc).__name__}: {exc}")


if __name__ == "__main__":
    raise SystemExit(main())
