import React, { useCallback, useEffect, useMemo, useState } from "react";
import PortalChatSurface from "./PortalChatSurface.jsx";
import { guestApi } from "./portalApi.js";
import { useVisualViewport } from "./hooks.js";
import "./chat.css";

const SESSION_KEY = "kf_guest_chat_session";
const INVITE_KEY = "kf_guest_chat_invite";
const HEX64 = /^[0-9a-f]{64}$/;

const read = (storage, key) => { try { return storage.getItem(key); } catch { return null; } };
const write = (storage, key, value) => { try { if (value == null) storage.removeItem(key); else storage.setItem(key, value); } catch { /* storage can be blocked; the page then works for this visit only */ } };

function loadSavedSession() {
  try {
    const saved = JSON.parse(read(window.localStorage, SESSION_KEY) || "null");
    if (saved && HEX64.test(saved.session || "") && Date.parse(saved.expires_at) > Date.now()) return saved;
  } catch { /* fall through */ }
  write(window.localStorage, SESSION_KEY, null);
  return null;
}

// Freelancer guest chat: no login. The one-time invite token arrives in the URL *fragment* (never sent
// to servers or logged), is moved to sessionStorage immediately, and is exchanged for a revocable
// session. Only the session's hash is stored server-side.
export default function GuestChatPage() {
  useVisualViewport();
  const [session, setSession] = useState(() => loadSavedSession());
  const [invite, setInvite] = useState(() => {
    const match = /(?:^#|&)t=([0-9a-f]{64})/i.exec(window.location.hash || "");
    if (match) { write(window.sessionStorage, INVITE_KEY, match[1].toLowerCase()); window.history.replaceState(null, "", window.location.pathname + window.location.search); }
    return read(window.sessionStorage, INVITE_KEY);
  });
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { document.title = "Studio chat"; }, []);

  const join = async (event) => {
    event.preventDefault();
    if (!invite || busy) return;
    setBusy(true); setError("");
    try {
      const result = await guestApi.claim(invite, name.trim());
      const saved = { session: result.session, display_name: result.display_name, project_name: result.project_name, expires_at: result.expires_at };
      write(window.localStorage, SESSION_KEY, JSON.stringify(saved));
      write(window.sessionStorage, INVITE_KEY, null);
      setInvite(null); setSession(saved);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const leave = useCallback(() => { write(window.localStorage, SESSION_KEY, null); setSession(null); }, []);
  const onInvalid = useCallback(() => { write(window.localStorage, SESSION_KEY, null); setSession(null); setError("Your access was ended or has expired. Ask the studio for a new link."); }, []);
  const sessionToken = session?.session;
  const api = useMemo(() => sessionToken ? {
    list: () => guestApi.list(sessionToken),
    send: (body, key, files) => guestApi.send(sessionToken, body, key, files),
    download: (id) => guestApi.download(sessionToken, id),
  } : null, [sessionToken]);

  if (session && api) {
    return (
      <div className="chat-root chat-theme-auto chat-standalone-wrap">
        <div className="chat-standalone">
          <PortalChatSurface {...api} selfKind="guest" selfLabel={session.display_name} title={session.project_name || "Project chat"}
            subtitle={`Chatting as ${session.display_name} · private to this project`} onInvalid={onInvalid} pushWho={{ audience: "guest", session: sessionToken }} footerNote="Only the studio can see this conversation" />
          <div className="chat-composer-foot" style={{ justifyContent: "center", background: "var(--c-panel)", paddingBottom: 8 }}><button type="button" className="chat-link-btn" onClick={leave}>Leave this chat on this device</button></div>
        </div>
      </div>
    );
  }
  if (invite) {
    return (
      <div className="chat-root chat-theme-auto chat-gate">
        <h1>Join the project chat</h1>
        <p>You've been invited to talk with the studio about a project. No account needed.</p>
        <form className="chat-field" onSubmit={join} style={{ width: "min(340px, 100%)", textAlign: "left" }}>
          Your name
          <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. Amina" aria-label="Your name" autoFocus required />
          {error && <div className="chat-alert error" role="alert"><span>{error}</span></div>}
          <button type="submit" className="chat-button primary" disabled={busy || !name.trim()}>{busy ? "Joining…" : "Join chat"}</button>
          <span className="chat-hint">This link works once. After joining, this device stays signed in to the chat for 30 days unless the studio revokes access.</span>
        </form>
      </div>
    );
  }
  return (
    <div className="chat-root chat-theme-auto chat-gate">
      <h1>This chat link isn't active</h1>
      <p>{error || "The link may have expired, been used already, or been revoked. Ask the studio for a new one."}</p>
    </div>
  );
}
