import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DIGEST_KEY, POMODORO_KEY, digestAlert, nextMorning, pomodoroAlert } from "./jobs.js";
import {
  buildPayload, cleanPrefs, isGone, namespacedKey, safeOpenUrl, shouldDeliver, validSubscription, validateJobs,
} from "../../supabase/functions/_shared/push_logic.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

// ---------------------------------------------------------------- timer alerts
test("a finished focus round announces the next break", () => {
  const at = Date.UTC(2026, 9, 29, 12, 0, 0);
  const a = pomodoroAlert({ phase: "work", endsAt: at, cycle: 1, rounds: 4, nextBreak: "break", nextBreakMinutes: 5 });
  assert.equal(a.title, "Break time");
  assert.equal(a.body, "Round 1 of 4 done - 5 minutes to recharge.");
  assert.equal(a.key, POMODORO_KEY);
  assert.equal(a.due_at, new Date(at).toISOString());
  assert.equal(a.category, "focus");
  assert.equal(pomodoroAlert({ phase: "work", endsAt: at, cycle: 2, rounds: 4, nextBreak: "longBreak", nextBreakMinutes: 15 }).title, "Long break time");
  assert.match(pomodoroAlert({ phase: "work", endsAt: at, cycle: 1, rounds: 2, nextBreak: "break", nextBreakMinutes: 1 }).body, /1 minute to recharge/);
});
test("the last round ends the session; breaks end with a prompt", () => {
  const at = Date.now() + 60000;
  assert.equal(pomodoroAlert({ phase: "work", endsAt: at, cycle: 4, rounds: 4 }).title, "Focus session complete");
  assert.equal(pomodoroAlert({ phase: "work", endsAt: at, cycle: 1, rounds: 1 }).body, "1 focus round finished. Nice work.");
  assert.equal(pomodoroAlert({ phase: "break", endsAt: at, cycle: 1, rounds: 4 }).title, "Back to focus");
  assert.match(pomodoroAlert({ phase: "longBreak", endsAt: at, cycle: 1, rounds: 4 }).body, /^Long break over/);
  assert.equal(pomodoroAlert({ phase: null, endsAt: at }), null);
  assert.equal(pomodoroAlert({ phase: "work", endsAt: NaN }), null);
});
test("the morning digest is the next 9:00 and only exists when something is pending", () => {
  const now = new Date(2026, 9, 29, 14, 30);
  assert.equal(nextMorning(now).getDate(), 30);
  assert.equal(nextMorning(new Date(2026, 9, 29, 6, 0)).getDate(), 29);
  assert.equal(nextMorning(new Date(2026, 9, 29, 9, 0)).getDate(), 30, "exactly 9:00 rolls to tomorrow");
  assert.equal(nextMorning(now).getHours(), 9);
  assert.equal(digestAlert({ followupsDueToday: 0, hotAwaitingResponse: 0, proposalsAwaitingResponse: 0, approachingDeadline: 0 }, now), null);
  const d = digestAlert({ followupsDueToday: 2, hotAwaitingResponse: 1, proposalsAwaitingResponse: 0, approachingDeadline: 0 }, now);
  assert.equal(d.key, DIGEST_KEY);
  assert.match(d.body, /^2 follow-ups due · 1 hot lead awaiting response \(as of your last visit\)$/);
  assert.equal(d.category, "followups");
});

