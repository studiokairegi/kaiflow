// Pure helpers for the `push` Edge Function. Plain JavaScript so the Node test suite can import it
// directly; the function imports the same file under Deno.

export const SCHEDULE_PREFIXES = ["pomo", "digest"];
export const MAX_SCHEDULE_AHEAD_MS = 7 * 24 * 3600 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, max);

// Per-browser preferences mirror Settings > Alerts & display: a master switch and per-category switches.
export function shouldDeliver(prefs, category) {
  if (!prefs || typeof prefs !== "object") return true;
  if (prefs.enabled === false) return false;
  const categories = prefs.categories && typeof prefs.categories === "object" ? prefs.categories : {};
  return categories[category] !== false;
}

export function cleanPrefs(input) {
  const out = { enabled: input?.enabled !== false, categories: {} };
  if (input?.categories && typeof input.categories === "object") {
    for (const [key, value] of Object.entries(input.categories).slice(0, 30)) {
      if (/^[A-Za-z0-9_]{1,40}$/.test(key) && typeof value === "boolean") out.categories[key] = value;
    }
  }
  return out;
}

export function validSubscription(sub) {
  if (!sub || typeof sub !== "object") return null;
  const endpoint = String(sub.endpoint || "");
  const p256dh = String(sub.keys?.p256dh || "");
  const auth = String(sub.keys?.auth || "");
  if (!/^https:\/\//.test(endpoint) || endpoint.length < 20 || endpoint.length > 2048) return null;
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(p256dh) || !/^[A-Za-z0-9_-]{8,100}$/.test(auth)) return null;
  return { endpoint, p256dh, auth };
}

// Only same-site paths may be opened from a notification.
export function safeOpenUrl(value, fallback = "/") {
  const url = String(value || "");
  if (url.length > 500 || url.startsWith("//") || /[\u0000-\u001f\\]/.test(url)) return fallback;
  return url.startsWith("/") ? url : fallback;
}

// A user may only schedule keys in known namespaces, and the key is stored under their own id so two
// people can never overwrite each other's pending alert.
export function namespacedKey(userId, key) {
  const raw = String(key || "");
  const [prefix, ...rest] = raw.split(":");
  if (!SCHEDULE_PREFIXES.includes(prefix) || !rest.length || raw.length > 60 || !/^[A-Za-z0-9:_.-]+$/.test(raw)) return null;
  if (!UUID.test(String(userId || ""))) return null;
  return `${userId}:${raw}`;
}

export function validateJobs(jobs, now = Date.now()) {
  if (!Array.isArray(jobs) || jobs.length < 1 || jobs.length > 5) return null;
  const out = [];
  for (const job of jobs) {
    const key = String(job?.key || "");
    const due = new Date(job?.due_at);
    if (isNaN(+due) || +due < now - 60000 || +due > now + MAX_SCHEDULE_AHEAD_MS) return null;
    const title = clean(job?.title, 120);
    if (!title) return null;
    out.push({
      key, due_at: due.toISOString(), title, body: clean(job?.body, 240),
      category: /^[A-Za-z0-9_]{1,40}$/.test(String(job?.category || "")) ? String(job.category) : "general",
      tag: clean(job?.tag, 80) || null, url: safeOpenUrl(job?.url),
    });
  }
  return out;
}

export function buildPayload(job, openUrl) {
  return JSON.stringify({
    title: clean(job.title, 120) || "KairFlow", body: clean(job.body, 240), tag: clean(job.tag, 80) || undefined,
    url: safeOpenUrl(openUrl || job.url), category: job.category, icon: "/icon-512.png", ts: Date.now(),
  });
}

// 404/410 mean the browser revoked the subscription: forget it. Anything else is retried by the queue.
export const isGone = (status) => status === 404 || status === 410;
