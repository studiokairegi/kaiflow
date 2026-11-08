import test from "node:test";
import assert from "node:assert/strict";
import { attentionItems, conversations, criteriaPatch, findTargetProspect, missingJapaneseKb, missingKb, splitLines, workerState, statusInfo, isHttpUrl, isAiGeneratedLead } from "./logic.js";
import { intelApi } from "./api.js";

test("workerState reflects the heartbeat age", () => {
  assert.equal(workerState(null).tone, "warn"); assert.equal(workerState(30).tone, "ok");
  assert.equal(workerState(400).tone, "warn"); assert.equal(workerState(5000).tone, "bad");
});

test("attentionItems orders by urgency and stays quiet when all is well", () => {
  assert.deepEqual(attentionItems({ configured: true, unknown_sends: 0, dead_jobs: 0, pending_approval: 0, prospects_by_status: {} }), []);
  const items = attentionItems({ configured: true, unknown_sends: 1, dead_jobs: 2, pending_approval: 3, prospects_by_status: { needs_review: 4 } });
  assert.deepEqual(items.map((i) => i.tone), ["bad", "bad", "warn", "warn"]);
  assert.deepEqual(attentionItems({ configured: false }), []);
});

test("conversations group by prospect, newest first, and flag what needs the administrator", () => {
  const prospects = [{ id: "p1", name: "A" }, { id: "p2", name: "B" }];
  const msgs = [
    { id: "1", prospect_id: "p1", direction: "outbound", state: "sent", sent_at: "2026-11-01T10:00:00Z", created_at: "2026-11-01T09:00:00Z" },
    { id: "2", prospect_id: "p1", direction: "inbound", state: "received", received_at: "2026-11-02T08:00:00Z", escalated: true, created_at: "2026-11-02T08:00:00Z" },
    { id: "3", prospect_id: "p2", direction: "outbound", state: "pending_approval", created_at: "2026-11-02T12:00:00Z" },
    { id: "4", prospect_id: null, direction: "inbound", state: "received", created_at: "2026-11-02T13:00:00Z" },
  ];
  const c = conversations(msgs, prospects);
  assert.deepEqual(c.map((x) => x.prospectId), ["p2", "p1"]);
  assert.ok(c[0].needsAttention && c[1].needsAttention && c[1].inbound && !c[0].inbound);
  assert.deepEqual(c[1].messages.map((m) => m.id), ["1", "2"]);
});

test("notification targets resolve by prospect, message or lead", () => {
  const prospects = [{ id: "p1", lead_id: "L1" }, { id: "p2", lead_id: null }];
  const messages = [{ id: "m9", prospect_id: "p2" }];
  assert.equal(findTargetProspect({ prospectId: "p1" }, prospects, messages), "p1");
  assert.equal(findTargetProspect({ messageId: "m9" }, prospects, messages), "p2");
  assert.equal(findTargetProspect({ leadId: "L1" }, prospects, messages), "p1");
  assert.equal(findTargetProspect({ prospectId: "gone" }, prospects, messages), null);
  assert.equal(findTargetProspect(null, prospects, messages), null);
});

test("criteriaPatch clamps scores and normalizes lists", () => {
  const p = criteriaPatch({ keywords: " 2D \n\nAnime ", seedUrls: "https://a.test\n", qualifyMin: 120, reviewMin: 80 });
  assert.deepEqual(p, { keywords: ["2d", "anime"], seed_urls: ["https://a.test"], qualify_min: 100, review_min: 80 });
  assert.equal(criteriaPatch({ keywords: "", seedUrls: "", qualifyMin: 60, reviewMin: 90 }).review_min, 60, "review can never exceed qualify");
  assert.throws(() => criteriaPatch({ keywords: "", seedUrls: "", qualifyMin: "x", reviewMin: 1 }));
  assert.deepEqual(splitLines("a\r\n b \n"), ["a", "b"]); assert.ok(isHttpUrl("https://x.test") && !isHttpUrl("javascript:alert(1)"));
  assert.equal(statusInfo("zzz").tone, "muted");
});

test("missingKb lists exactly the approved entries the agent still needs", () => {
  assert.equal(missingKb([]).length, 4);
  const all = ["studio.about", "services.indie_game_developer", "services.animation_studio_support", "portfolio.main"].map((key) => ({ key, approved: true, body: "x" }));
  assert.equal(missingKb(all).length, 0);
  assert.deepEqual(missingKb([{ ...all[0], approved: false }, ...all.slice(1)]).map((m) => m.key), ["studio.about"]);
  assert.equal(missingKb([{ ...all[0], body: "  " }, ...all.slice(1)]).length, 1);
});

