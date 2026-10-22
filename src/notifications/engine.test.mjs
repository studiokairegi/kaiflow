// Run: node --test src/notifications/engine.test.mjs
// The engine is driven with a fake server (in-memory activity + per-user state) and fake timers,
// so nothing waits in real time.
import test from "node:test";
import assert from "node:assert/strict";
import { createNotificationEngine } from "./engine.js";
import { SNOOZE_MS, FEED_EVENT_TYPES } from "./logic.js";

const T0 = Date.parse("2026-10-22T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

function world({ baseline = T0 - 60_000, pageSize = 20, failInit = false } = {}) {
  const clock = { t: T0 };
  const rows = [];                // this user's activity_log rows (RLS already applied server-side)
  const stateDb = new Map();      // activity_id -> row
  const calls = { ack: [], snooze: [], reminded: [], fetchPage: 0, subscribe: 0, unsub: 0 };
  let onRow = null, onStatus = null;
  let ackGate = null;
  let failNextAck = false, failFetch = false, initFails = failInit;

  const api = {
    init: async () => { if (initFails) throw new Error("init down"); return baseline; },
    fetchPage: async ({ afterMs, beforeIso, limit }) => {
      calls.fetchPage++;
      if (failFetch) throw new Error("network");
      return rows
        .filter((r) => FEED_EVENT_TYPES.includes(r.event_type) && Date.parse(r.created_at) > afterMs && (!beforeIso || Date.parse(r.created_at) <= Date.parse(beforeIso)))
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || (a.id < b.id ? 1 : -1))
        .slice(0, limit).map((r) => ({ ...r }));
    },
    fetchStates: async (ids) => ids.filter((i) => stateDb.has(i)).map((i) => ({ ...stateDb.get(i) })),
    ack: async (ids, opened) => {
      calls.ack.push({ ids: [...ids], opened });
      if (ackGate) await ackGate;
      if (failNextAck) { failNextAck = false; throw new Error("ack failed"); }
      for (const id of ids) {
        const cur = stateDb.get(id) || { activity_id: id };
        stateDb.set(id, { ...cur, read_at: cur.read_at || iso(clock.t), opened_at: opened ? iso(clock.t) : cur.opened_at || null });
      }
    },
    snooze: async (id) => {
      calls.snooze.push(id);
      if (!rows.some((r) => String(r.id) === id)) return null;
      const until = iso(clock.t + SNOOZE_MS);
      stateDb.set(id, { ...(stateDb.get(id) || { activity_id: id }), snoozed_until: until });
      return until;
    },
    markReminded: async (ids) => {
      calls.reminded.push([...ids]);
      for (const id of ids) { const s = stateDb.get(id); if (s) s.reminded_until = s.snoozed_until; }
    },
    fetchCommentBodies: async (ids) => Object.fromEntries(ids.map((i) => [i, "Please fix the colour grade at 0:42"])),
    subscribe: (r, s) => { calls.subscribe++; onRow = r; onStatus = s; return () => { calls.unsub++; onRow = null; }; },
  };

  // fake timers
  const timers = new Map(); let tid = 0;
  const setTimeoutFn = (f, ms) => { timers.set(++tid, { f, at: clock.t + ms }); return tid; };
  const clearTimeoutFn = (i) => timers.delete(i);
  const intervals = new Map();
  const setIntervalFn = (f, ms) => { intervals.set(++tid, { f, ms }); return tid; };
  const clearIntervalFn = (i) => intervals.delete(i);
  const advance = async (ms) => {
    const end = clock.t + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); clock.t = Math.max(clock.t, due[1].at); due[1].f();
      await tick();
    }
    clock.t = end;
  };

  const emits = [];
  const make = () => createNotificationEngine({ api, now: () => clock.t, pageSize, onChange: (v) => emits.push(v), setTimeoutFn, clearTimeoutFn, setIntervalFn, clearIntervalFn });
  let seq = 0;
  const add = (type, ageMs, extra = {}) => {
    const r = { id: `a${++seq}`, event_type: type, project_id: "p1", shot_id: "s1", description: `${type} happened`, created_at: iso(clock.t - ageMs), meta: {}, ...extra };
    rows.push(r); return r;
  };
  return {
    clock, rows, stateDb, calls, api, timers, intervals, advance, emits, make, add,
    push: (r) => onRow && onRow(r), status: (s) => onStatus && onStatus(s),
    gateAck: () => { let go; ackGate = new Promise((r) => { go = r; }); return () => { ackGate = null; go(); }; },
    failNextAck: () => { failNextAck = true; },
    setFetchFail: (v) => { failFetch = v; },
    setInitFail: (v) => { initFails = v; },
  };
}
const tick = () => new Promise((r) => setImmediate(r));
const ids = (v) => v.items.map((n) => n.id);

