import test from "node:test";
import assert from "node:assert/strict";
import * as L from "./logic.js";

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
test("buildStoragePath: stays under the user's folder and neutralises hostile names", () => {
  const p = L.buildStoragePath(U, "../../etc/pass wd?.mp4", "abc");
  assert.ok(p.startsWith(`${U}/abc-`));
  assert.ok(!p.slice(U.length + 1).includes("/") && !p.includes(".."));
  assert.ok(L.buildStoragePath(U, "", "x").endsWith("-file"));
  assert.ok(L.buildStoragePath(U, "é日本語.mp4", "x").endsWith(".mp4"));
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
