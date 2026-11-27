// Finance V3 - shared contracts (Phase 1).
//
// This file is the single JavaScript-side statement of the names and enumerations
// that the database (Phase 2+) and the UI (Phase 5+) must agree on. It contains NO
// accounting logic. The database is the authority for every financial calculation;
// nothing here may be used to compute a balance, a conversion or a posting.
//
// Changing a value here is a contract change: record it in the phase handoff.

export const FINANCE_V3_VERSION = "3.0.0-phase6.0";

// ---- Namespacing ----------------------------------------------------------
// Tables, views and internal functions live in a dedicated Postgres schema that is
// NOT exposed through PostgREST. Clients reach V3 only through public.fin3_* RPCs.
export const DB_SCHEMA = "finance_v3";
export const RPC_PREFIX = "fin3_";
export const MIGRATION_NAME_MARKER = "finance_v3"; // supabase/migrations/<ts>_finance_v3_<topic>.sql

// Existing objects that V3 must never alter, drop or write to (enforced by guards/).
export const V2_PROTECTED_TABLES = Object.freeze([
  "finance_settings", "chart_accounts", "fx_rates", "journal_entries", "journal_lines",
  "finance_audit_log", "finance_contacts", "bank_accounts", "bank_reconciliations",
  "invoice_payments", "bills", "bill_shots", "bill_payments",
  "invoices", "expenses", "shots", "projects", "team_members",
]);

// ---- Money conventions ------------------------------------------------------
// Amounts cross every boundary as DECIMAL STRINGS ("1234.5600"), never JS numbers.
// Storage: numeric(19,4). FX rates: numeric(20,10), expressed as
//   base_amount = native_amount * rate   (rate = units of BASE per 1 unit of NATIVE).
// Rounding: round half away from zero (PostgreSQL numeric round()) to the currency's
// ISO 4217 minor unit, applied once, in the database, when a base amount is derived.
export const MONEY = Object.freeze({
  storageScale: 4,
  storagePrecision: 19,
  fxRateScale: 10,
  fxRatePrecision: 20,
  roundingMode: "half_away_from_zero",
  wireFormat: "decimal_string",
  // Signed (balances may be negative); no leading zeros. Journal LINES use the stricter, unsigned LINE_AMOUNT_PATTERN.
  amountPattern: /^-?(0|[1-9]\d{0,14})(\.\d{1,4})?$/,
});

// ---- Chart of accounts ----------------------------------------------------------
export const ACCOUNT_TYPES = Object.freeze([
  "asset", "liability", "equity", "revenue", "cost_of_sales",
  "operating_expense", "other_income", "other_expense",
]);
export const NORMAL_BALANCE = Object.freeze({
  asset: "debit", liability: "credit", equity: "credit", revenue: "credit",
  cost_of_sales: "debit", operating_expense: "debit", other_income: "credit", other_expense: "debit",
});

// ---- Journal -----------------------------------------------------------------------
export const ENTRY_STATUS = Object.freeze(["draft", "posted", "reversed"]);
export const LINE_SIDE = Object.freeze(["debit", "credit"]);
export const FX_STATUS = Object.freeze(["native", "converted", "missing", "estimate"]);

// ---- UI modes ---------------------------------------------------------------------
export const UI_MODES = Object.freeze(["simple", "accountant"]);
export const DEFAULT_UI_MODE = "simple";

