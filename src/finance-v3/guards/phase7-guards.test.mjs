// Phase 7 guards: the final-audit migration is small, transactional, reversible, and changes nothing but one internal function.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const strip = (t) => t.replace(/--.*$/gm, "");
const mig = fs.readdirSync(path.join(ROOT, "supabase/migrations")).filter((f) => f.includes("finance_v3") && f.slice(0, 14) >= "20270118000000");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("Phase 7 ships exactly one migration, transactional, with a rollback", () => {
  assert.deepEqual(mig, ["20270118090000_finance_v3_phase7_fixes.sql"]);
  const sql = strip(read(`supabase/migrations/${mig[0]}`)), rb = strip(read("supabase/rollback/20270118090000_finance_v3_phase7_fixes.rollback.sql"));
  for (const t of [sql, rb]) { assert.match(t, /^begin;/m); assert.match(t, /^commit;/m); }
  assert.match(rb, /delete from finance_v3\.schema_version where version = '20270118090000'/);
});

test("Phase 7 migration replaces one internal function only: no table, no new RPC, no V2/legacy object, no grant change", () => {
  const sql = strip(read(`supabase/migrations/${mig[0]}`));
  assert.deepEqual([...sql.matchAll(/create or replace function ([a-z_0-9.]+)\(/g)].map((m) => m[1]), ["finance_v3.legacy_validate"]);
  assert.doesNotMatch(sql, /create table|alter table|drop |grant |revoke |public\.(?!fin3)/i);
});

test("legacy_validate never appends a bare string literal to its error array (the defect found in Phase 7)", () => {
  for (const f of fs.readdirSync(path.join(ROOT, "supabase/migrations")).filter((x) => x.includes("finance_v3") && x >= "20270118")) {
    assert.doesNotMatch(strip(read(`supabase/migrations/${f}`)), /v_err := v_err \|\|/);
  }
});

test("the end-to-end harness is wired into run.sh and never discovered by plain `node --test` (it needs a database)", () => {
  assert.match(read("supabase/tests/finance_v3/run.sh"), /e2e\/phase7\.e2e\.mjs/);
  assert.ok(!fs.readdirSync(path.join(ROOT, "supabase/tests/finance_v3/e2e")).some((f) => /\.test\.m?js$/.test(f)));
});
