// Finance V3 Phase 4 client API: studio financial intelligence and money protection. A thin, strict wrapper over the user RPCs.
//   * Same rules as Phase 3: only user RPCs, money as DECIMAL STRINGS, stable V3xxx error codes (V3007 = blocked by protection).
//   * The database is the only authority for safe-to-spend and protection. Nothing here computes a balance or decides a block;
//     `checkSpend` only asks the database. An override is { reason } and is honoured only for holders of finance.override.
//   * Reads of safe-to-spend, protection settings and events are for finance.read holders; owner compensation needs finance.owner_pay.
import { PHASE3_RPCS, PHASE4_RPCS, PHASE3_SERVICE_RPCS, ERROR_CODES, OVERRIDE_REASON } from "../contracts/index.js";
import { FinanceV3Error, assertDecimalString } from "./phase3.js";

export { FinanceV3Error, assertDecimalString };
const CODE_NAMES = Object.fromEntries(Object.entries(ERROR_CODES).map(([k, v]) => [v, k]));
const bad = (msg) => new FinanceV3Error(msg, ERROR_CODES.INVALID_INPUT, "INVALID_INPUT");

export function assertOverride(o) {
  if (o === undefined || o === null) return null;
  if (typeof o !== "object" || Array.isArray(o) || Object.keys(o).some((k) => k !== "reason")) throw bad('override must be { reason: "..." }');
  const r = typeof o.reason === "string" ? o.reason.trim() : "";
  if (r.length < OVERRIDE_REASON.minLength || r.length > OVERRIDE_REASON.maxLength) throw bad(`override reason must be ${OVERRIDE_REASON.minLength}-${OVERRIDE_REASON.maxLength} characters`);
  return { reason: r };
}
// Money-like fields inside JSON payloads must also be strings (the database rejects numbers too; this fails earlier and clearer).
function strings(obj, fields, label) {
  if (!obj || typeof obj !== "object") throw bad(`${label} must be an object`);
  for (const f of fields) if (obj[f] !== undefined && obj[f] !== null) assertDecimalString(obj[f], `${label}.${f}`);
  return obj;
}
const MONEY_FIELDS = ["amount", "agreed_rate", "quantity", "approved_quantity", "budget", "minimum_balance", "target_balance", "target_amount", "rate", "fee", "total_budget"];

