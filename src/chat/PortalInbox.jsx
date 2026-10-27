import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chatApi } from "./api.js";
import { PORTAL_ACCEPT, validatePortalFiles, portalErrorText as portalCodeText } from "./portalApi.js";

// Staff calls surface database/gateway errors as Error messages; map known codes, otherwise be generic.
const portalErrorText = (error) => { const raw = String(error?.message || error || ""); const text = portalCodeText(raw.replace(/^.*?(not_authorized|rate_limited|not_found|invalid_credential|message_too_long|empty_message|too_many_attachments|unsupported_file_type|file_content_mismatch|file_too_large).*$/s, "$1")); return text; };
import { createInviteToken } from "../studio/access.js";
import Composer from "./Composer.jsx";
import MessageList from "./MessageList.jsx";
import { initials, outboxToMessages, useOutbox, usePolling } from "./hooks.js";
import { formatChatTime, normalizeMessageBody } from "./logic.js";
import { IconBack, IconClose, IconCheck, IconFolder, IconInbox, IconLink, IconLock, IconUserPlus } from "./icons.jsx";

const KIND_LABEL = { client: "Client", freelancer: "Freelancer guests" };

export function PortalList({ threads, selectedId, onSelect, loading }) {
  if (loading && !threads.length) return <p className="chat-muted" style={{ padding: 12 }}>Loading…</p>;
  if (!threads.length) {
    return <div className="chat-empty"><span className="glyph" aria-hidden="true"><IconInbox size={24} /></span><strong>No client or guest chats yet</strong><p>Client chats appear once a client opens their portal link. Open a project chat to invite a freelancer as a guest.</p></div>;
  }
  return threads.map((thread) => (
    <button type="button" key={thread.thread_id} className={`chat-row${selectedId === thread.thread_id ? " active" : ""}`} onClick={() => onSelect(thread.thread_id)}>
      <span className={`chat-avatar ${thread.kind}`} aria-hidden="true">{thread.kind === "client" ? <IconFolder size={18} /> : <IconUserPlus size={18} />}</span>
      <span className="chat-row-copy">
        <span className="chat-row-title"><strong>{thread.title || thread.project_name}</strong><time>{formatChatTime(thread.last_message_at)}</time></span>
        <span className="chat-row-preview">{thread.last_message_body || `${KIND_LABEL[thread.kind] || thread.kind} · ${thread.project_name}`}</span>
      </span>
      {Number(thread.unread_count) > 0 && <span className="chat-unread" aria-label={`${thread.unread_count} unread`}>{thread.unread_count > 99 ? "99+" : thread.unread_count}</span>}
    </button>
  ));
}

function GuestInvitePanel({ organizationId, thread, onClose }) {
  const [invites, setInvites] = useState([]);
  const [label, setLabel] = useState("");
  const [created, setCreated] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const load = useCallback(async () => {
    try { setInvites(await chatApi.portalGuestInvites(organizationId, thread.project_id)); } catch (e) { setError(portalErrorText(e)); }
  }, [organizationId, thread.project_id]);
  useEffect(() => { load(); }, [load]);

  const create = async (event) => {
    event.preventDefault();
    setBusy(true); setError(""); setCreated(null);
    try {
      const token = createInviteToken(); // generated here; only its hash is ever stored
      await chatApi.portalCreateGuestInvite({ organizationId, projectId: thread.project_id, label: label.trim() || "Freelancer", token });
      const url = new URL(window.location.origin + "/");
      url.searchParams.set("guest-chat", "1");
      url.hash = `t=${token}`;
      setCreated(url.toString()); setLabel(""); load();
    } catch (e) { setError(portalErrorText(e)); } finally { setBusy(false); }
  };
  const revoke = async (invite) => {
    if (!window.confirm(`Revoke access for "${invite.label}"? Their link and any active session stop working immediately.`)) return;
    try { await chatApi.portalRevokeGuestInvite(invite.invite_id); load(); } catch (e) { setError(portalErrorText(e)); }
  };
  const copy = async () => { try { await navigator.clipboard.writeText(created); setCopied(true); window.setTimeout(() => setCopied(false), 1800); } catch { setError("Copy failed. Select the link and copy it manually."); } };

  return (
    <aside className="chat-drawer" aria-label="Freelancer guest access">
      <div className="chat-drawer-head"><h3>Freelancer guests</h3><button type="button" className="chat-icon-btn sm" aria-label="Close" onClick={onClose}><IconClose size={16} /></button></div>
      <div className="chat-drawer-body">
        <form className="chat-field" onSubmit={create}>
          <span>Invite a freelancer to this project's chat</span>
          <input value={label} maxLength={80} onChange={(event) => setLabel(event.target.value)} placeholder="Name or label (e.g. Amina — colourist)" aria-label="Guest label" />
          <button type="submit" className="chat-button primary" disabled={busy}>{busy ? "Creating…" : "Create one-time link"}</button>
          <span className="chat-hint">The link works once, expires in 7 days and opens only this conversation — no login, no access to the rest of your studio. You can revoke it at any time.</span>
        </form>
        {error && <div className="chat-alert error" role="alert"><span>{error}</span></div>}
        {created && (
          <div className="chat-field">
            <span>Copy this link now — it can't be shown again</span>
            <div className="chat-copy-box"><input readOnly value={created} aria-label="Guest invite link" onFocus={(event) => event.target.select()} /><button type="button" className="chat-button" onClick={copy}>{copied ? <IconCheck size={16} /> : <IconLink size={16} />}{copied ? "Copied" : "Copy"}</button></div>
          </div>
        )}
        <div className="chat-section-label">Existing guests</div>
        {!invites.length && <p className="chat-hint" style={{ padding: "0 8px" }}>No guest invitations for this project yet.</p>}
        {invites.map((invite) => (
          <div className="chat-member" key={invite.invite_id}>
            <span className="chat-avatar sm" aria-hidden="true">{initials(invite.guest_display_name || invite.label)}</span>
            <span><strong>{invite.guest_display_name || invite.label}</strong><small>{invite.status}{invite.status === "claimed" ? ` · ${invite.active_sessions} active` : ""} · {invite.status === "pending" ? `expires ${formatChatTime(invite.expires_at)}` : `since ${formatChatTime(invite.created_at)}`}</small></span>
            {(invite.status === "pending" || invite.status === "claimed") && <button type="button" className="chat-button danger" onClick={() => revoke(invite)}>Revoke</button>}
          </div>
        ))}
      </div>
    </aside>
  );
}

