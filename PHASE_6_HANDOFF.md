# KairFlow Intelligence — Phase 6 Handoff Report

**Phase:** 6 — Qualification, Outreach and Follow-Up Intelligence (per
`KairFlow_Intelligence_—_Seven-Phase_Production_Implementation_Roadmap.txt`)

**Input to this session:** the uploaded repo snapshot
(`KairFlow_Phase5_Full_Repo_presskit_reviewed(1).zip`, extracted root
`KairFlow_Indie_V2_Phase_1_Architecture_Audit_Handoff/`) plus the roadmap document. No separate
Phase 5 handoff matching the master roadmap's own deliverable names
(`PROSPECT_DISCOVERY_ARCHITECTURE.md` etc.) existed in the snapshot; this session worked from the
actual code and its own extensive pre-existing test suite instead of a missing document.

## 1. Session summary

This session did a real audit of the existing code against every Phase 6 task and business rule
before writing anything, per Global Implementation Rule 1 ("inspect before modifying"). The headline
finding: **most of Phase 6 was already built**, across many earlier ad hoc "Cloud sessions" whose own
internal phase numbering (visible in filenames like `PHASE_5_CONFIRMED_BUGFIX_REPORT.md`,
`PHASE_6_CONFIRMED_BUGFIX_HANDOFF_2026-11-12.md`) does not correspond to this roadmap's Phase 1-7
numbering. Full findings, task by task, are in the four companion documents:

- `PROSPECT_QUALIFICATION_SPEC.md` — tasks 1-4
- `OUTREACH_PERSONALIZATION_STANDARD.md` — tasks 5-6, 14, business rules
- `FOLLOWUP_WORKFLOW.md` — tasks 7-11
- `EMAIL_SAFETY_TESTS.md` — tasks 12-13, business rules, full test evidence

**One genuine gap was found and closed:** nothing used AI to help a human interpret an ambiguous
`needs_review` qualification outcome (task 3). Everything else audited was already implemented and
already tested.

**Second pass (this update):** the first pass's own "Known bugs, risks and unresolved issues" section
named three concrete shortcomings. All three that could be fixed from inside this sandbox are now
fixed:
1. `ambiguous_evidence_review` is now actually rendered in `ProspectModal.jsx`, not just written to
   the database unseen.
2. The AI routing path for the new site tag is now tested against the real `AIRouter` class (policy,
   fallback, `force_ollama`), not only a bare fake `llm`.
3. The CRM-sync and draft-accessibility frontend/SQL files flagged as "confirmed present but not
   re-read" were actually read this pass and are confirmed genuinely implemented (details in
   `FOLLOWUP_WORKFLOW.md` §3), not merely named correctly.

The one item that remains open **cannot** be closed from inside this sandbox: a real network call to
Gemini. See §5 below.

## 2. Files created, changed and removed

**Created:**
- `intelligence-worker/kairflow_intel/qualification_review.py` (new module)
- `intelligence-worker/tests/test_qualification_review.py` (14 tests total: 9 first pass + 5
  `RealRouterIntegrationTests` second pass)
- `PROSPECT_QUALIFICATION_SPEC.md`, `OUTREACH_PERSONALIZATION_STANDARD.md`, `FOLLOWUP_WORKFLOW.md`,
  `EMAIL_SAFETY_TESTS.md`, `PHASE_6_HANDOFF.md` (this file)

**Changed:**
- `intelligence-worker/kairflow_intel/research.py` — `qualify()` and `_qualify_studio()` gained an
  `llm=None` keyword-only parameter; both now attach an `ambiguous_evidence_review` key to
  `p_estimates` only when the decision is `needs_review`. Every existing call that doesn't pass `llm`
  behaves exactly as before, with the new key as a side effect of the (unchanged) deterministic logic.
- `intelligence-worker/kairflow_intel/jobs.py` — `h_qualify()` now passes
  `llm=getattr(d, "llm", None)` to `research.qualify()`.
- `intelligence-worker/kairflow_intel/airouter.py` — one line added to `KNOWN_SITES`:
  `"research.qualification_review"`.
- `src/intelligence/ProspectModal.jsx` (second pass) — added a "Why this is in review" card that
  renders `p.facts.estimates.ambiguous_evidence_review` for `needs_review` prospects: summary, key
  uncertainty, a confidence pill, the recommended next check, and a pill distinguishing an
  AI-assisted note from the automatic deterministic one. No existing behavior in this file was
  changed; this is a purely additive block guarded by `ambiguousReview &&`.

