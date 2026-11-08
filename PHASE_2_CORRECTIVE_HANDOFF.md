# Phase 2 Corrective Handoff

## Confirmed defect fixed

- `intelligence-worker/kairflow_intel/drafting.py`: normalize curly apostrophes (`’`, `‘`) to straight apostrophes before risky-claim and personalized-claim lexical checks. This ensures contractions such as `won’t` are not interpreted as the unsupported achievement claim `won`. The normalization is applied to both the draft sentence and the allowed evidence/fact text.
- `intelligence-worker/tests/test_phase2_audit_fixes.py`: expanded regression coverage to cover straight and curly apostrophe variants and retained a test that a genuine `won` achievement claim is still blocked.

## Verification

- Focused natural-phrasing tests: 3 passed.
- Full Python worker suite: 470 passed.
- Full JavaScript suite: 823 passed.
- Python compileall: passed.
- Runtime diagnostics remain environment-dependent: one configured RPC probe reported PGRST202 (`p_force_review` not found), while another resolved the 11-argument signature. Ollama probes also returned inconsistent results across configured endpoints. These are not claimed as production integration acceptance.
- No frontend build was rerun because this corrective change is confined to Python drafting validation and its tests.

## Scope and safety

Only the two source/test files listed above were changed relative to the Phase 1 corrective package. No deployment, database migration execution, database record modification, worker activation, or email sending was performed.