// ---- Error codes ---------------------------------------------------------------------
// Custom SQLSTATEs. Class "V3" is implementation-defined (class letters I-Z are free
// for applications; the standard reserves 0-4 and A-H). Phase 2 SQL must raise these
// with `using errcode = 'V3xxx'`; the UI maps them to plain-language messages.
// An idempotent replay is NOT an error: it returns the original result.
export const ERROR_CODES = Object.freeze({
  UNBALANCED_ENTRY: "V3001",
  POSTED_IMMUTABLE: "V3002",
  FX_RATE_MISSING: "V3003",
  NOT_AUTHORIZED: "V3005",
  PERIOD_LOCKED: "V3006",
  PROTECTION_BLOCKED: "V3007",
  CURRENCY_MISMATCH: "V3008",
  INVALID_ACCOUNT: "V3009",
  NOT_FOUND: "V3010",
  INVALID_INPUT: "V3011",
  OVERPAYMENT: "V3012",
  // Added in Phase 1 (integration contracts). A replay of an already-processed event is NOT an error.
  PAYMENT_AMOUNT_MISMATCH: "V3013",
  PAYMENT_CURRENCY_MISMATCH: "V3014",
  PAYMENT_NOT_VERIFIED: "V3015",
  ENGINE_MISMATCH: "V3016",        // organization is not on the engine that must handle this operation
  INVOICE_STATE_INVALID: "V3017",  // not payable / not sendable in its current state
  EMAIL_RECIPIENT_INVALID: "V3018",
  ENVIRONMENT_NOT_ALLOWED: "V3019", // e.g. a Paystack TEST payment for a non-sandbox organization
  // Added in Phase 2 (accounting engine).
  ALREADY_REVERSED: "V3020",         // the entry already has a reversal
  IDEMPOTENCY_CONFLICT: "V3021",     // same idempotency key / provider reference, different content
  ORG_NOT_INITIALIZED: "V3022",      // fin3_init_organization has not been run for this organization
  ENTRY_STATE_INVALID: "V3023",      // e.g. posting an entry that is not a draft, reversing a draft
  BASE_CURRENCY_LOCKED: "V3024",     // base currency cannot change once real entries are posted
});

// ============================================================================================
// Integration contracts (Phase 1, roadmap sections F, G, I).
// Specifications: docs/finance-v3/FINANCE_V3_RESEND_INTEGRATION_SPEC.md and
//                 docs/finance-v3/FINANCE_V3_PAYSTACK_INTEGRATION_SPEC.md
// Nothing here is implemented yet and nothing here computes money. These are names, enumerations
// and pure string helpers that the database (Phase 2-3), the Edge Functions (Phase 3) and the
// UI (Phase 5) must agree on.
// ============================================================================================

// Which accounting engine accepts new money events for an organization (architecture D-09).
export const ENGINES = Object.freeze(["v2", "v3"]);

// Providers. Finance V3 is the financial source of truth; providers only deliver mail / collect money.
export const EMAIL_PROVIDER = "resend";
export const PAYMENT_PROVIDERS = Object.freeze(["paystack"]); // open set; manual payments are a separate path
export const PAYMENT_ENVIRONMENTS = Object.freeze(["test", "live"]);

// ---- Finance email (Resend spec section 3) ----------------------------------------------
export const FINANCE_EMAIL_TYPES = Object.freeze([
  "invoice", "invoice_reminder", "overdue_notice", "payment_receipt", "invoice_update", "refund_notice",
]);
// The six user-visible states (roadmap 3.B / 5.B). Extra provider facts live in delivery_flags.
export const FINANCE_EMAIL_STATUS = Object.freeze(["queued", "sending", "sent", "delivered", "bounced", "failed"]);
// Status only moves forward by rank; bounced/failed are terminal. A late "sent" never regresses "delivered".
export const FINANCE_EMAIL_STATUS_RANK = Object.freeze({ queued: 0, sending: 1, sent: 2, delivered: 3, bounced: 4, failed: 4 });
export const FINANCE_EMAIL_DELIVERY_FLAGS = Object.freeze(["delayed", "complained", "suppressed"]);
// Resend echoes this tag in signed webhook events. Distinct from the Inbox tag "kf_message_id".
export const FINANCE_EMAIL_TAG = "kf_finance_message_id";
export const INBOX_EMAIL_TAG = "kf_message_id";
// "Emailed" for the user means sent or delivered - never merely "the API request was issued".
export const FINANCE_EMAIL_EMAILED_STATES = Object.freeze(["sent", "delivered"]);
export const FINANCE_EMAIL_MAX_AUTO_ATTEMPTS = 5;
export const FINANCE_EMAIL_BACKOFF_SECONDS = Object.freeze([60, 300, 1800, 7200, 43200]);

