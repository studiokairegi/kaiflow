import test from "node:test";
import assert from "node:assert/strict";
import { effectiveRange, parseRange } from "../../supabase/functions/_shared/portfolio/range.ts";
import { guardLength, legacyStorageUrl, parseContentRange, probeRangeSupport, serveMedia, withTimeouts } from "../../supabase/functions/_shared/portfolio/stream.ts";

// serveMedia turns an upstream (Drive / Storage) response into the browser response. A 206 may only be sent when
// upstream genuinely returned the requested range; anything inconsistent must fail, not send misleading headers.

const SIZE = 1000;
const FILE = Uint8Array.from({ length: SIZE }, (_, i) => i % 251);
const CORS = { "Access-Control-Allow-Origin": "*" };
const CAP = 16 * 1024 * 1024;

const streamOf = (bytes, chunk = 64) => new ReadableStream({
  start(c) { for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.slice(i, i + chunk)); c.close(); },
});
const up = (status, bytes, headers = {}) => new Response(streamOf(bytes), { status, headers });
const bytesOf = async (res) => new Uint8Array(await res.arrayBuffer());

// Runs serveMedia against a scripted upstream and records the Range value it asked for.
async function serve({ range, upstream, size = SIZE, cap = CAP, mimeType = "video/mp4", limits }) {
  const calls = [];
  const res = await serveMedia({
    size, mimeType, baseHeaders: CORS, limits,
    range: parseRange(range, size, cap),
    fetchUpstream: async (r, signal) => { calls.push(r); return typeof upstream === "function" ? upstream(r, signal) : upstream; },
  });
  return { res, calls };
}
const partialUpstream = (a, b, extra = {}) => up(206, FILE.slice(a, b + 1), { "Content-Range": `bytes ${a}-${b}/${SIZE}`, "Content-Length": String(b - a + 1), ...extra });

// ---------------------------------------------------------------- valid ranges
test("valid range: genuine upstream 206 -> 206 with matching Content-Range/Length and the exact bytes", async () => {
  const { res, calls } = await serve({ range: "bytes=100-199", upstream: partialUpstream(100, 199) });
  assert.deepEqual(calls, ["bytes=100-199"]);
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("Content-Range"), "bytes 100-199/1000");
  assert.equal(res.headers.get("Content-Length"), "100");
  assert.equal(res.headers.get("Accept-Ranges"), "bytes");
  assert.equal(res.headers.get("Content-Type"), "video/mp4");
  assert.deepEqual(await bytesOf(res), FILE.slice(100, 200));
});
test("valid range: open-ended and suffix ranges are clamped to the file and still validated", async () => {
  let r = await serve({ range: "bytes=900-", upstream: partialUpstream(900, 999) });
  assert.equal(r.res.status, 206); assert.equal(r.res.headers.get("Content-Range"), "bytes 900-999/1000");
  r = await serve({ range: "bytes=-50", upstream: partialUpstream(950, 999) });
  assert.equal(r.res.status, 206); assert.equal(r.res.headers.get("Content-Range"), "bytes 950-999/1000");
});
test("valid range: the per-response cap still applies and is what is requested upstream", async () => {
  const { res, calls } = await serve({ range: "bytes=0-", cap: 100, upstream: partialUpstream(0, 99) });
  assert.deepEqual(calls, ["bytes=0-99"]);
  assert.equal(res.status, 206); assert.equal(res.headers.get("Content-Range"), "bytes 0-99/1000");
  assert.equal((await bytesOf(res)).length, 100);
});

