# Provider Failure Tests

**All results below are MOCKED (fake HTTP session / fake clients). None involved real Gemini or real Ollama.**

| Suite | Result |
|---|---|
| `python -m unittest discover` (worker) | **916 run, 0 failures, 0 errors** (Phase 1 baseline: 911 run, 2 errors from the missing `.env.example`) |
| `npm test` (Node) | **1142 pass, 0 fail** (baseline 1141/1) |
| Not run | Vite build, SQL migrations, Deno Edge Functions, browser E2E, any live provider |

Existing tests (`test_ai_router.py`, `test_gemini.py`, 59 tests) cover: each fallback trigger (429 minute/daily, 408, 5xx, timeout, connection, empty, truncated, blocked, invalid JSON, schema-invalid, unexpected exception) causing exactly one Ollama attempt; both providers failing raises Ollama's error with no loop; Retry-After honoured; daily-quota cooldown; permanent-error 600 s pause; outage pause after 3 consecutive failures; repeated bare 429s escalating to daily exhaustion; rollback flag; D1=A/C routing; RPM/RPD caps incl. failed attempts and drafting reserve; provenance per call under concurrency; key absent from URLs/errors/logs/results; `model_reported` mismatch recorded.
New in Phase 2: template validates as a configuration with D1=C, 10 RPM, 200 RPD and blank key; D1=C sends chat to Gemini by default but not drafting/classification; fast-model selection and validation; 10/min and 200/day caps hold.

**Gate status:** real Gemini request succeeding: **NOT MET** (not attempted). Real Ollama fallback: **NOT MET** (mocked only). Routing traceability and cost-control logic: verified by mocked tests only.
