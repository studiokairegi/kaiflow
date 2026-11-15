/** Browser-side direct-to-Drive transfer shared by freelancer and Final QC uploads.
 * The app server only creates the private Drive session and finalizes metadata.
 *
 * Recovery design (in order of authority):
 *  1. The Drive resumable *session* itself. A status query on the session URI answers
 *     "complete (here is the file id)", "N bytes received" or "gone" without any of the
 *     eventual-consistency lag that Drive file listings have.
 *  2. A Drive listing by the private upload-id app property, retried with bounded backoff
 *     (1s, 3s, 6s) because listings can trail a completed upload.
 *  3. Only when both say the upload never happened is a new session opened.
 * Recovery state (upload id, file fingerprint, session URI, file id, md5) is persisted in
 * localStorage so it survives refresh/close.
 *
 * Identity vs. integrity:
 *  - The sampled *fingerprint* is a cheap identity key (which pending upload does this file belong to).
 *  - A streamed *full-content MD5* is the integrity proof: it is computed while the bytes upload (so it
 *    adds no wall-clock time on a normal connection) and the server compares it with Drive's own
 *    `md5Checksum` before anything is registered. A file edited in bytes the fingerprint never samples
 *    therefore can no longer be registered under another file's upload.
 */
import { md5Blob, sha256Bytes } from "./uploadHash.js";

export class ResumableDriveUploadError extends Error {
  constructor(message, code = "upload_error", options = {}) {
    super(message);
    this.name = "ResumableDriveUploadError";
    this.code = code;
    this.status = options.status;
    this.ambiguous = options.ambiguous === true;
  }
}

export const RECOVERY_DELAYS_MS = [1000, 3000, 6000];
const PUT_RETRY_DELAYS_MS = [1000, 3000, 6000];
const PENDING_TTL_MS = 6 * 24 * 60 * 60 * 1000; // Drive sessions live ~7 days; expire a day early.
const SAMPLE_BYTES = 256 * 1024;
const SAMPLE_COUNT = 8;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- file identity

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Content fingerprint: SHA-256 over name + size + lastModified + head + tail + evenly spaced samples.
 * name/size/lastModified alone cannot tell two different exports apart; hashing a multi-GB
 * file in the browser is too slow, so we hash ~2.5 MB spread across the whole file.
 */
export async function fingerprintFile(file, subtle = globalThis.crypto?.subtle) {
  const size = file.size;
  const offsets = new Set([0, Math.max(0, size - SAMPLE_BYTES)]);
  for (let i = 1; i <= SAMPLE_COUNT; i++) offsets.add(Math.floor(((size - SAMPLE_BYTES) * i) / (SAMPLE_COUNT + 1)));
  // name + lastModified are included on purpose: they can only make a match stricter (never conflate two exports).
  const parts = [new TextEncoder().encode(`size:${size};name:${file.name};mtime:${file.lastModified ?? ""};`)];
  for (const offset of [...offsets].filter((o) => o >= 0).sort((a, b) => a - b)) {
    parts.push(new TextEncoder().encode(`@${offset};`));
    parts.push(new Uint8Array(await file.slice(offset, Math.min(size, offset + SAMPLE_BYTES)).arrayBuffer()));
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { joined.set(p, at); at += p.length; }
  // crypto.subtle only exists in secure contexts (https/localhost); fall back to the pure-JS digest instead of failing every upload.
  if (!subtle?.digest) return sha256Bytes(joined);
  return toHex(await subtle.digest("SHA-256", joined));
}

/** crypto.randomUUID is also secure-context only; fall back to getRandomValues, then Math.random as a last resort. */
export function newUploadId() {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof c?.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------- persisted recovery state

function defaultStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

export function pendingStorageKey(scope) {
  return `kairflow.pendingUpload.${scope}`;
}

function readAll(storage, storageKey) {
  try {
    const parsed = JSON.parse(storage?.getItem(storageKey) || "{}");
    const now = Date.now();
    const live = {};
    for (const [fp, entry] of Object.entries(parsed || {})) {
      if (entry && typeof entry.uploadId === "string" && now - (entry.createdAt || 0) < PENDING_TTL_MS) live[fp] = entry;
    }
    return live;
  } catch { return {}; }
}

function writeAll(storage, storageKey, all) {
  try {
    if (Object.keys(all).length === 0) storage?.removeItem(storageKey);
    else storage?.setItem(storageKey, JSON.stringify(all));
  } catch { /* storage unavailable (private window/quota): recovery degrades to in-memory only. */ }
}

export function loadPendingUpload(storageKey, fingerprint, storage = defaultStorage()) {
  return readAll(storage, storageKey)[fingerprint] || null;
}

function savePending(storage, storageKey, fingerprint, entry) {
  const all = readAll(storage, storageKey);
  all[fingerprint] = entry;
  writeAll(storage, storageKey, all);
}

export function clearPendingUpload(storageKey, fingerprint, storage = defaultStorage()) {
  const all = readAll(storage, storageKey);
  delete all[fingerprint];
  writeAll(storage, storageKey, all);
}

// ------------------------------------------------------------- Drive session I/O

function parseFileId(text) {
  try { return JSON.parse(text).id || null; } catch { return null; }
}

function driveXhr({ method = "PUT", url, headers = {}, body, onProgress }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    if (onProgress) xhr.upload.onprogress = onProgress;
    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText, range: xhr.getResponseHeader?.("Range") || null });
    xhr.onerror = () => reject(new ResumableDriveUploadError("The connection was interrupted during upload.", "ambiguous_upload", { ambiguous: true }));
    xhr.onabort = () => reject(new ResumableDriveUploadError("Upload cancelled.", "aborted"));
    xhr.send(body);
  });
}

