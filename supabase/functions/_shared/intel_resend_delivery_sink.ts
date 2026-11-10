// KairFlow Intelligence: Resend delivery-event sink. OWNED BY INTELLIGENCE, not by general Email.
// The general Email webhook (email_resend_logic.ts) knows nothing about intel_* objects: it accepts an optional
// `applyIntelDeliveryEvent` function and resend-webhook/index.ts plugs this one in. General Email therefore has no import,
// table or RPC dependency on Intelligence, and the two systems apply the same signed event independently (both are idempotent).
import type { WebhookStore } from "./email_resend_logic.ts";

const must = <T>(r: { data: T; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};
const failOn = (e: { message: string } | null, what: string) => { if (e) throw new Error(`${what}: ${e.message}`); };

export function makeIntelDeliverySink(service: any): NonNullable<WebhookStore["applyIntelDeliveryEvent"]> {
  return async function applyIntelDeliveryEvent(a) {
    // Find exact Intelligence outbound messages by provider identity. Never guess
    // an account when a provider message id is duplicated across accounts.
    const query = await service.from("intel_messages")
      .select("id,organization_id,provider_account_id,provider_key,provider_message_id,to_email")
      .eq("direction", "outbound").eq("provider_key", "resend")
      .eq("provider_message_id", a.provider_message_id);
    failOn(query.error, "Intelligence provider message lookup");
    const rows = (query.data || []).filter((r: any) => {
      const addr = String(r.to_email || "").trim().toLowerCase();
      return !a.recipient || addr === a.recipient;
    });
    const accounts = rows.filter((r: any) => r.provider_account_id && r.organization_id);
    const distinct = accounts.filter((r: any, i: number) => accounts.findIndex((x: any) => x.organization_id === r.organization_id && x.provider_account_id === r.provider_account_id) === i);
    if (distinct.length > 1) return { found: false, ambiguous: true };
    if (!distinct.length) return { found: false };
    const row = distinct[0];
    const statusMap: Record<string, string> = {
      "email.sent": "accepted", "email.delivered": "delivered", "email.delivery_delayed": "delayed",
      "email.bounced": "bounced", "email.complained": "complained", "email.failed": "failed",
      "email.suppressed": "failed", "email.rejected": "failed",
    };
    const status = a.event_type === "email.bounced" && /temporary|transient|soft/i.test(a.bounce_type || "")
      ? "delayed" : statusMap[a.event_type];
    if (!status) return { found: false };
    const out = must(await service.rpc("intel_agent_apply_delivery_event", {
      p_provider_key: "resend", p_provider_account_id: row.provider_account_id,
      p_provider_message_id: a.provider_message_id, p_provider_event_id: a.provider_event_id,
      p_event_type: a.event_type, p_status: status, p_occurred_at: a.occurred_at,
      p_recipient: String(row.to_email || "").trim().toLowerCase(), p_reason: a.reason,
    }), "apply Intelligence delivery event") as any;
    if (out?.ok !== true || out?.found !== true || (out?.duplicate !== true && typeof out?.applied !== "boolean")) {
      throw new Error(`Intelligence delivery event not durably accepted: ${String(out?.reason || "invalid RPC response")}`);
    }
    return { found: true, duplicate: out.duplicate === true, applied: out.applied === true };
  };
}
