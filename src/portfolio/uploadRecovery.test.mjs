import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import * as L from "./logic.js";

// ---- the real api.js, with the Supabase client, fetch and XHR replaced by in-memory fakes ----------------------
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, n) { if (s === "../supabaseClient") return { url: "data:text/javascript," + encodeURIComponent("export const supabase = { auth: { getSession: async () => ({ data: { session: { access_token: 'jwt' } } }) } }; export const functionUrl = (n) => 'https://proj.supabase.co/functions/v1/' + n;"), shortCircuit: true }; return n(s, c); }`),
  import.meta.url);
const api = await import("./api.js");

const NO_WAIT = [0, 0];
const bigFile = (name = "reel.mp4") => ({ name, type: "video/mp4", size: L.SERVER_UPLOAD_MAX_BYTES + 1 });     // goes the direct-to-Drive route

let server; let puts; let xhrMode = "ok";
function world() {
  puts = 0;
  xhrMode = "ok";
  server = { requests: [], finalize: [], recover: [], drive: new Map(), recoverScript: [], uploadId: "11111111-1111-4111-8111-111111111111" };
  globalThis.XMLHttpRequest = class {
    constructor() { this.upload = {}; }
    open() {} setRequestHeader() {}
    send() {
      puts++;
      queueMicrotask(() => {
        if (xhrMode === "network") return this.onerror();
        if (xhrMode === "403") { this.status = 403; return this.onload(); }
        if (xhrMode === "503") { this.status = 503; return this.onload(); }
        if (xhrMode === "unreadable") { this.status = 200; this.responseText = "<html>"; return this.onload(); }
        this.status = 200; this.responseText = JSON.stringify({ id: `drive-file-${puts}xxxxx` }); this.onload();
      });
    }
  };
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body); server.requests.push(body.action);
    if (body.action === "init-upload") return Response.json({ uploadUrl: "https://upload.example/session?secret=1", ...(server.noUploadId ? {} : { uploadId: server.uploadId }) });
    if (body.action === "recover-upload") {
      server.recover.push(body);
      const next = server.recoverScript.shift() ?? "ok";
      if (next === "ok") {
        const item = { id: `item-${server.drive.size + 1}`, drive_file_id: "drive-file-recovered" };
        const existing = [...server.drive.values()].find((i) => i.drive_file_id === item.drive_file_id);
        server.drive.set((existing ?? item).id, existing ?? item);
        return Response.json({ item: existing ?? item, warnings: [], fileId: item.drive_file_id });
      }
      return Response.json(next.body, { status: next.status });
    }
    if (body.action === "finalize") {
      server.finalize.push(body);
      const next = server.script.shift() ?? "ok";
      if (next === "ok") {
        const existing = [...server.drive.values()].find((i) => i.drive_file_id === body.fileId);          // idempotent, like the real server
        const item = existing ?? { id: `item-${server.drive.size + 1}`, drive_file_id: body.fileId };
        server.drive.set(item.id, item);
        return Response.json({ item, warnings: server.warnings ?? [] });
      }
      return Response.json(next.body, { status: next.status });
    }
    throw new Error(`unexpected action ${body.action}`);
  };
  server.script = [];
}

// ---------------------------------------------------------------- pure helpers
test("withFinalizeRetry: retries retryable failures, stops on non-retryable ones, rethrows the last error", async () => {
  const slept = []; const sleep = async (ms) => { slept.push(ms); };
  let n = 0;
  assert.equal(await L.withFinalizeRetry(async () => { if (++n < 3) { const e = new Error("x"); e.retryable = true; throw e; } return "ok"; }, { delays: [5, 7], sleep }), "ok");
  assert.deepEqual(slept, [5, 7]); assert.equal(n, 3);
  n = 0;
  await assert.rejects(() => L.withFinalizeRetry(async () => { n++; const e = new Error("fatal"); e.retryable = false; throw e; }, { delays: [1, 1], sleep }), /fatal/);
  assert.equal(n, 1);
  n = 0;
  await assert.rejects(() => L.withFinalizeRetry(async () => { n++; const e = new Error(`try ${n}`); e.retryable = true; throw e; }, { delays: [1, 1], sleep }), /try 3/);
  assert.equal(n, 3);
});
test("isRetryableFinalizeError: server-marked retryable or a dropped connection", () => {
  assert.equal(L.isRetryableFinalizeError({ retryable: true }), true);
  assert.equal(L.isRetryableFinalizeError({ code: "network" }), true);
  for (const e of [{ code: "duplicate" }, { code: "invalid_file" }, { retryable: false }, {}, null]) assert.equal(L.isRetryableFinalizeError(e), false);
});
test("finalizeFailureMessage tells the owner not to upload again", () => {
  assert.match(L.finalizeFailureMessage("reel.mp4", "db down"), /reel\.mp4 reached Google Drive/);
  assert.match(L.finalizeFailureMessage("reel.mp4", "db down"), /instead of uploading it again/);
});

// ---------------------------------------------------------------- the real upload flow
test("upload + finalize succeed: one session, one PUT, one item", async () => {
  world();
  const item = await api.uploadMedia(bigFile(), { retryDelays: NO_WAIT });
  assert.equal(item.drive_file_id, "drive-file-1xxxxx"); assert.equal(puts, 1);
  assert.deepEqual(server.requests, ["init-upload", "finalize"]);
});
test("finalize fails after a good upload: a distinguishable error carrying the Drive file id; retrying registers it WITHOUT uploading again", async () => {
  world();
  server.script = Array(3).fill({ status: 500, body: { error: "Couldn't save the portfolio item. Try again.", code: "db_error", retryable: true } });   // initial try + both automatic retries
  const err = await api.uploadMedia(bigFile("grade.mp4"), { retryDelays: NO_WAIT }).then(() => null, (e) => e);
  assert.ok(err instanceof api.PortfolioError);
  assert.equal(err.code, "finalize_failed"); assert.equal(err.fileId, "drive-file-1xxxxx"); assert.equal(err.fileName, "grade.mp4"); assert.equal(err.retryable, true);
  assert.match(err.message, /reached Google Drive/); assert.match(err.message, /Retry saving/);
  assert.equal(server.finalize.length, 3); assert.equal(puts, 1);
  // The owner presses "Retry saving": same file id, no new init-upload / PUT.
  const item = await api.finalizeUpload({ fileId: err.fileId, replaceItemId: err.replaceItemId, fileName: err.fileName }, { retryDelays: NO_WAIT });
  assert.equal(item.drive_file_id, "drive-file-1xxxxx");
  assert.equal(puts, 1); assert.equal(server.requests.filter((a) => a === "init-upload").length, 1);
  assert.equal(server.drive.size, 1);
});
test("repeated retries never create duplicate items", async () => {
  world();
  const a = await api.finalizeUpload({ fileId: "drive-file-1xxxxx" }, { retryDelays: NO_WAIT });
  const b = await api.finalizeUpload({ fileId: "drive-file-1xxxxx" }, { retryDelays: NO_WAIT });
  assert.equal(a.id, b.id); assert.equal(server.drive.size, 1);
});
test("a transient finalize failure is retried automatically and then succeeds", async () => {
  world(); server.script = [{ status: 502, body: { error: "Couldn't check the file in Google Drive.", code: "drive_unavailable", retryable: true } }];
  const item = await api.uploadMedia(bigFile(), { retryDelays: NO_WAIT });
  assert.equal(item.drive_file_id, "drive-file-1xxxxx"); assert.equal(server.finalize.length, 2); assert.equal(puts, 1);
});
test("a non-retryable finalize failure is not retried; the error still carries the file id and says so", async () => {
  world(); server.script = [{ status: 422, body: { error: "That file isn't in your portfolio folder.", code: "drive_file_foreign", retryable: false } }];
  const err = await api.uploadMedia(bigFile(), { retryDelays: NO_WAIT }).then(() => null, (e) => e);
  assert.equal(err.code, "finalize_failed"); assert.equal(err.retryable, false); assert.equal(server.finalize.length, 1);
  assert.match(err.message, /isn.t in your portfolio folder/);
});
test("replacement keeps replaceItemId through failure and retry; cleanup warnings are surfaced", async () => {
  world(); const R = "00000000-0000-4000-8000-000000000001";
  server.script = Array(3).fill({ status: 500, body: { error: "x", code: "db_error", retryable: true } });
  const err = await api.uploadMedia(bigFile(), { replaceItemId: R, retryDelays: NO_WAIT }).then(() => null, (e) => e);
  assert.equal(err.replaceItemId, R);
  assert.ok(server.finalize.every((b) => b.replaceItemId === R));
  server.warnings = [{ code: "old_file_cleanup_failed", message: "old file not trashed" }];
  const seen = []; await api.finalizeUpload(err, { retryDelays: NO_WAIT, onWarning: (m) => seen.push(...m) });
  assert.deepEqual(seen, ["old file not trashed"]); assert.equal(server.finalize.at(-1).replaceItemId, R);
});
test("a failure BEFORE the bytes reach Drive is not a finalize failure (safe to just upload again)", async () => {
  world();
  globalThis.XMLHttpRequest = class { constructor() { this.upload = {}; } open() {} setRequestHeader() {} send() { queueMicrotask(() => { this.status = 403; this.onload(); }); } };
  const err = await api.uploadMedia(bigFile(), { retryDelays: NO_WAIT }).then(() => null, (e) => e);
  assert.equal(err.code, "drive_upload_failed"); assert.equal(err.fileId, undefined); assert.equal(server.finalize.length, 0);
});
test("small files (server route): if the server could not clean up its copy it hands back the id and the client offers a retry instead of a re-upload", async () => {
  world();
  globalThis.fetch = async () => Response.json({ error: "Couldn't save the portfolio item. Try again.", code: "db_error", retryable: true, fileId: "drive-file-9xxxxx" }, { status: 500 });
  const err = await api.uploadMedia({ name: "p.png", type: "image/png", size: 1000 }, { retryDelays: NO_WAIT }).then(() => null, (e) => e);
  assert.equal(err.code, "finalize_failed"); assert.equal(err.fileId, "drive-file-9xxxxx");
  // an ordinary server-route failure (file already discarded) stays a plain error: re-uploading is correct there
  globalThis.fetch = async () => Response.json({ error: "Couldn't save the portfolio item. Try again.", code: "db_error", retryable: false }, { status: 500 });
  const plain = await api.uploadMedia({ name: "p.png", type: "image/png", size: 1000 }, { retryDelays: NO_WAIT }).then(() => null, (e) => e);
  assert.equal(plain.code, "db_error"); assert.equal(plain.fileId, undefined);
});
test("secrets: neither the resumable session URL nor tokens appear in thrown errors", async () => {
  world(); server.script = Array(3).fill({ status: 500, body: { error: "boom", code: "db_error", retryable: true } });
  const err = await api.uploadMedia(bigFile(), { retryDelays: NO_WAIT }).then(() => null, (e) => e);
  assert.ok(!JSON.stringify({ m: err.message, c: err.code, f: err.fileId }).match(/secret=1|upload\.example|Bearer|jwt/));
});

// ---------------------------------------------------------------- lost PUT response -> recovery (client + mocked server; the server side is covered in register.test.mjs)
const NOT_FOUND = { status: 404, body: { error: "No completed upload was found", code: "upload_not_found", retryable: false } };
const DRIVE_DOWN = { status: 502, body: { error: "Couldn't check Google Drive", code: "drive_unavailable", retryable: true } };

test("lost PUT response (network error) -> the completed upload is recovered by its upload id: no second upload, one item", async () => {
  world(); xhrMode = "network";
  const item = await api.uploadMedia(bigFile("a.mp4"), { retryDelays: NO_WAIT });
  assert.equal(item.drive_file_id, "drive-file-recovered");
  assert.equal(puts, 1); assert.deepEqual(server.requests, ["init-upload", "recover-upload"]);
  assert.equal(server.recover[0].uploadId, server.uploadId); assert.equal(server.finalize.length, 0);
});
test("an unreadable 200 and a 5xx from Drive are treated as ambiguous too (recovered), a 4xx is a definite failure (not recovered)", async () => {
  for (const mode of ["unreadable", "503"]) {
    world(); xhrMode = mode;
    assert.equal((await api.uploadMedia(bigFile(), { retryDelays: NO_WAIT })).drive_file_id, "drive-file-recovered", mode);
    assert.equal(server.recover.length, 1); assert.equal(puts, 1);
  }
  world(); xhrMode = "403";
  const err = await api.uploadMedia(bigFile(), { retryDelays: NO_WAIT }).then(() => null, (e) => e);
  assert.equal(err.code, "drive_upload_failed"); assert.equal(server.recover.length, 0);
});
test("recovery 'not found' (after retrying Drive's listing lag) is a DEFINITE answer: nothing was stored, safe to upload again", async () => {
  world(); xhrMode = "network"; server.recoverScript = [NOT_FOUND, NOT_FOUND, NOT_FOUND, NOT_FOUND];
  const err = await api.uploadMedia(bigFile("a.mp4"), { retryDelays: [0, 0, 0] }).then(() => null, (e) => e);
  assert.equal(err.code, "drive_upload_network"); assert.equal(err.uploadId, undefined); assert.equal(err.fileId, undefined);
  assert.match(err.message, /upload it again/i); assert.equal(server.recover.length, 4); assert.equal(server.drive.size, 0);
});
test("'not found' that turns into 'found' on a later retry is a success (listing lag)", async () => {
  world(); xhrMode = "network"; server.recoverScript = [NOT_FOUND, NOT_FOUND];
  assert.equal((await api.uploadMedia(bigFile(), { retryDelays: [0, 0, 0] })).drive_file_id, "drive-file-recovered");
  assert.equal(server.recover.length, 3);
});
test("if recovery itself can't be completed, the owner gets 'upload_unconfirmed' with the upload id and can check again later without re-uploading", async () => {
  world(); xhrMode = "network"; server.recoverScript = Array(4).fill(DRIVE_DOWN);
  const err = await api.uploadMedia(bigFile("b.mp4"), { replaceItemId: "00000000-0000-4000-8000-000000000009", retryDelays: [0, 0, 0] }).then(() => null, (e) => e);
  assert.equal(err.code, "upload_unconfirmed"); assert.equal(err.uploadId, server.uploadId); assert.equal(err.retryable, true);
  assert.equal(err.replaceItemId, "00000000-0000-4000-8000-000000000009"); assert.match(err.message, /Check again/);
  assert.equal(puts, 1);
  const item = await api.recoverUpload(err, { retryDelays: [0] });                    // the "Check again" button
  assert.equal(item.drive_file_id, "drive-file-recovered"); assert.equal(puts, 1);
  assert.equal(server.recover.at(-1).replaceItemId, "00000000-0000-4000-8000-000000000009");
  await api.recoverUpload(err, { retryDelays: [0] });                                  // pressing it again must not duplicate
  assert.equal(server.drive.size, 1);
});
test("an older server that returns no uploadId can't recover: the original upload error is surfaced unchanged", async () => {
  world(); xhrMode = "network"; server.noUploadId = true;
  const err = await api.uploadMedia(bigFile(), { retryDelays: NO_WAIT }).then(() => null, (e) => e);
  assert.equal(err.code, "drive_upload_network"); assert.equal(server.recover.length, 0);
});
test("non-retryable recovery answers (ambiguous match, bad request) are surfaced as-is, not looped as 'check again'", async () => {
  world(); xhrMode = "network"; server.recoverScript = [{ status: 409, body: { error: "More than one file matches", code: "ambiguous_upload", retryable: false } }];
  const err = await api.uploadMedia(bigFile(), { retryDelays: [0, 0, 0] }).then(() => null, (e) => e);
  assert.equal(err.code, "ambiguous_upload"); assert.equal(server.recover.length, 1);
});
test("recovery of a replacement surfaces the server's 'target vanished -> added as new' warning", async () => {
  world(); xhrMode = "network";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { const b = JSON.parse(init.body); if (b.action === "recover-upload") return Response.json({ item: { id: "n1" }, warnings: [{ code: "replace_target_missing", message: "The item you were replacing no longer exists, so the file was added as a new item." }], fileId: "f" }); return realFetch(url, init); };
  const seen = []; await api.uploadMedia(bigFile(), { replaceItemId: "00000000-0000-4000-8000-000000000009", retryDelays: NO_WAIT, onWarning: (m) => seen.push(...m) });
  assert.match(seen[0], /no longer exists/);
});
