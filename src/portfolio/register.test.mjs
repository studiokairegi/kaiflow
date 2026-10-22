import test from "node:test";
import assert from "node:assert/strict";
import { deletePortfolioItem, recoverUpload, registerDriveFile, RegisterError, trashConfirmed } from "../../supabase/functions/_shared/portfolio/register.ts";

// In-memory Drive + portfolio_items. `log` records every Drive/DB side effect in order so tests can assert
// not just WHAT happened but WHEN (e.g. the old file is trashed only after the replacement row is saved).
const U1 = "00000000-0000-0000-0000-0000000000a1";
const U2 = "00000000-0000-0000-0000-0000000000a2";
const FOLDER = "folder-1";
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

function world() {
  const w = { drive: new Map(), rows: [], log: [], trashFails: new Set(), metaThrows: false, nextInsertError: null, nextUpdateError: null, deleteError: null, legacyRemoveFails: false, removedLegacy: [] };
  const log = (...a) => w.log.push(a.join(":"));
  w.file = (id, over = {}) => { w.drive.set(id, { id, name: `${id}.mp4`, mimeType: "video/mp4", size: "5000000", trashed: false, parents: [FOLDER], ...over }); return id; };
  w.row = (over = {}) => { const r = { id: uuid(), user_id: U1, kind: "video", title: "t", drive_file_id: null, storage_path: null, mime_type: "video/mp4", size_bytes: 1, sort_order: w.rows.length, ...over }; w.rows.push(r); return r; };
  w.deps = {
    listUploads: async (folderId, uploadId) => { log("listUploads", uploadId); if (w.listThrows) throw new Error("drive 503"); return [...w.drive.values()].filter((f) => f.appProperties?.portfolioUpload === uploadId && f.parents?.includes(folderId) && !f.trashed); },
    getMeta: async (id) => { log("getMeta", id); if (w.metaThrows) throw new Error("drive 503"); return w.drive.get(id) ?? null; },
    trash: async (id) => { log("trash", id); if (w.trashFails.has(id)) return false; const f = w.drive.get(id); if (f) f.trashed = true; return true; },
    store: {
      // Like a real database, reads return COPIES (a later update must not retroactively change what was read).
      findByDriveFile: async (id) => { if (w.readThrows) throw new Error("db read failed"); const r = w.rows.find((x) => x.drive_file_id === id); return r ? { ...r } : null; },
      getOwned: async (u, id) => { if (w.readThrows) throw new Error("db read failed"); const r = w.rows.find((x) => x.id === id && x.user_id === u); return r ? { ...r } : null; },
      insert: async (u, media, title) => {
        if (w.nextInsertError) { const error = w.nextInsertError; w.nextInsertError = null; return { error }; }
        if (w.rows.some((r) => r.drive_file_id === media.drive_file_id)) return { error: { code: "23505", message: "duplicate key" } };
        log("insert", media.drive_file_id); const r = { id: uuid(), user_id: u, title, sort_order: w.rows.length, ...media }; w.rows.push(r); return { row: { ...r } };
      },
      update: async (u, id, media) => {
        if (w.nextUpdateError) { const error = w.nextUpdateError; w.nextUpdateError = null; return { error }; }
        if (w.rows.some((r) => r.drive_file_id === media.drive_file_id && r.id !== id)) return { error: { code: "23505", message: "duplicate key" } };
        const r = w.rows.find((x) => x.id === id && x.user_id === u); if (!r) return { error: { message: "no rows" } };
        log("update", id); Object.assign(r, media); return { row: { ...r } };
      },
      delete: async (u, id) => {
        if (w.deleteError) return { error: w.deleteError };
        log("deleteRow", id); const i = w.rows.findIndex((r) => r.id === id && r.user_id === u); if (i >= 0) w.rows.splice(i, 1); return {};
      },
      removeLegacy: async (path) => { log("removeLegacy", path); if (w.legacyRemoveFails) return false; w.removedLegacy.push(path); return true; },
    },
  };
  w.fin = (fileId, over = {}) => registerDriveFile(w.deps, { userId: U1, folderId: FOLDER, fileId, mode: "finalize", ...over });
  w.up = (fileId, over = {}) => registerDriveFile(w.deps, { userId: U1, folderId: FOLDER, fileId, mode: "upload", ...over });
  w.trashed = () => w.log.filter((l) => l.startsWith("trash:")).map((l) => l.slice(6));
  return w;
}
const rejects = (p, code, extra = {}) => assert.rejects(p, (e) => { assert.ok(e instanceof RegisterError, `expected RegisterError, got ${e?.message}`); assert.equal(e.code, code); for (const [k, v] of Object.entries(extra)) assert.equal(e[k], v, k); return true; });

