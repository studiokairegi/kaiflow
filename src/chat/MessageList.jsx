import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import MessageBody from "./MessageBody.jsx";
import { dayLabel, formatChatTime, isNearBottom, QUICK_REACTIONS } from "./logic.js";
import { IconDown, IconEdit, IconFile, IconHistory, IconImage, IconPin, IconReply, IconRetry, IconSmile, IconTrash } from "./icons.jsx";

const sizeLabel = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

function Attachments({ items, onOpen, busyId }) {
  if (!items?.length) return null;
  return (
    <div className="chat-attachments">
      {items.map((item) => (
        <button type="button" className="chat-attachment" key={item.id} onClick={() => onOpen?.(item)} disabled={busyId === item.id} title={item.file_name}>
          <span className="chat-attachment-icon">{String(item.content_type || "").startsWith("image/") ? <IconImage size={18} /> : <IconFile size={18} />}</span>
          <span className="chat-attachment-copy"><strong>{item.file_name}</strong><small>{sizeLabel(item.size_bytes)} · {busyId === item.id ? "Opening…" : "Open"}</small></span>
        </button>
      ))}
    </div>
  );
}

function Row({ message, grouped, actions, busyId, downloadBusyId, active, onActivate, jump, pickerOpen, onTogglePicker }) {
  const { mine } = message;
  const tools = [];
  if (!message.deleted && !message.status) {
    if (actions.reply) tools.push(<button key="reply" type="button" className="chat-tool" aria-label="Reply" title="Reply" onClick={() => actions.reply(message)}><IconReply size={16} /></button>);
    if (actions.react && message.canReact !== false) tools.push(<button key="react" type="button" className={`chat-tool${pickerOpen ? " on" : ""}`} aria-label="Add reaction" title="Add reaction" aria-expanded={pickerOpen} onClick={() => onTogglePicker(message.id)}><IconSmile size={16} /></button>);
    if (actions.pin && message.canPin !== false) tools.push(<button key="pin" type="button" className={`chat-tool${message.pinned ? " on" : ""}`} aria-label={message.pinned ? "Unpin message" : "Pin message"} aria-pressed={message.pinned} title={message.pinned ? "Unpin" : "Pin"} disabled={busyId === message.id} onClick={() => actions.pin(message, !message.pinned)}><IconPin size={16} filled={message.pinned} /></button>);
    if (actions.edit && message.canEdit) tools.push(<button key="edit" type="button" className="chat-tool" aria-label="Edit message" title="Edit" onClick={() => actions.edit(message)}><IconEdit size={16} /></button>);
    if (actions.history && message.edited) tools.push(<button key="history" type="button" className="chat-tool" aria-label="Edit history" title="Edit history" onClick={() => actions.history(message)}><IconHistory size={16} /></button>);
    if (actions.remove && message.canDelete) tools.push(<button key="del" type="button" className="chat-tool danger" aria-label="Delete message" title="Delete" disabled={busyId === message.id} onClick={() => actions.remove(message)}><IconTrash size={16} /></button>);
  }
  return (
    <article
      id={`chat-message-${message.id}`}
      className={`chat-msg ${mine ? "mine" : "theirs"}${grouped ? " grouped" : ""}${jump ? " jump" : ""}${active ? " active" : ""}${message.status ? ` is-${message.status}` : ""}`}
      onClick={onActivate}
    >
      {!mine && <span className="chat-msg-avatar" aria-hidden="true">{grouped ? "" : message.avatar}</span>}
      <div className="chat-msg-main">
        {!grouped && (
          <div className="chat-msg-meta">
            {!mine && <strong>{message.senderName}</strong>}
            {message.badge && <span className="chat-badge">{message.badge}</span>}
            <time dateTime={message.createdAt} title={message.createdAt ? new Date(message.createdAt).toLocaleString() : ""}>{formatChatTime(message.createdAt)}</time>
            {message.pinned && <span className="chat-pin-flag" title="Pinned"><IconPin size={12} filled /></span>}
          </div>
        )}
        {message.replyTo && (
          <button type="button" className="chat-quote" onClick={(event) => { event.stopPropagation(); actions.jumpTo?.(message.replyTo.id); }}>
            <strong>{message.replyTo.name}</strong><span>{message.replyTo.preview}</span>
          </button>
        )}
        <div className={`chat-bubble${message.deleted ? " deleted" : ""}`} title={grouped && message.createdAt ? new Date(message.createdAt).toLocaleTimeString() : undefined}>
          {message.deleted ? <em>This message was deleted.</em> : <MessageBody body={message.body} />}
          {!message.deleted && <Attachments items={message.attachments} onOpen={actions.openAttachment} busyId={downloadBusyId} />}
          {grouped && message.pinned && <span className="chat-pin-flag inline" title="Pinned"><IconPin size={12} filled /></span>}
        </div>
        {(message.edited && !message.deleted) && <span className="chat-msg-note">edited</span>}
        {message.status === "sending" && <span className="chat-msg-note"><span className="chat-spinner xs" aria-hidden="true" /> Sending…</span>}
        {message.status === "failed" && (
          <span className="chat-msg-fail" role="alert">
            <span>{message.error || "Not sent."}</span>
            <button type="button" className="chat-link-btn" onClick={() => actions.retry?.(message)}><IconRetry size={14} /> Retry</button>
            <button type="button" className="chat-link-btn" onClick={() => actions.discard?.(message)}>Discard</button>
          </span>
        )}
        {message.reactions?.length > 0 && !message.deleted && (
          <div className="chat-reactions">
            {message.reactions.map((group) => (
              <button type="button" key={group.reaction} className={`chat-reaction${group.reactedByMe ? " mine" : ""}`} title={group.names?.join(", ")} aria-pressed={group.reactedByMe}
                onClick={(event) => { event.stopPropagation(); actions.react?.(message, group.reaction, group.reactedByMe); }}>{group.reaction} <span>{group.count}</span></button>
            ))}
          </div>
        )}
        {pickerOpen && (
          <div className="chat-reaction-picker" role="group" aria-label="Choose a reaction">
            {QUICK_REACTIONS.map((reaction) => (
              <button type="button" key={reaction} aria-label={`React ${reaction}`} onClick={() => { actions.react?.(message, reaction, message.reactions?.some((g) => g.reaction === reaction && g.reactedByMe)); onTogglePicker(null); }}>{reaction}</button>
            ))}
          </div>
        )}
        {tools.length > 0 && <div className="chat-msg-tools" role="toolbar" aria-label="Message actions">{tools}</div>}
      </div>
    </article>
  );
}

