// Zoho Mail adapter for user-initiated central Inbox correspondence only.
// Credentials and regional OAuth/token refresh remain owned by Settings/Intelligence.
import type { AdapterAccount, AdapterContext, AdapterSendInput, AdapterSendOutcome, AdapterSyncPage, EmailAdapter } from "./email_adapter.ts";
import { htmlToText } from "./email_common.ts";
import { AdapterError } from "./email_adapter.ts";
import { parseAddress } from "./email_common.ts";

const safe = (v: string) => !/[\r\n\0]/.test(v);

const zohoAddresses = (value: unknown) => [...new Set((String(value || "").match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map((x) => x.toLowerCase()))];
const zohoDate = (value: unknown) => {
  const n = Number(value);
  const d = Number.isFinite(n) && n > 0 ? new Date(n) : new Date(String(value || ""));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
function parseZohoHeaders(raw: unknown): Record<string, string> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(" ") : String(v || "")]));
  const out: Record<string, string> = {};
  for (const match of String(raw || "").matchAll(/^([A-Za-z-]+):[ \t]*(.*(?:\r?\n[ \t].*)*)/gm)) out[match[1].toLowerCase()] = match[2].replace(/\s+/g, " ").trim();
  return out;
}
function isZohoDeadline(error: unknown, ctx: AdapterContext, timeoutWasBudgetBound: boolean): boolean {
  return (ctx.deadlineAt !== undefined && ctx.now() >= ctx.deadlineAt) ||
    (timeoutWasBudgetBound && error instanceof Error && error.name === "TimeoutError");
}
async function zohoRequest(ctx: AdapterContext, token: { access_token: string; api_base: string; external_account_id: string }, path: string, params?: Record<string, string>) {
  const remaining = (ctx.deadlineAt ?? Number.POSITIVE_INFINITY) - ctx.now();
  if (remaining <= 0) throw new AdapterError("sync_deadline", "Mailbox account time budget exhausted", { provider: "zoho", operation: "sync" });
  const url = new URL(`${token.api_base}/accounts/${encodeURIComponent(token.external_account_id)}${path}`);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const timeoutMs = Math.max(1, Math.min(20_000, remaining));
  const timeoutWasBudgetBound = remaining <= 20_000;
  let response: Response;
  try { response = await ctx.fetch(url.toString(), { headers: { Authorization: `Zoho-oauthtoken ${token.access_token}`, Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) }); }
  catch (error) {
    if (isZohoDeadline(error, ctx, timeoutWasBudgetBound)) throw new AdapterError("sync_deadline", "Mailbox account time budget exhausted", { provider: "zoho", operation: "sync" });
    throw error;
  }
  if (response.status === 429) throw new AdapterError("rate_limited", "Zoho mailbox is rate limited", { provider: "zoho", operation: "sync" });
  if (response.status >= 500) throw new AdapterError("provider_unavailable", "Zoho mailbox is temporarily unavailable", { provider: "zoho", operation: "sync" });
  if (!response.ok) throw new AdapterError(response.status === 401 ? "account_not_usable" : "provider_rejected", "Zoho mailbox request was rejected", { provider: "zoho", operation: "sync" });
  return await response.json();
}
async function zohoFolders(ctx: AdapterContext, token: { access_token: string; api_base: string; external_account_id: string }) {
  const data = await zohoRequest(ctx, token, "/folders");
  return (Array.isArray(data?.data) ? data.data : []).map((x: any) => ({
    id: String(x.folderId || ""), name: String(x.folderName || x.name || x.folderType || "Folder"),
    type: String(x.folderType || "").toLowerCase(),
  })).filter((x: any) => x.id && ["inbox", "sent"].includes(x.type));
}
async function syncZoho(ctx: AdapterContext, account: AdapterAccount, checkpoint: unknown): Promise<AdapterSyncPage> {
  if (!ctx.getProviderAccessToken) throw new AdapterError("not_configured", "Zoho token gateway is unavailable", { provider: "zoho", operation: "sync" });
  const token = await ctx.getProviderAccessToken(account, "sync");
  if (token.provider !== "zoho" || token.mailbox.toLowerCase() !== account.address.toLowerCase() || !token.external_account_id) throw new AdapterError("account_not_usable", "Connected Zoho identity does not match this Inbox account", { provider: "zoho", operation: "sync" });
  const cp = checkpoint && typeof checkpoint === "object" ? checkpoint as Record<string, unknown> : {};
  // An empty folder array is the terminal checkpoint emitted after the last folder.
  // Treat it as an expired checkpoint and rediscover folders on the next sync run.
  const folders = Array.isArray(cp.folders) && cp.folders.length > 0
    ? cp.folders as Array<{ id: string; name: string; type: string }>
    : await zohoFolders(ctx, token);
  if (!folders.length) throw new AdapterError("provider_rejected", "Zoho did not return Inbox and Sent folders", { provider: "zoho", operation: "sync" });
  const folderIndex = Math.max(0, Math.min(folders.length - 1, Number(cp.folderIndex || 0)));
  const folder = folders[folderIndex];
  const pageSize = 25;
  const start = Math.max(1, Number(cp.start || 1));
  const offset = Math.max(0, Math.min(pageSize, Number(cp.offset || 0)));
  const page = await zohoRequest(ctx, token, "/messages/view", { folderId: folder.id, limit: String(pageSize), start: String(start), sortBy: "date", sortorder: "false" });
  const rows = Array.isArray(page?.data) ? page.data : [];
  const messages: AdapterSyncPage["messages"] = [];
  let interrupted = false;
  let processedOffset = offset;
  let processedMessageId = typeof cp.lastProcessedId === "string" ? cp.lastProcessedId : undefined;
  // Anchor resume to a provider message ID where possible. If the anchor was
  // deleted/moved since the previous run, restart the page from row 0 (idempotent replay).
  let startIndex = offset;
  if (processedMessageId) {
    const anchorIndex = rows.findIndex((row: any) => String(row?.messageId || "") === processedMessageId);
    startIndex = anchorIndex >= 0 ? anchorIndex + 1 : 0;
  }
  for (let rowIndex = startIndex; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    if (ctx.deadlineAt !== undefined && ctx.now() >= ctx.deadlineAt) { interrupted = true; break; }
    if (!row?.messageId) { processedOffset = rowIndex + 1; continue; }
    const id = String(row.messageId);
    let contentResult: any;
    try { contentResult = await zohoRequest(ctx, token, `/folders/${encodeURIComponent(folder.id)}/messages/${encodeURIComponent(id)}/content`); }
    catch (error) { if (error instanceof AdapterError && error.code === "sync_deadline") { interrupted = true; break; } throw error; }
    let headerResult: any = null;
    try { headerResult = await zohoRequest(ctx, token, `/folders/${encodeURIComponent(folder.id)}/messages/${encodeURIComponent(id)}/header`); }
    catch (error) { if (error instanceof AdapterError && error.code === "sync_deadline") { interrupted = true; break; } }
    const content = String(contentResult?.data?.content || "");
    const headers = parseZohoHeaders(headerResult?.data?.headerContent || headerResult?.data?.content || "");
    const timestamp = zohoDate(row.receivedTime || row.sentDateInGMT || row.date);
    const outbound = folder.type === "sent";
    const readValue = typeof row.isRead === "boolean" ? row.isRead : typeof row.is_read === "boolean" ? row.is_read : true;
    const attachmentRows = Array.isArray(row.attachments) ? row.attachments : Array.isArray(row.attachmentDetails) ? row.attachmentDetails : [];
    const sender = parseAddress(row.fromAddress || row.sender || headers.from || "");
    messages.push({
      provider_message_id: id, provider_thread_id: String(row.threadId || "") || null,
      rfc_message_id: headers["message-id"] || null, in_reply_to: headers["in-reply-to"] || null, references_ids: headers.references || null,
      direction: outbound ? "outbound" : "inbound", from_email: sender.email || zohoAddresses(row.fromAddress || row.sender || headers.from)[0] || "",
      from_name: sender.name || "", to_emails: zohoAddresses(row.toAddress || headers.to),
      cc_emails: zohoAddresses(row.ccAddress || headers.cc), bcc_emails: zohoAddresses(row.bccAddress || headers.bcc),
      reply_to: headers["reply-to"] || "", subject: String(row.subject || headers.subject || ""),
      body_text: htmlToText(content).slice(0, 20000), body_html: content, headers, is_read: readValue, folder_ids: [folder.id],
      provider_updated_at: timestamp, sent_at: outbound ? timestamp : null, received_at: outbound ? null : timestamp,
      attachments: attachmentRows.map((a: any) => ({ provider_attachment_id: String(a.attachmentId || a.attachmentID || ""), filename: String(a.attachmentName || a.fileName || "attachment"), content_type: String(a.contentType || "application/octet-stream"), size_bytes: Number(a.size || a.attachmentSize || 0), is_inline: a.isInline === true })).filter((a: any) => a.provider_attachment_id),
      provider_metadata: { folder_type: folder.type, read_state_reported: typeof row.isRead === "boolean" || typeof row.is_read === "boolean" },
    });
    processedOffset = rowIndex + 1;
    processedMessageId = id;
  }
  const hasMoreInFolder = rows.length >= pageSize;
  const nextCheckpoint = hasMoreInFolder
    ? { folders, folderIndex, start: start + Math.max(1, rows.length - 5) }
    : folderIndex + 1 < folders.length ? { folders, folderIndex: folderIndex + 1, start: 1 } : { folders: [], folderIndex: 0, start: 1 };
  const hasMore = hasMoreInFolder || folderIndex + 1 < folders.length;
  return interrupted
    ? { messages, next_checkpoint: processedOffset > offset || processedMessageId !== (typeof cp.lastProcessedId === "string" ? cp.lastProcessedId : undefined) ? { folders, folderIndex, start, offset: processedOffset, ...(processedMessageId ? { lastProcessedId: processedMessageId } : {}) } : checkpoint, has_more: true, complete: false, partial: true }
    : { messages, next_checkpoint: nextCheckpoint, has_more: hasMore, complete: !hasMore };
}

