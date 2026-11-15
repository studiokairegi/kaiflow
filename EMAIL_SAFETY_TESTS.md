# KairFlow Intelligence — Email Safety Tests (Phase 6)

**Scope:** Master roadmap Phase 6, task 12-13 and Business Rules ("prevent outreach to suppressed,
unsubscribed, invalid or otherwise prohibited contacts", "require explicit approval before sending",
"respect existing suppression, approval, daily-cap and kill-switch controls").

## 1. Test run performed this session

Environment note: this sandbox has **no outbound network access** and `pytest` could not be installed
(no PyPI reachable). All testing below was run with Python's stdlib `unittest` against the real
`kairflow_intel` package — the test files themselves are plain `unittest.TestCase` (no pytest-only
syntax), so this is a faithful run of the same tests, not a reduced substitute.

```
cd intelligence-worker
python3 -m unittest discover -t . -s tests -p "test_*.py"
```

| Run | Tests | Result |
|---|---|---|
| Baseline, before any Phase 6 change | 1102 | **OK** (0 failures) |
| After adding `qualification_review.py` + wiring (first attempt) | 1111 | 6 failures — see below |
| After fixing the two bugs those failures found | 1111 | **OK** (0 failures) |
| After adding `RealRouterIntegrationTests` (second pass) | 1116 | **OK** (0 failures) |

**The 6 failures were real and were in this session's own new code, not pre-existing:**
1. `jobs.h_qualify` passed `d.llm` directly; a test fixture (`D` in `test_studio_scoring.py`) has no
   `llm` attribute, so 5 pre-existing tests that construct a minimal fake `Deps` broke.
   Fix: `getattr(d, "llm", None)` instead of `d.llm` — every fake `Deps` without an `llm` attribute now
   gets the deterministic (no-AI) explanation path instead of an `AttributeError`.
2. One of the 9 new tests in `tests/test_qualification_review.py` had a bug in its own helper
   (`breakdown=[] or default` silently discards an explicitly-empty list in Python) — fixed in the test,
   not in the production module.

This is exactly the kind of regression the full-suite run is supposed to catch, and it did; no change
in this session shipped without the suite going back to green.

## 2. What the existing (pre-existing, not written this session) tests already demonstrate

These are cited by file name so the next session can re-run or extend them directly; this list is not
exhaustive of every safety-relevant test in the repository.

- **`tests/test_safety.py` (22 tests):** SSRF-safe fetching — only-public-IP resolution
  (`is_public_ip`, `assert_public_url`), connection pinning so a redirect can't retarget a private
  address after DNS was checked.
- **`tests/test_v1.py` (33 tests):** core v1 send-path behavior.
- **`tests/test_campaign_followup_send_cap_migration.py` (3 tests):** daily/campaign send-cap
  enforcement across a schema migration.
- **`tests/test_ops.py` (31 tests):** operational safeguards (the specific set was not individually
  re-read line-by-line this session; cited for the next session to consult directly).
- **`tests/test_indie_campaign_audit_fixes.py` (6 tests):** indie-campaign-specific audit fixes,
  including suppression-related corrections from an earlier session.
- `policy.validate_outbound` is exercised by the drafting test suite (`test_indie_outreach_v6.py`,
  `test_phase5_drafting_routing.py`, `test_indie_research_integrity_v6.py`) for: missing opt-out
  sentence, missing postal address, unapproved link, price/discount/guarantee language (English and
  Japanese), and unverifiable prior-contact claims.

**This session did not find a gap in suppression, approval or kill-switch enforcement.** Everything
inspected (`mailops.send_message`, the suppression lookups in `research.qualify`, `policy.UNSUBSCRIBE`)
was already defensive: a missing or failed suppression lookup is treated as blocking
(`needs_review`/held), never as a silent pass, and the kill switch is re-checked immediately before
the provider call in `mailops.send_message` via `intel_agent_mark_sending`.

## 3. New tests added this session

