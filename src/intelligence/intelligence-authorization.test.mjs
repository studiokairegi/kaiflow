import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canAccessIntelligence, loadIntelligenceAccess, guardIntelligenceWorkspace } from "./access.js";
import { allowedWorkspaceKeys, STUDIO_MODULES } from "../studio/access.js";
import { canAccessPayments } from "../payments/access.js";
import { requireIntelligenceAdmin } from "../../supabase/functions/_shared/intel_auth.ts";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

// ------------------------------------------------------------ UI gate
test("canAccessIntelligence: only a literal true opens it", () => {
  assert.equal(canAccessIntelligence(true), true);
  for (const v of [null, undefined, false, "true", 1, {}, [], { isAdmin: true }, { is_admin: true, role: "master_user" }]) {
    assert.equal(canAccessIntelligence(v), false);
  }
});

test("loadIntelligenceAccess: asks the database rpc and fails closed on everything but true", async () => {
  const mk = (result) => ({ rpc: async (name) => { assert.equal(name, "intel_is_authorized"); return result; } });
  assert.equal(await loadIntelligenceAccess(mk({ data: true, error: null }), "u1"), true);
  for (const r of [{ data: false, error: null }, { data: null, error: null }, { data: "true", error: null }, { data: 1, error: null }, { data: true, error: { message: "x" } }]) {
    assert.equal(await loadIntelligenceAccess(mk(r), "u1"), false);
  }
  assert.equal(await loadIntelligenceAccess({ rpc: async () => { throw new Error("network"); } }, "u1"), false);
  assert.equal(await loadIntelligenceAccess(mk({ data: true, error: null }), null), false);
  assert.equal(await loadIntelligenceAccess(null, "u1"), false);
});

test("loadIntelligenceAccess: sends no client-supplied identity or flags", async () => {
  let args;
  await loadIntelligenceAccess({ rpc: async (...a) => { args = a; return { data: true, error: null }; } }, "forged-user");
  assert.deepEqual(args, ["intel_is_authorized"]);
});

test("guardIntelligenceWorkspace: direct entry falls back to the dashboard unless allowed", () => {
  assert.equal(guardIntelligenceWorkspace("intelligence", null), "dashboard");
  assert.equal(guardIntelligenceWorkspace("intelligence", false), "dashboard");
  assert.equal(guardIntelligenceWorkspace("intelligence", true), "intelligence");
  assert.equal(guardIntelligenceWorkspace("leads", false), "leads");
});

// ------------------------------------------------------------ wiring in App.jsx
test("App.jsx: Intelligence lives INSIDE the CRM module (a CRM sub-tab), not as a top-level module, and renders only when authorized", () => {
  const app = read("../App.jsx");
  // not a top-level workspace tab any more
  assert.ok(!/workspace === "intelligence"/.test(app), "no top-level 'intelligence' workspace remains");
  assert.ok(!/setWorkspace\("intelligence"\)/.test(app));
  // the CRM sub-tab bar offers it only to the authorized admin
  assert.match(app, /\["portfolio", "Portfolio"\], \.\.\.\(canAccessIntelligence\(intelAccess\) \? \[\["intelligence", "Intelligence"\]\] : \[\]\)/);
  // rendered only on the leads (CRM) workspace, on its own sub-tab, and only when allowed
  assert.match(app, /workspace === "leads" && crmTab === "intelligence" && canAccessIntelligence\(intelAccess\) && <IntelligenceModule/);
  // a denied or revoked permission can never leave the user parked on that sub-tab
  assert.match(app, /crmTab === "intelligence" && intelAccess === false\) setCrmTab\("pipeline"\)/);
  // notification click-through opens CRM > Intelligence
  assert.match(app, /setWorkspace\("leads"\);\s*setCrmTab\("intelligence"\);/);
  assert.match(app, /loadIntelligenceAccess\(supabase, userId\)/);
});

// ------------------------------------------------------------ other permissions untouched
test("existing permissions: Payments and studio module keys are unchanged", () => {
  assert.equal(canAccessPayments({ isAdmin: true }), true);
  assert.equal(canAccessPayments({ isAdmin: false }), false);
  assert.ok(!STUDIO_MODULES.includes("intelligence"), "Intelligence is not a general studio module");
  const master = allowedWorkspaceKeys({ role: "master_user", is_member: true });
  assert.ok(!master.includes("intelligence"), "a Master User alone never gets the Intelligence key");
});

