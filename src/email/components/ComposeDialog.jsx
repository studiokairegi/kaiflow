import React, { useRef, useState } from "react";
import { useBusy } from "../../finance/ui.jsx";
import { confirmAction } from "../../intelligence/kit.jsx";
import { IconClose } from "../../chat/icons.jsx";
import { emailApi } from "../lib/api.js";
import { accountCanSend, accountConnectionLabel, attachmentProblem, composeProblem, parseRecipients, providerForAccount, textToHtml } from "../lib/logic.js";
import { newKey, shouldRotateSendKey } from "../lib/helpers.js";

// Dialog for brand-new emails, forwards and saved drafts: the only place To and Subject are typed.
export default function ComposeDialog({ supabase, accounts, providers = [], initial, onClose, onSent }) {
  const [f, setF] = useState({ accountId: initial.accountId || accounts[0]?.id || "", to: initial.to || "", cc: initial.cc || "", bcc: initial.bcc || "", subject: initial.subject || "", body: initial.body || "" });
  const [files, setFiles] = useState([]);
  const [showCc, setShowCc] = useState(Boolean(initial.cc || initial.bcc));
  const [draftId, setDraftId] = useState(initial.draftId || null);
  const [conversationId, setConversationId] = useState(initial.conversationId || null);
  const key = useRef(newKey());
  const sendState = useBusy();
  const draftState = useBusy();
  const set = (k) => (e) => setF((old) => ({ ...old, [k]: e.target.value }));
  const selectedAccount = accounts.find((a) => a.id === f.accountId) || null;
  const selectedProvider = providerForAccount(selectedAccount, providers);
  const accountProblem = selectedAccount && !accountCanSend(selectedAccount, providers)
    ? `${selectedProvider?.display_name || "This provider"} account is not currently available for sending (${accountConnectionLabel(selectedAccount, providers)}).`
    : "";
  const problem = accountProblem || composeProblem(f) || attachmentProblem(files);
  const lists = () => ({ to: parseRecipients(f.to).valid, cc: parseRecipients(f.cc).valid, bcc: parseRecipients(f.bcc).valid });

  const saveDraft = () => draftState.run(async () => {
    const r = await emailApi.saveDraft(supabase, { draftId, conversationId, accountId: f.accountId, ...lists(), subject: f.subject, text: f.body, html: "" });
    setDraftId(r.draft_id); setConversationId(r.conversation_id);
  });
  const send = () => sendState.run(async () => {
    if (problem) throw new Error(problem);
    try {
      const result = await emailApi.send(supabase, { accountId: f.accountId, ...lists(), subject: f.subject.trim(), text: f.body, html: textToHtml(f.body), conversationId, draftId, key: key.current, files, crmLeadId: initial.crmLeadId || null });
      if (result?.warning === "crm_activity_pending") {
        const e = new Error("Email sent successfully, but its CRM activity is still pending. Retry Send to repair the CRM entry; the same request key prevents another email from being submitted.");
        e.outcome = result.outcome || "accepted";
        throw e;
      }
      if (result?.warning === "sent_status_not_saved") {
        const e = new Error("The provider accepted this email, but KairFlow could not save its sent status. Do not create a new send; check Sent and retry only with this same request key.");
        e.outcome = result.outcome || "accepted";
        throw e;
      }
    } catch (e) {
      if (shouldRotateSendKey(e)) key.current = newKey();
      // Keep the key for timeouts, 202/unknown, unreadable responses and pre-send refusals.
      // Retrying those with a fresh key could submit the same logical email twice.
      throw e;
    }
    await onSent();
  });
  const discard = async () => {
    if (draftId && confirmAction("Delete this draft?")) { try { await emailApi.deleteDraft(supabase, draftId); } catch { /* already gone */ } onSent(); return; }
    onClose();
  };
  const err = sendState.error || draftState.error;

  return (
    <div className="chat-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="chat-modal inbox-compose" role="dialog" aria-modal="true" aria-labelledby="inbox-compose-title">
        <div className="chat-modal-head"><h2 id="inbox-compose-title">{initial.title || "New message"}</h2><button type="button" className="chat-icon-btn" onClick={onClose} aria-label="Close"><IconClose /></button></div>
        <div className="chat-modal-body">
          {err && <div className="chat-alert error" role="alert"><span>{err}</span></div>}
          <label className="chat-field">From
            <select value={f.accountId} onChange={set("accountId")} disabled={Boolean(draftId || conversationId)} title={draftId || conversationId ? "The sender of a saved draft or an existing conversation cannot be changed" : undefined}>
              {accounts.map((a) => {
                const provider = providerForAccount(a, providers);
                const available = accountCanSend(a, providers);
                return <option key={a.id} value={a.id} disabled={!available}>{`${provider?.display_name || a.provider || "Email"} · ${a.display_name ? `${a.display_name} <${a.address}>` : a.address}${available ? "" : ` · ${accountConnectionLabel(a, providers)}`}`}</option>;
              })}
            </select>
            {selectedAccount && <span className="chat-hint">{selectedProvider?.display_name || selectedAccount.provider} · {accountConnectionLabel(selectedAccount, providers)}</span>}
          </label>
          <label className="chat-field">To<input value={f.to} onChange={set("to")} placeholder="name@example.com, separate several with commas" autoFocus={!initial.to} /></label>
          {showCc ? <div className="inbox-compose-two">
            <label className="chat-field">Cc<input value={f.cc} onChange={set("cc")} /></label>
            <label className="chat-field">Bcc<input value={f.bcc} onChange={set("bcc")} /></label>
          </div> : <div><button type="button" className="chat-link-btn" onClick={() => setShowCc(true)}>Add Cc / Bcc</button></div>}
          <label className="chat-field">Subject<input value={f.subject} onChange={set("subject")} /></label>
          <label className="chat-field">Message<textarea rows={8} value={f.body} onChange={set("body")} /></label>
          <label className="chat-field">Attachments<input type="file" multiple onChange={(e) => setFiles(Array.from(e.target.files || []))} /><span className="chat-hint">Up to 10 files, 10 MB in total.</span></label>
          {problem && <p className="chat-hint">{problem}</p>}
        </div>
        <div className="chat-modal-foot">
          <button type="button" className="chat-button quiet" onClick={discard}>{draftId ? "Delete draft" : "Discard"}</button>
          <button type="button" className="chat-button" disabled={draftState.busy || sendState.busy || !f.accountId} onClick={saveDraft}>Save draft</button>
          <button type="button" className="chat-button primary" disabled={sendState.busy || Boolean(problem)} onClick={send}>{sendState.busy ? "Sending…" : "Send"}</button>
        </div>
      </div>
    </div>
  );
}