// ---------------------------------------------------------------- upstream ignored / mangled the range
test("upstream returns 200 (ignored Range): NO 206 and no Content-Range is emitted", async () => {
  const { res } = await serve({ range: "bytes=100-199", upstream: up(200, FILE, { "Content-Length": String(SIZE) }) });
  assert.equal(res.status, 502);
  assert.equal(res.headers.get("Content-Range"), null);
  assert.equal((await res.json()).error, "media_unavailable");
});
test("upstream 206 with a Content-Range for a different range / total / format is rejected", async () => {
  const bad = ["bytes 0-99/1000", "bytes 100-198/1000", "bytes 101-199/1000", "bytes 100-199/999", "bytes 100-199/*", "bytes 100-199", "items 100-199/1000", "bytes 199-100/1000", ""];
  for (const cr of bad) {
    const { res } = await serve({ range: "bytes=100-199", upstream: up(206, FILE.slice(100, 200), { "Content-Range": cr, "Content-Length": "100" }) });
    assert.equal(res.status, 502, `Content-Range "${cr}" must be rejected`);
    assert.equal(res.headers.get("Content-Range"), null);
  }
  const { res } = await serve({ range: "bytes=100-199", upstream: up(206, FILE.slice(100, 200), { "Content-Length": "100" }) });   // header missing
  assert.equal(res.status, 502);
});
test("upstream 206 with a mismatched or invalid Content-Length is rejected", async () => {
  for (const len of ["99", "101", "0", "abc", "-100", "1e2", "100.0", ""]) {
    const { res } = await serve({ range: "bytes=100-199", upstream: up(206, FILE.slice(100, 200), { "Content-Range": "bytes 100-199/1000", "Content-Length": len }) });
    assert.equal(res.status, 502, `Content-Length "${len}" must be rejected`);
  }
});
test("upstream 206 without a Content-Length is accepted (chunked), but its byte count is still enforced", async () => {
  const ok = await serve({ range: "bytes=100-199", upstream: up(206, FILE.slice(100, 200), { "Content-Range": "bytes 100-199/1000" }) });
  assert.equal(ok.res.status, 206); assert.equal(ok.res.headers.get("Content-Length"), "100");
  assert.equal((await bytesOf(ok.res)).length, 100);
  const short = await serve({ range: "bytes=100-199", upstream: up(206, FILE.slice(100, 150), { "Content-Range": "bytes 100-199/1000" }) });
  await assert.rejects(() => short.res.arrayBuffer());            // truncated upstream must error, not deliver a short "complete" body
});

// ---------------------------------------------------------------- upstream errors
test("upstream errors never become successful media responses", async () => {
  for (const status of [400, 401, 403, 429, 500, 502, 503]) {
    for (const range of [undefined, "bytes=0-99"]) {
      const { res } = await serve({ range, upstream: new Response("nope", { status }) });
      assert.equal(res.status, 502, `upstream ${status} (${range ?? "full"})`);
      assert.equal(res.headers.get("Content-Range"), null);
      assert.deepEqual(await res.json(), { error: "media_unavailable" });
    }
  }
});
test("upstream 404 -> 404 file_missing; upstream 416 for an in-range request -> 502 (our stored size is wrong)", async () => {
  let r = await serve({ range: "bytes=0-99", upstream: new Response("", { status: 404 }) });
  assert.equal(r.res.status, 404); assert.equal((await r.res.json()).error, "file_missing");
  r = await serve({ range: "bytes=0-99", upstream: new Response("", { status: 416, headers: { "Content-Range": "bytes */500" } }) });
  assert.equal(r.res.status, 502); assert.equal(r.res.headers.get("Content-Range"), null);
});
test("network failure while fetching upstream -> 502, a body-less 2xx is rejected", async () => {
  let r = await serve({ range: "bytes=0-99", upstream: () => { throw new Error("boom"); } });
  assert.equal(r.res.status, 502);
  r = await serve({ range: "bytes=0-99", upstream: new Response(null, { status: 206, headers: { "Content-Range": "bytes 0-99/1000" } }) });
  assert.equal(r.res.status, 502);
});

// ---------------------------------------------------------------- full-file requests
test("ordinary full-file request: 200, correct length/type/security headers, no Content-Range, exact bytes", async () => {
  const { res, calls } = await serve({ upstream: up(200, FILE, { "Content-Length": String(SIZE) }) });
  assert.deepEqual(calls, [undefined]);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Length"), "1000");
  assert.equal(res.headers.get("Content-Range"), null);
  assert.equal(res.headers.get("Accept-Ranges"), "bytes");
  assert.equal(res.headers.get("Content-Type"), "video/mp4");
  assert.equal(res.headers.get("Content-Disposition"), "inline");
  assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  assert.match(res.headers.get("Content-Security-Policy"), /sandbox/);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  assert.deepEqual(await bytesOf(res), FILE);
});
test("full-file: upstream 206, wrong Content-Length, or a body that disagrees with the stored size is not passed off as complete", async () => {
  let r = await serve({ upstream: up(206, FILE, { "Content-Range": "bytes 0-999/1000" }) });
  assert.equal(r.res.status, 502);
  r = await serve({ upstream: up(200, FILE, { "Content-Length": "999" }) });
  assert.equal(r.res.status, 502);
  r = await serve({ upstream: up(200, FILE.slice(0, 400)) });                      // no length header, but short body
  assert.equal(r.res.status, 200); await assert.rejects(() => r.res.arrayBuffer());
  r = await serve({ upstream: up(200, new Uint8Array(SIZE + 50)) });               // longer than the stored size
  await assert.rejects(() => r.res.arrayBuffer());
});