test("client and freelancer events appear newest first; unsupported types and pre-baseline history do not", async () => {
  const w = world();
  w.add("client_comment", 5000); w.add("freelancer_upload", 4000); w.add("cut_submitted", 3000);
  w.add("client_revisions_requested", 2000); w.add("client_approved", 1000);
  w.add("client_download_started", 500);                       // informational: not a notification
  w.add("client_comment", 10 * 24 * 3600 * 1000);              // years-old history: before baseline
  const e = w.make(); await e.start();
  const v = e.view();
  assert.equal(v.status, "ready");
  assert.deepEqual(v.items.map((n) => n.type), ["client_approved", "client_revisions_requested", "cut_submitted", "freelancer_upload", "client_comment"]);
  assert.equal(v.badgeCount, 5);
  assert.ok(v.items.every((n) => n.unread));
  e.dispose();
});

test("first run does not flood: nothing before the baseline is unread", async () => {
  const w = world();
  for (let i = 0; i < 50; i++) w.add("client_comment", 3600_000 * (i + 2));
  const e = w.make(); await e.start();
  assert.equal(e.view().badgeCount, 0);
  assert.equal(e.view().items.length, 0);
  e.dispose();
});

test("opening the centre acknowledges exactly the visible unread items and keeps them in the feed", async () => {
  const w = world();
  const a = w.add("client_comment", 3000), b = w.add("freelancer_upload", 2000);
  const e = w.make(); await e.start();
  const acked = await e.open();
  assert.deepEqual(new Set(acked), new Set([a.id, b.id]));
  assert.deepEqual(w.calls.ack, [{ ids: acked, opened: false }]);
  const v = e.view();
  assert.equal(v.badgeCount, 0);
  assert.equal(v.items.length, 2);               // not deleted
  assert.ok(v.items.every((n) => !n.unread));
  e.dispose();
});

test("an event that arrives after the centre opened is not marked read by the earlier bulk ack", async () => {
  const w = world();
  w.add("client_comment", 3000);
  const e = w.make(); await e.start();
  await e.open();
  const late = w.add("client_approved", 0);
  w.push(late);
  assert.equal(e.view().badgeCount, 1);
  assert.equal(e.view().items.find((n) => n.id === late.id).unread, true);
  const second = await e.open();                  // reopening acknowledges only the new one
  assert.deepEqual(second, [late.id]);
  e.dispose();
});

test("an event that arrives WHILE the ack request is still in flight stays unread", async () => {
  const w = world();
  const first = w.add("client_comment", 3000);
  const e = w.make(); await e.start();
  const release = w.gateAck();
  const opening = e.open();
  await tick();
  const late = w.add("freelancer_upload", 0);
  w.push(late);
  release(); await opening;
  assert.deepEqual(w.calls.ack[0].ids, [first.id]);
  assert.equal(e.view().items.find((n) => n.id === late.id).unread, true);
  assert.equal(e.view().badgeCount, 1);
  e.dispose();
});

test("realtime + initial fetch + refresh deliver the same event once", async () => {
  const w = world();
  const r = w.add("client_comment", 1000);
  const e = w.make(); await e.start();
  w.push(r); w.push(r);
  await e.refresh(); await e.refresh();
  assert.deepEqual(ids(e.view()), [r.id]);
  e.dispose();
});

test("realtime rows that are unsupported or older than the baseline are ignored", async () => {
  const w = world();
  const e = w.make(); await e.start();
  w.push({ id: "x1", event_type: "client_download_started", created_at: iso(w.clock.t), project_id: "p", shot_id: "s", description: "d" });
  w.push({ id: "x2", event_type: "client_comment", created_at: iso(w.clock.t - 99_999_999), project_id: "p", shot_id: "s", description: "d" });
  assert.equal(e.view().items.length, 0);
  e.dispose();
});

test("realtime rows delivered before the initial load finishes are buffered, not lost", async () => {
  const w = world();
  const e = w.make();
  const starting = e.start();
  const r = w.add("client_approved", 0);
  w.push(r);                                     // arrives while init() is still awaiting
  await starting;
  assert.deepEqual(ids(e.view()), [r.id]);
  e.dispose();
});

test("client comment text is shown as the summary when it can be read", async () => {
  const w = world();
  w.add("client_comment", 1000, { meta: { commentId: "c1" } });
  const e = w.make(); await e.start(); await tick();
  assert.match(e.view().items[0].body, /colour grade/);
  e.dispose();
});

test("clicking through an item acknowledges it individually with opened=true", async () => {
  const w = world();
  const a = w.add("client_comment", 3000); w.add("freelancer_upload", 2000);
  const e = w.make(); await e.start();
  await e.openItem(a.id);
  assert.deepEqual(w.calls.ack, [{ ids: [a.id], opened: true }]);
  assert.equal(e.view().badgeCount, 1);
  e.dispose();
});

