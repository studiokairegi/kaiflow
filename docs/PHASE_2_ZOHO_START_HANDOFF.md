# Phase 2 — Zoho-first start handoff

**Status: Partial implementation completed locally. Phase 2 is not complete.**

## 1. Phase and objective

Phase 2 — Individualized English emails, follow-ups and replies. This increment starts with the account-scoped Zoho mailbox path and closes the gap where English replies/follow-ups for CRM-takeover leads used legacy paragraph generation and fixed-template fallback.

## 2. What was inspected

- `intelligence-worker/kairflow_intel/providers/zoho.py`: account-scoped Zoho adapter construction.
- `intelligence-worker/kairflow_intel/mailops.py`: account-scoped Zoho/Gmail inbound sync, stable account-qualified inbound IDs, RFC headers and classification enqueue.
- `intelligence-worker/kairflow_intel/jobs.py`: inbound classification/reply composition and mailbox sync routing.
- `intelligence-worker/kairflow_intel/takeover.py`: CRM pasted-conversation analysis and draft workflow.
- `intelligence-worker/kairflow_intel/drafting.py`: shared evidence-grounded English/Japanese composers and similarity checks.
- Existing worker tests for Zoho, provider registry, takeover, AI routing and cross-site Gemini/Ollama policy.
- `docs/PHASE_ROADMAP.txt` and the supplied CRM Lead Composer re-audit scope.

## 3. What changed

- Routed English CRM-takeover follow-ups and replies through `drafting.compose_english`, the same individualized composer used by discovered prospects.
- Preserved the Japanese route through `drafting.compose_japanese`.
- Shared the organization-wide duplicate/near-duplicate/structural-repetition vetting and one-regeneration rule across English and Japanese takeover drafts.
- Removed the English takeover paragraph/template fallback path. Missing verified evidence, invalid claims, or failed composition now produces a human-review outcome instead of a generic fallback draft.
- Kept the existing Zoho mailbox synchronization path provider-neutral after inbound persistence; Zoho remains the transport adapter, not a separate drafting implementation.
- Preserved existing AI routing site identifiers (`drafting.takeover_followup`, `drafting.takeover_reply`, and `drafting.takeover`) so D1 privacy policy and routing configuration remain compatible.
- Updated worker documentation and tests to reflect the actual shared-composer behaviour.

## 4. Files modified

- `intelligence-worker/kairflow_intel/takeover.py`
- `intelligence-worker/tests/test_takeover.py`
- `intelligence-worker/tests/test_phase5_drafting_routing.py`
- `intelligence-worker/tests/test_phase7_integration.py`
- `intelligence-worker/README.md`

## 5. Database migrations

None created or modified.

## 6. Tests and exact results

- Full Python worker suite: **745 tests passed** (`python -m unittest discover -s tests -t . -q`).
- Takeover workflow: **29 tests passed**.
- AI drafting/routing policy: **21 tests passed**.
- Whole-system AI routing integration: **32 tests passed**.
- Zoho REST/provider tests: passed (`tests.test_zoho`).
- Account-scoped provider registry tests: passed (`tests.test_provider_registry`).
- Mailbox sync/operations tests: passed (`tests.test_ops`).
- Python compilation: passed (`python -m compileall -q kairflow_intel tests`).

These are local mocked/unit tests. The environment's optional self-test output reported unavailable/failed live Ollama structured-output and draft-RPC probes; those diagnostics are not part of the 745-test unit-suite result and do not establish live Zoho readiness.

## 7. Remaining defects, decisions and validation

- This increment does not complete all Phase 2 acceptance criteria. Representative end-to-end drafting coverage across both indie developers and animation studios, all message kinds, evidence-quality calibration and near-duplicate false-positive/false-negative evaluation still need explicit acceptance.
- Zoho OAuth, data-center selection, refresh, account inventory, live folder/message response shapes and a real inbound-to-reply lifecycle have not been exercised against a live Zoho tenant.
- The CRM Lead Composer re-audit supplied separately is not implemented by this Intelligence Phase 2 increment. Its Lead Card/shared Inbox composer/account-selection/CRM-activity workstream remains separate.
- No provider/account sending gates were changed.

## 8. Deployment and safety confirmation

No deployment, push, database migration, worker activation/restart, autonomy change, sending-gate change, OAuth connection or real email sending occurred.

## 9. Exact next scope

Continue Phase 2 with Zoho-backed staging fixtures and representative English initial, follow-up, reply and re-engagement acceptance for both prospect categories. Verify inbound Zoho messages reach the shared composer with correct conversation context, evidence IDs and approval state. Do not start Phase 3 until Phase 2 is reviewed and accepted.