// ---------------------------------------------------------------- server-side rules
test("preferences gate delivery per category", () => {
  assert.equal(shouldDeliver(undefined, "messages"), true);
  assert.equal(shouldDeliver({ enabled: false }, "messages"), false);
  assert.equal(shouldDeliver({ enabled: true, categories: { messages: false } }, "messages"), false);
  assert.equal(shouldDeliver({ enabled: true, categories: { messages: false } }, "focus"), true);
  assert.deepEqual(cleanPrefs({ enabled: false, categories: { focus: false, "bad key!": true, x: "no" } }), { enabled: false, categories: { focus: false } });
  assert.deepEqual(cleanPrefs(null), { enabled: true, categories: {} });
});
test("subscriptions are validated", () => {
  const good = { endpoint: "https://fcm.googleapis.com/fcm/send/abcdef123456", keys: { p256dh: "B".repeat(60), auth: "a".repeat(22) } };
  assert.deepEqual(validSubscription(good), { endpoint: good.endpoint, p256dh: good.keys.p256dh, auth: good.keys.auth });
  assert.equal(validSubscription({ ...good, endpoint: "http://x.example/aaaaaaaaaaaaaaaa" }), null);
  assert.equal(validSubscription({ ...good, keys: { p256dh: "short", auth: "a".repeat(22) } }), null);
  assert.equal(validSubscription({ ...good, keys: { p256dh: "B".repeat(60), auth: "<script>" } }), null);
  assert.equal(validSubscription(null), null);
});
test("notification links stay on the same site", () => {
  assert.equal(safeOpenUrl("/?share=project&token=abc"), "/?share=project&token=abc");
  assert.equal(safeOpenUrl("//evil.example"), "/");
  assert.equal(safeOpenUrl("https://evil.example/"), "/");
  assert.equal(safeOpenUrl("javascript:alert(1)"), "/");
  assert.equal(safeOpenUrl("/a\\b"), "/");
  assert.equal(safeOpenUrl(undefined), "/");
  assert.equal(safeOpenUrl("/" + "a".repeat(600)), "/");
});
test("scheduled keys are namespaced to the caller and limited to known prefixes", () => {
  const user = "11111111-1111-4111-8111-111111111111";
  assert.equal(namespacedKey(user, "pomo:timer"), `${user}:pomo:timer`);
  assert.equal(namespacedKey(user, "digest:morning"), `${user}:digest:morning`);
  assert.equal(namespacedKey(user, "chat:abc"), null);
  assert.equal(namespacedKey(user, "pomo"), null);
  assert.equal(namespacedKey(user, "pomo:../x y"), null);
  assert.equal(namespacedKey("not-a-uuid", "pomo:timer"), null);
  assert.ok(namespacedKey(user, "pomo:timer").length <= 120);
});
test("scheduled jobs are bounded and cleaned", () => {
  const now = Date.now();
  const ok = validateJobs([{ key: "pomo:timer", due_at: new Date(now + 60000).toISOString(), title: " Break\u0007 time ", body: "x".repeat(500), category: "focus", tag: "t", url: "https://evil.example" }], now);
  assert.equal(ok[0].title, "Break time");
  assert.equal(ok[0].body.length, 240);
  assert.equal(ok[0].url, "/");
  assert.equal(validateJobs([{ key: "pomo:timer", due_at: new Date(now + 8 * 864e5).toISOString(), title: "x" }], now), null, "more than a week ahead");
  assert.equal(validateJobs([{ key: "pomo:timer", due_at: new Date(now - 3600e3).toISOString(), title: "x" }], now), null, "long past");
  assert.equal(validateJobs([{ key: "pomo:timer", due_at: "nope", title: "x" }], now), null);
  assert.equal(validateJobs([{ key: "pomo:timer", due_at: new Date(now + 1000).toISOString(), title: "  " }], now), null);
  assert.equal(validateJobs([], now), null);
  assert.equal(validateJobs(Array(6).fill({ key: "pomo:timer", due_at: new Date(now + 1000).toISOString(), title: "x" }), now), null);
  assert.equal(validateJobs([{ key: "pomo:timer", due_at: new Date(now + 1000).toISOString(), title: "x", category: "bad cat!" }], now)[0].category, "general");
});
test("payloads carry only what the worker needs", () => {
  const payload = JSON.parse(buildPayload({ title: "Hi", body: "there", tag: "t", category: "messages", url: "/x" }, "/?share=shot&token=zzz"));
  assert.equal(payload.title, "Hi");
  assert.equal(payload.url, "/?share=shot&token=zzz");
  assert.equal(payload.icon, "/icon-512.png");
  assert.equal(JSON.parse(buildPayload({ title: "", body: "b" })).title, "KairFlow");
  assert.equal(isGone(410), true); assert.equal(isGone(404), true); assert.equal(isGone(500), false);
});

// ---------------------------------------------------------------- service worker
function loadWorker({ windows = [], origin = "https://studio.example" } = {}) {
  const listeners = {};
  const shown = []; const opened = []; const messages = [];
  const self = {
    location: { origin },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: () => {},
    clients: {
      claim: () => Promise.resolve(),
      matchAll: () => Promise.resolve(windows.map((w) => ({ ...w, postMessage: (m) => messages.push(m), focus: () => { w.focused = true; return Promise.resolve({ ...w, navigate: (u) => { w.navigatedTo = u; return Promise.resolve(); } }); } }))),
      openWindow: (u) => { opened.push(u); return Promise.resolve(); },
    },
    registration: { showNotification: (title, opts) => { shown.push({ title, ...opts }); return Promise.resolve(); } },
  };
  vm.runInNewContext(read("public/sw.js"), { self, URL, String, Boolean, Promise });
  const dispatch = async (type, event) => { let pending; listeners[type]({ ...event, waitUntil: (p) => { pending = p; } }); await pending; };
  return { shown, opened, messages, listeners, dispatch };
}
const pushEvent = (data) => ({ data: { json: () => data, text: () => JSON.stringify(data) } });

