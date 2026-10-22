// Run: node --test src/authBootstrap.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createAuthBootstrap } from "./authBootstrap.js";

// Fake auth client + manual timers (no real waiting).
function setup({ getSession } = {}) {
  const listeners = new Set();
  let unsub = 0, calls = 0;
  const auth = {
    getSession: () => { calls++; return getSession(calls); },
    onAuthStateChange: (cb) => {
      listeners.add(cb);
      return { data: { subscription: { unsubscribe: () => { listeners.delete(cb); unsub++; } } } };
    },
  };
  const timers = new Map(); let id = 0;
  const setTimeoutFn = (f) => { timers.set(++id, f); return id; };
  const clearTimeoutFn = (i) => timers.delete(i);
  const log = [];
  const boot = createAuthBootstrap({ auth, onChange: (s, e) => log.push({ ...s, event: e }), setTimeoutFn, clearTimeoutFn });
  return {
    boot, log, listeners,
    emit: (e, s) => listeners.forEach((l) => l(e, s)),
    fireTimeout: () => { const fs = [...timers.values()]; timers.clear(); fs.forEach((f) => f()); },
    get calls() { return calls; }, get unsub() { return unsub; },
  };
}
const tick = () => new Promise((r) => setImmediate(r));
const S = { user: { id: "u1" }, access_token: "t" };

test("valid existing session restores", async () => {
  const t = setup({ getSession: async () => ({ data: { session: S }, error: null }) });
  t.boot.start(); await tick();
  assert.equal(t.boot.state.status, "ready");
  assert.equal(t.boot.state.session, S);
});

test("no session resolves to ready/signed-out so the login page can render", async () => {
  const t = setup({ getSession: async () => ({ data: { session: null }, error: null }) });
  t.boot.start(); await tick();
  assert.deepEqual([t.boot.state.status, t.boot.state.session], ["ready", null]);
});

test("rejected getSession -> error state (not signed out), never stuck loading", async () => {
  const t = setup({ getSession: async () => { throw new Error("boom"); } });
  const orig = console.error; console.error = () => {};
  t.boot.start(); await tick(); console.error = orig;
  assert.equal(t.boot.state.status, "error");
  assert.equal(t.boot.state.session, null);
});

test("{error} result is treated as failure", async () => {
  const t = setup({ getSession: async () => ({ data: { session: null }, error: new Error("x") }) });
  const orig = console.error; console.error = () => {};
  t.boot.start(); await tick(); console.error = orig;
  assert.equal(t.boot.state.status, "error");
});

test("pending getSession -> stalled after timeout (session unknown, not ready)", async () => {
  const t = setup({ getSession: () => new Promise(() => {}) });
  t.boot.start(); await tick();
  assert.equal(t.boot.state.status, "loading");
  t.fireTimeout();
  assert.equal(t.boot.state.status, "stalled");
  assert.equal(t.boot.state.session, null);
});

test("late answer after stall recovers automatically", async () => {
  let resolve;
  const t = setup({ getSession: () => new Promise((r) => { resolve = r; }) });
  t.boot.start(); t.fireTimeout();
  resolve({ data: { session: S }, error: null }); await tick();
  assert.equal(t.boot.state.status, "ready");
  assert.equal(t.boot.state.session, S);
});

test("retry after a transient failure succeeds; stale attempt is ignored", async () => {
  const t = setup({ getSession: async (n) => { if (n === 1) throw new Error("net"); return { data: { session: null }, error: null }; } });
  const orig = console.error; console.error = () => {};
  t.boot.start(); await tick(); console.error = orig;
  assert.equal(t.boot.state.status, "error");
  t.boot.retry();
  assert.equal(t.boot.state.status, "loading");
  await tick();
  assert.equal(t.boot.state.status, "ready");
  assert.equal(t.calls, 2);
});