test("a failed acknowledgement reverts and reports, so the notification isn't silently lost", async () => {
  const w = world();
  w.add("client_comment", 3000);
  const e = w.make(); await e.start();
  w.failNextAck();
  await e.open();
  assert.equal(e.view().badgeCount, 1);
  assert.match(e.view().actionError, /unchanged/);
  e.dispose();
});

test("snooze: five minutes, keeps read/unread, no reminder while active, one reminder after expiry", async () => {
  const w = world();
  const a = w.add("client_comment", 3000);
  const e = w.make(); await e.start();
  const until = await e.snooze(a.id);
  assert.equal(until, T0 + SNOOZE_MS);
  let v = e.view();
  assert.equal(v.items[0].snoozed, true);
  assert.equal(v.items[0].unread, true);          // snooze did not acknowledge it
  assert.equal(v.items.length, 1);                // and did not delete it
  await w.advance(SNOOZE_MS - 1000);
  assert.equal(e.view().toast, null);             // still suppressed
  await w.advance(2000);                          // wake timer fires
  v = e.view();
  assert.equal(v.toast.count, 1);
  assert.equal(v.items[0].reminder, true);
  assert.equal(w.calls.reminded.length, 1);
  e.dispose();
});

test("reminder is shown once per snooze, then the user can snooze again for a fresh cycle", async () => {
  const w = world();
  const a = w.add("client_comment", 3000);
  const e = w.make(); await e.start();
  await e.snooze(a.id);
  await w.advance(SNOOZE_MS + 100);
  assert.equal(w.calls.reminded.length, 1);
  e.dismissToast();
  await e.refresh(); await e.onResume(); await w.advance(60_000);
  assert.equal(e.view().toast, null);             // no repeat loop
  assert.equal(w.calls.reminded.length, 1);
  await e.snooze(a.id);                           // snooze again
  assert.equal(e.view().items[0].snoozed, true);
  assert.equal(e.view().items[0].reminder, false);
  await w.advance(SNOOZE_MS + 100);
  assert.equal(e.view().toast.count, 1);
  assert.equal(w.calls.reminded.length, 2);
  e.dispose();
});

test("an item opened after it was snoozed does not trigger a reminder", async () => {
  const w = world();
  const a = w.add("client_comment", 3000);
  const e = w.make(); await e.start();
  await e.snooze(a.id);
  w.clock.t += 1000;
  await e.openItem(a.id);
  await w.advance(SNOOZE_MS + 100);
  assert.equal(e.view().toast, null);
  assert.equal(w.calls.reminded.length, 0);
  e.dispose();
});

test("multiple snoozed items are independent and reminders are aggregated into one toast", async () => {
  const w = world();
  const a = w.add("client_comment", 5000), b = w.add("freelancer_upload", 4000), c = w.add("client_approved", 3000);
  const e = w.make(); await e.start();
  await e.snooze(a.id);
  await w.advance(60_000);
  await e.snooze(b.id);                           // b expires one minute after a
  await w.advance(SNOOZE_MS - 60_000 + 100);      // a expired, b not yet
  assert.equal(e.view().toast.count, 1);
  assert.equal(e.view().items.find((n) => n.id === b.id).snoozed, true);
  assert.equal(e.view().items.find((n) => n.id === c.id).reminder, false);
  await w.advance(60_000);
  assert.equal(e.view().items.find((n) => n.id === b.id).reminder, true);
  e.dispose();
});

test("open() leaves actively snoozed unread items unacknowledged", async () => {
  const w = world();
  const a = w.add("client_comment", 3000), b = w.add("freelancer_upload", 2000);
  const e = w.make(); await e.start();
  await e.snooze(a.id);
  const acked = await e.open();
  assert.deepEqual(acked, [b.id]);
  assert.equal(e.view().items.find((n) => n.id === a.id).unread, true);
  e.dispose();
});

test("snooze expiry is recalculated on resume even if the timer never fired (suspended browser)", async () => {
  const w = world();
  const a = w.add("client_comment", 3000);
  const e = w.make(); await e.start();
  await e.snooze(a.id);
  w.timers.clear();                               // the browser froze/killed our timer
  w.clock.t += SNOOZE_MS + 120_000;               // laptop slept past the expiry
  assert.equal(e.view().toast, null);
  await e.onResume();
  assert.equal(e.view().toast.count, 1);
  e.dispose();
});

test("read and snooze state survive a page refresh (new engine, same server state)", async () => {
  const w = world();
  const a = w.add("client_comment", 3000), b = w.add("freelancer_upload", 2000);
  const e1 = w.make(); await e1.start();
  await e1.openItem(a.id);
  await e1.snooze(b.id);
  e1.dispose();
  const e2 = w.make(); await e2.start();
  const v = e2.view();
  assert.equal(v.items.find((n) => n.id === a.id).unread, false);
  assert.equal(v.items.find((n) => n.id === b.id).snoozed, true);
  assert.equal(v.badgeCount, 1);
  e2.dispose();
});