/**
 * Map a signed Resend event to a Finance email outcome. Pure string logic, no money.
 * Returns { status, flag } where either may be null (no change). Unknown events -> null/null.
 * Temporary/transient/soft bounces are delays, not permanent failures (same rule as the Inbox adapter).
 */
export function financeEmailOutcomeForResendEvent(eventType, bounceType = "") {
  switch (String(eventType || "")) {
    case "email.sent": return { status: "sent", flag: null };
    case "email.delivered": return { status: "delivered", flag: null };
    case "email.delivery_delayed": return { status: null, flag: "delayed" };
    case "email.bounced":
      return /temporary|transient|soft/i.test(String(bounceType || ""))
        ? { status: null, flag: "delayed" }
        : { status: "bounced", flag: null };
    case "email.complained": return { status: null, flag: "complained" };
    case "email.failed": return { status: "failed", flag: null };
    case "email.suppressed":
    case "email.rejected": return { status: "failed", flag: "suppressed" };
    default: return { status: null, flag: null };
  }
}

/** True when moving from `from` to `to` is a legal forward transition for a Finance email. */
export function canAdvanceFinanceEmailStatus(from, to) {
  if (!(from in FINANCE_EMAIL_STATUS_RANK) || !(to in FINANCE_EMAIL_STATUS_RANK)) return false;
  if (from === "bounced" || from === "failed") return false;
  return FINANCE_EMAIL_STATUS_RANK[to] > FINANCE_EMAIL_STATUS_RANK[from];
}

// ---- Payments (Paystack spec section 3-4) ----------------------------------------------
export const PAYMENT_INTENT_STATUS = Object.freeze([
  "created", "initialized", "pending", "succeeded", "failed", "abandoned", "expired", "cancelled", "needs_review",
]);
export const OPEN_PAYMENT_INTENT_STATUS = Object.freeze(["created", "initialized", "pending"]); // at most one per invoice
export const PAYMENT_VERIFICATION_STATUS = Object.freeze(["verified", "pending_verification", "rejected"]);
export const PAYMENT_METHODS = Object.freeze(["card", "apple_pay", "bank_transfer", "cash", "other"]);
export const REFUND_STATUS = Object.freeze(["requested", "approved", "processing", "processed", "failed", "rejected"]);
export const PROVIDER_EVENT_STATUS = Object.freeze([
  "received", "processing", "processed", "ignored", "failed", "needs_review", "exhausted",
]);
// Paystack events the existing handler acts on (supabase/functions/_shared/paystack_core.ts HANDLED_EVENTS).
export const PAYSTACK_HANDLED_EVENTS = Object.freeze([
  "charge.success", "refund.processed", "refund.failed", "refund.pending", "refund.processing",
]);

// V3 payment reference. Disjoint from every existing prefix ("KRL-L-", "KRL-T-", "KRL-W-") so the shared
// webhook can route by prefix, and it contains no fragment of any internal id.
export const V3_PAYMENT_REFERENCE_PREFIX = "KRL3-";
export const LEGACY_PAYMENT_REFERENCE_PREFIXES = Object.freeze(["KRL-L-", "KRL-T-", "KRL-W-"]);
export const V3_PAYMENT_REFERENCE_PATTERN = /^KRL3-[LT]-[A-Z2-7]{12}-[A-Z2-7]{4}$/;
export function isV3PaymentReference(ref) {
  return typeof ref === "string" && ref.startsWith(V3_PAYMENT_REFERENCE_PREFIX);
}

