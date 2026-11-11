// Roadmap Phase 5: Inbox <-> CRM synchronization on the lead timeline.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mergeEmailTimeline, sortEmailTimelineForDisplay } from "./lib/logic.js";
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

const stage = { ts: "2026-11-01T10:00:00Z", type: "stage_change", note: "Moved" };
const mail = (id, ts) => ({ ts, type: "email_sent", note: `Email sent ${id}`, emailMessageId: id, emailActivityId: `a-${id}`, provider: "resend", providerMessageId: `p-${id}` });

test("server email entries are merged without reordering existing activity", () => {
  const out = mergeEmailTimeline([stage, { ts: "2026-11-03T10:00:00Z", type: "note", note: "later" }], [stage, mail("m1", "2026-11-02T09:00:00Z")]);
  assert.deepEqual(out.map((e) => e.note), ["Moved", "later", "Email sent m1"]);
  assert.deepEqual(sortEmailTimelineForDisplay(out).map((e) => e.note), ["Moved", "Email sent m1", "later"]);
});
test("never duplicates an email already on the timeline, and repeated merges are stable (no duplicate activities)", () => {
  const local = [stage, mail("m1", "2026-11-02T09:00:00Z")];
  assert.equal(mergeEmailTimeline(local, [mail("m1", "2026-11-02T09:00:00Z")]), local);
  const once = mergeEmailTimeline(local, [mail("m2", "2026-11-04T09:00:00Z"), mail("m2", "2026-11-04T09:00:00Z")]);
  assert.equal(once.filter((e) => e.emailMessageId === "m2").length, 1);
  assert.equal(mergeEmailTimeline(once, [mail("m2", "2026-11-04T09:00:00Z")]), once);
});
test("only well-formed email_sent entries are imported; local non-email entries are never replaced by server ones", () => {
  const server = [{ ts: "2026-11-05T00:00:00Z", type: "stage_change", note: "server only" }, { type: "email_sent", note: "no id" }, null, mail("m3", "2026-11-05T01:00:00Z")];
  assert.deepEqual(mergeEmailTimeline([stage], server).map((e) => e.emailMessageId || e.note), ["Moved", "m3"]);
  assert.deepEqual(mergeEmailTimeline(undefined, undefined), []);
  assert.deepEqual(mergeEmailTimeline(null, [mail("m4", "2026-11-05T01:00:00Z")]).length, 1);
});
test("missing timestamps remain stable and are sorted last only for display", () => {
  const out = mergeEmailTimeline([{ type: "note", note: "a" }], [{ ...mail("m5", "bad"), note: "b" }]);
  assert.deepEqual(out.map((e) => e.note), ["a", "b"]);
  assert.deepEqual(sortEmailTimelineForDisplay([{ type: "note", note: "a" }, { ts: "2026-11-01", note: "dated" }]).map((e) => e.note), ["dated", "a"]);
});

