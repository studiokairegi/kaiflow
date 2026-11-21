// Finance V3 - shared contracts (Phase 1).
//
// This file is the single JavaScript-side statement of the names and enumerations
// that the database (Phase 2+) and the UI (Phase 5+) must agree on. It contains NO
// accounting logic. The database is the authority for every financial calculation;
// nothing here may be used to compute a balance, a conversion or a posting.
//
// Changing a value here is a contract change: record it in the phase handoff.

export const FINANCE_V3_VERSION = "3.0.0-phase1.1";

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
  amountPattern: /^-?\d{1,15}(\.\d{1,4})?$/,
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
