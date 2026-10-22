// Run: node --test src/downloadGuard.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createDownloadGuard } from "./downloadGuard.js";

function setup(opts = {}) {
  const timers = new Map(); let id = 0;
  const changes = [];
  const guard = createDownloadGuard({
    cooldownMs: 10000,
    onChange: (s) => changes.push([...s]),
    setTimeoutFn: (f, ms) => { timers.set(++id, { f, ms }); return id; },
    clearTimeoutFn: (i) => timers.delete(i),
    ...opts,
  });
  const fire = () => { const all = [...timers.values()]; timers.clear(); all.forEach((t) => t.f()); };
  return { guard, timers, changes, fire };
}
const tick = () => new Promise((r) => setImmediate(r));

test("one click starts exactly one download", async () => {
  const { guard } = setup(); let calls = 0;
  const r = await guard.start("a", async () => { calls++; });
  assert.equal(calls, 1);
  assert.deepEqual(r, { started: true, ok: true });
});

test("rapid repeated clicks (same tick, while the request is in flight) start only one", async () => {
  const { guard } = setup(); let calls = 0; let finish;
  const run = () => { calls++; return new Promise((r) => { finish = r; }); };
  const p1 = guard.start("a", run), p2 = guard.start("a", run), p3 = guard.start("a", run);
  assert.equal(calls, 1); // decided synchronously, before any await
  finish();
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.equal(r1.started, true);
  assert.equal(r2.started, false);
  assert.equal(r3.started, false);
});

test("in-progress state is visible immediately (before the request resolves)", async () => {
  const { guard, changes } = setup(); let finish;
  const p = guard.start("a", () => new Promise((r) => { finish = r; }));
  assert.equal(guard.isActive("a"), true);
  assert.deepEqual(changes.at(-1), ["a"]);
  finish(); await p;
});

test("stays locked until the cooldown elapses, then becomes available again", async () => {
  const { guard, fire, timers } = setup();
  await guard.start("a", async () => {});
  assert.equal(guard.isActive("a"), true);
  assert.equal([...timers.values()][0].ms, 10000);
  assert.equal((await guard.start("a", async () => {})).started, false);
  fire();
  assert.equal(guard.isActive("a"), false);
});

test("an intentional later click can download again after the cooldown", async () => {
  const { guard, fire } = setup(); let calls = 0;
  await guard.start("a", async () => { calls++; });
  fire();
  const r = await guard.start("a", async () => { calls++; });
  assert.equal(r.started, true);
  assert.equal(calls, 2);
});

test("a failed download releases the lock so the user can retry", async () => {
  const { guard } = setup(); let calls = 0;
  const r = await guard.start("a", async () => { calls++; throw new Error("nope"); });
  assert.equal(r.ok, false);
  assert.equal(guard.isActive("a"), false);
  const r2 = await guard.start("a", async () => { calls++; });
  assert.equal(r2.ok, true);
  assert.equal(calls, 2);
});

test("separate files do not block one another", async () => {
  const { guard } = setup(); let finish;
  const p = guard.start("file-1", () => new Promise((r) => { finish = r; }));
  const r = await guard.start("file-2", async () => {});
  assert.equal(r.started, true);
  assert.equal(guard.isActive("file-1"), true);
  finish(); await p;
});

test("dispose clears timers, stops notifications, and refuses new work", async () => {
  const { guard, timers, changes } = setup();
  await guard.start("a", async () => {});
  assert.equal(timers.size, 1);
  const before = changes.length;
  guard.dispose();
  assert.equal(timers.size, 0);
  assert.equal(guard.isActive("a"), false);
  assert.equal((await guard.start("a", async () => {})).started, false);
  assert.equal(changes.length, before);
});

test("dispose while a request is in flight leaves no timer behind", async () => {
  const { guard, timers } = setup(); let finish;
  const p = guard.start("a", () => new Promise((r) => { finish = r; }));
  guard.dispose();
  finish(); await p; await tick();
  assert.equal(timers.size, 0);
});