/** Sends bytes [offset, size) to the session. Resolves with the Drive file id. */
async function putToDrive(uploadUrl, file, offset, onProgress) {
  const headers = { "Content-Type": file.type || "application/octet-stream" };
  if (offset > 0) headers["Content-Range"] = `bytes ${offset}-${file.size - 1}/${file.size}`;
  const res = await driveXhr({
    url: uploadUrl,
    headers,
    body: offset > 0 ? file.slice(offset) : file,
    onProgress: (event) => {
      if (event.lengthComputable) onProgress?.(Math.min(100, Math.round(((offset + event.loaded) / file.size) * 100)));
    },
  });
  if (res.status === 200 || res.status === 201) {
    const fileId = parseFileId(res.text);
    if (fileId) return fileId;
    throw new ResumableDriveUploadError("Google Drive accepted the upload but its response could not be read.", "ambiguous_upload", { ambiguous: true });
  }
  if (res.status === 404 || res.status === 410) throw new ResumableDriveUploadError("The Google Drive upload session expired.", "session_gone");
  throw new ResumableDriveUploadError(`Google Drive rejected the upload (HTTP ${res.status}).`, "drive_upload_failed", { ambiguous: res.status >= 500 || res.status === 308 });
}

/**
 * Asks Drive how much of the session it has. Authoritative and not subject to listing lag.
 * Resolves { state: "complete", fileId } | { state: "partial", offset } | { state: "gone" }.
 * Throws an ambiguous error when Drive cannot be reached or answers unexpectedly.
 */
export async function queryDriveSession(uploadUrl, size) {
  const res = await driveXhr({ url: uploadUrl, headers: { "Content-Range": `bytes */${size}` } });
  if (res.status === 200 || res.status === 201) {
    const fileId = parseFileId(res.text);
    if (fileId) return { state: "complete", fileId };
    throw new ResumableDriveUploadError("Google Drive reported the upload complete but did not return a file id.", "ambiguous_upload", { ambiguous: true });
  }
  if (res.status === 308) {
    const match = /bytes=0-(\d+)/.exec(res.range || "");
    return { state: "partial", offset: match ? Number(match[1]) + 1 : 0 };
  }
  if (res.status === 404 || res.status === 410) return { state: "gone" };
  throw new ResumableDriveUploadError(`Could not check the Google Drive upload (HTTP ${res.status}).`, "ambiguous_upload", { ambiguous: true });
}

/** `headers` may be an object or an (async) function: the function form is evaluated for EVERY request so a long
 * transfer never finalizes with a stale auth token. */
async function resolveHeaders(headers) {
  if (typeof headers !== "function") return headers || {};
  try { return (await headers()) || {}; } catch (error) {
    throw new ResumableDriveUploadError(error?.message || "Please sign in again.", "auth_required", { status: 401 });
  }
}

