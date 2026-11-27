// Phase 2: the JS contracts and the SQL migrations must say the same thing. These tests read the migration text,
// so they run in plain `npm test` without a database. (The behaviour itself is proven by supabase/tests/finance_v3/run.sh.)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as c from "./index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const MIG_DIR = path.join(ROOT, "supabase/migrations");
const RB_DIR = path.join(ROOT, "supabase/rollback");
const read = (p) => fs.readFileSync(p, "utf8");
const v3 = fs.readdirSync(MIG_DIR).filter((f) => f.includes("finance_v3") && f.slice(0, 14) < "20270114000000").sort();   // Phase 2 files only; Phase 3 has phase3-parity.test.mjs
const sql = Object.fromEntries(v3.map((f) => [f, read(path.join(MIG_DIR, f))]));
const all = Object.values(sql).join("\n");
const rpcFile = v3.find((f) => f.endsWith("rpc_surface.sql"));
const coreFile = v3.find((f) => f.endsWith("core_schema.sql"));
const engineFile = v3.find((f) => f.endsWith("posting_engine.sql"));

test("Phase 2 ships exactly three ordered, finance_v3-marked migrations after the Phase 1 baseline", () => {
  assert.equal(v3.length, 3);
  assert.ok(coreFile && engineFile && rpcFile);
  assert.deepEqual(v3, [coreFile, engineFile, rpcFile]);
  for (const f of v3) {
    const ts = f.slice(0, 14);
    assert.match(ts, /^\d{14}$/);
    assert.ok(ts > "20270112100000", `${f} must sort after the latest pre-V3 migration`);
  }
});

test("every V3 migration has a rollback script and each is transactional", () => {
  for (const f of v3) {
    const rb = path.join(RB_DIR, f.replace(/\.sql$/, ".rollback.sql"));
    assert.ok(fs.existsSync(rb), `missing rollback for ${f}`);
    assert.match(read(rb), /^begin;/m);
    assert.match(read(rb), /^commit;/m);
    assert.match(sql[f], /^begin;/m);
    assert.match(sql[f], /^commit;/m);
  }
});

