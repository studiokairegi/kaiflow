# KairFlow Intelligence — AI Routing Audit

**Phase 1 source-level routing audit | 12 November 2026**

## 1. Executive finding

The repository contains a shared Gemini/Ollama adapter and route policy. It does **not** route every task to Gemini. The default privacy policy deliberately keeps `drafting`, `classification` and `chat` local, while selected public-data `discovery` and `research` call sites are Gemini-first. A large part of KairFlow's prospecting pipeline is deterministic and bypasses both providers.

This is a source-code expectation, not a live execution report. No API key, worker environment, production log or execution record was present in the supplied snapshot. The actual production provider for every task remains **unable to verify**.

## 2. Shared router

- Construction: `intelligence-worker/kairflow_intel/main.py:22-44` creates `GeminiClient` only when a key is found, creates `OllamaClient`, then wraps both in `FallbackLLM`.
- Policy: `airouter.py:37-52,125-164` defines groups, private groups, default policy and exact model IDs.
- Default policy: `discovery=gemini_first`, `research=gemini_first`; other groups use their default route.
- Privacy: `d1` defaults to `A`; `PRIVATE_GROUPS` are `drafting`, `classification`, `chat` (`airouter.py:37-38,134-138`). Those groups route to Ollama unless D1=C (`airouter.py:226-248`). D1=B is rejected because redaction mode is not implemented.
- Fallback: at most one Gemini attempt followed by one Ollama attempt; Gemini output is discarded on failure and both providers share schema validation (`airouter.py:263-313`).
- Failure handling: rate-limit, outage and permanent-error cooldowns are tracked in memory (`airouter.py:320-380`).
- Model: `gemini-3.8-flash` is the code default for structured output and Agent Chat (`airouter.py:52-63`; `config.py:51-58,96-105`). `fast=True` changes output budget, not model family.
- Local request budget: code supports `KAIRFLOW_GEMINI_RPM` and `KAIRFLOW_GEMINI_RPD`, but both default to `0` (no local cap); the router then relies on provider responses (`airouter.py:64-73,153-164,167-198`).

## 3. Task-by-task routing matrix

| Task | Model call exists? | Source-level route by default | Data class | Production provider observed? |
|---|---|---|---|---|
| Agent Chat planning | Yes, `chat.plan` | Ollama only under default D1=A; Gemini-first only with D1=C and route allowed | Private chat history and CRM tool results | **Unable to verify** |
| Indie Steam discovery | No | Deterministic Steam parser | Public store pages | N/A |
| Indie itch discovery | No | Deterministic itch parser | Public project pages | N/A |
| Kickstarter intake | No model call for intake itself | Admin-submitted URL/metadata; manual-only, no Kickstarter fetch | Admin-supplied public project metadata | N/A |
| Animation Studio seed discovery | Mostly no | Wikidata/source parsers and deterministic dedupe | Public business data | N/A for deterministic stages |
| Studio GDELT headline extraction | Yes, `discovery.news` | Gemini-first, then Ollama | Public headlines only | **Unable to verify** |
| Manual post analysis | Yes, `discovery.manual_post` | Gemini-first, then Ollama (except deterministic/Kickstarter special path) | Pasted/public post text | **Unable to verify** |
| Studio profile term proposal | Yes, `discovery.studio_profile` | Gemini-first, then Ollama | Admin-provided studio description | **Unable to verify** |
| Public prospect website contact extraction | Yes, `research.entity` | Gemini-first, then Ollama | Public website text | **Unable to verify** |
| Studio reevaluation contact extraction | Yes, `research.studio_reeval` | Gemini-first, then Ollama | Public website text | **Unable to verify** |
| Evidence/signal extraction | No | Deterministic parsing and evidence rules | Public page text | N/A |
| Site analysis | No general LLM call | Deterministic analysis | Public website facts | N/A |
| Indie qualification/scoring | No | Deterministic project-first rubric | Verified evidence and contactability | N/A |
| Studio qualification/scoring | No | Deterministic scoring rubric | Verified evidence and criteria | N/A |
| Contactability/suppression/consent | No | Deterministic Python + SQL RPCs | Contact and policy records | N/A |
| Initial outreach drafting | Yes | Ollama only under D1=A; Gemini possible under D1=C + drafting Gemini-first policy | Private CRM/contact and approved KB/evidence | **Unable to verify** |
| Follow-up / re-engagement drafting | Yes | Same as initial drafting | Private conversation history and prospect data | **Unable to verify** |
| Reply drafting | Yes | Ollama only under D1=A; Gemini possible only with D1=C + route | Inbound email content | **Unable to verify** |
| Inbound classification | Yes for ambiguous cases; deterministic hard gates first | Ollama only under D1=A; Gemini possible only with D1=C + route | Private inbound email | **Unable to verify** |
| Follow-up candidate selection | No | Deterministic SQL candidate RPC | CRM and schedule data | N/A |
| Lead resolution/linking | No | Deterministic RPC | CRM records | N/A |
| Worker scheduling, permissions, approval, send decision | No | Deterministic Python/SQL | Operational and policy data | N/A |

