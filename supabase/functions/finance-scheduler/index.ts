// finance-scheduler: Finance V3 background work that needs the network.
//   1. runs the database sweep (alerts, scheduled reminders, receipts backlog, email-outcome expiry) via fin3svc_run_scheduled;
//   2. asks Paystack about card payments that never completed (reconcileUnsettled), settling or flagging them with the webhook's own rules.
// Called every few minutes by finance_v3.kick_scheduler() (pg_cron + pg_net) with header x-cron-secret = FINANCE_SCHEDULER_SECRET
// (or FINANCE_EMAIL_CRON_SECRET when you use one secret for both). Deploy with --no-verify-jwt. It cannot be called by a signed-in user.
// It has no path to issue, send, pay or edit anything: the only writes are the ones fin3svc_run_scheduled and the Paystack handler make,
// each idempotent.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { paystackFetch } from "../_shared/paystack_api.ts";
import { constantTimeEqual, loadKeyRing } from "../_shared/paystack_core.ts";
import { reconcileUnsettled } from "../_shared/finance_v3_scheduler.ts";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  const secret = Deno.env.get("FINANCE_SCHEDULER_SECRET") || Deno.env.get("FINANCE_EMAIL_CRON_SECRET") || "";
  const provided = req.headers.get("x-cron-secret") || "";
  if (!secret || !provided || !constantTimeEqual(secret, provided)) return json(401, { error: "Not authorized." });

  const out: Record<string, unknown> = {};
  try {
    const r = await service.rpc("fin3svc_run_scheduled", { p_org: null });
    out.sweep = r.error ? { error: r.error.message } : { organizations: r.data?.organizations, expired_unknown_emails: r.data?.expired_unknown_emails };
  } catch (e) { out.sweep = { error: e instanceof Error ? e.message : "failed" }; }

  const ring = loadKeyRing(Deno.env);
  try {
    out.paystack = await reconcileUnsettled({
      rpc: async (name, args) => await service.rpc(name, args),
      verifyFor: (env) => { const key = ring[env]; return key ? (ref: string) => paystackFetch({ secretKey: key, environment: env }, `/transaction/verify/${encodeURIComponent(ref)}`) : null; },
    });
  } catch (e) { out.paystack = { error: e instanceof Error ? e.message : "failed" }; }
  return json(200, out);
});
