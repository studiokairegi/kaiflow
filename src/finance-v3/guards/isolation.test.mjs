// Finance V3 isolation guards. These tests protect the Phase 1 rules in
// docs/finance-v3/FINANCE_V3_MASTER_ARCHITECTURE.md (section 12):
//   * V2 stays byte-for-byte intact until a deliberate, documented cutover.
//   * V3 code never imports V2 code, and nothing outside V3 imports V3 before Phase 5/6.
//   * V3 migrations never alter, drop or write V2 / legacy tables and sort after every
//     existing migration.
//   * Phase 1 (rev. 1.1): the existing Resend / Inbox / Intelligence / Paystack infrastructure is hash-pinned
//     (docs/finance-v3/integration-baseline.sha256), no second Paystack or Resend webhook processor may be
//     created, and V3 migrations never alter or write the protected integration tables.
// When a later phase legitimately changes a guarded item, update the guard in the SAME
// change and say so in that phase's handoff. Never loosen a guard silently.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  V2_PROTECTED_TABLES, MIGRATION_NAME_MARKER,
  PROTECTED_INTEGRATION_TABLES, PROTECTED_INTEGRATION_TABLE_PREFIXES,
  ALLOWED_PAYSTACK_WEBHOOK_FUNCTIONS, ALLOWED_RESEND_WEBHOOK_FUNCTIONS,
} from "../contracts/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p) => fs.readFileSync(path.join(root, p));
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out); else out.push(rel);
  }
  return out;
};

test("V2 baseline: every Finance V2 artifact is byte-identical to the Phase 1 snapshot", () => {
  const manifest = read("docs/finance-v3/v2-baseline.sha256").toString("utf8").trim().split("\n");
  assert.ok(manifest.length >= 20, "manifest should list the V2 files");
  for (const line of manifest) {
    const [hash, file] = line.split(/\s{2}/);
    const actual = crypto.createHash("sha256").update(read(file)).digest("hex");
    assert.equal(actual, hash, `${file} changed since the Phase 1 snapshot`);
  }
});

test("V2 baseline: no new file appeared inside src/finance (V2 is frozen)", () => {
  const listed = new Set(read("docs/finance-v3/v2-baseline.sha256").toString("utf8").trim().split("\n").map((l) => l.split(/\s{2}/)[1]));
  for (const f of walk("src/finance")) assert.ok(listed.has(f), `${f} is not in the V2 baseline manifest`);
});

