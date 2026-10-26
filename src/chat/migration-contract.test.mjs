import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sql = readFileSync(resolve(root, 'supabase/migrations/20261029090000_chat_collaboration.sql'), 'utf8');
const compact = sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').toLowerCase();

function functionBody(name) {
  const start = compact.indexOf(`create or replace function public.${name.toLowerCase()}(`);
  assert.notEqual(start, -1, `expected function ${name} in migration`);
  const end = compact.indexOf('$$;', start);
  assert.notEqual(end, -1, `expected end of function ${name}`);
  return compact.slice(start, end + 3);
}

test('every new protected chat/studio table enables RLS', () => {
  const tables = [
    'studio_organizations', 'studio_memberships', 'studio_departments', 'studio_department_memberships',
    'chat_conversations', 'chat_conversation_members', 'chat_messages', 'chat_read_state',
    'chat_reactions', 'chat_attachments', 'chat_pins', 'chat_message_edits', 'chat_audit_events',
  ];
  for (const table of tables) assert.ok(compact.includes(`alter table public.${table} enable row level security`), table);
});

test('authenticated writes use checked RPCs, not direct inserts/updates/deletes', () => {
  assert.ok(compact.includes('revoke all on public.studio_organizations, public.studio_memberships'));
  assert.ok(compact.includes('grant select on public.studio_organizations, public.studio_memberships'));
  assert.ok(compact.includes('revoke insert, update, delete, truncate, references, trigger on public.chat_messages from authenticated, anon'));
  assert.ok(compact.includes('revoke insert, update, delete, truncate, references, trigger on public.chat_audit_events from authenticated, anon'));
  assert.ok(compact.includes('revoke all on function public.chat_write_audit(uuid,uuid,uuid,text,uuid,jsonb) from public, anon, authenticated'));
});

test('message creation derives its author from the trusted JWT and checks conversation membership', () => {
  const body = functionBody('chat_send_message');
  assert.ok(body.includes('auth.uid() is null'));
  assert.ok(body.includes('not public.chat_can_read_conversation(p_conversation_id)'));
  assert.ok(body.includes('values(p_conversation_id,auth.uid(),v_body,p_reply_to_id,p_idempotency_key,v_fingerprint)'));
  assert.ok(body.includes('idempotency_key_reused'));
  assert.ok(body.includes('string_agg(a.file_name'));
});

test('client identities are rejected from internal conversations and internal chat directory', () => {
  const read = functionBody('chat_can_read_conversation');
  const directory = functionBody('chat_list_directory');
  const create = functionBody('chat_create_conversation');
  assert.ok(read.includes("me.role <> 'client'"));
  assert.ok(directory.includes("m.role <> 'client'"));
  assert.ok(create.includes("m.role<>'client'"));
  assert.ok(compact.includes("audience text not null default 'internal' check (audience = 'internal')"));
});

test('project conversations and invites cannot manufacture project access', () => {
  const access = functionBody('chat_user_can_access_project');
  const create = functionBody('chat_create_conversation');
  const add = functionBody('chat_add_conversation_member');
  assert.ok(access.includes('p.user_id = p_user_id'));
  assert.ok(access.includes("actor.role = 'master_user'"));
  assert.ok(create.includes('public.chat_user_can_access_project(p_organization_id,p_project_id,t.x)'));
  assert.ok(add.includes('public.chat_user_can_access_project(v_conv.organization_id,v_conv.project_id,p_target_user_id)'));
  assert.ok(create.includes('v_project_owner'));
  assert.ok(create.includes('v_master_user'));
  const remove = functionBody('chat_remove_conversation_member');
  assert.ok(remove.includes('project_owner_must_remain_in_project_conversation'));
  const departmentAssignment = functionBody('chat_assign_department_member');
  assert.ok(departmentAssignment.includes('target_must_be_department_admin_role'));
});

test('chat attachment storage stays private and read policies require authorized conversation membership', () => {
  assert.ok(compact.includes("values ('chat-attachments','chat-attachments',false,20971520"));
  assert.ok(compact.includes("create policy chat_attachment_object_select on storage.objects for select to authenticated"));
  assert.ok(compact.includes('public.chat_can_read_conversation(((storage.foldername(name))[1])::uuid)'));
  assert.ok(compact.includes('a.message_id is not null'));
});

test('Master User is not editable through normal member-management RPCs', () => {
  const add = functionBody('chat_add_studio_member');
  const status = functionBody('chat_set_member_status');
  assert.ok(add.includes('not public.chat_is_org_master(p_organization_id)'));
  assert.ok(add.includes("v_existing_role = 'master_user'"));
  assert.ok(add.includes('cannot_change_master_membership'));
  assert.ok(status.includes("v_target.role='master_user' and p_status='suspended'"));
  assert.ok(compact.includes("on public.studio_memberships(organization_id) where role = 'master_user' and status = 'active'"));
});

test('private Realtime topics are conversation-authorized and messages remain persisted in PostgreSQL', () => {
  assert.ok(compact.includes('create or replace function public.chat_realtime_topic_allowed(p_topic text)'));
  assert.ok(compact.includes('return public.chat_can_read_conversation(v_id::uuid)'));
  assert.ok(compact.includes("'alter publication supabase_realtime add table public.chat_messages'"));
});
