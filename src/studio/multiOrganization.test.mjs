import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const chatMigration = readFileSync(resolve(root, 'supabase/migrations/20261029090000_chat_collaboration.sql'), 'utf8');
const coreMigration = readFileSync(resolve(root, 'supabase/migrations/20261030090000_studio_multiuser_core.sql'), 'utf8');
const inviteMigration = readFileSync(resolve(root, 'supabase/migrations/20261031090000_studio_team_invites_and_bootstrap.sql'), 'utf8');
const multiOrgMigration = readFileSync(resolve(root, 'supabase/migrations/20261031100000_multi_organization_memberships.sql'), 'utf8');
const app = readFileSync(resolve(root, 'src/App.jsx'), 'utf8');
const teamAccess = readFileSync(resolve(root, 'src/studio/TeamAccessPanel.jsx'), 'utf8');
const chatPage = readFileSync(resolve(root, 'src/chat/ChatPage.jsx'), 'utf8');
const chatApi = readFileSync(resolve(root, 'src/chat/api.js'), 'utf8');

const compact = (value) => value.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').toLowerCase();
const chatSql = compact(chatMigration);
const coreSql = compact(coreMigration);
const inviteSql = compact(inviteMigration);
const multiOrgSql = compact(multiOrgMigration);

function getFunctionBody(sql, name) {
  const start = sql.indexOf(`create or replace function public.${name.toLowerCase()}(`);
  assert.notEqual(start, -1, `expected ${name} function`);
  const end = sql.indexOf('$$;', start);
  assert.notEqual(end, -1, `expected ${name} function terminator`);
  return sql.slice(start, end + 3);
}

test('membership identity is unique per organization, not globally per user', () => {
  const memberships = getFunctionBody(chatSql, 'chat_get_my_memberships');
  assert.ok(chatSql.includes('unique (organization_id, user_id)'));
  assert.ok(chatSql.includes('on public.studio_memberships(user_id, status, organization_id)'));
  assert.ok(!/unique\s*\(\s*user_id\s*\)/i.test(chatMigration));
  assert.ok(memberships.includes('where m.user_id = auth.uid() and m.status = \'active\''));
  assert.ok(memberships.includes('select m.organization_id'));
});

test('accepting another studio invite cannot replace a Master User membership elsewhere', () => {
  const accept = getFunctionBody(multiOrgSql, 'studio_accept_team_invite');
  assert.ok(accept.includes("if v_email<>lower(v_inv.invited_email)"), 'bind acceptance to the invited email');
  assert.ok(accept.includes('lower(btrim(tm.email))=v_email'), 'bind membership to the matching existing Teams roster entry');
  assert.ok(!accept.includes("raise exception 'account_already_in_studio'"), 'cross-organization membership is allowed');
  assert.ok(!accept.includes('m.organization_id<>v_inv.organization_id'), 'no cross-org rejection remains');
  assert.ok(accept.includes("if v_existing_role='master_user' then raise exception 'cannot_replace_master_membership'"), 'do not downgrade a Master User inside the target studio');
  assert.ok(accept.includes('where m.organization_id=v_inv.organization_id and m.user_id=v_user'), 'only inspect existing membership in the invited organization');
  assert.ok(accept.includes('on conflict(organization_id,user_id) do update'), 'upsert is scoped to organization + user');
  assert.ok(!accept.includes('delete from public.studio_memberships'), 'never delete memberships');
  assert.ok(!accept.includes('update public.studio_memberships m set'), 'never rewrite memberships in other organizations');
  assert.ok(!accept.includes('insert into public.studio_data_owners'), 'invite acceptance must not transfer or remap workspace ownership');
  assert.ok(multiOrgSql.includes('revoke all on function public.studio_accept_team_invite(text) from public, anon'));
  assert.ok(multiOrgSql.includes('grant execute on function public.studio_accept_team_invite(text) to authenticated'));
});

test('invite acceptance serializes same-studio races but leaves different organizations independent', () => {
  const accept = getFunctionBody(multiOrgSql, 'studio_accept_team_invite');
  assert.ok(accept.includes('pg_advisory_xact_lock(hashtext(v_inv.organization_id::text), hashtext(v_user::text))'));
  assert.ok(accept.includes('for update'), 'the invite row itself is locked for one-time consumption');
  assert.ok(accept.includes("update public.studio_member_invites set status='accepted'"));
});

