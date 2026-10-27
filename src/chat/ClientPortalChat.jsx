import React, { useMemo, useState } from "react";
import PortalChatSurface from "./PortalChatSurface.jsx";
import { clientApi, freelancerApi } from "./portalApi.js";
import "./chat.css";

// Embedded in the Client Portal. The credential is the project's existing share token. Replies the
// studio posts here are visible to the client; internal notes live in a different table and are
// never returned by this gateway.
export default function ClientPortalChat({ token, defaultName = "", kind = "client" }) {
  const isFreelancer = kind === "freelancer";
  const remote = isFreelancer ? freelancerApi : clientApi;
  const nameKey = isFreelancer ? "kf_freelancer_chat_name" : "kf_client_chat_name";
  const [name, setName] = useState(() => { try { return window.localStorage.getItem(nameKey) || defaultName; } catch { return defaultName; } });
  const [editing, setEditing] = useState(!name);
  const [draftName, setDraftName] = useState(name);
  const [expired, setExpired] = useState(false);
  const label = name.trim() || (isFreelancer ? "Freelancer" : "Client");
  const api = useMemo(() => ({
    list: () => remote.list(token),
    send: (body, key, files) => remote.send(token, label, body, key, files),
    download: (id) => remote.download(token, id),
  }), [token, label, remote]);

  if (expired) return <div className="chat-root chat-theme-auto chat-embed"><div className="chat-empty"><strong>Chat unavailable</strong><p>This link no longer has chat access. Ask the studio for a new one.</p></div></div>;
  if (editing) {
    return (
      <div className="chat-root chat-theme-auto chat-embed">
        <form className="chat-gate" style={{ minHeight: 0, height: "100%" }} onSubmit={(e) => { e.preventDefault(); const next = draftName.trim(); if (!next) return; setName(next); setEditing(false); try { window.localStorage.setItem(nameKey, next); } catch { /* optional */ } }}>
          <h2 style={{ margin: 0 }}>Message the studio</h2>
          <p>Tell us who's writing so the team knows who they're talking to.</p>
          <label className="chat-field" style={{ width: "min(320px, 100%)", textAlign: "left" }}>Your name<input value={draftName} maxLength={60} onChange={(e) => setDraftName(e.target.value)} autoFocus required /></label>
          <button type="submit" className="chat-button primary" disabled={!draftName.trim()}>Start chatting</button>
        </form>
      </div>
    );
  }
  return (
    <div className="chat-root chat-theme-auto chat-embed">
      <PortalChatSurface {...api} selfKind={isFreelancer ? "guest" : "client"} selfLabel={label} title={isFreelancer ? "Chat with the studio" : "Studio chat"} subtitle={`Writing as ${label}`} onInvalid={() => setExpired(true)}
        placeholder="Write to the studio…" footerNote="Visible to the studio team" />
    </div>
  );
}
