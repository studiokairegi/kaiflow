import React, { useEffect, useRef, useState } from "react";
import { EMOJI_CATEGORIES, loadRecentEmoji, pushRecentEmoji, saveRecentEmoji } from "./logic.js";

// Dropdown emoji panel: recent row + category tabs. Recents persist per browser (best-effort).
// `onPick(emoji)` is called; the panel stays open when `keepOpen` (composer) and closes otherwise.
export default function EmojiPanel({ onPick, onClose, keepOpen = false, className = "", align = "left" }) {
  const [recent, setRecent] = useState(() => loadRecentEmoji());
  const [cat, setCat] = useState(() => (loadRecentEmoji().length ? "recent" : EMOJI_CATEGORIES[0].id));
  const ref = useRef(null);

  useEffect(() => {
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target) && !e.target.closest?.("[data-emoji-toggle]")) onClose?.(); };
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); onClose?.(); } };
    document.addEventListener("mousedown", onDown); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [onClose]);

  const pick = (emoji) => {
    const next = pushRecentEmoji(recent, emoji);
    setRecent(next); saveRecentEmoji(next);
    onPick(emoji);
    if (!keepOpen) onClose?.();
  };
  const tabs = [...(recent.length ? [{ id: "recent", label: "Recent", icon: "🕘" }] : []), ...EMOJI_CATEGORIES];
  const active = tabs.find((t) => t.id === cat) || tabs[0];
  const list = active.id === "recent" ? recent : EMOJI_CATEGORIES.find((c) => c.id === active.id)?.emoji || [];

  return (
    <div ref={ref} className={`chat-emoji-panel align-${align} ${className}`.trim()} role="dialog" aria-label="Emoji picker">
      <div className="chat-emoji-tabs" role="tablist">
        {tabs.map((t) => <button type="button" role="tab" key={t.id} aria-selected={active.id === t.id} aria-label={t.label} title={t.label} className={active.id === t.id ? "active" : ""} onClick={() => setCat(t.id)}>{t.icon}</button>)}
      </div>
      <div className="chat-emoji-label">{active.label}</div>
      <div className="chat-emoji-grid" role="group" aria-label={active.label}>
        {list.map((emoji) => <button type="button" key={emoji} aria-label={emoji} onClick={() => pick(emoji)}>{emoji}</button>)}
      </div>
    </div>
  );
}
