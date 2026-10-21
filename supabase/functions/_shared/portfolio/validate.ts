// Server-side rules for portfolio media. Pure (no Deno/Node globals) so it is unit-tested with node.
// The browser has its own copy in src/portfolio/logic.js; a test keeps the two in lock-step.
export const VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime"] as const;
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
export const MAX_BYTES = 500 * 1024 * 1024;
export const MAX_ITEMS = 50;
// Up to this size a file goes browser -> Edge Function -> Drive in one request (no browser/CORS
// dependency on Google). Larger files (reels) go straight from the browser to a Drive resumable session.
export const SERVER_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

export function kindFromMime(mime: string): "video" | "image" | null {
  if ((VIDEO_TYPES as readonly string[]).includes(mime)) return "video";
  if ((IMAGE_TYPES as readonly string[]).includes(mime)) return "image";
  return null;
}

export type UploadCheck = { ok: true; kind: "video" | "image" } | { ok: false; error: string };

export function validateUpload(input: { name?: unknown; mimeType?: unknown; size?: unknown }, existingCount: number): UploadCheck {
  if (existingCount >= MAX_ITEMS) return { ok: false, error: `A portfolio can hold up to ${MAX_ITEMS} items.` };
  const kind = typeof input.mimeType === "string" ? kindFromMime(input.mimeType) : null;
  if (!kind) return { ok: false, error: "Use MP4, WebM or MOV video, or JPG, PNG, WebP or GIF images." };
  const size = Number(input.size);
  if (!Number.isFinite(size) || size <= 0) return { ok: false, error: "The file is empty." };
  if (size > MAX_BYTES) return { ok: false, error: `The file is larger than the ${Math.round(MAX_BYTES / 1024 / 1024)} MB limit.` };
  return { ok: true, kind };
}

// Drive file names are cosmetic (the id is the reference); keep them short and free of path/control chars.
export function safeDriveName(name: unknown): string {
  const s = String(name ?? "").replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(-120);
  return s || "portfolio-file";
}
