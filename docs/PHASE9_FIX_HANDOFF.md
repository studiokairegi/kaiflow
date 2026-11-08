# Phase 9 — Source-registry enforcement corrective handoff

## Objective
Correct the Phase 9 confirmed source enforcement issues in discovery adapter error handling, handler configuration validation, and request-budget accounting clarity.

## Changes
- Removed swallowing of `PermanentError` in source adapters' `_safe` helper so registry/budget denials remain visible to the source-level handling.
- Added per-source success/failure reporting for indie Steam/itch adapters and studio seed crawler through `intel_agent_source_report`; failures are captured and that source is not continued after a failure.
- Made indie discovery handler preflight validate campaign criteria object, supported requested source names, and non-empty keyword list.
- Made studio seed configuration fail closed when seed URLs are malformed, and enforce site crawler registry authorization if URLs are supplied.
- Clarified the budget unit: one reservation per actual adapter fetch (Steam search and app details separately; each itch tag page; each seed URL fetch). This retains the current SQL `p_n=1` atomic reserve boundary rather than making assumptions about batch behavior.
- Added tests for source failure reporting and malformed source lists.

## Files included
- `intelligence-worker/kairflow_intel/sources.py`
- `intelligence-worker/kairflow_intel/jobs.py`
- `intelligence-worker/tests/test_discovery.py`

## Verification
- Discovery test module: 39 passed.
- Full Python worker suite: 476 passed.
- Python compileall: passed.
- ZIP integrity: to be checked after packaging.
- PostgreSQL migration execution and live source concurrency checks: not performed.
- Diagnostics emitted a traceback from a test's intentional `ValueError: boom`; unittest suite still passed. External environment probes reported Ollama/RPC failures; they are not counted as unit test failures.

## Safety
No deployment, push, worker activation, autonomy change, or real email sending occurred.

## Next phase
Phase 10 — schema, migrations, and email-provider integration. Do not start automatically.