export function createPhase4Api(rpc) {
  const allowed = new Set([...PHASE4_RPCS, ...PHASE3_RPCS]);
  async function call(name, args = {}) {
    if (PHASE3_SERVICE_RPCS.includes(name)) throw new FinanceV3Error(`${name} is a service-only function`, ERROR_CODES.NOT_AUTHORIZED, "NOT_AUTHORIZED");
    if (!allowed.has(name)) throw new FinanceV3Error(`${name} is not a Finance V3 Phase 3/4 RPC`, ERROR_CODES.INVALID_INPUT, "INVALID_INPUT");
    const { data, error } = await rpc(name, args);
    if (error) { const code = String(error.code || ""); throw new FinanceV3Error(error.message || "Finance request failed", code, CODE_NAMES[code]); }
    return data;
  }
  const ov = (o) => assertOverride(o);
  return {
    call,
    // protection and safe-to-spend
    getProtectionSettings: (org) => call("fin3_get_protection_settings", { p_org: org }),
    updateProtectionSettings: (org, settings) => call("fin3_update_protection_settings", { p_org: org, p_settings: settings }),
    safeToSpend: (org, currency = null) => call("fin3_safe_to_spend", { p_org: org, p_currency: currency }),
    checkSpend: (org, amount, currency, check = "spend", projectId = null) => call("fin3_check_spend", { p_org: org, p_amount: assertDecimalString(amount, "amount"), p_currency: currency, p_check: check, p_project: projectId }),
    listProtectionEvents: (org, limit = 50, offset = 0) => call("fin3_list_protection_events", { p_org: org, p_limit: limit, p_offset: offset }),
    // project finance
    upsertProjectFinance: (org, projectId, values) => call("fin3_upsert_project_finance", { p_org: org, p_project: projectId, p_values: strings({ ...values }, MONEY_FIELDS, "values") }),
    getProjectFinancials: (org, projectId) => call("fin3_get_project_financials", { p_org: org, p_project: projectId }),
    listProjectFinancials: (org, o = {}) => call("fin3_list_project_financials", { p_org: org, p_include_inactive: !!o.includeInactive, p_limit: o.limit ?? 50, p_offset: o.offset ?? 0 }),
    // animators
    upsertAnimatorAssignment: (org, a) => call("fin3_upsert_animator_assignment", { p_org: org, p_assignment: strings({ ...a }, MONEY_FIELDS, "assignment") }),
    listAnimatorAssignments: (org, o = {}) => call("fin3_list_animator_assignments", { p_org: org, p_project: o.projectId ?? null, p_animator: o.animatorId ?? null, p_include_ended: !!o.includeEnded }),
    submitAnimatorWork: (org, key, assignmentId, work) => call("fin3_submit_animator_work", { p_org: org, p_key: key, p_assignment: assignmentId, p_work: strings({ ...work }, MONEY_FIELDS, "work") }),
    approveAnimatorWork: (org, workId, approvedQuantity = null, date = null) => call("fin3_approve_animator_work", { p_org: org, p_work: workId, p_approved_quantity: approvedQuantity === null ? null : assertDecimalString(approvedQuantity, "approved quantity"), p_date: date }),
    rejectAnimatorWork: (org, workId, reason) => call("fin3_reject_animator_work", { p_org: org, p_work: workId, p_reason: reason }),
    voidAnimatorWork: (org, workId, reason) => call("fin3_void_animator_work", { p_org: org, p_work: workId, p_reason: reason }),
    payAnimator: (org, key, workId, amount, paidOn, payAccountId, o = {}) => call("fin3_pay_animator", { p_org: org, p_key: key, p_work: workId, p_amount: assertDecimalString(amount, "payment amount"), p_paid_on: paidOn, p_pay_account: payAccountId, p_reference: o.reference ?? null, p_override: ov(o.override) }),
    reverseAnimatorPayment: (org, paymentId, reason) => call("fin3_reverse_animator_payment", { p_org: org, p_payment: paymentId, p_reason: reason }),
    listAnimatorObligations: (org, f = {}) => call("fin3_list_animator_obligations", { p_org: org, p_animator: f.animatorId ?? null, p_project: f.projectId ?? null, p_currency: f.currency ?? null, p_status: f.status ?? null, p_outstanding_only: !!f.outstandingOnly, p_limit: f.limit ?? 50, p_offset: f.offset ?? 0 }),
    animatorStatement: (org, animatorId) => call("fin3_animator_statement", { p_org: org, p_animator: animatorId }),
    // protected production allocations
    allocateProjectFunds: (org, key, projectId, purpose, amount, note = null) => call("fin3_allocate_project_funds", { p_org: org, p_key: key, p_project: projectId, p_purpose: purpose, p_amount: assertDecimalString(amount, "allocation amount"), p_note: note }),
    releaseAllocation: (org, allocationId, amount = null, reason = null) => call("fin3_release_allocation", { p_org: org, p_allocation: allocationId, p_amount: amount === null ? null : assertDecimalString(amount, "release amount"), p_reason: reason }),
    listAllocations: (org, projectId = null, includeClosed = false) => call("fin3_list_allocations", { p_org: org, p_project: projectId, p_include_closed: includeClosed }),
    // reserves
    upsertReserve: (org, reserve) => call("fin3_upsert_reserve", { p_org: org, p_reserve: strings({ ...reserve }, MONEY_FIELDS, "reserve") }),
    moveReserve: (org, key, reserveId, type, amount, movedOn, o = {}) => call("fin3_move_reserve", { p_org: org, p_key: key, p_reserve: reserveId, p_type: type, p_amount: assertDecimalString(amount, "amount"), p_moved_on: movedOn, p_note: o.note ?? null, p_override: ov(o.override) }),
    listReserves: (org, includeInactive = false) => call("fin3_list_reserves", { p_org: org, p_include_inactive: includeInactive }),
    reserveHistory: (org, reserveId, limit = 50, offset = 0) => call("fin3_reserve_history", { p_org: org, p_reserve: reserveId, p_limit: limit, p_offset: offset }),
    // owner compensation
    recordOwnerPayment: (org, key, type, amount, currency, paidOn, accountId, o = {}) => call("fin3_record_owner_payment", { p_org: org, p_key: key, p_type: type, p_amount: assertDecimalString(amount, "amount"), p_currency: currency, p_paid_on: paidOn, p_account: accountId, p_note: o.note ?? null, p_override: ov(o.override) }),
    scheduleOwnerPayment: (org, key, type, amount, currency, scheduledFor, o = {}) => call("fin3_schedule_owner_payment", { p_org: org, p_key: key, p_type: type, p_amount: assertDecimalString(amount, "amount"), p_currency: currency, p_scheduled_for: scheduledFor, p_account: o.accountId ?? null, p_note: o.note ?? null }),
    executeOwnerPayment: (org, paymentId, paidOn, o = {}) => call("fin3_execute_owner_payment", { p_org: org, p_payment: paymentId, p_paid_on: paidOn, p_account: o.accountId ?? null, p_override: ov(o.override) }),
    cancelOwnerPayment: (org, paymentId, reason) => call("fin3_cancel_owner_payment", { p_org: org, p_payment: paymentId, p_reason: reason }),
    reverseOwnerPayment: (org, paymentId, reason) => call("fin3_reverse_owner_payment", { p_org: org, p_payment: paymentId, p_reason: reason }),
    recordOwnerPaidExpense: (org, key, expense) => call("fin3_record_owner_paid_expense", { p_org: org, p_key: key, p_expense: strings({ ...expense }, MONEY_FIELDS, "expense") }),
    listOwnerPayments: (org, f = {}) => call("fin3_list_owner_payments", { p_org: org, p_type: f.type ?? null, p_status: f.status ?? null, p_limit: f.limit ?? 50, p_offset: f.offset ?? 0 }),
    ownerSummary: (org, from = null, to = null) => call("fin3_owner_summary", { p_org: org, p_from: from, p_to: to }),
    // Phase 3 spending paths, now protected: the optional override is the only change
    payBill: (org, key, billId, amount, paidOn, payAccountId, o = {}) => call("fin3_pay_bill", { p_org: org, p_key: key, p_bill: billId, p_amount: assertDecimalString(amount, "payment amount"), p_paid_on: paidOn, p_pay_account: payAccountId, p_reference: o.reference ?? null, p_override: ov(o.override) }),
    recordExpense: (org, key, e, override = null) => call("fin3_record_expense", { p_org: org, p_key: key, p_expense: { ...e, amount: assertDecimalString(e.amount, "expense amount") }, p_override: ov(override) }),
    postTransfer: (org, key, t) => call("fin3_post_transfer", { p_org: org, p_key: key, p_from_account: t.fromAccountId, p_to_account: t.toAccountId, p_from_ccy: t.fromCurrency, p_to_ccy: t.toCurrency ?? t.fromCurrency,
      p_amount_from: assertDecimalString(t.amountFrom, "amount sent"), p_amount_to: assertDecimalString(t.amountTo ?? t.amountFrom, "amount received"), p_date: t.date, p_reference: t.reference ?? null, p_memo: t.memo ?? null, p_override: ov(t.override) }),
  };
}
