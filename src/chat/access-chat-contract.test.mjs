import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(resolve(root, p), "utf8");
const access = read("supabase/migrations/20261102090000_access_overrides_directory_privacy.sql");
const portal = read("supabase/migrations/20261102100000_portal_guest_client_chat.sql");
const edge = read("supabase/functions/portal-chat/index.ts");
const chatSources = readdirSync(resolve(root, "src/chat")).filter((f) => /\.(jsx|js)$/.test(f) && !f.includes(".test.")).map((f) => [f, read(`src/chat/${f}`)]);

test("new migrations never open a table with a permissive policy", () => {
  for (const sql of [access, portal]) {
    assert.ok(!/using\s*\(\s*true\s*\)/i.test(sql), "no USING (true)");
    assert.ok(!/with\s+check\s*\(\s*true\s*\)/i.test(sql), "no WITH CHECK (true)");
    assert.ok(!/to\s+anon\b/i.test(sql.replace(/revoke[^;]*;/gi, "")), "nothing is granted to anon");
  }
});

test("every portal table has RLS enabled and direct access revoked", () => {
  const tables = [...portal.matchAll(/create table if not exists public\.(portal_\w+)/gi)].map((m) => m[1]);
  assert.ok(tables.length >= 8);
  const loop = portal.match(/foreach t in array array\[([^\]]+)\] loop([\s\S]*?)end loop/i);
  assert.ok(loop, "RLS loop present");
  assert.ok(/enable row level security/i.test(loop[2]) && /revoke all on public\.%I from public, anon, authenticated/i.test(loop[2]));
  for (const table of tables) assert.ok(loop[1].includes(`'${table}'`), `${table} covered by the RLS loop`);
  assert.ok(!/create policy/i.test(portal), "no policies: tables are reachable only through definer functions");
});

test("gateway-only portal functions are granted to service_role only", () => {
  const block = portal.slice(portal.lastIndexOf("-- Grants: service functions"));
  const service = block.match(/foreach f in array array\[([\s\S]*?)\] loop([\s\S]*?)end loop/i);
  assert.ok(/revoke all on function public\.%s from public, anon, authenticated/i.test(service[2]));
  assert.ok(/grant execute on function public\.%s to service_role'/i.test(service[2]));
  assert.ok(!/authenticated, service_role/.test(service[2]));
  for (const fn of ["portal_guest_claim", "portal_guest_resolve", "portal_client_resolve", "portal_thread_messages", "portal_post_message", "portal_get_attachment", "portal_rate_limit"]) {
    assert.ok(service[1].includes(`'${fn}(`), `${fn} is service_role only`);
  }
});

test("security-definer functions pin search_path", () => {
  for (const sql of [access, portal]) {
    const defs = sql.split(/create or replace function/i).slice(1).filter((d) => /security definer/i.test(d.split("$$")[0]));
    assert.ok(defs.length > 5);
    for (const def of defs) assert.ok(/set search_path\s*=\s*pg_catalog,\s*public/i.test(def.split("$$")[0]), def.slice(0, 60));
  }
});

test("tokens are stored only as hashes and guest invites expire", () => {
  assert.ok(/token_hash\s+text\s+not null/i.test(portal));
  assert.ok(!/\binvite_token\s+text/i.test(portal));
  assert.ok(/expires_at/i.test(portal));
  assert.ok(/revoked_at/i.test(portal));
});

test("internal notes are never read by the token gateway", () => {
  assert.ok(!/portal_internal_notes/.test(edge));
  const gatewayFns = [...portal.matchAll(/create or replace function public\.(portal_(?:guest_claim|guest_resolve|client_resolve|thread_messages|post_message|get_attachment))\b[\s\S]*?\$\$;/gi)].map((m) => m[0]);
  assert.equal(gatewayFns.length, 6);
  for (const body of gatewayFns) assert.ok(!/portal_internal_notes/.test(body));
});

test("the Edge Function never trusts client-supplied thread ids for token audiences", () => {
  assert.ok(/portal_guest_resolve/.test(edge) && /portal_client_resolve/.test(edge));
  assert.ok(!/SUPABASE_SERVICE_ROLE_KEY.*(console\.log|json\()/.test(edge));
  assert.ok(/magic|sniff|signature/i.test(edge));
});

test("only the Master can create groups or change overrides by default", () => {
  assert.ok(/group_creation_not_permitted/.test(access));
  assert.ok(/master_user_required/.test(access));
  assert.ok(!/insert into public\.studio_member_overrides[^;]*'chat\.create_groups'[^;]*select/i.test(access), "no bulk grant of group creation");
});

test("chat UI never injects raw HTML", () => {
  for (const [file, src] of chatSources) {
    assert.ok(!/dangerouslySetInnerHTML/.test(src), `${file} dangerouslySetInnerHTML`);
    assert.ok(!/\.innerHTML\s*=/.test(src), `${file} innerHTML`);
  }
});

test("external links in messages are http(s) only and noopener", () => {
  const body = read("src/chat/MessageBody.jsx");
  assert.ok(/noopener noreferrer/.test(body));
});

test("the guest invite token travels in the URL fragment and is stripped", () => {
  const page = read("src/chat/GuestChatPage.jsx");
  assert.ok(/location\.hash/.test(page) && /replaceState/.test(page));
  assert.ok(!/searchParams\.get\(["']t["']\)/.test(page));
});
