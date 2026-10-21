import test from "node:test";
import assert from "node:assert/strict";
import * as L from "./logic.js";
import * as V from "../../supabase/functions/_shared/portfolio/validate.ts";
import { parseRange } from "../../supabase/functions/_shared/portfolio/range.ts";
import { signMediaTicket, verifyMediaTicket } from "../../supabase/functions/_shared/portfolio/ticket.ts";

const HEX64 = "c".repeat(64);
const file = (name, type, size) => ({ name, type, size });
const U = "00000000-0000-0000-0000-0000000000a1";

test("validateFile: accepts video and image types, rejects everything else", () => {
  assert.deepEqual(L.validateFile(file("reel.mp4", "video/mp4", 5e6)), { ok: true, kind: "video" });
  assert.deepEqual(L.validateFile(file("a.mov", "video/quicktime", 5e6)), { ok: true, kind: "video" });
  assert.deepEqual(L.validateFile(file("p.webp", "image/webp", 1e5)), { ok: true, kind: "image" });
  for (const t of ["application/pdf", "image/svg+xml", "text/html", "", undefined]) assert.equal(L.validateFile(file("x", t, 10)).ok, false);
});
test("validateFile: size and count limits", () => {
  assert.equal(L.validateFile(file("e.mp4", "video/mp4", 0)).ok, false);
  assert.equal(L.validateFile(file("big.mp4", "video/mp4", L.MAX_BYTES + 1)).ok, false);
  assert.equal(L.validateFile(file("max.mp4", "video/mp4", L.MAX_BYTES)).ok, true);
  assert.equal(L.validateFile(file("a.mp4", "video/mp4", 10), L.MAX_ITEMS).ok, false);
});
test("moveItem: swaps neighbours, renumbers densely, no-ops at the ends", () => {
  const items = [{ id: "a", sort_order: 0, created_at: "1" }, { id: "b", sort_order: 5, created_at: "2" }, { id: "c", sort_order: 9, created_at: "3" }];
  assert.deepEqual(L.moveItem(items, "c", "up").map((x) => [x.id, x.sort_order]), [["a", 0], ["c", 1], ["b", 2]]);
  assert.deepEqual(L.moveItem(items, "a", "up").map((x) => x.id), ["a", "b", "c"]);
  assert.deepEqual(L.moveItem(items, "c", "down").map((x) => x.id), ["a", "b", "c"]);
  assert.equal(L.nextSortOrder(items), 10); assert.equal(L.nextSortOrder([]), 0);
});
test("token and path helpers", () => {
  assert.ok(L.isPortfolioToken(HEX64));
  for (const t of ["", "abc", "C".repeat(64), HEX64 + "0", null, U]) assert.equal(L.isPortfolioToken(t), false);
  assert.equal(L.tokenFromPortfolioPath(`/portfolio/${HEX64}`), HEX64);
  assert.equal(L.tokenFromPortfolioPath(`/portfolio/${HEX64}/`), HEX64);
  for (const p of ["/", "/portfolio", `/pay/${HEX64}`, `/portfolio/${HEX64}/x`]) assert.equal(L.tokenFromPortfolioPath(p), null);
  assert.equal(L.portfolioUrl(HEX64, "https://studiokairegi.com/"), `https://studiokairegi.com/portfolio/${HEX64}`);
});
test("linkStatus: revoked beats expired beats active", () => {
  const now = Date.parse("2026-10-22T00:00:00Z");
  assert.equal(L.linkStatus({ revoked_at: "x", expires_at: null }, now), "revoked");
  assert.equal(L.linkStatus({ revoked_at: null, expires_at: "2026-10-21T00:00:00Z" }, now), "expired");
  assert.equal(L.linkStatus({ revoked_at: null, expires_at: "2026-11-01T00:00:00Z" }, now), "active");
  assert.equal(L.linkStatus({ revoked_at: null, expires_at: null }, now), "active");
});
test("formatBytes", () => { assert.equal(L.formatBytes(1536), "2 KB"); assert.equal(L.formatBytes(5 * 1024 ** 2), "5.0 MB"); });

