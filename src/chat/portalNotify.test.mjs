import test from "node:test";
import assert from "node:assert/strict";
import { findIncoming, previewBody, readSoundPreference, notificationPermission } from "./notify.js";

test("findIncoming returns only new rows from other people", () => {
  const rows = [{ id: "a", sender_kind: "staff" }, { id: "b", sender_kind: "client" }, { id: "c", sender_kind: "staff" }];
  const out = findIncoming(rows, new Set(["a"]), (r) => r.sender_kind === "client");
  assert.deepEqual(out.map((r) => r.id), ["c"]);
});
test("findIncoming is empty when nothing is new", () => {
  assert.deepEqual(findIncoming([{ id: "a" }], new Set(["a"]), () => false), []);
});
test("previewBody collapses whitespace, truncates, and handles attachments", () => {
  assert.equal(previewBody({ body: "  hi \n there " }), "hi there");
  assert.equal(previewBody({ body: "x".repeat(300) }).length, 118);
  assert.equal(previewBody({ body: "", attachments: [{}] }), "Sent an attachment");
  assert.equal(previewBody({ body: "" }), "New message");
});
test("helpers are safe without a browser", () => {
  assert.equal(readSoundPreference(), true);
  assert.equal(notificationPermission(), "unsupported");
});
