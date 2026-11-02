import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");
const sql = read("supabase/migrations/20261107090000_portal_reply_reactions.sql");
const edge = read("supabase/functions/portal-chat/index.ts");
const surface = read("src/chat/PortalChatSurface.jsx");
const inbox = read("src/chat/PortalInbox.jsx");
const portalApi = read("src/chat/portalApi.js");

test("portal reactions table is private: RLS on, direct access revoked, one row per person+emoji", () => {
  assert.match(sql, /create table if not exists public\.portal_reactions/);
  assert.match(sql, /alter table public\.portal_reactions enable row level security/);
  assert.match(sql, /revoke all on public\.portal_reactions from public, anon, authenticated/);
  assert.match(sql, /unique \(message_id, reactor_key, reaction\)/);
  assert.doesNotMatch(sql, /create policy/i);
});

test("both portal writers reject a reply target from another thread", () => {
  const guard = sql.match(/r\.id = p_reply_to_id and r\.thread_id = p_thread_id/g) || [];
  assert.equal(guard.length, 2, "portal_post_message and portal_staff_send must both check the thread");
  assert.match(sql, /drop function if exists public\.portal_post_message\(uuid, text, uuid, text, text, text, jsonb\)/);
  assert.match(sql, /drop function if exists public\.portal_staff_send\(uuid, text, text, jsonb\)/);
});

test("reaction writes check the message belongs to the resolved thread and are bounded", () => {
  assert.match(sql, /m\.id = p_message_id and m\.thread_id = p_thread_id and m\.deleted_at is null/);
  assert.match(sql, /too_many_reactions/);
  assert.match(sql, /\[\[:cntrl:\]\]/);
  assert.match(sql, /portal_staff_assert_thread\(v_thread\)/);
});

test("gateway-only functions are service-role only; staff functions need a signed-in user", () => {
  const serviceBlock = sql.match(/foreach f in array array\[\s*'portal_reply_preview[\s\S]*?\] loop[\s\S]*?end loop;/)[0];
  assert.match(serviceBlock, /portal_set_reaction\(uuid,uuid,text,text,text,boolean\)/);
  assert.match(serviceBlock, /to service_role/);
  assert.doesNotMatch(serviceBlock, /to authenticated/);
  assert.match(sql, /'portal_staff_set_reaction\(uuid,text,boolean\)'/);
});

test("gateway resolves the thread from the credential for react and validates ids", () => {
  const react = edge.slice(edge.indexOf('if (action === "react")'), edge.indexOf('// ---- download'));
  assert.match(react, /mode === "staff"\) throw new HttpError\(400/);
  assert.match(react, /p_thread_id: threadId/);
  assert.doesNotMatch(react, /fields\.thread_id/);
  assert.match(react, /UUID\.test\(messageId\)/);
  assert.match(react, /portal_react_/); // rate limited
  assert.match(edge, /UUID\.test\(replyToId\)/);
  assert.equal((edge.match(/p_reply_to_id: replyToId/g) || []).length, 2);
  assert.match(edge, /guest:\$\{sessionId\}/); // guests are told apart by session, never by display name
});

test("client, guest, freelancer and staff UIs wire reply-quote and reactions", () => {
  for (const api of ["guestApi", "clientApi", "freelancerApi"]) assert.match(portalApi, new RegExp(`export const ${api}[\\s\\S]*?react:`));
  assert.match(portalApi, /reply_to_id: replyToId/);
  for (const source of [surface, inbox]) {
    assert.match(source, /reply: \(m\) =>/);
    assert.match(source, /react:/);
    assert.match(source, /row\.reply_to/);
    assert.match(source, /row\.reactions/);
    assert.match(source, /replyTo=\{replyTo\}/);
    assert.match(source, /jumpId=\{jumpId\}/);
  }
});


const identityMigration = read("supabase/migrations/20261108090000_portal_message_participant_identity.sql");

test("client and freelancer message ownership uses stable participant identity, never display names", () => {
  assert.match(identityMigration, /add column if not exists sender_participant_id uuid/i);
  assert.match(identityMigration, /m\.sender_participant_id = p_viewer_participant_id/);
  assert.match(identityMigration, /returns table \([\s\S]*?mine boolean/);
  assert.match(surface, /const isMine = useCallback\(\(row\) => row\.mine === true, \[\]\)/);
  assert.doesNotMatch(surface, /row\.sender_kind === selfKind[\s\S]{0,160}sender_label/);
});

test("participant identity is required on client/freelancer send and reaches the database", () => {
  assert.match(edge, /action === "list" \|\| action === "send" \|\| action === "react"/);
  assert.match(edge, /p_sender_participant_id: mode === "client" \|\| mode === "freelancer" \? participantId : null/);
  assert.match(edge, /p_viewer_participant_id: mode === "client" \|\| mode === "freelancer" \? participantId : null/);
  assert.match(portalApi, /mode: "client", action: "send"[\s\S]*?participant_id: participantId/);
  assert.match(portalApi, /mode: "freelancer", action: "send"[\s\S]*?participant_id: participantId/);
  assert.match(read("src/chat/ClientPortalChat.jsx"), /remote\.send\(token, label, body, key, files, replyToId, participantId\)/);
});

test("participant-aware idempotency and function permissions are preserved", () => {
  assert.match(identityMigration, /coalesce\(sender_user_id::text, guest_session_id::text, sender_participant_id::text, 'client'\)/);
  assert.match(identityMigration, /portal_post_message\(uuid, text, uuid, text, text, text, jsonb, uuid, uuid\)/);
  assert.match(identityMigration, /grant execute on function public\.portal_post_message[\s\S]*?to service_role/i);
  assert.match(identityMigration, /grant execute on function public\.portal_thread_messages[\s\S]*?to service_role/i);
});
