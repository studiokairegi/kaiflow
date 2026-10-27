export const CHAT_PAGE_SIZE = 50;
export const MAX_MESSAGE_LENGTH = 10000;
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const ALLOWED_ATTACHMENT_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain",
  "application/zip", "video/mp4", "video/webm", "audio/mpeg", "audio/mp4", "audio/wav",
]);
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "👀"];

export function safeDisplayName(value, fallback = "Team member") {
  const normalized = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80);
  return normalized || fallback;
}

export function normalizeMessageBody(value) {
  return String(value ?? "").replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim();
}

export function validateMessage(body, files = []) {
  const value = normalizeMessageBody(body);
  if (value.length > MAX_MESSAGE_LENGTH) return { ok: false, error: `Messages must be ${MAX_MESSAGE_LENGTH.toLocaleString()} characters or fewer.` };
  if (!value && files.length === 0) return { ok: false, error: "Write a message or attach a file." };
  if (files.length > MAX_ATTACHMENTS) return { ok: false, error: `Attach up to ${MAX_ATTACHMENTS} files at a time.` };
  for (const file of files) {
    if (!file || !Number.isFinite(file.size) || file.size < 1 || file.size > MAX_ATTACHMENT_BYTES) {
      return { ok: false, error: "Each attachment must be smaller than 20 MB." };
    }
    if (!ALLOWED_ATTACHMENT_TYPES.has(String(file.type || "").toLowerCase())) {
      return { ok: false, error: `This file type is not supported: ${file.name || "unnamed file"}.` };
    }
  }
  return { ok: true, body: value };
}

export function conversationLabel(conversation, currentUserId, members = []) {
  if (!conversation) return "Conversation";
  if (conversation.kind === "group") return conversation.title || "Group conversation";
  if (conversation.kind === "project") return conversation.title || "Project conversation";
  const other = members.find((member) => member.user_id !== currentUserId && member.status === "active");
  return safeDisplayName(other?.display_name, conversation.title || "Direct message");
}

export function sortMessagesAscending(messages) {
  return [...(messages || [])].sort((a, b) => {
    const time = Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0);
    if (time) return time;
    return String(a.id).localeCompare(String(b.id));
  });
}

export function mergeMessages(existing, incoming) {
  const byId = new Map((existing || []).map((message) => [String(message.id), message]));
  for (const message of incoming || []) byId.set(String(message.id), { ...(byId.get(String(message.id)) || {}), ...message });
  return sortMessagesAscending([...byId.values()]);
}

export function unreadCountFromMessages(messages, currentUserId, lastReadAt, lastReadMessageId = null) {
  const cutoff = lastReadAt ? Date.parse(lastReadAt) : Number.NEGATIVE_INFINITY;
  return (messages || []).filter((message) => {
    if (message.sender_user_id === currentUserId || message.deleted_at) return false;
    const timestamp = Date.parse(message.created_at);
    if (timestamp > cutoff) return true;
    return timestamp === cutoff && (!lastReadMessageId || String(message.id) > String(lastReadMessageId));
  }).length;
}

export function safeObjectFileName(fileName) {
  const leaf = String(fileName || "attachment").split(/[\\/]/).pop() || "attachment";
  const safe = leaf.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 180);
  return !safe || /^\.+$/.test(safe) ? "attachment" : safe;
}

export function groupReactions(reactions = [], currentUserId) {
  const groups = new Map();
  for (const reaction of reactions) {
    const key = reaction.reaction;
    if (!groups.has(key)) groups.set(key, { reaction: key, count: 0, reactedByMe: false, users: [] });
    const group = groups.get(key);
    group.count += 1;
    group.reactedByMe ||= reaction.user_id === currentUserId;
    group.users.push(reaction.user_id);
  }
  return [...groups.values()].sort((a, b) => a.reaction.localeCompare(b.reaction));
}

export function formatChatTime(value, now = Date.now()) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "";
  const date = new Date(timestamp);
  const current = new Date(now);
  const sameDay = date.getFullYear() === current.getFullYear() && date.getMonth() === current.getMonth() && date.getDate() === current.getDate();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function messageCursor(message) {
  if (!message?.created_at || !message?.id) return null;
  return { created_at: message.created_at, id: message.id };
}

// ---------------------------------------------------------------------------------------------
// Message rendering. Bodies are untrusted plain text: they are parsed into a small block/inline
// tree that React renders as elements. Nothing is ever injected as HTML, and only http(s) links
// become anchors.
// ---------------------------------------------------------------------------------------------
const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

export function safeHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch { return null; }
}

