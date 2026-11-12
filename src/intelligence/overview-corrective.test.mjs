import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { attentionItems, sendingReadiness, queueDiscovery, DISCOVERY_TYPES } from "./logic.js";

const base = { configured: true, unknown_sends: 0, dead_jobs: 0, failed_jobs: 0, expired_leases: 0, pending_approval: 0, prospects_by_status: {} };
const connected = { status: "connected", accounts: [{ status: "connected" }] };
const healthy = { ...base, kill_switch: false, autonomy: "assisted", worker_last_seen_seconds: 20, initial_sent_today: 1, initial_cap: 5, followup_sent_today: 0, followup_cap: 5 };

test("OV-01: refresh bumps tick only, so the overview and mail RPCs are not requested twice", () => {
  const src = readFileSync(new URL("./IntelligenceModule.jsx", import.meta.url), "utf8");
  const line = src.split("\n").find((l) => l.includes("const refresh"));
  assert.ok(line.includes("setTick"));
  assert.ok(!/ov\.reload|mail\.reload/.test(line));
});

test("OV-02/03: failed jobs and expired leases raise attention alerts, below permanent failures", () => {
  assert.deepEqual(attentionItems(base), []);
  const items = attentionItems({ ...base, dead_jobs: 1, failed_jobs: 2, expired_leases: 3, pending_approval: 1 });
  assert.equal(items.length, 4);
  assert.equal(items[0].tone, "bad");
  assert.match(items[1].text, /3 worker job lease/);
  assert.match(items[2].text, /2 job\(s\) failed/);
  assert.equal(attentionItems({ ...base, failed_jobs: 1 }).length, 1);
  assert.equal(attentionItems({ ...base, expired_leases: 1 }).length, 1);
});

test("OV-04: sending readiness distinguishes kill-switch state from operational readiness", () => {
  assert.equal(sendingReadiness({ ...healthy, kill_switch: true }, connected).state, "stopped");
  assert.equal(sendingReadiness(healthy, connected).state, "ready");
  assert.equal(sendingReadiness(healthy, { status: "disconnected" }).state, "blocked");
  assert.equal(sendingReadiness(healthy, { status: "check_failed" }).state, "blocked");
  assert.equal(sendingReadiness(healthy, null).state, "blocked");
  assert.equal(sendingReadiness(healthy, { status: "connected", accounts: [{ status: "error" }] }).state, "blocked");
  assert.equal(sendingReadiness({ ...healthy, worker_last_seen_seconds: 5000 }, connected).state, "blocked");
  assert.equal(sendingReadiness({ ...healthy, worker_last_seen_seconds: null }, connected).state, "blocked");
  const capped = sendingReadiness({ ...healthy, initial_sent_today: 5, followup_sent_today: 5 }, connected);
  assert.equal(capped.state, "blocked"); assert.match(capped.text, /limits are both reached/);
  assert.equal(sendingReadiness({ ...healthy, initial_sent_today: 5 }, connected).state, "ready");
  assert.match(sendingReadiness({ ...healthy, autonomy: "shadow" }, connected).text, /waits for your approval/);
  const r = sendingReadiness(healthy, { status: "disconnected" });
  assert.equal(r.tone, "warn"); assert.doesNotMatch(r.text, /^Outgoing email is ON\.$/);
});

test("OV-05: discovery reports partial completion and a retry only re-queues failed types", async () => {
  const calls = [];
  const flaky = async (kind, payload) => { calls.push(payload.type); if (payload.type === DISCOVERY_TYPES[1]) throw new Error("network"); };
  const r = await queueDiscovery(flaky);
  assert.deepEqual(r.queued, [DISCOVERY_TYPES[0]]);
  assert.deepEqual(r.failed, [{ type: DISCOVERY_TYPES[1], error: "network" }]);
  assert.deepEqual(calls, [...DISCOVERY_TYPES], "the first failure must not stop later types, and the second type is still attempted");
  const firstFails = async (k, p) => { if (p.type === DISCOVERY_TYPES[0]) throw new Error("boom"); };
  const r2 = await queueDiscovery(firstFails);
  assert.deepEqual(r2.queued, [DISCOVERY_TYPES[1]]);
  const retryCalls = [];
  await queueDiscovery(async (k, p) => { retryCalls.push(p.type); }, r.failed.map((f) => f.type));
  assert.deepEqual(retryCalls, [DISCOVERY_TYPES[1]]);
  const ok = await queueDiscovery(async () => {});
  assert.deepEqual(ok, { queued: [...DISCOVERY_TYPES], failed: [] });
});

test("OverviewView uses the readiness and discovery helpers rather than the raw kill switch", () => {
  const src = readFileSync(new URL("./OverviewView.jsx", import.meta.url), "utf8");
  assert.match(src, /sendingReadiness\(o, mail\)/);
  assert.match(src, /queueDiscovery\(/);
  assert.doesNotMatch(src, /"Outgoing email is ON\."/);
});
