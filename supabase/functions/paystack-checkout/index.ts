// POST /paystack-checkout    body: { action, token, ... }      PUBLIC (deploy with --no-verify-jwt)
//
//   start   { token, email, channel: "card" | "bank_transfer" | "apple_pay", quote_id }
//             -> { status: "redirect", authorization_url }   send the client to Paystack-hosted checkout
//             -> { status: "paid" | "pending", ... }          nothing new was started
//   quote   { token, channel }
//             -> { quote: {...} }   a server-made, 15-minute, session-bound price (FX included). The page shows it,
//                                   the client confirms it, and `start` must echo its quote_id. The browser never
//                                   supplies a rate, a converted amount or a currency.
//   wise_start  { token, email? }  -> manual Wise/M-PESA instructions + a pending record (NOTHING is paid or posted)
//   wise_submit { token, reference, transfer_reference, payer_name?, note? } -> evidence only; status "submitted"
//   confirm { token, reference? }
//             -> verifies with Paystack from the server and reports the TRUSTED state.
//                Used by the return page and by the "check my payment" button.
//
// Authorisation is the unguessable checkout token (64 hex chars). Everything else is derived on
// the server:
//   * the invoice, amount and currency come from the database (payments_checkout_prepare),
//   * production checkout requires the PAYSTACK_MODE server secret to be live,
//   * success is decided ONLY by Paystack's verify API called here with the secret key, and the
//     reference, amount, currency and environment are checked against OUR stored row.
// The browser redirect, query strings and anything else the client sends prove nothing.
//
// Double-charge protection lives mostly in the database (row locks + one open attempt per invoice).
// This function adds the rule "an attempt whose outcome is unknown is verified with Paystack
// before another one may start; a timeout is never treated as a failure".

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { paystackFetch, paystackMessage } from "../_shared/paystack_api.ts";
import { channelsFor, interpretVerification, isValidEmail, resolvePaystackConfig, toMinor, type PaystackConfig } from "../_shared/paystack_core.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } });

const TOKEN = /^[0-9a-f]{64}$/;
const REFERENCE = /^[A-Za-z0-9_.=-]{6,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RETIRE_AFTER_MS = 30 * 60 * 1000;       // an unpaid ("abandoned") attempt may only be retired after this long
const INIT_GRACE_MS = 2 * 60 * 1000;          // an attempt Paystack has never heard of may only be retired after this long

type Ok = Extract<PaystackConfig, { ok: true }>;

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const action = String(body?.action || "");
  const token = String(body?.token || "");
  if (!TOKEN.test(token)) return json({ error: "This payment link is not valid." }, 400);

  const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Wise is a manual flow: it needs no Paystack key and can never start a Paystack transaction.
  try {
    if (action === "wise_start") return await wiseStart(service, token, body);
    if (action === "wise_submit") return await wiseSubmit(service, token, body);
  } catch (e) {
    console.error("paystack-checkout wise error", e instanceof Error ? e.message : "unknown");
    return json({ error: "Something went wrong. Please try again in a moment." }, 500);
  }

  const cfg = resolvePaystackConfig(Deno.env);
  if (!cfg.ok || cfg.environment !== "live") {
    console.error("paystack-checkout disabled", { code: cfg.ok ? "live_required" : cfg.code });
    return json({ error: "Online payment is not available right now. Please contact StudioKairegi." }, 503);
  }

  try {
    if (action === "quote") return await quote(service, token, String(body?.channel || ""));
    if (action === "start") return await start(service, cfg, token, body);
    if (action === "confirm") return await confirm(service, cfg, token, String(body?.reference || ""));
    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    console.error("paystack-checkout error", e instanceof Error ? e.message : "unknown");
    return json({ error: "Something went wrong. Please try again in a moment." }, 500);
  }
});