`tests/test_qualification_review.py` — 9 tests for the new `qualification_review.py` module
(see `PROSPECT_QUALIFICATION_SPEC.md`):

- Returns `None` (adds nothing) for `qualified`/`rejected` decisions, with and without a model — 2 tests.
- Deterministic fallback with no model, built only from the existing `Result` — 1 test.
- A model exception is swallowed and falls back — never raises — 1 test.
- An invalid `confidence` value from the model is rejected and falls back — 1 test.
- An ungrounded model answer (introduces a fact not in any evidence) is rejected and falls back — 1 test.
- Fallback still produces a sane answer with empty breakdown/evidence — 1 test.
- A grounded model answer is accepted, provenance is recorded, and the exact site tag used is checked
  against `airouter.KNOWN_SITES` and confirmed to route through the `research` (public-evidence) group,
  not a private-correspondence group — 2 tests.

## 4. Second pass: real-router coverage added

The first-pass tests above only proved `explain_ambiguous()` behaves correctly against a bare fake
`llm` object — they never proved the *routing* (policy resolution, D1, Gemini-then-Ollama fallback,
budget/force_ollama) actually works correctly for this new site tag. `RealRouterIntegrationTests`
(5 tests, added second pass) closes that gap by constructing a real `kairflow_intel.airouter.AIRouter`
(the production class, not a stand-in) with `FakeGemini`/`FakeOllama` providers borrowed from the
existing `test_ai_router.py` fixtures, and confirms: the default policy sends this site to Gemini
first; a Gemini failure produces exactly one Ollama attempt and a usable grounded answer; an
ungrounded answer is rejected even when it comes from the Ollama fallback, not only from a
first-attempt Gemini call; `force_ollama` skips Gemini entirely; and a `qualified`/`rejected` result
never calls the router at all (confirming the "never forced into every operation" property at the
router level, not just inside `qualification_review.py` itself).

## 5. What is still explicitly **not** done

- **No live Gemini or Ollama call was made** (no network egress in this sandbox) — this cannot be
  fixed from inside this sandbox, only from the user's own machine. The model path is now exercised
  against the real `AIRouter` class (§4) but still through `FakeGemini`/`FakeOllama` stand-ins, not an
  actual network call. **The user should run a real Gemini call against the new
  `research.qualification_review` site tag before relying on the AI-written explanation in production** —
  the deterministic fallback is safe to ship regardless, since it is what runs when the model path is
  untested or unavailable.
- No SQL migration was written, run, or reviewed this session; nothing was applied to Supabase; no
  secrets were touched.
- `git status`, staging, committing and pushing were not performed — see `PHASE_6_HANDOFF.md`.
- **Outbound sending remains disabled by this session's own account; nothing here changes that.** This
  session made no change to any sending, kill-switch, or approval code path.

## 6. Reconcile pass: run against the real Phase 5 repository

Pristine Phase 5 repo: `python3 -m unittest discover -t . -s tests -p "test_*.py"` -> **1102 tests, OK**.
With Phase 6 applied (and the audit fixes): **1137 tests, OK** (1102 + 35 in `tests/test_qualification_review.py`, which includes
the real-`AIRouter` tests and tests built on real `score_studio` / `score_indie` output).
`node --experimental-strip-types --test` (repo JS tests): **1191 pass, 0 fail**. `ProspectModal.jsx` parses and bundles with esbuild;
a full `vite build` was not run (no `node_modules`). `pytest` is not installed here; the suite was run with `unittest`.
Still not done: any live Gemini/Ollama call.

## 7. Merge audit pass

After merging the three uploads: Python `unittest discover` **1137 tests, OK** (4 new regression tests in `tests/test_qualification_review.py`
for date-safe redaction and numeric grounding); `node --experimental-strip-types --test` **1191 pass, 0 fail** (no JS file changed).
Still not done: live Gemini/Ollama call, `vite build`, any database migration run.
