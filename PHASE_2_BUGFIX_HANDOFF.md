# KairFlow Intelligence — Phase 2 Production Hardening Handoff

Date: 2026-11-07  
Scope: Phase 2 English outreach, follow-ups/re-engagement, inbound replies, provider threading, inbox reliability, and send coordination. No Japanese drafting scope.

## Changes in this release

- Preserved inbound message context through reply composition and routed unsupported personalization, ungrounded claims, repetitive drafts, and consequential inbound messages to manual review.
- Added deterministic draft uniqueness checks against persisted organization-wide outbound history (up to 500 messages from the last 180 days), including drafts, pending approvals, reserved/sending, sent and unknown states. These checks are a lexical/structural safety filter, not semantic entailment or a statistically calibrated classifier.
- Classified inbound jobs against their corresponding pending message rather than repeatedly processing an arbitrary first batch.
- Kept pre-provider parent lookup errors as definite non-sends and retryable failures.
- Made Zoho native reply threading fail closed: malformed or provider-rejected parent threading raises `ThreadingRejected`; it never silently falls back to a new unthreaded message.
- Kept missing Zoho parent references blocked for manual review; Gmail continues to use RFC `In-Reply-To`/`References` headers.
- Require a provider message ID before confirming a send. Missing IDs and ambiguous provider outcomes remain unknown for reconciliation; they are never blindly resent.
- Paginate Gmail Sent reconciliation and added bounded, overlapping pagination for Zoho Sent reconciliation.
- Retained overlap/deduplication for Zoho offset pagination during inbox sync.
- Added an agent-only, bounded outbound-history RPC for cross-recipient duplicate checks.
- Added a database-backed, per-organization send slot. The settings-row lock serializes slot acquisition across worker processes; the randomized gap is 45–120 seconds. Slot acquisition is idempotent for the same reserved message, and the worker requeues a message when another send owns the active spacing window.
- Recheck the emergency kill switch when acquiring the send slot, immediately before the provider call path.
- Added regression coverage for global slot denial, Zoho threaded-reply rejection, malformed parent IDs, and multi-page Sent reconciliation.

## Required database migration

Apply `supabase/migrations/20261119090000_intelligence_phase2_global_send_pacing.sql` after the existing Intelligence migrations. It adds two nullable coordination fields to `intel_settings` and the agent-only `intel_agent_acquire_send_slot(uuid)` RPC. The worker change depends on this RPC; deploying the worker without applying the migration causes sends to fail closed rather than bypass pacing.

## Verification performed locally

- `python -m unittest discover -s tests -t .` in `intelligence-worker`: **206 tests passed**.
- `python -m compileall -q intelligence-worker`: passed.
- No live Gmail/Zoho/Resend mailbox calls or real email sends were performed.
- No Supabase migration was applied to a live database; the new SQL must be reviewed/applied in the target project before deploying the worker.

## Remaining production gates

- Zoho OAuth, send/reply response shapes, Sent-folder semantics, and pagination must be validated against the actual connected mailbox in a controlled test. No live provider test was run here.
- Zoho offset pagination cannot provide the same snapshot guarantees as an opaque cursor. The overlap and message-id deduplication reduce gaps, but a continuously changing mailbox can still require repeated sync passes.
- The lexical grounding and similarity thresholds are conservative deterministic checks. They do not prove semantic entailment; ambiguous drafts should remain in manual review.
- Gmail/Resend live integration behavior, account-specific sending limits, DNS/authentication, and deliverability remain operational checks.
- A database migration and a controlled staging deployment are required before calling the global throttle production-active.

## Safety / non-actions

- Phase 3 Japanese email-generation work was not started.
- No production database migration was applied, no secrets were changed, and no deployment or Git push was performed.
- No worker was activated and no real email was sent.
