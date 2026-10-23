// POST /paystack-payments   body: { action, ... }     (JWT required: signed-in Kairil users only)
//
//   status       -> configuration state for the active environment (no secrets, no Paystack call)
//   connect      -> confirm the server key works, mark Paystack connected + primary for the active environment
//   init         -> legacy development-only shortcut; production checkout is always the hosted live payment link
//   verify       -> { reference }                    verify with Paystack server-side, then apply
//   balance      -> Paystack live available balance
//   settlements  -> Paystack live settlements
//   snapshot     -> live gateway snapshot: transactions, fees, refunds, totals, balances and settlements
//
// Required server secrets (never in frontend code or git):
//   PAYSTACK_MODE=test|live          which environment is ACTIVE; anything else disables payments
//   PAYSTACK_TEST_SECRET_KEY=sk_test_...   and/or
//   PAYSTACK_LIVE_SECRET_KEY=sk_live_...   the key prefix must match its environment
//   APP_URL=https://your-app         required for live (post-checkout return address)
//   SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY  (provided by Supabase)
//
// What the browser can NEVER influence: the amount, the currency, the reference, the
// environment, or whether a payment counts as successful. Amount and currency are derived
// by the database from the invoice; success is decided only by Paystack's verify API called
// with the secret key. Client payments go through the public paystack-checkout function.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { paystackFetch, paystackMessage } from "../_shared/paystack_api.ts";
import { fromMinor, interpretVerification, loadKeyRing, resolvePaystackConfig, toMinor } from "../_shared/paystack_core.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFERENCE = /^[A-Za-z0-9_.=-]{6,100}$/;