test("wiring: refresh after an Inbox send, when opening a lead, and when jumping from the Inbox to a lead", () => {
  const app = read("../App.jsx");
  assert.match(app, /select\("id, activity_log"\)\.eq\("id", lead\.id\)/);
  assert.match(app, /setEditingLead\(await refreshLeadTimeline\(lead\)\)/);
  assert.match(app, /onLeadEmailSent=\{\(leadId\) =>/);
  assert.match(app, /const fresh = await refreshLeadTimeline\(l\); setCrmTab\("pipeline"\); setEditingLead\(fresh\)/);
  assert.match(app, /EMAIL_TIMELINE_TYPES\.includes\(entry\.type\) && entry\.emailMessageId/);
  const inbox = read("./InboxModule.jsx");
  assert.match(inbox, /const leadId = composer\?\.crmLeadId; setComposer\(null\); refresh\(\); if \(leadId\) onLeadEmailSent\?\.\(leadId\)/);
});
test("sync never writes email rows from the browser: the refresh only reads activity_log", () => {
  const app = read("../App.jsx");
  const body = app.slice(app.indexOf("const refreshLeadTimeline"), app.indexOf("const handleLeadClick"));
  assert.doesNotMatch(body, /\.(insert|update|upsert|delete)\(/);
});

// ---- Phase 5 follow-up: inbound replies on the timeline, "Open email", live refresh ----
const received = (id, ts) => ({ ts, type: "email_received", note: `Email received ${id}`, emailMessageId: id, emailConversationId: `c-${id}`, provider: "resend" });

test("received replies merge like sent emails, with no duplicates, preserving local order", () => {
  const out = mergeEmailTimeline([stage, mail("m1", "2026-11-02T09:00:00Z")], [received("r1", "2026-11-03T09:00:00Z"), received("r1", "2026-11-03T09:00:00Z"), mail("m1", "2026-11-02T09:00:00Z")]);
  assert.deepEqual(out.map((e) => e.emailMessageId || e.note), ["Moved", "m1", "r1"]);
  assert.deepEqual(sortEmailTimelineForDisplay(out).map((e) => e.emailMessageId || e.note), ["Moved", "m1", "r1"]);
});

test("lead editor: live read-only refresh, merged display, Open email wiring", () => {
  const app = read("../App.jsx");
  assert.match(app, /const timer = setInterval\(pull, 30000\)/);
  assert.match(app, /return \(\) => \{ alive = false; clearInterval\(timer\); \}/);
  assert.match(app, /const timelineEntries = sortEmailTimelineForDisplay\(mergeEmailTimeline\(form\.activityLog, serverLog\)\)/);
  assert.match(app, /\[\.\.\.timelineEntries\]/);
  assert.match(app, /rpc\("email_message_conversation", \{ p_message_id: entry\.emailMessageId \}\)/);
  assert.match(app, /loadServerTimeline=\{canAccessEmail\(emailAccess\) \? loadLeadServerTimeline : undefined\}/);
  assert.match(app, /onOpenEmail=\{canAccessEmail\(emailAccess\) \? openLeadEmail : undefined\}/);
  assert.match(app, /openConversationRequest=\{openConversationRequest\} onOpenConversationHandled=\{\(\) => setOpenConversationRequest\(null\)\}/);
  const poll = app.slice(app.indexOf("const loadLeadServerTimeline"), app.indexOf("const openLeadEmail"));
  assert.doesNotMatch(poll, /\.(insert|update|upsert|delete)\(/);
  const inbox = read("./InboxModule.jsx");
  assert.match(inbox, /setSelected\(openConversationRequest\.id\)/);
});

test("migration: inbound trigger is per-insert, idempotent, non-blocking; guard keeps both entry types; RPC is org-checked", () => {
  const sql = read("../../supabase/migrations/20261221090000_email_crm_inbound_timeline.sql");
  assert.match(sql, /after insert on public\.email_messages\s+for each row when \(new\.direction = 'inbound'\)/);
  assert.match(sql, /not exists \(\s*select 1 from jsonb_array_elements\(coalesce\(activity_log, '\[\]'::jsonb\)\) e\s+where e ->> 'emailMessageId' = new\.id::text/);
  assert.match(sql, /exception when others then\s+raise warning/);
  assert.match(sql, /in \('email_sent', 'email_received'\)/);
  assert.match(sql, /email_require_access\(\)[\s\S]*m\.organization_id = v_org/);
  assert.match(sql, /grant execute on function public\.email_message_conversation\(uuid\) to authenticated/);
  assert.doesNotMatch(sql, /net\.http|email_create_outbound|insert into public\.email_messages/i);
});


test("confirmed bugfix migration reconciles link/unlink/rethread and filters automatic replies", () => {
  const sql = read("../../supabase/migrations/20261223100000_email_crm_timeline_reconciliation.sql");
  assert.match(sql, /email_reconcile_conversation_timeline/);
  assert.match(sql, /after update of lead_id on public\.email_conversations/);
  assert.match(sql, /after update of conversation_id on public\.email_messages/);
  assert.match(sql, /_email_sync_message_crm_timeline/);
  assert.match(sql, /mailer-daemon|postmaster/);
  assert.match(sql, /auto-submitted/);
  assert.match(sql, /email_reconcile_tagged_delivery_event_with_rfc/);
  assert.match(sql, /grant execute on function public\.email_reconcile_tagged_delivery_event_with_rfc[\s\S]*to service_role/);
});
