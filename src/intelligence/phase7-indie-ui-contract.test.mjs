import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

test("Indie prospect review exposes server-validated evidence and verification actions", () => {
  const modal = read("./ProspectModal.jsx");
  const panel = read("./IndieAdminPanel.jsx");
  const api = read("./api.js");
  assert.match(modal, /IndieAdminPanel/);
  for (const fn of ["intel_admin_add_indie_evidence", "intel_admin_verify_indie_identity", "intel_admin_verify_indie_contact"]) assert.match(api, new RegExp(fn));
  for (const type of ["developer_identity", "project_identity", "contact_email", "anime_visual_screenshot", "development_update", "marketing_opportunity"]) assert.match(panel, new RegExp(type));
  assert.match(panel, /Select reviewed evidence/);
  assert.match(panel, /Kickstarter pages are not accepted/);
});

test("Indie settings expose four stages without increasing non-Indie cadence", () => {
  const settings = read("./SettingsView.jsx");
  assert.match(settings, /max="4" value=\{f\.max_followups\}/);
  assert.match(settings, /Day 5 and Day 10/);
  assert.match(settings, /Other campaigns remain capped at three/);
});

test("reply outcomes distinguish stop-sequence from unsubscribe and retain approval-first replies", () => {
  const outreach = read("./OutreachView.jsx");
  for (const outcome of ["not_now", "not_interested", "already_has_trailer", "wrong_person", "referral", "tell_me_more", "unsubscribe"]) assert.match(outreach, new RegExp(outcome));
  assert.match(outreach, /not automatically an unsubscribe or permanent DNC/);
  assert.match(outreach, /remains pending your approval/);
  assert.match(outreach, /Creates a draft for your approval/);
});