// ---- Idempotency keys (Resend spec 3.3, Paystack spec 6) -----------------------------------
// Every externally triggered or retried operation carries a key; (organization_id, key) is unique in the
// database and a replay returns the original result. Parts may contain only [A-Za-z0-9_.:-].
export const IDEMPOTENCY_KINDS = Object.freeze([
  "email:invoice", "email:reminder", "email:overdue", "email:receipt", "email:update", "email:refund", "email:resend",
  "pay:intent", "pay", "refund", "manual-pay", "event",
  // Phase 2 (ledger operations)
  "journal", "journal:reverse", "journal:draft",
  // Phase 3 (documents, payments, purchases). The database hashes caller keys into its event keys; these are the caller-side kinds.
  "invoice:draft", "invoice:credit", "pay:manual", "refund:request", "bill:draft", "bill:pay", "expense", "transfer",
]);
export const IDEMPOTENCY_KEY_MAX = 200;
const KEY_PART = /^[A-Za-z0-9_.:-]{1,80}$/;
export function buildIdempotencyKey(kind, ...parts) {
  if (!IDEMPOTENCY_KINDS.includes(kind)) throw new Error(`Unknown idempotency kind: ${kind}`);
  if (!parts.length) throw new Error("An idempotency key needs at least one part");
  for (const p of parts) {
    if (!KEY_PART.test(String(p))) throw new Error("Invalid idempotency key part");
  }
  const key = `fin3:${kind}:${parts.join(":")}`;
  if (key.length > IDEMPOTENCY_KEY_MAX) throw new Error("Idempotency key too long");
  return key;
}

// ---- Permissions reserved for integrations (mapped from roles in Phase 2) ----------------------
export const INTEGRATION_PERMISSIONS = Object.freeze([
  "finance.send_email", "finance.collect", "finance.verify_payment", "finance.refund", "finance.view_integrations",
]);

// ---- Existing objects V3 must never alter, drop or write (guards/isolation.test.mjs) ------------
// Exact names plus prefixes. V3 may READ these. V3 owns its own finance_v3.email_* / payment_* tables.
export const PROTECTED_INTEGRATION_TABLES = Object.freeze([
  "paystack_transactions", "paystack_webhook_events",
  "payment_providers", "payment_quotes", "payment_checkout_sessions", "payment_manual_payments",
  "payment_events", "payment_fx_snapshots", "payment_transactions",
]);
export const PROTECTED_INTEGRATION_TABLE_PREFIXES = Object.freeze(["email_", "intel_"]);

// Edge Function directories that may exist as webhook processors. A second Paystack or Resend webhook
// would double-post or fork event handling (roadmap 1.7, 5.2); extend the existing handler instead.
export const ALLOWED_PAYSTACK_WEBHOOK_FUNCTIONS = Object.freeze(["paystack-webhook"]);
export const ALLOWED_RESEND_WEBHOOK_FUNCTIONS = Object.freeze(["resend-webhook", "intel-resend-webhook"]);

// ============================================================================================
// Phase 2 contracts: accounting engine, chart of accounts, posting RPCs.
// The database is the authority. These constants mirror what migrations
//   20270113090000_finance_v3_core_schema.sql, 20270113091000_finance_v3_posting_engine.sql and
//   20270113092000_finance_v3_rpc_surface.sql implement; src/finance-v3/contracts/phase2-parity.test.mjs
// fails if the two ever drift apart. Nothing here computes money.
// ============================================================================================

// Physical status stored in finance_v3.journal_entries. "reversed" (see ENTRY_STATUS) is a DERIVED display state:
// a posted entry is reversed when another entry links to it through reverses_entry_id (fin3_get_entry.is_reversed).
export const PHYSICAL_ENTRY_STATUS = Object.freeze(["draft", "posted"]);

// Journal line amounts are strictly positive decimal strings (the side carries the direction), at most 15 integer digits and
// 4 decimals, and never more decimals than the currency's ISO 4217 minor unit. JSON numbers are rejected by the database.
export const LINE_AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,14})(\.[0-9]{1,4})?$/;
// FX rate wire format for fin3_set_fx_rate: positive decimal string, up to 10 integer and 10 fractional digits.
export const FX_RATE_PATTERN = /^[0-9]{1,10}(\.[0-9]{1,10})?$/;
export const FX_SOURCES = Object.freeze(["manual", "provider", "import"]);
export const MAX_LINES_PER_ENTRY = 500;