function NotesPanel({ threadId, onClose }) {
  const [notes, setNotes] = useState([]);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => { try { setNotes(await chatApi.portalNotes(threadId)); } catch (e) { setError(portalErrorText(e)); } }, [threadId]);
  useEffect(() => { load(); }, [load]);
  const add = async (event) => {
    event.preventDefault();
    const body = normalizeMessageBody(text);
    if (!body) return;
    try { await chatApi.portalAddNote(threadId, body); setText(""); load(); } catch (e) { setError(portalErrorText(e)); }
  };
  return (
    <aside className="chat-drawer" aria-label="Internal notes">
      <div className="chat-drawer-head"><h3><IconLock size={14} /> Internal notes</h3><button type="button" className="chat-icon-btn sm" aria-label="Close notes" onClick={onClose}><IconClose size={16} /></button></div>
      <div className="chat-drawer-body">
        <p className="chat-hint" style={{ padding: "0 6px" }}>Notes are stored separately from the conversation and are never sent to the client or guest.</p>
        {error && <div className="chat-alert error" role="alert"><span>{error}</span></div>}
        {notes.map((note) => <div className="chat-note" key={note.id}><strong>{note.author_name}</strong> · <small>{formatChatTime(note.created_at)}</small><div>{note.body}</div></div>)}
        {!notes.length && <p className="chat-hint" style={{ padding: "0 6px" }}>No internal notes yet.</p>}
      </div>
      <form className="chat-drawer-foot" onSubmit={add}>
        <div className="chat-field"><textarea rows={3} maxLength={4000} value={text} onChange={(event) => setText(event.target.value)} placeholder="Add a private note for your team…" aria-label="Internal note" /></div>
        <button type="submit" className="chat-button primary" disabled={!text.trim()}>Save note</button>
      </form>
    </aside>
  );
}

