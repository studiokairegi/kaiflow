# KairFlow Combined Repository — Phases 8–10

This repository combines the Phase 8 baseline archive with the Phase 9 corrective worker files and Phase 10 provider/schema fixes.

## Merge precedence
1. Phase 8 archive is the baseline.
2. Phase 9 replaces the baseline copies of:
   - `intelligence-worker/kairflow_intel/sources.py`
   - `intelligence-worker/kairflow_intel/jobs.py`
   - `intelligence-worker/tests/test_discovery.py`
3. Phase 10 adds two timestamped Supabase migrations, a provider schema contract test, and its handoff.

## Important boundaries
- This is a local source merge only. No Supabase migrations were applied, no Edge Functions were deployed, no secrets or environment files were copied, no worker was started, and no emails were sent.
- The Phase 10 SQL must be reviewed and tested against disposable PostgreSQL before production use.
- Apply migrations only in their documented dependency order. Review the existing Intelligence migration history before applying these additions.
- The Phase 9 and Phase 10 handoffs are in `docs/`.
- Phase 8's original handoff and merge documentation are retained.

## Verification
The merge checks confirm the expected files are present and the Phase 9 files replaced the baseline copies. Automated test suites have not yet been executed as part of this packaging step.