// ---- Permissions (finance_v3.permissions) ----------------------------------------------------
export const PERMISSIONS = Object.freeze([
  "finance.read", "finance.post", "finance.approve", "finance.pay", "finance.owner_pay", "finance.override",
  "finance.admin", "finance.send_email", "finance.collect", "finance.verify_payment", "finance.refund",
  "finance.view_integrations",
]);
// Held by an ACTIVE department_admin who administers a department named Finance or Accounting (name compared case- and
// punctuation-insensitively). master_user holds every permission. Freelancers and clients never hold any.
export const FINANCE_DEPARTMENT_ADMIN_PERMISSIONS = Object.freeze([
  "finance.read", "finance.post", "finance.approve", "finance.pay",
  "finance.send_email", "finance.collect", "finance.verify_payment", "finance.view_integrations",
]);
export const FINANCE_DEPARTMENT_NAMES = Object.freeze(["finance", "accounting"]);
// Only the Master User may grant or revoke these.
export const MASTER_ONLY_PERMISSIONS = Object.freeze(["finance.admin", "finance.override", "finance.owner_pay", "finance.refund"]);
export const NO_FINANCE_ACCESS_ROLES = Object.freeze(["freelancer", "client"]);

// ---- Financial event kinds (finance_v3.event_kinds) ------------------------------------------
// enabled = accepted by the posting engine today; allowsProvider = may be created in a system context from a verified
// external (provider) event. Kinds with enabled=false are reserved for the phase noted and are refused (V3011) until a
// later migration enables them together with their domain RPC.
export const EVENT_KINDS = Object.freeze({
  manual_journal:      Object.freeze({ permission: "finance.post",           enabled: true,  allowsProvider: false, phase: 2 }),
  reversal:            Object.freeze({ permission: "finance.approve",        enabled: true,  allowsProvider: false, phase: 2 }),
  client_payment:      Object.freeze({ permission: "finance.verify_payment", enabled: true,  allowsProvider: true,  phase: 2 }),
  refund_issued:       Object.freeze({ permission: "finance.refund",          enabled: true,  allowsProvider: true,  phase: 2 }),
  adjustment:          Object.freeze({ permission: "finance.approve",        enabled: false, allowsProvider: false, phase: 3 }),
  opening_balance:     Object.freeze({ permission: "finance.admin",          enabled: false, allowsProvider: false, phase: 3 }),
  legacy_import:       Object.freeze({ permission: "finance.admin",          enabled: false, allowsProvider: false, phase: 3 }),
  invoice_issued:      Object.freeze({ permission: "finance.post",           enabled: false, allowsProvider: false, phase: 3 }),
  bill_approved:       Object.freeze({ permission: "finance.approve",        enabled: false, allowsProvider: false, phase: 3 }),
  bill_payment:        Object.freeze({ permission: "finance.pay",            enabled: false, allowsProvider: false, phase: 3 }),
  expense_paid:        Object.freeze({ permission: "finance.pay",            enabled: false, allowsProvider: false, phase: 3 }),
  bank_transfer:       Object.freeze({ permission: "finance.pay",            enabled: false, allowsProvider: false, phase: 3 }),
  owner_contribution:  Object.freeze({ permission: "finance.owner_pay",      enabled: false, allowsProvider: false, phase: 4 }),
  owner_draw:          Object.freeze({ permission: "finance.owner_pay",      enabled: false, allowsProvider: false, phase: 4 }),
  owner_salary:        Object.freeze({ permission: "finance.owner_pay",      enabled: false, allowsProvider: false, phase: 4 }),
  owner_reimbursement: Object.freeze({ permission: "finance.owner_pay",      enabled: false, allowsProvider: false, phase: 4 }),
  animator_obligation: Object.freeze({ permission: "finance.approve",        enabled: false, allowsProvider: false, phase: 4 }),
  animator_payment:    Object.freeze({ permission: "finance.pay",            enabled: false, allowsProvider: false, phase: 4 }),
});

