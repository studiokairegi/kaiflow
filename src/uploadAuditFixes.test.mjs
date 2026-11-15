// Regression tests for the production-readiness audit findings C1-C3 and P2-P10.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { installEdgeEnvironment, installGoogle, loadFunction, post } from "../supabase/tests/edgeHarness.mjs";
import { uploadResumableDriveFile, fingerprintFile, loadPendingUpload, newUploadId } from "./resumableDriveUpload.js";
import { md5Blob, sha256Bytes } from "./uploadHash.js";

const fnUrl = (name) => new URL(`../supabase/functions/${name}/index.ts`, import.meta.url).href;
const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const FP = "a".repeat(64);
const MD5 = "b".repeat(32);

// ------------------------------------------------------------------------------------------ client doubles
const SIZE = 1000;
const mkFile = (byte = 97, extra = {}) => {
  const data = new Uint8Array(SIZE).fill(byte);
  return { name: "render.mp4", type: "video/mp4", size: SIZE, lastModified: 1, slice: (s, e) => new Blob([data.slice(s, e)]), data, ...extra };
};
const memStorage = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), m }; };
const noSleep = () => { const waits = []; const fn = async (ms) => { waits.push(ms); }; fn.waits = waits; return fn; };

/** Fetch + XHR double. `server(body, calls)` returns a Response-like or undefined for the default happy path. */
function setup({ server } = {}) {
  const calls = []; const origFetch = globalThis.fetch, origXhr = globalThis.XMLHttpRequest; const headersSeen = [];
  globalThis.fetch = async (_u, init) => {
    const body = JSON.parse(init.body); calls.push(body); headersSeen.push(init.headers);
    const custom = server?.(body, calls);
    if (custom) return custom;
    if (body.action === "recover-upload") return Response.json({ error: "nf", code: "upload_not_found" }, { status: 404 });
    if (body.action === "init-upload") return Response.json({ uploadUrl: "https://drive.example/session/1" });
    if (body.action === "finalize") return Response.json({ success: true, fileId: body.fileId });
    throw new Error("bad action");
  };
  globalThis.XMLHttpRequest = class {
    constructor() { this.upload = {}; }
    open() {} setRequestHeader() {} getResponseHeader() { return null; }
    send() { queueMicrotask(() => { this.status = 200; this.responseText = JSON.stringify({ id: "drive-file-123456" }); this.onload(); }); }
  };
  return { calls, headersSeen, restore() { globalThis.fetch = origFetch; globalThis.XMLHttpRequest = origXhr; } };
}
const run = (over = {}) => uploadResumableDriveFile({ url: "/fn", actionPayload: { token: "share" }, file: mkFile(), storageKey: "k", storage: over.storage ?? memStorage(), sleep: noSleep(), locks: null, ...over });

// ================================================================================================ C1
test("C1: the sampled fingerprint cannot see an unsampled byte, but the full-content MD5 can", async () => {
  const size = 20 * 1024 * 1024; const SAMPLE = 256 * 1024;
  const a = new Uint8Array(size).fill(7); const b = a.slice();
  const w1 = Math.floor((size - SAMPLE) / 9), w2 = Math.floor(((size - SAMPLE) * 2) / 9);
  const unsampled = Math.floor((w1 + w2) / 2); // strictly between two sampled windows
  b[unsampled] = 8;
  const mk = (data) => ({ name: "x.mov", type: "video/quicktime", size, lastModified: 5, slice: (s, e) => new Blob([data.slice(s, e)]) });
  assert.equal(await fingerprintFile(mk(a)), await fingerprintFile(mk(b)), "documented limit: identity key alone is blind here");
  const [ma, mb] = [await md5Blob(mk(a)), await md5Blob(mk(b))];
  assert.notEqual(ma, mb);
  assert.equal(ma, createHash("md5").update(a).digest("hex"));
});

test("C1: MD5 and fallback SHA-256 match Node's reference digests across block-boundary lengths and chunk sizes", async () => {
  for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 121, 128, 4097]) {
    const bytes = new Uint8Array(n).map((_, i) => (i * 31 + n) & 255);
    assert.equal(await md5Blob(new Blob([bytes]), { chunkBytes: 37 }), createHash("md5").update(bytes).digest("hex"), `md5 n=${n}`);
    assert.equal(sha256Bytes(bytes), createHash("sha256").update(bytes).digest("hex"), `sha256 n=${n}`);
  }
});