// ---------------------------------------------------------------- success + idempotency
test("finalize: a valid uploaded file becomes one item and nothing is trashed", async () => {
  const w = world(); w.file("file-aaaaaaaaaa");
  const r = await w.fin("file-aaaaaaaaaa", { originalName: "My Reel.mov" });
  assert.equal(r.created, true); assert.deepEqual(r.warnings, []);
  assert.equal(r.item.drive_file_id, "file-aaaaaaaaaa"); assert.equal(r.item.kind, "video"); assert.equal(r.item.size_bytes, 5000000); assert.equal(r.item.storage_path, null);
  assert.equal(r.item.title, "My Reel");
  assert.equal(w.rows.length, 1); assert.deepEqual(w.trashed(), []);
});
test("finalize is idempotent: repeating it for the same file returns the same item and never duplicates or trashes", async () => {
  const w = world(); w.file("file-aaaaaaaaaa");
  const a = await w.fin("file-aaaaaaaaaa"); const b = await w.fin("file-aaaaaaaaaa"); const c = await w.up("file-aaaaaaaaaa");
  assert.equal(a.item.id, b.item.id); assert.equal(b.item.id, c.item.id);
  assert.equal(b.created, false); assert.equal(w.rows.length, 1); assert.deepEqual(w.trashed(), []);
});
test("finalize re-validates on EVERY attempt, even for an already-registered file (e.g. it was trashed or moved since)", async () => {
  const w = world(); w.file("file-aaaaaaaaaa"); await w.fin("file-aaaaaaaaaa");
  w.drive.get("file-aaaaaaaaaa").trashed = true;
  await rejects(w.fin("file-aaaaaaaaaa"), "drive_file_missing");
  w.drive.get("file-aaaaaaaaaa").trashed = false; w.drive.get("file-aaaaaaaaaa").parents = ["elsewhere"];
  await rejects(w.fin("file-aaaaaaaaaa"), "drive_file_foreign");
});
test("a concurrent finalize that wins the race (unique violation) is treated as success, not an error or a cleanup", async () => {
  const w = world(); w.file("file-aaaaaaaaaa");
  w.deps.store.insert = async (u, media) => { const r = w.row({ drive_file_id: media.drive_file_id }); void r; return { error: { code: "23505", message: "duplicate key" } }; };
  const r = await w.fin("file-aaaaaaaaaa");
  assert.equal(r.created, false); assert.equal(w.rows.length, 1); assert.deepEqual(w.trashed(), []);
});

