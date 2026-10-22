// src/notifications/engine.js
// Stateful core of the notification centre. No React / Supabase imports: the network layer, clock
// and timers are injected, so every behaviour below is unit tested with fakes (no real waiting).
//
// Data flow: initial fetch (bounded pages) + realtime INSERTs + periodic/resume refresh all funnel
// through mergeById(), which dedupes by activity id. Persistent state (read/opened/snooze/reminded)
// comes from the server and is merged monotonically (see mergeState), so refreshes, other tabs and
// optimistic local updates can't overwrite each other.

import {
  SNOOZE_MS, toNotification, toState, mergeState, mergeById, sortNewest, ackableIds,
  isUnread, isSnoozed, reminderPending, reminderToastDue, needsAttention, nextWake,
} from "./logic.js";

export const DEFAULT_PAGE_SIZE = 20;
export const DEFAULT_REFRESH_MS = 60000;

export function createNotificationEngine({
  api, onChange = () => {}, now = Date.now, pageSize = DEFAULT_PAGE_SIZE, refreshMs = DEFAULT_REFRESH_MS,
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, setIntervalFn = setInterval, clearIntervalFn = clearInterval,
}) {
  let status = "loading"; // loading | ready | error
  let error = null;
  let baselineMs = null;
  let hasMore = false;
  let loadingMore = false;
  let disposed = false;
  let started = false;
  let unsubscribe = null;
  let wakeTimer = null;
  let interval = null;
  let initInFlight = null;
  let toast = null;
  let actionError = null;
  const items = new Map();
  const states = new Map();
  const buffer = []; // realtime rows that arrive before the baseline is known
  const oldestMs = () => (items.size ? Math.min(...[...items.values()].map((n) => n.createdMs)) : null);

  const emit = () => { if (!disposed) onChange(view()); };

  function view() {
    const t = now();
    const list = sortNewest([...items.values()]).map((n) => {
      const st = states.get(n.id) || null;
      return {
        ...n,
        unread: baselineMs !== null && isUnread(n, st, baselineMs),
        snoozed: isSnoozed(st, t),
        snoozedUntil: st ? st.snoozedUntil : null,
        reminder: reminderPending(st, t),
      };
    });
    const unreadCount = list.filter((n) => n.unread).length;
    const badgeCount = baselineMs === null ? 0 : list.filter((n) => needsAttention(n, states.get(n.id), baselineMs, t)).length;
    return { status, error, actionError, items: list, unreadCount, badgeCount, hasMore, loadingMore, toast };
  }

  // ---- loading -----------------------------------------------------------------------------
  async function loadStates(ids) {
    if (!ids.length) return;
    const rows = await api.fetchStates(ids);
    for (const r of rows || []) {
      const id = String(r.activity_id);
      if (items.has(id)) states.set(id, mergeState(states.get(id), toState(r)));
    }
  }

  async function loadBodies(list) {
    const need = list.filter((n) => n.type === "client_comment" && n.commentId && !n.body);
    if (!need.length || !api.fetchCommentBodies) return;
    try {
      const bodies = await api.fetchCommentBodies(need.map((n) => n.commentId)); // { commentId: text }
      for (const n of need) {
        const text = bodies && bodies[n.commentId];
        if (text && items.has(n.id)) items.get(n.id).body = String(text).slice(0, 280);
      }
    } catch { /* the description is still shown */ }
  }

  async function fetchFirstPage() {
    const rows = await api.fetchPage({ afterMs: baselineMs, beforeIso: null, limit: pageSize + 1 });
    const mapped = (rows || []).map(toNotification).filter(Boolean);
    const page = sortNewest(mapped).slice(0, pageSize);
    mergeById(items, page);
    hasMore = mapped.length > pageSize;
    await loadStates(page.map((n) => n.id));
    loadBodies(page).then(emit);
  }

  async function init() {
    try {
      baselineMs = await api.init();
      for (const row of buffer.splice(0)) applyRow(row, false);
      await fetchFirstPage();
      status = "ready"; error = null;
    } catch (e) {
      status = "error"; error = e instanceof Error ? e : new Error(String(e));
    }
    scheduleWake();
    checkReminders();
    emit();
  }

  const runInit = () => {
    if (!initInFlight) initInFlight = init().finally(() => { initInFlight = null; });
    return initInFlight;
  };

  /** Re-fetch the newest page + state: used for reconnects, resume and the periodic reconcile. */
  async function refresh() {
    if (disposed) return;
    if (initInFlight) await initInFlight;
    if (disposed) return;
    if (baselineMs === null) { // initial load never succeeded: retry it
      status = "loading"; emit();
      return runInit();
    }
    try {
      const rows = await api.fetchPage({ afterMs: baselineMs, beforeIso: null, limit: pageSize + 1 });
      const page = sortNewest((rows || []).map(toNotification).filter(Boolean)).slice(0, pageSize);
      mergeById(items, page);
      await loadStates([...items.keys()]);
      loadBodies(page).then(emit);
      status = "ready"; error = null;
    } catch (e) {
      if (status !== "ready") { status = "error"; error = e instanceof Error ? e : new Error(String(e)); }
    }
    scheduleWake();
    checkReminders();
    emit();
  }

  async function loadMore() {
    if (loadingMore || !hasMore || baselineMs === null) return;
    loadingMore = true; emit();
    try {
      const before = oldestMs();
      // The cursor is inclusive (so same-timestamp rows are never skipped), which re-fetches the rows
      // we already hold at that timestamp. Ask for that many extra so "is there more?" stays correct.
      const overlap = [...items.values()].filter((n) => n.createdMs === before).length;
      const rows = await api.fetchPage({ afterMs: baselineMs, beforeIso: new Date(before).toISOString(), limit: pageSize + 1 + overlap });
      const mapped = (rows || []).map(toNotification).filter(Boolean);
      const fresh = sortNewest(mapped).filter((n) => !items.has(n.id));
      const page = fresh.slice(0, pageSize);
      mergeById(items, page);
      hasMore = fresh.length > pageSize;
      await loadStates(page.map((n) => n.id));
      loadBodies(page).then(emit);
      actionError = null;
    } catch (e) {
      actionError = "Couldn't load older notifications. Try again.";
    }
    loadingMore = false; emit();
  }

  // ---- realtime ----------------------------------------------------------------------------
  function applyRow(row, notify = true) {
    const n = toNotification(row);
    if (!n) return;
    if (n.createdMs <= baselineMs) return; // older than first-run baseline
    const added = mergeById(items, [n]);
    if (added) loadBodies([items.get(n.id)]).then(emit);
    if (notify) emit();
  }

  function onRow(row) {
    if (disposed) return;
    if (baselineMs === null) { buffer.push(row); return; }
    applyRow(row);
  }

  function onStatus(s) {
    if (disposed) return;
    // On the first subscribe and after every reconnect, reconcile against persisted activity so
    // events that happened before the channel was live (or while it was down) still appear.
    if (s === "SUBSCRIBED") refresh();
  }

  // ---- acknowledgement ---------------------------------------------------------------------
  async function ackIds(ids, opened) {
    const t = now();
    const touched = [];
    for (const id of ids) {
      const prev = states.get(id) || null;
      const next = mergeState(prev, { readAt: t, openedAt: opened ? t : null });
      states.set(id, next);
      touched.push([id, prev]);
    }
    emit();
    try {
      for (let i = 0; i < ids.length; i += 200) await api.ack(ids.slice(i, i + 200), opened);
      actionError = null;
    } catch (e) {
      for (const [id, prev] of touched) { if (prev) states.set(id, prev); else states.delete(id); }
      actionError = "Couldn't save that. Your notifications are unchanged.";
    }
    scheduleWake();
    emit();
  }

  /** The centre was opened: acknowledge exactly what is unread (and not snoozed) right now. */
  async function open() {
    const ids = ackableIds([...items.values()], states, baselineMs ?? Infinity, now());
    if (ids.length) await ackIds(ids, false);
    return ids; // the UI keeps these highlighted for this visit
  }

  /** A single notification was clicked through. */
  async function openItem(id) {
    if (!items.has(id)) return;
    await ackIds([id], true);
  }

  async function snooze(id) {
    if (!items.has(id)) return null;
    try {
      const until = await api.snooze(id);
      if (!until) { actionError = "That item is no longer available."; emit(); return null; }
      const ms = typeof until === "number" ? until : Date.parse(until);
      states.set(id, mergeState(states.get(id), { snoozedUntil: ms })); // a new cycle: see openedSinceSnooze
      actionError = null;
    } catch (e) {
      actionError = "Couldn't snooze that. Try again.";
      emit();
      return null;
    }
    scheduleWake();
    emit();
    return states.get(id).snoozedUntil;
  }

  // ---- reminders ---------------------------------------------------------------------------
  function checkReminders() {
    const t = now();
    const due = [];
    for (const [id, st] of states) if (items.has(id) && reminderToastDue(st, t)) due.push(id);
    if (!due.length) return;
    // One aggregated reminder, never one per item, and each snooze cycle is reported once.
    toast = { count: due.length, ids: due, firstTitle: items.get(due[0]).title };
    for (const id of due) states.set(id, { ...states.get(id), remindedUntil: states.get(id).snoozedUntil });
    Promise.resolve(api.markReminded(due)).catch(() => {});
  }

  function dismissToast() { toast = null; emit(); }

  function scheduleWake() {
    clearTimeoutFn(wakeTimer);
    wakeTimer = null;
    if (disposed) return;
    const at = nextWake(states, now());
    if (at === null) return;
    wakeTimer = setTimeoutFn(() => {
      wakeTimer = null;
      checkReminders();
      scheduleWake();
      emit();
    }, Math.max(0, at - now()) + 50);
  }

  /** Tab became visible / window focused / device woke: timers may have been suspended. */
  function onResume() {
    if (disposed || !started) return;
    checkReminders(); // snooze expiries are persisted timestamps, so overdue ones are caught right now
    scheduleWake();
    emit();
    return refresh();
  }

  // ---- lifecycle ---------------------------------------------------------------------------
  function start() {
    if (started || disposed) return;
    started = true;
    unsubscribe = api.subscribe(onRow, onStatus);
    interval = setIntervalFn(() => { refresh(); }, refreshMs);
    return runInit();
  }

  function dispose() {
    disposed = true;
    clearTimeoutFn(wakeTimer);
    clearIntervalFn(interval);
    wakeTimer = null; interval = null;
    try { unsubscribe && unsubscribe(); } catch { /* ignore */ }
    unsubscribe = null;
  }

  return { start, dispose, refresh, loadMore, open, openItem, snooze, dismissToast, onResume, view, SNOOZE_MS };
}