// ---------------------------------------------------------------- Drive migration: routing + server rules
test("uploadRoute: images and small files go through the server, big reels go direct to Drive", () => {
  assert.equal(L.uploadRoute({ size: 1e6 }), "server");
  assert.equal(L.uploadRoute({ size: L.SERVER_UPLOAD_MAX_BYTES }), "server");
  assert.equal(L.uploadRoute({ size: L.SERVER_UPLOAD_MAX_BYTES + 1 }), "direct");
});
test("client and server validation rules cannot drift apart", () => {
  assert.deepEqual([...V.VIDEO_TYPES], L.VIDEO_TYPES);
  assert.deepEqual([...V.IMAGE_TYPES], L.IMAGE_TYPES);
  assert.equal(V.MAX_BYTES, L.MAX_BYTES); assert.equal(V.MAX_ITEMS, L.MAX_ITEMS);
  assert.equal(V.SERVER_UPLOAD_MAX_BYTES, L.SERVER_UPLOAD_MAX_BYTES);
});
test("server validateUpload: type, size and count", () => {
  assert.deepEqual(V.validateUpload({ mimeType: "video/mp4", size: 5 }, 0), { ok: true, kind: "video" });
  for (const bad of [{ mimeType: "application/pdf", size: 5 }, { mimeType: "image/svg+xml", size: 5 }, { mimeType: "image/png", size: 0 }, { mimeType: "image/png", size: "x" }, { mimeType: "image/png", size: V.MAX_BYTES + 1 }, {}])
    assert.equal(V.validateUpload(bad, 0).ok, false);
  assert.equal(V.validateUpload({ mimeType: "image/png", size: 5 }, V.MAX_ITEMS).ok, false);
});
test("safeDriveName strips path and control characters", () => {
  assert.equal(V.safeDriveName("a/b\\c:d.mp4"), "a-b-c-d.mp4");
  assert.equal(V.safeDriveName(""), "portfolio-file"); assert.equal(V.safeDriveName(null), "portfolio-file");
  assert.ok(V.safeDriveName("x".repeat(500)).length <= 120);
});

// ---------------------------------------------------------------- Range proxy (video seeking)
test("parseRange: no header = whole file; ranges are inclusive and clamped to the file and the per-response cap", () => {
  assert.deepEqual(parseRange(null, 1000, 100), { status: 200 });
  assert.deepEqual(parseRange("bytes=0-499", 1000, 1000), { status: 206, start: 0, end: 499 });
  assert.deepEqual(parseRange("bytes=900-", 1000, 1000), { status: 206, start: 900, end: 999 });
  assert.deepEqual(parseRange("bytes=0-", 1000, 100), { status: 206, start: 0, end: 99 });          // capped
  assert.deepEqual(parseRange("bytes=0-5000", 1000, 1000), { status: 206, start: 0, end: 999 });     // end past EOF
  assert.deepEqual(parseRange("bytes=-200", 1000, 1000), { status: 206, start: 800, end: 999 });     // suffix
  assert.deepEqual(parseRange("bytes=-5000", 1000, 1000), { status: 206, start: 0, end: 999 });
});
test("parseRange: unsatisfiable or malformed ranges are rejected, not served", () => {
  for (const h of ["bytes=1000-", "bytes=2000-3000", "bytes=500-100", "bytes=-0", "bytes=-", "bytes=abc-"]) assert.equal(parseRange(h, 1000, 100).status, 416, h);
  assert.equal(parseRange("items=0-5", 1000, 100).status, 200);   // unknown unit: ignored per RFC 9110
});

// ---------------------------------------------------------------- media tickets
test("media ticket: round-trips, rejects tampering, wrong key, expiry and malformed scope", async () => {
  const now = Math.floor(Date.now() / 1000);
  const t = await signMediaTicket({ i: "item-1", l: "link-1", u: null, exp: now + 60 }, "secret");
  assert.deepEqual(await verifyMediaTicket(t, "secret"), { i: "item-1", l: "link-1", u: null, exp: now + 60 });
  assert.equal(await verifyMediaTicket(t, "other"), null);
  assert.equal(await verifyMediaTicket(t.slice(0, -2) + "xx", "secret"), null);
  assert.equal(await verifyMediaTicket(t, "secret", now + 61), null);
  assert.equal(await verifyMediaTicket("garbage", "secret"), null);
  const both = await signMediaTicket({ i: "a", l: "b", u: "c", exp: now + 60 }, "secret");     // link AND owner: invalid
  const neither = await signMediaTicket({ i: "a", l: null, u: null, exp: now + 60 }, "secret");
  assert.equal(await verifyMediaTicket(both, "secret"), null);
  assert.equal(await verifyMediaTicket(neither, "secret"), null);
  const owner = await signMediaTicket({ i: "a", l: null, u: "user-1", exp: now + 60 }, "secret");
  assert.deepEqual(await verifyMediaTicket(owner, "secret"), { i: "a", l: null, u: "user-1", exp: now + 60 });
});