test("V3 source never imports V2 finance code, App.jsx, or the payments, email or intelligence modules", () => {
  const bad = [];
  for (const f of walk("src/finance-v3").filter((p) => /\.(js|jsx|mjs|ts|tsx)$/.test(p) && !p.includes("/guards/"))) {
    const src = read(f).toString("utf8");
    for (const m of src.matchAll(/(?:import|from)\s*\(?\s*["']([^"']+)["']/g)) {
      if (/(^|\/)finance\//.test(m[1]) || /App(\.jsx)?$/.test(m[1]) || /\/payments\//.test(m[1]) || /\/email\//.test(m[1]) || /\/intelligence\//.test(m[1])) bad.push(`${f}: ${m[1]}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("nothing outside src/finance-v3 imports V3 yet (integration is Phase 5/6 work)", () => {
  const offenders = walk("src")
    .filter((p) => /\.(js|jsx|mjs)$/.test(p) && !p.startsWith("src/finance-v3/"))
    .filter((p) => /finance-v3/.test(read(p).toString("utf8")) && !p.endsWith(".test.mjs"));
  assert.deepEqual(offenders, [], "Phase 1 must not wire V3 into the running app");
});

test("V3 migrations: named finance_v3, sort after all other migrations, never touch V2/legacy tables", () => {
  const all = fs.readdirSync(path.join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
  const v3 = all.filter((f) => f.includes(`_${MIGRATION_NAME_MARKER}_`));
  const others = all.filter((f) => !v3.includes(f));
  const maxOther = others[others.length - 1].slice(0, 14);
  const tables = V2_PROTECTED_TABLES.join("|");
  const forbidden = new RegExp(
    `\\b(drop\\s+table|alter\\s+table|truncate|delete\\s+from|insert\\s+into|update|create\\s+(?:or\\s+replace\\s+)?trigger[^;]*?\\bon)\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(?:public\\.)?(${tables})\\b`, "i");
  const integTables = PROTECTED_INTEGRATION_TABLES.join("|");
  const integPrefixes = PROTECTED_INTEGRATION_TABLE_PREFIXES.join("|");
  const forbiddenIntegration = new RegExp(
    `\\b(drop\\s+table|alter\\s+table|truncate|delete\\s+from|insert\\s+into|update|create\\s+(?:or\\s+replace\\s+)?trigger[^;]*?\\bon)\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(?:public\\.)?(?:(?:${integTables})\\b|(?:${integPrefixes})[a-z0-9_]+)`, "i");
  for (const f of v3) {
    assert.ok(f.slice(0, 14) > maxOther, `${f} must be timestamped after the newest existing migration (${maxOther})`);
    const sql = read(`supabase/migrations/${f}`).toString("utf8");
    assert.doesNotMatch(sql, forbidden, `${f} modifies a protected V2/legacy table`);
    assert.doesNotMatch(sql, forbiddenIntegration, `${f} modifies a protected Resend/Inbox/Intelligence/Paystack table`);
  }
  // Phase 1 itself ships no migration at all.
  assert.ok(v3.length >= 0);
});

test("no secrets or env files were introduced under V3 paths", () => {
  for (const f of [...walk("src/finance-v3"), ...walk("docs/finance-v3"), ...walk("supabase/tests/finance_v3")]) {
    assert.ok(!/(^|\/)\.env/.test(f), f);
    const txt = read(f).toString("utf8");
    assert.doesNotMatch(txt, /sk_live_[A-Za-z0-9]{8,}|sk_test_[A-Za-z0-9]{12,}|re_[A-Za-z0-9]{20,}|whsec_[A-Za-z0-9+\/=]{16,}|eyJhbGciOi[A-Za-z0-9_-]{30,}|service_role\s*[:=]\s*["'][A-Za-z0-9._-]{20,}/, f);
  }
});

test("integration baseline: Resend, Inbox, Intelligence transport and Paystack files are byte-identical to the Phase 1 snapshot", () => {
  const manifest = read("docs/finance-v3/integration-baseline.sha256").toString("utf8").trim().split("\n");
  assert.ok(manifest.length >= 50, "manifest should list the integration files");
  for (const line of manifest) {
    const [hash, file] = line.trim().split(/\s{2}/);
    const actual = crypto.createHash("sha256").update(read(file)).digest("hex");
    assert.equal(actual, hash, `${file} changed since the Phase 1 integration snapshot. If a phase legitimately changed it ` +
      "(Phase 3: paystack-webhook router, resend-webhook sink, config.toml entries), update the manifest in the same change and say so in the handoff.");
  }
});

test("integration baseline: pins the files that carry the one Paystack webhook and the one shared Resend webhook", () => {
  const files = new Set(read("docs/finance-v3/integration-baseline.sha256").toString("utf8").trim().split("\n").map((l) => l.trim().split(/\s{2}/)[1]));
  for (const f of [
    "supabase/functions/paystack-webhook/index.ts", "supabase/functions/_shared/paystack_core.ts",
    "supabase/functions/resend-webhook/index.ts", "supabase/functions/_shared/email_adapter_resend.ts",
    "supabase/functions/_shared/email_resend_logic.ts", "supabase/functions/intel-resend-send/index.ts",
    "supabase/functions/intel-resend-webhook/index.ts", "supabase/functions/email-send/index.ts",
  ]) assert.ok(files.has(f), `${f} is not pinned`);
});

test("no second Paystack or Resend webhook processor exists (extend the existing handler instead)", () => {
  const dirs = fs.readdirSync(path.join(root, "supabase/functions"), { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "_shared").map((e) => e.name);
  const paystackHooks = dirs.filter((d) => /paystack/i.test(d) && /(web)?hook/i.test(d));
  const resendHooks = dirs.filter((d) => /resend/i.test(d) && /(web)?hook/i.test(d));
  assert.deepEqual(paystackHooks.sort(), [...ALLOWED_PAYSTACK_WEBHOOK_FUNCTIONS].sort(), "only paystack-webhook may process Paystack events");
  assert.deepEqual(resendHooks.sort(), [...ALLOWED_RESEND_WEBHOOK_FUNCTIONS].sort(), "no new Resend webhook processor may be added");
  // Finance functions with their own purposes are fine, but none may be a webhook for either provider.
  const finance = dirs.filter((d) => /^finance/i.test(d));
  for (const d of finance) assert.ok(!/hook/i.test(d), `${d}: Finance must route through the existing webhook handlers`);
});

test("V3 payment references cannot be confused with legacy references", () => {
  // Kept here as well as in contracts.test.mjs so a change to either prefix list fails the isolation suite.
  const src = read("src/finance-v3/contracts/index.js").toString("utf8");
  assert.match(src, /V3_PAYMENT_REFERENCE_PREFIX = "KRL3-"/);
  for (const legacy of ["KRL-L-", "KRL-T-", "KRL-W-"]) assert.ok(!"KRL3-".startsWith(legacy));
});
