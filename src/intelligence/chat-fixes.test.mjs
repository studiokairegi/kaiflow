import test from "node:test";
import assert from "node:assert/strict";
import { answerOverdue, ANSWER_TIMEOUT_MS } from "./logic.js";
import { intelApi } from "./api.js";

// A fake Supabase table that honours order()/limit() the way PostgREST does.
function fakeSupabase(rows) {
  return { from: () => {
    let col = null, asc = true, n = Infinity;
    const q = { select: () => q, eq: () => q,
      order: (c, o) => { col = c; asc = !(o && o.ascending === false); return q; },
      limit: (k) => { n = k; return q; },
      then: (ok, bad) => {
        const out = [...rows].sort((a, b) => (asc ? 1 : -1) * (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0)).slice(0, n);
        return Promise.resolve({ data: out, error: null }).then(ok, bad);
      } };
    return q;
  } };
}

test("chat messages: a thread longer than the limit shows the NEWEST rows, oldest first", async () => {
  const rows = Array.from({ length: 450 }, (_, i) => ({ id: i + 1, role: i % 2 ? "assistant" : "user" }));
  const out = await intelApi.chatMessages(fakeSupabase(rows), "t");
  assert.equal(out.length, 300);
  assert.equal(out[0].id, 151); assert.equal(out.at(-1).id, 450);
});

test("chat actions: the newest cards are kept, in time order", async () => {
  const rows = Array.from({ length: 130 }, (_, i) => ({ id: `a${i}`, created_at: `2026-11-04T10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z` }));
  const out = await intelApi.chatActions(fakeSupabase(rows), "t");
  assert.equal(out.length, 100);
  assert.equal(out.at(-1).id, "a129"); assert.equal(out[0].id, "a30");
});

test("an unanswered message stops 'working' after the timeout, and an answered one never counts as overdue", () => {
  const now = Date.parse("2026-11-04T12:00:00Z");
  const asked = (ms) => [{ id: 1, role: "user", created_at: new Date(now - ms).toISOString() }];
  assert.equal(answerOverdue(asked(10_000), now), false);
  assert.equal(answerOverdue(asked(ANSWER_TIMEOUT_MS + 1000), now), true);
  assert.equal(answerOverdue([...asked(ANSWER_TIMEOUT_MS + 1000), { id: 2, role: "assistant", reply_to: 1 }], now), false);
  assert.equal(answerOverdue([], now), false);
});
