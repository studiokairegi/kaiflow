// Resend adapter for general Email (multi-provider phase 3). Every function below was MOVED VERBATIM from email_resend_logic.ts so the
// existing, tested safeguards are unchanged: API key isolation (the key is passed in, never stored), Idempotency-Key on every send,
// bounded retries on 429/5xx only, unknown-outcome handling (never auto-resent), Svix signature + 5-minute replay tolerance,
// tolerant reading of Resend's received-email payload. NOT exercised against a live Resend account.
// Only the two things phase 3 adds are new here: the `resendAdapter` object and the `PayloadRequest` structural type.
// This file is the ONLY place that knows api.resend.com. Erasable TypeScript only.
import { isValidEmail, parseAddress, parseMessageIds, htmlToText, safeFileName } from "./email_common.ts";
import type { EmailAdapter, AdapterAccount, AdapterContext, AdapterSendInput, AdapterSendOutcome, AdapterOperation } from "./email_adapter.ts";

export const RESEND_API = "https://api.resend.com";

// ---------------------------------------------------------------------------------------------------------------
// Resend events -> message status
// ---------------------------------------------------------------------------------------------------------------
const EVENT_STATUS: Record<string, string> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.delivery_delayed": "delivery_delayed",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.failed": "failed",
  "email.suppressed": "rejected",
  "email.rejected": "rejected",
};
export const statusForEvent = (type: string, bounceType?: unknown): string | null => {
  // Resend reports temporary/transient/soft bounce classes inside the event payload.
  // They are delivery delays, not permanent contactability failures.
  if (type === "email.bounced" && /temporary|transient|soft/i.test(String(bounceType || ""))) return "delivery_delayed";
  return EVENT_STATUS[type] || null;
};