**Removed:** nothing.

**Note on this file:** `src/intelligence/*.jsx` could not be built, linted, or run in this sandbox
(no `node_modules`, no network to install any). The edit was reviewed by eye for JSX/brace balance and
follows the exact patterns (`S.card`, `S.label`, `S.grid`, `Pill`, `Muted`) already used elsewhere in
the same file. **The user should run their normal build/lint before merging this one file.**

## 3. Database migrations and deployment requirements

**None.** The new data (`ambiguous_evidence_review`) is written inside the existing `p_estimates`
jsonb parameter that `intel_agent_set_score` and `intel_agent_reeval_set_score` already accept — no
schema change, no new RPC, no migration file. Nothing was deployed; nothing was applied to Supabase.

## 4. Tests executed and their actual results

Full detail in `EMAIL_SAFETY_TESTS.md`. Summary:

| Run | Tests | Result |
|---|---|---|
| Baseline, before any Phase 6 change | 1102 | OK |
| First pass (`qualification_review.py` + wiring + 9 tests) | 1111 | OK, after fixing 2 self-introduced bugs |
| Second pass (+5 `RealRouterIntegrationTests`) | 1116 | **OK** |

```
cd intelligence-worker && python3 -m unittest discover -t . -s tests -p "test_*.py"
```

`pytest` could not be installed in this sandbox (no network egress) — the run above is `unittest`
against the same test files, which are plain `unittest.TestCase` and run identically either way. **The
user should re-run the suite with `pytest` on their own machine before merging**, as a second check,
though there is no reason to expect a different result given the test files don't use pytest-only
features.

No live Gemini or Ollama network call was made or could be made (no network egress at all in this
sandbox). The second pass did add tests that exercise the real `AIRouter` production class and its
policy/fallback logic (not just a bare fake `llm`) — see `EMAIL_SAFETY_TESTS.md` §4 — but those still
talk to `FakeGemini`/`FakeOllama` stand-ins, not the real API.

## 5. Known bugs, risks and unresolved issues

Of the three items raised in the first pass, two are now closed (frontend display — done; AI-routing
test coverage — done, now against the real `AIRouter`) and the CRM-sync/draft-accessibility question
was resolved by actually auditing those files (they're genuinely implemented — see
`FOLLOWUP_WORKFLOW.md` §3). One item is **not closeable from inside this sandbox**:

- **The AI-written explanation path has never talked to the real Gemini API**, and cannot from here —
  this sandbox has no network egress at all, so no amount of further work in this session can close
  this one. The deterministic fallback is safe to rely on regardless (it is pure string-building from
  data `scoring.py` already produced, never from a model). Recommend one real
  `research.qualification_review` call on a genuine `needs_review` prospect, from the user's own
  machine with real Gemini credentials, before considering the AI-assisted half of this feature
  "live" — see §8 step 5.
- `src/intelligence/ProspectModal.jsx` was edited without access to a JS build/lint/test toolchain in
  this sandbox (no `node_modules`, no network to install any). Reviewed by eye against the file's own
  existing patterns; **run the project's normal build before merging.**

## 6. Configuration and secrets required

**None new.** No new environment variable, API key, or account was introduced. The new site tag
(`research.qualification_review`) uses whatever Gemini/Ollama configuration already exists
(`KAIRFLOW_GEMINI_API_KEY`, `KAIRFLOW_AI_POLICY`, etc.) — it needs no secret of its own and defaults to
the `research` group's existing policy (`gemini_first` by default, per `airouter.DEFAULT_POLICY`).

## 7. Git status, branch and commit information

