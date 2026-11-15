import test from "node:test";
import assert from "node:assert/strict";
import { fetchAll, PAGE } from "./paging.js";
import { sourcesKey } from "./sourcesKey.js";

// Mock Supabase client. Rows are sorted only by the ORDER BY columns requested; rows that tie on every
// requested column come back in a different (deterministically shuffled) order on every call, like Postgres
// is free to do. Paging over a non-total order therefore skips/duplicates rows.
function mockClient(rows) {
  let call = 0;
  return {
    from() {
      const state = { orders: [], range: null };
      const q = {
        select: () => q,
        range: (a, b) => { state.range = [a, b]; return q; },
        order: (col, { ascending = true } = {}) => { state.orders.push({ col, ascending }); return q; },
        then(resolve) {
          call++;
          const cmp = (x, y) => {
            for (const { col, ascending } of state.orders) {
              if (x[col] === y[col]) continue;
              return (x[col] < y[col] ? -1 : 1) * (ascending ? 1 : -1);
            }
            return 0;
          };
          const sorted = rows.map((r, i) => ({ r, i, k: (i * 7919 + call * 104729) % 100003 }))
            .sort((x, y) => cmp(x.r, y.r) || x.k - y.k).map((x) => x.r);
          resolve({ data: sorted.slice(state.range[0], state.range[1] + 1), error: null });
        },
      };
      return q;
    },
  };
}

const makeRows = (n) => Array.from({ length: n }, (_, i) => ({ id: String(i).padStart(6, "0"), paid_date: `2026-01-${String(1 + (i % 3)).padStart(2, "0")}` }));

test("paging with a non-unique sort key plus id tiebreak returns every row exactly once", async () => {
  const rows = makeRows(PAGE * 2 + 345);
  const got = await fetchAll(mockClient(rows), "invoice_payments", { order: "paid_date", ascending: false });
  assert.equal(got.length, rows.length);
  assert.equal(new Set(got.map((r) => r.id)).size, rows.length);
});

test("control: without the tiebreak the same mock does drop/duplicate rows (proves the test bites)", async () => {
  const rows = makeRows(PAGE * 2 + 345);
  const got = await fetchAll(mockClient(rows), "invoice_payments", { order: "paid_date", ascending: false, tiebreak: [] });
  assert.notEqual(new Set(got.map((r) => r.id)).size, rows.length);
});

test("composite-key table (bill_shots) pages correctly with a multi-column tiebreak", async () => {
  const rows = Array.from({ length: PAGE + 50 }, (_, i) => ({ bill_id: `b${String(Math.floor(i / 4)).padStart(5, "0")}`, shot_id: `s${i}` }));
  const got = await fetchAll(mockClient(rows), "bill_shots", { tiebreak: ["bill_id", "shot_id"] });
  assert.equal(new Set(got.map((r) => `${r.bill_id}/${r.shot_id}`)).size, rows.length);
});

test("a short final page ends paging and an error is thrown, not swallowed", async () => {
  assert.equal((await fetchAll(mockClient(makeRows(10)), "t")).length, 10);
  const failing = { from: () => ({ select() { return this; }, range() { return this; }, order() { return this; }, then: (r) => r({ data: null, error: new Error("boom") }) }) };
  await assert.rejects(fetchAll(failing, "t"), /boom/);
});

test("sourcesKey is stable for fresh arrays with equal content (no reload on unrelated App re-renders)", () => {
  const mk = () => ({ inv: [{ id: "i1", total: 100, paid: 0, items: [{ x: 1 }] }], exp: [{ id: "e1", amount: 5 }] });
  const a = mk(), b = mk();
  assert.notEqual(a.inv, b.inv);
  assert.equal(sourcesKey(a.inv, a.exp), sourcesKey(b.inv, b.exp));
});

test("sourcesKey changes when an invoice or expense actually changes, and tolerates undefined", () => {
  const base = sourcesKey([{ id: "i1", total: 100 }], [{ id: "e1", amount: 5 }]);
  assert.notEqual(base, sourcesKey([{ id: "i1", total: 101 }], [{ id: "e1", amount: 5 }]));
  assert.notEqual(base, sourcesKey([{ id: "i1", total: 100 }], [{ id: "e1", amount: 6 }]));
  assert.notEqual(base, sourcesKey([{ id: "i1", total: 100 }], []));
  assert.equal(typeof sourcesKey(undefined, null), "string");
});