test("login and logout after init via auth events", async () => {
  const t = setup({ getSession: async () => ({ data: { session: null }, error: null }) });
  t.boot.start(); await tick();
  t.emit("SIGNED_IN", S);
  assert.equal(t.boot.state.session, S);
  t.emit("SIGNED_OUT", null);
  assert.equal(t.boot.state.session, null);
  assert.equal(t.boot.state.status, "ready");
});

test("auth event while stalled resolves state; PASSWORD_RECOVERY is surfaced once", async () => {
  const t = setup({ getSession: () => new Promise(() => {}) });
  t.boot.start(); t.fireTimeout();
  t.emit("PASSWORD_RECOVERY", S);
  assert.equal(t.boot.state.status, "ready");
  assert.equal(t.log.at(-1).event, "PASSWORD_RECOVERY");
  t.emit("TOKEN_REFRESHED", S);
  assert.equal(t.log.at(-1).event, "TOKEN_REFRESHED");
});

test("single listener, no loops, clean unsubscribe, nothing after dispose", async () => {
  const t = setup({ getSession: async () => ({ data: { session: null }, error: null }) });
  t.boot.start(); t.boot.start(); t.boot.retry(); await tick();
  assert.equal(t.listeners.size, 1);
  const before = t.log.length;
  t.emit("TOKEN_REFRESHED", S);
  assert.equal(t.log.length, before + 1); // exactly one state change per event
  t.boot.dispose();
  assert.equal(t.listeners.size, 0);
  assert.equal(t.unsub, 1);
  t.emit("SIGNED_IN", S);
  assert.equal(t.log.length, before + 1);
});

// --- Regression: auth events vs. an older in-flight getSession() ---

test("SIGNED_IN while getSession is pending is NOT overwritten by a late null", async () => {
  let resolve;
  const t = setup({ getSession: () => new Promise((r) => { resolve = r; }) });
  t.boot.start();
  t.emit("SIGNED_IN", S);
  assert.equal(t.boot.state.session, S);
  resolve({ data: { session: null }, error: null }); await tick();
  assert.equal(t.boot.state.status, "ready");
  assert.equal(t.boot.state.session, S);
});

test("SIGNED_OUT while getSession is pending is NOT overwritten by a late stale session", async () => {
  let resolve;
  const t = setup({ getSession: () => new Promise((r) => { resolve = r; }) });
  t.boot.start();
  t.emit("SIGNED_OUT", null);
  resolve({ data: { session: S }, error: null }); await tick();
  assert.equal(t.boot.state.session, null);
});

test("a late rejection after an auth event does not flip a ready state to error", async () => {
  let reject;
  const t = setup({ getSession: () => new Promise((_, r) => { reject = r; }) });
  t.boot.start();
  t.emit("SIGNED_IN", S);
  reject(new Error("late")); await tick();
  assert.equal(t.boot.state.status, "ready");
  assert.equal(t.boot.state.session, S);
});

test("a stalled-timeout that fires after an auth event does not clobber the ready state", async () => {
  const t = setup({ getSession: () => new Promise(() => {}) });
  t.boot.start();
  t.emit("SIGNED_IN", S);
  t.fireTimeout();
  assert.equal(t.boot.state.status, "ready");
  assert.equal(t.boot.state.session, S);
});

test("retry after an auth event still works and late answers from that retry are accepted", async () => {
  let resolve;
  const t = setup({ getSession: () => new Promise((r) => { resolve = r; }) });
  t.boot.start();
  t.emit("SIGNED_IN", S);
  t.boot.retry();                       // new attempt
  assert.equal(t.boot.state.status, "loading");
  resolve({ data: { session: null }, error: null }); await tick();
  assert.equal(t.boot.state.status, "ready");
});

test("late answer after stall (no events) still recovers", async () => {
  let resolve;
  const t = setup({ getSession: () => new Promise((r) => { resolve = r; }) });
  t.boot.start(); t.fireTimeout();
  assert.equal(t.boot.state.status, "stalled");
  resolve({ data: { session: S }, error: null }); await tick();
  assert.equal(t.boot.state.session, S);
});