test("Japanese outreach entries are tracked separately from the global required knowledge base", () => {
  assert.equal(missingJapaneseKb([]).length, 5);
  const ja = ["studio.about.ja", "services.animation_studio_support.ja", "services.indie_game_developer.ja",
    "portfolio.main.ja", "policy.opt_out.ja"].map((key) => ({ key, approved: true, body: "Japanese text" }));
  assert.equal(missingJapaneseKb(ja).length, 0);
  assert.deepEqual(missingJapaneseKb([{ ...ja[0], approved: false }, ...ja.slice(1)]).map((x) => x.key), ["studio.about.ja"]);
});

test("the AI badge is driven only by the immutable source_kind", () => {
  assert.equal(isAiGeneratedLead({ sourceKind: "ai_intelligence" }), true);
  for (const l of [{ sourceKind: "manual" }, {}, null, { channel: "Cold Email" }, { notes: "AI generated" }]) assert.equal(isAiGeneratedLead(l), false);
});

test("api: writes only call intel_admin_* functions, reads only intel tables", async () => {
  const calls = [];
  const sb = {
    rpc: async (n, a) => { calls.push(["rpc", n, a]); return { data: { ok: true }, error: null }; },
    from: (t) => { calls.push(["from", t]); const q = { select: () => q, order: () => q, limit: () => q, eq: () => q, in: () => q, then: (r) => r({ data: [], error: null }) }; return q; },
  };
  await intelApi.setKillSwitch(sb, true); await intelApi.disconnectMail(sb); await intelApi.reviewMessage(sb, "m", "approve"); await intelApi.enqueue(sb, "discover", { type: "indie_game_developer" });
  await intelApi.prospects(sb); await intelApi.messages(sb); await intelApi.kb(sb); await intelApi.leadsFor(sb, ["l1"]); await intelApi.leadsFor(sb, []);
  assert.ok(calls.filter((c) => c[0] === "rpc").every((c) => c[1].startsWith("intel_admin_")));
  assert.ok(calls.filter((c) => c[0] === "from").every((c) => c[1].startsWith("intel_") || c[1] === "leads"));
  await assert.rejects(intelApi.overview({ rpc: async () => ({ data: null, error: { message: "KairFlow Intelligence is restricted." } }) }), /restricted/);
});

import { profileFromForm, profileToForm, proposedTerms, sourceState } from "./logic.js";

test("sourceState: a source with unconfirmed terms can never look as if it is running", () => {
  const base = { tos_status: "confirmed", enabled: true, daily_budget: 10, used_today: 0, circuit_open_until: null };
  assert.equal(sourceState(base).label, "Running");
  assert.equal(sourceState({ ...base, tos_status: "unverified" }).label, "Terms not confirmed");
  assert.equal(sourceState({ ...base, tos_status: "unverified", enabled: true }).tone, "warn");
  assert.equal(sourceState({ ...base, tos_status: "excluded" }).tone, "bad");
  assert.equal(sourceState({ ...base, enabled: false }).label, "Off");
  assert.equal(sourceState({ ...base, used_today: 10 }).label, "Daily budget used");
  assert.equal(sourceState({ ...base, circuit_open_until: new Date(Date.now() + 3600_000).toISOString() }).label, "Paused after errors");
  assert.equal(sourceState({ ...base, circuit_open_until: new Date(Date.now() - 1000).toISOString() }).label, "Running");
  assert.equal(sourceState(null).label, "Off");
});

test("profile form round-trips, de-duplicates and refuses an empty profile", () => {
  const form = { description: "d", termsEn: "key animation\nKey  animation\n", termsJa: "åŽŸç”»å‹Ÿé›†\n\n", exclude: "school", approved: false };
  const p = profileFromForm(form);
  assert.deepEqual(p.termsEn, ["key animation", "Key animation"]); assert.deepEqual(p.termsJa, ["åŽŸç”»å‹Ÿé›†"]); assert.deepEqual(p.exclude, ["school"]);
  assert.throws(() => profileFromForm({ description: "", termsEn: "", termsJa: "", exclude: "" }), /at least one/);
  assert.deepEqual(profileToForm({ description: "x", terms_en: ["a"], terms_ja: ["b"], exclude: ["c"], approved: true }), { description: "x", termsEn: "a", termsJa: "b", exclude: "c", approved: true });
  assert.equal(proposedTerms({}), null); assert.deepEqual(proposedTerms({ proposed_en: ["a"], proposed_ja: [], proposed_exclude: ["z"] }), { termsEn: "a", termsJa: "", exclude: "z" });
});
