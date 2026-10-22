// Registering an uploaded Drive file as a portfolio item, and deleting items, with safe cleanup rules.
// Pure: Drive and the database are injected (see `Deps`), so this is unit-tested with node. The Edge Function
// supplies the real implementations.
//
// Rules enforced here (each has a test):
//  * A client-supplied Drive file id is never trusted: on EVERY call the file is re-read from Drive and must
//    exist, not be trashed, sit in this user's portfolio folder, and be an allowed type and size.
//  * Registering is idempotent: the same file for the same user returns the existing item (no duplicate row).
//  * A Drive file is trashed only when it is provably ours to discard: in the portfolio folder, not registered
//    to ANY item, and never a "misplaced" file (outside the folder), which could be something else of the user's.
//  * The result of every trash/remove is checked. A failed cleanup is reported (warning / error), never ignored.
//  * Replacing never touches the old file until the replacement row is saved. Deleting never removes the row
//    while the Drive file is still live.
import { kindFromMime, MAX_BYTES, safeDriveName } from "./validate.ts";

export type DriveMeta = { id?: string; name?: string; mimeType?: string; size?: string; trashed?: boolean; parents?: string[] };
export type ItemRow = { id: string; user_id: string; drive_file_id: string | null; storage_path: string | null } & Record<string, unknown>;
export type DbError = { code?: string; message: string };
export type Media = { kind: "video" | "image"; mime_type: string; size_bytes: number; drive_file_id: string; storage_path: null };

export type Deps = {
  getMeta(fileId: string): Promise<DriveMeta | null>;       // null = 404; throws on other Drive failures
  listUploads?(folderId: string, uploadId: string): Promise<DriveMeta[]>;   // files tagged with this upload attempt
  trash(fileId: string): Promise<boolean>;
  store: {
    findByDriveFile(fileId: string): Promise<ItemRow | null>;                                  // across ALL users
    getOwned(userId: string, itemId: string): Promise<ItemRow | null>;
    insert(userId: string, media: Media, title: string): Promise<{ row?: ItemRow; error?: DbError }>;
    update(userId: string, itemId: string, media: Media): Promise<{ row?: ItemRow; error?: DbError }>;
    delete(userId: string, itemId: string): Promise<{ error?: DbError }>;
    removeLegacy(path: string): Promise<boolean>;
  };
};

export type Warning = { code: "old_file_cleanup_failed" | "legacy_cleanup_failed" | "replace_target_missing"; message: string };
const TARGET_MISSING: Warning = { code: "replace_target_missing", message: "The item you were replacing no longer exists, so the file was added to your portfolio as a new item instead." };
export type RegisterResult = { item: ItemRow; created: boolean; warnings: Warning[] };

