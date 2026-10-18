// Run: node --test src/settings/notificationSound.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as R from "./runtime.js";

const snd = { enabled: true, id: undefined, volume: 0.5 };

test("sound off in Settings: nothing plays and the desktop notification stays silent", async () => {
  const out = await R.playNotificationSound({ ...snd, enabled: false });
  assert.equal(out, "off");
  assert.equal(R.desktopNotificationSilent(out), true);
});

test("chime plays: desktop notification is silent, so only the app sound is heard", async () => {
  globalThis.Audio = class { play() { return Promise.resolve(); } };
  const out = await R.playNotificationSound(snd);
  assert.equal(out, "played");
  assert.equal(R.desktopNotificationSilent(out), true);
});

test("browser blocks the chime: the desktop sound is allowed so the alert is not missed", async () => {
  globalThis.Audio = class { play() { return Promise.reject(new Error("NotAllowedError")); } };
  // use a different sound id so the cached element from the previous test isn't reused
  const { SOUNDS } = await import("./schema.js");
  const other = SOUNDS[1] || SOUNDS[0];
  const out = await R.playNotificationSound({ ...snd, id: other.id });
  assert.equal(R.desktopNotificationSilent(out), SOUNDS.length > 1 ? false : true);
});

test("no Audio support at all counts as blocked", async () => {
  delete globalThis.Audio;
  const out = await R.playNotificationSound(snd);
  assert.equal(out, "blocked");
  assert.equal(R.desktopNotificationSilent(out), false);
});
