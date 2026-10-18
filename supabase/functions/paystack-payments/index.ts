// POST /paystack-payments   body: { action, ... }     (JWT required: signed-in Kairil users only)
//
//   status       -> sandbox configuration state (no secrets, no Paystack call)
//   init         -> { invoice_id, email, amount? }  start a SANDBOX checkout for an invoice
//   verify       -> { reference }                    verify with Paystack server-side, then apply
//   balance      -> Paystack test-mode balance (only if the API returns one)
//   settlements  -> Paystack settlements list (only if the API returns any)
//
// SANDBOX ONLY. Required server secrets:
//   PAYMENTS_MODE=sandbox            explicit opt-in; anything else disables payments
//   PAYSTACK_SECRET_KEY=sk_test_...  a live key (sk_live_...) is refused and never used
//   APP_URL=https://your-app         optional, used for the post-checkout redirect
//   SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY  (provided by Supabase)
//
// What the browser can NEVER influence: the amount, the currency, the reference, the
// environment, or whether a payment counts as successful. Amount and currency are derived
// by the database from the invoice (payments_prepare_charge); success is decided only by
// Paystack's verify API called here with the secret key.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { paystackFetch, paystackMessage } from "../_shared/paystack_api.ts";
import { fromMinor, interpretVerification, resolveSandboxConfig, toMinor } from "../_shared/paystack_core.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFERENCE = /^[A-Za-z0-9_.=-]{6,100}$/;

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
  const action = String(body?.action || "");

  const cfg = resolveSandboxConfig(Deno.env);

  if (action === "status") {
    return json({
      ok: cfg.ok,
      environment: "test",
      mode: cfg.ok ? "sandbox" : "disabled",
      code: cfg.ok ? null : cfg.code,
      message: cfg.ok ? "Paystack sandbox is configured. Test mode only." : cfg.message,
      webhookPath: "/functions/v1/paystack-webhook",
    });
  }

  if (!cfg.ok) return json({ error: cfg.message, code: cfg.code, environment: "test" }, 503);

  const url = Deno.env.get("SUPABASE_URL")!;
  const authHeader = req.headers.get("Authorization") || "";
  // Acts as the signed-in user: RLS and every RPC's auth.uid() check apply.
  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "Not authenticated." }, 401);
  const service = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    if (action === "init") {
      const invoiceId = String(body.invoice_id || "");
      if (!UUID.test(invoiceId)) return json({ error: "Invalid invoice." }, 400);
      let amount: number | null = null;
      if (body.amount !== undefined && body.amount !== null && body.amount !== "") {
        amount = Number(body.amount);
        if (!Number.isFinite(amount) || amount <= 0) return json({ error: "Enter a valid amount." }, 400);
      }
      const { data, error } = await userClient.rpc("payments_prepare_charge", {
        p_invoice: invoiceId, p_amount: amount, p_email: String(body.email || ""),
      });
      if (error) return json({ error: error.message }, 400);
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) return json({ error: "Could not prepare the checkout." }, 500);
      if (row.reused && row.authorization_url) {
        return json({ environment: "test", reused: true, reference: row.reference, amount: Number(row.amount), currency: row.currency, authorization_url: row.authorization_url });
      }
      const callback = cfg.appUrl ? `${cfg.appUrl}/?payments_return=1` : undefined;
      const r = await paystackFetch(cfg, "/transaction/initialize", {
        method: "POST",
        body: {
          email: String(body.email).trim().toLowerCase(),
          amount: toMinor(row.amount),           // from the database row, never from the request
          currency: row.currency,
          reference: row.reference,
          callback_url: callback,
          metadata: { kairil_environment: "sandbox", invoice_id: invoiceId },
        },
      });
      if (!r.ok || r.body?.status !== true || !r.body?.data?.authorization_url) {
        await service.from("paystack_transactions").update({ status: "failed", gateway_response: paystackMessage(r), updated_at: new Date().toISOString() })
          .eq("id", row.transaction_id).eq("status", "initialized");
        return json({ error: `Paystack could not start the checkout: ${paystackMessage(r)}` }, 502);
      }
      const authUrl = String(r.body.data.authorization_url);
      if (!/^https:\/\/checkout\.paystack\.com\//.test(authUrl)) {
        return json({ error: "Paystack returned an unexpected checkout address." }, 502);
      }
      await service.from("paystack_transactions")
        .update({ authorization_url: authUrl, access_code: r.body.data.access_code || null, updated_at: new Date().toISOString() })
        .eq("id", row.transaction_id);
      return json({ environment: "test", reused: false, reference: row.reference, amount: Number(row.amount), currency: row.currency, authorization_url: authUrl });
    }

    if (action === "verify") {
      const reference = String(body.reference || "");
      if (!REFERENCE.test(reference)) return json({ error: "Invalid payment reference." }, 400);
      // RLS: a user can only see (and therefore verify) their own transactions.
      const { data: tx, error: txErr } = await userClient.from("paystack_transactions")
        .select("id, reference, amount, currency, status, invoice_payment_id, apply_status").eq("reference", reference).maybeSingle();
      if (txErr) return json({ error: txErr.message }, 400);
      if (!tx) return json({ error: "Payment not found." }, 404);
      if (tx.invoice_payment_id) return json({ environment: "test", status: tx.status, applied: true, duplicate: true });

      const r = await paystackFetch(cfg, `/transaction/verify/${encodeURIComponent(reference)}`);
      if (r.httpStatus === 404 || (r.body && r.body.status === false && /not found/i.test(String(r.body.message || "")))) {
        // The customer has not opened the checkout yet: nothing to verify.
        return json({ environment: "test", status: tx.status, applied: false, note: "Paystack has no completed attempt for this payment yet." });
      }
      if (!r.ok) return json({ error: `Could not verify with Paystack: ${paystackMessage(r)}` }, 502);

      const outcome = interpretVerification(r.body, { reference, amountMinor: toMinor(tx.amount), currency: tx.currency });
      if (outcome.kind === "rejected") {
        console.error("paystack-payments verify rejected", { reference, reason: outcome.reason });
        return json({ error: outcome.reason, status: tx.status, applied: false }, 422);
      }
      const d = r.body.data;
      const { data: applied, error: rpcErr } = await service.rpc("payments_apply_verification", {
        p_reference: reference,
        p_outcome: outcome.kind,
        p_amount_minor: outcome.kind === "success" ? Number(d.amount) : null,
        p_currency: outcome.kind === "success" ? String(d.currency) : null,
        p_fee_minor: outcome.kind === "success" ? outcome.feeMinor : null,
        p_channel: outcome.kind === "success" ? outcome.channel : null,
        p_paystack_id: outcome.kind === "success" ? outcome.paystackId : null,
        p_paid_at: outcome.kind === "success" ? outcome.paidAt : null,
        p_gateway: outcome.gateway,
      });
      if (rpcErr) return json({ error: rpcErr.message }, 400);
      return json({ environment: "test", ...applied });
    }

    if (action === "balance") {
      const r = await paystackFetch(cfg, "/balance");
      if (!r.ok || r.body?.status !== true) {
        return json({ environment: "test", available: false, reason: paystackMessage(r), fetchedAt: new Date().toISOString() });
      }
      const list = Array.isArray(r.body.data) ? r.body.data : [];
      return json({
        environment: "test",
        available: list.length > 0,
        reason: list.length ? "" : "Paystack returned no balance for this test account.",
        balances: list.map((b: any) => ({ currency: String(b.currency || ""), balance: fromMinor(b.balance) })),
        fetchedAt: new Date().toISOString(),
      });
    }

    if (action === "settlements") {
      const r = await paystackFetch(cfg, "/settlement?perPage=50");
      if (!r.ok || r.body?.status !== true) {
        return json({ environment: "test", available: false, reason: paystackMessage(r), settlements: [], fetchedAt: new Date().toISOString() });
      }
      const list = Array.isArray(r.body.data) ? r.body.data : [];
      return json({
        environment: "test",
        available: true,
        settlements: list.map((s: any) => ({
          id: String(s.id ?? ""), status: String(s.status || ""), domain: String(s.domain || ""),
          currency: String(s.currency || ""), totalAmount: fromMinor(s.total_amount), totalFees: fromMinor(s.total_fees),
          totalProcessed: fromMinor(s.total_processed), settlementDate: s.settlement_date || s.settled_at || null,
        })),
        fetchedAt: new Date().toISOString(),
      });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    console.error("paystack-payments error", e instanceof Error ? e.message : "unknown");
    return json({ error: "Unexpected error. Try again." }, 500);
  }
});
