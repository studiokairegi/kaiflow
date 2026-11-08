# KairFlow Intelligence — Phase 3 Ninth-Pass Corrective Handoff

**Date:** 8 November 2026
**Scope:** Explicit Japanese/English initial outreach drafting from Emma chat, persistence safety, and research-fetcher robustness.

## 1. Root cause

The reported chat behavior was possible because the chat planner had no dedicated email-drafting tool. `chat.handle` allowed the LLM to answer with ordinary prose, and the fixed `TOOLS` catalogue did not contain a one-prospect initial-draft operation. Consequently, a plausible email displayed in chat did not establish that `intel_messages` contained a prospect-linked draft.

The repository already had a worker composer and `intel_agent_upsert_draft`, but those were reached through scheduled/queued draft jobs, not by the explicit free-form chat request. The Japanese composer also required verified prospect evidence for every initial message and failed closed when no factual evidence existed; this did not implement the required honest, non-personalized introduction fallback.

A separate safety gap existed in `intel_agent_upsert_draft`: for an initial message, global `autonomy = 'autonomous'` could make the message `approved` even when the caller passed `p_auto_ok = false`. `h_draft` then enqueued an approved message for sending. An explicit “save for review, do not send” request therefore needed an independent database-enforced review override, not just a chat instruction.

The fetcher correctly translated `requests` timeouts into `TransientError`, but `fetch()` passed arbitrary `Response.encoding` values directly to `bytes.decode`. A malformed value such as `none` raised `LookupError` and interrupted that research attempt.

## 2. Corrections implemented

- Added deterministic explicit-draft intent routing in `kairflow_intel/chat.py`. Draft requests are no longer left to the LLM's free-form reply path.
- The chat workflow extracts the named recipient, searches through the authorized chat RPC, and proceeds only when exactly one prospect name matches. Missing, ambiguous, or not-ready prospects fail without generating an email.
- The workflow invokes the existing `jobs.h_draft` composer/vetting/persistence path, with an explicit Japanese language override when requested.
- Successful chat replies include the durable `intel_messages.id`, state, and the Outreach → Waiting for your approval location. Failed persistence is reported as failure, not as a saved draft.
- Added a deterministic Japanese initial-introduction fallback when verified recipient-specific evidence is absent. It uses only approved Japanese Studio Kairegi knowledge-base facts and does not pretend to know the recipient's work.
- Expanded Japanese high-specificity claim checks to reject unsupported volume/experience claims such as “many works”, “numerous works”, and “extensive experience”.
- Added `p_force_review` to the existing draft-upsert RPC through a new additive migration. When true, the database sets `pending_approval` before evaluating autonomy. Existing scheduled workflows retain their previous behavior because the new parameter defaults to false. The migration now explicitly sends `NOTIFY pgrst, 'reload schema'` so PostgREST refreshes its function signature cache after deployment.
- The existing fixed idempotency key `draft:{prospect_id}:initial` remains in use. The worker first reuses an existing initial draft with the stable key `draft:{prospect_id}:initial`; the database's unique `(organization_id, idempotency_key)` conflict handling remains the final duplicate guard and returns the existing message ID and current state. Chat distinguishes a pending draft from an already-decided message.
- `safety.Fetcher.fetch` validates response encodings with `codecs.lookup` and falls back to UTF-8 for missing/invalid codec labels. A second-pass audit also found that streamed body reads can time out *after* `requests.get()` returns; bounded response reads now translate requests/urllib3/socket read failures into `TransientError`. A robots.txt body-read timeout fails closed without crashing the worker.
- The explicit-draft intent guard now rejects directly negated requests (for example, “Do not draft an email”), preventing a state-changing draft operation from running against an instruction not to draft.
- Prospect target extraction now supports Japanese company names written in kana/kanji with Japanese business suffixes such as `様`, `御中`, `宛て`, and `向け`, while retaining exact normalized-name matching before any draft is created.

## 3. Files changed

- `intelligence-worker/kairflow_intel/chat.py` — deterministic chat draft route, recipient extraction and safe resolution, persistence result handling.
- `intelligence-worker/kairflow_intel/jobs.py` — explicit language override and database force-review flag passed to the existing draft-upsert path.
- `intelligence-worker/kairflow_intel/drafting.py` — evidence-free but fact-safe Japanese initial introduction fallback; unsupported Japanese volume/experience claim checks.
- `intelligence-worker/kairflow_intel/safety.py` — safe codec validation and UTF-8 fallback.
- `intelligence-worker/tests/test_v1.py` — chat intent, negation guard, English/Japanese prospect resolution, persistence failure, mocked request-to-persisted-draft integration, force-review/idempotency migration contract.
- `intelligence-worker/tests/test_phase3_japanese.py` — no-evidence Japanese fallback and unsupported volume-claim regression coverage.
- `intelligence-worker/tests/test_safety.py` — malformed encoding, connection-time timeout, streamed-body timeout, and robots.txt timeout regression coverage.
- `intelligence-worker/kairflow_intel/ollama.py` — model-tag inventory for real Ollama preflight checks.
- `intelligence-worker/kairflow_intel/main.py` — selftest now verifies both configured Ollama models can produce schema-valid JSON and probes the deployed force-review RPC signature without inserting a record.
- `intelligence-worker/tests/test_ollama_preflight.py` and `tests/test_live_preflight.py` — regression coverage for model inventory, structured output routing and the read-only RPC signature probe.
- `intelligence-worker/scripts/phase3_acceptance.py` — opt-in real Andraft acceptance runner that creates only a pending-review draft when explicitly authorized, reads it back, verifies idempotency, and proves no send job was queued.
- `PHASE_3_LIVE_ACCEPTANCE.md` — Windows commands and acceptance evidence requirements.
- `supabase/migrations/20261123100000_intelligence_chat_draft_force_review.sql` — database-enforced review override and PostgREST schema-cache reload for explicit chat drafts.
- `PHASE_3_NINTH_PASS_HANDOFF.md` — this corrective handoff.

