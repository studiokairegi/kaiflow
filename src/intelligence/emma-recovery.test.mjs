// Emma chat fixes: stuck "running" email cards, hidden cards, double-tab noise, "New chat" with stale rows.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { STUCK_MS, hasInFlight, isStuck, runEmmaAction, stuckRunning } from "./emma.js";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const NOW = Date.parse("2027-01-09T12:00:00Z");
const running = (ageMs, o = {}) => ({ id: "r1", tool: "send_email", status: "running", decided_at: new Date(NOW - ageMs).toISOString(), expires_at: new Date(NOW + 1e6).toISOString(), ...o });

test("a running email older than the timeout is stuck, a fresh one is not, and a stuck one stops the fast polling", () => {
  assert.equal(isStuck(running(STUCK_MS + 1000), NOW), true);
  assert.equal(isStuck(running(STUCK_MS - 1000), NOW), false);
  assert.equal(isStuck(running(STUCK_MS + 1000, { status: "confirmed" }), NOW), false);
  assert.equal(isStuck({ status: "running" }, NOW), false, "no timestamp: never guess");
  assert.deepEqual(stuckRunning([running(STUCK_MS + 1000), running(1000, { id: "r2" })], NOW).map((a) => a.id), ["r1"]);
  assert.equal(hasInFlight([running(1000)], NOW), true);
  assert.equal(hasInFlight([running(STUCK_MS + 1000)], NOW), false);
});

const mail = (fn) => ({ send: fn || (async () => ({ ok: true, message_id: "m1" })) });
const claimOk = { ok: true, status: "running", args: { to: "jane@pixelmoon.jp", subject: "Hi", body: "Hello" } };
const action = { id: "a1", tool: "send_email" };
const sender = { id: "acc-1" };
const noSleep = async () => {};

test("a lost report is retried, and a send that could not be recorded is flagged instead of hidden", async () => {
  let finishCalls = 0;
  const flaky = { chatClaim: async () => claimOk, chatFinish: async () => { finishCalls++; if (finishCalls < 3) throw new Error("network"); } };
  assert.deepEqual(await runEmmaAction({ supabase: {}, action, sender, api: flaky, mail: mail(), sleep: noSleep }), { ok: true, sent: true });
  assert.equal(finishCalls, 3);
  finishCalls = 0;
  const dead = { chatClaim: async () => claimOk, chatFinish: async () => { finishCalls++; throw new Error("network"); } };
  assert.deepEqual(await runEmmaAction({ supabase: {}, action, sender, api: dead, mail: mail(), sleep: noSleep }), { ok: true, sent: true, unrecorded: true });
  assert.equal(finishCalls, 3);
});

test("an automatic run that finds the card already taken by another window is skipped quietly; a manual one still explains", async () => {
  for (const status of ["running", "confirmed"]) {
    const api = { chatClaim: async () => ({ ok: false, status }), chatFinish: async () => {} };
    assert.deepEqual(await runEmmaAction({ supabase: {}, action, auto: true, sender, api, mail: mail(), sleep: noSleep }), { skipped: true });
    await assert.rejects(runEmmaAction({ supabase: {}, action, auto: false, sender, api, mail: mail(), sleep: noSleep }));
  }
});

test("ChatView shows cards for an unanswered request, recovers stuck cards and checks the current thread before 'New chat'", () => {
  const v = read("./ChatView.jsx");
  assert.match(v, /answered\.has\(t\.id\) \? \[\] : \(byRequest\.get\(t\.id\)/);
  assert.match(v, /stuckRunning\(actRows\)[\s\S]{0,300}intelApi\.chatRecoverStuck\(supabase\)/);
  assert.match(v, /const current = own\(msgs\.data\); if \(threadId && current && current\.length === 0\) return;/);
  assert.match(v, /r\.unrecorded/);
});

test("the API and the database expose the recovery, scoped to the caller's own running actions", () => {
  const api = read("./api.js");
  assert.match(api, /chatRecoverStuck: async \(s\) => \{ try \{ return await call\(s, "intel_admin_chat_recover_stuck", \{ p_minutes: 5 \}\)/);
  assert.match(api, /created_at,decided_at,expires_at/);
  const sql = read("../../supabase/migrations/20270109110000_intelligence_chat_recover_stuck.sql");
  assert.match(sql, /a\.user_id = auth\.uid\(\) and a\.status = 'running'/);
  assert.match(sql, /a\.organization_id = v_org/);
  assert.match(sql, /greatest\(coalesce\(p_minutes, 5\), 5\)/, "a caller cannot shorten the wait below 5 minutes");
  assert.match(sql, /revoke all on function public\.intel_admin_chat_recover_stuck\(integer\) from public, anon/);
  assert.match(sql, /grant execute on function public\.intel_admin_chat_recover_stuck\(integer\) to authenticated/);
});
