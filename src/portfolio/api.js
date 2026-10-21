import { supabase, functionUrl } from "../supabaseClient";
import { uploadRoute } from "./logic.js";

// Portfolio media lives in a dedicated Google Drive folder. The browser never touches Drive credentials:
//   * small files  -> portfolio-drive (Edge Function) uploads them to Drive
//   * large files  -> portfolio-drive opens a Drive resumable session; the browser PUTs the bytes to it
//   * every upload is then verified IN Drive by portfolio-drive before it is recorded
// Rows are read with the normal Supabase client (RLS: owner only); title/caption/order edits are direct.

export class PortfolioError extends Error {
  constructor(message, code = "error") { super(message); this.name = "PortfolioError"; this.code = code; }
}

const unwrap = ({ data, error }) => { if (error) throw new PortfolioError(error.message, "db"); return data; };

async function bearer() {
  const { data } = await supabase.auth.getSession();
  if (!data?.session) throw new PortfolioError("You're signed out. Please sign in again.", "unauthenticated");
  return `Bearer ${data.session.access_token}`;
}
async function readResult(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new PortfolioError(body.error || `Request failed (HTTP ${res.status}).`, body.code || "error");
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
        try { const id = JSON.parse(xhr.responseText).id; return id ? resolve(id) : reject(new PortfolioError("Google Drive accepted the upload but returned no file id.", "drive_upload_failed")); }
        catch { return reject(new PortfolioError("Google Drive returned an unreadable response after the upload.", "drive_upload_failed")); }
      }
      reject(new PortfolioError(`Google Drive rejected the upload (HTTP ${xhr.status}).`, "drive_upload_failed"));
    };
    xhr.onerror = () => reject(new PortfolioError("The upload to Google Drive failed: network error, or the browser blocked the cross-origin request.", "drive_upload_network"));
    xhr.onabort = () => reject(new PortfolioError("The upload was cancelled.", "aborted"));
    xhr.send(file);
  });
}

// Uploads a file to the portfolio Drive folder and records it. Resolves to the saved row.
// `replaceItemId` swaps the media of an existing item (also used to migrate old-storage items to Drive).
export async function uploadMedia(file, { replaceItemId, onProgress } = {}) {
  if (uploadRoute(file) === "server") {
    const form = new FormData();
    form.append("action", "upload"); form.append("file", file);
    if (replaceItemId) form.append("replaceItemId", replaceItemId);
    return (await callDriveForm(form)).item;
  }
  const { uploadUrl } = await callDrive({ action: "init-upload", name: file.name, mimeType: file.type, size: file.size, replaceItemId });
  const fileId = await putToDrive(uploadUrl, file, onProgress);
  return (await callDrive({ action: "finalize", fileId, replaceItemId })).item;
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
