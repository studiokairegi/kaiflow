import React from "react";
import { formatChatTime } from "../../chat/logic.js";
import { participantLabel } from "../lib/logic.js";
import { initialsOf } from "../lib/helpers.js";

// The sidebar list: one chat-style row per conversation (sender, subject, snippet, unread badge).
export default function ConversationList({ rows, loading, search, selected, own, error, onSelect, hasMore = false, onLoadMore }) {
  return (
    <div className="chat-sidebar-list">
      {error && <div className="chat-alert error" role="alert"><span>{error}</span></div>}
      {loading && !rows.length && <div className="chat-empty"><strong>Loading…</strong></div>}
      {!loading && rows.length === 0 && <div className="chat-empty"><strong>{search ? "No conversations match" : "Nothing here yet"}</strong><p>{search ? "Try a different search." : "Emails you send and receive show up here."}</p></div>}
      {rows.map((c) => {
        const label = participantLabel(c, own);
        const unread = Number(c.unread_count) > 0;
        return (
          <button type="button" key={c.id} className={`chat-row inbox-row${selected === c.id ? " active" : ""}${unread ? " unread" : ""}`} onClick={() => onSelect(c.id)}>
            <span className="chat-avatar" aria-hidden="true">{initialsOf(label)}</span>
            <span className="chat-row-copy">
              <span className="chat-row-title"><strong>{label}</strong><time>{c.last_message_at ? formatChatTime(c.last_message_at) : ""}</time></span>
              <span className="chat-row-subject">{c.subject || "(no subject)"}</span>
              <span className="chat-row-preview">{c.has_draft ? "Draft · " : ""}{c.has_attachments ? "📎 " : ""}{c.snippet}</span>
            </span>
            {unread && <span className="chat-unread" aria-label={`${c.unread_count} unread`}>{c.unread_count > 99 ? "99+" : c.unread_count}</span>}
          </button>
        );
      })}
      {hasMore && <div className="chat-empty"><button type="button" className="chat-button quiet" disabled={loading} onClick={onLoadMore}>{loading ? "Loading…" : "Load more"}</button></div>}
    </div>
  );
}