// ---------------------------------------------------------------- failure + retry
test("finalize failure keeps the uploaded file and is retryable with the SAME Drive file id (no re-upload, no duplicate)", async () => {
  const w = world(); w.file("file-aaaaaaaaaa");
  w.nextInsertError = { code: "XX000", message: "connection reset" };
  await rejects(w.fin("file-aaaaaaaaaa"), "db_error", { retryable: true, fileId: "file-aaaaaaaaaa", status: 500 });
  assert.deepEqual(w.trashed(), [], "a retryable failure must not discard the upload");
  assert.equal(w.rows.length, 0);
  const r = await w.fin("file-aaaaaaaaaa");                                   // the retry
  assert.equal(r.created, true); assert.equal(w.rows.length, 1); assert.equal(w.drive.size, 1);
});
test("transient Drive failures and not-yet-visible uploads are reported as retryable", async () => {
  const w = world();
  w.metaThrows = true; w.file("file-aaaaaaaaaa");
  await rejects(w.fin("file-aaaaaaaaaa"), "drive_unavailable", { retryable: true, fileId: "file-aaaaaaaaaa", status: 502 });
  w.metaThrows = false;
  await rejects(w.fin("file-bbbbbbbbbb"), "drive_file_missing", { retryable: true });          // 404 right after upload
  assert.equal((await w.fin("file-aaaaaaaaaa")).created, true);
  assert.deepEqual(w.trashed(), []);
});
test("the 50-item limit is a retryable conflict and does not discard the upload (delete one, then retry)", async () => {
  const w = world(); w.file("file-aaaaaaaaaa");
  w.nextInsertError = { code: "P0001", message: "A portfolio can hold up to 50 items." };
  await rejects(w.fin("file-aaaaaaaaaa"), "limit_reached", { status: 409, retryable: true, fileId: "file-aaaaaaaaaa" });
  assert.deepEqual(w.trashed(), []);
});

// ---------------------------------------------------------------- invalid / misplaced files
test("misplaced, trashed, or unknown-folder files are rejected and NEVER trashed (they may be the user's other files)", async () => {
  const w = world();
  w.file("file-elsewhere1", { parents: ["some-other-folder"] }); w.file("file-noparents1", { parents: undefined }); w.file("file-trashed001", { trashed: true });
  await rejects(w.fin("file-elsewhere1"), "drive_file_foreign");
  await rejects(w.fin("file-noparents1"), "drive_file_foreign");
  await rejects(w.fin("file-trashed001"), "drive_file_missing");
  assert.deepEqual(w.trashed(), []); assert.equal(w.rows.length, 0);
});
test("an invalid file inside the portfolio folder is trashed, and the trash result is CHECKED", async () => {
  for (const bad of [{ mimeType: "application/pdf" }, { mimeType: "image/svg+xml" }, { size: "0" }, { size: String(500 * 1024 * 1024 + 1) }, { size: undefined }]) {
    const w = world(); w.file("file-badbadbad1", bad);
    await rejects(w.fin("file-badbadbad1"), "invalid_file", { fileId: undefined });
    assert.deepEqual(w.trashed(), ["file-badbadbad1"]); assert.equal(w.drive.get("file-badbadbad1").trashed, true); assert.equal(w.rows.length, 0);
  }
});
test("cleanup failure of an invalid file is surfaced (with the id for manual removal), not assumed to have worked", async () => {
  const w = world(); w.file("file-badbadbad1", { mimeType: "application/pdf" }); w.trashFails.add("file-badbadbad1");
  await rejects(w.fin("file-badbadbad1"), "invalid_file", { fileId: "file-badbadbad1", retryable: false });
  try { await w.fin("file-badbadbad1"); } catch (e) { assert.match(e.message, /delete it there manually/i); }
});
test("an invalid file that is somehow already registered is never trashed", async () => {
  const w = world(); w.file("file-badbadbad1", { mimeType: "application/pdf" }); w.row({ drive_file_id: "file-badbadbad1" });
  await rejects(w.fin("file-badbadbad1"), "invalid_file"); assert.deepEqual(w.trashed(), []);
});
test("a file registered to ANOTHER user is a generic duplicate: not reused, not trashed", async () => {
  const w = world(); w.file("file-aaaaaaaaaa"); w.row({ user_id: U2, drive_file_id: "file-aaaaaaaaaa" });
  await rejects(w.fin("file-aaaaaaaaaa"), "duplicate", { status: 409 });
  assert.deepEqual(w.trashed(), []); assert.equal(w.rows.length, 1);
});
test("replaceItemId must be a real item id", async () => {
  const w = world(); w.file("file-aaaaaaaaaa");
  for (const bad of ["x", "123", {}, "../etc", "00000000-0000-0000-0000-00000000000g"]) await rejects(w.fin("file-aaaaaaaaaa", { replaceItemId: bad }), "bad_request");
  assert.deepEqual(w.log.filter((l) => l.startsWith("getMeta")), []);
});

