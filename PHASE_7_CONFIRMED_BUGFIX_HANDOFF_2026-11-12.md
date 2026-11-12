# KairFlow Intelligence — Phase 7 Confirmed Bugfix Handoff

**Date:** 12 November 2026  
**Scope:** Corrective patch for the two confirmed Phase 7 Admin UI / Reply Review findings.  
**Mode:** Local source changes only. No database migration was applied, no secrets were changed, no worker was started, no provider was contacted, and no email was sent.

## Summary

Both confirmed findings have been addressed in a forward-only patch:

1. **P1 — Manual reply approval bypass:** `intel_admin_compose_reply` now creates outbound replies in `pending_approval` with `auto_sent=false`. The existing `intel_admin_review_message(..., 'approve')` transition remains the explicit approval action that changes the state to `approved` and enqueues the send job. A composed reply is therefore not eligible for the approved-outbound queue until an administrator approves it.
2. **P2 — Composer on non-contactable conversations:** the Outreach UI hides the composer for `closed` and `suppressed` prospects and for conversations containing an inbound unsubscribe or complaint classification. The RPC independently rejects closed/suppressed prospects and recipients matching an organization-level email or domain suppression. The existing final send-time suppression gate remains in place as an independent safeguard.

## Files changed

- `src/intelligence/OutreachView.jsx`
  - Adds `replyBlocked` derived from prospect status and inbound unsubscribe/complaint classifications.
  - Replaces the composer with a clear blocked-state notice when reply composition is not permitted.
- `supabase/migrations/20270101090000_intelligence_phase7_reply_approval_safety.sql`
  - Forward-only replacement of `intel_admin_compose_reply`.
  - Requires an existing inbound message, validates the resolved recipient, rejects closed/suppressed prospects and email/domain suppressions, and creates a non-auto-sent `pending_approval` message.
  - Revokes execution from `public` and `anon`; grants it to `authenticated`. The function still obtains the organization through `intel_admin_org()`, preserving the admin authorization check.
- `src/intelligence/phase7-reply-approval-safety.test.mjs`
  - Adds regression contracts for pending approval, suppression checks, and UI hiding behavior.

## Verification

| Check | Result |
|---|---:|
| Focused Phase 7 UI + safety tests | **6 passed** |
| Full Node test suite | **1,142 passed, 0 failed** |
| Full Python worker suite | **903 passed, 0 failed** |
| Migration filename ordering | **Passed** — new migration is last |
| Duplicate migration versions | **None found** |
| Production build | **Not run successfully** — local `node_modules/vite/bin/vite.js` is absent |
| PostgreSQL execution | **Not run** — no PostgreSQL client/server or SQL parser available |
| Browser E2E | **Not run** |

Python test command:

```bash
PYTHONPATH=intelligence-worker python -m unittest discover -s intelligence-worker/tests -t intelligence-worker
```

Node test command:

```bash
npm test
```

## Staging acceptance required

Before production:

1. Review the migration ledger and confirm `20270101090000_intelligence_phase7_reply_approval_safety.sql` has not already been applied.
2. Apply the migration to a disposable/staging database using the normal reviewed migration process.
3. Compose a reply for an eligible prospect; verify its state is `pending_approval`, `auto_sent=false`, and it is absent from `intel_agent_approved_outbound`.
4. Approve it through `intel_admin_review_message` / the UI; verify the state becomes `approved` and the send job is enqueued.
5. Attempt composition for `closed` and `suppressed` prospects; verify the RPC rejects both.
6. Add exact-email and domain suppressions; verify composition is rejected for each matching recipient.
7. Verify the UI hides the composer for closed/suppressed prospects and inbound unsubscribe/complaint conversations.
8. Verify ordinary eligible replies remain available and continue to require explicit approval.

## Release disposition

The two source-level defects are patched. **Do not treat this as production-released yet.** Database execution, staging RPC tests, browser acceptance, and the production build remain outstanding. No production state was changed by this patch.
