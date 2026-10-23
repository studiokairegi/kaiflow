// POST /paystack-webhook          TEST and LIVE
//
// Deploy with --no-verify-jwt (Paystack sends no Supabase auth header; authenticity is proven by
// the x-paystack-signature HMAC-SHA512 over the raw body, keyed with the account's secret key).
// The environment of an event is whichever configured key (PAYSTACK_TEST_SECRET_KEY /
// PAYSTACK_LIVE_SECRET_KEY) reproduces the signature, so a live event is only ever verified with
// the live key and a test event with the test key. A request signed with neither is rejected.
//
// An event is never trusted for money: charge.success only triggers a server-side VERIFY call to
// Paystack's API, and the amount, currency and reference are checked against OUR stored row before
// anything touches an invoice. Duplicates and retries collapse into one record (unique event_key)
// and every database step is idempotent. Out-of-order refund events are answered with HTTP 500 so
// Paystack retries them after the charge has been applied.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { paystackFetch } from "../_shared/paystack_api.ts";
import { identifyWebhookEnvironment, interpretVerification, isHandledEvent, loadKeyRing, toMinor, webhookEventKey } from "../_shared/paystack_core.ts";

const MAX_BODY = 256 * 1024;
const reply = (status: number, body: Record<string, unknown> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Keep diagnostics, drop personal and card data (customer, authorization, log, ...).
function sanitise(parsed: any) {
  const d = parsed?.data || {};
  return {
    event: parsed?.event,
    data: {
      id: d.id, reference: d.reference, transaction_reference: d.transaction_reference, status: d.status,
      amount: d.amount, currency: d.currency, fees: d.fees, channel: d.channel, paid_at: d.paid_at,
      gateway_response: d.gateway_response, domain: d.domain,
    },
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply(405, { error: "Method not allowed" });
  const ring = loadKeyRing(Deno.env);
  if (!ring.test && !ring.live) return reply(503, { error: "Payments are not enabled." });   // never process while unconfigured

  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY) return reply(413);
  const authn = await identifyWebhookEnvironment(ring, rawBody, req.headers.get("x-paystack-signature"));
  if (!authn) return reply(401, { error: "Invalid signature." });
  const cfg = { secretKey: authn.secretKey, environment: authn.environment };

  let parsed: any;
  try { parsed = JSON.parse(rawBody); } catch { return reply(400, { error: "Invalid JSON." }); }
  const event = String(parsed?.event || "");
  // Prefixed with the environment so a test event id can never collide with (and hide) a live one.
  const key = `${cfg.environment}:${await webhookEventKey(rawBody, parsed)}`;
  const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const reference = String(parsed?.data?.reference || parsed?.data?.transaction_reference || "") || null;

  // Record (or find) the event. A unique event_key makes retries and duplicates collapse.
  let { data: ev } = await service.from("paystack_webhook_events")
    .upsert({ event_key: key, event, reference, environment: cfg.environment, payload: sanitise(parsed) }, { onConflict: "event_key", ignoreDuplicates: true })
    .select("id, status, attempts").maybeSingle();
  if (!ev) {
    const existing = await service.from("paystack_webhook_events").select("id, status, attempts").eq("event_key", key).single();
    ev = existing.data;
    if (ev) await service.from("paystack_webhook_events").update({ attempts: (ev.attempts || 1) + 1 }).eq("id", ev.id);
  }
  if (!ev) return reply(500, { error: "Could not record the event." });
  if (ev.status === "processed" || ev.status === "ignored") return reply(200, { duplicate: true });

  const finish = (status: "processed" | "ignored" | "failed", error = "", extra: Record<string, unknown> = {}) =>
    service.from("paystack_webhook_events")
      .update({ status, error: error.slice(0, 500), processed_at: new Date().toISOString(), ...extra }).eq("id", ev!.id);

  try {
    if (!isHandledEvent(event)) { await finish("ignored", "event type not handled"); return reply(200); }
    if (!reference) { await finish("ignored", "no reference in event"); return reply(200); }

    const { data: tx } = await service.from("paystack_transactions")
      .select("id, user_id, reference, amount, currency, status, invoice_payment_id, environment").eq("reference", reference).maybeSingle();
    if (!tx) { await finish("ignored", "reference does not belong to this app"); return reply(200); }
    // A signed event for the wrong environment must never touch this row.
    if (tx.environment !== cfg.environment) { await finish("ignored", `environment mismatch (${cfg.environment} event, ${tx.environment} transaction)`); return reply(200); }
    await service.from("paystack_webhook_events").update({ transaction_id: tx.id, user_id: tx.user_id }).eq("id", ev.id);

    // Verify with Paystack and apply. Used by charge.success and, if needed, before a refund.
    const verifyAndApply = async () => {
      const r = await paystackFetch(cfg, `/transaction/verify/${encodeURIComponent(reference)}`);
      if (!r.ok) throw new Error(`verify failed (HTTP ${r.httpStatus})`);
      const out = interpretVerification(r.body, { reference, amountMinor: toMinor(tx.amount), currency: tx.currency, environment: cfg.environment });
      if (out.kind === "rejected") throw new Error(`verification rejected: ${out.reason}`);
      const d = r.body.data;
      const { error } = await service.rpc("payments_apply_verification", {
        p_reference: reference, p_environment: cfg.environment, p_outcome: out.kind,
        p_amount_minor: out.kind === "success" ? Number(d.amount) : null,
        p_currency: out.kind === "success" ? String(d.currency) : null,
        p_fee_minor: out.kind === "success" ? out.feeMinor : null,
        p_channel: out.kind === "success" ? out.channel : null,
        p_paystack_id: out.kind === "success" ? out.paystackId : null,
        p_paid_at: out.kind === "success" ? out.paidAt : null,
        p_gateway: out.gateway,
      });
      if (error) throw new Error(error.message);
      return out.kind;
    };

    if (event === "charge.success") {
      await verifyAndApply();
      await finish("processed");
      return reply(200);
    }

    // refund.* : bookkeeping only. Nothing here asks Paystack to refund anything.
    if (event === "refund.processed") {
      if (!tx.invoice_payment_id) await verifyAndApply();     // out-of-order: make sure the charge is applied first
      const d = parsed.data || {};
      const amountMinor = Number(d.amount);
      if (!Number.isFinite(amountMinor) || amountMinor <= 0) throw new Error("refund event has no valid amount");
      const { error } = await service.rpc("payments_apply_refund", {
        p_reference: reference, p_amount_minor: Math.round(amountMinor),
        p_currency: String(d.currency || tx.currency).toUpperCase(), p_event_ref: key,
      });
      if (error) throw new Error(error.message);
      await finish("processed");
      return reply(200);
    }
    await finish("processed", "refund status recorded; no bookkeeping change");
    return reply(200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    console.error("paystack-webhook failed", { event, reference, msg });
    await finish("failed", msg);
    return reply(500, { error: "Processing failed; Paystack will retry." });   // non-200 => Paystack retries
  }
});