The uploaded snapshot is a plain directory, not a git checkout (`git status` reports "not a git
repository" at its root) — this session could not stage, diff, or commit against the user's actual
`studiokairegi/kaiflow` repository. **The user needs to apply the four changed files and six new files
listed in §2 to their own local clone (on `main`, per the roadmap header) themselves, then run
`git status`/`git diff` there to confirm the real diff before committing** — consistent with every
other handoff in this project's history ("nothing applied or deployed yet", "owner still has to run
the tests himself").

## 8. Exact instructions for the next phase / for applying this one

1. Copy `intelligence-worker/kairflow_intel/qualification_review.py` and
   `intelligence-worker/tests/test_qualification_review.py` into the real repo at the same relative
   paths.
2. Apply the three small edits described in §2 to `research.py`, `jobs.py` and `airouter.py` (each is
   a few lines; a reviewable unified diff can be produced on request if preferred over copying the
   full files).
3. Copy `src/intelligence/ProspectModal.jsx` over the existing file (or apply the one additive block
   by hand) and run the project's normal build/lint — this is the one file in this delivery that
   could not be verified by any automated check here.
4. Run `cd intelligence-worker && python3 -m pytest -q` (or the `unittest discover` command in
   `EMAIL_SAFETY_TESTS.md` if pytest isn't installed) and confirm it is green before anything else.
5. When ready to validate the model path for real, trigger one `h_qualify` run against a genuine
   `needs_review` studio or indie prospect with Gemini enabled for the `research` group, and read back
   `p_estimates.ambiguous_evidence_review.generated_by` — it should say `"model"`, not
   `"deterministic_fallback"`, and the `confidence`/`summary` should read sensibly against that
   prospect's actual evidence. Confirm the new card in `ProspectModal.jsx` renders it correctly.
6. Phase 7 (Production Validation, Controlled Rollout and Operations) is the next roadmap phase; this
   session did not begin it.

## 9. Confirmation that outbound sending remains disabled

**Confirmed.** This session touched no sending, approval, suppression, or kill-switch code path. Every
change in this session is inside the qualification/explanation path only, which writes exploratory
data to `p_estimates` and nothing else; it has no ability to send, approve, or suppress a message.

## 10. Audit-fix and reconcile pass (supersedes earlier test counts and "still open" lists)

**Lineage reconciled.** Eight uploaded zips collapse to three distinct Phase 6 deliveries plus the Phase 5 repo: first pass
(`...Followup.zip`), second pass (`...Followup (1)-(4)` and `__4__1`, all byte-identical), and the audit-fix zip (two identical
copies, which pre-dates the confidence indicator and model-call cap). This pass applies everything onto the real Phase 5 repo
(`KairFlow_Indie_V2_Phase_1_Architecture_Audit_Handoff`); a later upload (`KairFlow_Full_Repo_Phase6.zip`) turned out to be that same repo with only the second-pass Phase 6 delivery applied (+7 files, 1116 tests passing, crash bug still present), so this pass was rebuilt on top of it. The baseline `jobs.py` / `research.py` / `airouter.py` / `ProspectModal.jsx`
matched what Phase 6 was built against, so all edits applied cleanly.

**Files changed against the Phase 5 repo:** `intelligence-worker/kairflow_intel/{qualification_review.py (new), research.py, jobs.py, airouter.py}`,
`intelligence-worker/tests/test_qualification_review.py (new)`, `src/intelligence/ProspectModal.jsx`, and the docs. No migration, no new
secret. Optional env: `KAIRFLOW_QUAL_REVIEW_MAX_PER_HOUR`.

**Tests actually run (real repo):** Python 1102 -> 1137 (1133 after the reconcile pass, +4 in the merge audit), all OK; JS 1191 pass; JSX parses via esbuild. See `EMAIL_SAFETY_TESTS.md` §6.

**Bugs fixed (details in `PROSPECT_QUALIFICATION_SPEC.md` §5):** crash on real studio needs_review output; indie flat-row/gate shape
ignored; loose grounding; contact details sent to the model; hard-coded fallback confidence; wasted model call on held results;
studio confidence used campaign criteria that `score_studio` ignores; no confidence for qualified/rejected; no model-call cap; dates/year ranges redacted as phone numbers in the model payload; numbers the model was given (score, points, max) rejected as ungrounded.

**Retracted / resolved after reading the real repo:** future-dated migration (convention, not a bug); UI-only gates (enforced in
the database); task 8 follow-up backlog (implemented via `followup_scan`; this report's earlier description was wrong).

**Still open:** (1) no live Gemini call has been made; run one `research.qualification_review` call on a genuine needs_review prospect
and check `p_estimates.ambiguous_evidence_review.generated_by == "model"`. (2) No full `vite build` / `pytest` run. (3) Studio
needs_review reasons that come from `contactability`/suppression (not from scoring) are not part of the note's source. (4) Not a git
checkout, so no commit/branch information; apply the patch in your clone.

**Outbound sending:** unchanged and still disabled by this work; no send, approval, suppression or kill-switch code was touched.