function linkify(text) {
  const out = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    let raw = match[0];
    const trail = raw.match(TRAILING_PUNCTUATION)?.[0] || "";
    // Keep a closing bracket that belongs to the URL, e.g. https://x.test/a_(b)
    if (trail && raw.includes("(") && trail.startsWith(")")) raw = raw.slice(0, raw.length - trail.length + 1);
    else if (trail) raw = raw.slice(0, raw.length - trail.length);
    const href = safeHttpUrl(raw);
    if (!href) continue;
    if (match.index > last) out.push({ t: "text", v: text.slice(last, match.index) });
    out.push({ t: "link", v: raw, href });
    last = match.index + raw.length;
  }
  if (last < text.length) out.push({ t: "text", v: text.slice(last) });
  return out;
}

export function parseInline(text) {
  const tokens = [];
  const pattern = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|(?<![\w*])\*([^*\n]+)\*(?![\w*])|(?<![\w_])_([^_\n]+)_(?![\w_])/g;
  let last = 0;
  for (const match of String(text).matchAll(pattern)) {
    if (match.index > last) tokens.push(...linkify(text.slice(last, match.index)));
    if (match[1] !== undefined) tokens.push({ t: "code", v: match[1] });
    else if (match[2] !== undefined) tokens.push({ t: "bold", v: match[2] });
    else tokens.push({ t: "em", v: match[3] ?? match[4] });
    last = match.index + match[0].length;
  }
  if (last < text.length) tokens.push(...linkify(text.slice(last)));
  return tokens;
}

export function parseMessageBody(body) {
  const lines = String(body ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  let list = null;
  const flushParagraph = () => { if (paragraph.length) { blocks.push({ type: "p", lines: paragraph.map(parseInline) }); paragraph = []; } };
  const flushList = () => { if (list) { blocks.push(list); list = null; } };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flushParagraph(); flushList();
      const code = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i += 1; }
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }
    const bullet = line.match(/^\s{0,3}[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s{0,3}\d{1,3}[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushParagraph();
      const type = bullet ? "ul" : "ol";
      if (!list || list.type !== type) { flushList(); list = { type, items: [] }; }
      list.items.push(parseInline((bullet || numbered)[1]));
      continue;
    }
    flushList();
    if (line.trim() === "") { flushParagraph(); continue; }
    paragraph.push(line);
  }
  flushParagraph(); flushList();
  return blocks;
}

// Consecutive messages from one sender within four minutes on the same day share an avatar/name.
export function isGroupedWith(previous, message) {
  if (!previous || !message) return false;
  if (previous.sender_user_id !== message.sender_user_id) return false;
  const a = Date.parse(previous.created_at); const b = Date.parse(message.created_at);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b - a >= 4 * 60 * 1000 || b < a) return false;
  return new Date(a).toDateString() === new Date(b).toDateString();
}

export function composerHeight(scrollHeight, { min = 40, max = 160 } = {}) {
  const value = Number(scrollHeight);
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

export function isNearBottom({ scrollHeight, scrollTop, clientHeight }, threshold = 140) {
  return scrollHeight - scrollTop - clientHeight < threshold;
}

export function dayLabel(value, now = Date.now()) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "";
  const date = new Date(timestamp);
  const today = new Date(now);
  const yesterday = new Date(now); yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

export function chatErrorText(error) {
  const message = String(error?.message || "");
  if (/group_creation_not_permitted/i.test(message)) return "Creating groups isn't enabled for your account. Ask the studio owner to turn it on.";
  if (/target_not_visible|one_or_more_members_not_visible/i.test(message)) return "You can only add people you already chat with. Ask the studio owner for directory access to find others.";
  if (/not_authorized|permission denied|row-level security|42501/i.test(message)) return "You don't have permission to do that.";
  if (/account_not_found/i.test(message)) return "That email doesn't have a KairFlow login yet. The person must sign up first.";
  if (/target_not_chat_eligible/i.test(message)) return "That account isn't eligible for internal chat.";
  if (/project_access_required/i.test(message)) return "The person does not currently have permission to access this project.";
  if (/transfer_ownership_before_leaving/i.test(message)) return "Transfer group ownership to another active member before leaving.";
  if (/edit_window_expired/i.test(message)) return "Messages can only be edited for 15 minutes after sending.";
  if (/not_found_or_not_authorized|project_not_found/i.test(message)) return "That project is no longer available or you don't have access.";
  if (/rate_limited/i.test(message)) return "You're sending messages too quickly. Wait a moment and try again.";
  return message || "Something went wrong. Please try again.";
}
