// Finance V3 email dispatcher. Pure orchestration with injected dependencies (database RPC, Resend transport), so every decision
// is unit-testable without a network.
//
// Guarantees (docs/finance-v3/FINANCE_V3_RESEND_INTEGRATION_SPEC.md):
//  * content is rendered ONCE and stored; every retry sends exactly the same subject, body and PDF bytes;
//  * the provider idempotency key is stable per message (never regenerated), so a retry after an ambiguous result cannot duplicate;
//  * an ambiguous result (timeout, 5xx, unreadable answer) is recorded as "unknown" and is NEVER answered with a fresh key;
//  * a send failure never touches an invoice, a payment or the ledger: this module has no access to any money function.

import { renderFinanceEmail, TEMPLATE_VERSION, attachmentName } from "./finance_v3_email_templates.ts";
import { renderInvoicePdf, renderReceiptPdf, toBase64, fromBase64 } from "./finance_v3_pdf.ts";

export type Rpc = (name: string, args: Record<string, unknown>) => Promise<any>;
export type SendOutcome =
  | { ok: true; id: string }
  | { ok: false; unknown: boolean; retryable: boolean; status: number; message: string };
export type SendFn = (payload: Record<string, unknown>, idempotencyKey: string) => Promise<SendOutcome>;

export type EmailDeps = {
  rpc: Rpc;
  send: SendFn;
  linkBase: string;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
};

