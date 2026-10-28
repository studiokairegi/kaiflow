import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Composer from "./Composer.jsx";
import MessageList from "./MessageList.jsx";
import { initials, outboxToMessages, useOutbox, usePolling } from "./hooks.js";
import { normalizeMessageBody } from "./logic.js";
import { PORTAL_ACCEPT, portalErrorText, validatePortalFiles } from "./portalApi.js";
import { IconBell, IconBellOff, IconClose, IconLock } from "./icons.jsx";
import { currentSubscription, enablePush, pushSupported } from "../push/pushClient.js";
import {
  findIncoming, notificationPermission, playIncomingTone, previewBody, readSoundPreference, requestNotificationPermission,
  showDesktopNotification, unlockAudioOnGesture, writeSoundPreference,
} from "./notify.js";

// Shared thread UI for the two token-based audiences. It never receives internal notes (they are a
// separate table the gateway cannot read) and shows only sender labels, never ids or emails.
export default function PortalChatSurface({ list, send, download, selfKind, selfLabel, title, subtitle, onInvalid, placeholder = "Write a message…", footerNote = "", pushWho = null }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState([]);
  const [composerError, setComposerError] = useState("");
  const [error, setError] = useState("");
  const [downloadBusy, setDownloadBusy] = useState(null);
  const [soundOn, setSoundOn] = useState(() => readSoundPreference());
  const [permission, setPermission] = useState(() => notificationPermission());
  const [unreadWhileAway, setUnreadWhileAway] = useState(0);
  const [pushOn, setPushOn] = useState(null); // null = not checked yet
  const [pushNote, setPushNote] = useState("");
  const pushCanRun = Boolean(pushWho) && pushSupported();
  useEffect(() => {
    let live = true;
    if (!pushCanRun) return undefined;
    currentSubscription().then((sub) => { if (live) setPushOn(Boolean(sub) && notificationPermission() === "granted"); });
    return () => { live = false; };
  }, [pushCanRun]);
  const turnOnPush = async () => {
    setPushNote("");
    const result = await enablePush(pushWho, { enabled: true });
    setPermission(notificationPermission());
    if (result.ok) setPushOn(true);
    else setPushNote(result.reason === "denied" ? "Alerts are blocked in your browser settings for this site." : "Couldn't turn on alerts here. Try again later.");
  };
  const textareaRef = useRef(null);
  const aliveRef = useRef(true);
  const seenRef = useRef(null); // ids already shown; null until the first load so history never rings
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
  usePolling(load, 4000, true, { hidden: true });

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

  const isMine = useCallback((row) => row.sender_kind === selfKind && (selfKind === "client" || row.sender_label === selfLabel), [selfKind, selfLabel]);

  // Notify when someone else writes: a tone, a desktop notification if the tab is in the background,
  // and an unread count in the tab title. The first load only records history.
  useEffect(() => unlockAudioOnGesture(), []);
  useEffect(() => {
    if (loading) return;
    if (seenRef.current === null) { seenRef.current = new Set(rows.map((row) => row.id)); return; }
    const incoming = findIncoming(rows, seenRef.current, isMine);
    rows.forEach((row) => seenRef.current.add(row.id));
    if (!incoming.length) return;
    const away = document.visibilityState === "hidden" || !document.hasFocus();
    if (soundOn) playIncomingTone();
    if (away) {
      setUnreadWhileAway((count) => count + incoming.length);
      const latest = incoming[incoming.length - 1];
      showDesktopNotification(`${latest.sender_label || "Studio"} · new message`, previewBody(latest), () => setUnreadWhileAway(0));
    }
  }, [rows, loading, isMine, soundOn]);
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\)\s*/, "");
    document.title = unreadWhileAway > 0 ? `(${unreadWhileAway}) ${base}` : base;
    const clear = () => { if (document.visibilityState === "visible") setUnreadWhileAway(0); };
    document.addEventListener("visibilitychange", clear); window.addEventListener("focus", clear);
    return () => { document.removeEventListener("visibilitychange", clear); window.removeEventListener("focus", clear); document.title = base; };
  }, [unreadWhileAway]);

  const messages = useMemo(() => rows.map((row) => {
    const mine = isMine(row);
    const name = mine ? "You" : (row.sender_label || (row.sender_kind === "staff" ? "Studio" : "Guest"));
    return {
      id: row.id, senderKey: `${row.sender_kind}:${row.sender_label}`, senderName: name, avatar: initials(name), mine,
      badge: row.sender_kind === "staff" ? "Studio" : "", body: row.body, createdAt: row.created_at, attachments: row.attachments || [],
      reactions: [], canReact: false, canPin: false,
    };
  }), [rows, isMine]);
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
        <button type="button" className={`chat-icon-btn${soundOn ? " on" : ""}`} aria-pressed={soundOn} aria-label={soundOn ? "Mute message sounds" : "Turn on message sounds"} title={soundOn ? "Sound on" : "Sound off"}
          onClick={() => { const next = !soundOn; setSoundOn(next); writeSoundPreference(next); if (next) playIncomingTone(); }}>{soundOn ? <IconBell /> : <IconBellOff />}</button>
      </header>
      {pushCanRun && pushOn === false && permission !== "denied" ? (
        <div className="chat-alert info" style={{ margin: "8px 12px 0" }} role="status">
          <span>Get an alert when the studio replies, even after you close this page.</span>
          <button type="button" className="chat-link-btn" onClick={turnOnPush}>Turn on alerts</button>
        </div>
      ) : !pushCanRun && permission === "default" ? (
        <div className="chat-alert info" style={{ margin: "8px 12px 0" }} role="status">
          <span>Get a desktop alert when the studio replies while this tab is in the background.</span>
          <button type="button" className="chat-link-btn" onClick={async () => setPermission(await requestNotificationPermission())}>Turn on alerts</button>
        </div>
      ) : null}
      {pushNote && <div className="chat-alert error" style={{ margin: "8px 12px 0" }} role="alert"><span>{pushNote}</span><button type="button" onClick={() => setPushNote("")} aria-label="Dismiss"><IconClose size={14} /></button></div>}
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
