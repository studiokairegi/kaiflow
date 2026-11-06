import test from "node:test";
import assert from "node:assert/strict";
import { parseConversation, toIsoDate, directionOf, entryProblems, cleanEntries, suggestedLastContact, canImport, canIntroduce, takeoverInfo, reverseEntries, lastSpeaker, MAX_MESSAGES } from "./conversation.js";

const LEAD = { email: "hana@studio.jp", name: "Hana Sato" };
const dirs = (r) => r.entries.map((e) => e.direction);

test("dates are read from the formats mail clients use and ambiguous ones are left for the person", () => {
  assert.equal(toIsoDate("Sent: 2026-10-06 15:14"), "2026-10-06");
  assert.equal(toIsoDate("6 Oct 2026"), "2026-10-06");
  assert.equal(toIsoDate("Tuesday, October 6, 2026 3:14 PM"), "2026-10-06");
  assert.equal(toIsoDate("2026年10月6日 15:14"), "2026-10-06");
  assert.equal(toIsoDate("13/05/2026"), "2026-05-13");
  assert.equal(toIsoDate("05/13/2026"), "2026-05-13");
  assert.equal(toIsoDate("04/05/2026"), null);
  assert.equal(toIsoDate("Feb 30, 2026"), null);
  assert.equal(toIsoDate("Tue, Oct 6, 3:14 PM"), null);
  assert.equal(toIsoDate(""), null);
});

test("direction: the lead's address or colleagues at the same domain are inbound, any other address is ours, a bare name needs the person", () => {
  assert.equal(directionOf("Hana Sato <hana@studio.jp>", LEAD), "inbound");
  assert.equal(directionOf("Ken <ken@studio.jp>", LEAD), "inbound");
  assert.equal(directionOf("Kairegi <hello@kairegi.com>", LEAD), "outbound");
  assert.equal(directionOf("Hana Sato", LEAD), "inbound");
  assert.equal(directionOf("Someone Else", LEAD), "unknown");
  assert.equal(directionOf("", LEAD), "unknown");
});

test("a reply chain written with 'wrote:' markers becomes oldest-first messages with the right sides", () => {
  const paste = [
    "Thanks, sounds good. I will send the reel.",
    "",
    "On Tue, Oct 6, 2026 at 3:14 PM Hana Sato <hana@studio.jp> wrote:",
    "> Hello, we might need help in spring.",
    ">",
    "> On Mon, Oct 5, 2026 at 9:00 AM Kairegi <hello@kairegi.com> wrote:",
    ">> Hello Hana, we are a 2D animation studio.",
  ].join("\n");
  const r = parseConversation(paste, LEAD);
  assert.deepEqual(dirs(r), ["outbound", "inbound", "outbound"]);
  assert.equal(r.entries[0].body, "Hello Hana, we are a 2D animation studio.");
  assert.equal(r.entries[0].at, "2026-10-05");
  assert.equal(r.entries[1].body, "Hello, we might need help in spring.");
  assert.equal(r.entries[1].at, "2026-10-06");
  assert.match(r.entries[2].body, /send the reel/);
  assert.equal(lastSpeaker(r.entries), "outbound");
  assert.deepEqual(r.warnings, []);
});

test("a marker that the mail client wrapped over two lines is still found", () => {
  const paste = ["Yes please.", "", "On Tue, Oct 6, 2026 at 3:14 PM Hana Sato", "<hana@studio.jp> wrote:", "> Do you do 2D?"].join("\n");
  const r = parseConversation(paste, LEAD);
  assert.deepEqual(dirs(r), ["inbound", "outbound"]);
  assert.equal(r.entries[0].body, "Do you do 2D?");
});

test("an Outlook chain with From/Sent/Subject headers keeps dates and subject", () => {
  const paste = [
    "Hi Hana, just checking in.",
    "",
    "From: Hana Sato <hana@studio.jp>",
    "Sent: Tuesday, October 6, 2026 3:14 PM",
    "To: Kairegi <hello@kairegi.com>",
    "Subject: RE: 2D animation support",
    "",
    "We are interested.",
    "",
    "-----Original Message-----",
    "From: Kairegi <hello@kairegi.com>",
    "Sent: Monday, October 5, 2026 9:00 AM",
    "To: Hana Sato <hana@studio.jp>",
    "Subject: 2D animation support",
    "",
    "Hello Hana, we are a 2D animation studio.",
  ].join("\n");
  const r = parseConversation(paste, LEAD);
  assert.deepEqual(dirs(r), ["outbound", "inbound", "outbound"]);
  assert.deepEqual(r.entries.map((e) => e.at), ["2026-10-05", "2026-10-06", null]);
  assert.equal(r.subject, "RE: 2D animation support");
  assert.ok(!r.entries[1].body.includes("Original Message"));
});

