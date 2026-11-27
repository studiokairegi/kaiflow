// Finance V3 Paystack logic, called by the ONE existing paystack-webhook endpoint when an event's reference is a V3 reference
// (KRL3-...). This is NOT a second webhook processor (docs/finance-v3/FINANCE_V3_PAYSTACK_INTEGRATION_SPEC.md, D-13): the endpoint
// authenticates the request (signature -> environment) exactly as before and then routes by reference namespace. V2 references and
// every V2 table are untouched by this module.
//
// Trust model: the webhook only ever TRIGGERS work. Money is decided from what Paystack's verify API returns to us, and the database
// re-validates amount, currency, environment, studio and invoice state before it records anything (fin3svc_settle_payment). The
// browser/redirect is never evidence of payment.

export const V3_REFERENCE = /^KRL3-[LT]-[A-Z2-7]{12}-[A-Z2-7]{4}$/;
export const isV3Reference = (ref: unknown): boolean => typeof ref === "string" && V3_REFERENCE.test(ref);

export type Rpc = (name: string, args: Record<string, unknown>) => Promise<{ data: any; error: { message: string } | null }>;
export type VerifyFn = (reference: string) => Promise<{ ok: boolean; httpStatus: number; body: any; networkError?: string }>;

export type V3EventInput = {
  rpc: Rpc;
  verify: VerifyFn;
  environment: "test" | "live";
  eventKey: string;                 // already environment-prefixed by the endpoint
  event: string;
  reference: string;
  parsed: any;
  handled: boolean;                 // isHandledEvent(event)
};
export type V3Result = { status: number; body: Record<string, unknown> };

const sanitised = (parsed: any) => {
  const d = parsed?.data || {};
  return { event: parsed?.event, data: { id: d.id, reference: d.reference ?? d.transaction_reference, status: d.status, amount: d.amount, currency: d.currency, fees: d.fees, channel: d.channel } };
};
const must = (r: { data: any; error: { message: string } | null }, what: string) => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; };

