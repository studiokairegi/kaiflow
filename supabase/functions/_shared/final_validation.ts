// Pure validation rules for QC-adjusted final files. No imports, so it runs
// in Deno (Edge Functions) and in plain Node tests.

// No app-level size cap on final files. Kept as an exported constant so existing imports
// keep working; Infinity means the check below never rejects on size. Supabase's own
// Edge Function limits (request size, memory, run time) still apply and are not set here.
export const MAX_FINAL_BYTES = Number.POSITIVE_INFINITY;

const BLOCKED_EXTENSIONS = new Set([
  "exe", "bat", "cmd", "com", "scr", "msi", "ps1", "sh", "js", "jar", "vbs", "dll", "apk",
]);

export type InputCheck = { ok: true } | { ok: false; status: number; error: string };

export function validateFinalUploadInput(file: { name: string; size: number }): InputCheck {
  if (!file.name || file.name.length > 200) {
    return { ok: false, status: 400, error: "The file needs a name (200 characters max)." };
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return { ok: false, status: 400, error: "The file is empty." };
  }
  const ext = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
  if (BLOCKED_EXTENSIONS.has(ext)) {
    return { ok: false, status: 400, error: `.${ext} files can't be delivered as a final file.` };
  }
  return { ok: true };
}

export type DriveMeta = {
  id?: string;
  mimeType?: string;
  size?: string;
  trashed?: boolean;
  parents?: string[];
} | null;

// Backend-side check that what's in Drive is really the file we just uploaded,
// in the right folder, and still usable. Returns an error string or null.
export function validateDriveFile(
  meta: DriveMeta,
  expected: { fileId: string; folderId: string; sizeBytes: number }
): string | null {
  if (!meta) return "The uploaded file could not be found in Drive.";
  if (meta.id !== expected.fileId) return "Drive returned a different file than the one uploaded.";
  if (meta.trashed) return "The uploaded file is in the Drive trash.";
  if (!meta.parents || !meta.parents.includes(expected.folderId)) {
    return "The uploaded file is not in the Final QC folder.";
  }
  if (meta.size !== undefined && Number(meta.size) !== expected.sizeBytes) {
    return "The file size in Drive doesn't match the uploaded file.";
  }
  if (meta.size !== undefined && Number(meta.size) <= 0) return "The file in Drive is empty.";
  return null;
}
