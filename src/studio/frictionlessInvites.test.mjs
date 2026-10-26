import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { friendlyInviteError, inviteRoleFor, describeAccess, buildInviteLink, createInviteToken } from './access.js';
import { summarizeHome } from './homeSummary.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const migration = read('supabase/migrations/20261101090000_frictionless_team_invites.sql');
const fn = read('supabase/functions/studio-invite-accept/index.ts');
const app = read('src/App.jsx');
const team = read('src/studio/TeamAccessPanel.jsx');
const chat = read('src/chat/ChatPage.jsx');
const sql = migration.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').toLowerCase();

function body(name) {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.notEqual(start, -1, `expected ${name}`);
  return sql.slice(start, sql.indexOf('$$;', sql.indexOf('as $$', start)) + 3);
}

test('invites are bound to the roster entry, never to an email', () => {
  assert.ok(sql.includes('alter column invited_email drop not null'));
  const create = body('studio_create_team_invite');
  assert.ok(!create.includes('team_member_email_required'));
  assert.ok(!create.includes('tm.email') && !create.includes('team_member_email'), 'creating an invite never looks at a roster email');
  assert.ok(create.includes("when p_department_id is null then 'freelancer'"), 'no department = freelancer portal');
  const apply = body('studio_apply_team_invite');
  assert.ok(!apply.includes('invite_email_mismatch'));
  assert.ok(!apply.includes('email_confirmation_required'));
  assert.ok(!apply.includes('team_member_email_changed'));
  assert.ok(apply.includes('pg_advisory_xact_lock'));
  assert.ok(apply.includes('for update'), 'one-time consumption stays row-locked');
  assert.ok(apply.includes("status='accepted'"));
  assert.ok(apply.includes("raise exception 'cannot_replace_master_membership'"));
});

test('only the service role can redeem for a new account; the internal routine is not callable by clients', () => {
  assert.ok(sql.includes('revoke all on function public.studio_apply_team_invite(text,uuid) from public, anon, authenticated'));
  assert.ok(sql.includes('revoke all on function public.studio_redeem_team_invite(text,uuid) from public, anon, authenticated'));
  assert.ok(sql.includes('grant execute on function public.studio_redeem_team_invite(text,uuid) to service_role'));
  assert.ok(sql.includes('grant execute on function public.studio_accept_team_invite(text) to authenticated'));
});

test('signup trigger accepts a valid pending token without comparing emails', () => {
  const trigger = body('studio_bootstrap_new_auth_user');
  assert.ok(trigger.includes("i.status='pending' and i.expires_at>now()"));
  assert.ok(!trigger.includes('invited_email'));
  assert.ok(trigger.includes("raise exception 'invite_not_found_or_expired'"));
});

test('roster overview and department moves are master-only', () => {
  for (const name of ['studio_team_access_overview', 'studio_set_member_department', 'studio_set_member_access']) {
    assert.ok(body(name).includes('public.chat_is_org_master(p_organization_id)'), `${name} requires the master user`);
  }
  assert.ok(body('studio_set_member_department').includes("raise exception 'cannot_change_master'"));
});

test('edge function creates a confirmed account, redeems the invite, and cleans up on failure', () => {
  assert.ok(fn.includes('email_confirm: true'));
  assert.ok(fn.includes('studio_redeem_team_invite'));
  assert.ok(fn.includes('deleteUser(created.user.id)'));
  assert.ok(fn.includes('account_exists'));
  assert.ok(fn.includes('SUPABASE_SERVICE_ROLE_KEY'));
});

test('invite landing asks only for email and password and signs in afterwards', () => {
  assert.ok(app.includes('supabase.functions.invoke("studio-invite-accept"'));
  assert.ok(app.includes('Join studio'));
  assert.ok(!app.includes('The invited email must be used'));
  assert.ok(!app.includes('setAuthEmail(invite.invited_email)'));
  assert.ok(!app.includes('studio_invite_token: inviteToken'), 'no client-side signUp with the invite token');
});

test('Teams has no separate onboarding panel; each roster card carries the access control', () => {
  assert.ok(!app.includes('<TeamAccessPanel'));
  assert.ok(app.includes('<MemberAccessRow member={member} access={teamAccess} />'));
  assert.ok(team.includes('Copy invite link'));
  assert.ok(team.includes('Freelancer portal'));
});

test('chat is a floating popup with a single search box and no footer clutter', () => {
  assert.ok(app.includes('className="kf-chat-launcher"'));
  assert.ok(!chat.includes('STUDIO COLLABORATION'));
  assert.ok(!chat.includes('chat-sidebar-footer'));
  assert.ok(!chat.includes('conversationFilter'));
});

test('department and freelancer logins get their own home instead of the studio dashboard', () => {
  assert.ok(app.includes('workspace === "dashboard" && studioScoped && ('));
  assert.ok(app.includes('workspace === "dashboard" && !studioScoped && ('));
});

test('access helpers', () => {
  assert.equal(inviteRoleFor(''), 'freelancer');
  assert.equal(inviteRoleFor('dept-1'), 'staff');
  assert.equal(describeAccess('freelancer'), 'Freelancer portal');
  assert.equal(describeAccess('staff', 'Sales'), 'Sales');
  assert.match(friendlyInviteError('account_exists'), /already has an account/);
  assert.match(friendlyInviteError('invite_not_found_or_expired'), /expired or was already used/);
  const token = createInviteToken();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.match(buildInviteLink(token, 'https://app.example.com'), /studio-invite=/);
});

test('home summary counts open leads, due follow-ups and my open shots', () => {
  const summary = summarizeHome({
    todayIso: '2026-10-27',
    leads: [
      { id: 1, stage: 'contacted', followupDate: '2026-10-26', createdAt: '2026-10-25T00:00:00Z' },
      { id: 2, stage: 'won', followupDate: '2026-10-01' },
      { id: 3, stage: 'contacted', followupDate: '2026-11-05', archivedAt: '2026-10-02' },
    ],
    projects: [{ id: 'p', archived: false }],
    cards: [
      { id: 'a', assignedMemberId: 'tm1', stage: 'genga' },
      { id: 'b', assignedMemberId: 'tm1', stage: 'delivered' },
      { id: 'c', assignedMemberId: 'tm2', stage: 'genga' },
    ],
    teamMemberId: 'tm1',
  });
  assert.equal(summary.crm.open, 1);
  assert.equal(summary.crm.followupsDue, 1);
  assert.equal(summary.crm.newThisWeek, 1);
  assert.equal(summary.work.myOpenShots, 1);
  assert.equal(summary.work.myDelivered, 1);
  assert.equal(summary.work.stages[0].label, 'Genga');
});