test("Japanese Outlook headers are understood", () => {
  const paste = [
    "差出人: 佐藤 花 <hana@studio.jp>",
    "送信日時: 2026年10月6日 15:14",
    "宛先: Kairegi <hello@kairegi.com>",
    "件名: Re: アニメーション制作協力のご提案",
    "",
    "ご連絡ありがとうございます。",
    "",
    "差出人: Kairegi <hello@kairegi.com>",
    "送信日時: 2026年10月5日 9:00",
    "件名: アニメーション制作協力のご提案",
    "",
    "突然のご連絡失礼いたします。",
  ].join("\n");
  const r = parseConversation(paste, LEAD);
  assert.deepEqual(dirs(r), ["outbound", "inbound"]);
  assert.deepEqual(r.entries.map((e) => e.at), ["2026-10-05", "2026-10-06"]);
});

test("a conversation copied oldest-first (name, address, then date) is read in order", () => {
  const paste = [
    "Kairegi <hello@kairegi.com>", "Mon, Oct 5, 2026, 9:00 AM", "to Hana", "", "Hello Hana, we are a 2D animation studio.", "",
    "Hana Sato <hana@studio.jp>", "Tue, Oct 6, 2026, 3:14 PM", "to Kairegi", "", "We are interested.",
  ].join("\n");
  const r = parseConversation(paste, LEAD);
  assert.deepEqual(dirs(r), ["outbound", "inbound"]);
  assert.deepEqual(r.entries.map((e) => e.at), ["2026-10-05", "2026-10-06"]);
  assert.equal(r.entries[1].body, "We are interested.");
});

test("plain text with no structure stays one message that the person must label", () => {
  const r = parseConversation("Hi Hana, I wrote you last month about animation help. Not sure if it reached you.", LEAD);
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].direction, "unknown");
  assert.ok(r.warnings.length >= 1);
  assert.ok(entryProblems(r.entries).some((m) => /choose who wrote/i.test(m)));
  assert.deepEqual(parseConversation("   \n ", LEAD).entries, []);
});

test("review rules: every message needs a side and text, dates must be real, size is capped", () => {
  assert.deepEqual(entryProblems([{ direction: "outbound", body: "hi", at: "2026-10-05" }, { direction: "inbound", body: "hello", at: null }]), []);
  assert.ok(entryProblems([]).length);
  assert.ok(entryProblems([{ direction: "unknown", body: "x" }]).length);
  assert.ok(entryProblems([{ direction: "inbound", body: "  " }]).length);
  assert.ok(entryProblems([{ direction: "inbound", body: "x", at: "2026-13-40" }]).length);
  assert.ok(entryProblems(Array.from({ length: MAX_MESSAGES + 1 }, () => ({ direction: "inbound", body: "x" }))).length);
});

test("what is sent to the database is trimmed and only has the allowed fields", () => {
  const out = cleanEntries([{ direction: "inbound", at: "6 Oct 2026", subject: "  Hi ", body: "  text  ", extra: "drop me" }]);
  assert.deepEqual(out, [{ direction: "inbound", at: "2026-10-06", subject: "Hi", body: "text" }]);
});

test("last contact defaults to the newest message date, then to the CRM's last contact", () => {
  assert.equal(suggestedLastContact([{ at: "2026-10-05" }, { at: "2026-10-09" }, { at: null }], "2026-09-01"), "2026-10-09");
  assert.equal(suggestedLastContact([{ at: null }], "2026-09-01T10:00:00Z"), "2026-09-01");
  assert.equal(suggestedLastContact([], null), "");
});

test("only leads with a usable email can have a conversation pasted or be introduced", () => {
  const base = { lead_id: "L1", email: "hana@studio.jp", bucket: "follow_up_due", tracked: false };
  assert.ok(canImport(base));
  assert.ok(canImport({ ...base, bucket: "replied", tracked: true }));
  assert.ok(!canImport({ ...base, email: "" }));
  assert.ok(!canImport({ ...base, email: "not-an-email" }));
  assert.ok(!canImport({ ...base, bucket: "do_not_contact" }));
  assert.ok(!canImport({ ...base, bucket: "no_email" }));
  assert.ok(canIntroduce({ ...base, bucket: "not_contacted" }));
  assert.ok(!canIntroduce({ ...base, bucket: "not_contacted", email: "" }));
  assert.ok(!canIntroduce({ ...base, bucket: "not_contacted", tracked: true }));
  assert.ok(!canIntroduce({ ...base, bucket: "waiting" }));
});

test("take-over status labels", () => {
  assert.equal(takeoverInfo(null), null);
  assert.equal(takeoverInfo({}), null);
  assert.equal(takeoverInfo({ state: "pending" }).tone, "info");
  assert.equal(takeoverInfo({ state: "failed", error: "Ollama is down" }).detail, "Ollama is down");
  assert.equal(takeoverInfo({ state: "ready", next_action: "reply", reason: "They asked for the reel" }).label, "Reply drafted");
  assert.equal(takeoverInfo({ state: "ready", next_action: "needs_human" }).tone, "warn");
  assert.equal(takeoverInfo({ state: "ready", next_action: "stop" }).tone, "bad");
  assert.deepEqual(reverseEntries([1, 2, 3]), [3, 2, 1]);
});
