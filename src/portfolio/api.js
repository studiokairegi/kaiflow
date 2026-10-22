import { supabase, functionUrl } from "../supabaseClient";
import { finalizeFailureMessage, isRetryableFinalizeError, RECOVER_RETRY_DELAYS_MS, unconfirmedUploadMessage, uploadRoute, withFinalizeRetry } from "./logic.js";

// Portfolio media lives in a dedicated Google Drive folder. The browser never touches Drive credentials:
//   * small files  -> portfolio-drive (Edge Function) uploads them to Drive
//   * large files  -> portfolio-drive opens a Drive resumable session; the browser PUTs the bytes to it
//   * every upload is then verified IN Drive by portfolio-drive before it is recorded
// Rows are read with the normal Supabase client (RLS: owner only); title/caption/order edits are direct.

// `code` says what went wrong. Upload stages: "drive_upload_failed" / "drive_upload_network" (bytes never reached
// Drive: safe to upload again) vs "finalize_failed" (bytes ARE in Drive; carries `fileId` so saving can be retried
// without re-uploading). `retryable` comes from the server.
export class PortfolioError extends Error {
  constructor(message, code = "error", extra = {}) {
    super(message); this.name = "PortfolioError"; this.code = code;
    this.retryable = extra.retryable === true; this.fileId = extra.fileId; this.replaceItemId = extra.replaceItemId; this.fileName = extra.fileName;
    this.uploadId = extra.uploadId; this.ambiguous = extra.ambiguous === true;   // ambiguous: the PUT may have completed although its response was lost
  }
}

const unwrap = ({ data, error }) => { if (error) throw new PortfolioError(error.message, "db"); return data; };

async function bearer() {
  const { data } = await supabase.auth.getSession();
  if (!data?.session) throw new PortfolioError("You're signed out. Please sign in again.", "unauthenticated");
  return `Bearer ${data.session.access_token}`;
}
async function readResult(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new PortfolioError(body.error || `Request failed (HTTP ${res.status}).`, body.code || "error", { retryable: body.retryable === true || (res.status >= 502 && res.status <= 504), fileId: body.fileId });
  return body;
}
async function callDrive(payload) {
  const res = await fetch(functionUrl("portfolio-drive"), { method: "POST", headers: { Authorization: await bearer(), "Content-Type": "application/json" }, body: JSON.stringify(payload) })
    .catch(() => { throw new PortfolioError("Couldn't reach the server. Check your connection and try again.", "network"); });
  return readResult(res);
}
async function callDriveForm(form) {
  const res = await fetch(functionUrl("portfolio-drive"), { method: "POST", headers: { Authorization: await bearer() }, body: form })
    .catch(() => { throw new PortfolioError("Couldn't reach the server. Check your connection and try again.", "network"); });
  return readResult(res);
}

export async function listItems() {
  return unwrap(await supabase.from("portfolio_items").select("*").order("sort_order", { ascending: true }).order("created_at", { ascending: true }));
}
export async function listLinks() {
  return unwrap(await supabase.from("portfolio_links").select("*").order("created_at", { ascending: false }));
}

// Owner previews: { itemId: url } of short-lived media URLs.
export async function previewUrls() { return (await callDrive({ action: "previews" })).urls || {}; }
// Drive health of every item: [{ id, status: ok|missing|trashed|moved|legacy|error, detail }].
export async function verifyItems() { return (await callDrive({ action: "verify" })).items || []; }

// PUT the bytes to a Drive resumable session. XHR (not fetch) so the owner sees real upload progress.
function putToDrive(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status === 200 || xhr.status === 201) {
        try { const id = JSON.parse(xhr.responseText).id; return id ? resolve(id) : reject(new PortfolioError("Google Drive accepted the upload but returned no file id.", "drive_upload_failed", { ambiguous: true })); }
        catch { return reject(new PortfolioError("Google Drive returned an unreadable response after the upload.", "drive_upload_failed", { ambiguous: true })); }
      }
      reject(new PortfolioError(`Google Drive rejected the upload (HTTP ${xhr.status}).`, "drive_upload_failed", { ambiguous: xhr.status >= 500 }));   // 4xx: definitely not stored
    };
    xhr.onerror = () => reject(new PortfolioError("The upload to Google Drive failed: network error, or the browser blocked the cross-origin request.", "drive_upload_network", { ambiguous: true }));
    xhr.onabort = () => reject(new PortfolioError("The upload was cancelled.", "aborted"));
    xhr.send(file);
  });
}

