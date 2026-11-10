// KairFlow Email on Resend. Every decision here is pure or takes injected dependencies (fetch, clock, a data "store"),
// so it is unit tested without a network or database. The two index.ts files only wire real dependencies.
// NOT exercised against a live Resend account: endpoints and payloads follow Resend's public docs (send, receiving, webhooks).
// Keep this file to erasable TypeScript (types/interfaces only) so Node's test runner can load it directly.
import { corsHeaders } from "./cors.ts";

export const RESEND_API = "https://api.resend.com";
const safeMsg = (e: unknown): string => String((e as Error)?.message || "error").replace(/\s+/g, " ").slice(0, 200);   // never includes request bodies or keys
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
export const statusForEvent = (type: string, bounceType?: unknown): string | null => {
  // Resend reports temporary/transient/soft bounce classes inside the event payload.
  // They are delivery delays, not permanent contactability failures.
  if (type === "email.bounced" && /temporary|transient|soft/i.test(String(bounceType || ""))) return "delivery_delayed";
  return EVENT_STATUS[type] || null;
};

export async function handleSend(req: Request, deps: SendDeps): Promise<Response> {
  try {
    return await sendInner(req, deps);
  } catch (e) {
    // Any unexpected failure (for example a database error) is a safe 500, never an unhandled crash and never a false "sent".
    console.error("email-send failed:", safeMsg(e));
    return json({ error: "Could not send right now. Check the Sent folder before trying again." }, 500);
  }
}

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

