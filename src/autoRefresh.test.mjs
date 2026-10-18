// Run: node --test src/autoRefresh.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { startAutoRefresh, PORTAL_REFRESH_MS } from "./autoRefresh.js";

function env(visibility = "visible") {
  const listeners = { doc: {}, win: {} };
  const mk = (bag) => ({
    addEventListener: (n, f) => { bag[n] = f; },
    removeEventListener: (n) => { delete bag[n]; },
  });
  const doc = { visibilityState: visibility, ...mk(listeners.doc) };
  const win = mk(listeners.win);
  let cb = null, cleared = false;
  return {
    doc, win, listeners,
    setIntervalFn: (f) => { cb = f; return 1; },
    clearIntervalFn: () => { cleared = true; },
    fire: () => cb(),
    get cleared() { return cleared; },
  };
}

test("refreshes on each interval tick while the tab is visible", async () => {
  const e = env(); let n = 0;
  startAutoRefresh(async () => { n++; }, e);
  await e.fire(); await e.fire();
  assert.equal(n, 2);
});

test("does nothing while the tab is hidden, and catches up when it becomes visible", async () => {
  const e = env("hidden"); let n = 0;
  startAutoRefresh(async () => { n++; }, e);
  await e.fire();
  assert.equal(n, 0);
  e.doc.visibilityState = "visible";
  await e.listeners.doc.visibilitychange();
  assert.equal(n, 1);
});

test("focus and coming back online also refresh", async () => {
  const e = env(); let n = 0;
  startAutoRefresh(async () => { n++; }, e);
  await e.listeners.win.focus();
  await e.listeners.win.online();
  assert.equal(n, 2);
});

test("never runs two refreshes at once", async () => {
  const e = env(); let n = 0; let release;
  startAutoRefresh(() => { n++; return new Promise((r) => { release = r; }); }, e);
  const first = e.fire();
  await e.fire(); await e.listeners.win.focus(); // overlapping triggers are ignored
  assert.equal(n, 1);
  release(); await first;
  const second = e.fire(); // allowed again once the first finished
  assert.equal(n, 2);
  release(); await second;
});

test("a failing refresh does not throw and the next tick still runs", async () => {
  const e = env(); let n = 0;
  startAutoRefresh(async () => { n++; if (n === 1) throw new Error("offline"); }, e);
  await e.fire(); await e.fire();
  assert.equal(n, 2);
});

test("stop clears the timer, removes listeners, and ends refreshing", async () => {
  const e = env(); let n = 0;
  const stop = startAutoRefresh(async () => { n++; }, e);
  stop();
  assert.equal(e.cleared, true);
  assert.deepEqual(Object.keys(e.listeners.doc), []);
  assert.deepEqual(Object.keys(e.listeners.win), []);
  await e.fire();
  assert.equal(n, 0);
});

test("default interval is 5 seconds and can be overridden", () => {
  assert.equal(PORTAL_REFRESH_MS, 5000);
  const seen = [];
  const mk = () => ({ ...env(), setIntervalFn: (f, ms) => { seen.push(ms); return 1; } });
  startAutoRefresh(async () => {}, mk());
  startAutoRefresh(async () => {}, { ...mk(), intervalMs: 2000 });
  assert.deepEqual(seen, [5000, 2000]);
});
