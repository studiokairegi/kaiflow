# KairFlow Intelligence — Production Gap Analysis

**Phase 1 audit | 12 November 2026**

This report distinguishes confirmed source-level facts from production conditions that cannot be verified from a ZIP snapshot.

## 1. Confirmed findings

### P1-01 — Worker environment template path is inconsistent and breaks tests

**Severity:** MEDIUM
**Status:** Confirmed defect (repository packaging / configuration documentation)

- The repository contains `.env.example` at the repository root, but no `intelligence-worker/.env.example`.
- The Windows worker setup is rooted in `intelligence-worker/`, and both test suites explicitly open `intelligence-worker/.env.example`.
- Node test `src/intelligence/phase11-security-contract.test.mjs:91-92` fails with `ENOENT`.
- Python tests `intelligence-worker/tests/test_phase7_integration.py:399-409` fail in two test cases with `FileNotFoundError`.
- The root `.env.example` also omits the AI router variables read by the current code: `KAIRFLOW_AI_D1`, `KAIRFLOW_AI_POLICY`, `KAIRFLOW_AI_FORCE_OLLAMA`, `KAIRFLOW_GEMINI_JSON_MODEL`, `KAIRFLOW_GEMINI_THINKING`, output-token controls, RPM/RPD budgets, draft reserve and daily cooldown.

**Impact:** Fresh setup is ambiguous and the repository's own test suite fails before any application logic is exercised.
**Remediation owner/phase:** Phase 2 setup/configuration hardening. Do not silently copy or edit the template during Phase 1.

### P1-02 — Conflicting worker/AI setup documentation

**Severity:** MEDIUM
**Status:** Confirmed documentation drift

- Root `README.md` describes Gemini as optional for Agent Chat only, gives `gemini-2.5-flash` as the default, and says research/classification/drafting remain local.
- Current code defaults structured output and Agent Chat to `gemini-3.8-flash` (`airouter.py:52-63`; `config.py:51-58,96-105`).
- Current routing defaults public discovery and research to Gemini-first (`airouter.py:44-45`), while D1=A keeps chat/drafting/classification local.
- `intelligence-worker/README.md` has a newer routing table but begins with wording that can be read as every AI call being Gemini-first; the actual code includes many deterministic operations that do not call an LLM.
- `airouter.py:1-4` and `jobs.py:36-43` also contain stale summary comments that conflict with the actual `DEFAULT_POLICY` and routed call sites.

**Impact:** Operators may configure or interpret provider behavior incorrectly. This also obscures the privacy boundary and which jobs truly use Gemini.

### P1-03 — Agent Chat lacks the approved Studio Kairegi knowledge context

**Severity:** MEDIUM
**Status:** Confirmed implementation gap relative to Phase 3 target

- `chat.py:98-113` defines a generic small-animation-studio system prompt.
- `chat.py:432-436` constructs the prompt from that template and the tool catalogue; it does not retrieve `intel_agent_kb` or another approved Studio Kairegi knowledge bundle.
- Drafting separately loads approved KB entries (`jobs.py:54-55,369-405`).

**Impact:** Agent Chat may answer studio-specific service, pricing, portfolio or positioning questions without the canonical approved facts. Provider switching alone will not fix this.

### P1-04 — Agent Chat lacks durable per-turn provider provenance

**Severity:** MEDIUM
**Status:** Confirmed implementation gap relative to Phase 2 target

- `chat.py:471` calls `d.llm.chat_json()` and keeps only the returned plan data.
- `FallbackLLM` stores `last_backend` and `last_chat` in process memory (`gemini.py:250-259`).
- Worker heartbeat stores only last provider/model convenience fields (`jobs.py:778-790`); initial `last_backend` is set to `ollama` before a chat call (`gemini.py:224-232`).

**Impact:** The application cannot reliably answer which provider/model handled a particular chat turn, whether Gemini was attempted, why fallback occurred, or which request produced a given result.

### P1-05 — Local Gemini request caps default to unlimited

**Severity:** MEDIUM
**Status:** Confirmed configuration default; operational risk depends on chosen quota/billing

- `RouterSettings.rpm` and `.rpd` default to `0` (no local cap) (`airouter.py:64-73`).
- `settings_from_env()` defaults both to zero (`airouter.py:153-164`).
- `RequestBudget` enforces limits only when non-zero (`airouter.py:167-198`).

**Impact:** The code supports configurable request caps but a default install has no local RPM/RPD guard. Provider 429 responses and cooldowns remain, but they are not a hard configured spend budget.

### P1-06 — AI-assisted qualification explanation is not implemented

**Severity:** MEDIUM
**Status:** Confirmed current behavior; later-roadmap gap, not a Phase 1 regression

