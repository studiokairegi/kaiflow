// KairFlow Email on Resend. Every decision here is pure or takes injected dependencies (fetch, clock, a data "store"),
// so it is unit tested without a network or database. The two index.ts files only wire real dependencies.
// NOT exercised against a live Resend account: endpoints and payloads follow Resend's public docs (send, receiving, webhooks).
// Keep this file to erasable TypeScript (types/interfaces only) so Node's test runner can load it directly.
import { corsHeaders } from "./cors.ts";

export const RESEND_API = "https://api.resend.com";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

// ---------------------------------------------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
export const isValidEmail = (s: unknown): boolean => typeof s === "string" && s.length <= 254 && EMAIL_RE.test(s.trim());

/** "Ada <ada@x.com>" -> { name: "Ada", email: "ada@x.com" }. A bare address works too. */
export function parseAddress(input: unknown): { name: string; email: string } {
  const s = String(input ?? "").trim();
  const m = /^(.*?)<([^<>]+)>\s*$/.exec(s);
  if (m) return { name: m[1].trim().replace(/^"+|"+$/g, "").trim(), email: m[2].trim().toLowerCase() };
  return { name: "", email: s.toLowerCase() };
}

/** Lower-cased bare addresses from a list of strings or "Name <addr>" strings. */
export const addressList = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === "string" && v ? v.split(",") : []).map((x) => parseAddress(x).email).filter(Boolean);

/** "Re: Re: Fwd: Hello" -> "hello". Used to match a reply to its conversation when headers are missing. */
export function normalizeSubject(subject: unknown): string {
  let s = String(subject ?? "").trim();
  const re = /^\s*(re|fwd?|aw|sv|vs|rv|antw)(\[\d+\])?\s*:\s*/i;
  for (let i = 0; i < 10 && re.test(s); i++) s = s.replace(re, "");
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}
export const replySubject = (s: string): string => (/^\s*re\s*:/i.test(s) ? s : `Re: ${s}`.trim());
export const forwardSubject = (s: string): string => (/^\s*fwd?\s*:/i.test(s) ? s : `Fwd: ${s}`.trim());

/** Message-IDs in a header value, with their angle brackets, in order. */
export const parseMessageIds = (v: unknown): string[] => String(v ?? "").match(/<[^<>\s]+>/g) || [];

/** In-Reply-To / References for a reply to `parent`. Null when the parent has no Message-ID we know. */
export function buildThreadHeaders(parent: { rfc_message_id?: string | null; references_ids?: string | null } | null): { in_reply_to: string; references: string } | null {
  const id = parseMessageIds(parent?.rfc_message_id)[0];
  if (!id) return null;
  const chain = [...parseMessageIds(parent?.references_ids), id].filter((x, i, a) => a.indexOf(x) === i).slice(-20);
  return { in_reply_to: id, references: chain.join(" ") };
}

