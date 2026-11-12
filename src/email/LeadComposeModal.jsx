// CRM lead -> email composer, shown as a modal over the current CRM screen (Pipeline stays where it is).
// Same sender checks and the same ComposeDialog as the Inbox; the Inbox screen is never opened. The database still re-checks every send.
import React, { useState } from "react";
import { useLoad } from "../intelligence/kit.jsx";
import "../chat/chat.css";
import "./styles/inbox-chat.css";
import { emailApi } from "./lib/api.js";
import { leadComposeReadiness, trustedProviderRows } from "./lib/logic.js";
import ComposeDialog from "./components/ComposeDialog.jsx";

function Notice({ children, onClose }) {
  return (
    <div className="chat-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="chat-modal" role="dialog" aria-modal="true" aria-label="Email">
        <div className="chat-modal-body" style={{ paddingTop: 18 }}>{children}</div>
        <div className="chat-modal-foot"><button type="button" className="chat-button" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

/** request: { leadId, to, label } from leadComposeTarget(). onSent(leadId) runs after a successful send; the modal then closes itself. */
export default function LeadComposeModal({ supabase, request, onClose, onSent, theme = "dark" }) {
  const accounts = useLoad(() => emailApi.accounts(supabase), [supabase]);
  const providers = useLoad(() => emailApi.providers(supabase), [supabase]);
  const [composer, setComposer] = useState(() => ({ title: `Email ${request.label || request.to}`, to: request.to, crmLeadId: request.leadId, crmLeadLabel: request.label || "" }));

  const readiness = leadComposeReadiness({ accounts, providers });
  const accts = Array.isArray(accounts.data) ? accounts.data : [];
  // A stale registry must never authorize a send after a failed refresh (same rule as the Inbox).
  const providerRows = trustedProviderRows(providers.data, providers.error);
  const sendProviderRows = accounts.error ? [] : providerRows;

  let body;
  if (readiness === "waiting") body = <Notice onClose={onClose}><p className="chat-hint">Loading your email accounts…</p></Notice>;
  else if (readiness === "error") body = <Notice onClose={onClose}><div className="chat-alert error" role="alert"><span>Could not verify your email accounts{accounts.error || providers.error ? `: ${accounts.error || providers.error}` : ""}. Close this and try again.</span></div></Notice>;
  else if (readiness === "unavailable") body = <Notice onClose={onClose}><p>No connected sender can send right now. Connect or reauthorize an email account in Settings \u2192 Intelligence \u2192 Email accounts, then try again.</p></Notice>;
  else body = (
    <ComposeDialog
      key={composer.title}
      supabase={supabase}
      accounts={accts}
      providers={sendProviderRows}
      initial={composer}
      onClose={onClose}
      onCopyToNew={(draft) => setComposer({ title: "New message", ...draft })}
      onSent={() => { onSent?.(request.leadId); onClose(); }}
    />
  );

  return <div className={`chat-root chat-theme-${theme}`} style={{ position: "fixed", inset: 0, zIndex: 10050 }}>{body}</div>;
}
