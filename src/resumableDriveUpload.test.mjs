import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { uploadResumableDriveFile, fingerprintFile, loadPendingUpload, pendingStorageKey } from "./resumableDriveUpload.js";

const SIZE = 1000;
const mkFile = (bytes = "a", extra = {}) => {
  const data = new Uint8Array(SIZE).fill(bytes.charCodeAt(0));
  return { name: "render.mp4", type: "video/mp4", size: SIZE, lastModified: 1, slice: (s, e) => new Blob([data.slice(s, e)]), data, ...extra };
};
const memStorage = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), m }; };
const noSleep = () => { const waits = []; const fn = async (ms) => { waits.push(ms); }; fn.waits = waits; return fn; };

/** Scriptable Google Drive + Edge Function double. */
function setup({ listingLag = 0, putScript = [], statusScript = [], recoverFoundAtStart = false } = {}) {
  const calls = []; const puts = []; const statuses = [];
  const state = { listed: recoverFoundAtStart, listCalls: 0, sessions: 0 };
  const origFetch = globalThis.fetch, origXhr = globalThis.XMLHttpRequest;
  globalThis.fetch = async (_u, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    if (body.action === "recover-upload") {
      state.listCalls++;
      if (state.listed && state.listCalls > listingLag) return Response.json({ success: true, fileId: "drive-file-123456" });
      return Response.json({ error: "nf", code: "upload_not_found" }, { status: 404 });
    }
    if (body.action === "init-upload") { state.sessions++; return Response.json({ uploadUrl: `https://drive.example/session/${state.sessions}` }); }
    if (body.action === "finalize") return Response.json({ success: true, fileId: body.fileId });
    throw new Error("bad action");
  };
  globalThis.XMLHttpRequest = class {
    constructor() { this.upload = {}; this.h = {}; }
    open(m, u) { this.url = u; }
    setRequestHeader(k, v) { this.h[k] = v; }
    getResponseHeader(k) { return this.resp?.headers?.[k] ?? null; }
    send(body) {
      const isStatus = /^bytes \*\//.test(this.h["Content-Range"] || "");
      const script = isStatus ? statusScript : putScript;
      (isStatus ? statuses : puts).push({ url: this.url, range: this.h["Content-Range"], len: body?.size ?? null });
      const next = script.shift() ?? (isStatus ? { status: 404 } : { status: 200, text: JSON.stringify({ id: "drive-file-123456" }) });
      queueMicrotask(() => {
        if (next === "error") return this.onerror();
        if (next.listed) state.listed = true;
        this.resp = next; this.status = next.status; this.responseText = next.text || ""; this.onload();
      });
    }
  };
  return { calls, puts, statuses, state, restore() { globalThis.fetch = origFetch; globalThis.XMLHttpRequest = origXhr; } };
}
const run = (env, over = {}) => uploadResumableDriveFile({ url: "/fn", actionPayload: { token: "share" }, file: mkFile(), storageKey: "k", storage: over.storage ?? memStorage(), sleep: noSleep(), ...over });
const actions = (env) => env.calls.map((c) => c.action);

