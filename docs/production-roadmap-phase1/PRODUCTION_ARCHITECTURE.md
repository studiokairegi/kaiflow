# KairFlow Intelligence — Production Architecture

**Phase:** 1 — Architecture Audit and Production Blueprint
**Audit date:** 12 November 2026
**Repository snapshot:** `KairFlow_Indie_V2_Indie_Campaign_Confirmed_Bugfixes.zip`
**Input SHA-256:** `21a64499dab67914b85e464985706969950b899351e6555c93a4226af191b23e`

## 1. Executive architecture summary

KairFlow Intelligence is a local-worker / Supabase-coordinated system embedded in the Studio Kairegi React application. The browser is the administrative control surface; the local Python worker performs scheduled discovery, public-page research, deterministic qualification, AI-assisted extraction and drafting, mailbox synchronization, classification, follow-up orchestration and approved dispatch. Supabase is the durable system of record and job queue. Provider credentials are held by the trusted worker / Edge Function paths, not exposed to the browser.

The current architecture has these principal boundaries:

1. **Frontend:** React/Vite application, with the Intelligence module under `src/intelligence/` and the main route in `src/App.jsx`.
2. **Control plane:** Supabase Auth, PostgREST RPCs, RLS-protected tables and 35 Edge Functions under `supabase/functions/`.
3. **Worker plane:** local Python process under `intelligence-worker/kairflow_intel/`, supervised by the loopback controller in `intelligence-worker/controller.py` or one of the documented Windows service/scheduled-task modes.
4. **AI plane:** shared `FallbackLLM` / `AIRouter`, with Gemini for selected approved public-data call sites and Ollama as the local provider/fallback. The default privacy decision keeps private correspondence, CRM personal data and Agent Chat history on Ollama.
5. **Communication plane:** a code-installed, account-scoped Intelligence adapter registry for Gmail, Zoho and SMTP; a separate General Inbox TypeScript adapter system; and separate Resend transactional / delivery paths.

No single component is intended to make authorization, suppression, qualification, consent, approval or final-send decisions using model output. Those remain deterministic Python/database rules.

## 2. Component inventory

| Layer | Principal files | Responsibility |
|---|---|---|
| React application shell | `src/App.jsx`, `src/supabaseClient.js` | Workspace routing, authenticated Supabase client, Intelligence access check |
| Intelligence UI | `src/intelligence/IntelligenceModule.jsx`, `ChatView.jsx`, `CampaignView.jsx`, `ProspectsView.jsx`, `OutreachView.jsx`, `LogsView.jsx`, `SettingsView.jsx` | Admin interface for campaigns, prospects, chat, drafts, logs, settings, provider accounts and worker controls |
| Intelligence frontend API | `src/intelligence/api.js`, `src/intelligence/access.js` | `intel_admin_*` RPC writes and RLS-protected table reads; fail-closed access check |
| Local controller | `intelligence-worker/controller.py`, `intelligence-worker/windows/*` | Starts/stops local worker; loopback-only API, origin checks and per-install bearer token |
| Worker entrypoints | `intelligence-worker/kairflow_intel/__main__.py`, `main.py`, `jobs.py` | CLI, dependency construction, worker polling, scheduling and job dispatch |
| AI providers | `gemini.py`, `ollama.py`, `airouter.py`, `ai_call.py`, `ai_types.py` | Provider clients, route policy, fallback, schema validation and provenance |
| Prospect discovery | `sources.py`, `discovery.py`, `manual_post.py`, `profile.py`, `gdelt.py`, `feeds.py`, `wikidata.py`, `commoncrawl.py`, `anilist.py` | Steam/itch project discovery, manual Kickstarter intake, studio source discovery and evidence intake |
| Research / scoring | `research.py`, `siteanalysis.py`, `indie_evidence.py`, `signals.py`, `scoring.py`, `contactability.py` | Public-page retrieval, evidence extraction, contact discovery, deterministic qualification and contactability |
| Drafting / conversation | `drafting.py`, `takeover.py`, `chat.py`, `classify.py`, `policy.py` | Evidence-grounded draft composition, CRM takeover, Agent Chat tools, inbound classification and outbound policy validation |
| Email transport | `providers/base.py`, `providers/registry.py`, `providers/router.py`, `providers/gmail.py`, `providers/zoho.py`, `providers/smtp.py`, `mailops.py` | Provider-neutral, account-assigned send and receive/sync operations |
| Supabase schema and policy | `supabase/migrations/*.sql` | Intelligence tables, auth, RLS, RPCs, job leases, provider registry, send gates and audit trail |
| Edge Functions | `supabase/functions/*/index.ts`, `_shared/*` | OAuth, provider health/token, Resend, Inbox, portal, attachments, payment and other server-side integrations |

## 3. Authentication and trust boundaries

### 3.1 Administrator/browser

