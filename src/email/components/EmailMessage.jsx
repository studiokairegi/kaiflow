import React from "react";
import { formatChatTime } from "../../chat/logic.js";
import { IconFile, IconForward, IconImage } from "../../chat/icons.jsx";
import { emailApi } from "../lib/api.js";
import { fmtSize, isProblem, normalizeSubject, statusLabel } from "../lib/logic.js";
import { initialsOf, when } from "../lib/helpers.js";

// One email shown as a chat bubble (same markup and classes as the main chat), with a hover toolbar holding Forward.
export default function EmailMessage({ m, convoSubject, supabase, active, onActivate, onEditDraft, onForward }) {
  const [label, tone] = statusLabel(m.status);
  const inbound = m.direction === "inbound";
  const isDraft = m.status === "draft";
  const name = inbound ? (m.from_name || m.from_email || "Unknown sender") : "You";
  const ts = m.received_at || m.sent_at || m.created_at;
  const showSubject = m.subject && normalizeSubject(m.subject) !== normalizeSubject(convoSubject);
  const open = async (att) => {
    try { window.open(await emailApi.attachmentUrl(supabase, att.storage_path), "_blank", "noopener"); } catch (e) { window.alert(e.message); }
  };
  return (
    <article className={`chat-msg ${inbound ? "theirs" : "mine"}${active ? " active" : ""}`} onClick={onActivate}>
      {inbound && <span className="chat-msg-avatar" aria-hidden="true">{initialsOf(name)}</span>}
      <div className="chat-msg-main">
        <div className="chat-msg-meta">
          {inbound && <strong>{name}</strong>}
          {inbound && m.from_name && m.from_email && <span>{m.from_email}</span>}
          {m.ai_generated && <span className="chat-badge">AI draft · review before sending</span>}
          <time dateTime={ts} title={when(ts)}>{formatChatTime(ts)}</time>
        </div>
        <div className="chat-bubble">
          {showSubject && <strong className="inbox-bubble-subject">{m.subject}</strong>}
          <div className="chat-body-text"><p>{m.body_text || "(no text content)"}</p></div>
          {m.attachments?.length > 0 && <div className="chat-attachments">{m.attachments.map((a) => (
            <button type="button" className="chat-attachment" key={a.id} disabled={!a.storage_path} onClick={(e) => { e.stopPropagation(); open(a); }} title={a.storage_path ? "Open" : "Not stored (too large)"}>
              <span className="chat-attachment-icon">{String(a.content_type || "").startsWith("image/") ? <IconImage size={18} /> : <IconFile size={18} />}</span>
              <span className="chat-attachment-copy"><strong>{a.filename}</strong><small>{fmtSize(a.size_bytes)} · {a.storage_path ? "Open" : "Not stored"}</small></span>
            </button>
          ))}</div>}
        </div>
        {m.cc_emails?.length > 0 && <span className="chat-msg-note">Cc: {m.cc_emails.join(", ")}</span>}
        {!inbound && m.bcc_emails?.length > 0 && <span className="chat-msg-note">Bcc: {m.bcc_emails.join(", ")}</span>}
        {!inbound && !isDraft && !isProblem(m.status) && <span className={`chat-msg-note inbox-status ${tone}`}>{label}</span>}
        {isDraft && <span className="chat-msg-note">Draft · <button type="button" className="chat-link-btn" onClick={(e) => { e.stopPropagation(); onEditDraft(m); }}>Edit draft</button></span>}
        {isProblem(m.status) && <span className="chat-msg-fail" role="alert"><span>{label}: {m.error || "This email was not delivered."} Nothing was resent automatically.</span></span>}
        {!isDraft && <div className="chat-msg-tools" role="toolbar" aria-label="Message actions">
          <button type="button" className="chat-tool" aria-label="Forward" title="Forward" onClick={(e) => { e.stopPropagation(); onForward(m); }}><IconForward size={16} /></button>
        </div>}
      </div>
    </article>
  );
}