async function sendInner(req: Request, deps: SendDeps): Promise<Response> {
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
    try {
      await deps.store.markResult(created.message_id, { status: "sent", provider_message_id: out.id, sent_at: new Date(deps.now()).toISOString(), error: "" });
    } catch (e) {
      // The provider accepted the mail. Never turn that into an error the person might retry: report success and flag the bookkeeping gap.
      console.error("email-send: sent but status update failed", safeMsg(e));
      return json({ ok: true, message_id: created.message_id, conversation_id: created.conversation_id, status: "sent", warning: "sent_status_not_saved" });
    }
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
/** An account a received message may be filed under. */
export interface AccountRef { id: string; organization_id: string; address: string }
export type AccountResolution = { status: "found"; account: AccountRef } | { status: "none" } | { status: "ambiguous"; reason: string };

/** Deterministic account choice from per-recipient matches (recipient order: To, Cc, Bcc).
 *  - a recipient that matches more than one account is ambiguous (nothing is guessed);
 *  - matches that span more than one organization are ambiguous (mail is never filed across an organization boundary);
 *  - within one organization the first matching recipient wins. */
export function resolveInboundAccount(matches: AccountRef[][]): AccountResolution {
  const hits: AccountRef[] = [];
  for (const list of matches) {
    const uniq = list.filter((a, i) => list.findIndex((b) => b.id === a.id) === i);
    if (uniq.length > 1) return { status: "ambiguous", reason: "a recipient matches more than one account" };
    if (uniq.length === 1) hits.push(uniq[0]);
  }
  if (!hits.length) return { status: "none" };
  if (new Set(hits.map((h) => h.organization_id)).size > 1) return { status: "ambiguous", reason: "recipients belong to different organizations" };
  return { status: "found", account: hits[0] };
}

/** Valid, de-duplicated routing addresses (plus-tags removed), at most 20. */
export const routingRecipients = (...lists: string[][]): string[] =>
  [...new Set(lists.flat().filter(isValidEmail).map(baseAddress))].slice(0, 20);

export const safeSegment = (v: unknown): string => String(v ?? "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128) || "x";

export type ClaimResult = { state: "claimed"; token: string; attempts: number } | { state: "done" } | { state: "busy" } | { state: "exhausted" };
export interface WebhookStore {
  /** Throws on any database error: a failure must never look like "provider disabled". */
  providerEnabled(): Promise<boolean>;
  /** Atomic claim (see the claim state machine in the hardening migration). */
  claimWebhook(svixId: string, type: string, payload: unknown): Promise<ClaimResult>;
  /** Records the outcome only while `token` still owns the claim. Returns false when the claim was lost. */
  finishWebhook(svixId: string, token: string, status: "processed" | "failed" | "ignored", error?: string): Promise<boolean>;
  /** Active Resend accounts for one recipient address, exact match (plus-tag removed) or, for the configured inbound domain, same local part. Throws on database errors. */
  accountsForRecipient(address: string, inboundDomain: string): Promise<AccountRef[]>;
  /** Scoped to the organization AND the account. Throws on database errors. */
  threadLookup(orgId: string, accountId: string, q: { token: string | null; rfcIds: string[]; normalizedSubject: string; sender: string }): Promise<{ tokenConversationId: string | null; rfcMap: Record<string, string>; candidates: SubjectCandidate[] }>;
  uploadAttachment(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  ingestInbound(p: Record<string, unknown>): Promise<{ duplicate: boolean; message_id: string; conversation_id?: string }>;
  applyDeliveryEvent(a: { provider_message_id: string; status: string; event_type: string; provider_event_id: string; occurred_at: string | null; detail: Record<string, unknown> }): Promise<{ found: boolean; ambiguous?: boolean; duplicate?: boolean; applied?: boolean }>;
  /** Route authenticated Resend delivery events into Intelligence, matching exact provider message/account provenance. */
  applyIntelDeliveryEvent(a: { provider_message_id: string; event_type: string; provider_event_id: string; occurred_at: string | null; recipient: string; reason: string; bounce_type: string }): Promise<{ found: boolean; ambiguous?: boolean; duplicate?: boolean; applied?: boolean }>;
}
export interface WebhookDeps {
  env: (k: string) => string | undefined;
  fetch: typeof fetch;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  store: WebhookStore;
}

const MAX_ATTACHMENT_DOWNLOAD = 25 * 1024 * 1024;
const MAX_WEBHOOK_BODY = 1_000_000;

async function resendGet(d: WebhookDeps, apiKey: string, path: string): Promise<any> {
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

/** Reads a download but gives up (null) as soon as it would exceed `cap` bytes, so a huge file is never held in memory. */
export async function readCapped(res: Response, cap: number): Promise<Uint8Array | null> {
  if (Number(res.headers.get("content-length") || 0) > cap) { try { await res.body?.cancel(); } catch { /* ignore */ } return null; }
  if (!res.body) { const b = new Uint8Array(await res.arrayBuffer()); return b.length <= cap ? b : null; }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) { try { await reader.cancel(); } catch { /* ignore */ } return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
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

export type Outcome = { result: "processed" | "ignored"; reason?: string };

export async function processInbound(d: WebhookDeps, apiKey: string, data: any): Promise<Outcome> {
  const emailId = String(data?.email_id ?? data?.id ?? "");
  if (!emailId) return { result: "ignored", reason: "missing email id" };
  const full = await resendGet(d, apiKey, `/emails/receiving/${encodeURIComponent(emailId)}`);
  const m = normalizeReceivedEmail(full, data);
  const { to, cc, bcc } = m;
  const inboundDomain = cleanInboundDomain(d.env("EMAIL_INBOUND_DOMAIN"));

  // Which inbox? Decided only from the recipients, per recipient, never from a global search or a default account.
  const matches: AccountRef[][] = [];
  for (const r of routingRecipients(to, cc, bcc)) matches.push(await d.store.accountsForRecipient(r, inboundDomain));
  const resolved = resolveInboundAccount(matches);
  if (resolved.status === "none") return { result: "ignored", reason: "no matching inbox" };
  if (resolved.status === "ambiguous") { console.error("resend-webhook: ambiguous inbox:", resolved.reason); return { result: "ignored", reason: `ambiguous inbox: ${resolved.reason}` }; }
  const account = resolved.account;

  const from = parseAddress(m.fromRaw);
  const normalizedSubject = normalizeSubject(m.subject);

  const lookup = await d.store.threadLookup(account.organization_id, account.id, {
    token: extractThreadToken([...to, ...cc]), rfcIds: [...parseMessageIds(m.inReplyTo), ...parseMessageIds(m.references)], normalizedSubject, sender: from.email,
  });
  const picked = pickConversation({ tokenConversationId: lookup.tokenConversationId, inReplyTo: m.inReplyTo, references: m.references, rfcMap: lookup.rfcMap, normalizedSubject, sender: from.email, candidates: lookup.candidates, nowMs: d.now() });

  const bodyText = m.text || htmlToText(m.html);

  // Attachments: the webhook only carries metadata; download each file now (links expire) with a hard size cap and keep our own copy.
  // Any failure here throws, so the event is NOT marked complete and Resend retries it.
  const files: Record<string, unknown>[] = [];
  const declared = (full?.attachments?.length || data?.attachments?.length || 0) > 0;
  if (declared) {
    const listed = await resendGet(d, apiKey, `/emails/receiving/${encodeURIComponent(emailId)}/attachments`);
    const items: any[] = Array.isArray(listed) ? listed : Array.isArray(listed?.data) ? listed.data : [];
    for (const raw of items) {
      const a = normalizeAttachment(raw);
      const meta = { provider_attachment_id: a.id, filename: a.filename, content_type: a.contentType, size_bytes: a.size, content_id: a.contentId, is_inline: a.inline };
      let storagePath: string | null = null;
      if (a.url && meta.size_bytes <= MAX_ATTACHMENT_DOWNLOAD) {
        const res = await d.fetch(a.url);
        if (!res.ok) throw new Error(`Attachment download failed (${res.status})`);
        const bytes = await readCapped(res, MAX_ATTACHMENT_DOWNLOAD);
        if (bytes) {
          storagePath = `${account.organization_id}/${safeSegment(emailId)}/${safeSegment(meta.provider_attachment_id)}-${meta.filename}`;
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
    provider_message_id: emailId, rfc_message_id: m.messageId, in_reply_to: m.inReplyTo, references_ids: m.references,
    from_email: from.email, from_name: from.name, to_emails: to, cc_emails: cc, bcc_emails: bcc, reply_to: m.replyTo.join(", "),
    subject: m.subject, body_text: bodyText, body_html: m.html, received_at: m.createdAt || new Date(d.now()).toISOString(),
    headers: { "in-reply-to": m.inReplyTo, references: m.references, "message-id": m.messageId, "list-unsubscribe": m.listUnsubscribe },
    auth_results: m.authentication, participants, attachments: files,
  });
  return { result: "processed" };
}

/** Unsupported or id-less events are ignored; ambiguous ids are never guessed.
 * Unmatched signed events remain durably queued in email_webhook_events and are
 * reconciled by database triggers when the exact provider message id is persisted. */
export async function processDeliveryEvent(d: WebhookDeps, svixId: string, event: any): Promise<Outcome> {
  const eventType = String(event?.type || "");
  const bounceType = String(event?.data?.bounce?.type || "");
  const status = statusForEvent(eventType, bounceType);
  if (!status) return { result: "ignored", reason: "unsupported event type" };
  const emailId = String(event?.data?.email_id || "");
  if (!emailId) return { result: "ignored", reason: "missing email id" };
  const rawRecipients = Array.isArray(event?.data?.to) ? event.data.to : [];
  const recipients = rawRecipients.map((x: unknown) => String(x || "").trim().toLowerCase())
    .filter((x: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));
  const detail = {
    reason: String(event?.data?.bounce?.message || event?.data?.failed?.reason || event?.data?.suppressed?.message || event?.data?.reason || "").slice(0, 400),
    type: bounceType || null,
    recipient: recipients.length === 1 ? recipients[0] : "",
  };
  const out = await d.store.applyDeliveryEvent({ provider_message_id: emailId, status, event_type: eventType,
    provider_event_id: svixId, occurred_at: event?.created_at || null, detail });
  if (out.ambiguous) console.error("resend-webhook: provider message id matches several CRM messages; CRM row not updated");
  // CRM Inbox and Intelligence own separate message rows, and either side can
  // exist independently. Route the authenticated event to both idempotent stores.
  const intel = await d.store.applyIntelDeliveryEvent({
    provider_message_id: emailId, event_type: eventType, provider_event_id: svixId,
    occurred_at: event?.created_at || null, recipient: recipients.length === 1 ? recipients[0] : "",
    reason: detail.reason, bounce_type: bounceType,
  });
  if (intel.ambiguous) throw new Error("Intelligence provider message id is ambiguous");
  if (out.found || intel.found) return { result: "processed" };
  if (out.ambiguous) return { result: "ignored", reason: "ambiguous provider message id" };
  // The signed payload was persisted by claimWebhook before processing. Do not
  // discard it based on event age: insert/update triggers replay it once the
  // matching CRM or Intelligence provider id is committed.
  return { result: "ignored", reason: "awaiting provider message persistence; queued for reconciliation" };
}

export async function handleWebhook(req: Request, d: WebhookDeps): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = d.env("RESEND_WEBHOOK_SECRET");
  const apiKey = d.env("RESEND_API_KEY");
  if (!secret || !apiKey) return json({ error: "Webhook is not configured" }, 503);

  if (Number(req.headers.get("content-length") || 0) > MAX_WEBHOOK_BODY) return json({ error: "Too large" }, 413);
  const body = await req.text();                                  // the RAW body: the signature covers these exact bytes
  if (body.length > MAX_WEBHOOK_BODY) return json({ error: "Too large" }, 413);
  const id = req.headers.get("svix-id") || "";
  const valid = await verifySvixSignature({ secret, id, timestamp: req.headers.get("svix-timestamp") || "", signature: req.headers.get("svix-signature") || "", body, nowMs: d.now() });
  if (!valid) return json({ error: "Invalid signature" }, 401);   // rejected before any database work
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) return json({ error: "Invalid payload" }, 400);

  let event: any;
  try { event = JSON.parse(body); } catch { return json({ error: "Invalid payload" }, 400); }
  const type = String(event?.type || "");

  try {
    if (!(await d.store.providerEnabled())) return json({ ok: true, ignored: "provider disabled" });   // acknowledged on purpose so Resend stops retrying
    const claim = await d.store.claimWebhook(id, type, event);
    if (claim.state === "done") return json({ ok: true, duplicate: true });
    if (claim.state === "busy") return json({ error: "Already being processed" }, 409);              // not 2xx: if the owner crashes, the sender's retry recovers the event
    if (claim.state === "exhausted") { console.error("resend-webhook: retry limit reached for", type); return json({ ok: false, exhausted: true }); }

    let outcome: Outcome;
    try {
      outcome = type === "email.received" ? await processInbound(d, apiKey, event.data) : await processDeliveryEvent(d, id, event);
    } catch (e) {
      const message = safeMsg(e);
      console.error("resend-webhook failed:", type, message);
      try { await d.store.finishWebhook(id, claim.token, "failed", message); }
      catch (fe) { console.error("resend-webhook: could not record failure:", safeMsg(fe)); }      // the lease simply expires; the 500 still triggers a retry
      return json({ error: "Processing failed" }, 500);
    }
    const owned = await d.store.finishWebhook(id, claim.token, outcome.result, outcome.reason || "");
    if (!owned) return json({ error: "Processing claim was lost" }, 409);                              // another worker owns this event now
    return json({ ok: true, result: outcome.result });
  } catch (e) {
    console.error("resend-webhook error:", type, safeMsg(e));                                           // database failures are never acknowledged as success
    return json({ error: "Processing failed" }, 500);
  }
}
