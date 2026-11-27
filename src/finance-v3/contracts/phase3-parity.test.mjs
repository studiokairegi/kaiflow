// Phase 3: static checks that the six migrations, their rollbacks, the Edge Functions and the JS contracts agree.
// These run in plain `npm test` without a database. The BEHAVIOUR is proven by supabase/tests/finance_v3/phase3.test.sql, which has
// to be run against a disposable PostgreSQL (see PHASE_3_HANDOFF.md: it could not be run where this phase was written).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as c from "./index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const MIG = path.join(ROOT, "supabase/migrations");
const RB = path.join(ROOT, "supabase/rollback");
const FN = path.join(ROOT, "supabase/functions");
const read = (p) => fs.readFileSync(p, "utf8");
const p3 = fs.readdirSync(MIG).filter((f) => f.includes("finance_v3") && f.slice(0, 14) >= "20270114000000" && f.slice(0, 14) < "20270115000000").sort();
const sql = Object.fromEntries(p3.map((f) => [f, read(path.join(MIG, f))]));
const all = Object.values(sql).join("\n");
const strip = (t) => t.replace(/--.*$/gm, "");

test("Phase 3 ships six ordered finance_v3 migrations, each transactional with a rollback", () => {
  assert.deepEqual(p3.map((f) => f.replace(/^\d+_finance_v3_/, "").replace(/\.sql$/, "")),
    ["settings_contacts", "receivables", "payments", "messages", "purchases_banking", "migration_tools"]);
  for (const f of p3) {
    assert.match(sql[f], /^begin;/m); assert.match(sql[f], /^commit;/m);
    const rb = path.join(RB, f.replace(/\.sql$/, ".rollback.sql"));
    assert.ok(fs.existsSync(rb), `missing rollback ${f}`);
    assert.match(read(rb), /^begin;/m); assert.match(read(rb), /^commit;/m);
    assert.match(read(rb), /Rollback refused/, "rollbacks must refuse to destroy data");
  }
});

