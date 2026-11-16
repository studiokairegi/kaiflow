# AI Provider Architecture (Phase 2, 12 Nov 2026)

**Finding:** the single provider-routing layer the roadmap asks for already exists and was verified, not rebuilt (global rule 3).

- `FallbackLLM` (`gemini.py`) wraps one `AIRouter` (`airouter.py`). Every worker AI call (14 call-site tags in `main.ROUTED_SITES`) goes through it. `GeminiClient` and `OllamaClient` sit behind it; business logic never calls either directly.
- Per call: policy resolution (`resolve`) -> one Gemini attempt if policy, D1, cooldowns and local budget allow -> otherwise exactly one Ollama attempt. No loops; partial Gemini output is discarded; both providers pass the same schema validator.
- Every result is an `AIResult` carrying `provider`, exact `model`, `model_reported`, `site`, `route_reason` (why Ollama served: policy, D1, cooldown, budget, or the Gemini failure kind), `gemini_attempted`, `finish_reason`, token usage. `ai_call.py` turns this into the `{provider, model, site, fallback_reason}` record stored with job results, so a fallback never pretends to be Gemini.
- Deterministic safeguards (permissions, suppression, approval, caps, kill switch) are not touched by the router.
- Keys: read server-side from `KAIRFLOW_GEMINI_API_KEY`, sent only in the `x-goog-api-key` header to a fixed Google host; existing tests assert the key is absent from URLs, errors, logs and results.

## Changes made in Phase 2
1. **Created `intelligence-worker/.env.example`** (was missing: fixed P1-01 / N-02 and both previously failing test suites). Contains every `KAIRFLOW_AI_*` / `KAIRFLOW_GEMINI_*` variable the code reads and the owner decisions below.
2. **Resolved N-03:** root `.env.example` no longer says "use a billing-enabled project"; worker template and README now say free tier only, never enable billing, and state the data-use consequence of D1=C.
3. **F-07:** optional `KAIRFLOW_GEMINI_FAST_MODEL`. `fast=True` structured calls use it when set; blank keeps previous behaviour. Exact IDs only, `latest` aliases rejected. No Flash-Lite model is selected: that needs the benchmark.
4. New tests `tests/test_phase2_provider_infra.py` (5 tests).
5. Owner-run `scripts/phase2_gemini_benchmark.py` (real calls, synthetic prompts, paced under the RPM cap).

## Owner decisions recorded (12 Nov 2026)
| Decision | Answer | Effect |
|---|---|---|
| Tier | Free tier only, no billing | No paid path; code has none (tested) |
| D1 | **C** (private data may go to Gemini unredacted) | See risk below |
| Local caps | 10 RPM, 200 RPD, no spend | Template values; enforced by `RequestBudget` |
| Gemini advising qualification | not asked | Stays advisory/deferred to Phase 6 |

**Risk to keep visible:** on the free tier, Google may use prompts to improve its products (the repo's own claim; Google's current terms were not re-checked). With D1=C and private groups opted in, Agent Chat history, CRM contact records and email text would be sent under those terms. D1=C with a key set sends **Agent Chat** (history and CRM tool results) to Gemini by default; drafting and classification move only when listed in `KAIRFLOW_AI_POLICY`. To keep chat local use `chat=ollama` in the policy or D1=A. Rollback: `KAIRFLOW_AI_D1=A` or `KAIRFLOW_AI_FORCE_OLLAMA=1`, restart worker.