// Registers a Drive file that is already uploaded. Idempotent on the server, so it is safe to call again after
// any failure: the same file never becomes two items. Resolves to the saved row.
export async function finalizeUpload({ fileId, replaceItemId, fileName } = {}, { onWarning, retryDelays } = {}) {
  try {
    const r = await withFinalizeRetry(() => callDrive({ action: "finalize", fileId, replaceItemId }), retryDelays ? { delays: retryDelays } : undefined);
    if (r.warnings?.length) onWarning?.(r.warnings.map((w) => w.message));
    return r.item;
  } catch (e) {
    throw new PortfolioError(finalizeFailureMessage(fileName, e.message), "finalize_failed",
      { retryable: isRetryableFinalizeError(e), fileId, replaceItemId, fileName });
  }
}

// Id of the signed-in user (used only to scope browser-local state such as unfinished uploads).
export async function currentUserId() {
  const { data } = await supabase.auth.getSession();
  return data?.session?.user?.id ?? null;
}

// Recovers an upload whose PUT response was lost. The server tagged the Drive file with `uploadId`, so a COMPLETED
// upload is found (and registered, idempotently) without re-uploading. "Not found" after the retries means the
// upload never completed, so nothing exists in Drive and uploading again cannot duplicate anything.
export async function recoverUpload({ uploadId, replaceItemId, fileName } = {}, { onWarning, retryDelays } = {}) {
  try {
    const r = await withFinalizeRetry(() => callDrive({ action: "recover-upload", uploadId, replaceItemId }),
      { delays: retryDelays ?? RECOVER_RETRY_DELAYS_MS, isRetryable: (e) => isRetryableFinalizeError(e) || e.code === "upload_not_found" });
    if (r.warnings?.length) onWarning?.(r.warnings.map((w) => w.message));
    return r.item;
  } catch (e) {
    if (e.code === "upload_not_found") throw new PortfolioError(`${fileName || "The file"} didn't finish uploading to Google Drive, so nothing was saved. Please upload it again.`, "drive_upload_network");
    if (e.fileId || e.code === "finalize_failed" || e.code === "ambiguous_upload" || e.code === "bad_request") throw e;
    throw new PortfolioError(unconfirmedUploadMessage(fileName, e.message), "upload_unconfirmed", { retryable: true, uploadId, replaceItemId, fileName });
  }
}

// Uploads a file to the portfolio Drive folder and records it. Resolves to the saved row.
// `replaceItemId` swaps the media of an existing item (also used to migrate old-storage items to Drive).
// If the bytes reached Drive but saving failed, throws PortfolioError code "finalize_failed" carrying `fileId`:
// call finalizeUpload() with it to retry; do NOT upload again (that would create a second Drive file).
export async function uploadMedia(file, { replaceItemId, onProgress, onWarning, retryDelays } = {}) {
  if (uploadRoute(file) === "server") {
    const form = new FormData();
    form.append("action", "upload"); form.append("file", file);
    if (replaceItemId) form.append("replaceItemId", replaceItemId);
    try {
      const r = await callDriveForm(form);
      if (r.warnings?.length) onWarning?.(r.warnings.map((w) => w.message));
      return r.item;
    } catch (e) {
      // The server only reports a file id when its own cleanup failed and the file is still in Drive.
      if (e.fileId && e.retryable) throw new PortfolioError(finalizeFailureMessage(file.name, e.message), "finalize_failed", { retryable: true, fileId: e.fileId, replaceItemId, fileName: file.name });
      throw e;
    }
  }
  const { uploadUrl, uploadId } = await callDrive({ action: "init-upload", name: file.name, mimeType: file.type, size: file.size, replaceItemId });
  let fileId;
  try { fileId = await putToDrive(uploadUrl, file, onProgress); }
  catch (e) {
    if (!e.ambiguous || !uploadId) throw e;                      // definite failure (or an older server): nothing to recover
    return recoverUpload({ uploadId, replaceItemId, fileName: file.name }, { onWarning, retryDelays });
  }
  return finalizeUpload({ fileId, replaceItemId, fileName: file.name }, { onWarning, retryDelays });
}

export async function updateItem(id, patch) {
  unwrap(await supabase.from("portfolio_items").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).select("id"));
}
export async function saveOrder(items) {
  await Promise.all(items.map((i) => supabase.from("portfolio_items").update({ sort_order: i.sort_order }).eq("id", i.id).select("id").then(unwrap)));
}
export async function deleteItem(item) { await callDrive({ action: "delete", itemId: item.id }); }

export async function createLink(label, expiresDays) {
  const r = unwrap(await supabase.rpc("portfolio_create_link", { p_label: label || "", p_expires_days: expiresDays ?? null }));
  return Array.isArray(r) ? r[0] : r;
}
export async function revokeLink(id) { unwrap(await supabase.rpc("portfolio_revoke_link", { p_link: id })); }

// PUBLIC: what the /portfolio/{token} page calls. null => invalid, expired or revoked.
export async function fetchPublicPortfolio(token) {
  const res = await fetch(functionUrl("portfolio-view"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
  if (res.status === 404) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new PortfolioError(body.error || "Couldn't load the portfolio.", body.code || "error");
  return body;
}
