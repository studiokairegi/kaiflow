// Run: node --test src/notifications/logic.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  toNotification, toState, mergeState, isUnread, isSnoozed, reminderPending, reminderToastDue, ackableIds,
  nextWake, sortNewest, mergeById, badgeLabel, relativeTime, FEED_EVENT_TYPES, SNOOZE_MS,
} from "./logic.js";

const row = (o = {}) => ({ id: "a1", event_type: "client_comment", project_id: "p1", shot_id: "s1", description: "Sam commented", created_at: "2026-10-22T10:00:00Z", meta: { commentId: "c9" }, ...o });

test("only event types the app really writes become notifications", () => {
  assert.deepEqual([...FEED_EVENT_TYPES].sort(), ["client_approved", "client_comment", "client_revisions_requested", "cut_submitted", "freelancer_upload"]);
  for (const t of FEED_EVENT_TYPES) assert.ok(toNotification(row({ event_type: t })));
  for (const t of ["client_download_started", "cut_released", "cut_withdrawn", "review_approved", "review_revisions", "note", "made_up"]) {
    assert.equal(toNotification(row({ event_type: t })), null, t);
  }
});

test("toNotification maps fields, tolerates case, rejects malformed rows", () => {
  const n = toNotification(row({ event_type: " CLIENT_COMMENT ", id: 42 }));
  assert.equal(n.id, "42");
  assert.equal(n.actor, "client");
  assert.equal(n.commentId, "c9");
  assert.equal(toNotification(row({ created_at: "garbage" })), null);
  assert.equal(toNotification({ event_type: "client_comment" }), null);
  assert.equal(toNotification(null), null);
});

test("unread = newer than baseline and not read", () => {
  const n = toNotification(row());
  const base = Date.parse("2026-10-22T09:00:00Z");
  assert.equal(isUnread(n, null, base), true);
  assert.equal(isUnread(n, { readAt: 1 }, base), false);
  assert.equal(isUnread(n, null, Date.parse("2026-10-22T10:00:00Z")), false); // not strictly newer: history, not new
});

test("snooze + reminder rules", () => {
  const t0 = 1_000_000;
  const st = { snoozedUntil: t0 + SNOOZE_MS, openedAt: null, remindedUntil: null, readAt: null };
  assert.equal(isSnoozed(st, t0), true);
  assert.equal(reminderPending(st, t0), false);                       // active snooze: no reminder
  assert.equal(reminderPending(st, t0 + SNOOZE_MS), true);            // expired: pending
  assert.equal(reminderToastDue(st, t0 + SNOOZE_MS), true);
  assert.equal(reminderToastDue({ ...st, remindedUntil: st.snoozedUntil }, t0 + SNOOZE_MS), false); // shown once per snooze
  assert.equal(reminderPending({ ...st, openedAt: t0 + 1000 }, t0 + SNOOZE_MS), false);              // clicked through since snoozing
  assert.equal(reminderPending({ ...st, openedAt: t0 - 10 * SNOOZE_MS }, t0 + SNOOZE_MS), true);     // an old open doesn't count
});

test("mergeState is monotonic and order-independent", () => {
  const a = { readAt: null, openedAt: 5, snoozedUntil: 10, remindedUntil: null };
  const b = { readAt: 3, openedAt: 9, snoozedUntil: 7, remindedUntil: 10 };
  assert.deepEqual(mergeState(a, b), mergeState(b, a));
  assert.deepEqual(mergeState(a, b), { readAt: 3, openedAt: 9, snoozedUntil: 10, remindedUntil: 10 });
  assert.deepEqual(mergeState(undefined, undefined), { readAt: null, openedAt: null, snoozedUntil: null, remindedUntil: null });
});

test("ackableIds excludes read, history, and actively snoozed items", () => {
  const base = 100, t = 1000;
  const mk = (id, ms) => ({ id, createdMs: ms });
  const items = [mk("new", 500), mk("read", 500), mk("snoozed", 500), mk("old", 50)];
  const states = new Map([["read", { readAt: 1 }], ["snoozed", { snoozedUntil: t + 1 }]]);
  assert.deepEqual(ackableIds(items, states, base, t), ["new"]);
});

test("nextWake picks the earliest future unopened snooze", () => {
  const states = new Map([["a", { snoozedUntil: 500 }], ["b", { snoozedUntil: 300 }], ["c", { snoozedUntil: 100 }], ["d", { snoozedUntil: 200, openedAt: 150 }]]);
  assert.equal(nextWake(states, 150), 300);
  assert.equal(nextWake(new Map(), 0), null);
});

test("newest first, stable tie-break; mergeById dedupes", () => {
  const list = sortNewest([{ id: "a", createdMs: 1 }, { id: "c", createdMs: 3 }, { id: "b", createdMs: 3 }]);
  assert.deepEqual(list.map((n) => n.id), ["c", "b", "a"]);
  const m = new Map();
  assert.equal(mergeById(m, [{ id: "x", createdMs: 1 }]), 1);
  assert.equal(mergeById(m, [{ id: "x", createdMs: 1 }]), 0);
  assert.equal(m.size, 1);
});

test("badge label caps at 99+", () => {
  assert.equal(badgeLabel(0), "0");
  assert.equal(badgeLabel(99), "99");
  assert.equal(badgeLabel(100), "99+");
  assert.equal(badgeLabel(5000), "99+");
});

test("relative time", () => {
  const now = Date.parse("2026-10-22T12:00:00Z");
  assert.equal(relativeTime("2026-10-22T11:59:50Z", now), "just now");
  assert.equal(relativeTime("2026-10-22T11:55:00Z", now), "5 min ago");
  assert.equal(relativeTime("2026-10-22T09:00:00Z", now), "3 h ago");
  assert.equal(relativeTime("2026-10-20T12:00:00Z", now), "2 d ago");
  assert.equal(relativeTime("nope", now), "");
});

test("toState parses server timestamps", () => {
  assert.deepEqual(toState({ read_at: "2026-10-22T10:00:00Z", opened_at: null, snoozed_until: "2026-10-22T10:05:00Z", reminded_until: null }),
    { readAt: Date.parse("2026-10-22T10:00:00Z"), openedAt: null, snoozedUntil: Date.parse("2026-10-22T10:05:00Z"), remindedUntil: null });
});