export class RegisterError extends Error {
  status: number; code: string; retryable: boolean; fileId?: string;
  constructor(status: number, message: string, code: string, extra: { retryable?: boolean; fileId?: string } = {}) {
    super(message); this.status = status; this.code = code; this.retryable = !!extra.retryable; this.fileId = extra.fileId;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const present = (v: unknown) => v !== undefined && v !== null && v !== "";

// Store READS fail closed: a database error must never be mistaken for "not registered" (which could allow a
// cleanup trash) or "item not found" (which would add a new item instead of replacing). Retryable, file kept.
async function rd<T>(p: Promise<T>, fileId?: string): Promise<T> {
  try { return await p; }
  catch { throw new RegisterError(500, "Couldn't read your portfolio just now. Try again.", "db_error", { retryable: true, fileId }); }
}

// Trash a file and CONFIRM the outcome: true when it is trashed or already gone, false when it may still be live.
export async function trashConfirmed(deps: Deps, fileId: string): Promise<boolean> {
  if (await deps.trash(fileId)) return true;
  try { const m = await deps.getMeta(fileId); return !m || !!m.trashed; } catch { return false; }
}

// Trash a freshly uploaded file nobody references. Re-checks the registry first so a registered file is never trashed.
async function discard(deps: Deps, fileId: string): Promise<"trashed" | "kept_registered" | "failed"> {
  if (await rd(deps.store.findByDriveFile(fileId), fileId)) return "kept_registered";
  return (await trashConfirmed(deps, fileId)) ? "trashed" : "failed";
}

// mode "finalize": the browser holds the file id and can retry, so a transient failure NEVER trashes the file.
// mode "upload":   the server just created the file itself and returned no id to the browser, so a failed
//                  registration discards it (checked); if that cleanup fails the id is returned for a retry.
export async function registerDriveFile(deps: Deps, a: {
  userId: string; folderId: string; fileId: string; replaceItemId?: unknown; originalName?: string | null; mode: "finalize" | "upload";
}): Promise<RegisterResult> {
  const { userId, folderId, fileId, mode } = a;
  const replacing = present(a.replaceItemId);
  if (replacing && (typeof a.replaceItemId !== "string" || !UUID.test(a.replaceItemId))) throw new RegisterError(400, "Invalid item to replace.", "bad_request");

  let meta: DriveMeta | null;
  try { meta = await deps.getMeta(fileId); }
  catch { throw new RegisterError(502, "Couldn't check the file in Google Drive. Try again in a moment.", "drive_unavailable", { retryable: true, fileId }); }
  if (!meta) throw new RegisterError(422, "Google Drive has no such file yet. The upload may not have finished.", "drive_file_missing", { retryable: true, fileId });
  if (meta.trashed) throw new RegisterError(422, "That file is in the Drive trash.", "drive_file_missing");
  // Misplaced file: never trashed here. It is not provably ours and may be another file of the user's.
  if (!meta.parents?.includes(folderId)) throw new RegisterError(422, "That file isn't in your portfolio folder.", "drive_file_foreign");

  const existing = await rd(deps.store.findByDriveFile(fileId), fileId);
  const kind = kindFromMime(meta.mimeType || "");
  const size = Number(meta.size);
  if (!kind || !(size > 0) || size > MAX_BYTES) {
    const why = !kind ? "Unsupported file type." : "The uploaded file is empty or too large.";
    if (existing) throw new RegisterError(422, why, "invalid_file");                       // registered: leave it alone
    const out = await discard(deps, fileId);
    throw new RegisterError(422, out === "failed" ? `${why} It also couldn't be removed from your portfolio folder in Google Drive; delete it there manually.` : why, "invalid_file",
      out === "failed" ? { fileId } : {});
  }

  const media: Media = { kind, mime_type: meta.mimeType!, size_bytes: size, drive_file_id: fileId, storage_path: null };

  // Idempotency: this exact file is already registered.
  if (existing) {
    if (existing.user_id !== userId) throw new RegisterError(409, "That file was already added.", "duplicate");
    if (!replacing || existing.id === a.replaceItemId) return { item: existing, created: false, warnings: [] };
    // Retry after "replacement target vanished, so it was added as a new item": the target is still gone -> same outcome.
    const target = await rd(deps.store.getOwned(userId, a.replaceItemId as string), fileId);
    if (!target || target.user_id !== userId) return { item: existing, created: false, warnings: [TARGET_MISSING] };
    throw new RegisterError(409, "That file is already used by another portfolio item.", "duplicate");
  }

  // A failure while saving the row. Decide what happens to the (valid, unregistered) Drive file.
  const failSave = async (error: DbError): Promise<RegisterResult> => {
    if (error.code === "23505") {                                                          // lost a race with a concurrent finalize
      const now = await rd(deps.store.findByDriveFile(fileId), fileId);
      if (now && now.user_id === userId && (!replacing || now.id === a.replaceItemId)) return { item: now, created: false, warnings: [] };
      throw new RegisterError(409, "That file was already added.", "duplicate");
    }
    const limit = error.code === "P0001";
    const message = limit ? error.message : "Couldn't save the portfolio item. Try again.";
    if (mode === "finalize") throw new RegisterError(limit ? 409 : 500, message, limit ? "limit_reached" : "db_error", { retryable: true, fileId });
    const out = await discard(deps, fileId);
    throw new RegisterError(limit ? 409 : 500, message, limit ? "limit_reached" : "db_error", out === "failed" ? { retryable: true, fileId } : {});
  };

  {
    // Replacement target: it can disappear while a large upload is in flight (deleted in another tab, etc.).
    // The upload is valid and the owner clearly wanted this media in the portfolio, so it is added as a NEW item
    // and the owner is told. It is neither silently orphaned nor discarded. (A foreign item id is treated the
    // same way and nothing about it is revealed; the other user's item is never touched.)
    let old: ItemRow | null = null;
    if (replacing) {
      old = await rd(deps.store.getOwned(userId, a.replaceItemId as string), fileId);
      if (old && old.user_id !== userId) old = null;
    }
    const missing: Warning[] = replacing && !old ? [TARGET_MISSING] : [];
    if (old) {
      const oldDriveId = old.drive_file_id; const oldPath = old.storage_path;          // captured BEFORE the swap
      const { row, error } = await deps.store.update(userId, old.id, media);
      if (error || !row) return await failSave(error ?? { message: "no row returned" });
      const warnings: Warning[] = [];
      // Only now that the replacement is saved is the previous media cleaned up (and the result checked).
      if (oldDriveId && oldDriveId !== fileId) {
        if (!(await trashConfirmed(deps, oldDriveId))) warnings.push({ code: "old_file_cleanup_failed", message: "The new file was saved, but the previous file couldn't be moved to the Google Drive trash. Delete it from the “StudioKairegi Portfolio” folder in Drive." });
      } else if (!oldDriveId && oldPath) {
        if (!oldPath.startsWith(`${userId}/`) || !(await deps.store.removeLegacy(oldPath))) warnings.push({ code: "legacy_cleanup_failed", message: "The file was moved to Google Drive, but the old copy couldn't be removed from the legacy storage." });
      }
      return { item: row, created: false, warnings };
    }
    const title = safeDriveName(a.originalName ?? meta.name ?? "").replace(/\.[^.]+$/, "").slice(0, 120);
    const { row, error } = await deps.store.insert(userId, media, title);
    if (error || !row) return await failSave(error ?? { message: "no row returned" });
    return { item: row, created: true, warnings: missing };
  }
}

// Recovers an upload whose browser response was lost (the PUT may or may not have completed). Every upload
// session is tagged server-side with an `uploadId`; the completed file is looked up by that tag in the user's
// own portfolio folder and then registered through the SAME verified, idempotent path as a normal finalize.
// A file that never completed does not exist in Drive, so "not found" means it is safe to upload again.
export async function recoverUpload(deps: Deps, a: { userId: string; folderId: string; uploadId: unknown; replaceItemId?: unknown }): Promise<RegisterResult & { fileId: string }> {
  if (typeof a.uploadId !== "string" || !UUID.test(a.uploadId) || !deps.listUploads) throw new RegisterError(400, "Invalid upload.", "bad_request");
  let found: DriveMeta[];
  try { found = await deps.listUploads(a.folderId, a.uploadId); }
  catch { throw new RegisterError(502, "Couldn't check Google Drive for the upload. Try again in a moment.", "drive_unavailable", { retryable: true }); }
  found = found.filter((f) => f.id && !f.trashed && f.parents?.includes(a.folderId));
  if (found.length === 0) throw new RegisterError(404, "No completed upload was found for this attempt. It did not finish, so nothing was saved and it is safe to upload the file again.", "upload_not_found");
  if (found.length > 1) throw new RegisterError(409, "More than one file matches this upload. Open the portfolio folder in Google Drive to review them.", "ambiguous_upload");
  const fileId = found[0].id!;
  const r = await registerDriveFile(deps, { userId: a.userId, folderId: a.folderId, fileId, replaceItemId: a.replaceItemId, originalName: null, mode: "finalize" });
  return { ...r, fileId };
}

// Delete: the row is removed only after the file is confirmed trashed/gone, so a failed trash leaves a row the
// owner can retry (instead of an untracked file left behind in Drive). Ownership is enforced by the lookup.
export async function deletePortfolioItem(deps: Deps, a: { userId: string; itemId: unknown }): Promise<void> {
  if (typeof a.itemId !== "string" || !UUID.test(a.itemId)) throw new RegisterError(400, "Missing item.", "bad_request");
  const item = await rd(deps.store.getOwned(a.userId, a.itemId));
  if (!item || item.user_id !== a.userId) throw new RegisterError(404, "Portfolio item not found.", "not_found");
  if (item.drive_file_id) {
    if (!(await trashConfirmed(deps, item.drive_file_id))) throw new RegisterError(502, "Couldn't move the file to the Google Drive trash, so nothing was deleted. Try again.", "drive_trash_failed", { retryable: true });
  } else if (item.storage_path) {
    if (!item.storage_path.startsWith(`${a.userId}/`) || !(await deps.store.removeLegacy(item.storage_path))) throw new RegisterError(502, "Couldn't remove the old stored file, so nothing was deleted. Try again.", "storage_remove_failed", { retryable: true });
  }
  const { error } = await deps.store.delete(a.userId, item.id);
  if (error) throw new RegisterError(500, "The file was moved to the trash but the item couldn't be removed. Press delete again to finish.", "db_error", { retryable: true });
}
