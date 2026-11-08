# Phase 10 — Provider responsibility and authority report

## Responsibility split

| Capability | Authoritative component | Scope |
|---|---|---|
| Prospect outreach send | Dynamic Gmail / Zoho Mail / SMTP adapters selected by `intel_provider_accounts` | Per-message durable account assignment; provider registry and account gates apply. |
| Prospect outreach approval | KairFlow database send boundary and administrator review | Every outbound message requires explicit human approval at the final gate. Zoho's stricter human-review rule remains in place. |
| Prospect inbound replies | Gmail / Zoho mailbox adapters where receive/thread capabilities exist | Provider-specific sync and account identity; SMTP remains send-only. |
| Delivery/bounce/complaint reconciliation | Phase 7 provider-neutral delivery-event RPC | Provider-specific evidence must be authenticated and normalized before ingestion. |
| Transactional application email | Resend transactional integration | Separate from prospect outreach; does not appear in the prospect provider registry. |
| Resend inbound transactional/legacy Inbox webhook | `intel-resend-webhook` | Uses `RESEND_WEBHOOK_SECRET`; not a Gmail/Zoho mailbox and not an outreach account. |

## Authority and worker configuration

- `intel_provider_accounts` plus `intel_email_provider_registry` are authoritative for outbound prospect messages.
- `intel_agent_assign_provider_account` persists the exact provider account and key on the message. The worker's `DynamicProviderRouter.for_message()` resolves only that assignment and rejects partial assignments.
- A legacy/default adapter remains available to non-message mailbox jobs during migration compatibility. It is not the authoritative route for outbound prospect messages; Phase 8's final database gate rejects unassigned messages.
- `KAIRFLOW_MAIL_PROVIDER` is therefore a legacy/default mailbox-job setting, not a selector for prospect outreach. Do not use it to override a message's durable provider assignment.
- Account connection, account enablement, account send enablement, registry sending gate, human approval, consent, suppression, quotas and the emergency stop are independent gates. Phase 10 does not activate any of them.

## Findings addressed

- **M-01 — schema mismatch:** Phase 10 adds an idempotent additive alignment migration for the provider-account fields consumed by account management/status and guards against applying it before the provider registry exists. This is a source-level repair; actual PostgreSQL application is still required to prove compatibility with the deployed schema history.
- **M-02 — legacy mailbox prerequisite:** The final kill-switch function now checks an eligible dynamic Gmail/Zoho/SMTP account and the deployment-owned registry sending gate, rather than relying on a singleton `intel_mail_account` row or allowing an unconfigured Resend-only state to appear send-ready.
- **M-03 — Resend webhook secret:** Inbound Resend webhook and shared transactional webhook logic both use `RESEND_WEBHOOK_SECRET`, matching `docs/RESEND_EMAIL_SETUP.md`. No secret value is read or reported.
- **M-08 — Resend mailbox status:** Resend is not represented as a connected mailbox. The admin mailbox-status RPC now reports dynamic provider-account status, while retaining a clearly labelled legacy bridge when no registry account exists. Resend remains a separate transactional service.

## Explicit non-changes

No integration was removed. No provider credentials, API keys, webhook secrets or mailbox contents were accessed. No mailbox was connected, no registry gate enabled, no migration applied, no worker restarted, no deployment performed and no email sent.

## Settings authority after Phase 10 corrective pass

Intelligence Settings exposes only the dynamic provider-account registry UI for mailbox connection and account management. The legacy singleton mailbox UI has been removed from this screen so it cannot imply a single-mailbox limit or instruct operators to select a global worker provider for prospect outreach. Legacy singleton records remain a read-only status bridge for unmigrated installations; they do not authorize Phase 8 outbound messages.