async function postJson(url, headers, payload) {
  const resolved = await resolveHeaders(headers);
  const response = await fetch(url, {
    method: "POST",
    headers: { ...resolved, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => { throw new ResumableDriveUploadError("Couldn't reach the upload service. Check your connection and retry.", "network", { ambiguous: true }); });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new ResumableDriveUploadError(result.error || `Upload request failed (HTTP ${response.status}).`, result.code || "server_error", { ambiguous: result.code === "ambiguous_upload", status: response.status });
  return result;
}

// ------------------------------------------------------------------- main flow

const DEFINITIVE_REJECTIONS = new Set(["file_mismatch", "invalid_file"]);

/**
 * Uploads `file` straight to Google Drive and finalizes it server-side, idempotently.
 *
 * `headers` is an object or an (async) function returning one; the function form is called for every
 * request so long transfers never finalize with an expired token. `storageKey` scopes the persisted
 * recovery state (e.g. per share token / per shot); when omitted nothing is persisted. `uploadId` is only
 * used for a file with no persisted state; a persisted id for the same content fingerprint always wins so
 * a reload resumes the original upload. `onStatus(phase, detail)` reports "preparing" | "checking" |
 * "uploading" | "verifying" (detail = 0-100) | "finalizing" so the UI never sits silent during recovery.
 * The resolved value always carries `uploadId`.
 */
export async function uploadResumableDriveFile({
  url, headers = {}, actionPayload, file, uploadId, storageKey, onProgress, onStatus,
  storage = defaultStorage(), sleep = defaultSleep, recoveryDelays = RECOVERY_DELAYS_MS, putRetryDelays = PUT_RETRY_DELAYS_MS,
  fingerprint: providedFingerprint, hashFile = md5Blob, locks = globalThis.navigator?.locks,
}) {
  const status = (phase, detail) => { try { onStatus?.(phase, detail); } catch { /* UI callback errors must never break an upload */ } };
  status("preparing");
  const fingerprint = providedFingerprint || await fingerprintFile(file);
  const persist = !!storageKey;

  // Two tabs holding the same file would each open a Drive session before either persisted state (duplicates).
  // The Web Locks API serializes them per storage scope + content; browsers without it keep the old behaviour.
  if (persist && typeof locks?.request === "function") {
    return locks.request(`kairflow.upload.${storageKey}.${fingerprint}`, { ifAvailable: true }, async (lock) => {
      if (!lock) throw new ResumableDriveUploadError("This file is already uploading in another tab or window. Let that one finish (or close it) and try again.", "upload_in_progress");
      return runUpload();
    });
  }
  return runUpload();

  async function runUpload() {
    const mimeType = file.type || "application/octet-stream";
    const pending = persist ? loadPendingUpload(storageKey, fingerprint, storage) : null;
    const resumedPrior = !!pending;
    const id = pending?.uploadId || uploadId || newUploadId();
    const state = pending || { uploadId: id, name: file.name, size: file.size, createdAt: Date.now(), sessionUri: null, fileId: null, md5: null };
    let finished = false;
    const remember = (patch) => {
      Object.assign(state, patch);
      if (persist && !finished) savePending(storage, storageKey, fingerprint, state);
    };
    const forget = () => { if (persist) clearPendingUpload(storageKey, fingerprint, storage); };
    remember({});

    const base = { ...actionPayload, uploadId: id, uploadKey: id, name: file.name, mimeType, size: file.size, fingerprint };
    const withId = (result) => ({ ...result, uploadId: id });
    const done = (result) => { forget(); return withId(result); };

    // ---- full-content MD5: started when bytes start flowing, awaited only when something must be registered.
    let md5Promise = null;
    let reportHash = null;
    let lastHashPct = 0;
    const startMd5 = () => {
      if (state.md5) return Promise.resolve(state.md5);
      if (!md5Promise) {
        md5Promise = Promise.resolve(hashFile(file, { isCancelled: () => finished, onProgress: (pct) => { lastHashPct = pct; reportHash?.(pct); } }))
          .then((hex) => { if (hex && !finished) remember({ md5: hex }); return hex; });
        md5Promise.catch(() => {}); // surfaced by getMd5() if/when it is actually needed
      }
      return md5Promise;
    };
    const getMd5 = async () => {
      if (state.md5) return state.md5;
      reportHash = (pct) => status("verifying", pct);
      status("verifying", lastHashPct);
      const hex = await startMd5();
      reportHash = null;
      if (!hex) throw new ResumableDriveUploadError("Couldn't read the file to verify it. Select it again and retry.", "hash_failed");
      return hex;
    };

    // Drive can take a moment to publish md5Checksum for a just-completed file; the server answers 503 checksum_pending.
    const withChecksumRetry = async (fn) => {
      for (let attempt = 0; ; attempt++) {
        try { return await fn(); } catch (error) {
          if (error.code !== "checksum_pending" || attempt >= recoveryDelays.length) throw error;
          await sleep(recoveryDelays[attempt]);
        }
      }
    };

    const recoverOnce = async () => {
      const attempt = () => withChecksumRetry(() => postJson(url, headers, { ...base, action: "recover-upload", ...(state.md5 ? { md5: state.md5 } : {}) }));
      try {
        let recovered;
        try { recovered = await attempt(); } catch (error) {
          if (error.code !== "md5_required") throw error;
          await getMd5(); // a candidate file exists in Drive: now (and only now) pay for the full read
          recovered = await attempt();
        }
        return recovered.success || recovered.versionId || recovered.fileId ? recovered : null;
      } catch (error) {
        if (error.code === "upload_not_found") return null;
        if (DEFINITIVE_REJECTIONS.has(error.code)) forget();
        throw error;
      }
    };
    // Drive listings can lag a completed upload: retry with bounded backoff before saying "missing".
    const recoverWithBackoff = async () => {
      let found = await recoverOnce();
      for (let i = 0; i < recoveryDelays.length; i++) {
        if (found) return found;
        status("checking", { attempt: i + 1, of: recoveryDelays.length });
        await sleep(recoveryDelays[i]);
        found = await recoverOnce();
      }
      return found;
    };
    // A definitive rejection of this exact file (422 validation, wrong/mismatched file) will never succeed on
    // retry, so drop the saved state; otherwise re-selecting the same file would loop on the rejected Drive file.
    const finalize = async (fileId) => {
      const md5 = await getMd5(); // may report "verifying" while the background hash is still running
      status("finalizing");
      try { return await withChecksumRetry(() => postJson(url, headers, { ...base, action: "finalize", fileId, md5 })); } catch (error) {
        if (error.status === 422 || DEFINITIVE_REJECTIONS.has(error.code)) forget();
        throw error;
      }
    };
    const finishRecovered = async (recovered) => {
      // recover-upload registers the file itself; if it only returned an id, finalize it.
      if (recovered.success || recovered.versionId) return done(recovered);
      return done(await finalize(recovered.fileId));
    };

    try {
      // 0. Registration previously failed after Drive completed: just finalize again.
      if (state.fileId) return done(await finalize(state.fileId));

      // 1. Continue/complete an existing Drive session (authoritative, no listing lag).
      let fileId = null;
      if (state.sessionUri) {
        status("checking");
        try {
          const sessionStatus = await queryDriveSession(state.sessionUri, file.size);
          if (sessionStatus.state === "complete") fileId = sessionStatus.fileId;
          else if (sessionStatus.state === "partial") { startMd5(); fileId = await sendWithRetry(state.sessionUri, sessionStatus.offset); }
          else remember({ sessionUri: null });
        } catch (error) {
          if (error.code === "session_gone") remember({ sessionUri: null });
          else if (!error.ambiguous) throw error;
          // ambiguous: fall through to the listing check below before opening anything new.
        }
      }

      // 2. Ask the server whether Drive already holds this upload (retry with backoff after a prior attempt).
      if (!fileId) {
        if (resumedPrior || state.sessionUri) status("checking");
        const recovered = (resumedPrior || state.sessionUri) ? await recoverWithBackoff() : await recoverOnce();
        if (recovered) return await finishRecovered(recovered);
      }

      // 3. Nothing exists in Drive: open a new session unless the old one is still usable.
      if (!fileId) {
        if (state.sessionUri) {
          // Session exists but its status could not be read and Drive shows no file: do not open
          // a second session (that is how duplicates appear). Ask the user to retry.
          throw new ResumableDriveUploadError("We couldn't confirm whether Google Drive received the file. Please retry; if it already arrived it will not be uploaded twice.", "upload_uncertain", { ambiguous: true });
        }
        const init = await postJson(url, headers, { ...base, action: "init-upload" });
        if (!init.uploadUrl) throw new ResumableDriveUploadError("The upload service did not return a Google Drive upload session. If this keeps happening the upload service may be mid-update: refresh the page in a minute and retry.", "invalid_session");
        remember({ sessionUri: init.uploadUrl });
        startMd5();
        fileId = await sendWithRetry(init.uploadUrl, 0);
      }

      remember({ fileId });
      return done(await finalize(fileId));
    } finally {
      finished = true; // stops a still-running background hash and prevents it from re-persisting state
    }

    /** PUT the remaining bytes; on an ambiguous failure ask the session (not the listing) what Drive has. */
    async function sendWithRetry(sessionUri, startOffset) {
      status("uploading");
      let offset = startOffset;
      let lastError;
      for (let attempt = 0; attempt <= putRetryDelays.length; attempt++) {
        if (attempt > 0) await sleep(putRetryDelays[attempt - 1]);
        try {
          return await putToDrive(sessionUri, file, offset, onProgress);
        } catch (error) {
          if (!error.ambiguous) {
            // Drive definitively rejected this session (4xx / expired): a retry on it can never succeed, so forget it
            // and let the next attempt open a fresh session. A user cancel keeps the session so it can be resumed.
            if (error.code !== "aborted") remember({ sessionUri: null });
            throw error;
          }
          lastError = error;
          try {
            const sessionStatus = await queryDriveSession(sessionUri, file.size);
            if (sessionStatus.state === "complete") return sessionStatus.fileId;
            if (sessionStatus.state === "partial") offset = sessionStatus.offset;
            else throw new ResumableDriveUploadError("The Google Drive upload session expired.", "session_gone");
          } catch (statusError) {
            if (!statusError.ambiguous) throw statusError;
            // Cannot reach Drive to check; back off and try the PUT/status again.
          }
        }
      }
      throw new ResumableDriveUploadError(`${lastError?.message || "The upload was interrupted."} Retry to continue where it stopped.`, "upload_uncertain", { ambiguous: true });
    }
  }
}