test("an expired snooze is eligible for a reminder right after a refresh", async () => {
  const w = world();
  const a = w.add("client_comment", 3000);
  const e1 = w.make(); await e1.start();
  await e1.snooze(a.id);
  e1.dispose();
  w.clock.t += SNOOZE_MS + 1000;
  const e2 = w.make(); await e2.start();
  assert.equal(e2.view().toast.count, 1);
  assert.equal(e2.view().badgeCount, 1);
  e2.dispose();
});

test("another tab that already showed the reminder suppresses a second toast", async () => {
  const w = world();
  const a = w.add("client_comment", 3000);
  const e1 = w.make(); await e1.start();
  await e1.snooze(a.id);
  w.clock.t += SNOOZE_MS + 1000;
  w.stateDb.get(a.id).reminded_until = w.stateDb.get(a.id).snoozed_until; // the other tab recorded it
  const e2 = w.make(); await e2.start();
  assert.equal(e2.view().toast, null);
  assert.equal(e2.view().items[0].reminder, true); // still flagged in the list until opened
  e1.dispose(); e2.dispose();
});

test("a slow refresh carrying older state cannot undo a newer local acknowledgement", async () => {
  const w = world();
  const a = w.add("client_comment", 3000);
  const e = w.make(); await e.start();
  await e.open();
  w.stateDb.set(a.id, { activity_id: a.id, read_at: null, opened_at: null, snoozed_until: null, reminded_until: null }); // a stale response that predates the ack
  await e.refresh();
  assert.equal(e.view().items[0].unread, false);
  e.dispose();
});

test("reconnect reconciles against persisted activity and picks up missed events", async () => {
  const w = world();
  const e = w.make(); await e.start();
  assert.equal(e.view().items.length, 0);
  const missed = w.add("client_revisions_requested", 0);   // happened while the socket was down
  w.status("SUBSCRIBED"); await tick(); await tick();
  assert.deepEqual(ids(e.view()), [missed.id]);
  e.dispose();
});

test("feed errors show an error state and recover on retry", async () => {
  const w = world({ failInit: true });
  w.add("client_comment", 1000);
  const e = w.make(); await e.start();
  assert.equal(e.view().status, "error");
  w.setInitFail(false);
  await e.refresh();
  assert.equal(e.view().status, "ready");
  assert.equal(e.view().items.length, 1);
  e.dispose();
});

test("a transient refresh failure keeps the existing feed on screen", async () => {
  const w = world();
  w.add("client_comment", 1000);
  const e = w.make(); await e.start();
  w.setFetchFail(true);
  await e.refresh();
  assert.equal(e.view().status, "ready");
  assert.equal(e.view().items.length, 1);
  e.dispose();
});

test("the feed is paginated and bounded: one page at a time, no duplicates, hasMore tracks the remainder", async () => {
  const w = world({ pageSize: 5 });
  for (let i = 0; i < 12; i++) w.add("client_comment", 1000 + i * 1000);
  const e = w.make(); await e.start();
  assert.equal(e.view().items.length, 5);
  assert.equal(e.view().hasMore, true);
  await e.loadMore();
  assert.equal(e.view().items.length, 10);
  assert.equal(e.view().hasMore, true);
  await e.loadMore();
  assert.equal(e.view().items.length, 12);
  assert.equal(e.view().hasMore, false);
  assert.equal(new Set(ids(e.view())).size, 12);
  e.dispose();
});

test("snoozing something that no longer exists reports it and leaves the feed unchanged", async () => {
  const w = world();
  const a = w.add("client_comment", 1000);
  const e = w.make(); await e.start();
  w.rows.length = 0;                               // deleted server-side
  assert.equal(await e.snooze(a.id), null);
  assert.match(e.view().actionError, /no longer available/);
  e.dispose();
});

test("dispose unsubscribes realtime, clears the wake timer and interval, and stops emitting", async () => {
  const w = world();
  const a = w.add("client_comment", 1000);
  const e = w.make(); await e.start();
  await e.snooze(a.id);
  assert.equal(w.timers.size, 1);
  assert.equal(w.intervals.size, 1);
  const before = w.emits.length;
  e.dispose();
  assert.equal(w.calls.unsub, 1);
  assert.equal(w.timers.size, 0);
  assert.equal(w.intervals.size, 0);
  await e.refresh(); await e.onResume();
  assert.equal(w.emits.length, before);
});

test("starting twice subscribes once", async () => {
  const w = world();
  const e = w.make(); await e.start(); await e.start();
  assert.equal(w.calls.subscribe, 1);
  assert.equal(w.intervals.size, 1);
  e.dispose();
});
