# Phase 3 live acceptance — Japanese initial outreach draft

This is an opt-in acceptance test for the actual local Ollama + Supabase environment. It is deliberately separate from the worker loop. It never sends email, never approves a message, and never changes autonomy, kill-switch, or campaign limits.

## What the preflight checks

1. The configured Ollama URL is reachable on loopback.
2. Both configured model tags are installed (main and fast).
3. Both models return schema-valid JSON through `/api/chat`.
4. The signed-in agent can read Intelligence settings.
5. PostgREST resolves the 11-argument `intel_agent_upsert_draft` RPC including `p_force_review`. The signature probe uses a random nonexistent prospect UUID and must stop at `prospect not found`; it inserts nothing.
6. The supplied prospect UUID resolves to exactly `Andraft`, is `lead_linked`, and has a verified contact email.
7. If explicitly authorized with `--create-draft`, the real worker `jobs.h_draft` path creates a Japanese initial draft and the script reads the persisted message back through `intel_agent_context`.
8. A retry returns the same message ID without creating another row.
9. The saved row is `outbound` + `initial` + `pending_approval`; no send job is queued and sending settings are unchanged.

## Windows PowerShell

Run this from the extracted corrected repository. Use the same private `worker.env` file as the controller; do not copy secrets into the repository.

```powershell
cd C:\path\to\KairFlow_Phase3\intelligence-worker

$envFile = Join-Path $env:LOCALAPPDATA 'KairFlowIntelligence\worker.env'
$prospectId = 'PASTE-EXACT-ANDRAFT-PROSPECT-UUID-HERE'

# Read-only checks first. This does not create a draft.
.\.venv\Scripts\python scripts\phase3_acceptance.py --env-file $envFile --prospect-id $prospectId

# Only after reviewing the preflight and confirming this is the intended Andraft record:
# This creates a real pending-approval draft. It does NOT send it.
.\.venv\Scripts\python scripts\phase3_acceptance.py --env-file $envFile --prospect-id $prospectId --create-draft
```

If the worker environment is already exported into the current PowerShell session, omit `--env-file`.

## Expected successful evidence

The script prints the durable Supabase message ID, subject, body, confirms the message is retrievable from the prospect context, verifies the retry returns the same ID, and prints `ACCEPTANCE PASS`. Then open KairFlow → Intelligence → Outreach and confirm the same draft appears under **Waiting for your approval**. Review it there; do not approve it as part of this test.

If a pending initial draft already exists, the script will verify that existing row and retry idempotently rather than create another. If the existing row is sent, approved, discarded, or otherwise not pending approval, the script stops without changing it.

## Migration application

The migration is:

`supabase/migrations/20261123100000_intelligence_chat_draft_force_review.sql`

From the repository root, apply it only to the intended local/test Supabase project:

```powershell
cd C:\path\to\KairFlow_Phase3
supabase migration list
supabase migration up
supabase migration list
```

Check the linked project before applying anything. This repository does not authorize applying migrations to production. The live acceptance RPC signature probe detects an unapplied migration without writing a message.

## Frontend build

From the repository root:

```powershell
npm ci
npm test
npm run build
```

The Outreach view reads `intel_messages`, filters outbound `pending_approval` rows, and displays them under Waiting for your approval. The worker-side acceptance script proves the persisted row is retrievable by the agent RPC; the final browser/UI visibility check is still performed in the signed-in KairFlow app.

## Japanese review

The script prints the actual generated Japanese subject and body. Have a Japanese B2B business writer review that exact output before approving or sending. Automated tests and model health checks cannot certify native-level Japanese business nuance.
