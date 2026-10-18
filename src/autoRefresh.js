// src/autoRefresh.js
// Keeps a public portal page current without a manual refresh. No React, so it can be
// unit tested with `node --test src/autoRefresh.test.mjs`.
//
// Polls `refresh` every `intervalMs` (default PORTAL_REFRESH_MS) while the tab is visible, and once more whenever the
// tab becomes visible, the window regains focus, or the device comes back online. Never
// runs two refreshes at once, never throws (a failed background refresh just keeps the
// last data on screen), and returns a function that stops everything.
//
// Polling (not Supabase Realtime) on purpose: portal visitors are anonymous and read through
// token-checked RPCs, so there is no row-level subscription they could be allowed to hold.

// How often an open, visible portal tab checks for changes. Each check is a few small
// token-checked reads, so 5 seconds is cheap for a studio-sized audience; raise it here
// if many clients ever keep tabs open at once.
export const PORTAL_REFRESH_MS = 5000;

export function startAutoRefresh(refresh, opts = {}) {
  const {
    intervalMs = PORTAL_REFRESH_MS,
    doc = typeof document !== "undefined" ? document : null,
    win = typeof window !== "undefined" ? window : null,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = opts;

  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    if (doc && doc.visibilityState === "hidden") return;
    running = true;
    try {
      await refresh();
    } catch {
      /* keep showing the last data; the next tick tries again */
    }
    running = false;
  };

  const timer = setIntervalFn(tick, intervalMs);
  doc?.addEventListener?.("visibilitychange", tick);
  win?.addEventListener?.("focus", tick);
  win?.addEventListener?.("online", tick);

  return () => {
    stopped = true;
    clearIntervalFn(timer);
    doc?.removeEventListener?.("visibilitychange", tick);
    win?.removeEventListener?.("focus", tick);
    win?.removeEventListener?.("online", tick);
  };
}
