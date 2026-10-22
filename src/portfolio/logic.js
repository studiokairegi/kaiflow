// Pure portfolio helpers (no network): validation, upload routing, ordering, link URLs.
export const MAX_BYTES = 500 * 1024 * 1024;   // matches the bucket limit and the DB check
export const MAX_ITEMS = 50;                  // matches the DB trigger
export const VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime"];
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

export const kindFromMime = (mime) => (VIDEO_TYPES.includes(mime) ? "video" : IMAGE_TYPES.includes(mime) ? "image" : null);

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(1)} GB`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(v / 1024))} KB`;
}

// -> { ok: true, kind } | { ok: false, error }
export function validateFile(file, existingCount = 0) {
  if (existingCount >= MAX_ITEMS) return { ok: false, error: `A portfolio can hold up to ${MAX_ITEMS} items.` };
  const kind = kindFromMime(file?.type);
  if (!kind) return { ok: false, error: `${file?.name || "File"}: use MP4, WebM or MOV video, or JPG, PNG, WebP or GIF images.` };
  if (!(file.size > 0)) return { ok: false, error: `${file.name}: the file is empty.` };
  if (file.size > MAX_BYTES) return { ok: false, error: `${file.name} is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_BYTES)}.` };
  return { ok: true, kind };
}

// Small files go browser -> Edge Function -> Drive in one request (no dependency on Google's CORS);
// larger ones (reels) are PUT straight to a Drive resumable upload session. Mirrors the server constant.
export const SERVER_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const uploadRoute = (file) => (file.size <= SERVER_UPLOAD_MAX_BYTES ? "server" : "direct");

export const sortItems = (items) => [...items].sort((a, b) => (a.sort_order - b.sort_order) || String(a.created_at).localeCompare(String(b.created_at)));
export const nextSortOrder = (items) => (items.length ? Math.max(...items.map((i) => i.sort_order)) + 1 : 0);

// Move one item up/down and return the full list with dense sort_order 0..n-1.
export function moveItem(items, id, dir) {
  const list = sortItems(items);
  const i = list.findIndex((x) => x.id === id);
  const j = i + (dir === "up" ? -1 : 1);
  if (i < 0 || j < 0 || j >= list.length) return list.map((x, k) => ({ ...x, sort_order: k }));
  [list[i], list[j]] = [list[j], list[i]];
  return list.map((x, k) => ({ ...x, sort_order: k }));
}

export const isPortfolioToken = (s) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
export const portfolioUrl = (token, origin) => `${String(origin || "").replace(/\/+$/, "")}/portfolio/${token}`;
export function tokenFromPortfolioPath(pathname) {
  const m = /^\/portfolio\/([^/?#]+)\/?$/.exec(String(pathname || ""));
  return m ? m[1] : null;
}

export function linkStatus(link, now = Date.now()) {
  if (link.revoked_at) return "revoked";
  if (link.expires_at && new Date(link.expires_at).getTime() <= now) return "expired";
  return "active";
}

// ---- upload recovery -----------------------------------------------------------------------------------------
// A large upload is two steps: the bytes go to Drive, then the server REGISTERS the Drive file. If only the
// second step fails the file already sits in Drive, so the right recovery is to retry registration with the same
// Drive file id (the server verifies it again and is idempotent), never to upload the bytes a second time.
// Server errors carry `retryable`; a dropped connection is always worth retrying.
export const isRetryableFinalizeError = (e) => e?.retryable === true || e?.code === "network";

export const FINALIZE_RETRY_DELAYS_MS = [600, 2000];
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs `fn` (a finalize call), retrying retryable failures after the given delays. Resolves with fn's result or
// throws the LAST error. Non-retryable errors are thrown immediately. `sleep` is injectable for tests.
export async function withFinalizeRetry(fn, { delays = FINALIZE_RETRY_DELAYS_MS, sleep = realSleep, isRetryable = isRetryableFinalizeError } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(attempt); }
    catch (e) {
      if (attempt >= delays.length || !isRetryable(e)) throw e;
      await sleep(delays[attempt]);
    }
  }
}

// Message for "uploaded OK, but saving failed": tells the owner NOT to upload again.
export const finalizeFailureMessage = (name, cause) =>
  `${name || "The file"} reached Google Drive, but saving it to your portfolio failed${cause ? ` (${cause})` : ""}. Use “Retry saving” instead of uploading it again.`;

// Lost PUT response: Drive's file listing can lag the upload by a few seconds, so "not found" is retried for a while
// before concluding the upload never finished.
export const RECOVER_RETRY_DELAYS_MS = [1000, 3000, 6000];
export const unconfirmedUploadMessage = (name, cause) =>
  `${name || "The file"}: the upload to Google Drive may have finished, but the connection dropped before it could be confirmed${cause ? ` (${cause})` : ""}. Use “Check again” instead of uploading it again.`;

// ---- picking files + the upload loop --------------------------------------------------------------------------
// `input.files` is the input's OWN live FileList. Resetting the input (needed so choosing the same file again fires
// `change`) empties that list in place in Chromium/WebKit, so it must be COPIED first. Passing the FileList on and
// resetting afterwards silently uploads nothing. (File objects themselves survive the reset.)
export function takeFiles(input) {
  const files = Array.from(input?.files ?? []);
  if (input) input.value = "";
  return files;
}

// Errors whose recovery UI is the "Retry saving / Check again" banner, so they are not repeated in the failure list.
export const PENDING_ERROR_CODES = ["finalize_failed", "upload_unconfirmed"];

// Validates and uploads files one by one. Never throws: every outcome is returned as a user-visible message.
//   uploadOne(file, onProgress) performs one upload; describe(error) turns an error into text (and may record state).
export async function uploadBatch(files, { existingCount = 0, uploadOne, describe = (e) => e?.message || "Unknown error", onProgress } = {}) {
  const problems = []; const list = [...files]; let count = existingCount; let uploaded = 0;
  for (let n = 0; n < list.length; n++) {
    const f = list[n];
    const v = validateFile(f, count);
    if (!v.ok) { problems.push(v.error); continue; }
    const label = `Uploading ${n + 1} of ${list.length}: ${f.name}`;
    onProgress?.(label);
    try { await uploadOne(f, (p) => onProgress?.(`${label} (${Math.round(p * 100)}%)`)); count++; uploaded++; }
    catch (e) { const m = describe(e); if (!PENDING_ERROR_CODES.includes(e?.code)) problems.push(`${f.name}: ${m}`); }
  }
  return { problems, uploaded };
}
