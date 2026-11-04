import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const app = read("../App.jsx");
const fixtures = JSON.parse(read("./duplicates.fixtures.json"));

// Pull the REAL functions out of App.jsx (the UI's duplicate check) and run them against the shared fixtures.
const start = app.indexOf("function normalizeCompanyName");
const end = app.indexOf("\n}\n", app.indexOf("function findPossibleDuplicates")) + 3;
assert.ok(start > 0 && end > start, "found the duplicate-detection functions in App.jsx");
const ui = new Function(`${app.slice(start, end)}; return { normalizeCompanyName, normalizeWebsite, normalizeEmailStr, findPossibleDuplicates };`)();

test("the UI duplicate check agrees with the shared fixtures", () => {
  for (const f of fixtures) {
    const found = ui.findPossibleDuplicates(f.probe, [{ id: "L", ...f.lead }]);
    assert.equal(found[0]?.confidence ?? null, f.expect, f.name);
  }
});

test("the SQL port uses the same normalization words and rules as the UI", () => {
  const sql = read("../../supabase/migrations/20261109110000_intelligence_crm_notifications.sql");
  const jsWords = /\\b\(([a-z|]+)\)\\b/.exec(app.slice(start, end))[1];
  const sqlWords = /\\m\(([a-z|]+)\)\\M/.exec(sql)[1];
  assert.equal(sqlWords, jsWords, "company suffix words are identical");
  assert.match(sql, /length\(v_comp\) >= 4/); assert.match(app.slice(start, end), /length >= 4|length\s*>=\s*4/);
  for (const lvl of ["very_high", "high", "medium"]) { assert.ok(sql.includes(`'${lvl}'`)); assert.ok(app.slice(start, end).includes(`"${lvl}"`) || app.slice(start, end).includes(`'${lvl}'`)); }
  assert.match(sql, /\^https\?:\/\//); assert.match(sql, /\^www\\\./);
});