// ---- System accounts seeded for every organization (finance_v3.default_chart rows with a system_key) ----
// Later phases post to these by system_key, never by a hard-coded account code.
export const SYSTEM_ACCOUNT_KEYS = Object.freeze({
  cash_and_bank: "1000", payment_clearing: "1050", accounts_receivable: "1100",
  accounts_payable: "2000", animator_payables: "2100", client_deposits: "2200", tax_payable: "2300", owner_payable: "2500",
  owner_contributions: "3100", owner_draws: "3200", opening_balance: "3300", retained_earnings: "3900",
  revenue_animation: "4000", cos_animator: "5000", owner_salary: "6000", bank_fees: "6600", fx_gain: "7100", fx_loss: "8100",
});
export const DEFAULT_CHART_ACCOUNT_COUNT = 45;

// ---- Public RPCs implemented in Phase 2 (the only client entry points, architecture D-01) --------
export const PHASE2_RPCS = Object.freeze([
  "fin3_init_organization", "fin3_get_org_settings", "fin3_set_base_currency", "fin3_set_period_lock",
  "fin3_list_accounts", "fin3_upsert_account",
  "fin3_set_fx_rate", "fin3_get_fx_rate",
  "fin3_post_journal", "fin3_reverse_entry", "fin3_save_draft_entry", "fin3_post_draft_entry", "fin3_discard_draft_entry",
  "fin3_get_entry", "fin3_trial_balance",
  "fin3_grant_permission", "fin3_revoke_permission", "fin3_list_permissions", "fin3_my_permissions",
]);

// ---- Phase 3 RPC surface (kept in sync with the migrations by contracts/phase3-parity.test.mjs) ----------------------
// User RPCs are granted to `authenticated` only. Service RPCs (prefix fin3svc_) are executable only by the server-side service identity and are called
// exclusively by Edge Functions; no client ever calls them.
export const PHASE3_RPCS = Object.freeze([
  "fin3_add_expense_attachment",
  "fin3_approve_bill",
  "fin3_approve_invoice",
  "fin3_approve_refund",
  "fin3_bank_balances",
  "fin3_complete_reconciliation",
  "fin3_create_payment_link",
  "fin3_credit_invoice",
  "fin3_discard_invoice_draft",
  "fin3_get_bill",
  "fin3_get_intent_for_invoice",
  "fin3_get_invoice",
  "fin3_get_org_profile",
  "fin3_get_receipt",
  "fin3_init_expense_categories",
  "fin3_issue_and_send_invoice",
  "fin3_issue_invoice",
  "fin3_list_bank_accounts",
  "fin3_list_bills",
  "fin3_list_contacts",
  "fin3_list_emails",
  "fin3_list_expense_categories",
  "fin3_list_expenses",
  "fin3_list_invoice_communications",
  "fin3_list_invoices",
  "fin3_list_payments",
  "fin3_list_provider_events",
  "fin3_list_refunds",
  "fin3_migration_extract_legacy_invoices",
  "fin3_migration_import",
  "fin3_migration_report",
  "fin3_migration_stage",
  "fin3_migration_start_run",
  "fin3_migration_validate",
  "fin3_pay_bill",
  "fin3_payables_aging",
  "fin3_post_transfer",
  "fin3_queue_invoice_email",
  "fin3_queue_invoice_reminder",
  "fin3_queue_invoice_update",
  "fin3_queue_overdue_notice",
  "fin3_queue_receipt_email",
  "fin3_receivables_aging",
  "fin3_reconciliation_candidates",
  "fin3_reconciliation_summary",
  "fin3_record_expense",
  "fin3_record_manual_payment",
  "fin3_record_refund",
  "fin3_reject_manual_payment",
  "fin3_reject_refund",
  "fin3_request_refund",
  "fin3_resend_email",
  "fin3_retry_email",
  "fin3_retry_intent_posting",
  "fin3_return_invoice_to_draft",
  "fin3_reverse_bill_payment",
  "fin3_reverse_payment",
  "fin3_revoke_links",
  "fin3_save_bill_draft",
  "fin3_save_invoice_draft",
  "fin3_set_reconciliation_matches",
  "fin3_start_reconciliation",
  "fin3_update_org_profile",
  "fin3_upsert_bank_account",
  "fin3_upsert_contact",
  "fin3_upsert_expense_category",
  "fin3_verify_manual_payment",
  "fin3_void_bill",
  "fin3_void_expense",
  "fin3_void_invoice"
]);
export const PHASE3_SERVICE_RPCS = Object.freeze([
  "fin3svc_apply_email_event",
  "fin3svc_apply_payment_status",
  "fin3svc_apply_refund_event",
  "fin3svc_claim_emails",
  "fin3svc_expire_unknown_emails",
  "fin3svc_finish_attempt",
  "fin3svc_finish_provider_event",
  "fin3svc_get_document",
  "fin3svc_get_email",
  "fin3svc_get_intent",
  "fin3svc_get_snapshot",
  "fin3svc_intent_initialized",
  "fin3svc_list_unapplied_email_events",
  "fin3svc_mark_email_event_error",
  "fin3svc_prepare_intent",
  "fin3svc_record_email_event",
  "fin3svc_record_provider_event",
  "fin3svc_resolve_link",
  "fin3svc_save_rendered",
  "fin3svc_settle_payment",
  "fin3svc_store_document"
]);
export const SERVICE_RPC_PREFIX = "fin3svc_";

