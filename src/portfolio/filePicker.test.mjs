import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { takeFiles, uploadBatch, MAX_ITEMS } from "./logic.js";

// MOCKED browser: no real browser or DOM is available in this test runner (no jsdom), so inputs are modelled by hand.
// `blinkInput` copies the Chromium/WebKit behaviour: `input.files` is ONE live list object and `value = ""` empties it in place.
function blinkInput(files) {
  const list = [...files];
  const input = { files: list, get value() { return list.length ? "C:\\fakepath\\x" : ""; }, set value(v) { if (v === "") list.length = 0; } };
  return input;
}
// `freshListInput` models browsers/jsdom that hand out a NEW list on reset (the old one keeps its files).
function freshListInput(files) {
  const input = { files: [...files], set value(v) { if (v === "") input.files = []; } };
  return input;
}
const mp4 = (name = "reel.mp4", size = 5_000_000) => ({ name, type: "video/mp4", size });

// ---------------------------------------------------------------- the file input handler
test("REGRESSION: the old handler pattern loses the files in a Blink-style input (documents why the bug was silent)", () => {
  const input = blinkInput([mp4()]);
  const captured = input.files;            // what `const f = e.target.files` did
  input.value = "";                        // `e.target.value = ""`
  assert.equal(captured.length, 0);        // `if (f?.length) upload(f)` therefore never ran: no request, no error
});
test("takeFiles copies the picked files BEFORE resetting the input, so nothing is lost in Blink-style or fresh-list browsers", () => {
  for (const make of [blinkInput, freshListInput]) {
    const input = make([mp4("a.mp4"), mp4("b.mp4")]);
    const files = takeFiles(input);
    assert.deepEqual(files.map((f) => f.name), ["a.mp4", "b.mp4"]);
    assert.ok(Array.isArray(files));
    assert.equal(input.value ?? "", "", "the input is reset so choosing the same file again fires change");
  }
});
test("takeFiles tolerates an empty selection or a missing input", () => {
  assert.deepEqual(takeFiles(blinkInput([])), []);
  assert.deepEqual(takeFiles(null), []);
  assert.deepEqual(takeFiles({ files: null }), []);
});
test("PortfolioTab never hands the live FileList on: both inputs go through takeFiles()", () => {
  const src = readFileSync(new URL("./PortfolioTab.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /=\s*e\.target\.files\b/);
  assert.equal((src.match(/takeFiles\(e\.target\)/g) || []).length, 2);
});

// ---------------------------------------------------------------- the upload loop
const run = (files, over = {}) => {
  const calls = []; const progress = [];
  const p = uploadBatch(files, { uploadOne: async (f) => { calls.push(f.name); }, onProgress: (m) => progress.push(m), ...over });
  return p.then((r) => ({ ...r, calls, progress }));
};
test("a valid file starts the upload and reports progress", async () => {
  const r = await run([mp4("a.mp4")]);
  assert.deepEqual(r.calls, ["a.mp4"]); assert.deepEqual(r.problems, []); assert.equal(r.uploaded, 1);
  assert.equal(r.progress[0], "Uploading 1 of 1: a.mp4");
});
test("progress callbacks are forwarded with the file label and a percentage", async () => {
  const r = await run([mp4("a.mp4")], { uploadOne: async (f, onProgress) => { onProgress(0.5); } });
  assert.ok(r.progress.includes("Uploading 1 of 1: a.mp4 (50%)"));
});
test("invalid files produce a visible, actionable error and are never uploaded", async () => {
  const r = await run([{ name: "notes.pdf", type: "application/pdf", size: 10 }, { name: "x.mp4", type: "video/mp4", size: 0 }, { name: "huge.mp4", type: "video/mp4", size: 600 * 1024 * 1024 }, { name: "noext", type: "", size: 5 }]);
  assert.deepEqual(r.calls, []); assert.equal(r.uploaded, 0); assert.equal(r.problems.length, 4);
  assert.match(r.problems[0], /notes\.pdf: use MP4, WebM or MOV video, or JPG, PNG, WebP or GIF images/);
  assert.match(r.problems[1], /the file is empty/); assert.match(r.problems[2], /the limit is/); assert.match(r.problems[3], /use MP4, WebM or MOV/);
});
test("the 50-item limit is enforced across a batch (and counts successes only)", async () => {
  const r = await run([mp4("a.mp4"), mp4("b.mp4"), mp4("c.mp4")], { existingCount: MAX_ITEMS - 2 });
  assert.deepEqual(r.calls, ["a.mp4", "b.mp4"]); assert.match(r.problems[0], /up to 50 items/);
  const failing = await run([mp4("a.mp4"), mp4("b.mp4")], { existingCount: MAX_ITEMS - 1, uploadOne: async () => { throw new Error("x"); } });
  assert.equal(failing.problems.length, 2);                                                         // a failed upload did not use up a slot, so b was attempted
  assert.match(failing.problems[1], /b\.mp4: x/);
});
test("failures are shown with the file name: failed initial request, auth failure, Drive failure", async () => {
  const errs = [
    Object.assign(new Error("Couldn't reach the server. Check your connection and try again."), { code: "network" }),
    Object.assign(new Error("You're signed out. Please sign in again."), { code: "unauthenticated" }),
    Object.assign(new Error("Google Drive rejected the upload (HTTP 403)."), { code: "drive_upload_failed" }),
  ];
  for (const e of errs) {
    const r = await run([mp4("a.mp4")], { uploadOne: async () => { throw e; } });
    assert.deepEqual(r.problems, [`a.mp4: ${e.message}`]); assert.equal(r.uploaded, 0);
  }
});
test("one failure does not stop the rest of the batch; the batch always resolves (loading state can always clear)", async () => {
  const r = await run([mp4("a.mp4"), mp4("b.mp4"), mp4("c.mp4")], { uploadOne: async (f) => { if (f.name === "b.mp4") throw undefined; } });   // even a non-Error rejection
  assert.equal(r.uploaded, 2); assert.equal(r.problems.length, 1); assert.match(r.problems[0], /^b\.mp4: /);
});
test("finalize/unconfirmed failures are handed to describe() (which registers the Retry banner) and not repeated in the failure list", async () => {
  const seen = [];
  for (const code of ["finalize_failed", "upload_unconfirmed"]) {
    const r = await run([mp4("a.mp4")], { describe: (e) => { seen.push(e.code); return e.message; }, uploadOne: async () => { throw Object.assign(new Error("saved? no"), { code }); } });
    assert.deepEqual(r.problems, []);
  }
  assert.deepEqual(seen, ["finalize_failed", "upload_unconfirmed"]);
});
