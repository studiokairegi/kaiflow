import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const migration = readFileSync(resolve(root, 'supabase/migrations/20261031090000_studio_team_invites_and_bootstrap.sql'), 'utf8');
const compact = migration.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').toLowerCase();
const multiOrgMigration = readFileSync(resolve(root, 'supabase/migrations/20261031100000_multi_organization_memberships.sql'), 'utf8');
const multiOrgCompact = multiOrgMigration.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').toLowerCase();
const app = readFileSync(resolve(root, 'src/App.jsx'), 'utf8');
const access = readFileSync(resolve(root, 'src/studio/access.js'), 'utf8');
const team = readFileSync(resolve(root, 'src/studio/TeamAccessPanel.jsx'), 'utf8');
const settings = readFileSync(resolve(root, 'src/settings/SettingsPage.jsx'), 'utf8');
const chatCss = readFileSync(resolve(root, 'src/chat/chat.css'), 'utf8');

function functionBody(name) {
  const start = compact.indexOf(`create or replace function public.${name.toLowerCase()}(`);
  assert.notEqual(start, -1, `expected ${name} in rollout migration`);
  const end = compact.indexOf('$$;', start);
  assert.notEqual(end, -1, `expected end of ${name}`);
  return compact.slice(start, end + 3);
}

test('invite tokens are random, stored as hashes, expire, and are consumed only once', () => {
  assert.ok(compact.includes('token_hash text not null unique'));
  assert.ok(compact.includes("expires_at timestamptz not null default (now() + interval '7 days')"));
  assert.ok(compact.includes('public.studio_hash_invite_token(p_token)'));
  const create = functionBody('studio_create_team_invite');
  const accept = functionBody('studio_accept_team_invite');
  assert.ok(create.includes('public.studio_hash_invite_token(p_token)'));
  assert.ok(accept.includes("if v_inv.status<>'pending' or v_inv.expires_at<=now()"));
  assert.ok(accept.includes("update public.studio_member_invites set status='accepted'"));
});

test('signup invitation cannot silently bootstrap a different studio for the wrong email', () => {
  const bootstrap = functionBody('studio_bootstrap_new_auth_user');
  assert.ok(bootstrap.includes("lower(i.invited_email)=lower(coalesce(new.email,''))"));
  assert.ok(bootstrap.includes("raise exception 'invite_not_found_or_expired'"));
  assert.ok(bootstrap.includes("values(v_org,new.id,'master_user','active'"));
});

test('final invite acceptance permits multiple organizations without replacing the existing Master User membership', () => {
  const start = multiOrgCompact.indexOf('create or replace function public.studio_accept_team_invite(');
  assert.notEqual(start, -1);
  const end = multiOrgCompact.indexOf('$$;', start);
  assert.notEqual(end, -1);
  const accept = multiOrgCompact.slice(start, end + 3);
  assert.ok(accept.includes("if v_email<>lower(v_inv.invited_email)"));
  assert.ok(accept.includes('lower(btrim(tm.email))=v_email'));
  assert.ok(accept.includes("raise exception 'account_already_linked_to_other_roster'"));
  assert.ok(!accept.includes("raise exception 'account_already_in_studio'"));
  assert.ok(!accept.includes('m.organization_id<>v_inv.organization_id'));
  assert.ok(accept.includes("if v_existing_role='master_user' then raise exception 'cannot_replace_master_membership'"));
  assert.ok(accept.includes('where m.organization_id=v_inv.organization_id and m.user_id=v_user'));
  assert.ok(accept.includes('on conflict(organization_id,user_id) do update'));
  assert.ok(!accept.includes('delete from public.studio_memberships'));
  assert.ok(!accept.includes('update public.studio_memberships m set'));
  assert.ok(!accept.includes('insert into public.studio_data_owners'));
});

test('department modules are opt-in by department, but project and shot access requires explicit project grants', () => {
  const permission = functionBody('studio_user_has_app_permission');
  assert.ok(permission.includes('join public.studio_department_permissions dp'));
  assert.ok(permission.includes('dp.permission_key=p_permission_key'));
  assert.ok(permission.includes("p_permission_key in ('projects.read','projects.write','projects.delete','shots.read','shots.write','shots.delete')"));
  assert.ok(permission.includes('from public.studio_project_members pm'));
  assert.ok(permission.includes('owner_master.role=\'master_user\''));
  assert.ok(permission.includes("if p_permission_key = 'activity.read' and p_project_id is not null"));
});

test('existing shot assignments remain on the roster entry and synchronize project access after invitation acceptance', () => {
  const accept = (() => {
    const start = multiOrgCompact.indexOf('create or replace function public.studio_accept_team_invite(');
    const end = multiOrgCompact.indexOf('$$;', start);
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);
    return multiOrgCompact.slice(start, end + 3);
  })();
  const sync = functionBody('studio_sync_shot_assignment');
  assert.ok(accept.includes('sh.assigned_member_id=v_inv.team_member_id'));
  assert.ok(accept.includes('public.studio_sync_shot_assignment(s.project_id,v_inv.team_member_id,true)'));
  assert.ok(sync.includes("grant_source='shot_assignment'"));
  assert.ok(!accept.includes('update public.shots set assigned_member_id'));
});

test('first standalone signup is provisioned as Master User; invite signup must not create a second studio', () => {
  const bootstrap = functionBody('studio_bootstrap_new_auth_user');
  assert.ok(bootstrap.includes("if v_token is not null"));
  assert.ok(bootstrap.includes('return new;'));
  assert.ok(bootstrap.includes("values(v_org,new.id,'master_user','active'"));
  assert.ok(bootstrap.includes('public.studio_data_owners'));
});

test('chat stays a floating popup and staff settings only expose allowed module sections', () => {
  assert.ok(app.includes('className="kf-chat-widget"'));
  assert.ok(app.includes('className={`kf-chat-popup${chatOpen ? " is-open" : ""}`}'));
  assert.ok(chatCss.includes('.kf-chat-launcher{pointer-events:auto;position:relative'));
  assert.ok(settings.includes('const settingsTabs = useMemo(() =>'));
  assert.ok(settings.includes('if (workspaceAccess.includes("leads")) visible.add("crm")'));
  assert.ok(settings.includes('<PersonalAccountTab'));
  assert.ok(access.includes('if (access.is_member !== true) return ["dashboard"]'));
  assert.ok(team.includes('export function MemberAccessRow'), 'invites live on each Teams roster card');
});
