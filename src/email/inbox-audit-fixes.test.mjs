// Regression tests for the Inbox production-readiness audit (issues A-E). Pure Node: no network, no database.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { syncActiveEmailOrganization } from "./access.js";
import { handleSend, LIMITS } from "../../supabase/functions/_shared/email_resend_logic.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// ---- A: Inbox follows the active studio -------------------------------------------------------------------------------------------------
test("A: syncActiveEmailOrganization sends the selected studio to the database", async () => {
  const calls = [];
  const supabase = { rpc: async (name, args) => { calls.push([name, args]); return { data: args.p_organization_id, error: null }; } };
  assert.equal(await syncActiveEmailOrganization(supabase, " 11111111-1111-4111-8111-111111111111 "), true);
  assert.deepEqual(calls, [["email_set_active_organization", { p_organization_id: "11111111-1111-4111-8111-111111111111" }]]);
});
test("A: syncActiveEmailOrganization skips an empty studio and never throws", async () => {
  let called = 0;
  assert.equal(await syncActiveEmailOrganization({ rpc: async () => { called++; return {}; } }, ""), false);
  assert.equal(await syncActiveEmailOrganization({ rpc: async () => { called++; return {}; } }, null), false);
  assert.equal(called, 0);
  assert.equal(await syncActiveEmailOrganization({ rpc: async () => ({ error: { message: "nope" } }) }, "x"), false);
  assert.equal(await syncActiveEmailOrganization({ rpc: async () => { throw new Error("offline"); } }, "x"), false);
  assert.equal(await syncActiveEmailOrganization(null, "x"), false);
});
test("A: the app syncs the studio BEFORE it enables email access", () => {
  const app = read("../App.jsx");
  const sync = app.indexOf("await syncActiveEmailOrganization(supabase, activeStudioOrganizationId)");
  const enable = app.indexOf("setEmailAccess(emailOk)");
  assert.ok(sync > 0 && enable > sync, "sync must run before setEmailAccess(emailOk)");
  assert.match(app, /\[userId, activeStudioOrganizationId\]\);\s*\n\s*\/\/ Direct entry/, "access check must still re-run when the studio changes");
});
test("A: migration prefers the selected studio, keeps the old fallback and is not callable by anon", () => {
  const sql = read("../../supabase/migrations/20270108100000_email_inbox_active_studio.sql");
  assert.match(sql, /create or replace function public\.email_set_active_organization\(p_organization_id uuid\)/);
  assert.match(sql, /public\.email_can_access\(p_organization_id\)/, "must verify membership of the chosen studio");
  assert.match(sql, /from public\.email_active_organization a\s+join public\.studio_memberships m[\s\S]*m\.role = 'master_user' and m\.status = 'active'/);
  assert.match(sql, /order by exists \(select 1 from public\.email_accounts a where a\.organization_id = m\.organization_id\) desc, m\.created_at/, "fallback kept");
  assert.match(sql, /revoke all on function public\.email_set_active_organization\(uuid\) from public, anon;/);
  assert.match(sql, /grant execute on function public\.email_set_active_organization\(uuid\) to authenticated;/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all on table public\.email_active_organization from public, anon, authenticated;/);
  assert.match(sql, /security definer set search_path = pg_catalog, public/);
});

// ---- B: the 500-row cap is visible ------------------------------------------------------------------------------------------------------
test("B: reaching the row cap shows a notice instead of silently dropping Load more", () => {
  const list = read("./components/ConversationList.jsx");
  assert.match(list, /capped && !hasMore/);
  assert.match(list, /Showing the newest \{cap\} conversations/);
  const inbox = read("./InboxModule.jsx");
  assert.match(inbox, /capped=\{rows\.length >= MAX_ROWS\} cap=\{MAX_ROWS\}/);
});

// ---- C: search indexes ------------------------------------------------------------------------------------------------------------------
test("C: trigram indexes cover every column email_list_conversations searches", () => {
  const sql = read("../../supabase/migrations/20270108110000_email_inbox_search_trigram_indexes.sql");
  for (const [table, col] of [["email_messages", "body_text"], ["email_conversations", "subject"], ["email_conversations", "snippet"], ["email_participants", "email"], ["email_participants", "name"]]) {
    assert.match(sql, new RegExp(`on public\\.${table} using gin \\(lower\\(${col}\\) %I\\.gin_trgm_ops\\)`), `${table}.${col}`);
  }
  const search = read("../../supabase/migrations/20261226100000_email_inbox_stable_pagination.sql");
  for (const col of ["c.subject", "c.snippet", "p.email", "p.name", "m.body_text"]) assert.ok(search.includes(`lower(${col}) like v_q`), `search predicate ${col}`);
});

// ---- D: request size is enforced before the body is buffered ---------------------------------------------------------------------------
const deps = (state) => ({
  env: () => undefined, fetch: async () => { throw new Error("no network"); }, now: () => Date.now(),
  authenticate: async () => ({ ok: true, userId: "u", organizationId: "o" }),
  store: new Proxy({}, { get() { state.storeUsed = true; return async () => { throw new Error("store must not be reached"); }; } }),
});
test("D: a declared Content-Length over the limit is refused with 413 without reading the body", async () => {
  const state = {};
  let pulls = 0;   // a ReadableStream pre-fills one chunk on construction; a handler that drained it would pull many more
  const chunk = new Uint8Array(1024 * 1024).fill(97);
  const body = new ReadableStream({ pull(c) { pulls++; c.enqueue(chunk); } });
  const req = new Request("https://x/functions/v1/email-send", { method: "POST", headers: { authorization: "Bearer good", "content-length": String(LIMITS.maxRequestBytes + 1) }, body, duplex: "half" });
  const res = await handleSend(req, deps(state));
  assert.equal(res.status, 413);
  assert.equal((await res.json()).code, "request_too_large");
  assert.ok(pulls <= 2, `the stream must not be drained (pulled ${pulls} times)`);
  assert.ok(!state.storeUsed);
});
test("D: an undeclared oversized body is cut off while streaming and refused with 413", async () => {
  const state = {};
  const chunk = new Uint8Array(1024 * 1024).fill(97);
  let sent = 0;
  const body = new ReadableStream({ pull(c) { if (sent >= 40) return c.close(); sent++; c.enqueue(chunk); } });
  const req = new Request("https://x/functions/v1/email-send", { method: "POST", headers: { authorization: "Bearer good" }, body, duplex: "half" });
  const res = await handleSend(req, deps(state));
  assert.equal(res.status, 413);
  assert.ok(sent <= LIMITS.maxRequestBytes / (1024 * 1024) + 2, `read ${sent} MiB before stopping`);
  assert.ok(!state.storeUsed);
});
test("D: a normal request body still parses (invalid JSON stays a 400, not a 413)", async () => {
  const res = await handleSend(new Request("https://x", { method: "POST", headers: { authorization: "Bearer good" }, body: "{not json" }), deps({}));
  assert.equal(res.status, 400);
});

// ---- E: attachment tab is opened inside the click ---------------------------------------------------------------------------------------
test("E: the attachment window is opened before the first await and closed on failure", () => {
  const src = read("./components/EmailMessage.jsx");
  const early = src.indexOf('window.open("about:blank", "_blank")');
  const wait = src.indexOf("await emailApi.attachmentUrl");
  assert.ok(early > 0 && wait > early, "window.open must come before the await");
  assert.match(src, /win\.opener = null; win\.location\.href = url;/);
  assert.match(src, /win\?\.close\(\)/);
  assert.match(src, /else window\.open\(url, "_blank", "noopener"\)/, "popup-blocked fallback");
});
