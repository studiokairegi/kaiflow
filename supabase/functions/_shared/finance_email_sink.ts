// Finance V3: Resend delivery-event sink. OWNED BY FINANCE. The shared resend-webhook endpoint (the ONE Resend webhook; see
// docs/finance-v3/FINANCE_V3_RESEND_INTEGRATION_SPEC.md) calls this through an optional hook, before any Inbox/Intelligence work and
// with its own fault isolation, so a Finance problem never blocks Inbox or Intelligence events and vice versa.
//
// Phase 1 of the sink (record) is the idempotency point and is durable; phase 2 (apply) moves the Finance message status forward by
// rank only. An event that cannot be matched yet stays recorded and is applied by the dispatcher's reconcile pass.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type FinanceDeliveryEvent = {
  provider_event_id: string;       // the Svix id of the delivery
  event_type: string;              // email.sent | email.delivered | ...
  provider_message_id: string;     // Resend email_id
  tags: unknown;                   // event.data.tags (object map or array of {name,value})
  occurred_at: string | null;
  bounce_type: string;
};

export function financeTag(tags: unknown): string | null {
  const v = typeof (tags as any)?.kf_finance_message_id === "string"
    ? (tags as any).kf_finance_message_id
    : Array.isArray(tags) ? String((tags as any[]).find((t) => t?.name === "kf_finance_message_id")?.value || "") : "";
  return UUID.test(v) ? v.toLowerCase() : null;
}

export function makeFinanceEmailSink(service: { rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: any; error: { message: string } | null }> }) {
  return async function applyFinanceDeliveryEvent(a: FinanceDeliveryEvent): Promise<{ found: boolean; applied: boolean; duplicate: boolean }> {
    const tag = financeTag(a.tags);
    // Nothing identifies this as a Finance message: it is an Inbox or Intelligence event. Do no work at all.
    // (A Finance message without our tag can still be matched by provider id, so look the id up; unmatched ids are cheap no-ops.)
    const rec = await service.rpc("fin3svc_record_email_event", {
      p_provider_event_id: a.provider_event_id, p_event_type: a.event_type, p_provider_message_id: a.provider_message_id || null,
      p_message_id: tag, p_occurred_at: a.occurred_at, p_bounce_type: a.bounce_type || null,
    });
    if (rec.error) throw new Error(`Finance email event not recorded: ${rec.error.message}`);
    // An event that matches no Finance message is not ours: it was recorded as unapplied only when it could still become ours
    // (message correlated later). Events for foreign messages are expected and are not an error.
    if (!rec.data?.found && !tag) return { found: false, applied: false, duplicate: !!rec.data?.duplicate };
    if (rec.data?.applied) return { found: true, applied: true, duplicate: true };
    const out = await service.rpc("fin3svc_apply_email_event", { p_event: rec.data.id });
    if (out.error) throw new Error(`Finance email event not applied: ${out.error.message}`);
    return { found: !!out.data?.found, applied: !!out.data?.applied, duplicate: !!rec.data?.duplicate };
  };
}
