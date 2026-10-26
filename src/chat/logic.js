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
