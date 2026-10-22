import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { signMediaTicket } from "../../supabase/functions/_shared/portfolio/ticket.ts";
import { encryptText } from "../../supabase/functions/_shared/crypto.ts";

// Loads the REAL portfolio-media Edge Function under node: `Deno` and the esm.sh supabase import are stubbed, the
// database is an in-memory model of the live checks in portfolio_authorize_media (the SQL itself is covered by
// supabase/tests/portfolio.test.sql), and `fetch` plays Google Drive / Supabase Storage. Nothing here talks to a
// real service.
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, n) { if (s.startsWith("https://esm.sh/")) return { url: "data:text/javascript,export const createClient=(...a)=>globalThis.__createClient(...a);", shortCircuit: true }; return n(s, c); }`));

const SUPABASE_URL = "https://proj.supabase.co";
const SERVICE_KEY = "service-role-secret-key";
const SIGNING_KEY = "k".repeat(32);
const ENC_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
const env = { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, DOWNLOAD_SIGNING_KEY: SIGNING_KEY, DRIVE_TOKEN_ENCRYPTION_KEY: ENC_KEY, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csecret" };
globalThis.Deno = { env: { get: (k) => env[k] }, serve: (fn) => { globalThis.__handler = fn; } };

const OWNER = "00000000-0000-0000-0000-0000000000a1";
const OTHER = "00000000-0000-0000-0000-0000000000a2";
const LINK = "00000000-0000-0000-0000-00000000c001";
const SIZE = 1000;
const BYTES = Uint8Array.from({ length: SIZE }, (_, i) => i % 251);

// ---- fake world ------------------------------------------------------------------------------------------
let db; let calls;
const resetWorld = async () => {
  db = {
    items: [
      { id: "i-legacy", user_id: OWNER, kind: "video", mime_type: "video/mp4", size_bytes: SIZE, drive_file_id: null, storage_path: `${OWNER}/legacy.mp4` },
      { id: "i-drive", user_id: OWNER, kind: "video", mime_type: "video/mp4", size_bytes: SIZE, drive_file_id: "drive-file-0001", storage_path: null },
      { id: "i-other", user_id: OTHER, kind: "image", mime_type: "image/png", size_bytes: SIZE, drive_file_id: null, storage_path: `${OTHER}/o.png` },
    ],
    links: [{ id: LINK, user_id: OWNER, revoked_at: null, expires_at: null }],
    conns: { [OWNER]: { refresh_token_encrypted: await encryptText("refresh-token", ENC_KEY) } },
    storageIgnoresRange: false, driveIgnoresRange: false, driveFirst401: false,
  };
  calls = { rpc: 0, upstream: [], signedUrls: 0, token: 0 };
};
// Mirrors portfolio_authorize_media: public link must be the owner's, unrevoked, unexpired; preview must be the owner.
function authorize({ p_item, p_link, p_user }) {
  const i = db.items.find((x) => x.id === p_item); if (!i) return null;
  if (p_link) { const l = db.links.find((x) => x.id === p_link); if (!l || l.user_id !== i.user_id || l.revoked_at || (l.expires_at && l.expires_at <= Date.now())) return null; }
  else if (!p_user || i.user_id !== p_user) return null;
  return { user_id: i.user_id, kind: i.kind, mime_type: i.mime_type, size_bytes: i.size_bytes, drive_file_id: i.drive_file_id, storage_path: i.storage_path };
}
globalThis.__createClient = () => ({
  rpc: async (name, args) => { calls.rpc++; return name === "portfolio_authorize_media" ? { data: authorize(args), error: null } : { data: null, error: { message: "unknown rpc" } }; },
  from: (table) => ({ select: () => ({ eq: (_c, userId) => ({ maybeSingle: async () => ({ data: table === "google_drive_connections" ? db.conns[userId] ?? null : null }) }) }) }),
  storage: { from: () => ({ createSignedUrl: async () => { calls.signedUrls++; return { data: { signedUrl: "https://signed.example/leak" } }; } }) },
});
function rangeAware(req, ignore) {
  const range = new Headers(req.headers).get("Range");
  const m = range && /^bytes=(\d+)-(\d+)$/.exec(range);
  if (!m || ignore) return new Response(BYTES, { status: 200, headers: { "Content-Length": String(SIZE) } });
  const a = Number(m[1]); const b = Math.min(Number(m[2]), SIZE - 1);
  return new Response(BYTES.slice(a, b + 1), { status: 206, headers: { "Content-Range": `bytes ${a}-${b}/${SIZE}`, "Content-Length": String(b - a + 1) } });
}
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith("https://oauth2.googleapis.com/token")) { calls.token++; return Response.json({ access_token: `tok-${calls.token}` }); }
  const headers = new Headers(init.headers);
  if (url.startsWith(`${SUPABASE_URL}/storage/v1/object/authenticated/portfolio/`)) {
    calls.upstream.push({ kind: "storage", url, auth: headers.get("Authorization"), apikey: headers.get("apikey"), range: headers.get("Range") });
    return rangeAware({ headers }, db.storageIgnoresRange);
  }
  if (url.startsWith("https://www.googleapis.com/drive/v3/files/")) {
    calls.upstream.push({ kind: "drive", url, auth: headers.get("Authorization"), range: headers.get("Range") });
    if (db.driveFirst401) { db.driveFirst401 = false; return new Response("expired", { status: 401 }); }
    return rangeAware({ headers }, db.driveIgnoresRange);
  }
  throw new Error(`unexpected fetch: ${url}`);
};

await import("../../supabase/functions/portfolio-media/index.ts");
const handler = globalThis.__handler;
const future = () => Math.floor(Date.now() / 1000) + 3600;
const ticketFor = (o) => signMediaTicket({ i: o.i, l: o.l ?? null, u: o.u ?? null, exp: o.exp ?? future() }, o.key ?? SIGNING_KEY);
const get = async (o, headers = {}) => handler(new Request(`https://x/functions/v1/portfolio-media?t=${encodeURIComponent(typeof o === "string" ? o : await ticketFor(o))}`, { headers }));
const NOT_AVAILABLE = { error: "not_available" };

