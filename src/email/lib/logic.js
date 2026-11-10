// KairFlow Email (Resend): pure helpers for the Inbox screen. No network, no React, so they are unit tested.

export const FOLDERS = Object.freeze([["inbox", "Inbox"], ["unread", "Unread"], ["sent", "Sent"], ["drafts", "Drafts"], ["archived", "Archived"]]);

const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
export const isEmail = (s) => typeof s === "string" && s.length <= 254 && EMAIL_RE.test(s.trim());

/** "a@x.com, B <b@y.com>; c@z.com" -> { valid: [...lower-cased addresses], invalid: [...as typed] } (duplicates removed). */
export function parseRecipients(text) {
  const valid = [], invalid = [];
  for (const raw of String(text || "").split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean)) {
    const m = /<([^<>]+)>\s*$/.exec(raw);
    const addr = (m ? m[1] : raw).trim().toLowerCase();
    if (!isEmail(addr)) invalid.push(raw);
    else if (!valid.includes(addr)) valid.push(addr);
  }
  return { valid, invalid };
}

export const normalizeSubject = (s) => {
  let out = String(s || "").trim();
  const re = /^\s*(re|fwd?|aw|sv|vs|rv|antw)(\[\d+\])?\s*:\s*/i;
  for (let i = 0; i < 10 && re.test(out); i++) out = out.replace(re, "");
  return out.replace(/\s+/g, " ").trim().toLowerCase();
};
export const replySubject = (s) => (/^\s*re\s*:/i.test(s || "") ? s : `Re: ${s || ""}`.trim());
export const forwardSubject = (s) => (/^\s*fwd?\s*:/i.test(s || "") ? s : `Fwd: ${s || ""}`.trim());

const lc = (x) => String(x || "").toLowerCase();