test("C1: every finalize carries the full-file MD5, and it is persisted so a retried finalize does not re-read the file", async () => {
  const env = setup(); const storage = memStorage(); let hashes = 0;
  const hashFile = async (f) => { hashes++; return md5Blob(f); };
  try {
    await run({ storage, hashFile });
    const fin = env.calls.find((c) => c.action === "finalize");
    assert.equal(fin.md5, createHash("md5").update(mkFile().data).digest("hex"));
    assert.equal(hashes, 1);
  } finally { env.restore(); }
  // registration fails after Drive completed -> state keeps fileId + md5; the retry must not hash again
  const storage2 = memStorage(); let fail = true; hashes = 0;
  const env2 = setup({ server: (b) => (b.action === "finalize" && fail ? (fail = false, Response.json({ error: "db down" }, { status: 503 })) : undefined) });
  try {
    await assert.rejects(() => run({ storage: storage2, hashFile }));
    const saved = loadPendingUpload("k", await fingerprintFile(mkFile()), storage2);
    assert.ok(saved.fileId); assert.match(saved.md5, /^[a-f0-9]{32}$/);
    await run({ storage: storage2, hashFile });
    assert.equal(hashes, 1, "md5 reused from saved state");
  } finally { env2.restore(); }
});

test("C1: a recover-upload answered md5_required makes the client hash the file once and retry with it", async () => {
  const storage = memStorage(); const env = setup({ server: (b) => {
    if (b.action === "recover-upload") return b.md5 ? Response.json({ success: true, fileId: "drive-file-123456" }) : Response.json({ error: "need md5", code: "md5_required", fileId: "drive-file-123456" }, { status: 428 });
  } });
  try {
    const r = await run({ storage });
    assert.equal(r.success, true);
    const recovers = env.calls.filter((c) => c.action === "recover-upload");
    assert.equal(recovers.length, 2); assert.equal(recovers[0].md5, undefined); assert.match(recovers[1].md5, /^[a-f0-9]{32}$/);
    assert.ok(!env.calls.some((c) => c.action === "init-upload"), "no second session");
  } finally { env.restore(); }
});

test("C1: Drive not having published md5Checksum yet (503 checksum_pending) is retried with backoff, not failed", async () => {
  let pending = 2; const sleep = noSleep();
  const env = setup({ server: (b) => (b.action === "finalize" && pending-- > 0 ? Response.json({ error: "processing", code: "checksum_pending" }, { status: 503 }) : undefined) });
  try {
    const r = await run({ sleep });
    assert.equal(r.success, true);
    assert.equal(env.calls.filter((c) => c.action === "finalize").length, 3);
    assert.deepEqual(sleep.waits.slice(0, 2), [1000, 3000]);
  } finally { env.restore(); }
});

test("C1: a content mismatch from the server clears saved state so re-selecting uploads fresh", async () => {
  const storage = memStorage(); let mismatch = true; let sessions = 0;
  const env = setup({ server: (b) => {
    if (b.action === "init-upload") { sessions++; return Response.json({ uploadUrl: `https://drive.example/session/${sessions}` }); }
    if (b.action === "finalize" && mismatch) { mismatch = false; return Response.json({ error: "differs", code: "file_mismatch" }, { status: 409 }); }
  } });
  try {
    await assert.rejects(() => run({ storage }), (e) => e.code === "file_mismatch");
    assert.equal(storage.m.size, 0);
    assert.equal((await run({ storage })).success, true);
    assert.equal(sessions, 2);
  } finally { env.restore(); }
});

// ================================================================================================ C2
test("C2: auth headers are re-resolved for every request, so finalize after a long transfer uses the refreshed token", async () => {
  let n = 0; const env = setup();
  try {
    await run({ headers: async () => ({ Authorization: `Bearer token-${++n}` }) });
    const seen = env.headersSeen.map((h) => h.Authorization);
    assert.deepEqual(seen, ["Bearer token-1", "Bearer token-2", "Bearer token-3"]);
    assert.deepEqual(env.calls.map((c) => c.action), ["recover-upload", "init-upload", "finalize"]);
  } finally { env.restore(); }
});

