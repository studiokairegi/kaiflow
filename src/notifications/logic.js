// src/notifications/logic.js
// Pure rules for the notification centre. No React, no Supabase: unit tested directly.
//
// A "notification" is an existing activity_log row of a supported type (we reuse the activity the
// app already writes; nothing is duplicated). Per-user read/snooze STATE lives separately
// (notification_state) and is merged in here.

export const SNOOZE_MS = 5 * 60 * 1000;

// Only event types the app really writes today (see the cut-review migration, the
// freelancer-drive-upload function and App.jsx). Studio-side events (cut_released, cut_withdrawn,
// review_approved/review_revisions, which the operator triggers) and informational ones
// (client_download_started) are deliberately NOT notifications.
export const NOTIFY_TYPES = {
  client_comment: { title: "Client left a comment", actor: "client" },
  client_revisions_requested: { title: "Client requested revisions", actor: "client" },
  client_approved: { title: "Client approved a cut", actor: "client" },
  freelancer_upload: { title: "Freelancer uploaded a file", actor: "freelancer" },
  cut_submitted: { title: "Freelancer submitted a cut", actor: "freelancer" },
};
export const FEED_EVENT_TYPES = Object.keys(NOTIFY_TYPES);

const toMs = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(n) ? n : null;
};
export { toMs };

/** activity_log row -> notification, or null if it isn't a supported, well-formed event. */
export function toNotification(row) {
  if (!row || row.id === undefined || row.id === null) return null;
  const type = String(row.event_type || "").trim().toLowerCase();
  const def = NOTIFY_TYPES[type];
  const createdMs = toMs(row.created_at);
  if (!def || createdMs === null) return null;
  return {
    id: String(row.id),
    type,
    title: def.title,
    actor: def.actor,
    projectId: row.project_id ?? null,
    shotId: row.shot_id ?? null,
    summary: String(row.description || ""),
    createdAt: row.created_at,
    createdMs,
    commentId: row.meta && row.meta.commentId ? String(row.meta.commentId) : null,
  };
}

/** notification_state row -> client state (timestamps as ms). */
export function toState(row) {
  return {
    readAt: toMs(row.read_at),
    openedAt: toMs(row.opened_at),
    snoozedUntil: toMs(row.snoozed_until),
    remindedUntil: toMs(row.reminded_until),
  };
}

/**
 * Merge two views of the same state. read only goes null -> value (first wins); opened, snooze and
 * reminder only move forward (latest wins), so merging is order-independent: a slow refresh can't undo a newer local
 * acknowledgement, and two tabs can't undo each other.
 */
export function mergeState(a, b) {
  const x = a || {}, y = b || {};
  const first = (p, q) => (p ?? q ?? null);
  const max = (p, q) => (p === null || p === undefined ? (q ?? null) : q === null || q === undefined ? p : Math.max(p, q));
  return {
    readAt: first(x.readAt, y.readAt),
    openedAt: max(x.openedAt, y.openedAt), // latest click-through wins (a new snooze cycle needs a newer one)
    snoozedUntil: max(x.snoozedUntil, y.snoozedUntil),
    remindedUntil: max(x.remindedUntil, y.remindedUntil),
  };
}

export const isUnread = (n, st, baselineMs) => n.createdMs > baselineMs && !(st && st.readAt);
export const isSnoozed = (st, nowMs) => !!(st && st.snoozedUntil && st.snoozedUntil > nowMs);
/** True if the user clicked the item after the current snooze began (snooze start = until - 5 min). */
export const openedSinceSnooze = (st) => !!(st && st.snoozedUntil && st.openedAt && st.openedAt >= st.snoozedUntil - SNOOZE_MS);
/** Snooze expired and the user has not opened the item since it was snoozed: needs attention again. */
export const reminderPending = (st, nowMs) => !!(st && st.snoozedUntil && st.snoozedUntil <= nowMs && !openedSinceSnooze(st));
/** The in-app reminder for the current snooze hasn't been shown yet. */
export const reminderToastDue = (st, nowMs) => reminderPending(st, nowMs) && st.remindedUntil !== st.snoozedUntil;
export const needsAttention = (n, st, baselineMs, nowMs) => isUnread(n, st, baselineMs) || reminderPending(st, nowMs);

/**
 * Ids acknowledged when the centre is opened: what is unread right now, minus anything under an
 * active snooze. Computed from a snapshot of the loaded feed, so an item that arrives after this
 * call is never in the list and stays unread.
 */
export function ackableIds(items, states, baselineMs, nowMs) {
  const out = [];
  for (const n of items) {
    const st = states.get(n.id);
    if (isUnread(n, st, baselineMs) && !isSnoozed(st, nowMs)) out.push(n.id);
  }
  return out;
}

/** Earliest future snooze expiry among unopened items (when to wake up and re-check), or null. */
export function nextWake(states, nowMs) {
  let best = null;
  for (const st of states.values()) {
    if (st.snoozedUntil && st.snoozedUntil > nowMs && !openedSinceSnooze(st) && (best === null || st.snoozedUntil < best)) best = st.snoozedUntil;
  }
  return best;
}

export const sortNewest = (items) =>
  [...items].sort((a, b) => b.createdMs - a.createdMs || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

/** Insert/replace by id so a fetch and a realtime delivery of the same event never duplicate. */
export function mergeById(map, incoming) {
  let added = 0;
  for (const n of incoming) {
    if (!map.has(n.id)) added++;
    map.set(n.id, { ...(map.get(n.id) || {}), ...n });
  }
  return added;
}

export const badgeLabel = (count) => (count > 99 ? "99+" : String(Math.max(0, count | 0)));

export function relativeTime(iso, nowMs = Date.now()) {
  const t = toMs(iso);
  if (t === null) return "";
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(t).toLocaleDateString();
}
