# Phase 2 Handoff — Reliable AI Provider and Routing Infrastructure

**Status: PARTIAL.** Offline work complete; live completion gate NOT met (no network/key in this session). Do not switch production workloads over until the live checks below pass.

## Files
- Created: `intelligence-worker/.env.example`; `scripts/phase2_gemini_benchmark.py`; `tests/test_phase2_provider_infra.py`; `docs/production-roadmap-phase2/*` (5 files).
- Changed: `kairflow_intel/airouter.py` (+`fast_model` setting), `gemini.py` (+`fast_model` param/selection), `main.py` (passes it), root `.env.example` (Gemini block, N-03), `intelligence-worker/README.md` (one sentence).
- Removed: none. Migrations: none. Deployment: copy new template if installing a fresh worker; restart worker after any env change.

## Tests (actual)
Worker unittest 916 OK; npm test 1142 pass. All provider behaviour mocked. Details in `PROVIDER_FAILURE_TESTS.md`.

## Owner actions to close the gate
1. Put a free-tier key in `worker.env` (never commit). 2. Run `selftest gemini` and `selftest ollama`. 3. Run the benchmark script, fill `MODEL_BENCHMARK_RESULTS.md`. 4. Check real quotas; adjust RPM/RPD. 5. Force a fallback (e.g. temporarily set a bad key or `KAIRFLOW_AI_FORCE_OLLAMA=1`) and confirm the job result shows `provider: ollama` with a `fallback_reason`. 6. Decide which private groups to opt in via `KAIRFLOW_AI_POLICY` (see risk).

## Known risks / unresolved
- D1=C on free tier: Agent Chat history and CRM tool results go to Gemini by default once a key is set (drafting/classification need a policy entry); free-tier data-use terms apply (Google's current terms unchecked).
- Phase 2 benchmark script had a matching bug (spaced expected values never matched); fixed in the recheck.
- Local budget is in-memory, per process, resets on restart; no persisted usage/cost record or dashboard yet.
- `gemini-3.8-flash` availability and the 10/200 caps are unverified. Interactions-API compatibility not checked.
- Provider/model/latency are recorded on job results (`ai_call.py`); a queryable per-call log table was not added (needs a migration; deferred pending approval).
- Carried: Phase 4 items N-01, N-06–N-08; Phase 3 F-06; git state unverifiable (no `.git`).

## Secrets required (names only)
`KAIRFLOW_GEMINI_API_KEY`, plus existing Supabase/agent credentials.

## Next (Phase 3)
Read roadmap + Phase 1/2 handoffs; confirm Phase 2 live checks passed or accept proceeding on mocks; then KB + Agent Chat provenance (P1-03, P1-04, F-06).

**Outbound sending was not touched and remains disabled; the deployed kill-switch state was not verified.**