export type Stats = { claimed: number; sent: number; rejected: number; retry: number; unknown: number; errors: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** "Name <addr@x>" or "addr@x" -> parts (the database stores the composed sender). */
export function splitSender(sender: string): { email: string; name: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(sender || "");
  if (m) return { name: m[1].trim(), email: m[2].trim() };
  return { name: "", email: String(sender || "").trim() };
}

async function rpcOrThrow(d: EmailDeps, name: string, args: Record<string, unknown>) {
  const r = await d.rpc(name, args);
  return r;
}

/** Builds (or reuses) the PDF for an attachment plan item and returns its base64 plus the stored metadata. */
export async function attachmentFor(d: EmailDeps, orgId: string, item: { kind: string; entity_id: string }) {
  const docKind = item.kind === "receipt_pdf" ? "receipt_pdf" : "invoice_pdf";
  const existing = await rpcOrThrow(d, "fin3svc_get_document", { p_org: orgId, p_kind: docKind, p_entity: item.entity_id });
  let number = "";
  if (existing?.content_base64) {
    const snapExisting = await rpcOrThrow(d, "fin3svc_get_snapshot", { p_org: orgId, p_kind: docKind === "receipt_pdf" ? "receipt" : "invoice", p_entity: item.entity_id });
    number = String(snapExisting?.receipt_no || snapExisting?.invoice_no || "");
    return { filename: attachmentName(docKind, number), content_type: "application/pdf", content_base64: String(existing.content_base64), sha256: String(existing.sha256), bytes: Number(existing.bytes), document_id: String(existing.id) };
  }
  const snap = await rpcOrThrow(d, "fin3svc_get_snapshot", { p_org: orgId, p_kind: docKind === "receipt_pdf" ? "receipt" : "invoice", p_entity: item.entity_id });
  if (!snap) throw new Error("The document snapshot is not available (invoice not issued, or receipt missing).");
  const pdf = docKind === "receipt_pdf" ? renderReceiptPdf(snap) : renderInvoicePdf(snap);
  number = String(snap.receipt_no || snap.invoice_no || "");
  // First writer wins inside the database; read back what is stored so every attempt uses identical bytes.
  const stored = await rpcOrThrow(d, "fin3svc_store_document", { p_org: orgId, p_kind: docKind, p_entity: item.entity_id, p_content_base64: toBase64(pdf.bytes) });
  const back = await rpcOrThrow(d, "fin3svc_get_document", { p_org: orgId, p_kind: docKind, p_entity: item.entity_id });
  if (!back?.content_base64) throw new Error("The stored document could not be read back.");
  return { filename: attachmentName(docKind, number), content_type: "application/pdf", content_base64: String(back.content_base64), sha256: String(stored.sha256), bytes: Number(stored.bytes), document_id: String(stored.id) };
}

/** Ensures the message has its rendered snapshot; returns what must be sent. */
export async function ensureRendered(d: EmailDeps, msg: any) {
  const plan: { kind: string; entity_id: string }[] = Array.isArray(msg.payload?.attachments_plan) ? msg.payload.attachments_plan : [];
  const attachments: any[] = [];
  for (const item of plan) attachments.push(await attachmentFor(d, msg.organization_id, item));
  if (msg.rendered_at && msg.subject) {
    // Already rendered on an earlier attempt: reuse it verbatim.
    return { subject: String(msg.subject), html: String(msg.body_html || ""), text: String(msg.body_text || ""), attachments };
  }
  const r = renderFinanceEmail({ type: msg.email_type, payload: msg.payload || {}, linkBase: d.linkBase });
  const saved = await rpcOrThrow(d, "fin3svc_save_rendered", {
    p_message: msg.id, p_subject: r.subject, p_html: r.html, p_text: r.text,
    p_attachments: attachments.map((a) => ({ filename: a.filename, content_type: a.content_type, sha256: a.sha256, bytes: a.bytes, document_id: a.document_id })),
  });
  // If another worker rendered first, its content wins.
  return { subject: String(saved?.subject ?? r.subject), html: String(saved?.body_html ?? r.html), text: String(saved?.body_text ?? r.text), attachments };
}

export function buildPayload(msg: any, content: { subject: string; html: string; text: string; attachments: any[] }): Record<string, unknown> {
  const from = splitSender(msg.sender);
  const payload: Record<string, unknown> = {
    from: from.name ? `${from.name.replace(/["<>\r\n]/g, "")} <${from.email}>` : from.email,
    to: [msg.recipient],
    subject: content.subject,
    html: content.html,
    text: content.text,
    // Resend echoes custom tags in signed webhook events; the Finance sink uses this to correlate even if our post-send write failed.
    tags: [{ name: "kf_finance_message_id", value: String(msg.id).toLowerCase() }],
  };
  if (msg.reply_to) payload.reply_to = msg.reply_to;
  if (content.attachments.length) {
    payload.attachments = content.attachments.map((a) => ({ filename: a.filename, content: a.content_base64, content_type: a.content_type }));
  }
  return payload;
}

/** Processes one already-claimed message. Never throws for a provider outcome; unexpected exceptions are recorded as "unknown"/retry. */
export async function processClaimed(d: EmailDeps, claim: { id: string; attempt_no: number }, stats: Stats): Promise<void> {
  const log = d.log ?? (() => {});
  try {
    const msg = await rpcOrThrow(d, "fin3svc_get_email", { p_message: claim.id });
    if (!msg) { stats.errors++; return; }
    if (msg.status !== "sending") return;                                   // someone else finished it
    let content;
    try {
      content = await ensureRendered(d, msg);
    } catch (e) {
      // Rendering or PDF problems are local and certain: nothing was sent. Retry later with the same state.
      await d.rpc("fin3svc_finish_attempt", { p_message: claim.id, p_attempt: claim.attempt_no, p_outcome: "retryable", p_http_status: null, p_provider_message_id: null, p_error: `render failed: ${e instanceof Error ? e.message : "error"}`.slice(0, 380) });
      stats.retry++;
      return;
    }
    const outcome = await d.send(buildPayload(msg, content), `fin3-${msg.id}`);
    if (outcome.ok) {
      await d.rpc("fin3svc_finish_attempt", { p_message: claim.id, p_attempt: claim.attempt_no, p_outcome: "accepted", p_http_status: 200, p_provider_message_id: outcome.id, p_error: null });
      stats.sent++;
      return;
    }
    const kind = outcome.unknown ? "unknown" : outcome.retryable ? "retryable" : "rejected";
    await d.rpc("fin3svc_finish_attempt", { p_message: claim.id, p_attempt: claim.attempt_no, p_outcome: kind, p_http_status: outcome.status || null, p_provider_message_id: null, p_error: outcome.message });
    if (kind === "unknown") stats.unknown++; else if (kind === "retryable") stats.retry++; else stats.rejected++;
  } catch (e) {
    // The send may or may not have happened: treat as ambiguous. The stable idempotency key makes the retry safe.
    stats.errors++;
    log("finance-email: unexpected error", { id: claim.id, msg: e instanceof Error ? e.message : "error" });
    try {
      await d.rpc("fin3svc_finish_attempt", { p_message: claim.id, p_attempt: claim.attempt_no, p_outcome: "unknown", p_http_status: null, p_provider_message_id: null, p_error: "unexpected dispatcher error" });
    } catch { /* the lease expiry path will recover it */ }
  }
}

/** One dispatcher pass: reconcile events that arrived early, expire hopeless ambiguity, claim and send due messages. */
export async function dispatchDue(d: EmailDeps, opts: { limit?: number; leaseSeconds?: number; unknownWindowHours?: number } = {}): Promise<Stats> {
  const stats: Stats = { claimed: 0, sent: 0, rejected: 0, retry: 0, unknown: 0, errors: 0 };
  // 1. Delivery events that arrived before their message could be matched.
  try {
    const ids: number[] = (await d.rpc("fin3svc_list_unapplied_email_events", { p_limit: 50 })) || [];
    for (const id of ids) {
      try { await d.rpc("fin3svc_apply_email_event", { p_event: id }); }
      catch (e) { await d.rpc("fin3svc_mark_email_event_error", { p_event: id, p_error: e instanceof Error ? e.message : "error" }); }
    }
  } catch (e) { (d.log ?? (() => {}))("finance-email: event reconcile failed", { msg: e instanceof Error ? e.message : "error" }); }
  // 2. Ambiguous sends that stayed unproven past the provider's retry window become failed (manual resend only).
  try { await d.rpc("fin3svc_expire_unknown_emails", { p_hours: opts.unknownWindowHours ?? 24 }); } catch { /* next pass */ }
  // 3. Claim and send.
  const claimed: { id: string; attempt_no: number }[] = (await d.rpc("fin3svc_claim_emails", { p_limit: opts.limit ?? 10, p_lease_seconds: opts.leaseSeconds ?? 120 })) || [];
  stats.claimed = claimed.length;
  for (const c of claimed) {
    if (!UUID.test(c.id)) { stats.errors++; continue; }
    await processClaimed(d, c, stats);
  }
  return stats;
}

export { fromBase64 };
