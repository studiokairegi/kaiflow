# KairFlow Intelligence — Phase 8 Handoff

**Phase:** 8 — Secure the final sending boundary  
**Status:** Implemented locally; 435 Python tests and 796 JavaScript tests passed.  
**Disposition:** No migration applied, provider activated, worker started, live email sent, or production data changed.

## Objective

Every outbound message is revalidated in one database transaction immediately before the provider call. The final `intel_agent_mark_sending` transition locks the organization settings and message and then rechecks mutable permissions and eligibility.

## Changes

- Added `20261128100000_intelligence_phase8_final_send_boundary.sql`.
- Replaced the previous partial last-moment guard with a final fail-closed gate covering human approval (`auto_sent=false`), kill switch, recipient syntax, exact-email/domain suppression, revoked/missing prospecting permission, inbound business-correspondence context, prospect status, exact-address contactability pass, CRM origin/takeover ownership, lead state, campaign status, send window, compliance footer, conversation/reply state, organization/campaign caps, exact provider account and registry capability, purpose allowlist, provider enablement, account usage reservation and rolling provider quotas, and send-slot ownership/expiry.
- No unassigned/legacy provider route is accepted at the final boundary. The selected dynamic account must still be connected and enabled for the exact message purpose. Account, registry and legacy provider-flag rows are locked during the final check; reserved mailbox quota is released when a pre-send denial returns a message to a non-dispatch state.
- Human approval is required for all outbound messages at this boundary. Automatically approved messages (`auto_sent=true`) are returned to `pending_approval`; explicit administrator review clears the flag.
- Unknown outcomes remain non-retryable. `intel_agent_mark_unknown` now transitions only `sending` to `unknown`, releases the send slot and notifies the administrator. `intel_agent_confirm_send` can no longer promote a merely `reserved` message to `sent`; it requires `sending` or provider-reconciled `unknown`. Existing reconciliation continues to verify provider evidence; SMTP ambiguity remains manual and no automatic resend is introduced.
- Added advisory-lock triggers for suppression and contact-permission writes so insertions into previously empty keys serialize with the final check. Added a pre-send quota-release trigger for messages safely returned from `reserved` to a non-dispatch state. Inbound message recording now locks the same prospect row as the final gate, serializing inbound arrival against the outbound transition.
- Added source-level contract tests in `src/intelligence/phase8-final-send-boundary-contract.test.mjs`.

## Important behavior

- The worker still performs provider assignment and preflight before acquiring the send slot. The final database RPC is immediately adjacent to the provider call; no further RPC is inserted between the final check and `provider.send()`.
- A denial does not call the provider. Durable unknown state is never treated as a failed/absent send and cannot be automatically retried.
- Zoho's existing human-review rule is retained and strengthened by the global explicit-approval requirement.
- Resend remains excluded from prospect outreach by the existing provider registry policy; no Resend integration was added here.

## Verification and staging requirements

- Python worker suite: **435 passed, 0 failed** (`PYTHONPATH=intelligence-worker python -m unittest discover -s intelligence-worker/tests -t intelligence-worker`).
- JavaScript suite: **796 passed, 0 failed** (`npm test`).
- Python compilation: passed (`python -m compileall -q intelligence-worker/kairflow_intel`).
- SQL delimiter/transaction structure checks passed. PostgreSQL execution was not available, so the migration has not been executed and transactional concurrency behavior is not yet database-verified.
- The SQL migration must be applied first to a disposable staging database after all prior migrations, then test concurrent revocation/kill-switch/campaign pause/reply/takeover races against a real PostgreSQL instance. Source-level tests are not a substitute for transactional database tests.
- Confirm staging RPC grants, `intel_agent_org()` identity, timezone behavior, account quota locks and provider-account assignment before any controlled pilot.
- Vite was not installed in the supplied package, so a frontend production build was not run.
- No provider credentials, mailbox connections, provider activation, DB migration, worker restart, production deployment or live outreach were performed for this phase.

## Stop condition

Phase 8 is complete locally. Stop here; Phase 9 requires separate authorization.


## Post-audit correction (2026-11-08)

A post-implementation audit found that the final send gate could fall back from verified contactability to estimated contactability. This was corrected: only `facts.verified.contactability.status = pass` can authorize initial/follow-up sending; missing verified evidence defaults to `needs_review`. The exact normalized prospect contact address must still match the message recipient. A regression test now asserts that estimated contactability is never consulted by the final gate.

Post-correction verification: JavaScript suite 797/797 passed; Python suite and Python compilation re-run after this change (see delivery report). The migration remains unapplied; PostgreSQL transactional/concurrency execution remains a staging requirement.
