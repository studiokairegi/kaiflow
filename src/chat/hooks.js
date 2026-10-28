import { useCallback, useEffect, useRef, useState } from "react";

// Mobile browsers shrink the visual viewport when the on-screen keyboard opens. Publishing its height
// as --vv-h lets full-height chat surfaces stay above the keyboard instead of hiding the composer.
export function useVisualViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return undefined;
    const apply = () => document.documentElement.style.setProperty("--vv-h", `${Math.round(viewport.height)}px`);
    apply();
    viewport.addEventListener("resize", apply);
    viewport.addEventListener("scroll", apply);
    return () => { viewport.removeEventListener("resize", apply); viewport.removeEventListener("scroll", apply); document.documentElement.style.removeProperty("--vv-h"); };
  }, []);
}

// Optimistic outbox. A message appears immediately as "sending"; on failure it stays in the thread as
// "failed" with Retry/Discard. Retries reuse the same idempotency key, so a retry after a flaky
// network can never double-post. `send(item)` must resolve to whatever `onSent` needs.
export function useOutbox({ send, onSent, errorText }) {
  const [items, setItems] = useState([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const sendRef = useRef(send); sendRef.current = send;
  const onSentRef = useRef(onSent); onSentRef.current = onSent;
  const errorRef = useRef(errorText); errorRef.current = errorText;

  const run = useCallback(async (item) => {
    setItems((current) => current.map((entry) => (entry.id === item.id ? { ...entry, status: "sending", error: "" } : entry)));
    try {
      const result = await sendRef.current(item);
      onSentRef.current?.(result, item);
      setItems((current) => current.filter((entry) => entry.id !== item.id));
    } catch (error) {
      const text = errorRef.current ? errorRef.current(error) : String(error?.message || "Not sent.");
      setItems((current) => current.map((entry) => (entry.id === item.id ? { ...entry, status: "failed", error: text } : entry)));
    }
  }, []);

  const enqueue = useCallback((fields) => {
    const item = { id: `out-${crypto.randomUUID()}`, key: crypto.randomUUID(), status: "sending", error: "", createdAt: new Date().toISOString(), ...fields };
    setItems((current) => [...current, item]);
    run(item);
    return item;
  }, [run]);
  const retry = useCallback((id) => { const item = itemsRef.current.find((entry) => entry.id === id); if (item && item.status === "failed") run(item); }, [run]);
  const discard = useCallback((id) => setItems((current) => current.filter((entry) => entry.id !== id)), []);
  const clear = useCallback(() => setItems([]), []);
  return { items, enqueue, retry, discard, clear };
}

// Poll while the tab is visible and the surface is mounted. Used by the portal chats (no realtime).
// `hidden: true` keeps polling while the tab is in the background so notifications still arrive.
export function usePolling(callback, intervalMs, enabled = true, { hidden = false } = {}) {
  const ref = useRef(callback); ref.current = callback;
  useEffect(() => {
    if (!enabled) return undefined;
    const tick = () => { if (hidden || document.visibilityState === "visible") ref.current(); };
    const timer = window.setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", tick);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, [intervalMs, enabled, hidden]);
}

export function initials(name) {
  return String(name || "?").trim().slice(0, 1).toUpperCase() || "?";
}

export function outboxToMessages(items, { senderKey, senderName }) {
  return items.map((item) => ({
    id: item.id, senderKey, senderName, avatar: initials(senderName), mine: true, body: item.body, createdAt: item.createdAt,
    status: item.status, error: item.error, edited: false, deleted: false, pinned: false, reactions: [],
    attachments: (item.files || []).map((file, index) => ({ id: `${item.id}:${index}`, file_name: file.name, size_bytes: file.size, content_type: file.type, local: true })),
    replyTo: item.replyTo || null,
  }));
}
