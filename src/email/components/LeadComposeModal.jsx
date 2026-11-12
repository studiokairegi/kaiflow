// CRM lead email composer: opens as a modal directly over the CRM (no Inbox tab switch).
// It reuses the existing ComposeDialog (sender selector, availability checks, drafts, attachments, send path and CRM activity
// recording), so no second send path exists. Accounts and providers are loaded here and must verify cleanly before the dialog opens.
import React from "react";
import { Banner } from "../../finance/ui.jsx";
import { useLoad } from "../../intelligence/kit.jsx";
import { IconClose } from "../../chat/icons.jsx";
import "../../chat/chat.css";
import "../styles/inbox-chat.css";
import { emailApi } from "../lib/api.js";
import { leadComposeReadiness, trustedProviderRows } from "../lib/logic.js";
import ComposeDialog from "./ComposeDialog.jsx";

// Above the lead editor overlay (z-index 100) it opens from.
const WRAP = { position: "fixed", inset: 0, zIndex: 200 };

function Notice({ onClose, children }) {
  return (
    <div className="chat-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="chat-modal" role="dialog" aria-modal="true" aria-label="Compose email">
        <div className="chat-modal-head"><h2>Compose email</h2><button type="button" className="chat-icon-btn" onClick={onClose} aria-label="Close"><IconClose /></button></div>
        <div className="chat-modal-body">{children}</div>
        <div className="chat-modal-foot"><button type="button" className="chat-button" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

/** target: result of leadComposeTarget(lead, userId) — { leadId, to, label }. onSent(leadId) fires after a successful send. */
export default function LeadComposeModal({ supabase, target, onClose, onSent }) {
  const accounts = useLoad(() => emailApi.accounts(supabase), [supabase, target?.leadId]);
  const providers = useLoad(() => emailApi.providers(supabase), [supabase, target?.leadId]);
  if (!target) return null;
  const readiness = leadComposeReadiness({ accounts, providers });
  let content;
  if (readiness === "waiting") {
    content = <Notice onClose={onClose}><p className="chat-hint">Loading your sender accounts…</p></Notice>;
  } else if (readiness === "error") {
    content = <Notice onClose={onClose}><Banner tone="bad">Could not verify your email accounts: {String(accounts.error || providers.error)}</Banner></Notice>;
  } else if (readiness === "unavailable") {
    content = <Notice onClose={onClose}><Banner tone="warn">No connected sender can send right now. Connect or reauthorize an email account, then try again.</Banner></Notice>;
  } else {
    const accts = Array.isArray(accounts.data) ? accounts.data : [];
    const sendProviders = trustedProviderRows(providers.data, providers.error);
    content = (
      <ComposeDialog
        supabase={supabase}
        accounts={accts}
        providers={sendProviders}
        initial={{ title: `Email ${target.label || target.to}`, to: target.to, crmLeadId: target.leadId, crmLeadLabel: target.label || "" }}
        onClose={onClose}
        onSent={async () => { onSent?.(target.leadId); onClose(); }}
      />
    );
  }
  return <div className="chat-root" style={WRAP}>{content}</div>;
}
