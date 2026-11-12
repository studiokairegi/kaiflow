// KairFlow Email shared service (multi-provider plan, phase 3). Provider-neutral: validation, authorization hand-off, rate limits,
// idempotency, thread headers, persistence and error normalisation live here. Every provider API call lives in an adapter
// (email_adapter_*.ts) chosen from the provider stored on the ACCOUNT ROW in the database, never from anything the browser sends.
// Every decision here is pure or takes injected dependencies (fetch, clock, a data "store"), so it is unit tested without a network
// or database. The two index.ts files only wire real dependencies.
// The file keeps its historical name so existing imports keep working. Resend code moved to email_adapter_resend.ts and is
// re-exported below, unchanged. NOT exercised against a live Resend account.
// Keep this file to erasable TypeScript (types/interfaces only) so Node's test runner can load it directly.
import { corsHeaders } from "./cors.ts";
import { isValidEmail, parseAddress, parseMessageIds, buildThreadHeaders, normalizeSubject, withThreadToken, cleanInboundDomain, baseAddress, extractThreadToken, htmlToText, safeFileName, safeMsg, json, providerEventId } from "./email_common.ts";
import { resendAdapter, verifySvixSignature, normalizeReceivedEmail, normalizeAttachment, resendGet, statusForEvent } from "./email_adapter_resend.ts";
import { AdapterError } from "./email_adapter.ts";
import type { AdapterContext, AdapterAccount, AdapterSendInput, AdapterErrorCode, EmailAdapter } from "./email_adapter.ts";
import { resolveAdapter, BUILTIN_ADAPTERS } from "./email_adapter_registry.ts";
import type { RegistryRow } from "./email_adapter_registry.ts";

// Re-exports: the public surface of this module is unchanged (tests, Intelligence contract tests and both index.ts files import these names).
export * from "./email_common.ts";
export { RESEND_API, verifySvixSignature, buildResendPayload, sendViaResend, statusForEvent, normalizeReceivedEmail, normalizeAttachment, normalizeHeaders } from "./email_adapter_resend.ts";
export type { SendOutcome, ReceivedEmail } from "./email_adapter_resend.ts";

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