// ---------------------------------------------------------------- replacement
test("replacement: the item keeps its id, the old Drive file is trashed only AFTER the new media is saved", async () => {
  const w = world(); w.file("file-oldoldold1"); w.file("file-newnewnew1");
  const old = w.row({ drive_file_id: "file-oldoldold1" });
  const r = await w.fin("file-newnewnew1", { replaceItemId: old.id });
  assert.equal(r.item.id, old.id); assert.equal(r.item.drive_file_id, "file-newnewnew1"); assert.deepEqual(r.warnings, []);
  assert.equal(w.rows.length, 1);
  assert.ok(w.log.indexOf(`update:${old.id}`) < w.log.indexOf("trash:file-oldoldold1"), "update must precede trashing the old file");
  assert.deepEqual(w.trashed(), ["file-oldoldold1"]);
});
test("replacement failure leaves the OLD file and row intact and the new upload retryable", async () => {
  const w = world(); w.file("file-oldoldold1"); w.file("file-newnewnew1");
  const old = w.row({ drive_file_id: "file-oldoldold1" });
  w.nextUpdateError = { message: "timeout" };
  await rejects(w.fin("file-newnewnew1", { replaceItemId: old.id }), "db_error", { retryable: true, fileId: "file-newnewnew1" });
  assert.deepEqual(w.trashed(), []); assert.equal(w.rows[0].drive_file_id, "file-oldoldold1");
  const r = await w.fin("file-newnewnew1", { replaceItemId: old.id });                 // retry
  assert.equal(r.item.drive_file_id, "file-newnewnew1"); assert.deepEqual(w.trashed(), ["file-oldoldold1"]);
});
test("replacement retry after the swap already succeeded is idempotent (no second trash, old file not touched again)", async () => {
  const w = world(); w.file("file-oldoldold1"); w.file("file-newnewnew1");
  const old = w.row({ drive_file_id: "file-oldoldold1" });
  await w.fin("file-newnewnew1", { replaceItemId: old.id });
  const r = await w.fin("file-newnewnew1", { replaceItemId: old.id });
  assert.equal(r.created, false); assert.deepEqual(w.trashed(), ["file-oldoldold1"]); assert.equal(w.rows.length, 1);
});
test("replacing with a file that already backs ANOTHER item is refused and trashes nothing (the registered file is safe)", async () => {
  const w = world(); w.file("file-oneoneone1"); w.file("file-twotwotwo1");
  const a = w.row({ drive_file_id: "file-oneoneone1" }); const b = w.row({ drive_file_id: "file-twotwotwo1" });
  await rejects(w.fin("file-twotwotwo1", { replaceItemId: a.id }), "duplicate");
  assert.deepEqual(w.trashed(), []); assert.equal(a.drive_file_id, "file-oneoneone1"); assert.equal(b.drive_file_id, "file-twotwotwo1");
});
test("the old file's cleanup failure is reported as a warning (the replacement is still saved)", async () => {
  const w = world(); w.file("file-oldoldold1"); w.file("file-newnewnew1"); w.trashFails.add("file-oldoldold1");
  const old = w.row({ drive_file_id: "file-oldoldold1" });
  const r = await w.fin("file-newnewnew1", { replaceItemId: old.id });
  assert.equal(r.item.drive_file_id, "file-newnewnew1");
  assert.equal(r.warnings.length, 1); assert.equal(r.warnings[0].code, "old_file_cleanup_failed");
});
test("a failed trash of a file that is in fact already trashed or gone is not a warning", async () => {
  const w = world(); w.file("file-oldoldold1", { trashed: true }); w.file("file-newnewnew1"); w.trashFails.add("file-oldoldold1");
  const old = w.row({ drive_file_id: "file-oldoldold1" });
  assert.deepEqual((await w.fin("file-newnewnew1", { replaceItemId: old.id })).warnings, []);
  assert.equal(await trashConfirmed(w.deps, "never-existed-1"), true);                // trash false + 404 => gone
});
test("legacy -> Drive migration removes the old Storage object only after the swap, and only inside the owner's folder", async () => {
  const w = world(); w.file("file-newnewnew1");
  const old = w.row({ storage_path: `${U1}/old.mp4` });
  const r = await w.fin("file-newnewnew1", { replaceItemId: old.id });
  assert.equal(r.item.storage_path, null); assert.deepEqual(w.removedLegacy, [`${U1}/old.mp4`]);
  assert.ok(w.log.indexOf(`update:${old.id}`) < w.log.indexOf(`removeLegacy:${U1}/old.mp4`));
  // failure to remove is a warning; a path outside the owner's folder is never removed
  const w2 = world(); w2.file("file-newnewnew1"); w2.legacyRemoveFails = true;
  const o2 = w2.row({ storage_path: `${U1}/old.mp4` });
  assert.equal((await w2.fin("file-newnewnew1", { replaceItemId: o2.id })).warnings[0].code, "legacy_cleanup_failed");
  const w3 = world(); w3.file("file-newnewnew1"); const o3 = w3.row({ storage_path: `${U2}/victim.mp4` });
  assert.equal((await w3.fin("file-newnewnew1", { replaceItemId: o3.id })).warnings[0].code, "legacy_cleanup_failed");
  assert.deepEqual(w3.removedLegacy, []);
});
test("replacement target vanished (or is someone else's): the file is added as a NEW item with a clear warning; nothing is orphaned, trashed or taken from anyone", async () => {
  const w = world(); w.file("file-victim00001"); w.file("file-newnewnew1"); w.file("file-newnewnew2");
  const theirs = w.row({ user_id: U2, drive_file_id: "file-victim00001" });
  const gone = await w.fin("file-newnewnew1", { replaceItemId: uuid() });                    // deleted in another tab
  assert.equal(gone.created, true); assert.equal(gone.item.drive_file_id, "file-newnewnew1"); assert.equal(gone.item.user_id, U1);
  assert.equal(gone.warnings.length, 1); assert.equal(gone.warnings[0].code, "replace_target_missing");
  assert.match(gone.warnings[0].message, /no longer exists/);
  const foreign = await w.fin("file-newnewnew2", { replaceItemId: theirs.id });              // not the caller's item
  assert.equal(foreign.created, true); assert.equal(foreign.item.user_id, U1); assert.equal(foreign.warnings[0].code, "replace_target_missing");
  assert.equal(theirs.drive_file_id, "file-victim00001", "the other user's item is untouched");
  assert.deepEqual(w.trashed(), []);
});
test("retrying after 'target vanished -> added as new' is idempotent and gives the same outcome (no duplicate, no 409)", async () => {
  const w = world(); w.file("file-newnewnew1"); const missing = uuid();
  const a = await w.fin("file-newnewnew1", { replaceItemId: missing });
  const b = await w.fin("file-newnewnew1", { replaceItemId: missing });
  assert.equal(b.item.id, a.item.id); assert.equal(b.created, false); assert.equal(b.warnings[0].code, "replace_target_missing");
  assert.equal(w.rows.length, 1); assert.deepEqual(w.trashed(), []);
});
test("the target disappearing between lookup and update is a retryable error; the retry then adds the file as a new item", async () => {
  const w = world(); w.file("file-oldoldold1"); w.file("file-newnewnew1");
  const old = w.row({ drive_file_id: "file-oldoldold1" });
  w.nextUpdateError = { message: "no rows" };
  await rejects(w.fin("file-newnewnew1", { replaceItemId: old.id }), "db_error", { retryable: true, fileId: "file-newnewnew1" });
  w.rows.length = 0;                                                                         // item deleted meanwhile
  const r = await w.fin("file-newnewnew1", { replaceItemId: old.id });
  assert.equal(r.created, true); assert.equal(r.warnings[0].code, "replace_target_missing"); assert.equal(w.rows.length, 1);
});
test("a file already registered to a DIFFERENT, still-existing item is still refused as a duplicate", async () => {
  const w = world(); w.file("file-oneoneone1"); w.file("file-twotwotwo1");
  w.row({ drive_file_id: "file-oneoneone1" }); const b = w.row({ drive_file_id: "file-twotwotwo1" });
  await rejects(w.fin("file-oneoneone1", { replaceItemId: b.id }), "duplicate");
  assert.deepEqual(w.trashed(), []);
});

