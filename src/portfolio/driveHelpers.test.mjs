import test from "node:test";
import assert from "node:assert/strict";
import { createResumableUploadSession, fetchDriveFileStream, listFilesByAppProperty } from "../../supabase/functions/_shared/google.ts";

// Request shapes only (fetch is stubbed): these do NOT prove Google accepts them. See the live checklist in the report.
const realFetch = globalThis.fetch;
const capture = (response) => { const seen = []; globalThis.fetch = async (url, init) => { seen.push({ url: String(url), init }); return typeof response === "function" ? response(url, init) : response; }; return seen; };
test.afterEach(() => { globalThis.fetch = realFetch; });

test("createResumableUploadSession tags the file with appProperties only when asked (other callers unchanged)", async () => {
  let seen = capture(new Response("", { status: 200, headers: { Location: "https://upload.example/s" } }));
  await createResumableUploadSession("tok", "folder1234", "a.mp4", "video/mp4", 10, "https://app.example", { portfolioUpload: "u-1" });
  assert.deepEqual(JSON.parse(seen[0].init.body), { name: "a.mp4", parents: ["folder1234"], appProperties: { portfolioUpload: "u-1" } });
  seen = capture(new Response("", { status: 200, headers: { Location: "https://upload.example/s" } }));
  await createResumableUploadSession("tok", "folder1234", "a.mp4", "video/mp4", 10);
  assert.deepEqual(JSON.parse(seen[0].init.body), { name: "a.mp4", parents: ["folder1234"] });
});
test("listFilesByAppProperty queries by tag AND folder, excludes trashed, and returns the files", async () => {
  const seen = capture(Response.json({ files: [{ id: "f1", parents: ["folder1234"] }] }));
  const out = await listFilesByAppProperty("tok", "folder1234", "portfolioUpload", "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(out, [{ id: "f1", parents: ["folder1234"] }]);
  const q = new URL(seen[0].url).searchParams.get("q");
  assert.equal(q, "appProperties has { key='portfolioUpload' and value='11111111-1111-4111-8111-111111111111' } and 'folder1234' in parents and trashed = false");
  assert.equal(seen[0].init.headers.Authorization, "Bearer tok");
});
test("listFilesByAppProperty refuses values that could alter the query, and surfaces Drive errors", async () => {
  capture(Response.json({ files: [] }));
  for (const [f, k, v] of [["folder1234", "portfolioUpload", "x' or '1'='1"], ["folder1234", "k y", "abc"], ["fol'der1234", "portfolioUpload", "abc"], ["folder1234", "portfolioUpload", ""]])
    await assert.rejects(() => listFilesByAppProperty("tok", f, k, v), /Invalid Drive query/);
  capture(new Response("no", { status: 403 }));
  await assert.rejects(() => listFilesByAppProperty("tok", "folder1234", "portfolioUpload", "abc"), /Drive file search failed: 403/);
});
test("fetchDriveFileStream passes the abort signal and Range through (existing callers pass neither)", async () => {
  const ac = new AbortController();
  let seen = capture(new Response("x"));
  await fetchDriveFileStream("tok", "fileid", "bytes=0-9", ac.signal);
  assert.equal(seen[0].init.signal, ac.signal); assert.equal(seen[0].init.headers.Range, "bytes=0-9");
  seen = capture(new Response("x"));
  await fetchDriveFileStream("tok", "fileid");
  assert.equal(seen[0].init.headers.Range, undefined);
});
