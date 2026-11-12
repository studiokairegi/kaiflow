// Gmail adapter for the central Inbox. OAuth tokens are resolved through the existing
// Intelligence account/token lifecycle; this module never reads or stores credentials.
import type { AdapterAccount, AdapterContext, AdapterSendInput, AdapterSendOutcome, AdapterSyncPage, EmailAdapter } from "./email_adapter.ts";
import { AdapterError } from "./email_adapter.ts";
import { parseAddress } from "./email_common.ts";

const API = "https://gmail.googleapis.com/gmail/v1";
const safeHeader = (v: string) => {
  if (/[\r\n\0]/.test(v)) throw new AdapterError("provider_rejected", "Email headers contain an invalid line break", { provider: "gmail", operation: "send" });
  return v;
};
const b64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
const b64url = (value: string) => b64(new TextEncoder().encode(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
const enc = (v: string) => b64(new TextEncoder().encode(v));
const headerSubject = (v: string) => /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${enc(v)}?=`;

export function buildGmailMime(account: AdapterAccount, input: AdapterSendInput, messageId: string): string {
  const headers = [
    `From: ${safeHeader(input.fromName ? `${headerSubject(input.fromName.replace(/[<>]/g, "").replace(/[\r\n\0]/g, " "))} <${input.fromEmail}>` : input.fromEmail)}`,
    `To: ${input.to.map(safeHeader).join(", ")}`,
  ];
  if (input.cc.length) headers.push(`Cc: ${input.cc.map(safeHeader).join(", ")}`);
  if (input.bcc.length) headers.push(`Bcc: ${input.bcc.map(safeHeader).join(", ")}`);
  headers.push(`Subject: ${headerSubject(safeHeader(input.subject))}`, `Date: ${new Date().toUTCString()}`, `Message-ID: ${messageId}`);
  if (input.replyTo) headers.push(`Reply-To: ${safeHeader(input.replyTo)}`);
  if (input.thread?.in_reply_to) headers.push(`In-Reply-To: ${safeHeader(input.thread.in_reply_to)}`);
  if (input.thread?.references) headers.push(`References: ${safeHeader(input.thread.references)}`);
  headers.push(`X-KairFlow-Correlation-ID: ${input.correlationId}`);
  const body = input.html || input.text || "";
  const bodyType = input.html ? "text/html" : "text/plain";
  if (!input.attachments.length) {
    return `${headers.join("\r\n")}\r\nMIME-Version: 1.0\r\nContent-Type: ${bodyType}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${enc(body)}\r\n`;
  }
  const boundary = `kairflow_${crypto.randomUUID().replace(/-/g, "")}`;
  headers.push("MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = [`--${boundary}\r\nContent-Type: ${bodyType}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${enc(body)}`];
  for (const file of input.attachments) {
    const filename = safeHeader(file.filename).replace(/["\\]/g, "_");
    const contentType = safeHeader(file.content_type || "application/octet-stream").replace(/[\r\n;]/g, "");
    const bytes = Uint8Array.from(atob(file.content_base64), (c) => c.charCodeAt(0));
    parts.push(`--${boundary}\r\nContent-Type: ${contentType}; name="${filename}"\r\nContent-Disposition: attachment; filename="${filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(bytes)}`);
  }
  parts.push(`--${boundary}--`);
  return `${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}\r\n`;
}


