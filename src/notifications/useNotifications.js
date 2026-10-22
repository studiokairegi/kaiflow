// src/notifications/useNotifications.js
// Thin React wrapper around the engine. The engine is created inside the effect, keyed by user id,
// so a sign-out / user switch disposes the old engine (realtime channel, timers) before a new one starts.
import { useEffect, useRef, useState } from "react";
import { createNotificationEngine } from "./engine.js";
import { createNotificationApi } from "./api.js";

const EMPTY = { status: "loading", error: null, actionError: null, items: [], unreadCount: 0, badgeCount: 0, hasMore: false, loadingMore: false, toast: null };

export function useNotifications(userId) {
  const [state, setState] = useState(EMPTY);
  const engineRef = useRef(null);

  useEffect(() => {
    setState(EMPTY);
    if (!userId) return undefined;
    const engine = createNotificationEngine({ api: createNotificationApi(userId), onChange: setState });
    engineRef.current = engine;
    engine.start();

    // Timers are throttled or frozen while the tab is hidden / the device sleeps; snooze expiries are
    // persisted timestamps, so on return we recompute instead of trusting a timer.
    const resume = () => { if (document.visibilityState === "visible") engine.onResume(); };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    return () => {
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
      engine.dispose();
      if (engineRef.current === engine) engineRef.current = null;
    };
  }, [userId]);

  return { ...state, engine: engineRef };
}