**Code references:** `jobs.py:58-214,348-445,512-546,570-690,702-732`; `discovery.py:24-45,278-307,310-369`; `sources.py:37-45,136-160,202-300`; `research.py:40-43,195-239,479-559`; `scoring.py`; `classify.py:17-70`; `airouter.py:37-52,125-164,226-313`.

## 4. What Gemini is actually asked to do

The most important research call is deliberately narrow. `research.entity_llm()` asks only for a named contact and role from page text (`research.py:31-43`). The broader public-page pipeline fetches pages, extracts dated events/signals and contact emails deterministically (`research.py:195-239`). The model's contact extraction provenance is stored separately and is explicitly not read by scoring (`research.py:225-234`).

For Indie qualification, `research.qualify()` constructs verified project metadata and calls `scoring.score_indie()`; it does not call Gemini or Ollama (`research.py:479-559`). This is a deterministic evidence-first design. It is safe and explainable, but it does not yet satisfy the roadmap's later Phase 6 goal of AI-assisted interpretation of ambiguous evidence and natural-language qualification explanations.

## 5. Agent Chat provenance and context

- `FallbackLLM.chat_json()` captures provider/model/route reason in process memory (`gemini.py:250-259`).
- `chat.handle()` calls `d.llm.chat_json()` and receives only the plan data (`chat.py:466-495`). It does not persist the `AIResult` provider/model/route reason with the chat message.
- Worker heartbeat includes `chat_llm` and `chat_model`, but those are only last-chat convenience fields (`jobs.py:778-790`). `last_backend` starts as `ollama` before any request (`gemini.py:224-232`).
- `chat.py` constructs a generic system prompt and does not load the approved Studio Kairegi KB (`chat.py:98-113,432-436`).
- When the model is unavailable or cannot produce a usable plan, the worker may summarize tool results or use deterministic keyword matching; those answers are not generated by Gemini or Ollama (`chat.py:496-510`).

## 6. Provenance elsewhere

`ai_call.py:16-57` carries provider, model, site, fallback reason and model-reported identifier for routed structured calls. Draft composition stamps the call provenance on the draft; research stores AI extraction metadata. The chat path is the notable gap: it does not persist the same per-turn record.

## 7. Live verification status

| Check | Result |
|---|---|
| Gemini adapter exists | Confirmed in source |
| Shared router and Ollama fallback exist | Confirmed in source |
| Default public discovery/research routing | Confirmed in source |
| Private task routing under D1=A | Confirmed in source |
| Gemini API key present in audit environment | No |
| Live Gemini API request | Not performed |
| Actual production model/provider for recent requests | Unable to verify |
| Production quota / billing / rate limits | Unable to verify |
| Actual deployed worker version | Unable to verify |
| Controlled benchmark | Not run; no authorized live key/quota |

The unit tests exercise mocked provider responses and fallback cases. They do not establish successful Google API access.

## 8. Routing-related gaps to address in later phases

1. Decide and document the explicit approved Gemini workload matrix; keep private groups local until privacy review and explicit owner consent.
2. Provide durable per-turn Agent Chat provenance (provider, model, route reason, latency, error kind and correlation ID) without storing prompts/secrets in logs.
3. Load a centrally approved Studio Kairegi knowledge bundle into Agent Chat retrieval.
4. Set and test finite RPM/RPD or cost budgets before expanding Gemini traffic; current code defaults to no local cap.
5. Add AI-assisted interpretation/explanations only for ambiguous qualification evidence; keep final scoring and every safety decision deterministic.
6. Run a real, minimal, non-private Gemini health request only after the user authorizes use of the configured key and the billing/quota implications are known.