const decodeB64Url = (value: string): string => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
};
const headerMap = (rows: any[] = []) => Object.fromEntries(rows.filter((x) => x && typeof x.name === "string").map((x) => [String(x.name).toLowerCase(), String(x.value || "")]));
const addresses = (value: string) => [...new Set((String(value || "").match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map((x) => x.toLowerCase()))];
function gmailBody(payload: any, mime: string): string {
  if (!payload) return "";
  if (String(payload.mimeType || "").toLowerCase() === mime && payload.body?.data) return decodeB64Url(String(payload.body.data));
  for (const part of payload.parts || []) { const found = gmailBody(part, mime); if (found) return found; }
  return "";
}
function isGmailDeadline(error: unknown, ctx: AdapterContext, timeoutWasBudgetBound: boolean): boolean {
  return (ctx.deadlineAt !== undefined && ctx.now() >= ctx.deadlineAt) ||
    (timeoutWasBudgetBound && error instanceof Error && error.name === "TimeoutError");
}
async function gmailRequest(ctx: AdapterContext, token: { access_token: string }, path: string, params?: Record<string, string>) {
  const remaining = (ctx.deadlineAt ?? Number.POSITIVE_INFINITY) - ctx.now();
  if (remaining <= 0) throw new AdapterError("sync_deadline", "Mailbox account time budget exhausted", { provider: "gmail", operation: "sync" });
  const url = new URL(`${API}/users/me${path}`);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const timeoutMs = Math.max(1, Math.min(20_000, remaining));
  const timeoutWasBudgetBound = remaining <= 20_000;
  let response: Response;
  try { response = await ctx.fetch(url.toString(), { headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) }); }
  catch (error) {
    if (isGmailDeadline(error, ctx, timeoutWasBudgetBound)) throw new AdapterError("sync_deadline", "Mailbox account time budget exhausted", { provider: "gmail", operation: "sync" });
    throw error;
  }
  if (response.status === 429) throw new AdapterError("rate_limited", "Gmail mailbox is rate limited", { provider: "gmail", operation: "sync" });
  if (response.status >= 500) throw new AdapterError("provider_unavailable", "Gmail mailbox is temporarily unavailable", { provider: "gmail", operation: "sync" });
  if (!response.ok) {
    const failure = await response.json().catch(() => ({}));
    const detail = failure?.error || failure;
    const providerText = [detail?.message, detail?.status, ...(Array.isArray(detail?.errors) ? detail.errors.map((x: any) => `${x?.reason || ""} ${x?.message || ""}`) : [])].filter(Boolean).join(" ").toLowerCase();
    const invalidPageToken = response.status === 400 && /page.?token/.test(providerText);
    throw new AdapterError(response.status === 401 ? "account_not_usable" : "provider_rejected", invalidPageToken ? "Gmail page token was rejected" : "Gmail mailbox request was rejected", { status: response.status, provider: "gmail", operation: "sync" });
  }
  return await response.json();
}
async function syncGmail(ctx: AdapterContext, account: AdapterAccount, checkpoint: unknown): Promise<AdapterSyncPage> {
  if (!ctx.getProviderAccessToken) throw new AdapterError("not_configured", "Gmail token gateway is unavailable", { provider: "gmail", operation: "sync" });
  const token = await ctx.getProviderAccessToken(account, "sync");
  if (token.provider !== "gmail" || token.mailbox.toLowerCase() !== account.address.toLowerCase()) throw new AdapterError("account_not_usable", "Connected Gmail identity does not match this Inbox account", { provider: "gmail", operation: "sync" });
  const cp = checkpoint && typeof checkpoint === "object" ? checkpoint as Record<string, unknown> : {};
  const folderIndex = Math.max(0, Math.min(1, Number(cp.folderIndex || 0)));
  const label = folderIndex === 0 ? "INBOX" : "SENT";
  const pageToken = typeof cp.pageToken === "string" ? cp.pageToken : undefined;
  const offset = Math.max(0, Math.min(100, Number(cp.offset || 0)));
  let page: any;
  let activePageToken = pageToken;
  let resumeOffset = offset;
  let resumeMessageId = typeof cp.lastProcessedId === "string" ? cp.lastProcessedId : undefined;
  try {
    page = await gmailRequest(ctx, token, "/messages", { labelIds: label, maxResults: "100", ...(activePageToken ? { pageToken: activePageToken } : {}) });
  } catch (error) {
    // Gmail page tokens can expire or become invalid. Fall back to the beginning
    // of this label's current listing; persistence is idempotent, so this is safe.
    if (!(error instanceof AdapterError) || error.status !== 400 || error.message !== "Gmail page token was rejected" || !activePageToken) throw error;
    activePageToken = undefined;
    resumeOffset = 0;
    resumeMessageId = undefined;
    page = await gmailRequest(ctx, token, "/messages", { labelIds: label, maxResults: "100" });
  }
  const rows = Array.isArray(page.messages) ? page.messages : [];
  const messages: AdapterSyncPage["messages"] = [];
  let interrupted = false;
  let processedOffset = resumeOffset;
  let processedMessageId = resumeMessageId;
  // Prefer a stable provider ID anchor. If the anchor disappeared from the
  // current listing (delete/archive/move), restart the page from row 0. Persistence is idempotent,
  // so replaying the page is always safe; a fixed overlap cannot bound how many rows disappeared.
  let startIndex = resumeOffset;
  if (resumeMessageId) {
    const anchorIndex = rows.findIndex((row: any) => String(row?.id || "") === resumeMessageId);
    startIndex = anchorIndex >= 0 ? anchorIndex + 1 : 0;
  }
  for (let rowIndex = startIndex; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    if (ctx.deadlineAt !== undefined && ctx.now() >= ctx.deadlineAt) { interrupted = true; break; }
    if (!row?.id) { processedOffset = rowIndex + 1; continue; }
    let full: any;
    try { full = await gmailRequest(ctx, token, `/messages/${encodeURIComponent(String(row.id))}`, { format: "full" }); }
    catch (error) { if (error instanceof AdapterError && error.code === "sync_deadline") { interrupted = true; break; } throw error; }
    const payload = full.payload || {};
    const headers = headerMap(payload.headers || []);
    const labels: string[] = Array.isArray(full.labelIds) ? full.labelIds.map(String) : [label];
    const timestamp = Number(full.internalDate || 0);
    const when = timestamp > 0 ? new Date(timestamp).toISOString() : new Date(ctx.now()).toISOString();
    const parts: any[] = [];
    const collect = (part: any) => { if (!part) return; if (part.filename && part.body?.attachmentId) parts.push(part); for (const child of part.parts || []) collect(child); };
    collect(payload);
    const sender = parseAddress(headers.from || "");
    messages.push({
      provider_message_id: String(full.id), provider_thread_id: String(full.threadId || "") || null,
      rfc_message_id: headers["message-id"] || null, in_reply_to: headers["in-reply-to"] || null,
      references_ids: headers.references || null, direction: labels.includes("SENT") ? "outbound" : "inbound",
      from_email: sender.email || addresses(headers.from || "")[0] || "", from_name: sender.name || "",
      to_emails: addresses(headers.to || ""), cc_emails: addresses(headers.cc || ""), bcc_emails: addresses(headers.bcc || ""),
      reply_to: headers["reply-to"] || "", subject: headers.subject || "", body_text: gmailBody(payload, "text/plain"),
      body_html: gmailBody(payload, "text/html"), headers, is_read: !labels.includes("UNREAD"), folder_ids: labels,
      provider_updated_at: when, sent_at: labels.includes("SENT") ? when : null, received_at: labels.includes("SENT") ? null : when,
      attachments: parts.map((part) => ({ provider_attachment_id: String(part.body.attachmentId), filename: String(part.filename), content_type: String(part.mimeType || "application/octet-stream"), size_bytes: Number(part.body.size || 0), is_inline: String(part.headers?.find((h: any) => String(h.name).toLowerCase() === "content-disposition")?.value || "").toLowerCase().includes("inline") })),
      provider_metadata: { label_ids: labels, history_id: String(full.historyId || "") },
    });
    processedOffset = rowIndex + 1;
    processedMessageId = String(row.id);
  }
  const nextPageToken = typeof page.nextPageToken === "string" && page.nextPageToken ? page.nextPageToken : null;
  const nextCheckpoint = nextPageToken ? { folderIndex, pageToken: nextPageToken } : folderIndex === 0 ? { folderIndex: 1, pageToken: null } : { folderIndex: 0, pageToken: null };
  const hasMore = !!nextPageToken || folderIndex === 0;
  return interrupted
    ? { messages, next_checkpoint: processedOffset > resumeOffset || processedMessageId !== resumeMessageId ? { folderIndex, pageToken: activePageToken ?? null, offset: processedOffset, ...(processedMessageId ? { lastProcessedId: processedMessageId } : {}) } : checkpoint, has_more: true, complete: false, partial: true }
    : { messages, next_checkpoint: nextCheckpoint, has_more: hasMore, complete: !hasMore };
}