// ---------------------------------------------------------------- server-side upload route (browser holds no file id)
test("upload route: a failed save discards the freshly created file and CHECKS that it worked", async () => {
  const w = world(); w.file("file-aaaaaaaaaa"); w.nextInsertError = { message: "boom" };
  await rejects(w.up("file-aaaaaaaaaa"), "db_error", { fileId: undefined, retryable: false });
  assert.deepEqual(w.trashed(), ["file-aaaaaaaaaa"]);
});
test("upload route: if that cleanup fails the id comes back so saving can be retried instead of orphaning the file", async () => {
  const w = world(); w.file("file-aaaaaaaaaa"); w.nextInsertError = { message: "boom" }; w.trashFails.add("file-aaaaaaaaaa");
  await rejects(w.up("file-aaaaaaaaaa"), "db_error", { fileId: "file-aaaaaaaaaa", retryable: true });
  w.trashFails.clear();
  assert.equal((await w.fin("file-aaaaaaaaaa")).created, true);
});
test("upload route: a replacement target that vanished adds the new file as a new item instead of discarding it", async () => {
  const w = world(); w.file("file-newnewnew1");
  const r = await w.up("file-newnewnew1", { replaceItemId: uuid() });
  assert.equal(r.created, true); assert.equal(r.warnings[0].code, "replace_target_missing"); assert.deepEqual(w.trashed(), []);
});
test("discard never trashes a file that got registered in the meantime", async () => {
  const w = world(); w.file("file-aaaaaaaaaa");
  w.deps.store.insert = async (u, media) => { w.row({ drive_file_id: media.drive_file_id }); return { error: { message: "generic failure after the row landed" } }; };
  await rejects(w.up("file-aaaaaaaaaa"), "db_error");
  assert.deepEqual(w.trashed(), []);
});