test("C2: a signed-out session surfaces as auth_required instead of a vague network error", async () => {
  const env = setup();
  try { await assert.rejects(() => run({ headers: async () => { throw new Error("Please sign in again."); } }), (e) => e.code === "auth_required" && /sign in/.test(e.message)); } finally { env.restore(); }
  const api = await read("./cutWorkflowApi.js");
  assert.match(api, /headers: getHeaders/); assert.doesNotMatch(api, /headers: \{ Authorization: `Bearer \$\{session\.access_token\}` \}/);
});

// ================================================================================================ P7 / P8 / P9
test("P7: a second tab uploading the same file is refused while the first holds the lock", async () => {
  const held = new Set();
  const locks = { request: async (name, opts, cb) => { if (opts.ifAvailable && held.has(name)) return cb(null); held.add(name); try { return await cb({ name }); } finally { held.delete(name); } } };
  let release; const gate = new Promise((r) => { release = r; }); let gated = false;
  const env = setup({ server: (b) => (b.action === "recover-upload" && !gated ? (gated = true, gate.then(() => Response.json({ error: "nf", code: "upload_not_found" }, { status: 404 }))) : undefined) });
  try {
    const first = run({ locks, storage: memStorage() });
    await assert.rejects(() => run({ locks, storage: memStorage() }), (e) => e.code === "upload_in_progress");
    release();
    assert.equal((await first).success, true);
    assert.equal((await run({ locks, storage: memStorage() })).success, true, "lock released afterwards");
  } finally { env.restore(); }
});

test("P8: the UI is told what is happening during recovery waits, verification and finalization", async () => {
  // a reopened tab: saved state exists, Drive's listing lags twice before the file shows up
  let lag = 2; const phases = []; const sleep = noSleep();
  const env = setup({ server: (b) => {
    if (b.action === "recover-upload" && lag-- > 0) return Response.json({ error: "nf", code: "upload_not_found" }, { status: 404 });
    if (b.action === "recover-upload") return Response.json({ success: true, fileId: "drive-file-123456" });
  } });
  try {
    const storage = memStorage(); const fp = await fingerprintFile(mkFile());
    storage.setItem("kairflow.pendingUpload.k", JSON.stringify({ [fp]: { uploadId: "upload-0001", name: "render.mp4", size: SIZE, createdAt: Date.now(), sessionUri: null, fileId: null, md5: null } }));
    await run({ storage, storageKey: "kairflow.pendingUpload.k", sleep, onStatus: (p, d) => phases.push(p) });
    assert.ok(phases.includes("checking"), phases.join());
    assert.deepEqual(sleep.waits, [1000, 3000], "the waits that used to be silent");
  } finally { env.restore(); }
  // hashing normally finishes while the bytes upload, so "verifying" appears only when the hash is still running at finalize
  const slow = []; const env2 = setup();
  try {
    const slowHash = async (f, { onProgress }) => { await new Promise((r) => setTimeout(r, 15)); onProgress?.(60); return md5Blob(f); };
    await run({ hashFile: slowHash, onStatus: (p, d) => slow.push(d === undefined ? p : `${p}:${d}`) });
    assert.ok(slow.includes("verifying:0") || slow.includes("verifying:60"), slow.join());
    assert.deepEqual([...new Set(slow.map((s) => s.split(":")[0]))], ["preparing", "uploading", "verifying", "finalizing"]);
  } finally { env2.restore(); }
  const fast = []; const env3 = setup();
  try {
    await run({ onStatus: (p) => fast.push(p) });
    assert.deepEqual([...new Set(fast)], ["preparing", "uploading", "finalizing"], "no needless 'verifying' flicker when the hash is already done");
  } finally { env3.restore(); }
});

test("P9: without crypto.subtle the fingerprint is still computed (and equals the subtle result); upload ids fall back too", async () => {
  const file = mkFile();
  const viaSubtle = await fingerprintFile(file);
  const viaFallback = await fingerprintFile(file, null);
  assert.equal(viaFallback, viaSubtle);
  assert.match(viaFallback, /^[a-f0-9]{64}$/);
  const desc = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  try {
    Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
    assert.match(newUploadId(), /^[a-f0-9]{32}$/);
  } finally { Object.defineProperty(globalThis, "crypto", desc); }
  assert.match(newUploadId(), /^[a-f0-9-]{32,36}$/);
});