export const gmailAdapter: EmailAdapter = {
  providerKey: "gmail", adapterKey: "gmail", displayName: "Gmail", operations: ["send", "reply", "sync", "list_folders"], legacyFlagKey: null, defaultDailyLimit: 100,
  configurationProblem: () => null,
  async listFolders(ctx, account) {
    if (!ctx.getProviderAccessToken) throw new AdapterError("not_configured", "Gmail token gateway is unavailable", { provider: "gmail", operation: "list_folders" });
    const token = await ctx.getProviderAccessToken(account, "sync");
    const data = await gmailRequest(ctx, token, "/labels");
    return (data.labels || []).map((x: any) => ({ id: String(x.id), name: String(x.name || x.id), type: String(x.type || "system") }));
  },
  sync: syncGmail,
  async send(ctx: AdapterContext, account: AdapterAccount, input: AdapterSendInput): Promise<AdapterSendOutcome> {
    if (!ctx.getProviderAccessToken) return { ok: false, unknown: false, retryable: false, status: 503, message: "Gmail token gateway is unavailable", attempts: 0 };
    let token;
    try { token = await ctx.getProviderAccessToken(account, "send"); }
    catch { return { ok: false, unknown: false, retryable: false, status: 409, message: "Gmail account authorization is unavailable; check the connection in Settings", attempts: 0 }; }
    if (token.provider !== "gmail" || token.mailbox.toLowerCase() !== account.address.toLowerCase()) {
      return { ok: false, unknown: false, retryable: false, status: 409, message: "Connected Gmail identity does not match this Inbox account", attempts: 0 };
    }
    const messageId = `<${crypto.randomUUID()}@${account.address.split("@")[1] || "kairflow.local"}>`;
    let raw: string;
    try { raw = b64url(buildGmailMime(account, input, messageId)); }
    catch { return { ok: false, unknown: false, retryable: false, status: 422, message: "Gmail message content or headers are invalid", attempts: 0 }; }
    let response: Response;
    try {
      response = await ctx.fetch(`${API}/users/me/messages/send`, {
        method: "POST", headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ raw, ...(input.thread?.provider_thread_id ? { threadId: input.thread.provider_thread_id } : {}) }),
      });
    } catch { return { ok: false, unknown: true, retryable: false, status: 0, message: "Gmail delivery outcome is not yet confirmed", attempts: 1 }; }
    if (response.status === 429 || response.status >= 500) return { ok: false, unknown: true, retryable: false, status: response.status, message: "Gmail delivery outcome is not yet confirmed", attempts: 1 };
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, unknown: false, retryable: false, status: response.status || 502, message: "Gmail rejected the message", attempts: 1 };
    if (!data.id) return { ok: false, unknown: true, retryable: false, status: response.status || 200, message: "Gmail accepted a request but did not return a message identifier", attempts: 1 };
    return { ok: true, providerMessageId: String(data.id), rfcMessageId: messageId, providerThreadId: data.threadId ? String(data.threadId) : undefined, attempts: 1 };
  },
};