test("the public RPC surface is exactly the contract's PHASE2_RPCS", () => {
  const defined = [...sql[rpcFile].matchAll(/create or replace function public\.(fin3_[a-z_]+)\(/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(defined)].sort(), [...c.PHASE2_RPCS].sort());
  assert.equal(defined.length, new Set(defined).size, "no overloaded fin3_ function");
  for (const n of defined) assert.ok(n.startsWith(c.RPC_PREFIX));
  // nothing outside the RPC migration may create a public function
  for (const f of [coreFile, engineFile]) assert.doesNotMatch(sql[f], /create (or replace )?function public\./);
});

test("every RPC is SECURITY DEFINER with a pinned search_path", () => {
  const blocks = sql[rpcFile].split(/create or replace function /).slice(1).filter((b) => b.startsWith("public.fin3_"));
  assert.equal(blocks.length, c.PHASE2_RPCS.length);
  for (const b of blocks) {
    const head = b.slice(0, b.indexOf("$$"));
    assert.match(head, /security definer/, head.split("(")[0]);
    assert.match(head, /set search_path = pg_catalog, finance_v3/, head.split("(")[0]);
  }
});

test("no function anywhere in Phase 2 omits a pinned search_path unless it is a pure JSON/SQL helper", () => {
  const blocks = all.split(/create or replace function /).slice(1);
  for (const b of blocks) {
    const head = b.slice(0, b.indexOf("$$"));
    assert.match(head, /set search_path = pg_catalog, finance_v3/, head.split("(")[0]);
  }
});

test("every raised SQLSTATE is a declared contract error code, and the Phase 2 codes are all used", () => {
  const declared = new Set(Object.values(c.ERROR_CODES));
  const raised = new Set([...all.matchAll(/errcode = '(V3\d{3})'/g)].map((m) => m[1]));
  for (const code of raised) assert.ok(declared.has(code), `${code} raised but not declared in ERROR_CODES`);
  for (const k of ["UNBALANCED_ENTRY", "POSTED_IMMUTABLE", "NOT_AUTHORIZED", "PERIOD_LOCKED", "CURRENCY_MISMATCH", "INVALID_ACCOUNT",
    "NOT_FOUND", "INVALID_INPUT", "ALREADY_REVERSED", "IDEMPOTENCY_CONFLICT", "ORG_NOT_INITIALIZED", "ENTRY_STATE_INVALID", "BASE_CURRENCY_LOCKED"]) {
    assert.ok(raised.has(c.ERROR_CODES[k]), `${k} (${c.ERROR_CODES[k]}) is declared for Phase 2 but never raised`);
  }
});

test("seeded permissions, role defaults and master-only grants match the contract", () => {
  const perms = [...sql[coreFile].matchAll(/\('(finance\.[a-z_]+)',\s+'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(perms)].sort(), [...c.PERMISSIONS].sort());
  const dept = sql[coreFile].match(/'finance_department_admin', k from unnest\(array\[([\s\S]*?)\]\)/)[1];
  assert.deepEqual([...dept.matchAll(/'(finance\.[a-z_]+)'/g)].map((m) => m[1]).sort(), [...c.FINANCE_DEPARTMENT_ADMIN_PERMISSIONS].sort());
  const master = sql[rpcFile].match(/p_permission in \(([^)]*)\)/)[1];
  assert.deepEqual([...master.matchAll(/'(finance\.[a-z_]+)'/g)].map((m) => m[1]).sort(), [...c.MASTER_ONLY_PERMISSIONS].sort());
  assert.match(sql[coreFile], /v_role in \('freelancer', 'client'\) then return false/);
  assert.deepEqual([...c.NO_FINANCE_ACCESS_ROLES].sort(), ["client", "freelancer"]);
  assert.match(sql[coreFile], /in \('finance', 'accounting'\)/);
});

test("seeded event kinds match the contract, including which are enabled and provider-capable", () => {
  const rows = [...sql[coreFile].matchAll(/\('([a-z_]+)',\s*'[^']*',\s*'(finance\.[a-z_]+)',\s*(true|false),\s*(true|false),\s*(\d)\)/g)];
  assert.equal(rows.length, Object.keys(c.EVENT_KINDS).length);
  for (const [, kind, perm, prov, enabled, phase] of rows) {
    const k = c.EVENT_KINDS[kind];
    assert.ok(k, `unknown kind ${kind}`);
    assert.deepEqual([perm, prov === "true", enabled === "true", Number(phase)], [k.permission, k.allowsProvider, k.enabled, k.phase], kind);
  }
  for (const k of Object.values(c.EVENT_KINDS)) assert.ok(c.PERMISSIONS.includes(k.permission));
  // a provider can only ever reach provider-capable kinds, and only those that exist for payments/refunds
  assert.deepEqual(Object.entries(c.EVENT_KINDS).filter(([, v]) => v.allowsProvider).map(([k]) => k).sort(), ["client_payment", "refund_issued"]);
});

test("the default chart has the contract's size, types and system keys", () => {
  const rows = [...sql[coreFile].matchAll(/\('(\d{4})','([^']+)','([a-z_]+)','[^']*',(null|'[a-z_]+'),(null|'\d{4}'),(true|false),(true|false),(\d+)\)/g)];
  assert.equal(rows.length, c.DEFAULT_CHART_ACCOUNT_COUNT);
  const keys = Object.fromEntries(rows.filter((r) => r[4] !== "null").map((r) => [r[4].replace(/'/g, ""), r[1]]));
  assert.deepEqual(keys, { ...c.SYSTEM_ACCOUNT_KEYS });
  assert.deepEqual([...new Set(rows.map((r) => r[3]))].sort(), [...c.ACCOUNT_TYPES].sort());
  const first = { asset: "1", liability: "2", equity: "3", revenue: "4", cost_of_sales: "5", operating_expense: "6", other_income: "7", other_expense: "8" };
  for (const r of rows) assert.equal(r[1][0], first[r[3]], `${r[1]} is outside the ${r[3]} range`);
  assert.equal(new Set(rows.map((r) => r[1])).size, rows.length, "chart codes are unique");
});

test("account types, entry statuses, FX statuses and sources in SQL match the contract", () => {
  const types = sql[coreFile].match(/constraint ck_accounts_type check \(account_type in\s*\(([^)]*)\)/)[1];
  assert.deepEqual([...types.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort(), [...c.ACCOUNT_TYPES].sort());
  assert.match(sql[coreFile], /constraint ck_je_status check \(status in \('draft', 'posted'\)\)/);
  assert.deepEqual([...c.PHYSICAL_ENTRY_STATUS], ["draft", "posted"]);
  for (const s of c.PHYSICAL_ENTRY_STATUS) assert.ok(c.ENTRY_STATUS.includes(s));
  assert.match(sql[coreFile], /fx_status in \('native', 'converted', 'missing', 'estimate'\)/);
  for (const s of c.FX_STATUS) assert.ok(sql[coreFile].includes(`'${s}'`));
  assert.match(sql[coreFile], /source\s+text not null check \(source in \('manual', 'provider', 'import'\)\)/);
  assert.deepEqual([...c.FX_SOURCES], ["manual", "provider", "import"]);
  assert.match(sql[coreFile], /engine\s+text not null default 'v2' check \(engine in \('v2', 'v3'\)\)/);
  assert.match(sql[coreFile], /numeric\(19,4\)/);
  assert.match(sql[coreFile], /numeric\(20,10\)/);
  assert.equal(c.MONEY.storageScale, 4);
});

test("amount and rate wire formats in SQL equal the JS patterns; the limits agree", () => {
  const amt = sql[engineFile].match(/v_amt !~ '([^']+)'/)[1];
  assert.equal(new RegExp(amt).source, c.LINE_AMOUNT_PATTERN.source);
  const rate = sql[rpcFile].match(/p_rate !~ '([^']+)'/)[1];
  assert.equal(new RegExp(rate).source, c.FX_RATE_PATTERN.source);
  assert.match(sql[engineFile], new RegExp(`v_count > ${c.MAX_LINES_PER_ENTRY}`));
  for (const ok of ["1", "0.5", "123456789012345.1234"]) assert.match(ok, c.LINE_AMOUNT_PATTERN);
  for (const bad of ["0.12345", "-1", "1e3", "01", ".5", "1,000", "1234567890123456"]) assert.doesNotMatch(bad, c.LINE_AMOUNT_PATTERN);
});

test("idempotency keys built by the JS helper satisfy the database key rule", () => {
  const dbRule = /^[A-Za-z0-9_.:-]+$/;
  assert.match(sql[coreFile], /idempotency_key ~ '\^\[A-Za-z0-9_\.:-\]\+\$'/);
  for (const kind of ["journal", "journal:reverse", "journal:draft", "pay", "event"]) {
    const key = c.buildIdempotencyKey(kind, "org1", "entry-7");
    assert.match(key, dbRule);
    assert.ok(key.length <= c.IDEMPOTENCY_KEY_MAX);
  }
  assert.match(sql[coreFile], /char_length\(idempotency_key\) between 1 and 200/);
});

test("Phase 2 migrations only touch the finance_v3 schema or the public.fin3_ RPC namespace", () => {
  for (const [f, text] of Object.entries(sql)) {
    const stripped = text.replace(/--.*$/gm, "");
    for (const m of stripped.matchAll(/\b(?:create|alter|drop)\s+(?:or replace\s+)?(?:table|function|trigger|policy|index|view)\s+(?:if (?:not )?exists\s+)?([a-z_0-9.]+)/gi)) {
      const name = m[1].toLowerCase();
      if (name.includes(".")) assert.ok(name.startsWith("finance_v3.") || name.startsWith("public.fin3_"), `${f}: ${name}`);
    }
    // the only legacy tables read are the tenant tables, never written
    for (const m of stripped.matchAll(/\b(insert into|update|delete from)\s+public\.([a-z_]+)/gi)) assert.fail(`${f} writes public.${m[2]}`);
  }
  const legacyReads = new Set([...all.matchAll(/\bpublic\.(studio_[a-z_]+|projects)\b/g)].map((m) => m[1]));
  assert.deepEqual([...legacyReads].sort(), ["projects", "studio_data_owners", "studio_department_memberships", "studio_departments", "studio_memberships", "studio_organizations"]);
});

test("no migration function accepts or names a payment/email provider (providers reach the ledger only via post_event)", () => {
  const rpcHeads = sql[rpcFile].split(/create or replace function public\./).slice(1).map((b) => b.slice(0, b.indexOf(")")));
  for (const h of rpcHeads) assert.doesNotMatch(h, /paystack|resend|webhook|provider|p_kind/i, h);
  assert.doesNotMatch(sql[rpcFile], /grant execute on function finance_v3\.post_event/);
  assert.match(sql[engineFile], /revoke all on function %s from public, anon, authenticated, service_role/);
});

test("the SQL test harness tenant stubs only use columns that exist in the real legacy migrations", () => {
  const stub = read(path.join(ROOT, "supabase/tests/finance_v3/harness/01_tenant_stubs.sql"));
  const real = read(path.join(MIG_DIR, "20261029090000_chat_collaboration.sql")) + read(path.join(MIG_DIR, "20261030090000_studio_multiuser_core.sql"));
  const cols = {
    studio_organizations: ["id", "name", "slug", "created_by"],
    studio_memberships: ["organization_id", "user_id", "role", "status", "display_name"],
    studio_departments: ["id", "organization_id", "name", "created_by"],
    studio_department_memberships: ["organization_id", "department_id", "user_id", "department_role"],
    studio_data_owners: ["user_id", "organization_id"],
  };
  for (const [table, list] of Object.entries(cols)) {
    const decl = real.match(new RegExp(`create table if not exists public\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`, "i"));
    assert.ok(decl, `real definition of ${table} not found`);
    for (const col of list) assert.match(decl[1], new RegExp(`\\b${col}\\b`), `${table}.${col} missing in real migrations`);
    assert.match(stub, new RegExp(`public\\.${table}`));
  }
  assert.match(real, /role text not null check \(role in \('master_user','department_admin','staff','freelancer','client'\)\)/);
  assert.match(real, /department_role text not null default 'member' check \(department_role in \('admin','member'\)\)/);
});

test("the line amount and FX rate patterns equal the regexes used by the database", () => {
  const amount = sql[engineFile].match(/v_amt !~ '([^']+)'/);
  assert.ok(amount, "amount regex not found in the posting engine");
  assert.equal(c.LINE_AMOUNT_PATTERN.source.replace(/\\\./g, "\\."), amount[1].replace(/\\\./g, "\\.").replace(/\[0-9\]/g, "[0-9]"));
  const rate = sql[rpcFile].match(/p_rate !~ '([^']+)'/);
  assert.ok(rate, "rate regex not found in the RPC surface");
  assert.equal(c.FX_RATE_PATTERN.source, rate[1]);
});

test("every unsigned line amount the database accepts, MONEY.amountPattern accepts too (no looser JS rule)", () => {
  for (const ok of ["0", "1", "10.5", "999999999999999.9999"]) assert.match(ok, c.LINE_AMOUNT_PATTERN), assert.match(ok, c.MONEY.amountPattern);
  for (const bad of ["007", "1e3", ".5"]) { assert.doesNotMatch(bad, c.LINE_AMOUNT_PATTERN); assert.doesNotMatch(bad, c.MONEY.amountPattern); }
  assert.doesNotMatch("-1", c.LINE_AMOUNT_PATTERN); // lines are unsigned; MONEY.amountPattern is signed on purpose
});