export const zohoAdapter: EmailAdapter = {
  providerKey: "zoho", adapterKey: "zoho", displayName: "Zoho Mail", operations: ["send", "reply", "sync", "list_folders"], legacyFlagKey: null, defaultDailyLimit: 50,
  configurationProblem: () => null,
  async listFolders(ctx, account) {
    if (!ctx.getProviderAccessToken) throw new AdapterError("not_configured", "Zoho token gateway is unavailable", { provider: "zoho", operation: "list_folders" });
    const token = await ctx.getProviderAccessToken(account, "sync");
    return await zohoFolders(ctx, token);
  },
  sync: syncZoho,
  async send(ctx: AdapterContext, account: AdapterAccount, input: AdapterSendInput): Promise<AdapterSendOutcome> {
    if (!ctx.getProviderAccessToken) return { ok: false, unknown: false, retryable: false, status: 503, message: "Zoho token gateway is unavailable", attempts: 0 };
    if (input.attachments.length) return { ok: false, unknown: false, retryable: false, status: 501, message: "Zoho attachment sending is not enabled for the central Inbox yet", attempts: 0 };
    if (![input.fromEmail, input.subject, ...input.to, ...input.cc, ...input.bcc].every(safe)) {
      return { ok: false, unknown: false, retryable: false, status: 422, message: "Email headers contain an invalid line break", attempts: 0 };
    }
    let token;
    try { token = await ctx.getProviderAccessToken(account, "send"); }
    catch { return { ok: false, unknown: false, retryable: false, status: 409, message: "Zoho account authorization is unavailable; check the connection in Settings", attempts: 0 }; }
    if (token.provider !== "zoho" || token.mailbox.toLowerCase() !== account.address.toLowerCase() || !token.external_account_id) {
      return { ok: false, unknown: false, retryable: false, status: 409, message: "Connected Zoho identity does not match this Inbox account", attempts: 0 };
    }
    const payload: Record<string, unknown> = {
      fromAddress: input.fromEmail, toAddress: input.to.join(","), subject: input.subject,
      content: input.html || input.text, mailFormat: input.html ? "html" : "plaintext", askReceipt: "no",
    };
    if (input.cc.length) payload.ccAddress = input.cc.join(",");
    if (input.bcc.length) payload.bccAddress = input.bcc.join(",");
    if (input.replyTo) payload.replyTo = input.replyTo;
    const parent = input.thread?.provider_message_id;
    if (input.thread?.parent_direction === "outbound") {
      return { ok: false, unknown: false, retryable: false, status: 409, message: "Zoho cannot safely reply to an outbound parent; start a new correspondence instead", attempts: 0 };
    }
    if (input.thread && !parent) {
      return { ok: false, unknown: false, retryable: false, status: 409, message: "Zoho cannot safely reply because the original provider message is unavailable", attempts: 0 };
    }
    const path = parent ? `/accounts/${encodeURIComponent(token.external_account_id)}/messages/${encodeURIComponent(parent)}` : `/accounts/${encodeURIComponent(token.external_account_id)}/messages`;
    let response: Response;
    try {
      response = await ctx.fetch(`${token.api_base}${path}`, {
        method: "POST", headers: { Authorization: `Zoho-oauthtoken ${token.access_token}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(parent ? { ...payload, action: "reply" } : payload),
      });
    } catch { return { ok: false, unknown: true, retryable: false, status: 0, message: "Zoho delivery outcome is not yet confirmed", attempts: 1 }; }
    if (response.status === 429 || response.status >= 500) return { ok: false, unknown: true, retryable: false, status: response.status, message: "Zoho delivery outcome is not yet confirmed", attempts: 1 };
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, unknown: false, retryable: false, status: response.status || 502, message: "Zoho rejected the message", attempts: 1 };
    const row = data?.data || {};
    if (!row.messageId) return { ok: false, unknown: true, retryable: false, status: response.status || 200, message: "Zoho accepted a request but did not return a message identifier", attempts: 1 };
    return { ok: true, providerMessageId: String(row.messageId), providerThreadId: row.threadId ? String(row.threadId) : undefined, attempts: 1 };
  },
};
