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
  const [transactions, payouts, bills, billPayments, billShots, invoicePayments, feeExpenses, events, audit, gateway] = await Promise.all([
    fetchAll("paystack_transactions", { order: "created_at" }),
    fetchAll("freelancer_payout_requests", { order: "created_at" }),
    fetchAll("bills", { order: "issue_date" }),
    fetchAll("bill_payments", { order: "paid_date" }),
    fetchAll("bill_shots"),
    fetchAll("invoice_payments", { order: "paid_date" }),
    fetchAll("expenses", { filter: (q) => q.eq("category", "Payment processing fees") }),
    supabase.from("paystack_webhook_events").select("id,event,reference,status,attempts,error,received_at,processed_at").order("received_at", { ascending: false }).limit(50).then((r) => r.data || []),
    supabase.from("finance_audit_log").select("*").in("object_type", ["paystack_transaction", "payout_request"]).order("at", { ascending: false }).limit(100).then((r) => r.data || []),
    callPayments("snapshot").catch((error) => ({ available: false, error: error?.message || "Paystack live data is unavailable." })),
  ]);
  return { transactions, payouts, bills, billPayments, billShots, invoicePayments, feeExpenses, events, audit, gateway };
}

async function readFunctionError(error) {
  try {
    const body = await error?.context?.json?.();
    if (body?.error) return { message: body.error, code: body.code || "" };
  } catch { /* fall through */ }
  return { message: error?.message || "Request failed.", code: "" };
}

export async function callPayments(action, payload = {}) {
  const { data, error } = await supabase.functions.invoke("paystack-payments", { body: { action, ...payload } });
  if (error) { const e = await readFunctionError(error); throw Object.assign(new Error(e.message), { code: e.code }); }
  return data;
}

async function rpc(name, args = {}) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}

export const startCheckout = (invoiceId, email, amount) => callPayments("init", { invoice_id: invoiceId, email, amount: amount ?? null });
export const verifyPayment = (reference) => callPayments("verify", { reference });
export const getPaystackStatus = () => callPayments("status");
export const connectPaystack = () => callPayments("connect");
export const getBalance = () => callPayments("balance");
export const getSettlements = () => callPayments("settlements");
export const getGatewaySnapshot = () => callPayments("snapshot");

export const retryApply = (id) => rpc("payments_retry_apply", { p_transaction: id });
export const resolveReview = (id, note) => rpc("payments_resolve_review", { p_transaction: id, p_note: note });

export const createPayoutRequest = (billId, amount, note) => rpc("payments_create_payout_request", { p_bill: billId, p_amount: amount, p_note: note || "" });
export const approvePayoutRequest = (id) => rpc("payments_approve_payout_request", { p_request: id });
export const cancelPayoutRequest = (id, reason) => rpc("payments_cancel_payout_request", { p_request: id, p_reason: reason || "" });
export const startSimulation = (id) => rpc("payments_simulate_payout_start", { p_request: id });
export const finishSimulation = (id, succeed, reason) => rpc("payments_simulate_payout_finish", { p_request: id, p_succeed: succeed, p_reason: reason || "" });
export const reconcilePayout = (id, billPaymentId) => rpc("payments_reconcile_payout", { p_request: id, p_bill_payment: billPaymentId });
export const billPendingShots = (shotIds) => rpc("finance_bill_pending_shots", { p_shot_ids: shotIds });

// ---- provider-neutral (admin RPCs; every one re-checks admin on the server) -----------------
export const listProviders = () => rpc("payments_list_providers");
export const setProviderEnabled = (provider, enabled) => rpc("payments_set_provider_enabled", { p_provider: provider, p_enabled: enabled });
export const setPrimaryProvider = (provider) => rpc("payments_set_primary_provider", { p_provider: provider });
export const createCheckoutSession = (invoiceId, amount, expiresDays) =>
  rpc("payments_create_checkout_session", { p_invoice: invoiceId, p_amount: amount ?? null, p_expires_days: expiresDays ?? 14 }).then((r) => (Array.isArray(r) ? r[0] : r));
export const cancelCheckoutSession = (sessionId) => rpc("payments_cancel_checkout_session", { p_session: sessionId });

// PUBLIC (no login): the only call the /pay/{token} page makes. Returns a minimal view; see migration.
export const getPublicCheckout = (token) => rpc("payments_public_checkout", { p_token: token });

export const setPaystackOptions = (channels, currencies) => rpc("payments_set_paystack_options", { p_channels: channels, p_currencies: currencies });

// PUBLIC checkout actions (anonymous Edge Function). The server decides amount, currency and
// environment from the token; the browser only says which method and which email.
async function callCheckout(action, payload) {
  const { data, error } = await supabase.functions.invoke("paystack-checkout", { body: { action, ...payload } });
  if (error) { const e = await readFunctionError(error); throw Object.assign(new Error(e.message), { code: e.code }); }
  return data;
}
// quote_id is the id of the server-made quote the client just confirmed; the server rejects a missing, expired,
// superseded or foreign quote and re-derives every amount itself.
export const getCheckoutQuote = (token, channel) => callCheckout("quote", { token, channel });
export const startPublicCheckout = (token, email, channel, quoteId) => callCheckout("start", { token, email, channel, quote_id: quoteId || null });
export const startWiseTransfer = (token, email) => callCheckout("wise_start", { token, email: email || "" });
export const submitWiseTransfer = (token, { reference, transferReference, payerName, note }) =>
  callCheckout("wise_submit", { token, reference, transfer_reference: transferReference, payer_name: payerName || "", note: note || "" });
export const confirmPublicCheckout = (token, reference) => callCheckout("confirm", { token, reference: reference || "" });

// ---- Wise / M-PESA manual payments (admin) --------------------------------------------------------
export const setWiseManual = (settings) => rpc("payments_set_wise_manual", { p_settings: settings });
export const loadManualPayments = async () => fetchAll("payment_manual_payments", { order: "created_at" });
export const reviewManualPayment = (id, decision, { credited, received, receivedCurrency, note } = {}) =>
  rpc("payments_manual_review", { p_id: id, p_decision: decision, p_credited_amount: credited ?? null, p_received_amount: received ?? null, p_received_currency: receivedCurrency || null, p_note: note || "" });