test("fresh upload: one session, one PUT, finalize carries the fingerprint and same id", async () => {
  const env = setup(); const storage = memStorage();
  try {
    const r = await run(env, { storage });
    assert.equal(r.success, true);
    assert.deepEqual(actions(env), ["recover-upload", "init-upload", "finalize"]);
    assert.equal(env.puts.length, 1);
    assert.match(env.calls[1].fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(new Set(env.calls.map((c) => c.uploadId)).size, 1);
    assert.equal(storage.m.size, 0, "pending state cleared after success");
  } finally { env.restore(); }
});

// BUG 1: Drive listings lag a completed upload.
test("BUG1: after a prior attempt, listing is retried with 1s,3s,6s before 'missing' is concluded", async () => {
  const storage = memStorage(); const sleep = noSleep();
  const env = setup({ putScript: ["error"], statusScript: ["error", "error"] });
  try {
    await run(env, { storage, putRetryDelays: [] }).catch(() => {});
    assert.equal(env.state.sessions, 1);
    // Drive lists the file only on the 4th recover call (after 3 retries).
    env.state.listed = true; env.state.listCalls = 0;
    const lag = 3; // calls 1..3 miss
    const orig = globalThis.fetch;
    let n = 0;
    globalThis.fetch = async (u, init) => { const b = JSON.parse(init.body); if (b.action === "recover-upload" && ++n <= lag) return Response.json({ code: "upload_not_found", error: "nf" }, { status: 404 }); return orig(u, init); };
    const r = await run(env, { storage, sleep });
    assert.equal(r.success, true);
    assert.deepEqual(sleep.waits, [1000, 3000, 6000]);
    assert.equal(env.state.sessions, 1, "no new session / duplicate file");
  } finally { env.restore(); }
});

test("BUG1: still-uncertain after backoff throws upload_uncertain (not 'missing') and never opens a second session", async () => {
  const storage = memStorage();
  const env = setup({ putScript: ["error"], statusScript: ["error", "error", "error"] });
  try {
    await run(env, { storage, putRetryDelays: [] }).catch(() => {});
    const err = await run(env, { storage }).catch((e) => e);
    assert.equal(err.code, "upload_uncertain");
    assert.equal(env.state.sessions, 1);
    assert.ok(loadPendingUpload("k", await fingerprintFile(mkFile()), storage), "recovery state retained for the next retry");
  } finally { env.restore(); }
});

test("lost PUT response is resolved by the session status (authoritative), without any listing lag", async () => {
  const env = setup({ putScript: ["error"], statusScript: [{ status: 200, text: JSON.stringify({ id: "drive-file-123456" }) }] });
  try {
    const r = await run(env);
    assert.equal(r.success, true);
    assert.equal(env.state.sessions, 1);
    assert.equal(env.puts.length, 1, "bytes were not re-sent");
    assert.equal(env.state.listCalls, 1, "only the initial pre-upload listing check");
  } finally { env.restore(); }
});

// BUG 4: survives page reload / byte-range continuation
test("BUG4: interrupted upload resumes from the last received byte after a 'reload' (new call, same storage)", async () => {
  const storage = memStorage();
  const env = setup({ putScript: ["error"], statusScript: ["error", { status: 308, headers: { Range: "bytes=0-399" } }] });
  try {
    const first = await run(env, { storage, putRetryDelays: [] }).catch((e) => e);
    assert.equal(first.code, "upload_uncertain");
    const sessionUrl = env.puts[0].url;
    // "Reload": nothing in memory, only storage. Drive now reports 400 bytes received.
    const second = await run(env, { storage });
    assert.equal(second.success, true);
    assert.equal(env.state.sessions, 1, "same Drive session reused");
    const resume = env.puts[1];
    assert.equal(resume.url, sessionUrl);
    assert.equal(resume.range, "bytes 400-999/1000");
    assert.equal(resume.len, 600);
    assert.equal(second.uploadId, env.calls[0].uploadId, "original upload id reused after reload");
  } finally { env.restore(); }
});

test("BUG4: Drive finished but registration failed; after reload the same file id is finalized again, not re-uploaded", async () => {
  const storage = memStorage(); const orig = globalThis.fetch;
  const env = setup();
  try {
    let failFinalize = true; const f = globalThis.fetch;
    globalThis.fetch = async (u, init) => { const b = JSON.parse(init.body); if (b.action === "finalize" && failFinalize) { failFinalize = false; return Response.json({ error: "db down" }, { status: 500 }); } return f(u, init); };
    await assert.rejects(() => run(env, { storage }));
    const r = await run(env, { storage });
    assert.equal(r.success, true);
    assert.equal(env.puts.length, 1);
    assert.equal(env.state.sessions, 1);
  } finally { globalThis.fetch = orig; env.restore(); }
});

// BUG 3: file identity
test("BUG3: a different file with identical name/size/mtime never reuses the previous upload id", async () => {
  const storage = memStorage();
  const env = setup({ putScript: ["error"], statusScript: ["error"] });
  try {
    await run(env, { storage, file: mkFile("a"), putRetryDelays: [] }).catch(() => {});
    const idA = env.calls[0].uploadId;
    env.calls.length = 0;
    await run(env, { storage, file: mkFile("b") });
    assert.notEqual(env.calls[0].uploadId, idA);
    assert.equal(env.state.sessions, 2, "its own session; the earlier file's session is not reused");
    assert.notEqual(await fingerprintFile(mkFile("a")), await fingerprintFile(mkFile("b")));
    // Metadata is part of identity: it can only make a match stricter.
    assert.notEqual(await fingerprintFile(mkFile("a")), await fingerprintFile(mkFile("a", { lastModified: 999 })));
    assert.equal(await fingerprintFile(mkFile("a")), await fingerprintFile(mkFile("a")));
    // Difference only in the middle/tail is detected too.
    const tail = mkFile("a"); tail.data[SIZE - 1] = 9;
    assert.notEqual(await fingerprintFile(mkFile("a")), await fingerprintFile(tail));
  } finally { env.restore(); }
});

test("state storage being unavailable degrades gracefully", async () => {
  const env = setup();
  try {
    const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
    assert.equal((await run(env, { storage: broken })).success, true);
  } finally { env.restore(); }
});

// ---------------- source-level checks for the server side (Deno is not available in CI here)
const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

test("neither Edge Function parses or relays multipart bodies; both use resumable sessions", async () => {
  for (const src of await Promise.all([read("../supabase/functions/freelancer-drive-upload/index.ts"), read("../supabase/functions/final-qc-upload/index.ts")])) {
    assert.doesNotMatch(src, /req\.formData\(\)/); assert.doesNotMatch(src, /uploadFileToDrive\(/);
    assert.match(src, /createResumableUploadSession\(/); assert.match(src, /recover-upload/);
  }
});

test("BUG2: freelancer finalization uses one atomic idempotent RPC, not check-then-append", async () => {
  const src = await read("../supabase/functions/freelancer-drive-upload/index.ts");
  assert.match(src, /append_shot_deliverable_once/);
  assert.doesNotMatch(src, /append_shot_file/);
  assert.doesNotMatch(src, /shot\.deliverables/);
  const sql = await read("../supabase/migrations/20270106100000_append_shot_deliverable_once.sql");
  assert.match(sql, /update public\.shots/i);
  assert.match(sql, /not exists/i);
  assert.match(sql, /driveFileId/);
  assert.match(sql, /grant execute[^;]+service_role/i);
  assert.match(sql, /revoke all[^;]+anon/i);
});

test("both Edge Functions bind recovery/finalization to the content fingerprint", async () => {
  for (const src of await Promise.all([read("../supabase/functions/freelancer-drive-upload/index.ts"), read("../supabase/functions/final-qc-upload/index.ts")])) {
    assert.match(src, /FINGERPRINT_PROP/); assert.match(src, /fingerprintMatches\(meta,body\.fingerprint\)/); assert.match(src, /pickRecoveredFile\(/);
  }
});

test("recovery picks a deterministic file when retries left several with one upload id", async () => {
  const { pickRecoveredFile } = await import("../supabase/functions/_shared/upload_recovery.ts");
  const fp = "a".repeat(64), other = "b".repeat(64);
  const mk = (id, createdTime, f = fp, size = "1000", trashed = false) => ({ id, createdTime, size, trashed, appProperties: { fp: f } });
  assert.equal(pickRecoveredFile([mk("newer", "2026-01-02"), mk("older", "2026-01-01")], fp, 1000).id, "older");
  assert.equal(pickRecoveredFile([mk("x", "2026-01-01", other), mk("y", "2026-01-02")], fp, 1000).id, "y", "different-content file ignored");
  assert.equal(pickRecoveredFile([mk("x", "2026-01-01", other)], fp, 1000), null);
  assert.equal(pickRecoveredFile([mk("x", "2026-01-01", fp, "5")], fp, 1000), null, "size must match");
  assert.equal(pickRecoveredFile([], fp, 1000), null);
});

test("a definitively rejected file (422) clears saved state so the same file can be uploaded fresh", async () => {
  const storage = memStorage(); const orig = globalThis.fetch;
  const env = setup();
  try {
    const f = globalThis.fetch; let reject = true;
    globalThis.fetch = async (u, init) => { const b = JSON.parse(init.body); if (b.action === "finalize" && reject) { reject = false; return Response.json({ error: "bad size", success: false }, { status: 422 }); } return f(u, init); };
    await assert.rejects(() => run(env, { storage }));
    assert.equal(storage.m.size, 0);
    assert.equal((await run(env, { storage })).success, true);
    assert.equal(env.state.sessions, 2, "fresh session after a definitive rejection");
  } finally { globalThis.fetch = orig; env.restore(); }
});

test("upload ids containing underscores are accepted by the Drive listing query", async () => {
  const src = await readFile(new URL("../supabase/functions/_shared/google.ts", import.meta.url), "utf8");
  assert.match(src, /\^\[A-Za-z0-9_-\]\{1,64\}\$\/\.test\(value\)/);
});

test("AUDIT: freelancer init enforces a size cap, safe MIME, and a clear not-accepting status", async () => {
  const f = await read("../supabase/functions/freelancer-drive-upload/index.ts");
  assert.match(f, /freelancerMaxBytes\(/); assert.match(f, /file_too_large/); assert.match(f, /safeMime\(body\.mimeType\)/); assert.match(f, /cut_not_accepting_submissions/);
  const q = await read("../supabase/functions/final-qc-upload/index.ts");
  assert.match(q, /safeMime\(body\.mimeType\)/); assert.match(q, /upload_key_used/);
  const { safeMime, freelancerMaxBytes } = await import("../supabase/functions/_shared/upload_recovery.ts");
  assert.equal(safeMime("video/mp4"), "video/mp4");
  assert.equal(safeMime("x\r\nEvil: 1"), "application/octet-stream");
  assert.equal(safeMime(undefined), "application/octet-stream");
  assert.equal(freelancerMaxBytes(undefined), 10 * 1024 ** 3);
  assert.equal(freelancerMaxBytes("1048576"), 1048576);
  assert.equal(freelancerMaxBytes("garbage"), 10 * 1024 ** 3);
});

test("AUDIT: Final QC rotates the upload key after a validation rejection", async () => {
  const api = await read("./cutWorkflowApi.js"); const panel = await read("./CutWorkflowPanel.jsx");
  assert.match(api, /final_invalid/); assert.match(panel, /e\.code === "final_invalid" \? newUploadKey\(\)/);
});

test("AUDIT2: a session Drive definitively rejects is forgotten so the retry opens a fresh one", async () => {
  const storage = memStorage();
  const env = setup({ putScript: [{ status: 403, text: "{}" }] });
  try {
    await assert.rejects(() => run(env, { storage }), (e) => e.code === "drive_upload_failed");
    assert.equal(loadPendingUpload("k", await fingerprintFile(mkFile()), storage).sessionUri, null);
    assert.equal((await run(env, { storage })).success, true);
    assert.equal(env.state.sessions, 2);
  } finally { env.restore(); }
});
