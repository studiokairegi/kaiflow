# KairFlow Intelligence — Phase 1 Corrective Handoff

## Scope

Applied the four confirmed Phase 1 studio-v2 scoring corrections to the supplied `KairFlow_Phase14_Verification.zip` baseline. The changes are limited to studio qualification scoring, its campaign-settings presentation, and regression tests.

## Corrections

1. **Immutable studio qualification bands**
   - Studio-v2 now always applies 70–100 = Qualified, 50–69 = Needs Review, and below 50 = Rejected.
   - Legacy keyword arguments remain accepted for caller compatibility but cannot override the fixed bands.
   - The studio campaign UI no longer exposes editable threshold inputs. It displays the fixed policy and sends 70/50 in the campaign patch.
   - Indie campaign thresholds remain configurable and unchanged.

2. **3D anime no longer earns 2D relevance points**
   - The 7-point anime-specific 2D item now uses `style_2d_anime`, not generic `anime_production`.
   - Generic anime / 3DCG evidence alone receives zero 2D points and leaves 2D relevance uncertain.

3. **Recognized 2D-anime evidence is scored consistently**
   - `style_2d_anime` is now an explicit 7-point item in the 15-point 2D relevance group.
   - The confirmation decision uses the same scored evidence items, preventing a confirmed-but-unscored result.

4. **Published-work points require a multi-entry work list**
   - The `multiple_titles` detector no longer treats headings such as “Our works”, “Filmography”, or `制作実績はこちら` as proof of multiple published works.
   - It now requires a multi-entry list in the evidence sentence.

## Files changed

- `intelligence-worker/kairflow_intel/scoring.py`
- `intelligence-worker/kairflow_intel/signals.py`
- `intelligence-worker/tests/test_studio_scoring.py`
- `src/intelligence/CampaignView.jsx`
- `src/intelligence/logic.js`
- `src/intelligence/ui-logic.test.mjs`

No migration, schema, policy, secret, environment, production record, later-phase worker path, or unrelated application module was changed.

## Verification

- Focused Phase 1 scoring tests: **35 passed**.
- Full Python worker suite: **470 passed, 0 failed**.
- Python compile check: passed.
- Full JavaScript test suite: **823 passed, 0 failed**.
- ZIP integrity: verified in the corrected output package.
- Production frontend build: **not verified** — `npm run build` exits 127 because Vite is not installed in this environment (`sh: 1: vite: not found`).

The Python test runner also emitted its existing intentional `ValueError: boom` error-handling traceback while completing successfully. Environment smoke diagnostics printed separate Ollama structured-output/model and draft-RPC probe failures; these did not cause the 470-test unittest suite to fail and are not represented as passed integration checks.

## Operational boundary

- No deployment or Git push.
- No database connection, migration execution, or database mutation.
- No worker activation or autonomy change.
- No provider operation or real email sending.
- No later phase was started.

**Disposition:** The four confirmed Phase 1 code defects are corrected and covered by regression tests. This correction package is not a production certification; the frontend build and deployment-environment acceptance checks remain outstanding.
