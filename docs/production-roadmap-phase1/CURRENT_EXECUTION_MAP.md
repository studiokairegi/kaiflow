# KairFlow Intelligence — Current Execution Map

**Phase 1 read-only map | 12 November 2026**

## 1. Agent Chat path

```text
React UI
  src/intelligence/ChatView.jsx
    -> src/intelligence/api.js: chatSend()
      -> Supabase RPC: intel_admin_chat_send
        -> insert user message + enqueue chat job
          -> intel_jobs
            -> local worker polls intel_agent_claim_job
              -> jobs.HANDLERS["chat"] -> h_chat() -> chat.handle()
                -> intel_agent_chat_context (authorization + history)
                -> FallbackLLM.chat_json() -> AIRouter.chat_json_ex("chat.plan")
                   -> Gemini if route permits; otherwise Ollama
                   -> on Gemini failure/skip: one Ollama attempt
                -> Python validates allowlisted tool and args
                   -> intel_agent_chat_tool / intel_agent_chat_propose
                -> intel_agent_chat_reply persists answer
          -> React polls intel_chat_messages and renders the stored response
```

**Evidence:** `src/intelligence/ChatView.jsx:38-48`; `src/intelligence/api.js:77-85`; `supabase/migrations/20261109140000_intelligence_v1_completion.sql:354-410`; `intelligence-worker/kairflow_intel/jobs.py:687-690,728-732`; `chat.py:419-510`; `gemini.py:250-259`; `airouter.py:302-313`.

**Default route:** Agent Chat is in the private `chat` group. `KAIRFLOW_AI_D1` defaults to `A`, so the router sends the whole chat context to Ollama. D1=C is an explicit opt-in to allow Gemini to receive private history/tool context. Actual production provider is **not observed** in this snapshot.

**Important context gap:** `chat.py` builds the system prompt from a generic prompt and tool catalogue only; it does not load the approved Studio Kairegi KB. `chat.py:98-113,432-436`.

## 2. Prospect discovery / research / qualification / outreach path

```text
Worker periodic scheduler
  -> active campaign(s)
     -> discover job
        Indie: sources.discover_batch() -> Steam/itch parsing (no LLM)
        Studio: source seeding / GDELT / RSS / Common Crawl / manual post
           selected extraction helpers -> AI router (discovery.*)
        Kickstarter -> administrator manual intake; no Kickstarter fetch
     -> intel_agent_upsert_prospect / intel_agent_record_item
     -> research job
        -> intel_agent_context / source registry / metered Fetcher
        -> public page fetch + deterministic evidence/signal extraction
        -> research.entity_llm() -> AI router (research.entity)
           narrow output: named contact + role only
     -> analyze_site job (deterministic site/evidence analysis)
     -> qualify job
        -> Indie project-first scoring OR studio scoring
        -> deterministic evidence/contactability/suppression gates
     -> resolve job
        -> intel_agent_resolve_lead
     -> draft job
        -> approved KB + verified evidence + conversation context
        -> model composer via drafting.* route + validators + provenance
        -> intel_agent_upsert_draft (pending human approval for model-written draft)
```

**Evidence:** `jobs.py:58-214,348-445`; `discovery.py:24-45,185-220,278-307,310-369`; `sources.py:37-45,136-160,202-300`; `research.py:40-43,195-239,479-559`; `ai_call.py:25-77`.

## 3. Inbound reply / follow-up path

```text
Worker periodic scheduler
  -> sync_mail job (every ~120 sec)
     -> intel_agent_receive_accounts()
     -> account-scoped Gmail / Zoho sync; SMTP is send-only
     -> intel_agent_record_inbound / queue classify job
  -> classify job (every ~120 sec)
     -> deterministic bounce / auto-reply / unsubscribe / complaint / hard-rule checks
     -> remaining ambiguous content -> classification.inbound AI route
     -> reply draft via drafting.reply when appropriate
     -> model-written reply stays pending approval
  -> followup_scan (hourly)
     -> intel_agent_followup_candidates
     -> takeover job for pasted conversation OR draft follow-up/re-engagement
```

**Evidence:** `jobs.py:548-716,792-817`; `classify.py:17-70`; `mailops.py:189+`; `takeover.py:handle()`; `providers/router.py`.

## 4. Outbound send path

```text
Approved outbound message
  -> worker periodic enqueue when kill_switch is OFF
  -> send job checks mail pause + kill switch + send window
  -> intel_agent_reserve_send
  -> intel_agent_assign_provider_account (durable provider/account + purpose + quota)
  -> provider adapter resolved by provider_key + provider_account_id
  -> intel_agent_acquire_send_slot
  -> intel_agent_mark_sending (final database policy gate)
  -> provider.send()
  -> persist provider acceptance / intel_agent_confirm_send
  -> if ambiguous: mark unknown; reconcile, never fresh-key resend
```

**Evidence:** `jobs.py:512-546,815-817`; `mailops.py:40-132,135+`; `providers/router.py:12-28`; migration `20261128100000_intelligence_phase8_final_send_boundary.sql`.

## 5. Control and runtime paths

```text
Browser Settings UI
  -> local controller at 127.0.0.1:17843 (origin allowlist + per-install bearer token)
    -> starts/stops local Python worker process
      -> Supabase Auth as registered agent user
      -> Supabase RPCs + durable intel_jobs leases
      -> local Ollama on loopback
      -> Gemini REST API when routing policy permits
      -> provider-specific Gmail / Zoho / SMTP APIs through installed adapters
```

**Evidence:** `SettingsView.jsx:50-94`; `controller.py:24-33,75-87,115-145`; `main.py:22-44,170-200`; `jobs.py:771-917`; `config.py:70-129`.

## 6. Provider systems — separate maps

| System | Runtime | Installed/declared providers | Current state in source |
|---|---|---|---|
| Intelligence outreach | Python worker | Gmail, Zoho, SMTP | Account-scoped registry; Gmail/Zoho receive; SMTP send-only; Zoho manual correspondence only |
| General CRM Inbox | Supabase Edge Functions / TypeScript | Gmail, Zoho, Resend compiled; SMTP not implemented in TS adapter | Shared-account architecture note says Gmail/Zoho/SMTP capabilities remain disabled until authenticated gateway and acceptance |
| Resend transactional / Intelligence audit | Supabase Edge Functions | Resend | Separate send/inbound/delivery routes; not in worker prospect registry |

Do not collapse these into one provider list. See `docs/EMAIL_ADAPTER_ARCHITECTURE.md`, `intelligence-worker/kairflow_intel/providers/registry.py:44-79`, `supabase/functions/_shared/email_adapter_registry.ts:1-40`, and `src/intelligence/SettingsView.jsx:241-277`.

## 7. What is not established by this execution map

- Whether the deployed worker is currently running or which version it runs.
- Whether Gemini has a valid key, available quota, or successful production requests.
- Which provider handled any recent production request.
- Whether the hosted Supabase database has all 135 migration files reconciled/applied.
- Whether deployed Edge Functions match the source snapshot.
- Whether the production Inbox gateway has been deployed and enabled.
- Whether real Gmail, Zoho, SMTP or Resend accounts pass live acceptance.