// Verify one attempt with Paystack and record the outcome. Returns what is now true about it.
async function verifyAttempt(service: any, cfg: Ok, tx: { reference: string; amount: number | string; currency: string; created_at: string }) {
  const age = Date.now() - new Date(tx.created_at).getTime();
  const r = await paystackFetch(cfg, `/transaction/verify/${encodeURIComponent(tx.reference)}`);
  if (r.networkError) return { kind: "unknown" as const };                                  // could not ask: say nothing
  if (r.httpStatus === 404 || (r.body && r.body.status === false && /not found/i.test(String(r.body.message || "")))) {
    return { kind: age < INIT_GRACE_MS ? "incomplete" as const : "not_found" as const };    // Paystack has no record of it (yet)
  }
  if (!r.ok) return { kind: "unknown" as const };
  const out = interpretVerification(r.body, { reference: tx.reference, amountMinor: toMinor(tx.amount), currency: tx.currency, environment: cfg.environment });
  if (out.kind === "rejected") {
    console.error("paystack-checkout verify rejected", { reference: tx.reference, reason: out.reason });
    return { kind: "rejected" as const, reason: out.reason };
  }
  // "Abandoned" only means the customer has not paid YET. A young attempt stays open (not recorded as
  // abandoned) so a second tab or retry cannot start another charge while this one can still be completed.
  if (out.kind === "abandoned" && age < RETIRE_AFTER_MS) return { kind: "incomplete" as const };
  const d = r.body.data;
  const { data, error } = await service.rpc("payments_apply_verification", {
    p_reference: tx.reference, p_environment: cfg.environment, p_outcome: out.kind,
    p_amount_minor: out.kind === "success" ? Number(d.amount) : null,
    p_currency: out.kind === "success" ? String(d.currency) : null,
    p_fee_minor: out.kind === "success" ? out.feeMinor : null,
    p_channel: out.kind === "success" ? out.channel : null,
    p_paystack_id: out.kind === "success" ? out.paystackId : null,
    p_paid_at: out.kind === "success" ? out.paidAt : null,
    p_gateway: out.gateway,
  });
  if (error) { console.error("payments_apply_verification failed", { reference: tx.reference, msg: error.message }); return { kind: "unknown" as const }; }
  return { kind: out.kind, applied: !!data?.applied };
}

async function loadTx(service: any, reference: string) {
  const { data } = await service.from("paystack_transactions")
    .select("id, reference, amount, currency, status, created_at, authorization_url, apply_status").eq("reference", reference).maybeSingle();
  return data;
}

