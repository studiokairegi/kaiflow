// Run: node --test src/downloadGuard.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  createDownloadGuard,
  downloadButtonView,
  downloadKey,
  DOWNLOAD_BUTTON_BUSY_LABEL,
  DOWNLOAD_COOLDOWN_MS,
} from "./downloadGuard.js";

// Deterministic fake timers (no real waiting, and we can assert nothing is left scheduled).
function fakeClock() {
  let now = 0, nextId = 1;
  const timers = new Map();
  return {
    setTimeoutFn: (fn, ms) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeoutFn: (id) => { timers.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
    },
    get pending() { return timers.size; },
  };
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise((r) => setImmediate(r));

test("one click starts one download", async () => {
  const clock = fakeClock(); let starts = 0;
  const g = createDownloadGuard(clock);
  const res = await g.run("a", async () => { starts++; });
  assert.equal(starts, 1);
  assert.deepEqual(res, { started: true, ok: true });
});

test("rapid repeated clicks (same tick, before any await) start only one download", async () => {
  const clock = fakeClock(); let starts = 0;
  const g = createDownloadGuard(clock);
  const d = deferred();
  const results = [1, 2, 3, 4, 5].map(() => g.run("a", () => { starts++; return d.promise; }));
  d.resolve();
  const settled = await Promise.all(results);
  assert.equal(starts, 1);
  assert.equal(settled.filter((r) => r.started).length, 1);
  assert.equal(settled.filter((r) => !r.started).length, 4);
});

test("clicks during the cooldown are ignored too", async () => {
  const clock = fakeClock(); let starts = 0;
  const g = createDownloadGuard(clock);
  await g.run("a", async () => { starts++; });
  assert.equal(g.phase("a"), "cooldown");
  assert.deepEqual(await g.run("a", async () => { starts++; }), { started: false });
  assert.equal(starts, 1);
});

test("the in-progress state is visible synchronously, before the request resolves", () => {
  const clock = fakeClock(); let changes = 0;
  const g = createDownloadGuard({ ...clock, onChange: () => changes++ });
  g.run("a", () => new Promise(() => {}));
  assert.equal(g.phase("a"), "starting");
  assert.ok(changes >= 1, "onChange fires immediately so the button can re-render");
  const view = downloadButtonView(g.phase("a"), { version: 2 });
  assert.equal(view.label, DOWNLOAD_BUTTON_BUSY_LABEL);
  assert.equal(view.disabled, true);
  assert.match(view.statusMessage, /started/i);
  assert.doesNotMatch(view.statusMessage, /finished|complete/i, "never claims the browser finished the download");
});

test("button becomes available again after the cooldown", async () => {
  const clock = fakeClock();
  const g = createDownloadGuard(clock);
  await g.run("a", async () => {});
  clock.advance(DOWNLOAD_COOLDOWN_MS - 1);
  assert.equal(g.isBlocked("a"), true);
  clock.advance(1);
  assert.equal(g.isBlocked("a"), false);
  const view = downloadButtonView(g.phase("a"), { version: 2 });
  assert.equal(view.disabled, false);
  assert.equal(view.label, "Download v2");
});

test("an intentional later click can start another download", async () => {
  const clock = fakeClock(); let starts = 0;
  const g = createDownloadGuard(clock);
  await g.run("a", async () => { starts++; });
  clock.advance(DOWNLOAD_COOLDOWN_MS);
  const res = await g.run("a", async () => { starts++; });
  assert.equal(starts, 2);
  assert.equal(res.started, true);
});

test("a failed request releases the lock so the user can retry", async () => {
  const clock = fakeClock(); let starts = 0;
  const g = createDownloadGuard(clock);
  const res = await g.run("a", async () => { starts++; throw new Error("nope"); });
  assert.equal(res.ok, false);
  assert.equal(res.error.message, "nope");
  assert.equal(g.isBlocked("a"), false);
  assert.equal(clock.pending, 0);
  await g.run("a", async () => { starts++; });
  assert.equal(starts, 2);
});

test("a synchronous throw from the start function also releases the lock", async () => {
  const g = createDownloadGuard(fakeClock());
  const res = await g.run("a", () => { throw new Error("sync"); });
  assert.equal(res.ok, false);
  assert.equal(g.isBlocked("a"), false);
});

test("a request that never settles times out instead of locking the user out", async () => {
  const clock = fakeClock();
  const g = createDownloadGuard({ ...clock, requestTimeoutMs: 5000 });
  g.run("a", () => new Promise(() => {}));
  assert.equal(g.isBlocked("a"), true);
  clock.advance(5000);
  assert.equal(g.isBlocked("a"), false);
});

test("a stale request settling after a timeout cannot re-lock a newer run", async () => {
  const clock = fakeClock();
  const g = createDownloadGuard({ ...clock, requestTimeoutMs: 1000 });
  const slow = deferred();
  g.run("a", () => slow.promise);
  clock.advance(1000); // timed out + released
  const second = deferred();
  g.run("a", () => second.promise); // a deliberate retry
  slow.resolve(); // the old request finally finishes
  await tick();
  assert.equal(g.phase("a"), "starting", "the newer run still owns the lock");
});

test("separate files do not block one another", async () => {
  const clock = fakeClock(); const started = [];
  const g = createDownloadGuard(clock);
  const d = deferred();
  const a = g.run(downloadKey("shot1", "v1"), () => { started.push("a"); return d.promise; });
  const b = g.run(downloadKey("shot2", "v1"), () => { started.push("b"); return d.promise; });
  const a2 = g.run(downloadKey("shot1", "v2"), () => { started.push("a-v2"); return d.promise; });
  assert.deepEqual(started, ["a", "b", "a-v2"]);
  assert.equal(g.isBlocked(downloadKey("shot3", "v1")), false);
  d.resolve(); await Promise.all([a, b, a2]);
});

test("dispose clears every timer and ignores late settlement (no stale state)", async () => {
  const clock = fakeClock(); let changes = 0;
  const g = createDownloadGuard({ ...clock, onChange: () => changes++ });
  const d = deferred();
  g.run("a", () => d.promise);
  await g.run("b", async () => {}); // now cooling down
  assert.ok(clock.pending > 0);
  const before = changes;
  g.dispose();
  assert.equal(clock.pending, 0, "no timers left scheduled");
  d.resolve(); await tick();
  assert.equal(changes, before, "no onChange after unmount");
  assert.equal(clock.pending, 0, "settling after dispose schedules nothing");
  assert.deepEqual(await g.run("a", async () => {}), { started: false });
  g.dispose(); // idempotent
});

test("ClientCutReview routes its Download button through the guard (wiring regression)", () => {
  const src = fs.readFileSync(new URL("./ClientCutReview.jsx", import.meta.url), "utf8");
  assert.match(src, /createDownloadGuard/);
  assert.match(src, /downloadButtonView/);
  assert.match(src, /guard\.dispose\(\)/);
  assert.doesNotMatch(src, /act\(\(\) => clientDownload/, "download must not go through the generic act() wrapper");
});

test("ClientCutReview creates its guard in effect setup for React Strict Mode safety", () => {
  const src = fs.readFileSync(new URL("./ClientCutReview.jsx", import.meta.url), "utf8");
  const effectStart = src.indexOf("useEffect(() => {");
  const guardCreate = src.indexOf("const guard = createDownloadGuard", effectStart);
  const renderGuardCreate = src.indexOf("if (!guardRef.current) guardRef.current = createDownloadGuard");
  assert.ok(effectStart >= 0 && guardCreate > effectStart, "guard is created during effect setup");
  assert.equal(renderGuardCreate, -1, "guard must not be created during render");
  assert.match(src, /if \(guardRef\.current === guard\) guardRef\.current = null/);
});