test('one-active-Master constraint remains scoped to an organization', () => {
  assert.ok(chatSql.includes('on public.studio_memberships(organization_id) where role = \'master_user\' and status = \'active\''));
  assert.ok(!chatSql.includes('unique index') || chatSql.includes('studio_memberships_one_master_per_org_idx'));
  assert.ok(multiOrgSql.includes("if v_existing_role='master_user' then raise exception 'cannot_replace_master_membership'"));
});

test('organization-specific access context authorizes only the requested organization', () => {
  const context = getFunctionBody(multiOrgSql, 'studio_get_app_access_context_for_org');
  assert.ok(context.includes('where m.organization_id = p_organization_id'));
  assert.ok(context.includes('and m.user_id = auth.uid()'));
  assert.ok(context.includes("and m.status = 'active'"));
  assert.ok(context.includes('where o.organization_id = p_organization_id'), 'owner IDs are collected from the selected studio only');
  assert.ok(context.includes("master.role = 'master_user'"), 'primary owner is chosen from the selected organization');
  assert.ok(multiOrgSql.includes('revoke all on function public.studio_get_app_access_context_for_org(uuid) from public, anon'));
  assert.ok(multiOrgSql.includes('grant execute on function public.studio_get_app_access_context_for_org(uuid) to authenticated'));
});

test('organization switching scopes loaded records and fails closed when no membership context is available', () => {
  assert.ok(app.includes('kf-active-studio:${userId}'));
  assert.ok(app.includes('studio_get_app_access_context_for_org'));
  assert.ok(app.includes('studioMemberships.length > 1'));
  assert.ok(app.includes('studioAccess?.is_member === true'));
  assert.ok(app.includes('studioAccess === null && !inviteToken ? null : []'));
  assert.ok(app.includes('scopeOwnedQuery(supabase.from("projects")'));
});

test('admin UI is pinned to the active organization, not the first Master membership globally', () => {
  assert.ok(teamAccess.includes('studioAccess?.organization_id === activeOrganizationId'));
  assert.ok(teamAccess.includes('studioAccess?.role === "master_user"'), 'only the Master User of the active studio can manage access');
  assert.ok(teamAccess.includes('if (!canManage || !activeOrganizationId)'), 'nothing loads outside the active studio');
  assert.ok(app.includes('activeOrganizationId={activeStudioOrganizationId}'));
  assert.ok(app.includes('canManageRoster={studioAccess === null || (studioAccess?.is_member === true && studioAccess.role === "master_user")}'));
});

test('chat follows the selected organization and refreshes membership context there', () => {
  assert.ok(app.includes('activeOrganizationId={activeStudioOrganizationId}'));
  assert.ok(app.includes('onOrganizationChange={handleSwitchStudio}'));
  assert.ok(chatPage.includes('activeOrganizationId'));
  assert.ok(chatPage.includes('onOrganizationChange'));
  assert.ok(chatApi.includes('myAppAccessContext(organizationId = null)'));
  assert.ok(chatApi.includes('studio_get_app_access_context_for_org'));
});

test('legacy standalone signup and existing workspace-owner mapping are unchanged', () => {
  const bootstrap = getFunctionBody(inviteSql, 'studio_bootstrap_new_auth_user');
  assert.ok(bootstrap.includes("if v_token is not null"));
  assert.ok(bootstrap.includes('return new;'));
  assert.ok(bootstrap.includes("values(v_org,new.id,'master_user','active'"));
  assert.ok(bootstrap.includes('public.studio_data_owners'));
  assert.ok(!getFunctionBody(multiOrgSql, 'studio_accept_team_invite').includes('delete from public.studio_data_owners'));
});

 test('finance remains unavailable to non-Master organization context while owner-scoped finance writes stay protected', () => {
  const access = readFileSync(resolve(root, 'src/studio/access.js'), 'utf8');
  assert.ok(access.includes('if (access.role === "master_user" || access.is_master === true) allowed.push("finance")'));
  assert.ok(coreSql.includes('revoke all on public.studio_data_owners from public, anon, authenticated'));
  assert.ok(!multiOrgSql.includes('create policy studio_journal_entries_shared'));
  assert.ok(!multiOrgSql.includes('create policy studio_bank_accounts_shared'));
});