// ---- Phase 4: studio financial intelligence and money protection ------------------------------------------------------
// New user RPCs (migration 20270115091000). All are SECURITY DEFINER, authenticated only; permissions are checked in the database.
export const PHASE4_RPCS = Object.freeze([
  "fin3_allocate_project_funds",
  "fin3_animator_statement",
  "fin3_approve_animator_work",
  "fin3_cancel_owner_payment",
  "fin3_check_spend",
  "fin3_execute_owner_payment",
  "fin3_get_project_financials",
  "fin3_get_protection_settings",
  "fin3_list_allocations",
  "fin3_list_animator_assignments",
  "fin3_list_animator_obligations",
  "fin3_list_owner_payments",
  "fin3_list_project_financials",
  "fin3_list_protection_events",
  "fin3_list_reserves",
  "fin3_move_reserve",
  "fin3_owner_summary",
  "fin3_pay_animator",
  "fin3_record_owner_paid_expense",
  "fin3_record_owner_payment",
  "fin3_reject_animator_work",
  "fin3_release_allocation",
  "fin3_reserve_history",
  "fin3_reverse_animator_payment",
  "fin3_reverse_owner_payment",
  "fin3_safe_to_spend",
  "fin3_schedule_owner_payment",
  "fin3_submit_animator_work",
  "fin3_update_protection_settings",
  "fin3_upsert_animator_assignment",
  "fin3_upsert_project_finance",
  "fin3_upsert_reserve",
  "fin3_void_animator_work"
]);
// Phase 3 RPCs REPLACED in Phase 4 (migration 20270115090000): same names, one extra optional trailing parameter p_override (jsonb).
// The old signatures are dropped, so no unprotected overload exists. They stay listed in PHASE3_RPCS.
export const PHASE4_REDEFINED_RPCS = Object.freeze(["fin3_pay_bill", "fin3_post_transfer", "fin3_record_expense"]);
// Protection checks the database applies (finance_v3.enforce_protection) and the modes a studio can choose. There is no "off".
export const PROTECTION_CHECKS = Object.freeze(["commitment_payment", "spend", "reserve_contribution", "reserve_withdrawal"]);
// fin3_check_spend (a read-only pre-check for the UI) accepts only these three; reserve_withdrawal is enforced inside fin3_move_reserve.
export const CHECK_SPEND_KINDS = Object.freeze(["spend", "commitment_payment", "reserve_contribution"]);
export const PROTECTION_MODES = Object.freeze(["block", "warn"]);
export const OWNER_PAYMENT_TYPES = Object.freeze(["salary", "draw", "personal_withdrawal", "contribution", "reimbursement"]);
export const RESERVE_MODES = Object.freeze(["logical", "account"]);
// An override is { reason: "<10-500 characters>" } and needs the finance.override permission.
export const OVERRIDE_REASON = Object.freeze({ minLength: 10, maxLength: 500 });

