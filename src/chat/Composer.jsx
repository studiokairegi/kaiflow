import React, { useLayoutEffect, useRef } from "react";
import { composerHeight } from "./logic.js";
import { IconClose, IconPaperclip, IconSend } from "./icons.jsx";

// Bottom composer: a self-contained, bottom-anchored row (attach · growing textarea · send).
// Enter sends, Shift+Enter inserts a line break, IME composition is respected. The textarea grows
// to a maximum height and then scrolls internally, so the composer never resizes the whole app.
export default function Composer({
  value, onChange, onSend, onTyping, sending = false, files = [], onFilesChange, accept = "",
  canAttach = true, replyTo = null, onCancelReply, placeholder = "Write a message…", maxLength = 10000,
  footerNote = "", textareaRef, error = "", label = "Message",
}) {
  const localRef = useRef(null);
  const fileInputRef = useRef(null);
  const ref = textareaRef || localRef;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const next = composerHeight(el.scrollHeight);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > next ? "auto" : "hidden";
  }, [value, ref]);

  const empty = !value.trim() && files.length === 0;
  const nearLimit = value.length > maxLength * 0.8;

  return (
    <form className={`chat-composer${sending ? " is-sending" : ""}`} onSubmit={(event) => { event.preventDefault(); if (!sending && !empty) onSend(); }}>
      {replyTo && (
        <div className="chat-composer-context">
          <span className="chat-composer-context-copy"><strong>Replying to {replyTo.senderName}</strong><small>{replyTo.preview}</small></span>
          <button type="button" className="chat-icon-btn sm" aria-label="Cancel reply" onClick={onCancelReply}><IconClose size={16} /></button>
        </div>
      )}
      {files.length > 0 && (
        <ul className="chat-composer-files" aria-label="Attachments to send">
          {files.map((file, index) => (
            <li key={`${file.name}-${index}`}>
              <span title={file.name}>{file.name}</span>
              <button type="button" className="chat-icon-btn sm" aria-label={`Remove ${file.name}`} onClick={() => onFilesChange(files.filter((_, i) => i !== index))}><IconClose size={14} /></button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="chat-composer-error" role="alert">{error}</p>}
      <div className="chat-composer-row">
        {canAttach && <>
          <button type="button" className="chat-icon-btn" aria-label="Attach a file" title="Attach a file" onClick={() => fileInputRef.current?.click()} disabled={sending}><IconPaperclip /></button>
          <input ref={fileInputRef} className="chat-file-input" type="file" multiple accept={accept} tabIndex={-1} onChange={(event) => { onFilesChange([...files, ...Array.from(event.target.files || [])].slice(0, 10)); event.target.value = ""; }} />
        </>}
        <textarea
          ref={ref} rows={1} value={value} maxLength={maxLength} placeholder={placeholder} aria-label={label}
          onChange={(event) => { onChange(event.target.value); onTyping?.(true); }}
          onBlur={() => onTyping?.(false)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (!sending && !empty) onSend();
            }
          }}
        />
        <button type="submit" className="chat-send" aria-label={sending ? "Sending" : "Send message"} title="Send (Enter)" disabled={sending || empty}>
          {sending ? <span className="chat-spinner sm" aria-hidden="true" /> : <IconSend size={18} />}
        </button>
      </div>
      <div className="chat-composer-foot">
        <span>{footerNote}</span>
        {nearLimit && <span className={value.length >= maxLength ? "over" : ""}>{value.length.toLocaleString()} / {maxLength.toLocaleString()}</span>}
      </div>
    </form>
  );
}
