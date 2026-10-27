import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Composer from "./Composer.jsx";
import MessageList from "./MessageList.jsx";
import { initials, outboxToMessages, useOutbox, usePolling } from "./hooks.js";
import { normalizeMessageBody } from "./logic.js";
import { PORTAL_ACCEPT, portalErrorText, validatePortalFiles } from "./portalApi.js";
import { IconClose, IconLock } from "./icons.jsx";

// Shared thread UI for the two token-based audiences. It never receives internal notes (they are a
// separate table the gateway cannot read) and shows only sender labels, never ids or emails.
export default function PortalChatSurface({ list, send, download, selfKind, selfLabel, title, subtitle, onInvalid, placeholder = "Write a message…", footerNote = "" }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState([]);
  const [composerError, setComposerError] = useState("");
  const [error, setError] = useState("");
  const [downloadBusy, setDownloadBusy] = useState(null);
  const textareaRef = useRef(null);
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  const handleError = useCallback((e) => {
    if (e?.code === "invalid_credential") { onInvalid?.(); return; }
    setError(e?.message || portalErrorText(""));
  }, [onInvalid]);

  const load = useCallback(async () => {
    try { const result = await list(); if (aliveRef.current) { setRows(result.messages || []); setError(""); } }
    catch (e) { if (aliveRef.current) handleError(e); }
    finally { if (aliveRef.current) setLoading(false); }
  }, [list, handleError]);
  useEffect(() => { load(); }, [load]);
  usePolling(load, 4000, true);

  const outbox = useOutbox({
    send: (item) => send(item.body, item.key, item.files),
    onSent: () => load(),
    errorText: (e) => e?.message || portalErrorText(""),
  });

  const submit = () => {
    const body = normalizeMessageBody(draft);
    const problem = validatePortalFiles(files);
    if (problem) { setComposerError(problem); return; }
    if (!body && !files.length) return;
    if (body.length > 4000) { setComposerError(portalErrorText("message_too_long")); return; }
    setComposerError("");
    outbox.enqueue({ body, files });
    setDraft(""); setFiles([]);
    textareaRef.current?.focus();
  };

  const messages = useMemo(() => rows.map((row) => {
    const mine = row.sender_kind === selfKind && (selfKind === "client" || row.sender_label === selfLabel);
    const name = mine ? "You" : (row.sender_label || (row.sender_kind === "staff" ? "Studio" : "Guest"));
    return {
      id: row.id, senderKey: `${row.sender_kind}:${row.sender_label}`, senderName: name, avatar: initials(name), mine,
      badge: row.sender_kind === "staff" ? "Studio" : "", body: row.body, createdAt: row.created_at, attachments: row.attachments || [],
      reactions: [], canReact: false, canPin: false,
    };
  }), [rows, selfKind, selfLabel]);
  const pending = useMemo(() => outboxToMessages(outbox.items, { senderKey: `${selfKind}:${selfLabel}`, senderName: "You" }), [outbox.items, selfKind, selfLabel]);

  const actions = useMemo(() => ({
    retry: (m) => outbox.retry(m.id), discard: (m) => outbox.discard(m.id),
    openAttachment: async (attachment) => {
      if (attachment.local) return;
      setDownloadBusy(attachment.id);
      let popup = null;
      try {
        popup = window.open("about:blank", "_blank"); if (popup) popup.opener = null;
        const result = await download(attachment.id);
        if (popup) popup.location.href = result.url; else window.location.assign(result.url);
      } catch (e) { popup?.close(); handleError(e); } finally { setDownloadBusy(null); }
    },
  }), [outbox, download, handleError]);

  return (
    <>
      <header className="chat-header">
        <span className="chat-avatar" aria-hidden="true">{initials(title)}</span>
        <div className="chat-header-copy"><h2>{title}</h2><p>{subtitle}</p></div>
        <span className="chat-live on" title="Private conversation"><IconLock size={14} /></span>
      </header>
      <div className="chat-body">
        <MessageList conversationKey="portal" messages={messages} outbox={pending} loading={loading} actions={actions} downloadBusyId={downloadBusy}
          notices={error ? <div className="chat-alert error" role="alert"><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Dismiss"><IconClose size={14} /></button></div> : null}
          empty={<div className="chat-empty"><strong>No messages yet</strong><p>Say hello — the studio will reply here.</p></div>} />
      </div>
      <Composer value={draft} onChange={setDraft} onSend={submit} files={files} onFilesChange={setFiles} accept={PORTAL_ACCEPT}
        textareaRef={textareaRef} error={composerError} placeholder={placeholder} maxLength={4000} footerNote={footerNote} />
    </>
  );
}
