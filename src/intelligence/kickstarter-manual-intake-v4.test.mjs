import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const api = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const panels = readFileSync(new URL('./DiscoveryPanels.jsx', import.meta.url), 'utf8');
const campaign = readFileSync(new URL('./CampaignView.jsx', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../../supabase/migrations/20261112170000_intelligence_kickstarter_manual_intake_v4.sql', import.meta.url), 'utf8');

test('Kickstarter intake is an explicit administrator-submitted workflow', () => {
  assert.match(api, /addKickstarterProject:\s*\(s, project\)\s*=>\s*call\(s, "intel_admin_add_kickstarter_project"/);
  assert.match(panels, /export function ManualKickstarterProject/);
  assert.match(panels, /Kickstarter project URL/);
  assert.match(panels, /Kickstarter creator name/);
  assert.match(panels, /Developer \/ studio \(if known\)/);
  assert.match(panels, /prior written permission/);
  assert.match(panels, /kickstarter.com\/discover\/categories\/game/);
  assert.match(panels, /permissionReference/);
  assert.match(campaign, /type === "indie_game_developer" && <ManualKickstarterProject/);
});

test('Kickstarter intake does not introduce a client-side crawler or page fetch', () => {
  const component = panels.slice(panels.indexOf('export function ManualKickstarterProject'));
  assert.doesNotMatch(component, /fetch\s*\(/);
  assert.match(component, /never fetches Kickstarter pages or creator profiles/);
  assert.match(component, /unverified until independently checked/);
});

test('Kickstarter registry is disabled and intake RPC is admin-only', () => {
  assert.match(migration, /'kickstarter', 'Kickstarter \(manual intake only\)', false, 'unverified'/);
  assert.match(migration, /revoke all on function public\.intel_admin_add_kickstarter_project\(text,text,text,text,text,text,text,boolean\)/);
  assert.match(migration, /prior written permission for commercial use is required/);
  assert.match(migration, /grant execute on function public\.intel_admin_add_kickstarter_project[^;]+to authenticated/);
  assert.match(migration, /'manual_post'/);
  assert.doesNotMatch(migration, /create or replace function public\.kickstarter/i);
});
