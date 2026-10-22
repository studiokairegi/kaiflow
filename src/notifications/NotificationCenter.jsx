import React, { useCallback, useEffect, useRef, useState } from "react";
import { badgeLabel, relativeTime } from "./logic.js";

// Header bell + dropdown panel. Everything shown comes from the engine (activity the signed-in
// user already owns, via RLS); this component only renders and forwards actions.
//
// Opening the panel acknowledges what is unread at that moment (engine.open). Items that arrive
// while it is open stay unread until the next open or until they are clicked.

const C = { ink: "#14191c", inkSoft: "#1c2327", paper: "#EDEAE3", teal: "#2FBFA6", border: "#2a3338", muted: "#8b9a98", red: "#FF4D4D", blue: "#4A90D9" };
const ACTOR_COLOR = { client: C.blue, freelancer: C.teal };

const BellSvg = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 8a6 6 0 0 1 12 0c0 4 1.5 5.5 2 6H4c.5-.5 2-2 2-6Z" />
    <path d="M10 20a2 2 0 0 0 4 0" />
  </svg>
);

const small = { fontSize: 12, color: C.muted };
const textButton = { background: "transparent", border: `1px solid ${C.border}`, color: C.paper, borderRadius: 8, padding: "6px 10px", minHeight: 32, fontSize: 12.5, cursor: "pointer" };

const fullStamp = (iso) => { const d = new Date(iso); return isNaN(d.getTime()) ? "" : d.toLocaleString(); };
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/**
 * @param notifications result of useNotifications(userId)
 * @param onNavigate (notification) => { ok: boolean, message?: string } | Promise<...>
 *        Opens the project/shot/activity item. Returning ok:false shows `message` in the panel.
 */
