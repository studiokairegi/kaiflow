// Pure portfolio helpers (no network): validation, storage paths, ordering, link URLs.
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

export const safeFileName = (name) =>
  String(name || "file").normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(-80) || "file";

// Objects live under "<user_id>/": the storage policies and a DB check both enforce that prefix.
export const buildStoragePath = (userId, fileName, unique) => `${userId}/${unique}-${safeFileName(fileName)}`;

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