// ---------------------------------------------------------------- legacy Storage media
test("legacy item: streamed THROUGH the function; no redirect, no Location header, no Storage signed URL is ever created", async () => {
  await resetWorld();
  const res = await get({ i: "i-legacy", l: LINK });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Location"), null);
  assert.equal(calls.signedUrls, 0);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), BYTES);
  assert.equal(calls.upstream.length, 1);
  const u = calls.upstream[0];
  assert.equal(u.kind, "storage"); assert.equal(u.url, `${SUPABASE_URL}/storage/v1/object/authenticated/portfolio/${OWNER}/legacy.mp4`);
  assert.equal(u.auth, `Bearer ${SERVICE_KEY}`);
  assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  assert.equal(res.headers.get("Content-Type"), "video/mp4");
});
test("legacy item: Range requests are forwarded and answered with a validated 206", async () => {
  await resetWorld();
  const res = await get({ i: "i-legacy", l: LINK }, { Range: "bytes=10-19" });
  assert.equal(res.status, 206); assert.equal(res.headers.get("Content-Range"), "bytes 10-19/1000");
  assert.equal(calls.upstream[0].range, "bytes=10-19");
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), BYTES.slice(10, 20));
});
test("legacy item: if Storage ignores Range the player gets an error, never a mislabelled 206", async () => {
  await resetWorld(); db.storageIgnoresRange = true;
  const res = await get({ i: "i-legacy", l: LINK }, { Range: "bytes=10-19" });
  assert.equal(res.status, 502); assert.equal(res.headers.get("Content-Range"), null);
});
test("legacy item: an unsafe stored path is never fetched", async () => {
  await resetWorld();
  for (const path of [`${OTHER}/stolen.mp4`, `${OWNER}/../${OTHER}/x.png`, null]) {
    db.items[0].storage_path = path; calls.upstream.length = 0;
    const res = await get({ i: "i-legacy", l: LINK });
    assert.equal(res.status, 404); assert.equal(calls.upstream.length, 0, String(path));
  }
});