async function start(service: any, cfg: Ok, token: string, body: any) {
  const email = String(body?.email || "").trim();
  const channel = String(body?.channel || "");
  const quoteId = body?.quote_id == null || body.quote_id === "" ? null : String(body.quote_id);
  if (quoteId !== null && !UUID.test(quoteId)) return json({ error: "Please review the amount and confirm again.", code: "quote_invalid" }, 409);
  const channels = channelsFor(channel);
  if (!channels) return json({ error: "Choose a payment method." }, 400);        // PayPal / Payoneer land here
  if (!isValidEmail(email)) return json({ error: "Enter a valid email address for your payment receipt." }, 400);

  // At most two passes: the second only happens after an old unknown attempt was resolved with Paystack.
  for (let pass = 0; pass < 2; pass++) {
    const { data, error } = await service.rpc("payments_checkout_prepare", {
      p_token: token, p_email: email, p_environment: cfg.environment, p_channel: channel, p_quote: quoteId,
    });
    if (error) {
      // These messages are written for the client by the database (link expired, already paid, ...).
      // A quote problem means: show the (new) price and ask the client to confirm again. Nothing was started.
      const code = /^quote_/.test(String(error.details || "")) ? String(error.details) : "not_payable";
      return json({ error: error.message, code }, 409);
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return json({ error: "Could not start the payment." }, 500);

    if (row.action === "reuse" && row.authorization_url) {
      return json({ status: "redirect", authorization_url: row.authorization_url, reference: row.reference, reused: true });
    }

    if (row.action === "verify_first") {
      const tx = await loadTx(service, row.reference);
      if (!tx) return json({ error: "Could not check the earlier payment. Please try again." }, 500);
      const v = await verifyAttempt(service, cfg, tx);
      if (v.kind === "success") return json({ status: "paid", reference: row.reference, applied: (v as any).applied });
      if (v.kind === "unknown" || v.kind === "rejected" || v.kind === "pending" || v.kind === "reversed") {
        return json({ status: "pending", reference: row.reference, message: "A payment for this invoice is already in progress. We are checking its status; please do not pay again yet." }, 202);
      }
      if (v.kind === "incomplete") {
        return json({ status: "pending", reference: row.reference, message: "A payment for this invoice was started recently and has not been completed. Finish it, or try again in a few minutes." }, 202);
      }
      if (v.kind === "not_found") {
        // Paystack never heard of it and enough time passed that no request can still be initialising it.
        await service.rpc("payments_apply_verification", {
          p_reference: tx.reference, p_environment: cfg.environment, p_outcome: "abandoned", p_amount_minor: null, p_currency: null,
          p_fee_minor: null, p_channel: null, p_paystack_id: null, p_paid_at: null, p_gateway: "Not found at Paystack",
        });
      }
      // failed (definitive) or abandoned (old enough, already recorded): the next pass starts a fresh attempt.
      continue;
    }

    if (row.action !== "new") return json({ error: "Could not start the payment." }, 500);

    // Initialise the attempt the database just created. Amount and currency are the database's.
    const callback = `${cfg.appUrl}/pay/${token}/return`;
    const r = await paystackFetch(cfg, "/transaction/initialize", {
      method: "POST",
      body: {
        email: email.toLowerCase(),
        amount: toMinor(row.amount),
        currency: row.currency,
        reference: row.reference,
        callback_url: callback,
        channels,
        metadata: { kairil_environment: cfg.environment, invoice_number: row.invoice_number, channel,
                    invoice_amount: row.invoice_amount, invoice_currency: row.invoice_currency, quote_id: row.quote_id },
      },
    });
    if (r.networkError) {
      // Unknown outcome (Paystack may have created it). Leave the attempt open: the next request
      // verifies it before anything else can start. Never mark it failed on a timeout.
      return json({ status: "pending", reference: row.reference, message: "We couldn’t reach the payment provider. Please wait a minute and try again." }, 202);
    }
    if (!r.ok || r.body?.status !== true || !r.body?.data?.authorization_url) {
      // Paystack answered and said no: a definite failure, safe to close the attempt.
      await service.from("paystack_transactions").update({ status: "failed", gateway_response: paystackMessage(r), updated_at: new Date().toISOString() })
        .eq("id", row.transaction_id).eq("status", "initialized");
      console.error("paystack-checkout init rejected", { reference: row.reference, http: r.httpStatus, gateway: paystackMessage(r) });
      return json({ error: "The payment provider could not start this payment. Please try again, or contact StudioKairegi." }, 502);
    }
    const authUrl = String(r.body.data.authorization_url);
    if (!/^https:\/\/checkout\.paystack\.com\//.test(authUrl)) {
      return json({ error: "The payment provider returned an unexpected address. Nothing was charged." }, 502);
    }
    await service.from("paystack_transactions")
      .update({ authorization_url: authUrl, access_code: r.body.data.access_code || null, updated_at: new Date().toISOString() })
      .eq("id", row.transaction_id);
    return json({ status: "redirect", authorization_url: authUrl, reference: row.reference, reused: false });
  }
  return json({ status: "pending", message: "A payment for this invoice is already in progress. Please try again in a few minutes." }, 202);
}

async function confirm(service: any, cfg: Ok, token: string, reference: string) {
  if (reference && !REFERENCE.test(reference)) return json({ error: "Invalid payment reference." }, 400);
  const status = async () => (await service.rpc("payments_checkout_status", { p_token: token, p_reference: reference || null })).data;

  let s = await status();
  if (!s?.found) return json({ status: "notfound" }, 404);
  const trusted = (st: any) => {
    if (st.invoice_paid && st.applied) return "paid";
    if (st.transaction_status === "success" && st.applied) return "paid";
    if (["failed", "abandoned"].includes(st.transaction_status)) return "failed";
    if (st.invoice_paid) return "paid_elsewhere";
    return "pending";
  };
  let state = trusted(s);

  // Ask Paystack about an attempt that is not yet settled. The redirect itself proves nothing.
  if (state === "pending" && s.reference && s.environment === cfg.environment) {
    const tx = await loadTx(service, s.reference);
    if (tx) {
      const v = await verifyAttempt(service, cfg, tx);
      if (v.kind === "rejected") return json({ status: "review", message: "We could not confirm this payment automatically. StudioKairegi has been alerted; please do not pay again." }, 200);
      s = await status();
      state = trusted(s);
      // The customer came back without paying (cancelled or closed the window): say so, and let them resume.
      if (state === "pending" && v.kind === "incomplete") state = "incomplete";
    }
  }
  return json({
    status: state,
    invoice_number: s.invoice_number, amount: s.amount, currency: s.currency, reference: s.reference || null,
  });
}

// ---- quotes -------------------------------------------------------------------------------------
// The database derives the invoice, balance, currency, FX rate (from the stored snapshots), rounding and
// final charge. A snapshot older than 36 hours is "no reliable rate": we say so instead of guessing.
async function quote(service: any, token: string, channel: string) {
  if (!channelsFor(channel)) return json({ error: "Choose a payment method." }, 400);

  // Refresh the owner's checkout FX snapshot from the provider before asking SQL to quote.
  // A provider outage must not destroy a still-fresh snapshot; SQL will use a snapshot no older
  // than 36 hours and otherwise fail closed with fx_unavailable.
  await refreshCheckoutFx(service, token);
  const { data, error } = await service.rpc("payments_quote_create", { p_token: token, p_channel: channel });
  if (error) {
    if (error.details === "fx_unavailable") return json({ error: error.message, code: "fx_unavailable" }, 503);
    return json({ error: error.message, code: "not_payable" }, 409);
  }
  return json({ quote: data });
}


const FX_PROVIDER_URL = "https://open.er-api.com/v6/latest/USD";
const FX_MAX_AGE_MS = 36 * 60 * 60 * 1000;
const FX_SUPPORTED = ["EUR", "GBP", "JPY", "KES"] as const;

async function refreshCheckoutFx(service: any, token: string) {
  let response: Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      response = await fetch(FX_PROVIDER_URL, { method: "GET", signal: controller.signal, headers: { Accept: "application/json" } });
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return; // Quote RPC may still use a snapshot that is within the strict freshness window.
  }
  if (!response.ok) return;

  let payload: any;
  try { payload = await response.json(); } catch { return; }
  const updatedUnix = Number(payload?.time_last_update_unix);
  const updatedAtMs = updatedUnix * 1000;
  const now = Date.now();
  if (payload?.result !== "success" || !Number.isFinite(updatedAtMs) || updatedAtMs <= 0 ||
      updatedAtMs > now + 5 * 60 * 1000 || now - updatedAtMs > FX_MAX_AGE_MS || !payload?.rates || typeof payload.rates !== "object") return;

  const rates: Record<string, number> = {};
  for (const currency of FX_SUPPORTED) {
    const value = Number(payload.rates[currency]);
    if (Number.isFinite(value) && value > 0) rates[currency] = value;
  }
  // We need KES for Paystack and the original invoice currency to derive a cross rate.
  if (!rates.KES || Object.keys(rates).length === 0) return;

  const fetchedAt = new Date(updatedAtMs).toISOString();
  const rateDate = fetchedAt.slice(0, 10);
  try {
    const { error } = await service.rpc("payments_checkout_fx_snapshot_save", {
      p_token: token,
      p_rates: rates,
      p_rate_date: rateDate,
      p_fetched_at: fetchedAt,
    });
    if (error) console.error("checkout FX snapshot save failed", error.message);
  } catch (e) {
    console.error("checkout FX snapshot save failed", e instanceof Error ? e.message : "unknown");
  }
}

// ---- Wise / M-PESA (manual) ----------------------------------------------------------------------
async function wiseStart(service: any, token: string, body: any) {
  const email = String(body?.email || "").trim();
  const { data, error } = await service.rpc("payments_manual_start", { p_token: token, p_email: email });
  if (error) return json({ error: error.message, code: "not_payable" }, 409);
  return json({ status: "wise_instructions", transfer: data });
}

async function wiseSubmit(service: any, token: string, body: any) {
  const reference = String(body?.reference || "");
  if (!REFERENCE.test(reference)) return json({ error: "Invalid reference." }, 400);
  const { data, error } = await service.rpc("payments_manual_submit", {
    p_token: token, p_reference: reference, p_transfer_ref: String(body?.transfer_reference || ""),
    p_payer_name: String(body?.payer_name || ""), p_note: String(body?.note || ""),
  });
  if (error) return json({ error: error.message, code: "not_submittable" }, 409);
  // Evidence only: the invoice is not touched until an administrator verifies that the money arrived.
  return json({ status: data?.status || "submitted", reference });
}
