# KairFlow Intelligence — Phase 4 Confirmed Bug Fix Handoff

## Phase and objective
Phase 4 — Improve discovery of leads and suitable studios. Correct the source-budget reservation contract so discovery reservations succeed when they exactly consume quota and denied over-budget reservations do not consume quota.

## Confirmed defect addressed
`intel_agent_source_use` in `supabase/migrations/20261109170000_intelligence_discovery.sql` returned the remaining budget after an increment. The Python `_use()` helper interpreted a positive result as success. When a reservation exhausted the budget exactly, SQL returned zero, so the worker treated a successful quota consumption as denial and skipped discovery. The old SQL also did not atomically reject over-budget reservations.

## Changes
- Updated `intel_agent_source_use` to return a decision (`1` reserved, `0` denied), consistent with the Phase 9 source-registry contract.
- Made reservation atomic, enforcing enabled source, confirmed terms, closed circuit, daily budget, and day rollover.
- Invalid/nonpositive reservations fail closed; over-budget requests do not update quota.
- Added a regression test asserting the Phase 4 migration has the decision-return contract and budget guards.

## Files modified
- `supabase/migrations/20261109170000_intelligence_discovery.sql`
- `intelligence-worker/tests/test_discovery.py`

## Tests
- Phase 4 discovery tests: 37 passed.
- Full Python worker suite: 471 passed.
- Python compilation (`compileall`): passed.

## Remaining limitations
- Migration SQL was not applied to a live or disposable Supabase database in this environment; runtime SQL execution and RPC signature remain acceptance checks.
- No live AniList/Wikidata/Common Crawl/GDELT calls were made.
- Production build not run.

## Safety confirmation
No migration deployment, Git push, worker activation, autonomy change, or real email sending occurred.

## Scope
Only the confirmed Phase 4 quota-reservation bug was fixed. No next phase was started.