export async function handleSend(req: Request, deps: SendDeps): Promise<Response> {
  // Diagnostics only: a request id and the last pipeline stage reached. Never a body, address, token or key.
  const requestId = crypto.randomUUID();
  let stage = "authenticate";
  let authenticated = false;
  const mark = <T extends (...a: any[]) => any>(name: string, fn: T): T => ((...a: any[]) => { stage = name; return fn(...a); }) as T;
  const store = new Proxy(deps.store, {
    get(t, p, r) { const v = Reflect.get(t, p, r); return typeof v === "function" ? mark(String(p), v.bind(t)) : v; },
  });
  const traced: SendDeps = {
    ...deps, store,
    authenticate: async (rq) => { const a = await deps.authenticate(rq); authenticated = true; stage = "validate"; return a; },
    ...(deps.getProviderAccessToken ? { getProviderAccessToken: mark("getProviderAccessToken", deps.getProviderAccessToken) } : {}),
  };
  try {
    return await sendInner(req, traced);
  } catch (e) {
    // Any unexpected failure (for example a database error) is a safe 500, never an unhandled crash and never a false "sent".
    console.error("email-send failed:", safeMsg(e), JSON.stringify({ request_id: requestId, stage, error_name: (e as Error)?.name || "Error", frames: String((e as Error)?.stack || "").split("\n").slice(1, 7).map((l) => l.trim().replace(/https?:\/\/\S*\//g, "").slice(0, 160)) }));
    // Before authentication completes nothing can have been sent, so do not tell the person to look in the Sent folder.
    if (!authenticated) return refuse(500, "internal_error", "Could not verify your access right now. Nothing was sent. Try again shortly.");
    return refuse(500, "internal_error", "Could not send right now. Check the Sent folder before trying again.");
  }
}


// ---------------------------------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------------------------------
export interface AttachmentIn { filename: string; content_base64: string; content_type?: string }
export interface SendRequest {
  account_id: string; to: string[]; cc: string[]; bcc: string[]; subject: string; text: string; html: string; reply_to: string;
  conversation_id: string | null; draft_id: string | null; idempotency_key: string; attachments: AttachmentIn[];
  /** Phase 4B: optional CRM lead the send is for. A CLAIM, verified server-side against the caller before anything is created. Never forwarded to an adapter. */
  crm: { lead_id: string } | null;
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
  if (text.length > LIMITS.maxBody || html.length > 1_100_000) return { ok: false, error: "Message is too long" };
  const key = String(raw.idempotency_key ?? "");
  if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(key)) return { ok: false, error: "Missing request key" };
  const reply_to = String(raw.reply_to ?? "").trim();
  if (reply_to && !isValidEmail(parseAddress(reply_to).email)) return { ok: false, error: "Reply-to is not a valid address" };
  const conv = raw.conversation_id ? String(raw.conversation_id) : null;
  const draft = raw.draft_id ? String(raw.draft_id) : null;
  if ((conv && !UUID_RE.test(conv)) || (draft && !UUID_RE.test(draft))) return { ok: false, error: "Invalid conversation" };
  let crm: { lead_id: string } | null = null;
  if (raw.crm !== undefined && raw.crm !== null) {
    const id = raw.crm && typeof raw.crm === "object" && !Array.isArray(raw.crm) ? String((raw.crm as { lead_id?: unknown }).lead_id ?? "") : "";
    if (!UUID_RE.test(id)) return { ok: false, error: "Invalid CRM lead" };
    crm = { lead_id: id.toLowerCase() };
  }
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
  return { ok: true, value: { account_id: String(raw.account_id), to: dedupe(to), cc: dedupe(cc), bcc: dedupe(bcc), subject, text, html, reply_to, conversation_id: conv, draft_id: draft, idempotency_key: key, attachments, crm } };
}



// ---------------------------------------------------------------------------------------------------------------
// Data stores (implemented with Supabase in email_resend_store.ts, faked in tests)
// ---------------------------------------------------------------------------------------------------------------
export interface SendStore {
  /** The legacy shared kill switch (public.email_provider_flags, also written by Intelligence's admin switch) for `legacyFlagKey`. Throws on database errors. */
  providerEnabled(legacyFlagKey: string): Promise<boolean>;
  /** The provider's row in public.email_provider_registry, or null when there is none. Throws on database errors. */
  getProviderRegistryRow(providerKey: string): Promise<RegistryRow | null>;
  /** Scoped to the organization. `provider` is the value stored on the account row in the database. */
  getAccount(orgId: string, accountId: string): Promise<{ id: string; organization_id: string; provider: string; address: string; display_name: string; status: string; connection_status?: string } | null>;
  /** Phase 4B. The lead, only when it exists AND is owned by `userId` (leads are per user; decision D1). Null otherwise: "missing" and "not yours" look the same. Throws on database errors. */
  getLeadForUser(userId: string, leadId: string): Promise<{ id: string; email: string | null } | null>;
  /** Existing conversation CRM association, scoped to organization and sender account. */
  getConversationLead(orgId: string, conversationId: string, accountId: string): Promise<{ lead_id: string | null } | null>;
  /** Atomically writes the CRM timeline entry and its full email activity record. Safe to retry after provider acceptance. */
  recordCrmActivity(messageId: string): Promise<{ recorded: boolean; duplicate: boolean }>;
  /** Scoped to the organization AND the account, so another account's thread can never supply reply headers. */
  getThreadParent(orgId: string, conversationId: string, accountId: string): Promise<{ rfc_message_id: string | null; references_ids: string | null; provider_message_id?: string | null; provider_thread_id?: string | null; parent_direction?: "inbound" | "outbound" | null } | null>;
  /** Outbound messages created since `sinceIso`; when `provider` is given, only that provider's (its quota is its own). */
  countOutboundSince(orgId: string, sinceIso: string, provider?: string): Promise<number>;
  createOutbound(p: Record<string, unknown>): Promise<{ duplicate: boolean; message_id: string; conversation_id: string; status: string; provider_message_id?: string | null; rate_limited?: "minute" | "day" }>;
  markResult(messageId: string, patch: Record<string, unknown>): Promise<void>;
  /** Atomically transitions exactly one queued row to sending; false means another request already claimed it. */
  claimOutbound?(messageId: string, replyTo: string): Promise<boolean>;
  saveAttachments(orgId: string, messageId: string, files: { filename: string; content_type: string; base64: string }[]): Promise<void>;
}
export interface SendDeps {
  env: (k: string) => string | undefined;
  fetch: typeof fetch;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  authenticate: (req: Request) => Promise<{ ok: true; userId: string; organizationId: string } | { ok: false; status: number; error: string }>;
  store: SendStore;
  /** Optional audit sink (structured, no addresses, no bodies, no secrets). Defaults to one JSON line on the console. */
  audit?: (e: AuditEvent) => void;
  /** Adapters available to this deployment, by adapter_key. Defaults to BUILTIN_ADAPTERS; set only by tests and by future wiring that adds a provider. */
  adapters?: Readonly<Record<string, EmailAdapter>>;
  getProviderAccessToken?: AdapterContext["getProviderAccessToken"];
}

/** Audit record. Never contains recipient addresses, subjects, bodies, attachment names or credentials. */
export interface AuditEvent { event: "send_refused" | "send_attempt" | "send_result"; organization_id: string; user_id: string; account_id?: string; provider?: string; code?: string; status?: string; message_id?: string; provider_message_id?: string; attempts?: number }
const defaultAudit = (e: AuditEvent) => console.log(JSON.stringify({ email_audit: e }));

/** Normalised, browser-safe answer for an adapter/capability error. Never includes secrets or provider response bodies. */
export function adapterErrorResponse(e: AdapterError): Response {
  return json({ error: e.message, code: e.code }, e.status);
}

// ---------------------------------------------------------------------------------------------------------------
// Phase 4B: one normalised answer shape for email-send. The browser can always branch on `code` (refusals) and `outcome` (results).
// ---------------------------------------------------------------------------------------------------------------
/** Why email-send refused or failed. A superset of the adapter codes; EVERY non-2xx answer after the CORS preflight carries one. */
export type SendErrorCode = AdapterErrorCode | "unauthenticated" | "forbidden" | "method_not_allowed" | "request_too_large" | "invalid_request" | "account_not_found" | "lead_not_found" | "internal_error" | "database_unavailable" | "idempotency_conflict" | "crm_lead_conflict" | "crm_recipient_mismatch";
/** What happened to a message that reached the provider step. `unknown` = the provider may have accepted it: resend ONLY with the same idempotency key. */
export type SendOutcomeKind = "accepted" | "duplicate" | "rejected" | "failed" | "unknown";
export interface SendResponseV2 {
  ok: boolean; outcome?: SendOutcomeKind; message_id?: string; conversation_id?: string; status?: string;
  retry_with_same_key?: boolean; crm?: { lead_id: string; activity: "recorded" | "pending" | "skipped" };
  warning?: "sent_status_not_saved" | "crm_activity_pending"; code?: SendErrorCode; error?: string; duplicate?: boolean;
}
const refuse = (status: number, code: SendErrorCode, error: string) => json({ error, code }, status);

/** Provider-supplied text is untrusted: it may echo a credential, a token or an internal address. This keeps it short, single-line
 *  and free of anything that looks like a secret. It is what is stored in email_messages.error and (for rejections only) shown to a person. */
export function sanitizeProviderMessage(v: unknown): string {
  return String(v ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "[redacted]")
    .replace(/\b(api[_ -]?key|token|secret|password|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\b(?:re|sk|pk|rk|key|token|secret)_[A-Za-z0-9_-]{8,}/gi, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]")
    .replace(/\s+/g, " ").trim().slice(0, 200);
}

async function sendInner(req: Request, deps: SendDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return refuse(405, "method_not_allowed", "Method not allowed");
  const auth = await deps.authenticate(req);
  if (!auth.ok) return refuse(auth.status, auth.status === 401 ? "unauthenticated" : "forbidden", auth.error);

  const text = await req.text();
  if (text.length > LIMITS.maxRequestBytes) return refuse(413, "request_too_large", "Request is too large");
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return refuse(400, "invalid_request", "Invalid request"); }
  const v = validateSendRequest(raw);
  if (!v.ok) return refuse(400, "invalid_request", v.error);
  const r = v.value;

  const audit = deps.audit ?? defaultAudit;
  const who = { organization_id: auth.organizationId, user_id: auth.userId };

  // 1. The account row decides the provider. Nothing from the request body (such as a "provider" field) is ever consulted.
  //    Ownership: the row must belong to the caller's organization. The store already filters by it; this re-check makes a store
  //    mistake (or a row with no organization) fail closed. "Not found" and "someone else's" answer identically.
  const account = await deps.store.getAccount(auth.organizationId, r.account_id);
  if (!account || account.organization_id !== auth.organizationId) { audit({ event: "send_refused", ...who, account_id: r.account_id, code: "account_not_found" }); return refuse(404, "account_not_found", "Sender address not found"); }
  if (account.status !== "active") {
    audit({ event: "send_refused", ...who, account_id: account.id, provider: String(account.provider || ""), code: "account_not_usable" });
    return adapterErrorResponse(new AdapterError("account_not_usable", "This sender address is paused. Choose another sender.", { provider: String(account.provider || "") }));
  }

  // 2. Registry row + adapter, validated server-side. Unknown / disabled / not-installed providers are refused with a normalised code.
  let resolved;
  try {
    resolved = resolveAdapter(account.provider, await deps.store.getProviderRegistryRow(String(account.provider || "")), deps.adapters ?? BUILTIN_ADAPTERS);
  } catch (e) {
    if (e instanceof AdapterError) { audit({ event: "send_refused", ...who, account_id: account.id, provider: String(account.provider || ""), code: e.code }); return adapterErrorResponse(e); }
    throw e;
  }
  // OAuth accounts must be connected at the server boundary. UI gating is not authorization.
  if (resolved.row.capabilities?.oauth === true && account.connection_status !== "connected") {
    audit({ event: "send_refused", ...who, account_id: account.id, provider: resolved.adapter.providerKey, code: "account_not_connected" });
    return adapterErrorResponse(new AdapterError("account_not_usable", "This sender account is not connected. Reconnect it or choose another sender.", { provider: resolved.adapter.providerKey }));
  }
  const { adapter } = resolved;
  const ctx: AdapterContext = { env: deps.env, fetch: deps.fetch, now: deps.now, sleep: deps.sleep, getProviderAccessToken: deps.getProviderAccessToken };

  // 3. Server-side configuration (for Resend: the API key), then the legacy shared kill switch if the adapter has one.
  const problem = adapter.configurationProblem(deps.env);
  if (problem) { audit({ event: "send_refused", ...who, account_id: account.id, provider: adapter.providerKey, code: "not_configured" }); return refuse(503, "not_configured", problem); }
  if (adapter.legacyFlagKey && !(await deps.store.providerEnabled(adapter.legacyFlagKey))) {
    audit({ event: "send_refused", ...who, account_id: account.id, provider: adapter.providerKey, code: "provider_disabled" });
    return refuse(503, "provider_disabled", `${adapter.displayName} is not the active email provider`);
  }

  // 3b. Optional CRM lead: verify against the authenticated sender before anything is created or sent.
  // The lead association is persisted on the outbound message; CRM activity is written only after provider acceptance.
  let crm: SendResponseV2["crm"];
  const explicitlyRequestedLeadId = r.crm?.lead_id ?? null;
  let linkedConversationLeadId: string | null = null;
  let crmLeadId = explicitlyRequestedLeadId;
  if (r.conversation_id) {
    const linked = await deps.store.getConversationLead(auth.organizationId, r.conversation_id, account.id);
    const linkedLeadId = linked?.lead_id ? String(linked.lead_id).toLowerCase() : null;
    linkedConversationLeadId = linkedLeadId;
    if (linkedLeadId && crmLeadId && linkedLeadId !== crmLeadId) {
      audit({ event: "send_refused", ...who, account_id: account.id, provider: adapter.providerKey, code: "crm_lead_conflict" });
      return refuse(409, "crm_lead_conflict", "This conversation is already linked to a different CRM lead. Update the conversation link before sending.");
    }
    crmLeadId = crmLeadId || linkedLeadId;
  }
  if (crmLeadId) {
    const lead = await deps.store.getLeadForUser(auth.userId, crmLeadId);
    if (!lead || String(lead.id).toLowerCase() !== crmLeadId) {
      // A conversation can be shared across the studio while its CRM lead remains owned by
      // one colleague. A colleague may reply to that shared thread, but cannot write activity
      // to another user's lead. Explicit CRM compose/send requests still fail closed.
      if (explicitlyRequestedLeadId && linkedConversationLeadId !== crmLeadId) {
        audit({ event: "send_refused", ...who, account_id: account.id, provider: adapter.providerKey, code: "lead_not_found" });
        return refuse(404, "lead_not_found", "Lead not found");
      }
      crmLeadId = null;
    } else {
      const leadAddresses = String(lead.email || "").split(/[,;\r\n]+/).map((value) => parseAddress(value).email.toLowerCase()).filter(Boolean);
      if (explicitlyRequestedLeadId && (!leadAddresses.length || !r.to.some((address) => leadAddresses.includes(parseAddress(address).email.toLowerCase())))) {
        audit({ event: "send_refused", ...who, account_id: account.id, provider: adapter.providerKey, code: "crm_recipient_mismatch" });
        return refuse(409, "crm_recipient_mismatch", "The recipient does not match this CRM lead. Remove the CRM link or use the lead's email address.");
      }
      crm = { lead_id: crmLeadId, activity: "pending" };
    }
  }

  // Only some adapters name a limit variable. Never call env("") : Deno.env.get("") throws "Key is an empty string."
  const dailyOverride = adapter.dailyLimitEnv ? Number(deps.env(adapter.dailyLimitEnv)) : NaN;
  const daily = Number.isFinite(dailyOverride) && dailyOverride > 0 ? dailyOverride : (adapter.defaultDailyLimit || 100);
  const parent = r.conversation_id ? await deps.store.getThreadParent(auth.organizationId, r.conversation_id, account.id) : null;
  const thread = buildThreadHeaders(parent);

  let created: Awaited<ReturnType<SendStore["createOutbound"]>>;
  try {
    created = await deps.store.createOutbound({
      organization_id: auth.organizationId, account_id: account.id, conversation_id: r.conversation_id, draft_id: r.draft_id, idempotency_key: r.idempotency_key,
      user_id: auth.userId, to_emails: r.to, cc_emails: r.cc, bcc_emails: r.bcc, reply_to: r.reply_to, subject: r.subject, body_text: r.text, body_html: r.html,
      in_reply_to: thread?.in_reply_to ?? null, references_ids: thread?.references ?? null, normalized_subject: normalizeSubject(r.subject),
      // Included in the database-side immutable idempotency fingerprint (including attachment bytes).
      attachments: r.attachments.map((a) => ({ filename: a.filename, content_type: a.content_type || "application/octet-stream", content_base64: a.content_base64 })),
      crm_lead_id: crm?.lead_id ?? null, crm_user_id: crm ? auth.userId : null,
      rate_limit_minute: 20, rate_limit_daily: daily,
    });
  } catch (e) {
    if (/idempotency_key_conflict/i.test(safeMsg(e))) return refuse(409, "idempotency_conflict", "This request key was already used for a different sender or message. Create a new request key to send this message.");
    if (/crm_lead_conflict/i.test(safeMsg(e))) {
      audit({ event: "send_refused", ...who, account_id: account.id, provider: adapter.providerKey, code: "crm_lead_conflict" });
      return refuse(409, "crm_lead_conflict", "This conversation's CRM lead changed before the message was queued. Refresh the conversation and try again.");
    }
    throw e;
  }
  if (created.rate_limited) {
    const message = created.rate_limited === "minute"
      ? "Slow down: too many emails in the last minute"
      : `Daily sending limit reached (${daily}). Try again later or upgrade the ${adapter.displayName} plan.`;
    return refuse(429, "rate_limited", message);
  }
  // CRM recording is deliberately downstream of provider acceptance. A failed CRM write is
  // reported as pending; it must never turn an accepted email into a send retry. The recovery RPC
  // can replay this exact operation from the persisted email_messages row without contacting a provider.
  const recordCrm = async (messageId: string): Promise<"recorded" | "pending"> => {
    if (!crm) return "recorded";
    try {
      const result = await deps.store.recordCrmActivity(messageId);
      return result.recorded ? "recorded" : "pending";
    } catch (e) {
      console.error("email-send: CRM activity recording pending", safeMsg(e));
      return "pending";
    }
  };

  // Replies to this message come back to a plus-address that names the conversation, unless the person chose their own reply-to.
  const tokens = (deps.env("EMAIL_THREAD_TOKENS") || "on").toLowerCase() !== "off";
  const inboundDomain = cleanInboundDomain(deps.env("EMAIL_INBOUND_DOMAIN"));
  const replyTo = r.reply_to || (tokens ? withThreadToken(account.address, created.conversation_id, inboundDomain) : "");

  let claimAlreadyAcquired = false;
  // Phase 4C: a repeated key is a lookup, never permission to call the provider again.
  // Provider-accepted states are successful duplicates. Sending remains ambiguous; queued is resumable only through the atomic claim.
  if (created.duplicate) {
    const prior = String(created.status || "").toLowerCase();
    const accepted = new Set(["sent", "delivered", "delivery_delayed", "bounced", "complained"]);
    if (accepted.has(prior)) {
      const activity = await recordCrm(created.message_id);
      const crmResult = crm ? { ...crm, activity } : undefined;
      return json({ ok: true, duplicate: true, outcome: "duplicate", message_id: created.message_id, conversation_id: created.conversation_id, status: prior, ...(crmResult ? { crm: crmResult } : {}), ...(activity === "pending" && crm ? { warning: "crm_activity_pending" as const } : {}) } satisfies SendResponseV2);
    }
    if (prior === "rejected") return json({ ok: false, duplicate: true, outcome: "rejected", retry_with_same_key: false, code: "provider_rejected", message_id: created.message_id, conversation_id: created.conversation_id, status: prior, error: "The provider rejected this message. Edit it and try again." } satisfies SendResponseV2, 422);
    if (prior === "failed") return json({ ok: false, duplicate: true, outcome: "failed", retry_with_same_key: false, code: "provider_unavailable", message_id: created.message_id, conversation_id: created.conversation_id, status: prior, error: "The previous attempt failed. You can try again." } satisfies SendResponseV2, 502);
    if (prior === "queued" && deps.store.claimOutbound) {
      // A previous request may have persisted the queue row but failed before claiming it.
      // Claiming is an atomic queued -> sending transition; only its winner may contact the provider.
      const claimed = await deps.store.claimOutbound(created.message_id, replyTo);
      if (!claimed) return json({ ok: false, duplicate: true, outcome: "unknown", status: "unknown", retry_with_same_key: true, code: "outcome_unknown", message_id: created.message_id, conversation_id: created.conversation_id, error: "This send is already being claimed. Check Sent and retry with the same request key." } satisfies SendResponseV2, 202);
      claimAlreadyAcquired = true;
    } else {
      return json({ ok: false, duplicate: true, outcome: "unknown", status: "unknown", retry_with_same_key: true, code: "outcome_unknown", message_id: created.message_id, conversation_id: created.conversation_id, error: "This send is still unconfirmed. Check the Sent folder; do not create a new send." } satisfies SendResponseV2, 202);
    }
  }

  // Claim the queued row before contacting the provider. A transient database failure must never
  // strand a message silently or allow an untracked provider submission. Retry only this write.
  let claimed = claimAlreadyAcquired;
  let claimError: unknown = null;
  for (let attempt = 0; attempt < 3 && !claimed; attempt++) {
    try {
      if (deps.store.claimOutbound) {
        claimed = await deps.store.claimOutbound(created.message_id, replyTo);
        if (!claimed) throw new Error("queued message was claimed by another request");
      } else await deps.store.markResult(created.message_id, { status: "sending", reply_to: replyTo });
      claimed = true;
      break;
    } catch (e) {
      claimError = e;
      if (attempt < 2) await (deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(100 * (2 ** attempt));
    }
  }
  if (!claimed) {
    console.error("email-send: queued-to-sending transition failed after retries", safeMsg(claimError));
    return json({ ok: false, outcome: "failed", status: "queued", retry_with_same_key: true, code: "database_unavailable", message_id: created.message_id, conversation_id: created.conversation_id, error: "The message is safely queued but was not submitted. Retry this request with the same idempotency key." } satisfies SendResponseV2, 503);
  }

  audit({ event: "send_attempt", ...who, account_id: account.id, provider: adapter.providerKey, message_id: created.message_id });
  const adapterAccount: AdapterAccount = { id: account.id, organization_id: auth.organizationId, provider: adapter.providerKey, address: account.address, display_name: account.display_name, status: account.status, connection_status: account.connection_status };
  const input: AdapterSendInput = {
    fromEmail: account.address, fromName: account.display_name, to: r.to, cc: r.cc, bcc: r.bcc, subject: r.subject, text: r.text, html: r.html,
    replyTo, thread, attachments: r.attachments, idempotencyKey: r.idempotency_key, correlationId: created.message_id,
  };
  let outcome;
  try {
    outcome = await adapter.send(ctx, adapterAccount, input);
  } catch (e) {
    // A throwing adapter must look like "outcome unknown", never like a clean failure that invites a duplicate send.
    console.error("email-send: adapter threw", adapter.providerKey, safeMsg(e));
    outcome = { ok: false as const, unknown: true, retryable: false, status: 0, message: "The email provider gave an unreadable answer", attempts: 0 };
  }
  const out = outcome.ok ? { ok: true as const, id: outcome.providerMessageId, rfcMessageId: outcome.rfcMessageId, providerThreadId: outcome.providerThreadId, attempts: outcome.attempts } : outcome;
  // Diagnostics: adapters return fixed, user-safe messages and a numeric status. Never a response body, address, token or subject.
  if (!outcome.ok) console.error("email-send: provider outcome", JSON.stringify({ provider: adapter.providerKey, status: (outcome as any).status ?? null, unknown: (outcome as any).unknown === true, message: String((outcome as any).message || "").slice(0, 160), attempts: (outcome as any).attempts ?? null }));
  audit({ event: "send_result", ...who, account_id: account.id, provider: adapter.providerKey, message_id: created.message_id, ...(out.ok ? { provider_message_id: out.id } : {}), status: out.ok ? "sent" : out.unknown ? "unknown" : "failed", attempts: out.attempts });

  if (out.ok) {
    let persisted = false;
    let persistError: unknown = null;
    // Provider acceptance is final. Retry only the database write (never the provider call), bounded to three attempts.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await deps.store.markResult(created.message_id, { status: "sent", provider_message_id: out.id, sent_at: new Date(deps.now()).toISOString(), error: "",
          ...(typeof out.rfcMessageId === "string" ? { rfc_message_id: out.rfcMessageId } : {}),
          ...(typeof out.providerThreadId === "string" ? { provider_thread_id: out.providerThreadId } : {}) });
        persisted = true;
        break;
      } catch (e) {
        persistError = e;
        if (attempt < 2) await (deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(100 * (2 ** attempt));
      }
    }
    if (!persisted) {
      // Never turn accepted mail into a retryable send failure. The opaque provider id is in the audit event for manual repair.
      console.error("email-send: accepted message status write failed after retries", safeMsg(persistError));
      return json({ ok: true, outcome: "accepted", message_id: created.message_id, conversation_id: created.conversation_id, status: "sent", warning: "sent_status_not_saved", ...(crm ? { crm: { ...crm, activity: "pending" } } : {}) } satisfies SendResponseV2);
    }
    if (r.attachments.length) {
      try { await deps.store.saveAttachments(auth.organizationId, created.message_id, r.attachments.map((a) => ({ filename: a.filename, content_type: a.content_type || "application/octet-stream", base64: a.content_base64 }))); }
      catch (e) { console.error("email-send: attachment copy failed", (e as Error)?.message); }        // the mail is already sent; never report failure for this
    }
    const activity = await recordCrm(created.message_id);
    const crmResult = crm ? { ...crm, activity } : undefined;
    return json({ ok: true, outcome: "accepted", message_id: created.message_id, conversation_id: created.conversation_id, status: "sent", ...(crmResult ? { crm: crmResult } : {}), ...(activity === "pending" && crm ? { warning: "crm_activity_pending" as const } : {}) } satisfies SendResponseV2);
  }
  if (out.unknown) {
    // The provider may have accepted it. Never resend automatically; leave it visible as "sending" for a person to check.
    await deps.store.markResult(created.message_id, { status: "sending", error: "Delivery outcome unknown. Check before sending again." });
    return json({ ok: false, outcome: "unknown", status: "unknown", code: "outcome_unknown", retry_with_same_key: true, message_id: created.message_id, error: "We could not confirm the email was sent. Check the Sent folder before trying again." } satisfies SendResponseV2, 202);
  }
  // A clean provider refusal. Provider-supplied text is sanitised before it is stored or shown; for a server-side failure the browser gets a fixed message instead.
  const rejected = out.status >= 400 && out.status < 500 && out.status !== 429;
  const detail = sanitizeProviderMessage(out.message);
  await deps.store.markResult(created.message_id, { status: rejected ? "rejected" : "failed", error: detail });
  console.error("email-send: provider refused", out.status);
  return json({
    ok: false, outcome: rejected ? "rejected" : "failed", status: "failed", retry_with_same_key: false, message_id: created.message_id,
    code: rejected ? "provider_rejected" : out.status === 429 ? "rate_limited" : "provider_unavailable",
    error: rejected ? (detail || "The email provider rejected this message") : "The email provider could not take this message right now. Try again later.",
  } satisfies SendResponseV2, rejected ? 422 : 502);
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
  /** The legacy shared kill switch for `legacyFlagKey`. Throws on any database error: a failure must never look like "provider disabled". */
  providerEnabled(legacyFlagKey: string): Promise<boolean>;
  /** The provider's registry row, or null. Throws on any database error (same rule). */
  getProviderRegistryRow(providerKey: string): Promise<RegistryRow | null>;
  /** Atomic claim (see the claim state machine in the hardening migration). */
  claimWebhook(svixId: string, type: string, payload: unknown): Promise<ClaimResult>;
  /** Records the outcome only while `token` still owns the claim. Returns false when the claim was lost. */
  finishWebhook(svixId: string, token: string, status: "processed" | "failed" | "ignored", error?: string): Promise<boolean>;
  /** Active accounts OF THE GIVEN PROVIDER for one recipient address, exact match (plus-tag removed) or, for the configured inbound domain, same local part. Throws on database errors. */
  accountsForRecipient(address: string, inboundDomain: string, providerKey: string): Promise<AccountRef[]>;
  /** Scoped to the organization AND the account. Throws on database errors. */
  threadLookup(orgId: string, accountId: string, q: { token: string | null; rfcIds: string[]; normalizedSubject: string; sender: string }): Promise<{ tokenConversationId: string | null; rfcMap: Record<string, string>; candidates: SubjectCandidate[] }>;
  uploadAttachment(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  ingestInbound(p: Record<string, unknown>): Promise<{ duplicate: boolean; message_id: string; conversation_id?: string }>;
  /** Bind a signed Resend event carrying our server-generated kf_message_id tag to a previously persisted sending row. */
  reconcileTaggedDeliveryEvent(a: { message_id: string; provider_message_id: string; event_type: string; provider_event_id: string; occurred_at: string | null; detail: Record<string, unknown>; sender_email: string; recipients: string[]; subject: string }): Promise<{ found: boolean; conflict?: boolean; status?: string }>;
  applyDeliveryEvent(a: { provider_message_id: string; status: string; event_type: string; provider_event_id: string; occurred_at: string | null; detail: Record<string, unknown> }): Promise<{ found: boolean; ambiguous?: boolean; duplicate?: boolean; applied?: boolean }>;
  /** OPTIONAL extra delivery sink plugged in by the endpoint wiring (resend-webhook/index.ts). General Email does not implement or import it;
   *  it exists so Intelligence can apply the same signed event to its own rows without general Email depending on intel_* objects. */
  applyIntelDeliveryEvent?(a: { provider_message_id: string; event_type: string; provider_event_id: string; occurred_at: string | null; recipient: string; reason: string; bounce_type: string }): Promise<{ found: boolean; ambiguous?: boolean; duplicate?: boolean; applied?: boolean }>;
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



export type Outcome = { result: "processed" | "ignored"; reason?: string };

/** Persist only bounded headers used for RFC threading, unsubscribe handling and CRM automation filtering. */
export function inboundStoredHeaders(headers: Record<string, string> | null | undefined): Record<string, string> {
  const allow = ["in-reply-to", "references", "message-id", "list-unsubscribe", "auto-submitted", "precedence", "x-autoreply", "x-autorespond"];
  const out: Record<string, string> = {};
  for (const key of allow) {
    const value = headers?.[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim().slice(0, key === "references" ? 2000 : 500);
  }
  return out;
}

export async function processInbound(d: WebhookDeps, apiKey: string, data: any): Promise<Outcome> {
  const emailId = String(data?.email_id ?? data?.id ?? "");
  if (!emailId) return { result: "ignored", reason: "missing email id" };
  const full = await resendGet(d, apiKey, `/emails/receiving/${encodeURIComponent(emailId)}`);
  const m = normalizeReceivedEmail(full, data);
  const { to, cc, bcc } = m;
  const inboundDomain = cleanInboundDomain(d.env("EMAIL_INBOUND_DOMAIN"));

  // Which inbox? Decided only from the recipients, per recipient, never from a global search or a default account.
  const matches: AccountRef[][] = [];
  for (const r of routingRecipients(to, cc, bcc)) matches.push(await d.store.accountsForRecipient(r, inboundDomain, resendAdapter.providerKey));
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
    organization_id: account.organization_id, account_id: account.id, provider: resendAdapter.providerKey, conversation_id: picked.conversationId, normalized_subject: normalizedSubject,
    provider_message_id: emailId, rfc_message_id: m.messageId, in_reply_to: m.inReplyTo, references_ids: m.references,
    from_email: from.email, from_name: from.name, to_emails: to, cc_emails: cc, bcc_emails: bcc, reply_to: m.replyTo.join(", "),
    subject: m.subject, body_text: bodyText, body_html: m.html, received_at: m.createdAt || new Date(d.now()).toISOString(),
    headers: inboundStoredHeaders(m.headers),
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
    message_id: typeof event?.data?.message_id === "string" ? event.data.message_id : "",
  };
  const eventId = providerEventId(resendAdapter.providerKey, svixId);
  const rawTags = event?.data?.tags;
  const taggedMessageId = typeof rawTags?.kf_message_id === "string"
    ? rawTags.kf_message_id
    : Array.isArray(rawTags) ? String(rawTags.find((t: any) => t?.name === "kf_message_id")?.value || "") : "";
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  // General Email (CRM Inbox) side. A failure here is remembered, NOT thrown yet: the optional Intelligence sink below must still
  // get its turn, so one system's outage never blocks the other. Both stores are idempotent, so the retry that a thrown error
  // triggers is safe for the side that already succeeded.
  let out: { found: boolean; ambiguous?: boolean; duplicate?: boolean; applied?: boolean } = { found: false };
  let emailError: unknown = null;
  try {
    let reconciled = false;
    // Only accepted/terminal delivery lifecycle events prove that Resend accepted the message.
    // Failed/rejected events do not bind a provider id to a successfully accepted CRM send.
    if (taggedMessageId && uuid.test(taggedMessageId) && ["email.sent", "email.delivered", "email.delivery_delayed", "email.bounced", "email.complained"].includes(eventType)) {
      const senderEmail = parseAddress(String(event?.data?.from || "")).email.toLowerCase();
      const tagged = await d.store.reconcileTaggedDeliveryEvent({
        message_id: taggedMessageId.toLowerCase(), provider_message_id: emailId, event_type: eventType,
        provider_event_id: eventId, occurred_at: event?.created_at || null, detail,
        sender_email: senderEmail, recipients, subject: String(event?.data?.subject || ""),
      });
      if (tagged.conflict) console.error("resend-webhook: tagged message did not match persisted sender/recipient/subject; refusing correlation");
      reconciled = tagged.found;
    }
    out = reconciled ? { found: true, applied: true } : await d.store.applyDeliveryEvent({ provider_message_id: emailId, status, event_type: eventType,
      provider_event_id: eventId, occurred_at: event?.created_at || null, detail });
    if (out.ambiguous) console.error("resend-webhook: provider message id matches several CRM messages; CRM row not updated");
  } catch (e) {
    emailError = e;
    console.error("resend-webhook: general Email delivery event failed:", safeMsg(e));
  }
  // Intelligence owns separate message rows and may exist without a CRM row (and the reverse). It is an optional sink plugged in by the
  // endpoint wiring; when absent, general Email runs alone.
  let intel: { found: boolean; ambiguous?: boolean; duplicate?: boolean; applied?: boolean } = { found: false };
  let intelError: unknown = null;
  if (d.store.applyIntelDeliveryEvent) {
    try {
      intel = await d.store.applyIntelDeliveryEvent({
        provider_message_id: emailId, event_type: eventType, provider_event_id: svixId,
        occurred_at: event?.created_at || null, recipient: recipients.length === 1 ? recipients[0] : "",
        reason: detail.reason, bounce_type: bounceType,
      });
      if (intel.ambiguous) throw new Error("Intelligence provider message id is ambiguous");
    } catch (e) {
      intelError = e;
      console.error("resend-webhook: Intelligence delivery event failed:", safeMsg(e));
    }
  }
  // Both sides have now been attempted. If either failed, fail the delivery (500 -> Resend retries); the side that succeeded is idempotent.
  if (emailError || intelError) throw (emailError || intelError);
  if (out.found || intel.found) return { result: "processed" };
  if (out.ambiguous) return { result: "ignored", reason: "ambiguous provider message id" };
  // The signed payload was persisted by claimWebhook before processing. Do not
  // discard it based on event age: insert/update triggers replay it once the
  // matching CRM or Intelligence provider id is committed.
  return { result: "ignored", reason: "awaiting provider message persistence; queued for reconciliation" };
}

/** This endpoint is the Resend adapter's inbound transport (Svix signatures are Resend's scheme), so the adapter is fixed by the
 *  endpoint, not by anything in the request. Same gate as sending: registry row enabled AND the legacy shared flag.
 *  true = process; false = Resend is switched off on purpose (acknowledge so Resend stops retrying);
 *  throws = database failure, missing registry row or missing adapter (NOT acknowledged: Resend retries instead of losing the event). */
export async function webhookProviderAllowed(store: Pick<WebhookStore, "providerEnabled" | "getProviderRegistryRow">): Promise<boolean> {
  const row = await store.getProviderRegistryRow(resendAdapter.providerKey);
  if (!row) throw new Error("provider registry row is missing (apply the multi-provider phase 2 migrations first)");
  try {
    resolveAdapter(resendAdapter.providerKey, row);
  } catch (e) {
    if (e instanceof AdapterError && e.code === "provider_disabled") return false;
    throw e;
  }
  return resendAdapter.legacyFlagKey ? await store.providerEnabled(resendAdapter.legacyFlagKey) : true;
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
    if (!(await webhookProviderAllowed(d.store))) return json({ ok: true, ignored: "provider disabled" });   // acknowledged on purpose so Resend stops retrying
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