// ---------------------------------------------------------------- delete
test("delete: the Drive file is trashed BEFORE the row is removed", async () => {
  const w = world(); w.file("file-aaaaaaaaaa"); const it = w.row({ drive_file_id: "file-aaaaaaaaaa" });
  await deletePortfolioItem(w.deps, { userId: U1, itemId: it.id });
  assert.equal(w.rows.length, 0); assert.ok(w.log.indexOf("trash:file-aaaaaaaaaa") < w.log.indexOf(`deleteRow:${it.id}`));
});
test("delete: if the trash fails and the file is still live, the row is KEPT (no silent Drive/DB inconsistency) and the error is retryable", async () => {
  const w = world(); w.file("file-aaaaaaaaaa"); const it = w.row({ drive_file_id: "file-aaaaaaaaaa" }); w.trashFails.add("file-aaaaaaaaaa");
  await rejects(deletePortfolioItem(w.deps, { userId: U1, itemId: it.id }), "drive_trash_failed", { retryable: true, status: 502 });
  assert.equal(w.rows.length, 1);
  w.trashFails.clear(); await deletePortfolioItem(w.deps, { userId: U1, itemId: it.id });   // retry succeeds
  assert.equal(w.rows.length, 0);
});
test("delete: a file already gone/trashed in Drive does not block removing the row", async () => {
  const w = world(); w.file("file-aaaaaaaaaa", { trashed: true }); const a = w.row({ drive_file_id: "file-aaaaaaaaaa" }); w.trashFails.add("file-aaaaaaaaaa");
  await deletePortfolioItem(w.deps, { userId: U1, itemId: a.id }); assert.equal(w.rows.length, 0);
  const b = w.row({ drive_file_id: "file-vanished001" });                                  // not in Drive at all (404)
  await deletePortfolioItem(w.deps, { userId: U1, itemId: b.id }); assert.equal(w.rows.length, 0);
});
test("delete: a Drive meta outage during the check keeps the row (cannot confirm the file is gone)", async () => {
  const w = world(); w.file("file-aaaaaaaaaa"); const it = w.row({ drive_file_id: "file-aaaaaaaaaa" }); w.trashFails.add("file-aaaaaaaaaa"); w.metaThrows = true;
  await rejects(deletePortfolioItem(w.deps, { userId: U1, itemId: it.id }), "drive_trash_failed"); assert.equal(w.rows.length, 1);
});
test("delete: a failed row delete after a successful trash is retryable (the trashed file is not re-trashed into an error)", async () => {
  const w = world(); w.file("file-aaaaaaaaaa"); const it = w.row({ drive_file_id: "file-aaaaaaaaaa" }); w.deleteError = { message: "db down" };
  await rejects(deletePortfolioItem(w.deps, { userId: U1, itemId: it.id }), "db_error", { retryable: true });
  w.deleteError = null; await deletePortfolioItem(w.deps, { userId: U1, itemId: it.id }); assert.equal(w.rows.length, 0);
});
test("delete: cannot be used to trash another user's file", async () => {
  const w = world(); w.file("file-victim00001"); const theirs = w.row({ user_id: U2, drive_file_id: "file-victim00001" });
  await rejects(deletePortfolioItem(w.deps, { userId: U1, itemId: theirs.id }), "not_found", { status: 404 });
  assert.deepEqual(w.trashed(), []); assert.equal(w.rows.length, 1);
  await rejects(deletePortfolioItem(w.deps, { userId: U1, itemId: "not-a-uuid" }), "bad_request");
});
test("delete (legacy Storage item): removal is checked; a failure keeps the row; paths outside the owner's folder are refused", async () => {
  const w = world(); const it = w.row({ storage_path: `${U1}/a.mp4` }); w.legacyRemoveFails = true;
  await rejects(deletePortfolioItem(w.deps, { userId: U1, itemId: it.id }), "storage_remove_failed", { retryable: true }); assert.equal(w.rows.length, 1);
  w.legacyRemoveFails = false; await deletePortfolioItem(w.deps, { userId: U1, itemId: it.id }); assert.equal(w.rows.length, 0);
  const evil = w.row({ storage_path: `${U2}/b.mp4` });
  await rejects(deletePortfolioItem(w.deps, { userId: U1, itemId: evil.id }), "storage_remove_failed"); assert.deepEqual(w.removedLegacy, [`${U1}/a.mp4`]);
});

