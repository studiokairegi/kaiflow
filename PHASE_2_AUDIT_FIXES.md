# Phase 2 audit fixes (worker only)

Fixed (each has a regression test in `intelligence-worker/tests/test_phase2_audit_fixes.py`):

1. **Reused template** – `uniqueness_check` no longer drops paragraphs that recur across prior drafts. Only the compliance footer (passed as `footer=`) is excluded.
2. **Fabricated claims** – the risky-term and named-entity checks now run on every sentence; the prospect's own name no longer counts toward evidence overlap; sentence-initial proper nouns are no longer exempt (only ordinary opener words are); the risky list covers hiring/outsourcing/funding/prizes/praise.
3. **Auto-approval** – model-written replies are created with `p_auto_ok=False`. Fixed Japanese auto-replies are unchanged.
4. **Model outage** – `compose_english` re-raises `TransientError`. `h_classify` saves the classification only after reply composition finishes, so a retry still produces the reply.
5. **Quoted text** – consequential/relevance checks and inbound evidence use `policy.first_unquoted`.
6. **Policy phrasing** – `\bfree\b` replaced with price-specific phrasing; policy failures on model-written drafts and replies now flag the prospect; one shared body limit (`policy.MAX_BODY_CHARS`, footer included).
7. **Payload** – keys ordered so approved facts and the incoming message come first; evidence trimmed to `PAYLOAD_BUDGET` rather than cut mid-JSON; Ollama cap raised to 24000 chars with `num_ctx` scaled to the input.
8. **Evidence ids** – database id if present, otherwise a content hash (not array position). The audit log now stores each cited snippet.

Found and fixed on re-review of the fixes themselves:
- `policy.first_unquoted` stops at the first quote marker, so a reply written *below* the quote read as empty and skipped the consequential guard (fail-open). The drafting checks now use `drafting._new_text`, which drops only quoted lines and attribution headers (Outlook-style separators end the text only when new text is already above them).
- The new risky-term `won` matched "won't"; sender name and sign-off words ("Best, Alex", "Thanks, Rina.") were rejected as unsupported claims.
- Ollama context estimate assumed 3 chars/token; now 2 (CJK is near 1).

Not changed / still open:
- Evidence ids are not stored on the message row and the context RPC still returns no `id` (needs a migration; none written or run).
- Name-swap detection for lowercase or numeric names ("id Software", "2K Games"); threshold calibration; no regeneration step after a policy failure.
- Japanese uniqueness, re-engagement with `max_followups = 1`, repo hygiene files, and the superseded status doc.
- Not run: SQL, JS tests, frontend build, live mail. The new sentence checks are stricter and will send more drafts to manual review; tune against real model output.

Worker suite: 241 tests pass.
- `policy.scan_inbound` still uses `first_unquoted`, so the classifier can miss pricing/terms words in a bottom-posted reply; the drafting guard no longer depends on it. Worth fixing the same way.

## Round 2 (merged)

- Salutation/sign-off are stripped before grounding checks (`drafting._claim_body`); numbers and years must appear in cited evidence or approved facts; digit-led names (e.g. "2K Games") are allowed when sourced.
- Reply-relevance check ignores the echoed inbound subject and uses whole-word matching.
- Curly quotes are normalised (`policy.normalize_quotes`) so "don’t contact us" is caught by `scan_inbound` and the consequential-reply guard.
- `h_classify` saves the classification after the reply draft is stored, so a failed history lookup or draft upsert retries instead of losing the reply.
- Retried drafts/replies no longer count their own earlier copy as a duplicate (`idempotency_key` excluded).
- Migration `20261121090000_intelligence_phase2_fixes.sql`: `intel_agent_recent_outbound` returns `idempotency_key`; re-engagement only on the last slot when `max_followups >= 2`; worker-flagged prospects are not re-offered as follow-up candidates (clear `review_reason` to re-queue).
- Fixed: `policy.first_unquoted` now keeps a reply written below the quote (drops only `>` lines, attribution headers, and ends at an Outlook separator only when new text is above it), so `scan_inbound`, the classifier input and takeover no longer miss bottom-posted unsubscribe/pricing/complaint text. `drafting._new_text` delegates to it.

## Round 3 (merged)

- **Evidence ids stored.** Migration `20261122090000_intelligence_phase2_evidence_trace.sql` adds `intel_messages.evidence_trace` (write-once), the `intel_agent_set_message_evidence` RPC, and returns `id` on each evidence row from `intel_agent_context`, so cited ids are database ids. The worker records the cited snippets on the message after the draft is stored; a failure there is logged (`evidence_trace_not_stored`) and never loses the draft.
- **Name swaps with unusual names.** `intel_agent_recent_outbound` now also returns `prospect_name` and `contact_name`. `uniqueness_check(..., names=)` masks each message's own recipient names (full name and distinctive parts, e.g. "2K", "id Software") before the similarity and structural comparisons.
- **Regeneration.** `jobs._vet_draft` rewrites a model-written draft once, with the reason, when it is too similar or breaks outbound policy; a second failure flags the prospect as before. Used for outreach, follow-ups, re-engagement and replies. Template drafts (Japanese) are not regenerated.
- Apply order: `20261121090000` then `20261122090000`.
- Still open: Japanese uniqueness (Phase 3); threshold calibration needs real model drafts (`SIMILARITY_THRESHOLD` is unchanged); SQL has not been run.
- Worker suite: 273 tests pass.