// ---------------------------------------------------------------- revocation / expiry (the defect: a signed URL outlived the revoked link)
for (const [label, id] of [["legacy Storage", "i-legacy"], ["Google Drive", "i-drive"]]) {
  test(`${label} item: revoking the link stops the NEXT request immediately, even with an unexpired ticket and a Range request`, async () => {
    await resetWorld();
    const ticket = await ticketFor({ i: id, l: LINK });
    assert.equal((await get(ticket)).status, 200);
    assert.equal((await get(ticket, { Range: "bytes=0-9" })).status, 206);
    const before = calls.upstream.length;
    db.links[0].revoked_at = Date.now();                                    // owner clicks "Revoke"
    for (const h of [{}, { Range: "bytes=0-9" }, { Range: "bytes=500-" }]) {
      const res = await get(ticket, h);
      assert.equal(res.status, 404); assert.deepEqual(await res.json(), NOT_AVAILABLE);
    }
    assert.equal(calls.upstream.length, before, "no upstream request may be made after revocation");
    assert.equal(calls.signedUrls, 0);
  });
  test(`${label} item: an expired link is refused; so is a deleted item`, async () => {
    await resetWorld();
    const ticket = await ticketFor({ i: id, l: LINK });
    db.links[0].expires_at = Date.now() - 1000;
    assert.equal((await get(ticket)).status, 404);
    db.links[0].expires_at = null; assert.equal((await get(ticket)).status, 200);
    db.items = db.items.filter((x) => x.id !== id);
    assert.equal((await get(ticket)).status, 404);
  });
  test(`${label} item: every request re-runs the database authorization check`, async () => {
    await resetWorld();
    const ticket = await ticketFor({ i: id, l: LINK });
    await (await get(ticket)).arrayBuffer(); await (await get(ticket, { Range: "bytes=0-9" })).arrayBuffer(); await get(ticket, { Range: "bytes=10-19" });
    assert.equal(calls.rpc, 3);
  });
}

// ---------------------------------------------------------------- scoping
test("a public link can only fetch items of ITS owner", async () => {
  await resetWorld();
  const res = await get({ i: "i-other", l: LINK });                           // LINK belongs to OWNER; i-other belongs to OTHER
  assert.equal(res.status, 404); assert.equal(calls.upstream.length, 0);
});
test("owner preview: works for the owner's items, refused for anyone else's, and a ticket cannot be both link and owner", async () => {
  await resetWorld();
  assert.equal((await get({ i: "i-legacy", u: OWNER })).status, 200);
  assert.equal((await get({ i: "i-drive", u: OWNER })).status, 200);
  calls.upstream.length = 0;
  assert.equal((await get({ i: "i-legacy", u: OTHER })).status, 404);
  assert.equal((await get({ i: "i-other", u: OWNER })).status, 404);
  assert.equal((await get({ i: "i-legacy", l: LINK, u: OWNER })).status, 403);   // malformed scope: invalid ticket
  assert.equal(calls.upstream.length, 0);
});
test("unauthorized responses are identical whether or not the file exists (no existence oracle)", async () => {
  await resetWorld(); db.links[0].revoked_at = Date.now();
  const revoked = await get({ i: "i-legacy", l: LINK });
  const missing = await get({ i: "does-not-exist", l: LINK });
  const foreign = await get({ i: "i-legacy", u: OTHER });
  const bodies = await Promise.all([revoked, missing, foreign].map(async (r) => [r.status, await r.text()]));
  assert.deepEqual(bodies[0], bodies[1]); assert.deepEqual(bodies[0], bodies[2]);
  assert.deepEqual(JSON.parse(bodies[0][1]), NOT_AVAILABLE);
});
test("bad, tampered, expired or wrong-key tickets never reach the database or upstream", async () => {
  await resetWorld();
  const good = await ticketFor({ i: "i-legacy", l: LINK });
  for (const t of ["", "x", "a.b", good.slice(0, -2) + "xx", await ticketFor({ i: "i-legacy", l: LINK, exp: 1 }), await ticketFor({ i: "i-legacy", l: LINK, key: "z".repeat(32) })]) {
    const res = await get(t); assert.equal(res.status, 403, t.slice(0, 20));
  }
  assert.equal(calls.rpc, 0); assert.equal(calls.upstream.length, 0);
});
test("non-GET is refused; a missing signing key fails closed", async () => {
  await resetWorld();
  assert.equal((await handler(new Request("https://x/?t=a", { method: "POST" }))).status, 405);
  const k = env.DOWNLOAD_SIGNING_KEY; delete env.DOWNLOAD_SIGNING_KEY;
  try { assert.equal((await get("whatever")).status, 503); } finally { env.DOWNLOAD_SIGNING_KEY = k; }
});

