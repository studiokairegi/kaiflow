# KairFlow shared-account / outreach security review

Date: 2026-11-12

## Confirmed correction

- `intelligence-worker/kairflow_intel/mailops.py`: provider-account assignment is now mandatory. A missing, empty, or malformed `intel_agent_assign_provider_account` response fails closed and never activates the legacy default adapter. This prevents a transient schema/RPC/authorization failure from sending through an unintended mailbox.
- `intelligence-worker/tests/test_ops.py`: added regression coverage for null and malformed assignment responses; updated test doubles to model the mandatory assignment contract.
- `paystack-live.env.txt`: removed from the delivered working tree. The uploaded archive contained a value shaped like a live payment-provider secret. Treat it as exposed and rotate/revoke it in the provider dashboard immediately. Do not rely on `.gitignore` as remediation; check repository history, CI logs, deployment logs and any previously shared archives for copies.

## Existing architecture verified from source

- Settings/Intelligence is the intended account source of truth.
- Shared Inbox account projection uses the same Intelligence account UUID and does not copy credentials.
- Zoho's worker manifest and database purpose policy are manual-correspondence-only.
- Resend is excluded from the active Inbox provider catalogue and remains separate for transactional functions.
- SMTP implementation is submission-only; IMAP receiving is not implemented.
- The central Inbox Edge adapter registry currently contains only the Resend adapter implementation. Gmail, Zoho and SMTP registry rows remain disabled, as required by the fail-closed architecture.

## Verification boundaries

- Node test suite: 1,045 passed before the final worker-only correction; rerun status is recorded in the delivery report.
- Python worker suite: 752 passed before the final worker-only correction; focused worker regression tests pass after the correction.
- Production build, SQL migration execution, Edge Function deployment, worker deployment, and live-provider acceptance have not been performed or verified in this environment.
- Gmail/Zoho/SMTP central Inbox gateway, SMTP IMAP, and real-provider Inbox operations remain incomplete. No provider catalogue capability has been enabled.

## Required owner action

1. Rotate the exposed payment-provider secret and update the production secret store.
2. Confirm whether the removed secret file was tracked in any remote repository; purge it from history if so, following the provider's rotation.
3. Provide an authorized staging environment and connected test accounts for live provider acceptance.