// ---------------------------------------------------------------- 416
test("unsatisfiable ranges -> 416 with Content-Range bytes */size and upstream is never contacted", async () => {
  for (const range of ["bytes=1000-", "bytes=5000-6000", "bytes=-0", "bytes=500-100"]) {
    const { res, calls } = await serve({ range, upstream: () => { throw new Error("must not be called"); } });
    assert.equal(res.status, 416, range);
    assert.equal(res.headers.get("Content-Range"), "bytes */1000");
    assert.deepEqual(calls, []);
  }
});
test("no usable stored size -> refused rather than describing a file we cannot validate", async () => {
  for (const size of [0, NaN, -5]) {
    const { res } = await serve({ size, upstream: up(200, FILE) });
    assert.equal(res.status, 404);
  }
});

// ---------------------------------------------------------------- streaming + headers
test("streaming: the first bytes reach the client before upstream has finished (no buffering)", async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const body = new ReadableStream({
    async start(c) { c.enqueue(FILE.slice(0, 100)); await gate; c.enqueue(FILE.slice(100, 200)); c.close(); },
  });
  const { res } = await serve({ range: "bytes=0-199", upstream: new Response(body, { status: 206, headers: { "Content-Range": "bytes 0-199/1000", "Content-Length": "200" } }) });
  const reader = res.body.getReader();
  const first = await reader.read();                      // resolves although upstream is still blocked on `gate`
  assert.equal(first.value.length, 100);
  release();
  const second = await reader.read();
  assert.equal(second.value.length, 100);
  assert.equal((await reader.read()).done, true);
});
test("only allowed media types are echoed as Content-Type; anything else is served as opaque bytes", async () => {
  for (const [stored, sent] of [["video/mp4", "video/mp4"], ["image/png", "image/png"], ["text/html", "application/octet-stream"], ["image/svg+xml", "application/octet-stream"], [null, "application/octet-stream"], ["", "application/octet-stream"]]) {
    const { res } = await serve({ mimeType: stored, upstream: up(200, FILE, { "Content-Length": "1000", "Content-Type": "text/html" }) });
    assert.equal(res.headers.get("Content-Type"), sent, String(stored));
  }
});

// ---------------------------------------------------------------- helpers
test("parseContentRange", () => {
  assert.deepEqual(parseContentRange("bytes 0-99/1000"), { start: 0, end: 99, total: 1000 });
  assert.deepEqual(parseContentRange("bytes 5-9/*"), { start: 5, end: 9, total: null });
  for (const bad of ["", null, undefined, "bytes */1000", "bytes 9-5/10", "bytes 1-2", "bytes -1-2/3", "BYTES 1-2/3"]) assert.equal(parseContentRange(bad), null, String(bad));
});
test("guardLength passes exact streams and errors on short or long ones", async () => {
  assert.deepEqual(new Uint8Array(await new Response(guardLength(streamOf(FILE.slice(0, 10)), 10)).arrayBuffer()), FILE.slice(0, 10));
  await assert.rejects(() => new Response(guardLength(streamOf(FILE.slice(0, 9)), 10)).arrayBuffer());
  await assert.rejects(() => new Response(guardLength(streamOf(FILE.slice(0, 11)), 10)).arrayBuffer());
});