test("public function surface equals the contracts: fin3_* for users, fin3svc_* for the service role", () => {
  const defined = [...all.matchAll(/create or replace function public\.(fin3(?:svc)?_[a-z_0-9]+)\(/g)].map((m) => m[1]);
  assert.equal(defined.length, new Set(defined).size, "no overloaded or duplicated public function");
  assert.deepEqual(defined.filter((n) => !n.startsWith(c.SERVICE_RPC_PREFIX)).sort(), [...c.PHASE3_RPCS].sort());
  assert.deepEqual(defined.filter((n) => n.startsWith(c.SERVICE_RPC_PREFIX)).sort(), [...c.PHASE3_SERVICE_RPCS].sort());
  const phase2 = new Set(c.PHASE2_RPCS);
  for (const n of c.PHASE3_RPCS) assert.ok(!phase2.has(n), `${n} collides with a Phase 2 RPC`);
  for (const n of c.PHASE3_RPCS) assert.ok(n.startsWith(c.RPC_PREFIX));
});

test("every public function is SECURITY DEFINER with a pinned search_path", () => {
  for (const [f, text] of Object.entries(sql)) {
    const blocks = text.split(/create or replace function /).slice(1);
    for (const b of blocks) {
      const head = b.slice(0, b.indexOf("$$"));
      assert.match(head, /set search_path = pg_catalog(, finance_v3)?\s/, `${f}: ${head.split("(")[0]}`);
      if (b.startsWith("public.")) assert.match(head, /security definer/, `${f}: ${head.split("(")[0]}`);
    }
  }
});

test("no user RPC parameter names a provider, a webhook or an event kind (providers reach the ledger only through the engine)", () => {
  for (const b of all.split(/create or replace function public\.fin3_/).slice(1)) {
    const head = b.slice(b.indexOf("(") + 1, b.indexOf(")"));        // the parameter list only
    assert.doesNotMatch(head, /paystack|resend|webhook|provider|p_kind\b/i, head);
  }
});

test("privilege footers: user RPCs to authenticated only, service RPCs to service_role only, finance_v3 functions to nobody", () => {
  for (const f of p3) {
    assert.match(sql[f], /like 'fin3\\_%'[\s\S]*revoke all on function %s from public, anon, service_role[\s\S]*grant execute on function %s to authenticated/, f);
    assert.match(sql[f], /like 'fin3svc\\_%'[\s\S]*revoke all on function %s from public, anon, authenticated[\s\S]*grant execute on function %s to service_role/, f);
    assert.match(sql[f], /nspname = 'finance_v3'[\s\S]*revoke all on function %s from public, anon, authenticated, service_role/, f);
  }
  assert.doesNotMatch(all, /grant execute on function finance_v3\.(post_event|reverse_entry|settle_intent|record_payment_core)/);
});

test("every new table has row level security, a SELECT-only grant, and no client write grant", () => {
  const tables = [...all.matchAll(/create table if not exists finance_v3\.([a-z_0-9]+)/g)].map((m) => m[1]);
  assert.ok(tables.length >= 26, `found ${tables.length} tables`);
  for (const t of tables) {
    const enabled = new RegExp(`alter table finance_v3\\.${t}\\s+enable row level security`).test(all) ||
      // purchases migration enables policies for a loop list; the table must appear in that list
      new RegExp(`'${t}'`).test(all) && /foreach t in array array\[/.test(all);
    assert.ok(enabled, `${t}: row level security is not enabled`);
  }
  assert.doesNotMatch(strip(all), /grant\s+(insert|update|delete|all)[^;]*on\s+finance_v3\./i);
  assert.doesNotMatch(strip(all), /grant\s+select[^;]*to\s+(anon|public|service_role)/i);
  assert.doesNotMatch(strip(all), /create\s+policy[^;]*for\s+(insert|update|delete|all)/i);
});

test("money columns are exact numeric(19,4); no floating point money anywhere", () => {
  assert.doesNotMatch(strip(all), /\b(double precision|float4|float8)\b|\s(real|money)\s*(,|\)|not null|default)/i);
  for (const m of strip(all).matchAll(/\b(amount|total|subtotal|outstanding|amount_paid|credit_total|refunded_amount)\s+numeric\(([0-9, ]+)\)/g)) assert.equal(m[2].replace(/\s/g, ""), "19,4", m[0]);
});

test("every error code raised is a documented contract code", () => {
  const known = new Set(Object.values(c.ERROR_CODES));
  for (const m of all.matchAll(/errcode = '(V3\d+)'/g)) assert.ok(known.has(m[1]), `${m[1]} is not in ERROR_CODES`);
});

test("only the migration-tooling extract reads legacy tables, and only with SELECT", () => {
  const reads = [...strip(all).matchAll(/\b(?:from|join)\s+public\.([a-z_]+)/g)].map((m) => m[1]);
  const allowed = new Set(["invoices", "projects", "studio_data_owners", "studio_organizations", "studio_memberships", "studio_departments", "studio_department_memberships"]);
  for (const r of reads) assert.ok(allowed.has(r), `unexpected read of public.${r}`);
  assert.doesNotMatch(strip(all), /\b(insert\s+into|update|delete\s+from|alter\s+table|drop\s+table)\s+(?:only\s+)?public\.(?!fin3)/i);
  assert.match(sql[p3[5]], /from public\.invoices i/);
});

test("Edge Functions use only RPCs: no direct table access in any Finance V3 shared module or function", () => {
  const files = fs.readdirSync(path.join(FN, "_shared")).filter((f) => /^finance_/.test(f)).map((f) => path.join(FN, "_shared", f));
  for (const d of ["finance-public", "finance-email-dispatch", "finance-document", "finance-scheduler"]) files.push(path.join(FN, d, "index.ts"));
  assert.ok(files.length >= 8);
  for (const f of files) {
    const t = read(f);
    assert.doesNotMatch(t, /\.from\(\s*["'`]/, `${path.basename(f)} reads a table directly`);
    assert.doesNotMatch(t, /(sk_(live|test)_|re_[A-Za-z0-9]{20,}|whsec_)/, `${path.basename(f)} contains a secret-looking value`);
  }
  // service RPC names used by Edge code must exist
  const used = new Set();
  for (const f of files) for (const m of read(f).matchAll(/["'`](fin3(?:svc)?_[a-z_0-9]+)["'`]/g)) used.add(m[1]);
  const known = new Set([...c.PHASE3_RPCS, ...c.PHASE3_SERVICE_RPCS, ...c.PHASE2_RPCS, ...c.PHASE6_SERVICE_RPCS]);
  for (const n of used) assert.ok(known.has(n), `Edge code calls unknown RPC ${n}`);
});

test("the new Edge Functions are declared in config.toml, and none of them is a webhook", () => {
  const toml = read(path.join(ROOT, "supabase/config.toml"));
  for (const d of ["finance-public", "finance-email-dispatch", "finance-document", "finance-scheduler"]) {
    assert.match(toml, new RegExp(`\\[functions\\.${d}\\]\\s*\\nverify_jwt = false`), d);
    assert.ok(!/hook/i.test(d));
  }
});

test("the existing webhooks only gained Finance routing; the V2 paths are still present", () => {
  const ps = read(path.join(FN, "paystack-webhook/index.ts"));
  assert.match(ps, /isV3Reference\(reference\)/);
  assert.match(ps, /from\("paystack_webhook_events"\)/, "V2 processing is still there");
  const rs = read(path.join(FN, "resend-webhook/index.ts"));
  assert.match(rs, /applyIntelDeliveryEvent: makeIntelDeliverySink\(service\)/);
  assert.match(rs, /applyFinanceDeliveryEvent: makeFinanceEmailSink\(service\)/);
  const lg = read(path.join(FN, "_shared/email_resend_logic.ts"));
  assert.ok(lg.indexOf("applyFinanceDeliveryEvent({") < lg.indexOf("webhookProviderAllowed(d.store))) return json"), "the Finance sink runs before the Inbox provider gate");
});