- The frontend asks `intel_is_authorized()` before displaying Intelligence. `src/intelligence/access.js:1-25` treats anything except literal `true` as denied.
- Database authorization requires the signed-in user to be an administrator **and** have an active `master_user` membership (`supabase/migrations/20261108130000_intelligence_authorization.sql:1-24,71-147`).
- Intelligence UI writes use `intel_admin_*` RPCs (`src/intelligence/api.js:1-7,15-57`). Table reads use Supabase queries and rely on RLS (`src/intelligence/api.js:87-96`).
- `IntelligenceModule` rechecks the access result before mounting (`src/intelligence/IntelligenceModule.jsx:1-3,106-109`). The UI gate is not the security boundary; RLS and RPC authorization are.

### 3.2 Local worker

- The worker signs into Supabase using a separate limited agent account; it is not intended to be an administrator or studio member. The worker uses `intel_agent_*` RPCs.
- `main.build()` constructs the Supabase agent, mail adapter, Gemini/Ollama clients and shared AI router (`intelligence-worker/kairflow_intel/main.py:22-44`).
- The worker does not receive the Supabase service-role key. Its agent identity is checked by database-side `intel_agent_org()` and related functions.
- Worker configuration is local environment / Windows Credential Manager. Gemini key lookup is `KAIRFLOW_GEMINI_API_KEY` or the `kairflow-intelligence-gemini` keyring entry (`config.py:70-105`).

### 3.3 Edge Functions

- Privileged Intelligence Edge Functions are expected to authenticate the caller's JWT using the anon key, then call `intel_is_authorized()` before service-role work (`supabase/functions/_shared/intel_auth.ts:1-46`).
- `supabase/config.toml` explicitly disables JWT verification only for routes designed for signed webhooks, one-time OAuth/capability links or public token workflows. Those functions must enforce their own signatures/tokens as documented in their handlers.

## 4. Worker runtime and job lifecycle

- `main.py` builds `Deps`, creates `Worker`, acquires a machine-wide process lock and enters `run_forever()` (`main.py:22-44,170-200`).
- The controller binds to `127.0.0.1:17843`, accepts a short allowlist of origins, requires a per-install bearer token and only allows Ollama URLs that resolve to loopback (`controller.py:24-33,75-87,115-145`).
- Worker job handlers are registered in `jobs.py:728-732`: discovery, source seeding, research, site analysis, qualification, lead resolution, drafting, sending, mailbox sync, classification, reconciliation, follow-up scan, retention, Agent Chat, CRM takeover and studio reevaluation.
- `Worker.periodic()` enqueues mail sync every 120 seconds, reconciliation every 300 seconds, classification every 120 seconds, follow-up scan hourly and retention daily. Active campaigns receive discovery; the animation-studio campaign additionally schedules weekly source seeding, daily news, six-hourly feeds and monthly Common Crawl (`jobs.py:792-817`).
- Jobs are claimed through `intel_agent_claim_job` with a 300-second lease. The worker renews leases, completes only while ownership remains valid, retries transient failures with backoff and records permanent/unknown outcomes (`jobs.py:771-917`).
- Queue state is durable in Supabase; the local worker is an executor, not the system of record.

## 5. Prospect lifecycle

### 5.1 Indie Game Developers

1. Campaign configuration provides explicit Steam/itch sources and keywords.
2. `h_discover()` validates campaign/source settings and calls `sources.discover_batch()` (`jobs.py:58-100`).
3. `sources.py` performs Steam and itch page parsing (`sources.py:37-45,136-160,202-266,269-300`). Kickstarter is a separate manual intake path; it does not fetch Kickstarter pages (`discovery.py:310-369`).
4. Candidate data is upserted and source/project records are written (`jobs.py:103-145`).
5. Research uses public developer/project sources, evidence extraction, contact discovery and narrow AI entity extraction (`jobs.py:154-194`; `research.py:40-43,195-239`).
6. `research.qualify()` applies deterministic Indie evidence gates and scoring, then stores the result (`jobs.py:197-207`; `research.py:479-559`; `scoring.py`).
7. Qualified/contactable prospects are resolved to CRM leads (`jobs.py:209-214`).
8. Drafting uses approved KB entries, verified evidence and policy validators (`jobs.py:348-445`; `drafting.py`).
9. Outbound delivery requires database reservation, account assignment, purpose/consent checks, a send slot and final `mark_sending` gate before the provider call (`mailops.py:40-132`; `jobs.py:512-546`; migration `20261128100000_intelligence_phase8_final_send_boundary.sql`).

### 5.2 Animation Studio Support

- Discovery uses Wikidata/source seeding, configured studio profile terms, GDELT news, RSS/feed polling, Common Crawl and manual-post intake (`discovery.py:120-125,185-275,278-307`; `jobs.py:792-814`).
- Some discovery helpers use AI for headline organization extraction, manual post interpretation and proposed profile terms. Other discovery work is deterministic.
- Public website research and contact extraction are followed by deterministic studio qualification and reevaluation logic.

