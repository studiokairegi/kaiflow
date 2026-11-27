// Phase 4: static checks that the two migrations, their rollbacks, the JS contracts and the Phase 3 surface agree.
// BEHAVIOUR is proven against a real PostgreSQL by supabase/tests/finance_v3/phase4.test.sql and concurrency.sh (run.sh).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as c from "./index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const MIG = path.join(ROOT, "supabase/migrations");
const RB = path.join(ROOT, "supabase/rollback");
const read = (p) => fs.readFileSync(p, "utf8");
const p4 = fs.readdirSync(MIG).filter((f) => f.includes("finance_v3") && f.slice(0, 14) >= "20270115000000" && f.slice(0, 14) < "20270116000000").sort();
const sql = Object.fromEntries(p4.map((f) => [f, read(path.join(MIG, f))]));
const all = Object.values(sql).join("\n");
const strip = (t) => t.replace(/--.*$/gm, "");

test("Phase 4 ships two ordered transactional migrations, each with a data-safe rollback", () => {
  assert.deepEqual(p4.map((f) => f.replace(/^\d+_finance_v3_/, "").replace(/\.sql$/, "")), ["studio_core", "studio_ops"]);
  for (const f of p4) {
    assert.match(sql[f], /^begin;/m); assert.match(sql[f], /^commit;/m);
    const rb = read(path.join(RB, f.replace(/\.sql$/, ".rollback.sql")));
    assert.match(rb, /^begin;/m); assert.match(rb, /^commit;/m);
  }
  assert.match(read(path.join(RB, p4[0].replace(/\.sql$/, ".rollback.sql"))), /Rollback refused/);
});

test("new public RPCs equal PHASE4_RPCS; redefined Phase 3 RPCs are listed and keep their names", () => {
  const ops = [...strip(sql[p4[1]]).matchAll(/create or replace function public\.(fin3_[a-z_0-9]+)\(/g)].map((m) => m[1]);
  assert.deepEqual(ops.sort(), [...c.PHASE4_RPCS].sort());
  assert.equal(c.PHASE4_RPCS.length, 33);
  const redefined = [...strip(sql[p4[0]]).matchAll(/create or replace function public\.(fin3_[a-z_0-9]+)\(/g)].map((m) => m[1]);
  assert.deepEqual(redefined.sort(), [...c.PHASE4_REDEFINED_RPCS].sort());
  for (const n of c.PHASE4_REDEFINED_RPCS) assert.ok(c.PHASE3_RPCS.includes(n), n);
  const earlier = new Set([...c.PHASE2_RPCS, ...c.PHASE3_RPCS]);
  for (const n of c.PHASE4_RPCS) assert.ok(!earlier.has(n), `${n} collides with an earlier RPC`);
});

test("the old unprotected signatures are dropped before the protected ones are created", () => {
  const core = strip(sql[p4[0]]);
  for (const sig of ["fin3_pay_bill(uuid, text, uuid, text, date, uuid, text)", "fin3_record_expense(uuid, text, jsonb)"]) assert.ok(core.includes(`drop function if exists public.${sig}`), sig);
  assert.match(core, /drop function if exists public\.fin3_post_transfer\(/);
  for (const n of c.PHASE4_REDEFINED_RPCS) assert.match(core, new RegExp(`function public\\.${n}\\([^)]*p_override jsonb default null\\)`, "s"), n);
});

test("every function is SECURITY DEFINER (public) with a pinned search_path", () => {
  for (const [f, text] of Object.entries(sql)) for (const b of text.split(/create or replace function /).slice(1)) {
    const head = b.slice(0, b.indexOf("$$"));
    assert.match(head, /set search_path = pg_catalog(, finance_v3)?\s/, `${f}: ${head.split("(")[0]}`);
    if (b.startsWith("public.")) assert.match(head, /security definer/, `${f}: ${head.split("(")[0]}`);
  }
});

test("privilege footer in both migrations; finance_v3 functions reach nobody", () => {
  for (const f of p4) {
    assert.match(sql[f], /like 'fin3\\_%'[\s\S]*revoke all on function %s from public, anon, service_role[\s\S]*grant execute on function %s to authenticated/, f);
    assert.match(sql[f], /nspname = 'finance_v3'[\s\S]*revoke all on function %s from public, anon, authenticated, service_role/, f);
  }
  assert.doesNotMatch(all, /grant execute on function finance_v3\.(post_event|reverse_entry|enforce_protection|safe_to_spend)/);
});

test("every Phase 4 table has RLS, SELECT-only access, and no client write path", () => {
  const tables = [...all.matchAll(/create table if not exists finance_v3\.([a-z_0-9]+)/g)].map((m) => m[1]);
  assert.equal(tables.length, 10);
  assert.match(all, /execute format\('revoke all on finance_v3\.%I from public, anon, authenticated, service_role', t\)/);
  assert.match(all, /execute format\('grant select on finance_v3\.%I to authenticated', t\)/);
  assert.match(all, /enable row level security/);
  assert.doesNotMatch(strip(all), /grant\s+(insert|update|delete|all)[^;]*on\s+finance_v3\./i);
  assert.doesNotMatch(strip(all), /create\s+policy[^;]*for\s+(insert|update|delete|all)/i);
});

test("money is exact numeric; no floating point", () => {
  assert.doesNotMatch(strip(all), /\b(double precision|float4|float8)\b|\s(real|money)\s*(,|\)|not null|default)/i);
});

test("every error code raised is a documented contract code", () => {
  const known = new Set(Object.values(c.ERROR_CODES));
  for (const m of all.matchAll(/errcode = '(V3\d+)'/g)) assert.ok(known.has(m[1]), m[1]);
});

test("Phase 4 never touches V2 tables or legacy public tables", () => {
  assert.doesNotMatch(strip(all), /\b(insert\s+into|update|delete\s+from|alter\s+table|drop\s+table)\s+(?:only\s+)?public\.(?!fin3)/i);
  for (const t of c.V2_PROTECTED_TABLES) assert.doesNotMatch(strip(all), new RegExp(`\\bpublic\\.${t}\\b`), t);
});

test("protection contract constants match the database", () => {
  assert.deepEqual([...c.PROTECTION_MODES], ["block", "warn"]);
  for (const k of c.PROTECTION_CHECKS) assert.match(all, new RegExp(`'${k}'`), k);
  for (const k of c.OWNER_PAYMENT_TYPES) assert.match(all, new RegExp(`'${k}'`), k);
  assert.match(all, /10 and 500|between 10 and 500/);
});