// ---------------------------------------------------------------- lost upload response: recoverUpload
const UP = "11111111-1111-4111-8111-111111111111";
const rec = (w, over = {}) => recoverUpload(w.deps, { userId: U1, folderId: FOLDER, uploadId: UP, ...over });
test("recovery: a COMPLETED upload is found by its upload tag and registered; the same attempt repeated returns the same item", async () => {
  const w = world(); w.file("file-aaaaaaaaaa", { appProperties: { portfolioUpload: UP } });
  const a = await rec(w); const b = await rec(w);
  assert.equal(a.fileId, "file-aaaaaaaaaa"); assert.equal(a.created, true); assert.equal(b.created, false); assert.equal(a.item.id, b.item.id);
  assert.equal(w.rows.length, 1); assert.deepEqual(w.trashed(), []);
});
test("recovery: an upload that never completed has no file, so the answer is a definite 'not found' (safe to upload again) and nothing is created", async () => {
  const w = world(); w.file("file-other00001", { appProperties: { portfolioUpload: "22222222-2222-4222-8222-222222222222" } });
  await rejects(rec(w), "upload_not_found", { status: 404, retryable: false });
  assert.equal(w.rows.length, 0); assert.deepEqual(w.trashed(), []);
});
test("recovery: only this folder's live files count; trashed, misplaced or ambiguous matches are never registered or trashed", async () => {
  const w = world();
  w.file("file-trashed0001", { appProperties: { portfolioUpload: UP }, trashed: true });
  await rejects(rec(w), "upload_not_found");
  w.drive.delete("file-trashed0001");
  w.deps.listUploads = async () => [{ id: "file-misplaced01", parents: ["elsewhere"] }];            // even if Drive returned it
  await rejects(rec(w), "upload_not_found");
  w.file("file-aaaaaaaaaa", { appProperties: { portfolioUpload: UP } }); w.file("file-bbbbbbbbbb", { appProperties: { portfolioUpload: UP } });
  w.deps.listUploads = async () => [...w.drive.values()];
  await rejects(rec(w), "ambiguous_upload", { status: 409 });
  assert.equal(w.rows.length, 0); assert.deepEqual(w.trashed(), []);
});
test("recovery re-validates the found file exactly like finalize (type/size/folder) and honours replacement", async () => {
  const w = world(); w.file("file-badbadbad1", { appProperties: { portfolioUpload: UP }, mimeType: "application/pdf" });
  await rejects(rec(w), "invalid_file"); assert.deepEqual(w.trashed(), ["file-badbadbad1"]);
  const w2 = world(); w2.file("file-oldoldold1"); w2.file("file-newnewnew1", { appProperties: { portfolioUpload: UP } });
  const old = w2.row({ drive_file_id: "file-oldoldold1" });
  const r = await rec(w2, { replaceItemId: old.id });
  assert.equal(r.item.id, old.id); assert.equal(r.item.drive_file_id, "file-newnewnew1"); assert.deepEqual(w2.trashed(), ["file-oldoldold1"]);
});
test("recovery: Drive outage is retryable; a bad upload id is rejected before any Drive call", async () => {
  const w = world(); w.listThrows = true;
  await rejects(rec(w), "drive_unavailable", { retryable: true, status: 502 });
  for (const bad of ["x", "../../etc", UP + "' or 1=1", null, 5]) await rejects(rec(w, { uploadId: bad }), "bad_request");
  assert.equal(w.log.filter((l) => l.startsWith("listUploads")).length, 1);
});
test("recovery is scoped to the caller: another user's tagged file in a different folder is not found, and a file registered to another user is a duplicate", async () => {
  const w = world(); w.file("file-theirs00001", { appProperties: { portfolioUpload: UP }, parents: ["their-folder"] });
  await rejects(rec(w), "upload_not_found");
  w.drive.get("file-theirs00001").parents = [FOLDER]; w.row({ user_id: U2, drive_file_id: "file-theirs00001" });
  await rejects(rec(w), "duplicate"); assert.deepEqual(w.trashed(), []);
});

