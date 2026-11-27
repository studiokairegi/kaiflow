// Finance V3 Phase 6: background reconciliation of card payments that Paystack never finished telling us about.
//
// For every payment attempt that is still "initialized" or "pending" after 15 minutes (and younger than 3 days) the scheduler asks Paystack
// for the transaction and feeds the answer through the SAME handler the webhook uses (handleFinanceV3PaystackEvent). So the rules are identical:
// the amount, currency and reference are checked against our stored row, a mismatch goes to manual review and never updates a record silently,
// and settling is idempotent (a payment already recorded comes back as "duplicate"). The event key contains the reference and the hour,
// so one stuck attempt produces at most one provider event per hour and a repeated run in the same hour does nothing.
import { handleFinanceV3PaystackEvent, type Rpc, type VerifyFn } from "./finance_v3_paystack.ts";

export type ReconcileDeps = {
  rpc: Rpc;
  verifyFor: (environment: "test" | "live") => VerifyFn | null;   // null when that environment's key is not configured
  now?: () => number;
  limit?: number;
};
export type ReconcileStats = { examined: number; settled: number; duplicate: number; needs_review: number; still_pending: number; skipped: number; failed: number };

export const hourBucket = (ms: number): number => Math.floor(ms / 3_600_000);

export async function reconcileUnsettled(d: ReconcileDeps): Promise<ReconcileStats> {
  const stats: ReconcileStats = { examined: 0, settled: 0, duplicate: 0, needs_review: 0, still_pending: 0, skipped: 0, failed: 0 };
  const now = (d.now ?? Date.now)();
  const listed = await d.rpc("fin3svc_list_unsettled_intents", { p_min_minutes: 15, p_max_days: 3, p_limit: Math.min(Math.max(d.limit ?? 25, 1), 100) });
  if (listed.error) throw new Error(`list unsettled: ${listed.error.message}`);
  const items: any[] = Array.isArray(listed.data) ? listed.data : [];
  for (const it of items) {
    stats.examined++;
    const env = it.environment === "live" ? "live" : it.environment === "test" ? "test" : null;
    const reference = String(it.reference || "");
    const verify = env ? d.verifyFor(env) : null;
    if (!env || !reference || !verify) { stats.skipped++; continue; }
    try {
      // Remember the outcome the handler recorded, so the totals are real rather than guessed.
      let outcome = "";
      const rpc: Rpc = async (name, args) => {
        const r = await d.rpc(name, args);
        if (name === "fin3svc_settle_payment" && r.data?.outcome) outcome = String(r.data.outcome);
        return r;
      };
      const out = await handleFinanceV3PaystackEvent({
        rpc, verify, environment: env, eventKey: `${env}:reconcile:${reference}:${hourBucket(now)}`, event: "charge.success", reference,
        parsed: { event: "charge.success", data: { reference } }, handled: true,
      });
      if (out.status !== 200) stats.failed++;
      else if (outcome === "recorded") stats.settled++;
      else if (outcome === "duplicate") stats.duplicate++;
      else if (outcome === "needs_review") stats.needs_review++;
      else stats.still_pending++;
    } catch (_e) {
      stats.failed++;
    }
  }
  return stats;
}