test("a push with no open tab shows a sound-enabled notification", async () => {
  const w = loadWorker();
  await w.dispatch("push", pushEvent({ title: "Amina · new message", body: "Grade uploaded", tag: "chat-1", url: "/?share=shot&token=t" }));
  assert.equal(w.shown.length, 1);
  assert.equal(w.shown[0].title, "Amina · new message");
  assert.equal(w.shown[0].silent, false, "the device sound must not be silenced");
  assert.equal(w.shown[0].tag, "chat-1");
  assert.equal(w.shown[0].renotify, true);
  assert.equal(w.shown[0].data.url, "/?share=shot&token=t");
});
test("a push is not duplicated when a tab is already focused", async () => {
  const w = loadWorker({ windows: [{ url: "https://studio.example/", visibilityState: "visible", focused: true }] });
  await w.dispatch("push", pushEvent({ title: "x", body: "y" }));
  assert.equal(w.shown.length, 0);
  assert.equal(w.messages.length, 1);
});
test("a hidden tab still gets the system notification", async () => {
  const w = loadWorker({ windows: [{ url: "https://studio.example/", visibilityState: "hidden", focused: false }] });
  await w.dispatch("push", pushEvent({ title: "x", body: "y" }));
  assert.equal(w.shown.length, 1);
});
test("malformed or hostile push data is handled", async () => {
  const w = loadWorker();
  await w.dispatch("push", { data: { json: () => { throw new Error("bad json"); }, text: () => "plain text" } });
  assert.equal(w.shown[0].title, "KairFlow");
  assert.equal(w.shown[0].body, "plain text");
  await w.dispatch("push", pushEvent({ title: "t", url: "https://evil.example/phish" }));
  assert.equal(w.shown[1].data.url, "/");
  await w.dispatch("push", { data: null });
  assert.equal(w.shown[2].title, "KairFlow");
});
test("clicking a notification focuses the open app or opens a new window", async () => {
  const open = { url: "https://studio.example/", visibilityState: "hidden", focused: false };
  const w = loadWorker({ windows: [open] });
  let closed = false;
  await w.dispatch("notificationclick", { notification: { close: () => { closed = true; }, data: { url: "/" } } });
  assert.equal(closed, true);
  assert.equal(open.focused, true);
  assert.equal(w.opened.length, 0);
  const none = loadWorker();
  await none.dispatch("notificationclick", { notification: { close() {}, data: { url: "/?share=project&token=abc" } } });
  assert.deepEqual(none.opened, ["https://studio.example/?share=project&token=abc"]);
  const evil = loadWorker();
  await evil.dispatch("notificationclick", { notification: { close() {}, data: { url: "//evil.example/x" } } });
  assert.deepEqual(evil.opened, ["https://studio.example/"], "cross-site targets are ignored");
});
test("a portal tab on another page is navigated to the conversation", async () => {
  const open = { url: "https://studio.example/?share=project&token=other", visibilityState: "hidden", focused: false };
  const w = loadWorker({ windows: [open] });
  await w.dispatch("notificationclick", { notification: { close() {}, data: { url: "/?share=project&token=abc" } } });
  assert.equal(open.navigatedTo, "https://studio.example/?share=project&token=abc");
});

// ---------------------------------------------------------------- wiring contracts
test("the Edge Function authenticates every action and never trusts the caller's ids", () => {
  const fn = read("supabase/functions/push/index.ts");
  assert.match(fn, /action === "dispatch"[\s\S]{0,400}x-push-secret/);
  assert.match(fn, /safeEqual\(presented, cfg\.dispatch_secret\)/);
  assert.match(fn, /if \(!userId\) throw new HttpError\(401, "invalid_credential"\);\s*\n\s*if \(await limited\("push_user"/);
  assert.match(fn, /namespacedKey\(userId, job\.key\)/);
  assert.match(fn, /\.eq\("user_id", userId\)\.in\("dedupe_key", keys\)/);
  assert.match(fn, /portal_client_resolve/); assert.match(fn, /portal_freelancer_resolve/); assert.match(fn, /portal_guest_resolve/);
  assert.match(fn, /isGone\(status\)/);
  assert.doesNotMatch(fn, /user_id: fields\./, "the user id must come from the verified token");
});
test("the migration locks the tables and queue functions to the service role", () => {
  const sql = read("supabase/migrations/20261103090000_web_push.sql");
  for (const t of ["push_subscriptions", "push_jobs", "push_config"]) assert.match(sql, new RegExp(`alter table public\\.${t} enable row level security`));
  assert.match(sql, /revoke all on table public\.push_subscriptions, public\.push_jobs, public\.push_config from public, anon, authenticated/);
  assert.match(sql, /create trigger push_chat_message/); assert.match(sql, /create trigger push_portal_message/); assert.match(sql, /create trigger push_activity/);
  assert.doesNotMatch(sql, /grant [^;]*to (anon|authenticated)/);
});
test("the app registers the worker, schedules timers and syncs preferences", () => {
  assert.match(read("src/main.jsx"), /serviceWorker\.register\("\/sw\.js"\)/);
  const app = read("src/App.jsx");
  assert.match(app, /pomodoroAlert\(/); assert.match(app, /cancelPush\(\[POMODORO_KEY\]\)/);
  assert.match(app, /digestAlert\(counts\)/); assert.match(app, /syncPushPrefs\(/);
  assert.match(read("src/settings/schema.js"), /messages: true/);
  assert.match(read("public/_headers"), /\/sw\.js\s+Cache-Control: no-cache/);
});