// Generic, presentational thread. It owns scrolling: it follows new messages only while the reader
// is at the bottom, keeps position when older messages are prepended, and shows a "new messages"
// pill instead of yanking the view when the reader has scrolled up.
export default function MessageList({
  conversationKey, messages, outbox = [], typing = [], loading = false, hasOlder = false, loadingOlder = false,
  onLoadOlder, jumpId = null, onJumpDone, actions = {}, busyId = null, downloadBusyId = null, empty = null, notices = null, now,
}) {
  const scrollerRef = useRef(null);
  const contentRef = useRef(null);
  const stickRef = useRef(true);
  const anchorRef = useRef(null);
  const prevRef = useRef({ key: null, first: null, last: null, count: 0 });
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const [activeId, setActiveId] = useState(null);
  const [pickerFor, setPickerFor] = useState(null);
  const [flashId, setFlashId] = useState(null);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    stickRef.current = true; setAtBottom(true); setUnseen(0);
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const near = isNearBottom(el);
    stickRef.current = near;
    setAtBottom(near);
    if (near) setUnseen(0);
  }, []);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const prev = prevRef.current;
    const first = messages[0]?.id ?? null;
    const last = outbox.length ? `outbox:${outbox[outbox.length - 1].id}:${outbox[outbox.length - 1].status}` : (messages[messages.length - 1]?.id ?? null);
    const count = messages.length + outbox.length;
    if (prev.key !== conversationKey) {
      el.scrollTop = el.scrollHeight; stickRef.current = true; setAtBottom(true); setUnseen(0);
    } else if (anchorRef.current !== null && first !== prev.first && messages.length > prev.count) {
      el.scrollTop += el.scrollHeight - anchorRef.current; anchorRef.current = null; // older page prepended: keep the reader's place
    } else if (last !== prev.last) {
      const newest = outbox.length ? outbox[outbox.length - 1] : messages[messages.length - 1];
      if (stickRef.current || newest?.mine) scrollToBottom(false);
      else if (newest && !newest.mine) setUnseen((n) => n + Math.max(1, count - prev.count));
    }
    prevRef.current = { key: conversationKey, first, last, count: messages.length };
  }, [messages, outbox, conversationKey, scrollToBottom]);

  // Attachments rendering or the composer growing changes the scroller's size: stay pinned only if pinned.
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => { if (stickRef.current) { const el = scrollerRef.current; if (el) el.scrollTop = el.scrollHeight; } });
    if (scrollerRef.current) observer.observe(scrollerRef.current);
    if (contentRef.current) observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [conversationKey]);

  useEffect(() => {
    if (!jumpId) return undefined;
    const node = document.getElementById(`chat-message-${jumpId}`);
    if (!node) return undefined;
    stickRef.current = false;
    node.scrollIntoView({ block: "center", behavior: "smooth" });
    setFlashId(jumpId); onJumpDone?.();
    const timer = window.setTimeout(() => setFlashId(null), 1800);
    return () => window.clearTimeout(timer);
  }, [jumpId, messages, onJumpDone]);

  const loadOlder = () => { anchorRef.current = scrollerRef.current?.scrollHeight ?? null; onLoadOlder?.(); };
  const all = [...messages, ...outbox];

  return (
    <div className="chat-thread">
      <div ref={scrollerRef} className="chat-scroll" role="log" aria-live="polite" aria-label="Messages" tabIndex={0} onScroll={handleScroll}>
        <div ref={contentRef} className="chat-scroll-content">
          {notices}
          {hasOlder && <div className="chat-load-older"><button type="button" className="chat-pill-btn" onClick={loadOlder} disabled={loadingOlder}>{loadingOlder ? "Loading earlier messages…" : "Load earlier messages"}</button></div>}
          {loading && !all.length && <div className="chat-loading"><span className="chat-spinner" aria-hidden="true" /><span>Loading messages…</span></div>}
          {!loading && !all.length && empty}
          {all.map((message, index) => {
            const previous = all[index - 1];
            const sameDay = previous && previous.createdAt && message.createdAt && new Date(previous.createdAt).toDateString() === new Date(message.createdAt).toDateString();
            const grouped = Boolean(previous) && sameDay && previous.senderKey === message.senderKey && !previous.status === !message.status
              && Math.abs(Date.parse(message.createdAt) - Date.parse(previous.createdAt)) < 4 * 60 * 1000 && !message.replyTo;
            return (
              <React.Fragment key={message.id}>
                {(!previous || !sameDay) && message.createdAt && <div className="chat-day" role="separator"><span>{dayLabel(message.createdAt, now)}</span></div>}
                <Row message={message} grouped={grouped} actions={actions} busyId={busyId} downloadBusyId={downloadBusyId}
                  active={activeId === message.id} onActivate={() => setActiveId((current) => (current === message.id ? null : message.id))}
                  jump={flashId === message.id} pickerOpen={pickerFor === message.id} onTogglePicker={setPickerFor} />
              </React.Fragment>
            );
          })}
          {typing.length > 0 && (
            <div className="chat-typing" aria-live="polite"><span className="chat-typing-dots" aria-hidden="true"><i /><i /><i /></span>{typing.join(", ")} {typing.length > 1 ? "are" : "is"} typing…</div>
          )}
        </div>
      </div>
      {!atBottom && (
        <button type="button" className={`chat-jump-bottom${unseen ? " has-new" : ""}`} onClick={() => scrollToBottom(true)} aria-label={unseen ? `${unseen} new message${unseen > 1 ? "s" : ""}, jump to latest` : "Jump to latest message"}>
          <IconDown size={16} />{unseen > 0 && <span>{unseen} new</span>}
        </button>
      )}
    </div>
  );
}