export default function NotificationCenter({ notifications, onNavigate, buttonStyle }) {
  const { status, error, actionError, items, unreadCount, badgeCount, hasMore, loadingMore, toast, engine } = notifications;
  const [open, setOpen] = useState(false);
  const [fresh, setFresh] = useState(() => new Set()); // ids that were unread when this visit began
  const [navMessage, setNavMessage] = useState("");
  const [, setTick] = useState(0);
  const buttonRef = useRef(null);
  const panelRef = useRef(null);
  const wrapRef = useRef(null);

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    setNavMessage("");
    if (returnFocus && buttonRef.current) buttonRef.current.focus();
  }, []);

  const openPanel = useCallback(async () => {
    setOpen(true);
    setNavMessage("");
    const eng = engine.current;
    if (!eng) return;
    const ids = await eng.open(); // acknowledges exactly the unread, non-snoozed items right now
    setFresh(new Set(ids));
  }, [engine]);

  // Focus the panel when it opens; Escape and outside-click close it.
  useEffect(() => {
    if (!open) return undefined;
    if (panelRef.current) panelRef.current.focus();
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(true); } };
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) close(false); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    const t = setInterval(() => setTick((n) => n + 1), 30000); // keeps "5 min ago" fresh while open
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("mousedown", onDown); clearInterval(t); };
  }, [open, close]);

  const handleItem = async (n) => {
    const eng = engine.current;
    if (eng) eng.openItem(n.id);
    let res = { ok: true };
    try { res = (await onNavigate(n)) || { ok: true }; } catch { res = { ok: false, message: "That item couldn't be opened." }; }
    if (res.ok) close(false);
    else setNavMessage(res.message || "That item is no longer available.");
  };

  const label = badgeCount > 0 ? `Notifications, ${badgeCount} unread` : "Notifications";

  return (
    <div ref={wrapRef} style={{ position: "relative", flexShrink: 0 }}>
      <button
        ref={buttonRef}
        type="button"
        style={{ ...buttonStyle, position: "relative" }}
        onClick={() => (open ? close(true) : openPanel())}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Notifications"
      >
        <BellSvg />
        {badgeCount > 0 && (
          <span
            aria-hidden="true"
            style={{ position: "absolute", top: -4, right: -4, minWidth: 18, height: 18, padding: "0 5px", boxSizing: "border-box", borderRadius: 999, background: C.red, color: "#fff", fontSize: 10.5, fontWeight: 700, lineHeight: "18px", textAlign: "center" }}
          >
            {badgeLabel(badgeCount)}
          </span>
        )}
      </button>

      {toast && !open && (
        <div role="status" style={{ position: "fixed", top: 16, right: 16, zIndex: 60, maxWidth: "calc(100vw - 32px)", background: C.inkSoft, border: `1px solid ${C.teal}`, borderRadius: 12, padding: 12, color: C.paper, fontSize: 13, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span>Reminder: {toast.count === 1 ? toast.firstTitle : `${toast.count} notifications need your attention`}</span>
          <button type="button" style={textButton} onClick={() => { engine.current?.dismissToast(); openPanel(); }}>View</button>
          <button type="button" style={textButton} onClick={() => engine.current?.dismissToast()}>Dismiss</button>
        </div>
      )}

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Notifications"
          tabIndex={-1}
          style={{ position: "absolute", right: 0, top: 44, zIndex: 50, width: 380, maxWidth: "calc(100vw - 24px)", maxHeight: "min(70vh, 560px)", overflowY: "auto", background: C.ink, border: `1px solid ${C.border}`, borderRadius: 12, boxShadow: "0 12px 32px rgba(0,0,0,0.45)", color: C.paper, outline: "none" }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 14px", borderBottom: `1px solid ${C.border}` }}>
            <strong style={{ fontSize: 14 }}>Notifications</strong>
            <span style={small}>{status === "ready" ? (unreadCount > 0 ? `${unreadCount} unread` : "All caught up") : ""}</span>
          </div>

          {(navMessage || actionError) && <p role="alert" style={{ margin: 0, padding: "8px 14px", fontSize: 12.5, color: C.red }}>{navMessage || actionError}</p>}

          {status === "loading" && <p style={{ ...small, padding: 14, margin: 0 }}>Loading notifications…</p>}

          {status === "error" && (
            <div style={{ padding: 14 }}>
              <p role="alert" style={{ margin: "0 0 8px", fontSize: 13, color: C.red }}>Couldn't load notifications{error ? ` (${error.message})` : ""}.</p>
              <button type="button" style={textButton} onClick={() => engine.current?.refresh()}>Try again</button>
            </div>
          )}

          {status === "ready" && items.length === 0 && (
            <p style={{ ...small, padding: 14, margin: 0 }}>No notifications yet. Client feedback, approvals and freelancer uploads will appear here.</p>
          )}

          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {items.map((n) => {
              const isNew = n.unread || fresh.has(n.id);
              return (
                <li key={n.id} style={{ borderBottom: `1px solid ${C.border}`, padding: "10px 14px", background: isNew ? "rgba(47,191,166,0.07)" : "transparent" }}>
                  <button type="button" onClick={() => handleItem(n)} style={{ display: "block", width: "100%", textAlign: "left", background: "transparent", border: 0, padding: 0, margin: 0, color: "inherit", font: "inherit", cursor: "pointer", boxSizing: "border-box" }}>
                    <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      {isNew && <span aria-label="Unread" style={{ width: 8, height: 8, borderRadius: 999, background: C.teal, flexShrink: 0 }} />}
                      <span style={{ fontSize: 13.5, fontWeight: 600 }}>{n.title}</span>
                      <span style={{ fontSize: 11, padding: "1px 8px", borderRadius: 999, border: `1px solid ${ACTOR_COLOR[n.actor] || C.border}`, color: ACTOR_COLOR[n.actor] || C.muted }}>{n.actor}</span>
                      {n.reminder && <span style={{ fontSize: 11, color: C.red }}>Reminder</span>}
                    </span>
                    <span style={{ display: "block", fontSize: 13, margin: "4px 0 0", color: C.paper, overflowWrap: "anywhere" }}>{n.body ? `“${n.body}”` : n.summary}</span>
                    {n.body && <span style={{ display: "block", ...small, marginTop: 2 }}>{n.summary}</span>}
                  </button>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginTop: 6 }}>
                    <time dateTime={n.createdAt} title={fullStamp(n.createdAt)} style={small}>
                      {relativeTime(n.createdAt)}
                      <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}> ({fullStamp(n.createdAt)})</span>
                    </time>
                    {n.snoozed ? (
                      <span style={small}>Snoozed until {clock(n.snoozedUntil)}</span>
                    ) : (
                      <button type="button" style={textButton} onClick={() => engine.current?.snooze(n.id)} aria-label={`Snooze “${n.title}” for 5 minutes`}>Snooze 5 min</button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          {status === "ready" && hasMore && (
            <div style={{ padding: 12, textAlign: "center" }}>
              <button type="button" style={textButton} disabled={loadingMore} onClick={() => engine.current?.loadMore()}>{loadingMore ? "Loading…" : "Show older"}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
