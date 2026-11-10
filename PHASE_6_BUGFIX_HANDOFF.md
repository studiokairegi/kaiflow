# Phase 6 confirmed bug fixes

## Scope and source

Integrated into the latest Phase 5 confirmed-bug-fixed repository. Phase 5's strict contactability email validation, official-business-domain association checks, and regression tests were preserved unchanged. The older Phase 6 patch archive was not used as a wholesale replacement because it regressed those Phase 5 protections.

## Fixes

1. **Pilot size enforcement (P1)**
   - Both `intel_agent_reeval_start` database entry points reject a pilot `p_limit` greater than 50.
   - The worker CLI accepts pilot limits only from 1 through 50. Full-population runs continue to require the explicit `--all --expect COUNT` path.

2. **Historical evidence preservation (P1)**
   - Added `intel_evidence_versions` to retain pre-refresh evidence values and provenance.
   - `intel_agent_reeval_add_evidence` archives an existing matching row before its in-place refresh, and avoids archiving a row already written by the same run.
   - The score-history trigger uses the current re-evaluation run ID to snapshot archived pre-run versions for refreshed evidence, untouched pre-existing evidence for the rest, and excludes evidence first added by the current run.

3. **Takeover attribution (P1)**
   - `takeover_actor` and `takeover_at` now come directly from the selected `intel_lead_history` row's `created_by` and `created_at`; the administrator performing a later operation no longer overwrites the original attribution.

4. **Admin candidate inventory accuracy (P2)**
   - `pre_outreach_studio_candidates` now uses the default pilot eligibility exclusions: valid CRM ownership, no messages, no pasted history, no human rejection, no suppression, and no previously scored item.

## Regression tests and verification

- Phase 6 SQL/contract tests: 40 Python tests passed.
- Phase 6 frontend contract tests: 11 Node tests passed.
- Worker suite: 746 Python tests passed.
- Python compilation: passed.
- Full frontend test sweep: 537 passed, 16 failed. The failing test files require unsupported TypeScript/edge-runtime loading in this Node-only environment (`ERR_UNKNOWN_FILE_EXTENSION`); the focused Phase 6 contract suite passed.
- PostgreSQL tooling/database was unavailable. SQL migrations were not executed against PostgreSQL; static tests do not prove migration runtime correctness.
- Production frontend build was not run; Vite dependencies are not installed in this checkout.

## Side effects

No migrations were applied, no database records were changed, no deployments or Git pushes occurred, and no workers, sending, or autonomy settings were activated. This package is a source-code fix delivery, not production acceptance.
