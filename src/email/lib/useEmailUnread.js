// Keeps the Inbox unread count current without refreshing the app, using the same background poll as the main chat
// (usePolling, also while the tab is hidden) and reports new arrivals so the app can play the chat message tone.
import { useCallback, useEffect, useRef, useState } from "react";
import { usePolling } from "../../chat/hooks.js";
import { emailApi } from "./api.js";
import { newArrivals } from "./logic.js";

export const EMAIL_POLL_MS = 20000;   // same cadence as the chat conversation list

export function useEmailUnread(supabase, enabled, onArrival) {
  const [unread, setUnread] = useState(0);
  const previous = useRef(null);
  const arrival = useRef(onArrival); arrival.current = onArrival;
  const playedAt = useRef(0);

  const check = useCallback(async () => {
    try {
      const total = Math.max(0, Number(await emailApi.unreadTotal(supabase)) || 0);
      const arrived = newArrivals(previous.current, total);
      previous.current = total;
      setUnread(total);
      // One tone per burst, like the chat: a poll and a manual refresh can notice the same email.
      if (arrived > 0 && Date.now() - playedAt.current > 1200) { playedAt.current = Date.now(); arrival.current?.(arrived); }
    } catch { /* keep the last count; the next poll tries again */ }
  }, [supabase]);

  useEffect(() => {
    previous.current = null;
    if (!enabled) { setUnread(0); return undefined; }
    check();
    return undefined;
  }, [enabled, check]);
  usePolling(check, EMAIL_POLL_MS, Boolean(enabled), { hidden: true });
  return { unread, refresh: check };
}