No frontend source change was required: `OutreachView.jsx` already loads `intel_messages` and displays outbound `pending_approval` messages in its “Waiting for your approval” section. Chat now tells the user where to find the saved record and gives its message ID.

## 4. Verification

- Python worker suite after the additional live-preflight changes: **381 tests passed, 0 failed** (`python -m unittest discover -s tests -t .`).
- Python compile check, including the live acceptance script: passed.
- JavaScript suite: **750 tests passed, 0 failed** (`npm test`).
- `npm ci` could not complete in this environment (network install timed out; offline retry reported an uncached npm package). `npm run build` therefore remains blocked because Vite is not installed in the extracted environment. This is an environment/dependency availability limitation, not a successful build.
- No dedicated lint or formatting script is defined in `package.json`.
- The archive contains no `.git` directory. `git status`, branch inspection and `git diff --check` therefore cannot be run against this input. A manual whitespace scan is required before handoff.
- Database migration was not applied; no PostgreSQL/Supabase integration environment was available.

The worker integration test exercises the complete request → exact prospect resolution → actual `h_draft` implementation → `intel_agent_upsert_draft` RPC boundary → chat confirmation path, with a mocked RPC persistence layer. It verifies the returned durable message ID, prospect association, `initial` classification, stable idempotency key, `pending_approval` force flag, and absence of a send enqueue. It does **not** prove that a production Supabase row was created. That requires applying the migration and running the test against a non-production database.

## 5. Second-pass bug recheck

The corrected archive was re-opened and the full worker suite was rerun using package-aware unittest discovery. This uncovered three edge cases that the prior pass had not covered: streamed HTTP body-read timeouts, Japanese-script company names in the chat recipient parser, and negated drafting instructions. All three were corrected and regression-tested.

- Streamed response timeout: now raises `TransientError` so the worker retry policy can handle it.
- robots.txt response timeout: fails closed for that origin and does not crash the worker.
- Japanese company-name extraction: now supports kana/kanji names with common Japanese addressee suffixes; resolution still requires one exact normalized match.
- Negated drafting instruction: no draft operation is invoked.

Frontend tests: **750 passed, 0 failed**.

## 6. Additional acceptance tooling and outstanding gates

- Added a live Ollama preflight to `python -m kairflow_intel selftest ollama`: it checks that both configured model tags are installed and that each returns schema-valid JSON. This environment had no Ollama process listening on `127.0.0.1:11434`, so those live checks could not be completed here.
- Added a Supabase preflight to `python -m kairflow_intel selftest supabase`: it signs in, reads settings, and probes the 11-argument draft RPC with a random nonexistent prospect UUID. The expected `prospect not found` response proves the named argument resolves without inserting a record. This environment had no private Supabase credentials or project access, so the probe was not run against the user's project.
- Added `intelligence-worker/scripts/phase3_acceptance.py`. On the user's machine it can run both configured Ollama models, verify the migration/RPC signature, resolve the exact Andraft UUID, optionally create a Japanese initial draft only when `--create-draft` is explicitly passed, read the persisted message back, retry to verify idempotency, check `pending_approval`, and assert that no send job was queued or safety setting changed.
- The actual Andraft live test remains unrun here because the archive contains no private `worker.env`, Supabase credentials, Andraft UUID, or local Ollama service. Run the exact Windows commands in `PHASE_3_LIVE_ACCEPTANCE.md`; the script does not send email.
- The Outreach UI source already reads `intel_messages` and filters outbound `pending_approval` messages into **Waiting for your approval**. The live UI check still needs to be confirmed in the user's signed-in browser after a real database draft exists.
- Native Japanese B2B language review remains outstanding. The script prints the actual generated subject/body for a qualified Japanese reviewer; automated checks cannot certify native-level nuance.
- Apply the new migration to the intended local/test database before deploying the worker. The migration sends a PostgREST schema-cache reload notification. Do not deploy the worker first: it passes the new named RPC argument `p_force_review`.

## 7. Safety and deployment

- No email was sent by the test path.
- Chat-created drafts force `pending_approval` even if global autonomy is autonomous.
- No kill-switch, shadow-mode, autonomy, daily cap, suppression, mailbox provider, Zoho Mail, Resend, or sending configuration was changed.
- No migration was applied, no production database was modified, and no deployment, push, worker restart, or controller restart was performed.
- The supplied archive contains no `.git` directory, so no branch/status/diff-based release claims can be made.
- Phase 2 and unrelated Phase 3 architecture were preserved.