/** Who a reply goes to: the sender (or, for our own message, the people we wrote to). Never ourselves. */
export function replyRecipients(message, ownAddresses) {
  const own = new Set((ownAddresses || []).map(lc));
  const inbound = message.direction === "inbound";
  // Inbound records persist Reply-To as a text header (possibly a display-name
  // address list), not as reply_to_address. Prefer it when valid, then fall back
  // to From. Outbound messages reply to their original To recipients.
  const replyTo = inbound ? String(message.reply_to || message.reply_to_address || "") : "";
  const replyToAddresses = replyTo.match(/[A-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+/gi) || [];
  const primary = inbound
    ? (replyToAddresses.length ? replyToAddresses : [message.from_email]).map(lc)
    : (message.to_emails || []).map(lc);
  const to = primary.filter((a) => a && !own.has(a));
  return { to: [...new Set(to)] };
}

export const quoteBody = (message, when) => {
  const who = message.from_name ? `${message.from_name} <${message.from_email}>` : message.from_email;
  const quoted = String(message.body_text || "").split("\n").map((l) => `> ${l}`).join("\n");
  return `\n\nOn ${when || ""}, ${who} wrote:\n${quoted}`;
};

/** What the inline reply box sends: recipients and "Re:" subject come from the thread, the user only types the message. */
export function inlineReply(messages, ownAddresses, { subject = "", participants = [] } = {}) {
  const own = new Set((ownAddresses || []).map(lc));
  const last = [...(messages || [])].reverse().find((m) => m.status !== "draft");
  let to = last ? replyRecipients(last, ownAddresses).to : [];
  if (last && !to.length) to = [...new Set((participants || []).map((p) => lc(p.email)).filter((a) => a && !own.has(a)))];
  return { to, subject: replySubject(subject || last?.subject || "") };
}

export function buildForward(message, when = "") {
  const head = ["---------- Forwarded message ----------", `From: ${message.from_name ? `${message.from_name} <${message.from_email}>` : message.from_email}`, `Date: ${when}`, `Subject: ${message.subject || ""}`, `To: ${(message.to_emails || []).join(", ")}`].join("\n");
  return { to: "", cc: "", subject: forwardSubject(message.subject), body: `\n\n${head}\n\n${message.body_text || ""}` };
}

/** The other people in a conversation (not our own addresses), for the list row. */
export function participantLabel(conversation, ownAddresses) {
  const own = new Set((ownAddresses || []).map(lc));
  const others = (conversation.participants || []).filter((p) => !own.has(lc(p.email)));
  if (!others.length) return "(no recipients yet)";
  const names = others.slice(0, 2).map((p) => p.name || p.email);
  return names.join(", ") + (others.length > 2 ? ` +${others.length - 2}` : "");
}

export const STATUS_LABELS = Object.freeze({
  draft: ["Draft", "muted"], queued: ["Queued", "muted"], sending: ["Sending", "warn"], sent: ["Sent", "ok"], delivery_delayed: ["Delayed", "warn"],
  delivered: ["Delivered", "ok"], bounced: ["Bounced", "bad"], complained: ["Marked as spam", "bad"], failed: ["Failed", "bad"], rejected: ["Rejected", "bad"], received: ["Received", "muted"],
});
export const statusLabel = (status) => STATUS_LABELS[status] || [String(status || ""), "muted"];
/** Only a message that did not go out can be retried by writing a new one; nothing is resent automatically. */
export const isProblem = (status) => ["bounced", "complained", "failed", "rejected"].includes(status);

export const fmtSize = (bytes) => {
  const n = Number(bytes) || 0;
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
};

const escapeHtml = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Plain text typed in the composer -> simple HTML (escaped, line breaks kept). */
export const textToHtml = (text) => `<div style="white-space:pre-wrap;font-family:inherit">${escapeHtml(text)}</div>`;

export const MAX_ATTACHMENT_TOTAL = 10 * 1024 * 1024;
export function attachmentProblem(files) {
  const list = Array.from(files || []);
  if (list.length > 10) return "Attach at most 10 files.";
  if (list.reduce((n, f) => n + (f.size || 0), 0) > MAX_ATTACHMENT_TOTAL) return "Attachments are over 10 MB in total.";
  return "";
}

/** One-line reason a send cannot start, or "" when it can. */
export function composeProblem({ accountId, to, cc, bcc, subject, body }) {
  if (!accountId) return "Choose a sender address.";
  const lists = { To: parseRecipients(to), Cc: parseRecipients(cc), Bcc: parseRecipients(bcc) };
  for (const [label, r] of Object.entries(lists)) if (r.invalid.length) return `${label}: "${r.invalid[0]}" is not a valid email address.`;
  if (!lists.To.valid.length) return "Add at least one recipient.";
  if (!String(subject || "").trim()) return "Add a subject.";
  if (!String(body || "").trim()) return "Write a message.";
  return "";
}

/** Provider catalog is authoritative: only enabled registry rows with a real send capability can be selected. */
export function availableMailProviders(providers) {
  return (Array.isArray(providers) ? providers : []).filter((p) => p && p.enabled === true && p.capabilities?.send === true);
}

export function providerForAccount(account, providers) {
  return (providers || []).find((p) => p.provider_key === account?.provider) || null;
}

/** Resend-style address providers do not use OAuth; OAuth providers must have a live connection. */
export function accountCanSend(account, providers) {
  if (!account || account.status !== "active") return false;
  const provider = providerForAccount(account, providers);
  if (!provider || provider.enabled !== true || provider.capabilities?.send !== true) return false;
  return provider.capabilities?.oauth === true ? account.connection_status === "connected" : true;
}

export function accountConnectionLabel(account, providers) {
  if (!account) return "Unavailable";
  if (account.status !== "active") return "Paused";
  const provider = providerForAccount(account, providers);
  if (!provider || provider.enabled !== true) return "Provider unavailable";
  if (provider.capabilities?.oauth === true) {
    const labels = { not_connected: "Not connected", connecting: "Connecting", connected: "Connected", reauthorization_required: "Reauthorization required", disconnected: "Disconnected", error: "Connection error" };
    return labels[account.connection_status] || "Connection status unknown";
  }
  return "Sending address configured";
}

/** Never trust cached provider rows after a registry refresh fails. */
export function trustedProviderRows(data, error) {
  return error ? [] : (Array.isArray(data) ? data : []);
}

/** Distinguishes a successfully empty account list from a failed account request. */
export function accountListView({ loading, error, data }) {
  if (loading) return "loading";
  if (error) return "error";
  return Array.isArray(data) && data.length ? "ready" : "empty";
}

/** Providers the Settings screen may offer: only those the database flag turned on. Anything unknown or still loading counts as paused. */
export function activeMailProviders(flags, all) {
  return Object.entries(all).filter(([key]) => flags && flags[key] === true);
}

/** How many new unread emails arrived between two polls. The first poll (prev == null) only sets the baseline, so opening the app is silent. */
export function newArrivals(prev, next) {
  if (prev == null) return 0;
  return Math.max(0, (Number(next) || 0) - (Number(prev) || 0));
}
