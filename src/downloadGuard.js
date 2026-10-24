// Duplicate-download protection for client-facing download buttons.
//
// Root cause this fixes: the Download button used to rely on React state (`busy`) that is only
// visible after a re-render, and it released the lock as soon as the signed-URL request returned -
// while the browser was still saving the file. Nothing told the client a download had started,
// so they clicked again (three times).
//
// The guard is a plain, framework-free object so the lock is taken SYNCHRONOUSLY inside run(),
// before any await or re-render. The browser exposes no reliable "download finished" signal for
// an attachment navigation, so we never claim completion: the lock is held while the request is in
// flight, then for a fixed cooldown, and then released so a deliberate re-download is possible.
// A failed/rejected/timed-out request releases the lock immediately so nobody is locked out.

export const DOWNLOAD_COOLDOWN_MS = 10_000; // held after the download was handed to the browser
export const DOWNLOAD_REQUEST_TIMEOUT_MS = 30_000; // a request that never settles must not lock forever

export const DOWNLOAD_BUTTON_BUSY_LABEL = "Download started \u2014 please wait\u2026";
export const DOWNLOAD_STARTED_MESSAGE =
  "Your download has started. Your browser is saving the file \u2014 please wait a few seconds before clicking again.";

/**
 * @param {object} [opts]
 * @param {number} [opts.cooldownMs]
 * @param {number} [opts.requestTimeoutMs]
 * @param {() => void} [opts.onChange] called whenever any key's phase changes (never after dispose)
 * @param {Function} [opts.setTimeoutFn] injectable for tests
 * @param {Function} [opts.clearTimeoutFn] injectable for tests
 */
export function createDownloadGuard(opts = {}) {
  const cooldownMs = opts.cooldownMs ?? DOWNLOAD_COOLDOWN_MS;
  const requestTimeoutMs = opts.requestTimeoutMs ?? DOWNLOAD_REQUEST_TIMEOUT_MS;
  const setT = opts.setTimeoutFn || ((fn, ms) => setTimeout(fn, ms));
  const clearT = opts.clearTimeoutFn || ((id) => clearTimeout(id));
  const onChange = typeof opts.onChange === "function" ? opts.onChange : () => {};

  /** key -> { phase: "starting" | "cooldown", token, timer } */
  const entries = new Map();
  let disposed = false;
  let seq = 0;

  const notify = () => {
    if (!disposed) onChange();
  };

  const release = (key, token) => {
    const e = entries.get(key);
    if (!e || e.token !== token) return false; // a newer run owns this key
    if (e.timer !== null) clearT(e.timer);
    entries.delete(key);
    notify();
    return true;
  };

  /**
   * Start `startFn` for `key` unless that key is already starting/cooling down.
   * The lock is taken before startFn is called, so two synchronous calls can never both start.
   * Resolves to { started: false } when blocked, otherwise { started: true, ok, error? }.
   */
  function run(key, startFn) {
    if (disposed || entries.has(key)) return Promise.resolve({ started: false });

    const token = ++seq;
    const entry = { phase: "starting", token, timer: null };
    entries.set(key, entry);
    entry.timer = setT(() => {
      // Request never settled: treat as failed so the user can retry.
      entry.timer = null;
      release(key, token);
    }, requestTimeoutMs);
    notify();

    let pending;
    try {
      pending = Promise.resolve(startFn());
    } catch (err) {
      pending = Promise.reject(err);
    }

    return pending.then(
      () => {
        const current = entries.get(key);
        if (!disposed && current && current.token === token) {
          // Handed to the browser: keep the lock for the cooldown, then free it.
          if (current.timer !== null) clearT(current.timer);
          current.phase = "cooldown";
          current.timer = setT(() => {
            current.timer = null;
            release(key, token);
          }, cooldownMs);
          notify();
        }
        return { started: true, ok: true };
      },
      (error) => {
        release(key, token); // failure: allow an immediate retry
        return { started: true, ok: false, error };
      }
    );
  }

  return {
    run,
    isBlocked: (key) => !disposed && entries.has(key),
    phase: (key) => (disposed ? "idle" : entries.get(key)?.phase || "idle"),
    pendingTimerCount: () => [...entries.values()].filter((e) => e.timer !== null).length,
    /** Clear every timer and ignore any request that settles later. Safe to call twice. */
    dispose() {
      disposed = true;
      for (const e of entries.values()) if (e.timer !== null) clearT(e.timer);
      entries.clear();
    },
  };
}

/** Presentation for a download button given the guard phase. Pure, so it is unit-testable. */
export function downloadButtonView(phase, { version, enabled = true } = {}) {
  const busy = phase === "starting" || phase === "cooldown";
  return {
    busy,
    disabled: !enabled || busy,
    label: busy ? DOWNLOAD_BUTTON_BUSY_LABEL : `Download v${version ?? "\u2014"}`,
    statusMessage: busy ? DOWNLOAD_STARTED_MESSAGE : "",
  };
}

export const downloadKey = (shotId, versionId) => `${shotId}:${versionId}`;