- Indie qualification is a deterministic project-first rubric (`research.py:479-559`; `scoring.py`).
- Studio qualification is also deterministic (`research.py:423-476`).
- No Gemini/Ollama call interprets ambiguous qualification evidence or writes a model explanation.

**Impact:** This preserves predictable business gates, but it does not yet deliver the roadmap's Phase 6 AI-assisted interpretation/explanation capability. Any future AI assistance must remain advisory and must not replace deterministic gates.

### P1-07 — Multiple email provider systems need explicit ownership boundaries

**Severity:** LOW / architecture complexity
**Status:** Confirmed architecture; not a defect

- Intelligence worker registry: Gmail, Zoho and SMTP (`intelligence-worker/kairflow_intel/providers/registry.py:44-79`).
- General CRM Inbox: separate TypeScript adapter contract/registry (`supabase/functions/_shared/email_adapter.ts`, `email_adapter_registry.ts`). Its shared-account architecture note says provider capabilities remain disabled pending an authenticated gateway and acceptance (`docs/EMAIL_ADAPTER_ARCHITECTURE.md`).
- Resend is a separate transactional/delivery path and is excluded from the worker prospect adapter registry.

**Impact:** Future work must preserve these boundaries and avoid treating one registry's capabilities as evidence that another runtime can send or sync.

## 2. Suspected or not yet established

### P1-S01 — Production migration state may differ from repository

**Status:** Unable to verify

The snapshot has 135 canonical `supabase/migrations/*.sql` files, six `remote_applied_placeholder` files, several backup artifacts with non-`.sql` suffixes, and 58 root-level SQL files. There are no duplicate 14-digit version prefixes among the canonical `*.sql` migration files. No linked Supabase project, CLI or database was available, so the hosted migration ledger and actual deployed function definitions are unknown. Do not blindly run `supabase db push`.

### P1-S02 — Deployed Edge Functions may differ from source

**Status:** Unable to verify

The repository has 35 Edge Function folders and `supabase/config.toml`, but no deployed function inventory or project credentials. Deployment parity is unknown.

### P1-S03 — Actual provider health / real account acceptance

**Status:** Unable to verify

No `worker.env`, Gemini key, Supabase credentials, worker log, provider account credentials or runtime records were present. No live Gemini, Ollama, Gmail, Zoho, SMTP or Resend request was made.

### P1-S04 — Current Git branch / dirty worktree

**Status:** Unable to verify

The supplied ZIP has no `.git` directory or usable commit metadata. The roadmap's `main` branch cannot be confirmed from this snapshot; a source ZIP cannot establish current branch, commit or uncommitted changes.

## 3. Not found in source inspection

- No evidence that the AI model can directly execute SQL, shell commands or provider sends. Agent Chat returns structured plans and Python validates the fixed tool allowlist before calling RPCs.
- No evidence that model output is allowed to override the database final-send boundary.
- No evidence that Resend is installed in the active Intelligence worker adapter registry; it is deliberately excluded.
- No duplicate canonical migration version prefixes were found in the supplied `supabase/migrations/*.sql` list.

These are source-level observations only, not live security certification.

## 4. Production readiness blockers

1. Reconcile the hosted Supabase migration ledger and verify the actual deployed schema/RPC signatures.
2. Validate all required Edge Functions, auth modes and deployed versions in staging.
3. Resolve the worker `.env.example` path and refresh the single source of truth for environment documentation.
4. Align README/provider-routing documentation with the actual router and D1 privacy model.
5. Decide and document approved Gemini workloads, then set finite local RPM/RPD or spend budgets.
6. Implement Agent Chat KB retrieval and durable per-turn AI provenance.
7. Run real Gemini connectivity/model/quota checks using an explicitly authorized, cost-controlled health prompt.
8. Validate real provider account connect/health/sync/send/reconciliation with non-production mailboxes while all sending gates are OFF; only then perform a separately approved controlled send test.
9. Run frontend production build, SQL migration execution, Edge Function type/runtime validation and browser end-to-end tests in staging.
10. Preserve all human approval, suppression, consent, provider assignment, kill-switch, quota and final-send controls.

## 5. Recommended phase mapping

| Phase | Priority work |
|---|---|
| 2 | Consolidate env template/docs; validate Gemini endpoint/model/quota; set budgets; persist provider/model/latency/fallback provenance; add fallback tests |
| 3 | Build approved Studio Kairegi KB retrieval for Agent Chat; preserve D1 privacy and authorization boundaries |
| 4 | Validate controller/worker leases, retries, restarts and persisted job outcomes against staging Supabase |
| 5 | Improve source-specific evidence coverage and research quality; add tests for genuine prospects and verified facts |
| 6 | Add advisory AI interpretation for ambiguous qualification and evidence-based outreach/follow-ups; deterministic gates remain authoritative |
| 7 | End-to-end staging acceptance, browser tests, provider acceptance, metrics, rollback and explicitly approved rollout |
