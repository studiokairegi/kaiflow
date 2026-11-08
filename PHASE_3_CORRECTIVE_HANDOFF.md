# KairFlow Intelligence — Phase 3 Corrective Pass

**Date:** 8 November 2026
**Scope:** Correct all actionable source-code and documentation defects recorded in `KairFlow_Phase3_Line_by_Line_Audit.md`. Phase 2 remains the production reference. Phase 4 was not started.

## 1. Findings corrected

| Audit finding | Correction |
|---|---|
| P1 — Japanese opt-out wording could miss deterministic unsubscribe handling | Expanded shared inbound policy patterns for natural Japanese opt-out wording. Hard classification now wins over a positive model classification. Quoted historical opt-out text remains excluded from the sender's new message. |
| P1 — Japanese delivery/deadline wording could miss escalation | Expanded deadline and availability patterns for 納品, 納入, いつまで, いつ頃, いつから, 対応できますか, 稼働 and related schedule/commitment terms. The shared classifier and Japanese composer both fail closed to human review. |
| P2 — Short Japanese replies could be routed to English | Language selection now evaluates only the sender's unquoted new text, recognizes short kana-based acknowledgements such as はい and お願いします, and lets a clear current English response override older Japanese context. |
| P2 — Quoted thread content could influence language selection | Quoted lines and attribution content are removed before language detection; an empty new body falls back to the subject and then the latest inbound history. |
| P2 — Japanese greeting regex failed on no-space honorifics | Salutation recognition now handles 佐藤様, 佐藤 花子様, 山田先生, ご担当者様 and 御中. Grounding preprocessing removes these greeting lines. |
| P2 — Recipient/company names were not programmatically checked | Japanese drafts now fail closed if a supplied contact name is not preserved exactly in the greeting with a Japanese honorific. For initial, follow-up and re-engagement outreach, the verified company name must appear exactly in the subject; reply subjects retain the actual conversation thread subject. Generic business greetings remain allowed when no contact name is supplied. |
| P2 — Japanese reply relevance checks were too narrow | Expanded request/response phrase families for portfolios, samples, links, attachments, meetings and information requests. Unrecognized or ambiguous requests remain manual-review cases. Added varied positive and negative fixtures. |
| P3 — Duplicate setup-guide step number | Renumbered the worker registration, campaign activation and send-enablement steps. |

## 2. Files changed in this corrective pass

- `intelligence-worker/kairflow_intel/policy.py`
- `intelligence-worker/kairflow_intel/drafting.py`
- `intelligence-worker/tests/test_phase3_japanese.py`
- `docs/INTELLIGENCE_SETUP.md`
- `PHASE_3_HANDOFF.md` (updated with this corrective-pass status)
- `PHASE_3_CORRECTIVE_HANDOFF.md` (this report)

No database migrations, schema changes, frontend changes, worker architecture changes, or send-boundary changes were made.

## 3. Verification

| Check | Result |
|---|---:|
| Python compile check | Passed |
| Phase 3 Japanese targeted tests | **30 passed** |
| Full Python worker suite | **303 passed** |
| Full JavaScript suite | **750 passed, 0 failed** |
| `npm run build` | **Not verified** — `vite: not found` (dependencies are not installed in this environment) |
| Phase 2 regression | Existing Python and JavaScript suites passed |
| Production database / migrations | Not touched |

The Python test runner prints a traceback for a deliberately injected `ValueError: boom` in an existing worker error-handling test; the suite reports `OK` and all 303 tests pass.

## 4. Acceptance work that cannot be truthfully marked complete here

Two audit items are validation gates rather than source defects:

1. **Live local-model evaluation:** the Ollama executable/runtime is not available in this environment. Representative Japanese initial, follow-up, re-engagement and reply outputs therefore could not be generated using the actual configured model.
2. **Native Japanese business-language review:** no qualified native reviewer is available in this environment. Fluency, grammar, politeness, anime-production terminology, factual accuracy and personalization cannot be certified from mocked tests.

The frontend production build also remains unverified until dependencies are installed in the normal project environment and `npm run build` succeeds.

Do not mark Japanese-language quality production-ready until the actual local model outputs have been reviewed by a native Japanese business-language reviewer. Do not claim the frontend production build passed.

## 5. Safety and phase boundary

- Model-written drafts remain pending human approval (`auto_ok=false`).
- No email was sent.
- No deployment, Git push, worker activation, autonomy change, provider operation, migration application or production database modification occurred.
- Phase 2 English paths and existing sending controls were preserved.
- Phase 4 was not started.

**Disposition:** All actionable code/documentation findings in the line-by-line audit have been corrected and the automated regression suites pass. Phase 3 is not yet eligible for final production acceptance until live Ollama output review, native Japanese quality review and a successful production build are completed.