## 6. Agent Chat lifecycle

1. React `ChatView` creates a thread and sends a message (`src/intelligence/ChatView.jsx:38-48`).
2. `intel_admin_chat_send` stores the request and enqueues a `chat` job (`supabase/migrations/20261109140000_intelligence_v1_completion.sql:354-377`).
3. Worker `h_chat()` dispatches to `chat.handle()` (`jobs.py:687-690,728-732`).
4. The worker retrieves the authorized request and recent history, then constructs a fixed system prompt and allowlisted tool catalogue (`chat.py:419-436`; `chat.py:98-113`).
5. The model proposes a reply or one of a fixed set of tools. Python validates tool names/arguments and calls database RPCs; tool results are wrapped as untrusted data (`chat.py:446-495`).
6. The worker stores the answer with `intel_agent_chat_reply`; the frontend polls for it (`chat.py:402-416,496-510`; `ChatView.jsx:15-16,31-35`).
7. Consequential proposed changes require administrator confirmation; Agent Chat cannot send email.

## 7. Email provider architecture — preserve the boundaries

There are **separate provider systems**; do not merge them casually.

### 7.1 Intelligence outreach worker registry

- `providers/registry.py:44-79` installs Gmail, Zoho and SMTP adapters.
- `providers/router.py:6-28` resolves the adapter from the durable message `provider_key` + `provider_account_id`. A partial assignment fails closed; legacy fallback is used only if both fields are absent.
- Provider manifest purpose limits are enforced. Zoho is business-correspondence only; Gmail and SMTP can support consented prospecting according to account-level and global gates.
- SMTP is send-only; Gmail/Zoho support mailbox synchronization.
- Provider account records and credentials are held in `intel_provider_accounts`; the UI controls account-level state. Provider accounts are disabled by default.

### 7.2 General CRM Inbox TypeScript registry

- The separate contract and registry are `supabase/functions/_shared/email_adapter.ts` and `email_adapter_registry.ts`.
- The shared Inbox registry is a distinct runtime from the Python Intelligence worker. The architecture note says Gmail/Zoho/SMTP Inbox capabilities remain disabled until the authenticated gateway and tested adapters are complete (`docs/EMAIL_ADAPTER_ARCHITECTURE.md`).
- The compiled Resend adapter remains for historical compatibility, but its Inbox registry row and send flag are disabled by migration `20261227110000_email_shared_intelligence_accounts.sql`.

### 7.3 Resend

- Resend transactional / delivery / inbound paths remain separate Edge Functions (`intel-resend-send`, `intel-resend-webhook`, shared Resend logic).
- Resend is deliberately excluded from the active Intelligence worker registry. A legacy `ResendClient` file and conditional handling remain in the source tree, but the normal registry cannot select it.
- Preserve this separation unless a later phase explicitly changes provider responsibility and migration design.

## 8. Data and persistence model

Core Intelligence entities include:

- Settings and campaign configuration: `intel_settings`, `intel_campaigns`.
- Prospects and research: `intel_prospects`, `intel_evidence`, `intel_evidence_versions`, `intel_entity_aliases`, `intel_source_items`, `intel_sources`.
- Queue and observability: `intel_jobs`, `intel_worker_heartbeat`, `intel_actions`.
- Communication: `intel_messages`, `intel_chat_threads`, `intel_chat_messages`, `intel_chat_actions`, `intel_lead_history`.
- Policy and providers: `intel_suppressions`, `intel_contact_permissions`, `intel_email_provider_registry`, `intel_provider_accounts`, `intel_provider_account_usage`, `intel_delivery_events`.
- Knowledge: `intel_kb`.
- Reevaluation: `intel_reeval_runs`, `intel_reeval_items`, `intel_score_history`.

The authoritative schema and RPC definitions are in `supabase/migrations/`. The snapshot contains 135 canonical `*.sql` migration files in that directory. There are also loose root-level SQL files and non-`.sql` backup artifacts; do not treat those as the canonical Supabase migration sequence.

## 9. Non-negotiable safeguards already present in source

- Admin + active Master User authorization, RLS and RPC guards.
- Separate worker identity and worker-only RPC boundary.
- Source registry enablement, confirmed terms, budgets and circuit state.
- Verified evidence and deterministic qualification gates.
- Exact-recipient contact permission for prospecting.
- Suppression, unsubscribe, bounce and complaint checks.
- Provider account assignment, account quotas, global pacing and purpose checks.
- Human approval and final database send boundary immediately before provider submission.
- Unknown provider outcome is not automatically resent; it is reconciled or manually resolved.
- Worker process singleton, durable job leases, retries and failure logs.

These controls are source-level observations, not a claim that the deployed database has every migration applied. Live schema reconciliation remains required.
