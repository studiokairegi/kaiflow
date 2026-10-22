// src/authBootstrap.js
// Resolves the initial Supabase auth state for the app shell. No React and no Supabase import,
// so it can be unit tested with `node --test src/authBootstrap.test.mjs`.
//
// Why this exists: the shell used to call `supabase.auth.getSession()` with no timeout and no
// catch, and showed a logo-only screen until that promise resolved. getSession() waits for the
// client's internal initialization (which takes a browser storage lock), so if that ever hangs or
// rejects the screen stays on the logo with no way out.
//
// States:
//   loading  - waiting for the first answer (shown for at most `timeoutMs`)
//   ready    - session is known: a session object, or null = signed out
//   stalled  - no answer within `timeoutMs`. The session is UNKNOWN: this is NOT "signed out", so the
//              login form and protected content are both withheld and the UI offers a retry.
//   error    - getSession() rejected. Also unknown, also retryable.
// A late answer after `stalled`/`error` still moves the state to `ready`, so recovery is automatic.

export const AUTH_TIMEOUT_MS = 8000;

export function createAuthBootstrap({ auth, onChange, timeoutMs = AUTH_TIMEOUT_MS, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
  let state = { status: "loading", session: null, error: null };
  let attempt = 0;
  let timer = null;
  let subscription = null;
  let disposed = false;

  let lastEvent = null;
  const set = (next) => {
    if (disposed) return;
    state = next;
    const ev = lastEvent;
    lastEvent = null; // an event is reported once, with the state change it caused
    onChange(state, ev);
  };

  // `fromEvent`: an auth event is newer information than any in-flight getSession() request, so it
  // invalidates that request (bumping `attempt`) and a late, older answer can't overwrite it.
  const settle = (session, fromEvent = false) => {
    if (fromEvent) attempt++;
    clearTimeoutFn(timer);
    timer = null;
    set({ status: "ready", session: session || null, error: null });
  };

  function request() {
    const mine = ++attempt;
    clearTimeoutFn(timer);
    timer = setTimeoutFn(() => {
      if (mine === attempt && state.status === "loading") set({ status: "stalled", session: null, error: null });
    }, timeoutMs);
    let p;
    try { p = Promise.resolve(auth.getSession()); } catch (e) { p = Promise.reject(e); }
    p.then(
      (res) => {
        if (disposed || mine !== attempt) return;
        if (res && res.error) return fail(mine, res.error);
        settle(res?.data?.session);
      },
      (e) => fail(mine, e)
    );
  }

  function fail(mine, e) {
    if (disposed || mine !== attempt) return;
    clearTimeoutFn(timer);
    timer = null;
    console.error("Auth session initialization failed:", e);
    set({ status: "error", session: null, error: e instanceof Error ? e : new Error(String(e)) });
  }

  return {
    get state() { return state; },
    start() {
      if (subscription || disposed) return;
      // Callback stays synchronous and calls no Supabase methods: supabase-js holds its auth lock while
      // listeners run, so awaiting another auth call in here would deadlock.
      const { data } = auth.onAuthStateChange((event, session) => {
        if (disposed) return;
        lastEvent = event;
        // Every auth event carries the authoritative session, including while still loading/stalled.
        settle(session, true);
      });
      subscription = data?.subscription || null;
      request();
    },
    // Retry after stalled/error. Safe to call repeatedly; only the latest attempt counts.
    retry() {
      if (disposed) return;
      set({ status: "loading", session: null, error: null });
      request();
    },
    dispose() {
      disposed = true;
      clearTimeoutFn(timer);
      try { subscription?.unsubscribe(); } catch { /* ignore */ }
      subscription = null;
    },
  };
}