async function fetchPaged(cfg: any, path: string, mapRow: (row: any) => any, maxPages = 50) {
  const rows: any[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const r = await paystackFetch(cfg, `${path}${sep}perPage=100&page=${page}`);
    if (!r.ok || r.body?.status !== true) return { ok: false, rows, reason: paystackMessage(r), complete: false };
    const data = Array.isArray(r.body.data) ? r.body.data : [];
    rows.push(...data.map(mapRow));
    const meta = r.body.meta || {};
    if (data.length < 100 && !meta.next) return { ok: true, rows, reason: "", complete: true };
    if (data.length === 0) return { ok: true, rows, reason: "", complete: true };
  }
  return { ok: true, rows, reason: "Paystack pagination limit reached; refresh again to continue synchronizing.", complete: false };
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
  const action = String(body?.action || "");

  // ADMIN ONLY (backend gate; the UI hiding Payments is not the control). Every action, including
  // "status", requires a signed-in administrator.
  const url = Deno.env.get("SUPABASE_URL")!;
  const authHeader = req.headers.get("Authorization") || "";
  // Acts as the signed-in user: RLS and every RPC's auth.uid() check apply.
  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "Not authenticated." }, 401);
  const service = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: adminRow } = await service.from("user_settings").select("is_admin").eq("user_id", userData.user.id).maybeSingle();
  if (!adminRow?.is_admin) return json({ error: "Payments is currently available to administrators only." }, 403);

  const cfg = resolvePaystackConfig(Deno.env);
  const ring = loadKeyRing(Deno.env);

  if (action === "status") {
    const { data: prov } = await service.from("payment_providers").select("status, is_enabled, is_primary, environment, settings, connected_at")
      .eq("user_id", userData.user.id).eq("provider", "paystack").maybeSingle();
    return json({
      ok: cfg.ok,
      environment: cfg.ok ? cfg.environment : null,
      mode: cfg.ok ? cfg.environment : "disabled",
      code: cfg.ok ? null : cfg.code,
      message: cfg.ok ? `Paystack ${cfg.environment} mode is configured.` : cfg.message,
      keys: { test: !!ring.test, live: !!ring.live },
      provider: prov || null,
      webhookPath: "/functions/v1/paystack-webhook",
    });
  }

  if (!cfg.ok) return json({ error: cfg.message, code: cfg.code, environment: null }, 503);
  const env = cfg.environment;
  if (env !== "live" && ["connect", "snapshot", "balance", "settlements"].includes(action)) {
    return json({ error: "Production Payments requires PAYSTACK_MODE=live. Test mode is isolated to development and automated tests.", code: "live_required", environment: env }, 503);
  }

  // Confirms the server-side key works against Paystack's API, then marks Paystack connected,
  // primary and enabled in the ACTIVE environment. Test and live are connected separately.
  if (action === "connect") {
    const r = await paystackFetch(cfg, "/balance");
    if (!r.ok || r.body?.status !== true) {
      return json({ error: `Paystack rejected the ${env} key: ${paystackMessage(r)}`, environment: env }, 502);
    }
    const { error } = await service.rpc("payments_connect_paystack", { p_user: userData.user.id, p_environment: env });
    if (error) return json({ error: error.message }, 400);
    return json({ environment: env, connected: true });
  }


  try {
    if (action === "init") {
      // The admin "Pay now" shortcut predates live mode and tags its rows as test. Live payments go through
      // the invoice's payment link (public checkout), which is environment-aware end to end.
      if (env !== "test") return json({ error: "In live mode, send the client the invoice payment link instead.", environment: env }, 400);
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
        return json({ environment: env, reused: true, reference: row.reference, amount: Number(row.amount), currency: row.currency, authorization_url: row.authorization_url });
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
          metadata: { kairil_environment: "test", invoice_id: invoiceId },
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
      return json({ environment: env, reused: false, reference: row.reference, amount: Number(row.amount), currency: row.currency, authorization_url: authUrl });
    }

    if (action === "verify") {
      const reference = String(body.reference || "");
      if (!REFERENCE.test(reference)) return json({ error: "Invalid payment reference." }, 400);
      // RLS: a user can only see (and therefore verify) their own transactions.
      const { data: tx, error: txErr } = await userClient.from("paystack_transactions")
        .select("id, reference, amount, currency, status, invoice_payment_id, apply_status, environment").eq("reference", reference).maybeSingle();
      if (txErr) return json({ error: txErr.message }, 400);
      if (!tx) return json({ error: "Payment not found." }, 404);
      if (tx.invoice_payment_id) return json({ environment: tx.environment, status: tx.status, applied: true, duplicate: true });
      // Verify in the environment the transaction BELONGS to, with that environment's key.
      const txKey = ring[tx.environment as "test" | "live"];
      if (!txKey) return json({ error: `No ${tx.environment} key is configured on the server, so this payment cannot be verified.` }, 503);
      const vcfg = { secretKey: txKey, environment: tx.environment as "test" | "live" };

      const r = await paystackFetch(vcfg, `/transaction/verify/${encodeURIComponent(reference)}`);
      if (r.httpStatus === 404 || (r.body && r.body.status === false && /not found/i.test(String(r.body.message || "")))) {
        // The customer has not opened the checkout yet: nothing to verify.
        return json({ environment: tx.environment, status: tx.status, applied: false, note: "Paystack has no completed attempt for this payment yet." });
      }
      if (!r.ok) return json({ error: `Could not verify with Paystack: ${paystackMessage(r)}` }, 502);

      const outcome = interpretVerification(r.body, { reference, amountMinor: toMinor(tx.amount), currency: tx.currency, environment: vcfg.environment });
      if (outcome.kind === "rejected") {
        console.error("paystack-payments verify rejected", { reference, reason: outcome.reason });
        return json({ error: outcome.reason, status: tx.status, applied: false }, 422);
      }
      const d = r.body.data;
      const { data: applied, error: rpcErr } = await service.rpc("payments_apply_verification", {
        p_reference: reference,
        p_environment: vcfg.environment,
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
      return json({ environment: tx.environment, ...applied });
    }

    if (action === "snapshot") {
      if (env !== "live") return json({ available: false, environment: env, reason: "Production finance synchronization requires Paystack Live mode." }, 503);
      const fetchedAt = new Date().toISOString();
      const [balanceR, totalsR, txR, refundR, settlementR] = await Promise.all([
        paystackFetch(cfg, "/balance"),
        paystackFetch(cfg, "/transaction/totals?perPage=100"),
        fetchPaged(cfg, "/transaction?status=success", (t: any) => ({
          id: String(t.id ?? ""), reference: String(t.reference || ""), status: String(t.status || ""),
          amount: fromMinor(t.amount), currency: String(t.currency || "").toUpperCase(), fees: t.fees == null ? null : fromMinor(t.fees),
          channel: String(t.channel || ""), paidAt: t.paid_at || t.paidAt || null, createdAt: t.created_at || t.createdAt || null,
          gatewayResponse: String(t.gateway_response || ""), customerEmail: t.customer?.email || null, domain: String(t.domain || ""),
        })),
        fetchPaged(cfg, "/refund", (r: any) => ({
          id: String(r.id ?? ""), transaction: String(r.transaction ?? ""), status: String(r.status || ""),
          amount: fromMinor(r.amount), deductedAmount: r.deducted_amount == null ? null : fromMinor(r.deducted_amount),
          currency: String(r.currency || "").toUpperCase(), refundedAt: r.refunded_at || null, createdAt: r.created_at || r.createdAt || null,
          domain: String(r.domain || ""),
        })),
        fetchPaged(cfg, "/settlement", (s: any) => ({
          id: String(s.id ?? ""), status: String(s.status || ""), domain: String(s.domain || ""),
          currency: String(s.currency || "").toUpperCase(), totalAmount: fromMinor(s.total_amount), totalFees: fromMinor(s.total_fees),
          totalProcessed: fromMinor(s.total_processed), settlementDate: s.settlement_date || s.settled_at || null,
          createdAt: s.createdAt || s.created_at || null, updatedAt: s.updatedAt || s.updated_at || null,
        })),
      ]);
      const balanceOk = balanceR.ok && balanceR.body?.status === true;
      const totalsOk = totalsR.ok && totalsR.body?.status === true;
      return json({
        environment: env, available: balanceOk && totalsOk, fetchedAt,
        balance: { available: balanceOk, reason: balanceOk ? "" : paystackMessage(balanceR), balances: balanceOk ? (Array.isArray(balanceR.body.data) ? balanceR.body.data.map((b: any) => ({ currency: String(b.currency || "").toUpperCase(), balance: fromMinor(b.balance) })) : []) : [] },
        totals: { available: totalsOk, reason: totalsOk ? "" : paystackMessage(totalsR), totalTransactions: totalsOk ? Number(totalsR.body.data?.total_transactions || 0) : null, totalVolume: totalsOk ? fromMinor(totalsR.body.data?.total_volume) : null, totalVolumeByCurrency: totalsOk ? (Array.isArray(totalsR.body.data?.total_volume_by_currency) ? totalsR.body.data.total_volume_by_currency.map((x: any) => ({ currency: String(x.currency || "").toUpperCase(), amount: fromMinor(x.amount) })) : []) : [], pendingTransfersByCurrency: totalsOk ? (Array.isArray(totalsR.body.data?.pending_transfers_by_currency) ? totalsR.body.data.pending_transfers_by_currency.map((x: any) => ({ currency: String(x.currency || "").toUpperCase(), amount: fromMinor(x.amount) })) : []) : [] },
        transactions: txR, refunds: refundR, settlements: settlementR,
      });
    }

    if (action === "balance") {
      const r = await paystackFetch(cfg, "/balance");
      if (!r.ok || r.body?.status !== true) {
        return json({ environment: env, available: false, reason: paystackMessage(r), fetchedAt: new Date().toISOString() });
      }
      const list = Array.isArray(r.body.data) ? r.body.data : [];
      return json({
        environment: env,
        available: list.length > 0,
        reason: list.length ? "" : "Paystack returned no balance for this live account.",
        balances: list.map((b: any) => ({ currency: String(b.currency || ""), balance: fromMinor(b.balance) })),
        fetchedAt: new Date().toISOString(),
      });
    }

    if (action === "settlements") {
      const r = await paystackFetch(cfg, "/settlement?perPage=50");
      if (!r.ok || r.body?.status !== true) {
        return json({ environment: env, available: false, reason: paystackMessage(r), settlements: [], fetchedAt: new Date().toISOString() });
      }
      const list = Array.isArray(r.body.data) ? r.body.data : [];
      return json({
        environment: env,
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