export async function handleFinanceV3PaystackEvent(i: V3EventInput): Promise<V3Result> {
  const rec = must(await i.rpc("fin3svc_record_provider_event", {
    p_provider: "paystack", p_environment: i.environment, p_event_key: i.eventKey, p_event_type: i.event.slice(0, 80),
    p_reference: i.reference, p_payload: sanitised(i.parsed),
  }), "record event");
  if (rec.duplicate) return { status: 200, body: { duplicate: true } };
  const eventId: string = rec.id;
  const finish = async (status: "processed" | "ignored" | "failed" | "needs_review", error = "") => {
    const r = await i.rpc("fin3svc_finish_provider_event", { p_event: eventId, p_status: status, p_error: error.slice(0, 500) });
    if (r.error) console.error("finance paystack: could not record event status", { status, msg: r.error.message });   // visible, never swallowed silently
  };
  try {
    if (!i.handled) { await finish("ignored", "event type not handled"); return { status: 200, body: {} }; }
    const intent = must(await i.rpc("fin3svc_get_intent", { p_provider: "paystack", p_reference: i.reference }), "look up payment attempt");
    if (!intent) { await finish("ignored", "reference does not belong to a Finance V3 payment attempt"); return { status: 200, body: {} }; }
    if (intent.environment !== i.environment) { await finish("ignored", `environment mismatch (${i.environment} event, ${intent.environment} attempt)`); return { status: 200, body: {} }; }

    if (i.event === "charge.success") {
      const v = await i.verify(i.reference);
      if (!v.ok) throw new Error(`verify failed (HTTP ${v.httpStatus}${v.networkError ? `, ${v.networkError}` : ""})`);   // retryable
      const d = v.body?.data;
      if (v.body?.status !== true || !d || String(d.reference) !== i.reference) throw new Error("verify returned an unexpected body");
      const status = String(d.status || "");
      if (status === "success") {
        // Domain check: a live transaction verified through a test key (or the reverse) cannot happen, but never assume.
        if (d.domain && String(d.domain) !== i.environment) { await finish("needs_review", "verified transaction domain differs from the event environment"); return { status: 200, body: {} }; }
        const out = must(await i.rpc("fin3svc_settle_payment", {
          p_provider: "paystack", p_reference: i.reference, p_provider_txn: d.id === undefined || d.id === null ? null : String(d.id),
          p_amount_minor: Number(d.amount), p_currency: String(d.currency || ""), p_environment: i.environment,
          p_paid_at: d.paid_at || null, p_fee_minor: Number.isFinite(Number(d.fees)) && d.fees !== null ? Math.round(Number(d.fees)) : null,
          p_channel: d.channel ? String(d.channel) : null,
        }), "settle payment");
        if (out.outcome === "recorded" || out.outcome === "duplicate") { await finish("processed"); return { status: 200, body: { outcome: out.outcome } }; }
        if (out.outcome === "needs_review") { await finish("needs_review", String(out.reason || "needs review")); return { status: 200, body: { outcome: "needs_review" } }; }
        await finish("ignored", String(out.outcome || "no outcome"));
        return { status: 200, body: {} };
      }
      const mapped = status === "failed" ? "failed" : status === "abandoned" ? "abandoned" : status === "reversed" ? "reversed" : "pending";
      must(await i.rpc("fin3svc_apply_payment_status", { p_provider: "paystack", p_reference: i.reference, p_outcome: mapped }), "record payment status");
      await finish("processed", `transaction status ${status}`);
      return { status: 200, body: {} };
    }

    if (i.event.startsWith("refund.")) {
      const d = i.parsed?.data || {};
      const amountMinor = Number(d.amount);
      const refundRef = String(d.refund_reference || d.id || "");
      if (!Number.isFinite(amountMinor) || amountMinor <= 0 || !refundRef) throw new Error("refund event has no valid amount or reference");
      const st = i.event === "refund.processed" ? "processed" : i.event === "refund.failed" ? "failed" : i.event === "refund.pending" ? "pending" : "processing";
      const out = must(await i.rpc("fin3svc_apply_refund_event", {
        p_provider: "paystack", p_reference: i.reference, p_refund_ref: refundRef.slice(0, 120), p_amount_minor: Math.round(amountMinor),
        p_currency: String(d.currency || ""), p_status: st,
      }), "apply refund");
      if (out.outcome === "retry") throw new Error("the original charge is not settled yet; Paystack will retry the refund event");
      if (out.outcome === "needs_review") { await finish("needs_review", String(out.reason || "needs review")); return { status: 200, body: {} }; }
      await finish("processed", String(out.outcome || ""));
      return { status: 200, body: { outcome: out.outcome } };
    }
    await finish("ignored", "event type not handled");
    return { status: 200, body: {} };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    console.error("finance paystack failed", { event: i.event, reference: i.reference, msg });
    await finish("failed", msg);
    return { status: 500, body: { error: "Processing failed; Paystack will retry." } };   // non-200 => Paystack retries
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Checkout initialisation for a prepared intent. The amount, currency and reference come from OUR database row, never from the browser.
// ---------------------------------------------------------------------------------------------------------------------------------
export type InitInput = {
  rpc: Rpc;
  initialize: (body: Record<string, unknown>) => Promise<{ ok: boolean; httpStatus: number; body: any; networkError?: string }>;
  intent: { intent_id: string; reference: string; charge_amount_minor: string; currency: string; customer_email: string; authorization_url: string | null };
  callbackUrl: string;
};
export async function initializeCheckout(i: InitInput): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  if (i.intent.authorization_url) return { ok: true, url: i.intent.authorization_url };
  const amount = Number(i.intent.charge_amount_minor);
  if (!/^[1-9][0-9]{0,15}$/.test(String(i.intent.charge_amount_minor)) || !Number.isSafeInteger(amount)) return { ok: false, message: "The payment amount is not valid." };
  const r = await i.initialize({
    email: i.intent.customer_email, amount, currency: i.intent.currency, reference: i.intent.reference,
    callback_url: i.callbackUrl, channels: ["card", "apple_pay"], metadata: { finance_v3: true },
  });
  const url = r.body?.data?.authorization_url;
  if (!r.ok || r.body?.status !== true || typeof url !== "string" || !url.startsWith("https://")) {
    return { ok: false, message: r.networkError ? "Could not reach the payment provider. Try again in a moment." : "The payment provider could not start this payment." };
  }
  const saved = await i.rpc("fin3svc_intent_initialized", { p_intent: i.intent.intent_id, p_authorization_url: url });
  if (saved.error) return { ok: false, message: "The payment could not be prepared. Try again." };
  return { ok: true, url };
}