// ------------------------------------------------------------ migration contract
test("migration: strict AND rule, fail-closed, locked-down grants, no data changes", () => {
  const sql = read("../../supabase/migrations/20261109090000_intelligence_authorization.sql");
  const code = sql.replace(/--.*$/gm, "");
  assert.match(code, /s\.is_admin is true/);
  assert.match(code, /m\.role = 'master_user'/);
  assert.match(code, /m\.status = 'active'/);
  assert.match(code, /\)\s*and exists \(/, "the two conditions are joined with AND");
  assert.ok(!/\bor\s+exists\b/i.test(code), "no OR path between the two conditions");
  assert.match(code, /exception when others then\s*return false/);
  assert.match(code, /revoke all on function public\.intel_is_authorized\(\) from public, anon/);
  assert.match(code, /grant execute on function public\.intel_is_authorized\(\) to authenticated/);
  assert.ok(!/grant execute[^;]*\bto\s+(anon|public)\b/i.test(code), "never granted to anon/public");
  assert.ok(!/\b(insert\s+into|update\s+public|delete\s+from|create\s+table|alter\s+table|drop\s+policy|drop\s+table|truncate)\b/i.test(code), "no table, policy or row changes");
  assert.ok(!/payments_is_admin|chat_is_org_master/.test(code.replace(/^\s*--.*$/gm, "")), "does not redefine existing authorization functions");
});

// ------------------------------------------------------------ Edge Function helper
const req = (headers = {}, url = "https://x.test/fn") => new Request(url, { method: "POST", headers, body: "{}" });
function deps({ user = { id: "u1" }, userError = null, rpc = { data: true, error: null }, record = {} } = {}) {
  return {
    url: "https://p.supabase.co", anonKey: "anon-key",
    createClient: (url, key, opts) => {
      record.url = url; record.key = key; record.opts = opts;
      return {
        auth: { getUser: async (jwt) => { record.jwt = jwt; return { data: { user }, error: userError }; } },
        rpc: async (name, ...rest) => { record.rpc = [name, ...rest]; return rpc; },
      };
    },
  };
}

test("edge: allows only an authenticated caller that the database authorizes", async () => {
  const rec = {};
  const r = await requireIntelligenceAdmin(req({ Authorization: "Bearer tok123" }), deps({ record: rec }));
  assert.deepEqual(r, { ok: true, userId: "u1" });
  assert.equal(rec.key, "anon-key", "uses the anon key with the caller JWT, never a service key");
  assert.equal(rec.jwt, "tok123");
  assert.deepEqual(rec.rpc, ["intel_is_authorized"]);
});

test("edge: denies missing/invalid auth, DB denial, rpc errors, and thrown errors (fail closed)", async () => {
  const h = { Authorization: "Bearer tok" };
  assert.equal((await requireIntelligenceAdmin(req(), deps())).ok, false);
  assert.equal((await requireIntelligenceAdmin(req({ Authorization: "Basic abc" }), deps())).status, 401);
  assert.equal((await requireIntelligenceAdmin(req(h), deps({ user: null }))).status, 401);
  assert.equal((await requireIntelligenceAdmin(req(h), deps({ userError: { message: "bad" } }))).status, 401);
  for (const rpc of [{ data: false, error: null }, { data: null, error: null }, { data: "true", error: null }, { data: true, error: { message: "x" } }]) {
    const r = await requireIntelligenceAdmin(req(h), deps({ rpc }));
    assert.equal(r.ok, false); assert.equal(r.status, 403);
  }
  const boom = { ...deps(), createClient: () => { throw new Error("boom"); } };
  assert.equal((await requireIntelligenceAdmin(req(h), boom)).status, 403);
  assert.equal((await requireIntelligenceAdmin(req(h), { ...deps(), anonKey: undefined })).status, 500);
});

test("edge: forged headers, query string and body claims cannot grant access", async () => {
  const r = await requireIntelligenceAdmin(
    req({ Authorization: "Bearer tok", "x-user-id": "admin", "x-is-admin": "true", "x-role": "master_user" }, "https://x.test/fn?is_admin=true&user_id=admin"),
    deps({ rpc: { data: false, error: null } }),
  );
  assert.equal(r.ok, false); assert.equal(r.status, 403);
});