// ---- Phase 5: Finance user interface read services (migration 20270116090000) --------------------------------------------
// Read-only apart from fin3_set_ui_prefs (the Simple/Accountant choice). The fin3_report_* functions are the Phase 6 reporting
// family brought forward because Accountant Mode needs them; Phase 6 extends them.
export const PHASE5_RPCS = Object.freeze([
  "fin3_explain_safe_to_spend",
  "fin3_get_ui_prefs",
  "fin3_list_audit",
  "fin3_list_entries",
  "fin3_list_receipts",
  "fin3_overview",
  "fin3_preview_invoice_email",
  "fin3_report_balance_sheet",
  "fin3_report_cash_flow",
  "fin3_report_general_ledger",
  "fin3_report_profit_loss",
  "fin3_report_tax_summary",
  "fin3_set_ui_prefs"
]);
// Phase 3 RPC replaced in Phase 5 (same signature): fin3_queue_invoice_email now accepts optional `subject` and `message` options.
export const PHASE5_REDEFINED_RPCS = Object.freeze(["fin3_queue_invoice_email"]);
// Limits the database enforces on an edited invoice email.
export const EMAIL_EDIT_LIMITS = Object.freeze({ subjectMax: 150, messageMax: 2000 });

// ---- Phase 6: reporting, dashboard, notifications, scheduled processing, exports, project links (migration 20270117090000) ----
// Every function here is STABLE (read-only) except the five that write one thing each: fin3_set_alert_settings (settings),
// fin3_mark_notifications_read (the caller's own read markers), fin3_set_record_link (a project link), fin3_export_rows (an audit row).
export const PHASE6_RPCS = Object.freeze([
  "fin3_dashboard",
  "fin3_emma_snapshot",
  "fin3_export_rows",
  "fin3_get_alert_settings",
  "fin3_list_notifications",
  "fin3_mark_notifications_read",
  "fin3_notification_counts",
  "fin3_project_finance_detail",
  "fin3_report_animator_obligations",
  "fin3_report_email_delivery",
  "fin3_report_expense_breakdown",
  "fin3_report_integrity",
  "fin3_report_invoice_status",
  "fin3_report_owner_compensation",
  "fin3_report_payment_history",
  "fin3_report_payment_reconciliation",
  "fin3_report_reserves",
  "fin3_scheduler_status",
  "fin3_set_alert_settings",
  "fin3_set_record_link"
]);
// Service-role only (never callable from a screen).
export const PHASE6_SERVICE_RPCS = Object.freeze(["fin3svc_list_unsettled_intents", "fin3svc_run_scheduled"]);
// Emma's read path (migration 20270117091000). Called by the Intelligence agent worker, not by Finance screens.
export const PHASE6_EMMA_RPC = "intel_agent_finance_read";
export const EMMA_FINANCE_TOOL = "finance_insights";
export const EXPORT_KINDS = Object.freeze(["invoices", "payments", "transactions", "audit", "project_profitability", "email_delivery", "expenses", "report_profit_loss"]);
export const NOTIFICATION_CATEGORIES = Object.freeze(["invoice", "payment", "email", "project", "reserve", "payables", "safety", "integration", "reconciliation", "cash"]);
export const NOTIFICATION_SEVERITIES = Object.freeze(["info", "warning", "critical"]);
export const RECORD_LINK_TYPES = Object.freeze(["work_item", "invoice", "expense", "bill"]);
// Largest export the database returns in one call; beyond it the result says truncated=true.
export const EXPORT_ROW_CAP = 20000;
