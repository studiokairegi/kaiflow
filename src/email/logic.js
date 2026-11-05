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

/** Who a reply goes to. Reply: the sender (or, for our own message, the people we wrote to). Reply all adds everyone else except us. */
export function replyRecipients(message, ownAddresses, { all = false } = {}) {
  const own = new Set((ownAddresses || []).map(lc));
  const inbound = message.direction === "inbound";
  const primary = inbound ? [lc(message.reply_to_address || message.from_email)] : (message.to_emails || []).map(lc);
  const to = primary.filter((a) => a && !own.has(a));
  const cc = all ? [...(message.to_emails || []), ...(message.cc_emails || [])].map(lc).filter((a) => a && !own.has(a) && !to.includes(a)) : [];
  return { to: [...new Set(to)], cc: [...new Set(cc)] };
}

export const quoteBody = (message, when) => {
  const who = message.from_name ? `${message.from_name} <${message.from_email}>` : message.from_email;
  const quoted = String(message.body_text || "").split("\n").map((l) => `> ${l}`).join("\n");
  return `\n\nOn ${when || ""}, ${who} wrote:\n${quoted}`;
};

export function buildReply(message, ownAddresses, { all = false, when = "" } = {}) {
  const { to, cc } = replyRecipients(message, ownAddresses, { all });
  return { to: to.join(", "), cc: cc.join(", "), subject: replySubject(message.subject), body: "" };
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

/** Providers the Settings screen may offer: only those the database flag turned on. Anything unknown or still loading counts as paused. */
export function activeMailProviders(flags, all) {
  return Object.entries(all).filter(([key]) => flags && flags[key] === true);
}