/** Plus-address token: replies to john+k1a2b3c4d5e6f@domain land in the right conversation even if a mail server rewrites Message-ID. */
export const threadToken = (conversationId: string): string => conversationId.replace(/-/g, "").slice(0, 12).toLowerCase();
/** `inboundDomain` lets replies land on a different domain than the one mail is sent from (for example when Zoho owns the root domain's MX). */
export function withThreadToken(address: string, conversationId: string, inboundDomain = ""): string {
  const [local, domain] = address.toLowerCase().split("@");
  return `${local.split("+")[0]}+k${threadToken(conversationId)}@${inboundDomain || domain}`;
}
export const cleanInboundDomain = (v: unknown): string => {
  const d = String(v ?? "").trim().toLowerCase();
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d) ? d : "";
};
export const baseAddress = (address: string): string => {
  const [local, domain] = String(address).toLowerCase().trim().split("@");
  return domain ? `${local.split("+")[0]}@${domain}` : String(address).toLowerCase();
};
export function extractThreadToken(addresses: string[]): string | null {
  for (const a of addresses) {
    const m = /\+k([0-9a-f]{12})@/i.exec(a);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

export function htmlToText(html: string): string {
  return String(html || "")
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n").trim();
}

export const safeFileName = (n: unknown): string =>
  String(n ?? "attachment").replace(/[\\/\u0000-\u001f"<>|?*:]/g, "_").replace(/^\.+/, "").slice(0, 200) || "attachment";

// ---------------------------------------------------------------------------------------------------------------
// Threading: which conversation does an incoming message belong to?
// ---------------------------------------------------------------------------------------------------------------
export interface SubjectCandidate { conversation_id: string; normalized_subject: string; participants: string[]; last_message_at: string | null }
export interface PickInput {
  tokenConversationId: string | null;            // from a plus-address token, already resolved to a real conversation
  inReplyTo: string | null;
  references: string | null;
  rfcMap: Record<string, string>;                // Message-ID -> conversation id, for ids we already store
  normalizedSubject: string;
  sender: string;
  candidates: SubjectCandidate[];
  nowMs: number;
  windowDays?: number;
}
export function pickConversation(i: PickInput): { conversationId: string | null; via: "token" | "header" | "subject" | null } {
  if (i.tokenConversationId) return { conversationId: i.tokenConversationId, via: "token" };
  const ids = [...parseMessageIds(i.inReplyTo), ...parseMessageIds(i.references).reverse()];
  for (const id of ids) if (i.rfcMap[id]) return { conversationId: i.rfcMap[id], via: "header" };
  const windowMs = (i.windowDays ?? 30) * 86_400_000;
  const sender = i.sender.toLowerCase();
  const hit = i.candidates
    .filter((c) => i.normalizedSubject && c.normalized_subject === i.normalizedSubject)
    .filter((c) => c.participants.map((p) => p.toLowerCase()).includes(sender))
    .filter((c) => c.last_message_at && i.nowMs - Date.parse(c.last_message_at) <= windowMs)
    .sort((a, b) => Date.parse(b.last_message_at || "") - Date.parse(a.last_message_at || ""))[0];
  return hit ? { conversationId: hit.conversation_id, via: "subject" } : { conversationId: null, via: null };
}

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
export const statusForEvent = (type: string): string | null => EVENT_STATUS[type] || null;

// ---------------------------------------------------------------------------------------------------------------
// Webhook signature (Svix scheme, which Resend uses): HMAC-SHA256 over "<id>.<timestamp>.<body>", base64.
// ---------------------------------------------------------------------------------------------------------------
const b64ToBytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
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

// ---------------------------------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------------------------------
export interface AttachmentIn { filename: string; content_base64: string; content_type?: string }
export interface SendRequest {
  account_id: string; to: string[]; cc: string[]; bcc: string[]; subject: string; text: string; html: string; reply_to: string;
  conversation_id: string | null; draft_id: string | null; idempotency_key: string; attachments: AttachmentIn[];
}
export const LIMITS = Object.freeze({ maxRecipients: 50, maxAttachments: 10, maxAttachmentBytes: 10 * 1024 * 1024, maxSubject: 998, maxBody: 200_000, maxRequestBytes: 16 * 1024 * 1024 });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const base64Bytes = (b64: string) => Math.floor((b64.replace(/=+$/, "").length * 3) / 4);

export function validateSendRequest(raw: any): { ok: true; value: SendRequest } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Invalid request" };
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
  const to = list(raw.to), cc = list(raw.cc), bcc = list(raw.bcc);
  if (!UUID_RE.test(String(raw.account_id || ""))) return { ok: false, error: "Choose a sender address" };
  if (!to.length) return { ok: false, error: "Add at least one recipient" };
  for (const a of [...to, ...cc, ...bcc]) if (!isValidEmail(a)) return { ok: false, error: `"${a.slice(0, 80)}" is not a valid email address` };
  if (to.length + cc.length + bcc.length > LIMITS.maxRecipients) return { ok: false, error: `Too many recipients (max ${LIMITS.maxRecipients})` };
  const subject = String(raw.subject ?? "").trim();
  if (!subject) return { ok: false, error: "Add a subject" };
  if (subject.length > LIMITS.maxSubject || /[\r\n]/.test(subject)) return { ok: false, error: "Subject is too long or has line breaks" };
  const text = String(raw.text ?? ""), html = String(raw.html ?? "");
  if (!text.trim() && !html.trim()) return { ok: false, error: "Write a message" };
  if (text.length > LIMITS.maxBody || html.length > LIMITS.maxBody * 2) return { ok: false, error: "Message is too long" };
  const key = String(raw.idempotency_key ?? "");
  if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(key)) return { ok: false, error: "Missing request key" };
  const reply_to = String(raw.reply_to ?? "").trim();
  if (reply_to && !isValidEmail(parseAddress(reply_to).email)) return { ok: false, error: "Reply-to is not a valid address" };
  const conv = raw.conversation_id ? String(raw.conversation_id) : null;
  const draft = raw.draft_id ? String(raw.draft_id) : null;
  if ((conv && !UUID_RE.test(conv)) || (draft && !UUID_RE.test(draft))) return { ok: false, error: "Invalid conversation" };
  const atts = Array.isArray(raw.attachments) ? raw.attachments : [];
  if (atts.length > LIMITS.maxAttachments) return { ok: false, error: `Too many attachments (max ${LIMITS.maxAttachments})` };
  let total = 0;
  const attachments: AttachmentIn[] = [];
  for (const a of atts) {
    const b64 = String(a?.content_base64 ?? "");
    if (!b64 || !/^[A-Za-z0-9+/]+=*$/.test(b64)) return { ok: false, error: "An attachment could not be read" };
    total += base64Bytes(b64);
    attachments.push({ filename: safeFileName(a?.filename), content_base64: b64, content_type: String(a?.content_type || "application/octet-stream").slice(0, 120) });
  }
  if (total > LIMITS.maxAttachmentBytes) return { ok: false, error: "Attachments are over 10 MB in total" };
  const dedupe = (xs: string[]) => xs.filter((x, i) => xs.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i);
  return { ok: true, value: { account_id: String(raw.account_id), to: dedupe(to), cc: dedupe(cc), bcc: dedupe(bcc), subject, text, html, reply_to, conversation_id: conv, draft_id: draft, idempotency_key: key, attachments } };
}

const displayName = (n: string) => n.replace(/["<>\r\n\\]/g, "").trim();
export function buildResendPayload(o: { fromEmail: string; fromName: string; req: SendRequest; thread: { in_reply_to: string; references: string } | null; replyTo: string }): Record<string, unknown> {
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
    if (res.status === 429 || res.status >= 500) {
      last = { ok: false, unknown: false, retryable: true, status: res.status, message, attempts };
      const wait = Math.min(Number(res.headers?.get?.("retry-after")) * 1000 || 500 * 2 ** (attempts - 1), 5000);
      if (attempts < max) await sleep(wait);
      continue;
    }
    return { ok: false, unknown: false, retryable: false, status: res.status, message, attempts };   // 4xx: rejected, do not retry
  }
  return last;
}

// ---------------------------------------------------------------------------------------------------------------
// Data stores (implemented with Supabase in email_resend_store.ts, faked in tests)
// ---------------------------------------------------------------------------------------------------------------
export interface SendStore {
  providerEnabled(): Promise<boolean>;
  getAccount(orgId: string, accountId: string): Promise<{ id: string; address: string; display_name: string; status: string } | null>;
  getThreadParent(orgId: string, conversationId: string): Promise<{ rfc_message_id: string | null; references_ids: string | null } | null>;
  countOutboundSince(orgId: string, sinceIso: string): Promise<number>;
  createOutbound(p: Record<string, unknown>): Promise<{ duplicate: boolean; message_id: string; conversation_id: string; status: string; provider_message_id?: string | null }>;
  markResult(messageId: string, patch: Record<string, unknown>): Promise<void>;
  saveAttachments(orgId: string, messageId: string, files: { filename: string; content_type: string; base64: string }[]): Promise<void>;
}
export interface SendDeps {
  env: (k: string) => string | undefined;
  fetch: typeof fetch;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  authenticate: (req: Request) => Promise<{ ok: true; userId: string; organizationId: string } | { ok: false; status: number; error: string }>;
  store: SendStore;
}

export async function handleSend(req: Request, deps: SendDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const auth = await deps.authenticate(req);
  if (!auth.ok) return json({ error: auth.error }, auth.status);

  const text = await req.text();
  if (text.length > LIMITS.maxRequestBytes) return json({ error: "Request is too large" }, 413);
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return json({ error: "Invalid request" }, 400); }
  const v = validateSendRequest(raw);
  if (!v.ok) return json({ error: v.error }, 400);
  const r = v.value;

  const apiKey = deps.env("RESEND_API_KEY");
  if (!apiKey) return json({ error: "Email sending is not configured yet" }, 503);
  if (!(await deps.store.providerEnabled())) return json({ error: "Resend is not the active email provider" }, 503);
  const account = await deps.store.getAccount(auth.organizationId, r.account_id);
  if (!account || account.status !== "active") return json({ error: "Sender address not found" }, 404);

  // Free Resend plan allows 100 emails a day: stop here with a clear message rather than let Resend pause sending.
  const daily = Number(deps.env("EMAIL_DAILY_LIMIT") || 100);
  const dayAgo = new Date(deps.now() - 86_400_000).toISOString();
  const minuteAgo = new Date(deps.now() - 60_000).toISOString();
  if ((await deps.store.countOutboundSince(auth.organizationId, minuteAgo)) >= 20) return json({ error: "Slow down: too many emails in the last minute" }, 429);
  if ((await deps.store.countOutboundSince(auth.organizationId, dayAgo)) >= daily) return json({ error: `Daily sending limit reached (${daily}). Try again later or upgrade the Resend plan.` }, 429);

  const parent = r.conversation_id ? await deps.store.getThreadParent(auth.organizationId, r.conversation_id) : null;
  const thread = buildThreadHeaders(parent);

  const created = await deps.store.createOutbound({
    organization_id: auth.organizationId, account_id: account.id, conversation_id: r.conversation_id, draft_id: r.draft_id, idempotency_key: r.idempotency_key,
    user_id: auth.userId, to_emails: r.to, cc_emails: r.cc, bcc_emails: r.bcc, reply_to: r.reply_to, subject: r.subject, body_text: r.text, body_html: r.html,
    in_reply_to: thread?.in_reply_to ?? null, references_ids: thread?.references ?? null, normalized_subject: normalizeSubject(r.subject),
  });
  if (created.duplicate) return json({ ok: true, duplicate: true, message_id: created.message_id, conversation_id: created.conversation_id, status: created.status });

  // Replies to this message come back to a plus-address that names the conversation, unless the person chose their own reply-to.
  const tokens = (deps.env("EMAIL_THREAD_TOKENS") || "on").toLowerCase() !== "off";
  // EMAIL_INBOUND_DOMAIN: where replies should arrive (Resend receives there). Needed when another provider (Zoho) owns the sending domain's MX.
  const inboundDomain = cleanInboundDomain(deps.env("EMAIL_INBOUND_DOMAIN"));
  const replyTo = r.reply_to || (tokens ? withThreadToken(account.address, created.conversation_id, inboundDomain) : "");
  await deps.store.markResult(created.message_id, { status: "sending", reply_to: replyTo });

  const payload = buildResendPayload({ fromEmail: account.address, fromName: account.display_name, req: r, thread, replyTo });
  const out = await sendViaResend(deps.fetch, apiKey, payload, r.idempotency_key, { sleep: deps.sleep });

  if (out.ok) {
    await deps.store.markResult(created.message_id, { status: "sent", provider_message_id: out.id, sent_at: new Date(deps.now()).toISOString(), error: "" });
    if (r.attachments.length) {
      try { await deps.store.saveAttachments(auth.organizationId, created.message_id, r.attachments.map((a) => ({ filename: a.filename, content_type: a.content_type || "application/octet-stream", base64: a.content_base64 }))); }
      catch (e) { console.error("email-send: attachment copy failed", (e as Error)?.message); }        // the mail is already sent; never report failure for this
    }
    return json({ ok: true, message_id: created.message_id, conversation_id: created.conversation_id, status: "sent" });
  }
  if (out.unknown) {
    // The provider may have accepted it. Never resend automatically; leave it visible as "sending" for a person to check.
    await deps.store.markResult(created.message_id, { status: "sending", error: "Delivery outcome unknown. Check before sending again." });
    return json({ ok: false, status: "unknown", message_id: created.message_id, error: "We could not confirm the email was sent. Check the Sent folder before trying again." }, 202);
  }
  await deps.store.markResult(created.message_id, { status: out.status >= 400 && out.status < 500 && out.status !== 429 ? "rejected" : "failed", error: out.message });
  console.error("email-send: provider refused", out.status);
  return json({ ok: false, status: "failed", message_id: created.message_id, error: out.message }, out.status >= 400 && out.status < 500 && out.status !== 429 ? 422 : 502);
}

// ---------------------------------------------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------------------------------------------
export interface WebhookStore {
  providerEnabled(): Promise<boolean>;
  beginWebhook(svixId: string, type: string, payload: unknown): Promise<"new" | "done" | "retry">;
  finishWebhook(svixId: string, status: "processed" | "failed" | "ignored", error?: string): Promise<void>;
  findAccount(addresses: string[], inboundDomain?: string): Promise<{ id: string; organization_id: string; address: string } | null>;
  threadLookup(orgId: string, q: { token: string | null; rfcIds: string[]; normalizedSubject: string; sender: string }): Promise<{ tokenConversationId: string | null; rfcMap: Record<string, string>; candidates: SubjectCandidate[] }>;
  uploadAttachment(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  ingestInbound(p: Record<string, unknown>): Promise<{ duplicate: boolean; message_id: string; conversation_id?: string }>;
  applyDeliveryEvent(a: { provider_message_id: string; status: string; event_type: string; provider_event_id: string; occurred_at: string | null; detail: Record<string, unknown> }): Promise<boolean>;
}
export interface WebhookDeps {
  env: (k: string) => string | undefined;
  fetch: typeof fetch;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  store: WebhookStore;
}

const MAX_ATTACHMENT_DOWNLOAD = 25 * 1024 * 1024;

async function resendGet(d: WebhookDeps, apiKey: string, path: string): Promise<any> {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastStatus = 0;
  for (let i = 0; i < 3; i++) {
    const res = await d.fetch(`${RESEND_API}${path}`, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (res.ok) return await res.json();
    lastStatus = res.status;
    if (res.status !== 429 && res.status < 500) break;
    await sleep(400 * 2 ** i);
  }
  throw new Error(`Resend ${path.split("/").slice(0, 3).join("/")} failed (${lastStatus})`);   // path without ids: safe to log
}

export async function processInbound(d: WebhookDeps, apiKey: string, data: any): Promise<"processed" | "ignored"> {
  const emailId = String(data?.email_id || "");
  if (!emailId) return "ignored";
  const full = await resendGet(d, apiKey, `/emails/receiving/${encodeURIComponent(emailId)}`);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(full?.headers || {})) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(" ") : String(v);

  const to = addressList(full?.to ?? data?.to), cc = addressList(full?.cc ?? data?.cc), bcc = addressList(full?.bcc ?? data?.bcc);
  const account = await d.store.findAccount([...to, ...cc, ...bcc], cleanInboundDomain(d.env("EMAIL_INBOUND_DOMAIN")));
  if (!account) return "ignored";                                    // not addressed to one of our inboxes

  const from = parseAddress(headers["from"] || full?.from || data?.from);
  const subject = String(full?.subject ?? data?.subject ?? "");
  const rfc = parseMessageIds(full?.message_id ?? data?.message_id)[0] || "";
  const inReplyTo = parseMessageIds(headers["in-reply-to"])[0] || "";
  const references = headers["references"] || "";
  const normalizedSubject = normalizeSubject(subject);

  const lookup = await d.store.threadLookup(account.organization_id, {
    token: extractThreadToken([...to, ...cc]), rfcIds: [...parseMessageIds(inReplyTo), ...parseMessageIds(references)], normalizedSubject, sender: from.email,
  });
  const picked = pickConversation({ tokenConversationId: lookup.tokenConversationId, inReplyTo, references, rfcMap: lookup.rfcMap, normalizedSubject, sender: from.email, candidates: lookup.candidates, nowMs: d.now() });

  const bodyHtml = String(full?.html ?? "");
  const bodyText = String(full?.text ?? "") || htmlToText(bodyHtml);

  // Attachments: the webhook only carries metadata; download each file now (links expire in an hour) and keep our own copy.
  const files: Record<string, unknown>[] = [];
  const declared = (full?.attachments?.length || data?.attachments?.length || 0) > 0;
  if (declared) {
    const listed = await resendGet(d, apiKey, `/emails/receiving/${encodeURIComponent(emailId)}/attachments`);
    const items: any[] = Array.isArray(listed) ? listed : Array.isArray(listed?.data) ? listed.data : [];
    for (const a of items) {
      const meta = { provider_attachment_id: String(a.id || ""), filename: safeFileName(a.filename), content_type: String(a.content_type || "application/octet-stream"),
                     size_bytes: Number(a.size || 0), content_id: a.content_id || null, is_inline: String(a.content_disposition || "") === "inline" };
      let storagePath: string | null = null;
      if (a.download_url && meta.size_bytes <= MAX_ATTACHMENT_DOWNLOAD) {
        const res = await d.fetch(String(a.download_url));
        if (!res.ok) throw new Error(`Attachment download failed (${res.status})`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length <= MAX_ATTACHMENT_DOWNLOAD) {
          storagePath = `${account.organization_id}/${emailId}/${meta.provider_attachment_id}-${meta.filename}`;
          await d.store.uploadAttachment(storagePath, bytes, meta.content_type);
          meta.size_bytes = bytes.length;
        }
      }
      files.push({ ...meta, storage_path: storagePath });
    }
  }

  const participants = [{ email: from.email, name: from.name }, ...to.map((e) => ({ email: e, name: "" })), ...cc.map((e) => ({ email: e, name: "" }))];
  await d.store.ingestInbound({
    organization_id: account.organization_id, account_id: account.id, conversation_id: picked.conversationId, normalized_subject: normalizedSubject,
    provider_message_id: emailId, rfc_message_id: rfc, in_reply_to: inReplyTo, references_ids: references,
    from_email: from.email, from_name: from.name, to_emails: to, cc_emails: cc, bcc_emails: bcc, reply_to: addressList(full?.reply_to).join(", "),
    subject, body_text: bodyText, body_html: bodyHtml, received_at: full?.created_at || data?.created_at || new Date(d.now()).toISOString(),
    headers: { "in-reply-to": inReplyTo, references, "message-id": rfc, "list-unsubscribe": headers["list-unsubscribe"] || "" },
    auth_results: full?.authentication ?? null, participants, attachments: files,
  });
  return "processed";
}

export async function processDeliveryEvent(d: WebhookDeps, svixId: string, event: any): Promise<"processed" | "ignored"> {
  const status = statusForEvent(String(event?.type));
  const emailId = String(event?.data?.email_id || "");
  if (!status || !emailId) return "ignored";
  const detail = { reason: String(event?.data?.bounce?.message || event?.data?.failed?.reason || event?.data?.reason || "").slice(0, 400), type: event?.data?.bounce?.type || null };
  const found = await d.store.applyDeliveryEvent({ provider_message_id: emailId, status, event_type: String(event.type), provider_event_id: svixId, occurred_at: event?.created_at || null, detail });
  if (found) return "processed";
  // The event can beat our own database write of the Resend id by a moment: fail so Resend retries. Old events for mail we never sent are ignored.
  const age = d.now() - Date.parse(String(event?.created_at || "")) ;
  if (Number.isFinite(age) && age < 120_000) throw new Error("Message not recorded yet");
  return "ignored";
}

export async function handleWebhook(req: Request, d: WebhookDeps): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = d.env("RESEND_WEBHOOK_SECRET");
  const apiKey = d.env("RESEND_API_KEY");
  if (!secret || !apiKey) return json({ error: "Webhook is not configured" }, 503);

  const body = await req.text();
  if (body.length > 1_000_000) return json({ error: "Too large" }, 413);
  const id = req.headers.get("svix-id") || "";
  const valid = await verifySvixSignature({ secret, id, timestamp: req.headers.get("svix-timestamp") || "", signature: req.headers.get("svix-signature") || "", body, nowMs: d.now() });
  if (!valid) return json({ error: "Invalid signature" }, 401);

  let event: any;
  try { event = JSON.parse(body); } catch { return json({ error: "Invalid payload" }, 400); }
  const type = String(event?.type || "");

  if (!(await d.store.providerEnabled())) return json({ ok: true, ignored: "provider disabled" });   // acknowledge so Resend stops retrying
  const begin = await d.store.beginWebhook(id, type, event);
  if (begin === "done") return json({ ok: true, duplicate: true });

  try {
    const result = type === "email.received" ? await processInbound(d, apiKey, event.data) : await processDeliveryEvent(d, id, event);
    await d.store.finishWebhook(id, result);
    return json({ ok: true, result });
  } catch (e) {
    const message = String((e as Error)?.message || "failed").slice(0, 300);
    console.error("resend-webhook failed:", type, message);
    try { await d.store.finishWebhook(id, "failed", message); } catch { /* the 500 below still makes Resend retry */ }
    return json({ error: "Processing failed" }, 500);
  }
}
