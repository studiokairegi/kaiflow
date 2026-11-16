# KairFlow Intelligence — Prospect Qualification Spec (Phase 6)

**Scope:** Master roadmap Phase 6, task 1-4 ("Improve qualification using deterministic criteria...",
"keep campaigns separate", "use AI to interpret ambiguous evidence", "provide clear qualification
reasons and confidence indicators").

**Baseline inspected this session:** `kairflow_intel/scoring.py`, `research.py`, `signals.py`,
`protected_accounts.py`, and the existing test suite (`tests/test_studio_scoring.py`,
`tests/test_indie_qualification_v2.py`). Full suite run: **1102 pre-existing tests, 0 failures**
before any change in this session (baseline), **1111 tests, 0 failures** after (baseline + 9 new).

## 1. What was already in place (verified, not re-built)

Qualification is, and remains, fully deterministic:

> `scoring.py`: *"Qualification arithmetic. Pure, deterministic, explainable: every point is tied to
> a signal with stored evidence. The model never produces a score."*

- **Two campaigns, two rubrics, never mixed.** `score_indie()` (model `indie-project-v2`,
  `INDIE_QUALIFY_MIN=75`, `INDIE_REVIEW_MIN=55`) and `score_studio()` (model `studio-v2`,
  `STUDIO_QUALIFY_MIN=70`, `STUDIO_REVIEW_MIN=50`) are separate functions with separate thresholds,
  separate signal vocabularies and separate mandatory gates. `research.qualify()` dispatches on
  `prospect.type` and never calls the other campaign's scorer. A legacy `studio-v1` score is never
  silently rescored by `studio-v2`; a candidate rescore is appended as unverified evidence instead
  (`res.held = True`) until a human or the Phase-6 reevaluation flow (`studio_reeval.py`) moves it.
- **Clear reasons, already.** Every `Result` carries `breakdown` (`[{criterion, items: [{criterion,
  points, max, why}]}]`) and `reason` — a plain-English sentence tied to the actual rule that decided
  the outcome — plus `uncertain` (criteria the evidence didn't clearly settle either way). This
  gives clear reasons for every decision. **Correction (audit):** `Result` carries no confidence value;
  `uncertain` is only a list of unsettled criteria. There is therefore no confidence indicator for
  `qualified`/`rejected` results, and task 4's "confidence indicators" is only partly met (see §5).
- **Mandatory gates are separate from points.** `indie_mandatory_gates()` enforces hard requirements
  (e.g. a verifiable project identity, non-expired marketing timing) before a score is even computed;
  a failed gate forces `rejected` regardless of point total, so no amount of partial credit elsewhere
  can qualify a prospect that fails a hard requirement.
- **Contactability is scored separately from suitability.** (Studio-v2 comment: *"Phase 5 owns it."*)
  A prospect can be suitable but not contactable (`res.contactability.status != "pass"`); `jobs.h_qualify`
  only enqueues `resolve` when both suitability and contactability pass and the score wasn't held.

## 2. What this session added

**Gap found:** nothing in the qualification path used AI to help a human interpret a genuinely
ambiguous `needs_review` case, as the roadmap's task 3 asks for. Everything else in section 1 already
covered tasks 1, 2 and 4.

**Addition:** `kairflow_intel/qualification_review.py` — `explain_ambiguous(llm, res, evidence_rows,
rec=None)`.

- Runs **only** when `res.decision == "needs_review"`; returns `None` for `qualified` and `rejected`.
- **Never writes to `res.score`, `res.decision`, `res.breakdown` or `res.suitability`.** It cannot
  requalify, reject or approve anything — it only ever adds a note next to a decision scoring.py
  already made.
- With `llm=None` (default, backward compatible with every existing call site), the result is a
  **deterministic explanation** built only from `res.breakdown` and `res.uncertain` — no model, no
  network call, cannot be wrong because it says nothing scoring.py didn't already say.
- With an AI router given, it asks Gemini (site tag `research.qualification_review`, group
  `research` — the same public-prospect-evidence privacy class as `research.entity`, not a private
  correspondence group) for a short `{summary, key_uncertainty, confidence, recommended_human_action}`
  JSON object, built only from the breakdown, the uncertain list and the verified evidence snippets
  that fed the score. **Audit fix:** email addresses and phone numbers are now redacted from the payload
  before any model call (previously verified snippets could carry contact details to the cloud).
- **Every model answer is grounded before it is trusted**, the same way `drafting.model_hook` already
  grounds AI-written outreach hooks: each field is checked against the verified evidence, breakdown text, reason and uncertain list
  (**audit fix:** whole-word, lightly stemmed match, ≥70% of content words, and any number or mid-sentence
  capitalised name must appear in the source; previously a substring match at 50%, and breakdown text was
  not actually part of the source despite this document saying so). An ungrounded answer, a bad `confidence` value, a model
  exception, or no router at all all fall back to the same deterministic explanation. **This function
  never raises** — a qualification job can never fail, retry or stall because of it.
- Wired into both `research.qualify()` branches (indie and studio-v2, ordinary and reevaluation) as an
  `llm=None` keyword-only parameter, and into `jobs.h_qualify()` via `getattr(d, "llm", None)`. Every
  existing caller that doesn't pass `llm` is unaffected; the new behaviour only activates for
  `needs_review` results and is stored as an additional `p_estimates["ambiguous_evidence_review"]` key
  — additive, not a replacement of any existing key.
- `research.qualification_review` added to `airouter.KNOWN_SITES` so the site tag is recognized by the
  existing `KAIRFLOW_AI_POLICY` validator (one-line, no behavior change by itself).

## 3. Follow-up fixes (second pass)

The first pass left two confirmed shortcomings; both are closed now:

- **Frontend display added.** `src/intelligence/ProspectModal.jsx` now renders a "Why this is in
  review" card whenever `p.status === "needs_review"` and `p.facts.estimates.ambiguous_evidence_review`
  is present: the summary, key uncertainty, a confidence pill, and the recommended next check, with a
  pill distinguishing an AI-assisted note (`generated_by: "model"`) from the automatic deterministic
  one (`generated_by: "deterministic_fallback"`). `ReevaluationPanel.jsx` was deliberately left
  unchanged — it is a run-level/aggregate dashboard with no per-prospect detail anywhere in it today;
  a reevaluated prospect that lands in `needs_review` already surfaces through the same
  `ProspectModal.jsx` used everywhere else, so no separate display was needed there.
- **Real-router integration tests added.** The original 9 tests only exercised a bare fake `llm`
  object. 5 new tests in `tests/test_qualification_review.py` (`RealRouterIntegrationTests`) now
  route `explain_ambiguous` through the actual `kairflow_intel.airouter.AIRouter` with
  `FakeGemini`/`FakeOllama` stand-ins borrowed from `test_ai_router.py`, confirming: the default
  policy really does send `research.qualification_review` to Gemini first; a real Gemini-call failure
  really does fall back to a single Ollama attempt and still produces a usable answer; an ungrounded
  answer from either provider is still rejected; `force_ollama` really does skip Gemini entirely; and
  a `qualified`/`rejected` result never calls the router at all. Full suite: **1116 tests, 0
  failures** after this addition (was 1111).

## 4. What is still explicitly out of scope / not done

- The Supabase RPC (`intel_agent_set_score`, `intel_agent_reeval_set_score`) schema was **not**
  modified — the new key lands inside the existing free-form `p_estimates` jsonb payload both RPCs
  already accept, so no migration is required for this addition.
- **No live network call to Gemini or Ollama was made or could be made** in this sandboxed session (no
  network egress) — this cannot be fixed from inside this sandbox. Section 3's new tests close the
  *routing/policy/fallback* gap (that part is now exercised against the real `AIRouter`, not just a
  bare fake), but they still talk to `FakeGemini`/`FakeOllama` stand-ins, not the real Gemini API. The
  user should run one real `research.qualification_review` call before trusting the AI-written
  explanation in production, per `PHASE_6_HANDOFF.md` §8 step 5. The deterministic fallback needs no
  such validation — it is pure string-building from data `scoring.py` already produced.

## 5. Audit fixes (verified against the real repo)

All of the below were checked against the actual Phase 5 repo (`scoring.py`, migrations), not hand-built fixtures.

- **Crash on real studio output (confirmed).** The earlier module read `item["criterion"]`, but `score_studio` names sub-items
  under `item`. For a real `needs_review` studio result with partially-credited items (the `pipeline_fit` case in
  `test_studio_scoring.py`) the old code raised `TypeError` (`", ".join` of `None`) outside any `try`, which would have failed
  `h_qualify`. Fixed, and covered by `RealScoringShapeTests`, which use real `score_studio` / `score_indie` results.
- **Indie rows are flat (confirmed).** `score_indie` rows are `{criterion, points, max, why}` with no `items`, and the
  needs_review reason for indie usually lives in `mandatory_gates`. The old fallback and model payload ignored both; they now
  use group-level partial credit, group-level `why`, and failed mandatory gates (names and reasons) as fallback content,
  model input and grounding source.
- **Grounding:** whole-word, lightly stemmed, >=70% of content words, numbers and mid-sentence capitalised names must appear in
  the source (verified evidence + breakdown + gate reasons + reason + uncertain list).
- **Privacy:** emails and phone numbers are redacted from the model payload.
- **Confidence:** the fallback reports no confidence (`null`), never a fixed `"low"`. New deterministic
  `confidence_indicator()` covers qualified / needs_review / rejected using the score margin and uncertain count, with a failed
  mandatory gate on a rejection = high. It uses `scoring.STUDIO_*` / `scoring.INDIE_*` constants (`score_studio` ignores
  campaign criteria, so criteria values must not be used). Stored as `p_estimates.qualification_confidence`, shown in the UI.
- **Cost control:** at most `KAIRFLOW_QUAL_REVIEW_MAX_PER_HOUR` (default 30; 0 disables) model notes per rolling hour per
  process; over the cap the deterministic note is used. A `held` studio result no longer triggers a model call.
- **Dates and year ranges were redacted as phone numbers (confirmed in the merge audit).** The phone pattern turned `2019-2023` and
  `2023-05-17` into `[phone]` in the evidence sent to the model, which removes the dates that active-development ambiguity depends on,
  and the redaction ran on the JSON text, where it could swallow the quote in front of an address. Redaction now runs per string before
  JSON encoding, and a number is treated as a phone only if it has >= 9 digits (>= 8 with a leading `+`) and does not start like an ISO date.
- **Valid model notes were rejected as ungrounded (confirmed in the merge audit).** The score and per-row points/max are sent to the model
  but were missing from the grounding source, so "5 of 15 points" or "score 60" always fell back to the deterministic note. They are now
  part of the source (thresholds are still not, so a note citing them is still rejected). `points`, `scored` and `credit(s)` join the
  scoring-vocabulary words that do not count as content words.

### Previously raised, now retracted or resolved
- *Future-dated migration:* not a bug. This project's whole migration series is stamped ahead of the system clock (through
  `20270104...`) and `20261115110000_...` sits in sequence between `20261115100000` and `20261116090000`.
- *UI-only approval gates:* enforced server-side. `intel_admin_review_prospect` (20261112140000) rejects indie approvals unless
  the model is `indie-project-v2`, every mandatory gate passed, score >= 75, contactability = pass and the prospect is
  unsuppressed; `intel_agent_reserve_send` (and later versions through the phase-8 final send boundary) enforces kill switch,
  suppression, `approved` state, active campaign and daily/campaign/follow-up caps.