// ================================================================================================ UI wiring (P4/P8)
test("P4/P8: UIs surface status phases and an unshared-file warning", async () => {
  const sv = await read("./SharedViews.jsx"); const panel = await read("./CutWorkflowPanel.jsx");
  assert.match(sv, /onStatus:/); assert.match(sv, /result\.shared === false/); assert.match(panel, /onStatus:/);
});

// ================================================================================================ C3 / P2 / P6 sources
test("C3: every Drive call that can touch a Shared Drive carries supportsAllDrives (and listings include allDrives)", async () => {
  const src = await read("../supabase/functions/_shared/google.ts");
  const segments = src.split("https://www.googleapis.com/").slice(1).filter((seg) => /^(upload\/)?drive\/v3\/files/.test(seg));
  assert.ok(segments.length >= 10, `found ${segments.length}`);
  for (const seg of segments) assert.match(seg.slice(0, 600), /supportsAllDrives=true/, seg.slice(0, 80));
  assert.equal((src.match(/includeItemsFromAllDrives=true/g) || []).length, 2, "both file listings");
  assert.match(src, /md5Checksum/);
});

test("P2: non-JSON (old multipart) clients get a clear 'reload' answer, and the new client explains a mid-deploy mismatch", async () => {
  const edge = installEdgeEnvironment(); const g = installGoogle();
  try {
    const handler = await loadFunction(fnUrl("freelancer-drive-upload"));
    const res = await handler(new Request("https://fn.example/", { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=x" }, body: "--x--" }));
    assert.equal(res.status, 426); assert.equal((await res.json()).code, "client_outdated");
  } finally { g.restore(); }
  const client = await read("./resumableDriveUpload.js");
  assert.match(client, /mid-update/);
});

// ================================================================================================ Edge Functions, executed
function freelancerWorld({ meta, rpc } = {}) {
  const edge = installEdgeEnvironment({ FREELANCER_UPLOAD_INITS_PER_HOUR: "3" });
  const shot = { id: "shot-1", project_id: "proj-1", user_id: "user-1", title: "Cut A", stage: "x", assigned_to: "Sam", drive_deliverables_folder_id: "delfolder12" };
  edge.handler = (table, ops) => {
    if (table === "shots" && ops.filters.some((f) => f[1] === "share_token")) return { data: [shot] };
    if (table === "shots") return { data: [{ workflow_state: "in_progress" }] };
    if (table === "google_drive_connections") return { data: [{ refresh_token_encrypted: "enc" }] };
    return { data: [] };
  };
  edge.rpcHandler = (name, args) => (rpc?.(name, args)) ?? (name === "register_upload_session" ? { data: { allowed: true } } : name === "append_shot_deliverable_once" ? { data: true } : {});
  const driveMeta = { id: "drivefile12", name: "Cut A - a.mp4", mimeType: "video/mp4", size: "1000", trashed: false, parents: ["delfolder12"], appProperties: { freelancerUpload: "upload-0001", fp: FP }, md5Checksum: MD5, ...meta };
  const g = installGoogle({ meta: { drivefile12: driveMeta } });
  return { edge, g };
}
const fBody = (over = {}) => ({ token: "t".repeat(24), action: "finalize", uploadId: "upload-0001", fileId: "drivefile12", fingerprint: FP, size: 1000, name: "a.mp4", mimeType: "video/mp4", md5: MD5, ...over });

test("freelancer finalize: md5 required / pending / mismatch / ok, with submission registered BEFORE the deliverable is appended (P3) and share status reported (P4)", async () => {
  const { edge, g } = freelancerWorld();
  try {
    const handler = await loadFunction(fnUrl("freelancer-drive-upload"));
    let res = await handler(post(fBody({ md5: undefined })));
    assert.equal(res.status, 428); assert.equal((await res.json()).code, "md5_required");

    g.meta.drivefile12.md5Checksum = undefined;
    res = await handler(post(fBody()));
    assert.equal(res.status, 503); assert.equal((await res.json()).code, "checksum_pending"); assert.equal(res.headers.get("Retry-After"), "3");

    g.meta.drivefile12.md5Checksum = "c".repeat(32);
    res = await handler(post(fBody()));
    assert.equal(res.status, 409); assert.equal((await res.json()).code, "file_mismatch");
    assert.ok(!edge.rpcs.some((r) => r.name === "append_shot_deliverable_once" || r.name === "register_freelancer_submission"), "nothing registered for a mismatching file");

    g.meta.drivefile12.md5Checksum = MD5;
    edge.rpcs.length = 0;
    res = await handler(post(fBody()));
    const ok = await res.json();
    assert.equal(res.status, 200); assert.equal(ok.success, true); assert.equal(ok.shared, true);
    const order = edge.rpcs.map((r) => r.name);
    assert.ok(order.indexOf("register_freelancer_submission") < order.indexOf("append_shot_deliverable_once"), order.join());
    assert.ok(order.includes("mark_upload_session_finalized"));

    g.permissionStatus = 403; edge.rpcs.length = 0;
    res = await handler(post(fBody()));
    assert.equal((await res.json()).shared, false, "unshared file is reported, not hidden");
  } finally { g.restore(); }
});

test("P3: when the review gate refuses the submission, no deliverable is appended to the shot", async () => {
  const { edge, g } = freelancerWorld({ rpc: (name) => (name === "register_freelancer_submission" ? { error: { message: "cut_not_accepting_submissions" } } : undefined) });
  try {
    const handler = await loadFunction(fnUrl("freelancer-drive-upload"));
    const res = await handler(post(fBody()));
    assert.equal(res.status, 409); assert.equal((await res.json()).code, "not_accepting");
    assert.ok(!edge.rpcs.some((r) => r.name === "append_shot_deliverable_once"));
  } finally { g.restore(); }
});

test("freelancer recover-upload: a found file without md5 is answered md5_required (client then hashes once)", async () => {
  const { edge, g } = freelancerWorld();
  g.list.push({ id: "drivefile12", size: "1000", trashed: false, createdTime: "2026-01-01", appProperties: { freelancerUpload: "upload-0001", fp: FP }, md5Checksum: MD5 });
  try {
    const handler = await loadFunction(fnUrl("freelancer-drive-upload"));
    const res = await handler(post(fBody({ action: "recover-upload", fileId: undefined, md5: undefined })));
    assert.equal(res.status, 428); const body = await res.json(); assert.equal(body.code, "md5_required"); assert.equal(body.fileId, "drivefile12");
  } finally { g.restore(); }
});

test("P5: init-upload is rate limited per shot before any Drive session is created; allowed inits create a shared-drive-aware session", async () => {
  let allowed = true;
  const { edge, g } = freelancerWorld({ rpc: (name) => (name === "register_upload_session" ? { data: allowed ? { allowed: true } : { allowed: false, retry_after_seconds: 3600 } } : undefined) });
  const init = { token: "t".repeat(24), action: "init-upload", uploadId: "upload-0002", name: "a.mp4", size: 1000, mimeType: "video/mp4", fingerprint: FP };
  try {
    const handler = await loadFunction(fnUrl("freelancer-drive-upload"));
    let res = await handler(post(init));
    assert.equal(res.status, 200); assert.equal((await res.json()).uploadUrl, "https://upload.example/session-1");
    const reg = edge.rpcs.find((r) => r.name === "register_upload_session").args;
    assert.equal(reg.p_scope, "shot:shot-1"); assert.equal(reg.p_limit, 3); assert.equal(reg.p_kind, "freelancer");
    const session = g.calls.find((c) => c.url.includes("uploadType=resumable"));
    assert.match(session.url, /supportsAllDrives=true/);
    assert.deepEqual(JSON.parse(session.body).appProperties, { freelancerUpload: "upload-0002", fp: FP });

    allowed = false; const before = g.calls.length;
    res = await handler(post({ ...init, uploadId: "upload-0003" }));
    assert.equal(res.status, 429); assert.equal((await res.json()).code, "rate_limited"); assert.equal(res.headers.get("Retry-After"), "3600");
    assert.equal(g.calls.slice(before).filter((c) => c.url.includes("uploadType=resumable")).length, 0, "no Drive session when rate limited");
  } finally { g.restore(); }
});

test("P10: several actions of one upload share one Google OAuth refresh", async () => {
  const { edge, g } = freelancerWorld();
  try {
    const handler = await loadFunction(fnUrl("freelancer-drive-upload"));
    for (let i = 0; i < 4; i++) await handler(post(fBody({ md5: undefined })));
    assert.ok(g.tokenCalls <= 1, `token endpoint hit ${g.tokenCalls}x`);
  } finally { g.restore(); }
});

function finalQcWorld({ rpc } = {}) {
  const edge = installEdgeEnvironment();
  edge.handler = (table) => {
    if (table === "shots") return { data: [{ id: "shot-1", project_id: "proj-1", user_id: "user-1", title: "Cut A", workflow_state: "qc_adjustments", drive_final_qc_folder_id: null }] };
    if (table === "cut_final_versions") return { data: [] };
    if (table === "cut_submissions") return { data: [{ id: "s1" }] };
    if (table === "projects") return { data: [{ id: "proj-1", drive_folder_id: "projdrive12", drive_final_qc_folder_id: null }] };
    if (table === "google_drive_connections") return { data: [{ refresh_token_encrypted: "enc" }] };
    return { data: [] };
  };
  edge.rpcHandler = (name, args) => (rpc?.(name, args)) ?? (name === "register_upload_session" ? { data: { allowed: true } } : name === "register_final_version" ? { data: { versionId: "v1", version: 1, duplicate: false } } : {});
  const g = installGoogle({ meta: { drivefile12: { id: "drivefile12", name: "x", mimeType: "video/mp4", size: "1000", trashed: false, parents: ["cutfolder12"], appProperties: { finalQcUpload: "final-key-0001", fp: FP }, md5Checksum: MD5 } } });
  return { edge, g };
}
const qBody = (over = {}) => ({ action: "finalize", shotId: "shot-1", uploadKey: "final-key-0001", fileId: "drivefile12", fingerprint: FP, size: 1000, name: "final.mp4", mimeType: "video/mp4", md5: MD5, ...over });
const auth = { Authorization: "Bearer jwt" };

test("Final QC finalize: md5 required / mismatch rejected before registration; valid file registers and marks the session finalized; folders are cached (P10)", async () => {
  const { edge, g } = finalQcWorld();
  try {
    const handler = await loadFunction(fnUrl("final-qc-upload"));
    let res = await handler(post(qBody({ md5: undefined }), auth));
    assert.equal(res.status, 428);
    res = await handler(post(qBody({ md5: "d".repeat(32) }), auth));
    assert.equal(res.status, 409); assert.equal((await res.json()).code, "file_mismatch");
    assert.ok(!edge.rpcs.some((r) => r.name === "register_final_version"));
    res = await handler(post(qBody(), auth));
    assert.equal(res.status, 200); assert.equal((await res.json()).validationStatus, "valid");
    const names = edge.rpcs.map((r) => r.name);
    assert.ok(names.includes("register_final_version") && names.includes("mark_upload_session_finalized"));
    assert.equal(edge.foldersCalls, 1, "folder resolution cached across the three requests");
  } finally { g.restore(); }
});

test("Final QC init-upload: rate limited per studio user (429) before any Drive session; pre-Drive validation errors need no Google call", async () => {
  let allowed = false;
  const { edge, g } = finalQcWorld({ rpc: (name) => (name === "register_upload_session" ? { data: allowed ? { allowed: true } : { allowed: false, retry_after_seconds: 1800 } } : undefined) });
  const init = { action: "init-upload", shotId: "shot-1", uploadKey: "final-key-0002", name: "final.mp4", size: 1000, mimeType: "video/mp4", fingerprint: FP };
  try {
    const handler = await loadFunction(fnUrl("final-qc-upload")); const before = g.calls.length;
    let res = await handler(post({ ...init, fingerprint: "bad" }, auth));
    assert.equal(res.status, 400);
    res = await handler(post(init, auth));
    assert.equal(res.status, 429); assert.equal(res.headers.get("Retry-After"), "1800");
    assert.equal(g.calls.slice(before).filter((c) => c.url.includes("uploadType=resumable")).length, 0);
    assert.equal(edge.rpcs.find((r) => r.name === "register_upload_session").args.p_scope, "user:user-1");
    allowed = true;
    res = await handler(post({ ...init, uploadKey: "final-key-0003" }, auth));
    assert.equal(res.status, 200);
  } finally { g.restore(); }
});

// ================================================================================================ P5/P6 SQL + cleanup job
test("P5/P6: migration defines the guarded session table + RPCs; service role only", async () => {
  const sql = await read("../supabase/migrations/20270107100000_upload_sessions.sql");
  assert.match(sql, /create table if not exists public\.upload_sessions/i);
  assert.match(sql, /unique \(kind, upload_id\)/i);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /revoke all on function public\.register_upload_session[^;]+anon/i);
  assert.match(sql, /grant execute on function public\.register_upload_session[^;]+service_role/i);
  assert.match(sql, /grant execute on function public\.mark_upload_session_finalized[^;]+service_role/i);
  const timestamps = (await import("node:fs")).readdirSync(new URL("../supabase/migrations/", import.meta.url)).map((n) => n.slice(0, 14)).sort();
  // The upload migration must sort after every migration that existed when it was written. Later migrations (for example the Inbox ones, 20270108*) may follow it.
  assert.equal(timestamps.filter((t) => t <= "20270107100000").at(-1), "20270107100000", "upload migration sorts after every earlier migration");
  assert.ok(timestamps.every((t, i) => i === 0 || t > timestamps[i - 1]), "migration timestamps are unique and strictly increasing");
});

test("P6: cleanup job requires its secret, trashes only unreferenced files (duplicates + abandoned), never the registered one", async () => {
  const edge = installEdgeEnvironment({ UPLOAD_CLEANUP_SECRET: "s3cret" });
  const updated = [];
  edge.handler = (table, ops) => {
    if (table === "upload_sessions" && ops.method === "select") return { data: [
      { id: "r1", kind: "freelancer", upload_id: "upload-0001", user_id: "user-1", shot_id: "shot-1", folder_id: "delfolder12", drive_file_id: "keepfile01", finalized_at: "2026-01-01" },
      { id: "r2", kind: "final_qc", upload_id: "final-key-0001", user_id: "user-1", shot_id: "shot-2", folder_id: "cutfolder12", drive_file_id: null, finalized_at: null },
    ] };
    if (table === "upload_sessions" && ops.method === "update") { updated.push(ops.filters); return { data: null }; }
    if (table === "google_drive_connections") return { data: [{ refresh_token_encrypted: "enc" }] };
    if (table === "cut_final_versions") return { data: [{ drive_file_id: "validfile1", validation_status: "valid" }, { drive_file_id: "rejected01", validation_status: "invalid" }] };
    return { data: [] };
  };
  const g = installGoogle({ list: (url) => (url.includes("freelancerUpload")
    ? [{ id: "keepfile01" }, { id: "dupfile001" }]
    : [{ id: "validfile1" }, { id: "rejected01" }, { id: "orphan0001" }]) });
  const handler = await loadFunction(fnUrl("drive-upload-cleanup"));
  try {
    assert.equal((await handler(post({}))).status, 403, "missing secret header");
    assert.equal((await handler(post({}, { "x-cron-secret": "wrong" }))).status, 403);
    const res = await handler(post({}, { "x-cron-secret": "s3cret" }));
    const out = await res.json();
    assert.equal(res.status, 200); assert.equal(out.examined, 2);
    const trashed = g.calls.filter((c) => c.method === "PATCH").map((c) => /files\/([^/?]+)/.exec(c.url)[1]).sort();
    assert.deepEqual(trashed, ["dupfile001", "orphan0001", "rejected01"], "registered file, valid Final QC version are kept");
    for (const c of g.calls.filter((x) => x.method === "PATCH")) { assert.deepEqual(JSON.parse(c.body), { trashed: true }, "trash, never permanent delete"); assert.match(c.url, /supportsAllDrives=true/); }
    assert.equal(updated.length, 2, "both rows closed");
  } finally { g.restore(); }
  installEdgeEnvironment({ UPLOAD_CLEANUP_SECRET: "" });
  const g2 = installGoogle();
  try { assert.equal((await handler(post({}, { "x-cron-secret": "" }))).status, 503); } finally { g2.restore(); }
});

test("Final QC: a content mismatch rotates the upload key (otherwise the stable key would re-find the same bad Drive file forever)", async () => {
  const api = await read("./cutWorkflowApi.js"); const panel = await read("./CutWorkflowPanel.jsx");
  assert.match(api, /error\?\.code === "file_mismatch"[\s\S]{0,200}rejected\.code = "final_invalid"/);
  assert.match(panel, /e\.code === "final_invalid" \? newUploadKey\(\)/);
});