// ---------------------------------------------------------------- database READ failures fail closed
test("a failed DB read is never mistaken for 'not registered' / 'target missing': nothing is trashed, replaced or duplicated, and it is retryable", async () => {
  const w = world(); w.file("file-oldoldold1"); w.file("file-newnewnew1"); w.file("file-badbadbad1", { mimeType: "application/pdf" });
  const old = w.row({ drive_file_id: "file-oldoldold1" });
  w.readThrows = true;
  await rejects(w.fin("file-newnewnew1", { replaceItemId: old.id }), "db_error", { retryable: true, fileId: "file-newnewnew1" });
  await rejects(w.fin("file-newnewnew1"), "db_error", { retryable: true });
  await rejects(w.fin("file-badbadbad1"), "db_error", { retryable: true });            // would otherwise have been trashed
  await rejects(w.up("file-newnewnew1"), "db_error", { retryable: true, fileId: "file-newnewnew1" });
  await rejects(deletePortfolioItem(w.deps, { userId: U1, itemId: old.id }), "db_error", { retryable: true });
  assert.deepEqual(w.trashed(), []); assert.equal(w.rows.length, 1); assert.equal(w.rows[0].drive_file_id, "file-oldoldold1");
  w.readThrows = false;                                                                // and the retry works
  assert.equal((await w.fin("file-newnewnew1", { replaceItemId: old.id })).item.id, old.id);
});
