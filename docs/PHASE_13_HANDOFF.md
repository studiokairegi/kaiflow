# KairFlow Phase 13 handoff

## 1. Phase and objective
Phase 13 — Capacity, evidence retention and model benchmarks. Evaluate evidence/message retention, database growth and indexes, safe cleanup policy, and local Ollama performance/quality on the Windows GTX 1650 4 GB VRAM / 16 GB RAM target, including English/Japanese extraction and drafting and timeout/failure behavior.

## 2. Inspected
- Existing daily retention job scheduler and `h_retention` worker handler.
- Existing `intel_agent_prune` SQL function and evidence/message/job schema.
- Current indexes on evidence, messages, jobs and delivery events.
- Ollama client timeout/error handling and configured model tags.
- Existing Japanese language-selection/drafting regression tests.

## 3. Changed
- Added a read-only Ollama benchmark harness for English/Japanese extraction and drafting.
- Added a read-only SQL diagnostics script for table/index footprint, row-age distributions and index usage.
- Added retention proposal and model benchmark report.
- Added strict benchmark-output validation for required keys, JSON types, language enum and string-length limits.
- Restricted benchmark URL configuration to explicit HTTP loopback hosts (`localhost`, `127.0.0.0/8`, or `::1`); remote hosts, credentials, paths, queries and fragments are rejected before any request.
- Added regression tests for malformed benchmark outputs, URL restrictions, offline self-test and Ollama transient/permanent failure classification.

## 4. Files added
- `intelligence-worker/scripts/phase13_ollama_benchmark.py`
- `intelligence-worker/tests/test_phase13_capacity.py`
- `supabase/diagnostics/phase13_retention_diagnostics.sql`
- `docs/PHASE_13_RETENTION_PROPOSAL.md`
- `docs/PHASE_13_MODEL_BENCHMARK_REPORT.md`
- `docs/PHASE_13_HANDOFF.md`

## 5. Database migrations
None. No migration is appropriate until retention durations and measured index changes are approved. The SQL diagnostics script is SELECT-only.

## 6. Tests and exact results
- JavaScript: `npm test` — 822 passed, 0 failed.
- Python: `PYTHONPATH=intelligence-worker python -m unittest discover -s intelligence-worker/tests -t intelligence-worker` — 466 passed, 0 failed.
- Focused Phase 13 Python tests — 11 passed, 0 failed.
- Benchmark harness `--self-test` — passed; explicitly performs no network access.
- Python `compileall` — passed.
- Read-only SQL diagnostics contract test — passed (6 SELECT statements; no DML/DDL/maintenance statements).
- Local Ollama probe — unavailable at `127.0.0.1:11434`; no actual model run was attempted.
- PostgreSQL diagnostics — not executed; no authorized database connection was available.

## 7. Regression tests
Eleven focused tests cover strict benchmark output validation (including type, enum, length and extra-field rejection), loopback-only URL enforcement, offline self-test, read-only SQL diagnostics, Ollama timeouts, HTTP 429/5xx, permanent HTTP 4xx and malformed structured output.

## 8. Bug-fix recheck
- The previously flagged weak benchmark response validator is fixed; malformed types, unsupported languages, overlong fields, missing keys and extra keys are rejected.
- The previously flagged remote URL allowance is fixed; CLI and environment-provided URLs are validated before self-test or network access.
- Regression coverage passes. No production-worker changes were needed.

## 9. Remaining gaps / decisions
- Existing scheduled retention behavior: `intel_agent_prune(45)` deletes evidence older than 45 days for rejected/suppressed prospects and terminal succeeded/cancelled jobs older than 14 days. This was not executed or modified. The owner must review this pre-existing behavior against the proposed policy before enabling/deploying retention jobs.
- Actual DB growth/index measurements require authorized staging DB access.
- Actual model benchmark requires the target Windows workstation, local Ollama and both configured model tags.
- English/Japanese quality scoring requires human review of benchmark outputs.
- GPU offload, peak VRAM, RAM and thermal behavior require target-machine measurements.

## 10. Operational safety
No evidence or messages were deleted. No retention job or prune RPC was run. No database migration was created or applied. No deployment, push, worker activation, autonomy change, provider activation or email sending occurred.

## 11. Next phase
Phase 14 — Final end-to-end verification, only after Phase 13 acceptance and separate authorization.
