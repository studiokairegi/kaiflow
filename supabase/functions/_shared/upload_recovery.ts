// Shared helpers for direct-to-Drive upload recovery/finalization.
import type { DriveFileMeta } from "./google.ts";

export const validFingerprint = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);

// Drive appProperties are limited to 124 bytes per key+value; "fp" + 64 hex chars is well inside that.
export const FINGERPRINT_PROP = "fp";

/** Does the Drive file's stored content fingerprint match the one the browser claims? Files created
 * before fingerprints existed carry none and are accepted only when the caller sends none either. */
export function fingerprintMatches(meta: DriveFileMeta, fingerprint: unknown): boolean {
  const stored = meta.appProperties?.[FINGERPRINT_PROP];
  if (!stored) return !validFingerprint(fingerprint);
  return stored === fingerprint;
}

/**
 * Picks the Drive file for a recovery request. Several files may legitimately share one upload id
 * when an earlier attempt completed but its response (or Drive's listing) was lost and a retry opened
 * another session. Files for the same id + fingerprint + size are the same bytes, so the oldest wins
 * deterministically; files that do NOT match the requested fingerprint/size are ignored.
 * Returns null when nothing matches.
 */
export function pickRecoveredFile(matches: DriveFileMeta[], fingerprint: unknown, size: number): DriveFileMeta | null {
  const candidates = matches
    .filter((m) => !m.trashed && fingerprintMatches(m, fingerprint) && (!Number.isSafeInteger(size) || size <= 0 || Number(m.size) === size))
    .sort((a, b) => String(a.createdTime || "").localeCompare(String(b.createdTime || "")) || a.id.localeCompare(b.id));
  return candidates[0] ?? null;
}

/** Browser-supplied MIME types become an HTTP header (X-Upload-Content-Type); accept only well-formed values. */
export function safeMime(v: unknown): string {
  return typeof v === "string" && v.length <= 100 && /^[A-Za-z0-9][\w.+-]*\/[A-Za-z0-9][\w.+-]*$/.test(v) ? v : "application/octet-stream";
}

/** Largest freelancer deliverable accepted (the share link is a capability, so bound what it can reserve in the studio's Drive).
 * Override with the FREELANCER_UPLOAD_MAX_BYTES secret; default 10 GiB. */
export function freelancerMaxBytes(raw: string | undefined | null): number {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : 10 * 1024 * 1024 * 1024;
}

// ---------------------------------------------------------------------------------------------
// Full-content integrity. The sampled fingerprint only identifies which pending upload a file belongs to; it cannot
// see a change confined to bytes it never samples. The browser therefore streams an MD5 of the WHOLE file and the
// server compares it with the md5Checksum Drive computed for what it actually stored.
// ---------------------------------------------------------------------------------------------

export const validMd5 = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{32}$/.test(v);

export type Md5Verdict = "ok" | "required" | "pending" | "mismatch";

/**
 * required: the caller sent no (valid) md5 - ask for it (HTTP 428 md5_required).
 * pending:  Drive has not published md5Checksum for this file yet - retryable (HTTP 503 checksum_pending).
 * mismatch: the bytes in Drive differ from the bytes the user selected (HTTP 409 file_mismatch).
 */
export function md5Verdict(meta: DriveFileMeta, md5: unknown): Md5Verdict {
  if (!validMd5(md5)) return "required";
  const stored = meta.md5Checksum;
  if (!stored) return "pending";
  return stored.toLowerCase() === md5 ? "ok" : "mismatch";
}

export const MD5_MISMATCH_MESSAGE =
  "The file stored in Google Drive is not identical to the file on your computer (it may have changed while uploading). Select the file again to upload it fresh.";

/** Positive-integer env override with a default (rate limits). */
export function intFromEnv(raw: string | undefined | null, fallback: number): number {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/** Old (multipart) clients cached in a browser tab cannot speak the resumable protocol; tell them to reload instead of failing obscurely. */
export function isJsonRequest(req: Request): boolean {
  return (req.headers.get("content-type") || "").toLowerCase().includes("application/json");
}

export const CLIENT_OUTDATED_MESSAGE =
  "This page is out of date. Please reload it (Ctrl/Cmd+Shift+R) and try the upload again.";