// ---------------------------------------------------------------- Drive path through the real handler
test("Drive item: full request, valid range, and an expired access token (401 -> refresh -> retry) all stream correctly", async () => {
  await resetWorld();
  let res = await get({ i: "i-drive", l: LINK });
  assert.equal(res.status, 200); assert.deepEqual(new Uint8Array(await res.arrayBuffer()), BYTES);
  assert.match(calls.upstream[0].auth, /^Bearer tok-/);
  db.driveFirst401 = true;
  res = await get({ i: "i-drive", u: OWNER }, { Range: "bytes=100-199" });
  assert.equal(res.status, 206); assert.equal(res.headers.get("Content-Range"), "bytes 100-199/1000");
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), BYTES.slice(100, 200));
});
test("Drive item: upstream ignoring Range -> 502 (not a 206 carrying the whole file); unsatisfiable range -> 416 without contacting Drive", async () => {
  await resetWorld(); db.driveIgnoresRange = true;
  let res = await get({ i: "i-drive", l: LINK }, { Range: "bytes=100-199" });
  assert.equal(res.status, 502); assert.equal(res.headers.get("Content-Range"), null);
  calls.upstream.length = 0;
  res = await get({ i: "i-drive", l: LINK }, { Range: "bytes=5000-" });
  assert.equal(res.status, 416); assert.equal(res.headers.get("Content-Range"), "bytes */1000"); assert.equal(calls.upstream.length, 0);
});
test("Drive item: Drive not connected -> 503 and no upstream call", async () => {
  await resetWorld();
  const U3 = "00000000-0000-0000-0000-0000000000a3";           // never cached by an earlier test (the handler caches Drive tokens per user)
  db.items.push({ id: "i-u3", user_id: U3, kind: "video", mime_type: "video/mp4", size_bytes: SIZE, drive_file_id: "drive-file-0003", storage_path: null });
  db.links.push({ id: "00000000-0000-0000-0000-00000000c003", user_id: U3, revoked_at: null, expires_at: null });
  const res = await get({ i: "i-u3", l: "00000000-0000-0000-0000-00000000c003" });
  assert.equal(res.status, 503); assert.equal(calls.upstream.length, 0);
});

// ---------------------------------------------------------------- guard against reintroducing the redirect
test("portfolio-media never issues Storage signed URLs or redirects", () => {
  const src = readFileSync(new URL("../../supabase/functions/portfolio-media/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /createSignedUrl/);
  assert.doesNotMatch(src, /status:\s*30[1-8]/);
  assert.doesNotMatch(src, /Location/);
});
