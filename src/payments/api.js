// Network layer for Payments. Reads use RLS-protected selects; every write is an RPC or an
// Edge Function (nothing here can mark a payment successful or set an amount).
import { supabase } from "../supabaseClient";

const PAGE = 1000;
async function fetchAll(table, { order, ascending = false, filter } = {}) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from(table).select("*").range(from, from + PAGE - 1);
    if (filter) q = filter(q);
    if (order) q = q.order(order, { ascending });
    const { data, error } = await q;
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

export async function loadPaymentsData() {
  const [transactions, payouts, bills, billPayments, billShots, invoicePayments, feeExpenses, events, audit] = await Promise.all([
    fetchAll("paystack_transactions", { order: "created_at" }),
    fetchAll("freelancer_payout_requests", { order: "created_at" }),
    fetchAll("bills", { order: "issue_date" }),
    fetchAll("bill_payments", { order: "paid_date" }),
    fetchAll("bill_shots"),
    fetchAll("invoice_payments", { order: "paid_date" }),
    fetchAll("expenses", { filter: (q) => q.eq("category", "Payment processing fees") }),
    supabase.from("paystack_webhook_events").select("id,event,reference,status,attempts,error,received_at,processed_at").order("received_at", { ascending: false }).limit(50).then((r) => r.data || []),
    supabase.from("finance_audit_log").select("*").in("object_type", ["paystack_transaction", "payout_request"]).order("at", { ascending: false }).limit(100).then((r) => r.data || []),
  ]);
  return { transactions, payouts, bills, billPayments, billShots, invoicePayments, feeExpenses, events, audit };
}

async function readFunctionError(error) {
  try {
    const body = await error?.context?.json?.();
    if (body?.error) return body.error;
  } catch { /* fall through */ }
  return error?.message || "Request failed.";
}

export async function callPayments(action, payload = {}) {
  const { data, error } = await supabase.functions.invoke("paystack-payments", { body: { action, ...payload } });
  if (error) throw new Error(await readFunctionError(error));
  return data;
}

async function rpc(name, args = {}) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}

export const startCheckout = (invoiceId, email, amount) => callPayments("init", { invoice_id: invoiceId, email, amount: amount ?? null });
export const verifyPayment = (reference) => callPayments("verify", { reference });
export const getSandboxStatus = () => callPayments("status");
export const getBalance = () => callPayments("balance");
export const getSettlements = () => callPayments("settlements");

export const retryApply = (id) => rpc("payments_retry_apply", { p_transaction: id });
export const resolveReview = (id, note) => rpc("payments_resolve_review", { p_transaction: id, p_note: note });

export const createPayoutRequest = (billId, amount, note) => rpc("payments_create_payout_request", { p_bill: billId, p_amount: amount, p_note: note || "" });
export const approvePayoutRequest = (id) => rpc("payments_approve_payout_request", { p_request: id });
export const cancelPayoutRequest = (id, reason) => rpc("payments_cancel_payout_request", { p_request: id, p_reason: reason || "" });
export const startSimulation = (id) => rpc("payments_simulate_payout_start", { p_request: id });
export const finishSimulation = (id, succeed, reason) => rpc("payments_simulate_payout_finish", { p_request: id, p_succeed: succeed, p_reason: reason || "" });
export const reconcilePayout = (id, billPaymentId) => rpc("payments_reconcile_payout", { p_request: id, p_bill_payment: billPaymentId });
export const billPendingShots = (shotIds) => rpc("finance_bill_pending_shots", { p_shot_ids: shotIds });