// ---------------------------------------------------------------------------------------------------------------
// Webhook signature (Svix scheme, which Resend uses): HMAC-SHA256 over "<id>.<timestamp>.<body>", base64.
// ---------------------------------------------------------------------------------------------------------------
const b64ToBytes = (b64: string) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const bytesToB64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function verifySvixSignature(o: { secret: string; id: string; timestamp: string; signature: string; body: string; nowMs: number; toleranceSec?: number }): Promise<boolean> {
  try {
    if (!o.secret || !o.id || !o.timestamp || !o.signature) return false;
    if (!/^\d{1,12}$/.test(o.timestamp)) return false;                 // plain integer seconds only
    const ts = Number(o.timestamp);
    if (!Number.isFinite(ts) || Math.abs(o.nowMs / 1000 - ts) > (o.toleranceSec ?? 300)) return false;
    const key = await crypto.subtle.importKey("raw", b64ToBytes(o.secret.replace(/^whsec_/, "")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${o.id}.${o.timestamp}.${o.body}`)));
    const expected = bytesToB64(mac);
    return o.signature.split(" ").some((part) => {
      const [version, sig] = part.split(",");
      return version === "v1" && !!sig && constantTimeEqual(sig, expected);
    });
  } catch {
    return false;                                       // fail closed
  }
}

/** The fields buildResendPayload reads. The shared SendRequest satisfies this, so the function body is unchanged. */
export interface PayloadRequest { to: string[]; cc: string[]; bcc: string[]; subject: string; text: string; html: string; attachments: { filename: string; content_base64: string; content_type?: string }[] }
const displayName = (n: string) => n.replace(/["<>\r\n\\]/g, "").trim();
export function buildResendPayload(o: { fromEmail: string; fromName: string; req: PayloadRequest; thread: { in_reply_to: string; references: string } | null; replyTo: string; correlationId?: string }): Record<string, unknown> {
  const { req } = o;
  const p: Record<string, unknown> = {
    from: o.fromName ? `${displayName(o.fromName)} <${o.fromEmail}>` : o.fromEmail,
    to: req.to,
    subject: req.subject,
    text: req.text.trim() ? req.text : htmlToText(req.html),
  };
  if (req.html.trim()) p.html = req.html;
  if (req.cc.length) p.cc = req.cc;
  if (req.bcc.length) p.bcc = req.bcc;
  if (o.replyTo) p.reply_to = o.replyTo;
  if (o.thread) p.headers = { "In-Reply-To": o.thread.in_reply_to, References: o.thread.references };
  // Resend echoes custom tags in signed email.* webhook events. This server-generated id
  // lets KairFlow recover a provider acceptance even if its post-send DB write failed.
  if (o.correlationId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(o.correlationId)) {
    p.tags = [{ name: "kf_message_id", value: o.correlationId.toLowerCase() }];
  }
  if (req.attachments.length) p.attachments = req.attachments.map((a) => ({ filename: a.filename, content: a.content_base64, content_type: a.content_type }));
  return p;
}

export type SendOutcome =
  | { ok: true; id: string; attempts: number }
  | { ok: false; unknown: boolean; retryable: boolean; status: number; message: string; attempts: number };

/** Retries only what is safe: the Idempotency-Key makes Resend return the original result instead of sending twice. */
export async function sendViaResend(fetchFn: typeof fetch, apiKey: string, payload: Record<string, unknown>, idempotencyKey: string,
                                    opts: { maxAttempts?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<SendOutcome> {
  const max = opts.maxAttempts ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let attempts = 0;
  // Once any attempt has an ambiguous transport/5xx result, a later 429 cannot prove that earlier attempt was not accepted.
  let mayHaveAccepted = false;
  let last: SendOutcome = { ok: false, unknown: true, retryable: true, status: 0, message: "No response from the email provider", attempts: 0 };
  while (attempts < max) {
    attempts++;
    let res: Response;
    try {
      res = await fetchFn(`${RESEND_API}/emails`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": `kf-${idempotencyKey}`.slice(0, 256) },
        body: JSON.stringify(payload),
      });
    } catch {
      mayHaveAccepted = true;
      last = { ok: false, unknown: true, retryable: true, status: 0, message: "Network error reaching the email provider", attempts };
      if (attempts < max) await sleep(400 * 2 ** (attempts - 1));
      continue;
    }
    if (res.ok) {
      const body = await res.json().catch(() => null) as any;
      return body?.id ? { ok: true, id: String(body.id), attempts } : { ok: false, unknown: true, retryable: false, status: res.status, message: "The email provider gave an unreadable answer", attempts };
    }
    const err = await res.json().catch(() => null) as any;
    const message = String(err?.message || `Email provider error (${res.status})`).slice(0, 300);
    const providerErrorCode = String(err?.name ?? err?.code ?? "").toLowerCase();
    if (res.status === 409 && providerErrorCode === "concurrent_idempotent_requests") {
      // Resend explicitly says this same-key request is still in progress and may safely be retried later.
      mayHaveAccepted = true;
      last = { ok: false, unknown: true, retryable: true, status: res.status, message, attempts };
      if (attempts < max) await sleep(400 * 2 ** (attempts - 1));
      continue;
    }
    if (res.status === 409 && providerErrorCode !== "invalid_idempotent_request") {
      // Unknown 409 variants fail closed: they may be an in-flight idempotent request.
      return { ok: false, unknown: true, retryable: true, status: res.status, message, attempts };
    }
    if (res.status === 429 || res.status >= 500) {
      // 429 is an explicit non-acceptance. A 5xx may be returned after the provider committed the send,
      // so after bounded same-key retries it must remain unknown and must never invite a fresh-key resend.
      if (res.status >= 500) mayHaveAccepted = true;
      last = { ok: false, unknown: mayHaveAccepted, retryable: true, status: res.status, message, attempts };
      const wait = Math.min(Number(res.headers?.get?.("retry-after")) * 1000 || 500 * 2 ** (attempts - 1), 5000);
      if (attempts < max) await sleep(wait);
      continue;
    }
    return { ok: false, unknown: false, retryable: false, status: res.status, message, attempts };   // 4xx: rejected, do not retry
  }
  return last;
}

export async function resendGet(d: { fetch: typeof fetch; sleep?: (ms: number) => Promise<void> }, apiKey: string, path: string): Promise<any> {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastStatus = 0;
  for (let i = 0; i < 3; i++) {
    const res = await d.fetch(`${RESEND_API}${path}`, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (res.ok) return await res.json();
    lastStatus = res.status;
    if (res.status !== 429 && res.status < 500) break;       // 4xx (including "not available yet") ends here; the webhook retry handles it, bounded by the claim attempt limit
    await sleep(400 * 2 ** i);
  }
  throw new Error(`Resend ${path.split("/").slice(0, 3).join("/")} failed (${lastStatus})`);   // path without ids: safe to log
}


// ---------------------------------------------------------------------------------------------------------------
// Tolerant reading of Resend's "received email" response. Field names follow Resend's public docs but were never checked against a real
// account, so common variants are accepted (headers as an object or a list, recipients as strings or objects, snake/camel case names).
// If the essentials are missing the event FAILS with the field names we did see (names only, never values) so the problem is visible in
// email_webhook_events.error instead of silently storing a blank message.
// ---------------------------------------------------------------------------------------------------------------
const asText = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : Array.isArray(v) ? v.map(asText).join(" ") : String(v));
const addrText = (x: unknown): string => {
  if (typeof x === "string") return x;
  const o = (x ?? {}) as Record<string, unknown>;
  const email = asText(o.email ?? o.address ?? "");
  const name = asText(o.name ?? "");
  return email ? (name ? `${name} <${email}>` : email) : "";
};
const addrs = (v: unknown): string[] => (Array.isArray(v) ? v : v ? [v] : []).flatMap((x) => (typeof x === "string" ? x.split(",") : [addrText(x)])).map((x) => parseAddress(x).email).filter(Boolean);

export function normalizeHeaders(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(h)) {
    for (const e of h) { const k = asText((e as any)?.name ?? (e as any)?.key); if (k) out[k.toLowerCase()] = asText((e as any)?.value); }
  } else if (h && typeof h === "object") {
    for (const [k, v] of Object.entries(h as Record<string, unknown>)) out[k.toLowerCase()] = asText(v);
  }
  return out;
}

export interface ReceivedEmail {
  emailId: string; fromRaw: string; to: string[]; cc: string[]; bcc: string[]; replyTo: string[]; subject: string; messageId: string;
  inReplyTo: string; references: string; listUnsubscribe: string; html: string; text: string; createdAt: string | null; authentication: unknown; headers: Record<string, string>;
}
export function normalizeReceivedEmail(full: any, data: any): ReceivedEmail {
  const headers = normalizeHeaders(full?.headers);
  const fromRaw = asText(headers["from"] || addrText(full?.from) || addrText(data?.from));
  const to = addrs(full?.to ?? data?.to ?? headers["to"]);
  const cc = addrs(full?.cc ?? data?.cc ?? headers["cc"]);
  const bcc = addrs(full?.bcc ?? data?.bcc);
  if (!isValidEmail(parseAddress(fromRaw).email) || !(to.length + cc.length + bcc.length)) {
    const seen = Object.keys(full && typeof full === "object" ? full : {}).slice(0, 30).join(",");
    throw new Error(`Unexpected received-email shape (missing sender or recipients). Fields seen: ${seen || "none"}`);
  }
  return {
    emailId: asText(data?.email_id ?? data?.id ?? full?.id), fromRaw, to, cc, bcc,
    replyTo: addrs(full?.reply_to ?? full?.replyTo ?? headers["reply-to"]),
    subject: asText(full?.subject ?? data?.subject ?? headers["subject"]),
    messageId: parseMessageIds(full?.message_id ?? full?.messageId ?? data?.message_id ?? headers["message-id"])[0] || "",
    inReplyTo: parseMessageIds(headers["in-reply-to"])[0] || "",
    references: headers["references"] || "",
    listUnsubscribe: headers["list-unsubscribe"] || "",
    html: asText(full?.html), text: asText(full?.text),
    createdAt: asText(full?.created_at ?? full?.createdAt ?? data?.created_at) || null,
    authentication: full?.authentication ?? null, headers,
  };
}
export function normalizeAttachment(a: any) {
  return {
    id: asText(a?.id ?? a?.attachment_id), filename: safeFileName(a?.filename ?? a?.name), contentType: asText(a?.content_type ?? a?.contentType) || "application/octet-stream",
    size: Number(a?.size ?? a?.size_bytes ?? 0) || 0, contentId: asText(a?.content_id ?? a?.contentId) || null,
    inline: asText(a?.content_disposition ?? a?.contentDisposition) === "inline", url: asText(a?.download_url ?? a?.downloadUrl ?? a?.url),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The adapter object. `send` is a thin wrapper: build the payload, call sendViaResend with the SAME key/idempotency as before.
// ---------------------------------------------------------------------------------------------------------------
const RESEND_OPERATIONS: readonly AdapterOperation[] = Object.freeze(["send", "reply", "forward"] as AdapterOperation[]);

export const resendAdapter: EmailAdapter = {
  providerKey: "resend",
  adapterKey: "resend",
  displayName: "Resend",
  // Declared operations. `reply` and `forward` are sends with threading headers / a prefixed subject, built by the shared service.
  // Resend offers no folders, sync, search, remote drafts or read/archive state for a mailbox: those stay unsupported (CapabilityError).
  operations: RESEND_OPERATIONS,
  // No shared kill switch: public.email_provider_flags belongs to Intelligence (its admin switch writes it). General Email is gated ONLY by
  // its own public.email_provider_registry row (enabled) via the adapter registry.
  legacyFlagKey: null,
  // Free Resend plan: 100 emails a day. EMAIL_DAILY_LIMIT keeps its existing name and meaning.
  defaultDailyLimit: 100,
  dailyLimitEnv: "EMAIL_DAILY_LIMIT",
  configurationProblem(env) {
    return env("RESEND_API_KEY") ? null : "Email sending is not configured yet";
  },
  async send(ctx: AdapterContext, _account: AdapterAccount, i: AdapterSendInput): Promise<AdapterSendOutcome> {
    const apiKey = ctx.env("RESEND_API_KEY");
    if (!apiKey) return { ok: false, unknown: false, retryable: false, status: 503, message: "Email sending is not configured yet", attempts: 0 };
    const payload = buildResendPayload({
      fromEmail: i.fromEmail, fromName: i.fromName,
      req: { to: i.to, cc: i.cc, bcc: i.bcc, subject: i.subject, text: i.text, html: i.html, attachments: i.attachments },
      thread: i.thread, replyTo: i.replyTo, correlationId: i.correlationId,
    });
    const out = await sendViaResend(ctx.fetch, apiKey, payload, i.idempotencyKey, { sleep: ctx.sleep });
    if (!out.ok) return out;
    // Resend generates the RFC Message-ID. Since July 2026 it is available from GET /emails/:id.
    // Failure to retrieve it must not turn an accepted send into a failed/unknown send; the signed
    // email.* webhook also carries message_id and can repair the row asynchronously.
    let rfcMessageId: string | undefined;
    try {
      const full = await resendGet({ fetch: ctx.fetch, sleep: ctx.sleep }, apiKey, `/emails/${encodeURIComponent(out.id)}`);
      if (typeof full?.message_id === "string" && /^<[^<>\r\n]+>$/.test(full.message_id)) rfcMessageId = full.message_id;
    } catch {
      // Provider acceptance is final; leave RFC threading metadata for webhook reconciliation.
    }
    return { ok: true, providerMessageId: out.id, ...(rfcMessageId ? { rfcMessageId } : {}), attempts: out.attempts };
  },
};