// ---------------------------------------------------------------- legacy Storage URL
test("legacyStorageUrl: only a safe path inside the owner's own folder maps to a service-role URL", () => {
  const U = "00000000-0000-0000-0000-0000000000a1"; const base = "https://x.supabase.co";
  assert.equal(legacyStorageUrl(base, U, `${U}/reel 1.mp4`), `${base}/storage/v1/object/authenticated/portfolio/${U}/reel%201.mp4`);
  assert.equal(legacyStorageUrl(`${base}/`, U, `${U}/a/b.png`), `${base}/storage/v1/object/authenticated/portfolio/${U}/a/b.png`);
  const other = "00000000-0000-0000-0000-0000000000b2";
  for (const p of [`${other}/x.mp4`, `${U}/../${other}/x.mp4`, `${U}/./x`, `${U}//x`, `${U}/`, U, "", null, undefined, 5, `${U}\\x`, `${U}/x\u0000`, `/${U}/x`])
    assert.equal(legacyStorageUrl(base, U, p), null, String(p));
  assert.equal(legacyStorageUrl("", U, `${U}/x`), null);
});

// ---------------------------------------------------------------- resource limits
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
// An upstream body that sends `first`, then stalls forever (until aborted), recording cancel/abort.
function stallingUpstream(first, state) {
  const body = new ReadableStream({
    start(c) { c.enqueue(first); },
    pull() { return new Promise(() => {}); },                      // never resolves: stalled
    cancel() { state.cancelled = true; },
  });
  return new Response(body, { status: 200, headers: { "Content-Length": String(SIZE) } });
}
test("limits: an upstream that stalls mid-stream errors the response after idleMs and cancels upstream", async () => {
  const state = {};
  const { res } = await serve({ limits: { idleMs: 40, totalMs: 5000 }, upstream: (r, signal) => { signal.addEventListener("abort", () => { state.aborted = true; }); return stallingUpstream(FILE.slice(0, 100), state); } });
  const reader = res.body.getReader();
  assert.equal((await reader.read()).value.length, 100);
  await assert.rejects(() => reader.read(), /stalled/);
  assert.equal(state.cancelled, true); assert.equal(state.aborted, true);
});
test("limits: a response that exceeds totalMs is cut off even if the client is not reading (no pull), freeing upstream", async () => {
  const state = {};
  const { res } = await serve({ limits: { idleMs: 5000, totalMs: 60 }, upstream: () => stallingUpstream(FILE.slice(0, 100), state) });
  await tick(150);                                                    // client never read anything
  await assert.rejects(() => res.arrayBuffer());
  assert.equal(state.cancelled, true);
});
test("limits: upstream that never sends headers is aborted after headerMs -> 502, and the abort signal fires", async () => {
  let aborted = false;
  const { res } = await serve({ limits: { headerMs: 40 }, upstream: (r, signal) => new Promise((_, rej) => signal.addEventListener("abort", () => { aborted = true; rej(new Error("aborted")); })) });
  assert.equal(res.status, 502); assert.equal(aborted, true);
});
test("limits: a client that goes away (cancels the response) cancels upstream and clears its timers", async () => {
  const state = {};
  const { res } = await serve({ limits: { idleMs: 60_000, totalMs: 60_000 }, upstream: () => stallingUpstream(FILE.slice(0, 100), state) });
  const reader = res.body.getReader(); await reader.read(); await reader.cancel("client gone");
  await tick(20);                                                     // cancellation propagates asynchronously through the piped streams
  assert.equal(state.cancelled, true);                                // (a leaked 60 s timer would also keep this test process alive)
});
test("limits: legitimate slow-but-steady playback is not cut off, and a normal response is unaffected", async () => {
  const slow = new ReadableStream({ async start(c) { for (let i = 0; i < 5; i++) { c.enqueue(FILE.slice(i * 200, i * 200 + 200)); await tick(30); } c.close(); } });
  const { res } = await serve({ limits: { idleMs: 200, totalMs: 5000 }, upstream: new Response(slow, { status: 200, headers: { "Content-Length": "1000" } }) });
  assert.deepEqual(await bytesOf(res), FILE);
});
test("limits: a compressed (Content-Encoding) upstream body is refused because its length cannot be verified", async () => {
  for (const enc of ["gzip", "br", "deflate"]) {
    const { res } = await serve({ upstream: up(200, FILE, { "Content-Encoding": enc }) });
    assert.equal(res.status, 502, enc);
  }
  assert.equal((await serve({ upstream: up(200, FILE, { "Content-Encoding": "identity" }) })).res.status, 200);
});
test("withTimeouts passes data through unchanged and propagates upstream errors", async () => {
  assert.deepEqual(new Uint8Array(await new Response(withTimeouts(streamOf(FILE), { idleMs: 1000, totalMs: 5000 }, () => {})).arrayBuffer()), FILE);
  const boom = new ReadableStream({ start(c) { c.enqueue(FILE.slice(0, 10)); c.error(new Error("socket reset")); } });
  await assert.rejects(() => new Response(withTimeouts(boom, { idleMs: 1000, totalMs: 5000 }, () => {})).arrayBuffer(), /socket reset/);
});
test("effectiveRange: an un-ranged request for a huge VIDEO is answered as the first chunk (206); seeking, small videos and images are unchanged", () => {
  const MB = 1024 * 1024; const cap = 16 * MB; const fullMax = 64 * MB;
  assert.deepEqual(effectiveRange(null, 400 * MB, cap, fullMax, true), { status: 206, start: 0, end: 16 * MB - 1 });
  assert.deepEqual(effectiveRange(undefined, 65 * MB, cap, fullMax, true), { status: 206, start: 0, end: 16 * MB - 1 });
  assert.deepEqual(effectiveRange(null, 10 * MB, cap, fullMax, true), { status: 200 });          // small video: whole file
  assert.deepEqual(effectiveRange(null, 64 * MB, cap, fullMax, true), { status: 200 });          // exactly the limit
  assert.deepEqual(effectiveRange(null, 400 * MB, cap, fullMax, false), { status: 200 });        // images are never truncated
  assert.deepEqual(effectiveRange("bytes=200000000-", 400 * MB, cap, fullMax, true), { status: 206, start: 200000000, end: 200000000 + cap - 1 });   // seeking
  assert.deepEqual(effectiveRange("bytes=0-", 400 * MB, cap, fullMax, true), { status: 206, start: 0, end: cap - 1 });
  assert.deepEqual(effectiveRange("bytes=999999999999-", 400 * MB, cap, fullMax, true), { status: 416 });
  assert.deepEqual(effectiveRange(null, 5, 3, 4, true), { status: 206, start: 0, end: 2 });      // cap smaller than file
  assert.deepEqual(effectiveRange(null, 2, 16, 1, true), { status: 206, start: 0, end: 1 });     // file smaller than cap -> whole file as 206 0-1/2
});
test("the capped first chunk is served with a self-consistent 206 (Content-Range and Content-Length agree with the body)", async () => {
  const size = 1000; const r = effectiveRange(null, size, 100, 500, true);
  const { res, calls } = await serve({ size, range: undefined, upstream: partialUpstream(0, 99) });     // (parseRange inside serve() is bypassed below)
  void res; void calls;
  const out = await serveMedia({ size, mimeType: "video/mp4", baseHeaders: CORS, range: r, fetchUpstream: async (rr) => { assert.equal(rr, "bytes=0-99"); return partialUpstream(0, 99); } });
  assert.equal(out.status, 206); assert.equal(out.headers.get("Content-Range"), "bytes 0-99/1000"); assert.equal(out.headers.get("Content-Length"), "100");
  assert.deepEqual(await bytesOf(out), FILE.slice(0, 100));
});

test("probeRangeSupport: 206 with a matching Content-Range = supported; a 200 = unsupported; errors/odd statuses = unknown (never a verdict)", async () => {
  const mk = (res) => async (url, init) => { assert.equal(init.headers.Range, "bytes=0-0"); assert.equal(init.headers.Authorization, "Bearer k"); return res instanceof Error ? Promise.reject(res) : res; };
  const H = { Authorization: "Bearer k" };
  assert.equal(await probeRangeSupport("https://x", H, mk(new Response("a", { status: 206, headers: { "Content-Range": "bytes 0-0/1000" } }))), "supported");
  assert.equal(await probeRangeSupport("https://x", H, mk(new Response("a", { status: 206, headers: { "Content-Range": "bytes 0-5/1000" } }))), "unknown");
  assert.equal(await probeRangeSupport("https://x", H, mk(new Response(FILE, { status: 200 }))), "unsupported");
  assert.equal(await probeRangeSupport("https://x", H, mk(new Response("", { status: 404 }))), "unknown");
  assert.equal(await probeRangeSupport("https://x", H, mk(new Error("down"))), "unknown");
});