export function PortalThread({ organizationId, userId, thread, onBack, onChanged }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState([]);
  const [composerError, setComposerError] = useState("");
  const [drawer, setDrawer] = useState(null);
  const [downloadBusy, setDownloadBusy] = useState(null);
  const [error, setError] = useState("");
  const textareaRef = useRef(null);
  const threadId = thread.thread_id;

  const load = useCallback(async () => {
    try { setRows(await chatApi.portalMessages(threadId)); setError(""); chatApi.portalMarkRead(threadId).then(onChanged).catch(() => {}); }
    catch (e) { setError(portalErrorText(e)); } finally { setLoading(false); }
  }, [threadId, onChanged]);
  useEffect(() => { setRows([]); setLoading(true); setDrawer(null); setDraft(""); setFiles([]); load(); }, [threadId]); // eslint-disable-line react-hooks/exhaustive-deps
  usePolling(load, 5000, true);

  const outbox = useOutbox({
    send: (item) => (item.files?.length
      ? chatApi.portalSendWithFiles(threadId, item.body, item.key, item.files)
      : chatApi.portalSendText(threadId, item.body, item.key)),
    onSent: () => { load(); onChanged(); },
    errorText: portalErrorText,
  });

  const submit = () => {
    const body = normalizeMessageBody(draft);
    const check = validatePortalFiles(files);
    if (check) { setComposerError(check); return; }
    if (!body && !files.length) return;
    setComposerError("");
    outbox.enqueue({ body, files, scope: threadId });
    setDraft(""); setFiles([]);
    textareaRef.current?.focus();
  };

  const messages = useMemo(() => rows.map((row) => {
    const mine = row.sender_kind === "staff" && row.sender_user_id === userId;
    const name = mine ? "You" : (row.sender_label || (row.sender_kind === "client" ? "Client" : row.sender_kind === "guest" ? "Guest" : "Studio"));
    return {
      id: row.id, senderKey: `${row.sender_kind}:${row.sender_user_id || row.sender_label}`, senderName: name, avatar: initials(name), mine,
      badge: row.sender_kind === "client" ? "Client" : row.sender_kind === "guest" ? "Guest" : row.sender_kind === "staff" && !mine ? "Studio" : "",
      body: row.body, createdAt: row.created_at, attachments: row.attachments || [], reactions: [], canReact: false, canPin: false,
    };
  }), [rows, userId]);
  const pending = useMemo(() => outboxToMessages(outbox.items.filter((item) => item.scope === threadId), { senderKey: `staff:${userId}`, senderName: "You" }), [outbox.items, threadId, userId]);

  const actions = useMemo(() => ({
    retry: (message) => outbox.retry(message.id), discard: (message) => outbox.discard(message.id),
    openAttachment: async (attachment) => {
      if (attachment.local) return;
      setDownloadBusy(attachment.id);
      let popup = null;
      try {
        popup = window.open("about:blank", "_blank"); if (popup) popup.opener = null;
        const url = await chatApi.portalDownloadUrl(attachment.id);
        if (popup) popup.location.href = url; else window.location.assign(url);
      } catch (e) { popup?.close(); setError(portalErrorText(e)); } finally { setDownloadBusy(null); }
    },
  }), [outbox]);

  return (
    <>
      <header className="chat-header">
        <button type="button" className="chat-icon-btn chat-back" aria-label="Back to conversations" onClick={onBack}><IconBack /></button>
        <span className={`chat-avatar ${thread.kind}`} aria-hidden="true">{thread.kind === "client" ? <IconFolder size={20} /> : <IconUserPlus size={20} />}</span>
        <div className="chat-header-copy"><h2>{thread.title || thread.project_name}</h2><p>{thread.kind === "client" ? `Client portal · ${thread.client_name || thread.project_name}` : `Freelancer guests · ${thread.project_name}`}</p></div>
        <button type="button" className={`chat-icon-btn${drawer === "notes" ? " on" : ""}`} aria-label="Internal notes" title="Internal notes (never shown to the client)" onClick={() => setDrawer(drawer === "notes" ? null : "notes")}><IconLock /></button>
        <button type="button" className={`chat-icon-btn${drawer === "guests" ? " on" : ""}`} aria-label="Freelancer guest access" title="Freelancer guests" onClick={() => setDrawer(drawer === "guests" ? null : "guests")}><IconUserPlus /></button>
      </header>
      <div className="chat-body">
        <MessageList conversationKey={threadId} messages={messages} outbox={pending} loading={loading} actions={actions} downloadBusyId={downloadBusy}
          notices={error ? <div className="chat-alert error" role="alert"><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Dismiss"><IconClose size={14} /></button></div> : null}
          empty={<div className="chat-empty"><strong>No messages yet</strong><p>{thread.kind === "client" ? "Replies here are visible to the client." : "Replies here are visible to the invited freelancers."}</p></div>} />
        {drawer === "notes" && <NotesPanel threadId={threadId} onClose={() => setDrawer(null)} />}
        {drawer === "guests" && <GuestInvitePanel organizationId={organizationId} thread={thread} onClose={() => setDrawer(null)} />}
      </div>
      <Composer value={draft} onChange={setDraft} onSend={submit} files={files} onFilesChange={setFiles} accept={PORTAL_ACCEPT} textareaRef={textareaRef}
        error={composerError} placeholder={thread.kind === "client" ? "Reply to the client…" : "Reply to the freelancer…"}
        footerNote={thread.kind === "client" ? "Visible to the client" : "Visible to invited guests"} label="Reply" />
    </>
  );
}
