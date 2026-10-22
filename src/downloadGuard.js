// src/downloadGuard.js
// Click protection for download buttons. Pure (no React) so it is unit tested directly.
//
// Why: the old client Download button reused the generic `busy` flag from React state. That flag was
// cleared as soon as the signed-URL request returned and the page reload finished, which is long before
// the browser visibly starts a download, and the label never changed, so the client kept clicking.
//
// How it works:
//  - start(key) checks a plain Set synchronously, so two clicks in the same tick can never both pass
//    (React state would still be stale between them).
//  - While locked the UI shows "Download started - please wait...". The lock is held until the request
//    settles AND a cooldown has passed. We cannot observe the browser finishing a download, so the
//    cooldown is a fixed grace period, not a completion signal.
//  - A failed request releases the lock immediately, so the user can retry.
//  - Keys are per file (e.g. shot:version), so other files are never blocked.

export const DOWNLOAD_COOLDOWN_MS = 10000;

export function createDownloadGuard({ cooldownMs = DOWNLOAD_COOLDOWN_MS, onChange = () => {}, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  const active = new Map(); // key -> { timer, settled, cooled }
  let disposed = false;

  const notify = () => { if (!disposed) onChange(snapshot()); };
  const snapshot = () => new Set(active.keys());

  function release(key) {
    const entry = active.get(key);
    if (!entry) return;
    clearTimeoutFn(entry.timer);
    active.delete(key);
    notify();
  }

  return {
    isActive: (key) => active.has(key),
    /**
     * Runs `run()` unless a download for `key` is already in progress.
     * Resolves { started: false } for a blocked click, { started: true, ok, error? } otherwise.
     */
    async start(key, run) {
      if (disposed || active.has(key)) return { started: false };
      const entry = { timer: null, settled: false, cooled: false };
      active.set(key, entry); // synchronous: the lock is in place before any await
      notify();
      const maybeRelease = () => { if (entry.settled && entry.cooled) release(key); };
      try {
        await run();
        if (disposed) return { started: true, ok: true }; // unmounted mid-request: arm no timer
        entry.settled = true;
        // Cooldown starts once the browser has been handed the file.
        entry.timer = setTimeoutFn(() => { entry.cooled = true; maybeRelease(); }, cooldownMs);
        return { started: true, ok: true };
      } catch (error) {
        release(key); // failed or rejected: never lock the user out
        return { started: true, ok: false, error };
      }
    },
    /** Component unmounted: drop every timer and stop reporting state. */
    dispose() {
      disposed = true;
      for (const e of active.values()) clearTimeoutFn(e.timer);
      active.clear();
    },
  };
}
