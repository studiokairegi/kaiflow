// KairFlow Inbox: chat-style presentation over the existing Resend email infrastructure.
// Reads, writes, permissions, threading and delivery events remain owned by emailApi/database functions.
import React, { useEffect, useRef, useState } from "react";
import { S, T, Banner, Btn, Field, Pill, Tabs, useBusy } from "../finance/ui.jsx";
import { canAccessIntelligence } from "../intelligence/access.js";
import { Input, Muted, Section, Select, useLoad, confirmAction } from "../intelligence/kit.jsx";
import MessageBody from "../chat/MessageBody.jsx";
import ChatComposer from "../chat/Composer.jsx";
import "../chat/chat.css";
import "./inbox.css";
import { emailApi } from "./api.js";
import { FOLDERS, attachmentProblem, buildForward, buildReply, composeProblem, fmtSize, isProblem, parseRecipients, participantLabel, statusLabel, textToHtml } from "./logic.js";

const newKey = () => `kf-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");

function SetupAccount({ supabase, onDone }) {
  const [address, setAddress] = useState("");
  const [name, setName] = useState("Studio Kairegi");
  const { busy, error, run } = useBusy();
  return <Section title="Add your sending address" hint="Use an address on a domain verified in Resend. Replies arrive here once receiving records are configured.">
    {error && <Banner tone="bad">{error}</Banner>}
    <div style={S.grid(240)}><Field label="Address"><Input type="email" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="name@yourdomain.com" /></Field><Field label="Display name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field></div>
    <div><Btn kind="primary" disabled={busy || !address.trim()} onClick={() => run(async () => { await emailApi.addAccount(supabase, address, name); await onDone(); })}>Save address</Btn></div>
  </Section>;
}

function Composer({ supabase, accounts, initial, onClose, onSent }) {
  const [f, setF] = useState({ accountId: initial.accountId || accounts[0]?.id || "", to: initial.to || "", cc: initial.cc || "", bcc: initial.bcc || "", subject: initial.subject || "", body: initial.body || "" });
  const [files, setFiles] = useState([]);
  const [showCc, setShowCc] = useState(Boolean(initial.cc || initial.bcc));
  const [draftId, setDraftId] = useState(initial.draftId || null);
  const [conversationId, setConversationId] = useState(initial.conversationId || null);
  const key = useRef(newKey());
  const sendState = useBusy();
  const draftState = useBusy();
  const set = (k) => (e) => setF((old) => ({ ...old, [k]: e.target.value }));
  const problem = composeProblem(f) || attachmentProblem(files);
  const lists = () => ({ to: parseRecipients(f.to).valid, cc: parseRecipients(f.cc).valid, bcc: parseRecipients(f.bcc).valid });
  const saveDraft = () => draftState.run(async () => {
    const r = await emailApi.saveDraft(supabase, { draftId, conversationId, accountId: f.accountId, ...lists(), subject: f.subject, text: f.body, html: "" });
    setDraftId(r.draft_id); setConversationId(r.conversation_id);
  });
  const send = () => sendState.run(async () => {
    if (problem) throw new Error(problem);
    try { await emailApi.send(supabase, { accountId: f.accountId, ...lists(), subject: f.subject.trim(), text: f.body, html: textToHtml(f.body), conversationId, draftId, key: key.current, files }); }
    catch (e) { key.current = newKey(); throw e; }
    await onSent();
  });
  const discard = async () => {
    if (draftId && confirmAction("Delete this draft?")) { try { await emailApi.deleteDraft(supabase, draftId); } catch { /* already gone */ } onSent(); return; }
    onClose();
  };
  return <div className="inbox-compose-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <section className="inbox-compose chat-modal" role="dialog" aria-modal="true" aria-label={initial.title || "New chat"}>
      <header className="chat-modal-head"><div><h2>{initial.title || "New chat"}</h2><p className="chat-muted">A real email conversation, in your KairFlow chat.</p></div><button className="chat-icon-btn" type="button" aria-label="Close" onClick={onClose}>×</button></header>
      <div className="inbox-compose-fields">
        {sendState.error && <div className="chat-composer-error" role="alert">{sendState.error}</div>}
        {draftState.error && <div className="chat-composer-error" role="alert">{draftState.error}</div>}
        <label className="chat-field">From<select value={f.accountId} onChange={set("accountId")}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.display_name ? `${a.display_name} <${a.address}>` : a.address}</option>)}</select></label>
        <label className="chat-field">To<input type="text" value={f.to} onChange={set("to")} placeholder="name@example.com" autoFocus /></label>
        {showCc && <div className="inbox-compose-two"><label className="chat-field">Cc<input value={f.cc} onChange={set("cc")} placeholder="Optional" /></label><label className="chat-field">Bcc<input value={f.bcc} onChange={set("bcc")} placeholder="Optional" /></label></div>}
        {!showCc && <button className="chat-link-btn" type="button" onClick={() => setShowCc(true)}>Add Cc / Bcc</button>}
        <label className="chat-field">Subject<input value={f.subject} onChange={set("subject")} placeholder="Subject" /></label>
      </div>
      <ChatComposer value={f.body} onChange={(body) => setF((old) => ({ ...old, body }))} onSend={send} sending={sendState.busy} files={files} onFilesChange={setFiles} canAttach accept="" placeholder="Write a message…" label="Email message" error={problem} footerNote="Enter sends · Shift + Enter for a new line" />
      <div className="inbox-compose-actions"><button type="button" className="chat-button quiet" onClick={discard}>{draftId ? "Delete draft" : "Discard"}</button><button type="button" className="chat-button quiet" disabled={draftState.busy || sendState.busy || !f.accountId} onClick={saveDraft}>{draftState.busy ? "Saving…" : "Save draft"}</button></div>
    </section>
  </div>;
}

function EmailMessage({ m, supabase, onEditDraft, onReply, onReplyAll, onForward }) {
  const inbound = m.direction === "inbound";
  const [label, tone] = statusLabel(m.status);
  const open = async (att) => { try { window.open(await emailApi.attachmentUrl(supabase, att.storage_path), "_blank", "noopener"); } catch (e) { window.alert(e.message); } };
  const people = inbound ? `From: ${m.from_name ? `${m.from_name} ` : ""}${m.from_email || "Unknown sender"}` : `To: ${(m.to_emails || []).join(", ") || "—"}`;
  return <article className={`chat-msg ${inbound ? "theirs" : "mine"} inbox-email-message`}>
    {inbound && <span className="chat-msg-avatar" aria-hidden="true">{(m.from_name || m.from_email || "?").slice(0, 1).toUpperCase()}</span>}
    <div className="chat-msg-main">
      <div className="chat-msg-meta">{inbound && <strong>{m.from_name || m.from_email}</strong>}<time dateTime={m.received_at || m.sent_at || m.created_at}>{when(m.received_at || m.sent_at || m.created_at)}</time>{m.ai_generated && <span className="chat-badge">AI draft · review</span>}</div>
      <div className="chat-bubble inbox-email-bubble">
        <div className="inbox-email-meta"><strong>{m.subject || "(no subject)"}</strong><span>{people}</span>{m.cc_emails?.length > 0 && <span>Cc: {m.cc_emails.join(", ")}</span>}{!inbound && m.bcc_emails?.length > 0 && <span>Bcc: {m.bcc_emails.join(", ")}</span>}</div>
        <div className="inbox-email-body"><MessageBody body={m.body_text || "(no text content)"} /></div>
        {m.attachments?.length > 0 && <div className="chat-attachments">{m.attachments.map((a) => <button key={a.id} type="button" className="chat-attachment" disabled={!a.storage_path} onClick={() => open(a)} title={a.storage_path ? "Open attachment" : "Not stored (too large)"}><span className="chat-attachment-icon">↧</span><span className="chat-attachment-copy"><strong>{a.filename}</strong><small>{fmtSize(a.size_bytes)} · {a.storage_path ? "Open" : "Unavailable"}</small></span></button>)}</div>}
        <div className={`inbox-email-status ${inbound ? "received" : tone}`} title={m.error || undefined}>{inbound ? "Received" : isProblem(m.status) ? `${label}${m.error ? ` · ${m.error}` : ""}` : m.status === "queued" ? "Sending" : label}</div>
      </div>
      <div className="inbox-message-actions">{m.status === "draft" ? <button type="button" className="chat-link-btn" onClick={() => onEditDraft(m)}>Edit draft</button> : <><button type="button" className="chat-link-btn" onClick={() => onReply(m)}>Reply</button><button type="button" className="chat-link-btn" onClick={() => onReplyAll(m)}>Reply all</button><button type="button" className="chat-link-btn" onClick={() => onForward(m)}>Forward</button></>}</div>
    </div>
  </article>;
}

export default function InboxModule({ supabase, access, leads = [], onOpenLead }) {
  const [folder, setFolder] = useState("inbox");
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(null);
  const [composer, setComposer] = useState(null);
  const [tick, setTick] = useState(0);
  const action = useBusy();
  const allowed = canAccessIntelligence(access);
  const accounts = useLoad(() => (allowed ? emailApi.accounts(supabase) : Promise.resolve([])), [supabase, allowed, tick]);
  const list = useLoad(() => (allowed ? emailApi.list(supabase, folder, search) : Promise.resolve([])), [supabase, allowed, folder, search, tick]);
  const thread = useLoad(() => (allowed && selected ? emailApi.get(supabase, selected) : Promise.resolve(null)), [supabase, allowed, selected, tick]);
  useEffect(() => { const timer = window.setInterval(() => setTick((n) => n + 1), 20000); return () => window.clearInterval(timer); }, []);
  useEffect(() => { const c = thread.data?.conversation; if (c && c.unread_count > 0) emailApi.markRead(supabase, c.id, true).then(() => setTick((n) => n + 1)).catch(() => {}); }, [thread.data?.conversation?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!allowed) return <Banner tone="warn">Email is restricted.</Banner>;
  const refresh = () => setTick((n) => n + 1);
  const accts = accounts.data || [];
  const own = accts.map((a) => a.address);
  if (!accounts.loading && accts.length === 0) return <div style={S.page}><SetupAccount supabase={supabase} onDone={refresh} /></div>;
  const t = thread.data;
  const convo = t?.conversation;
  const reply = (m, all) => setComposer({ title: all ? "Reply all" : "Reply", ...buildReply(m, own, { all, when: when(m.received_at || m.sent_at) }), conversationId: convo.id, accountId: convo.account_id });
  const forward = (m) => setComposer({ title: "Forward", ...buildForward(m, when(m.received_at || m.sent_at)), accountId: convo.account_id });
  const editDraft = (m) => setComposer({ title: "Draft", draftId: m.id, conversationId: m.conversation_id, accountId: m.account_id, to: (m.to_emails || []).join(", "), cc: (m.cc_emails || []).join(", "), bcc: (m.bcc_emails || []).join(", "), subject: m.subject, body: m.body_text });
  return <div className="chat-root inbox-chat-root">
    <div className="inbox-chat-heading"><div><h2>Inbox</h2><p>{own.join(", ") || "Your studio email"} <span>·</span> Real email, familiar chat</p></div><button type="button" className="chat-button primary" onClick={() => setComposer({ title: "New chat" })}>＋ New chat</button></div>
    <div className="inbox-chat-layout">
      <aside className="inbox-chat-sidebar">
        <div className="inbox-sidebar-top"><div className="chat-search"><input placeholder="Search people, subjects and messages" value={searchText} onChange={(e) => setSearchText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") setSearch(searchText.trim()); }} /><button type="button" className="chat-link-btn" onClick={() => setSearch(searchText.trim())}>Search</button></div><Tabs tabs={FOLDERS.map(([id, label]) => ({ id, label }))} value={folder} onChange={(id) => { setFolder(id); setSelected(null); }} /></div>
        {search && <button className="inbox-clear-search" type="button" onClick={() => { setSearch(""); setSearchText(""); }}>Clear search ×</button>}
        <div className="inbox-conversation-list">
          {list.loading && <div className="chat-loading"><span className="chat-spinner" /> Loading conversations…</div>}
          {!list.loading && !(list.data || []).length && <div className="chat-empty"><strong>{search ? "No matches" : "No conversations yet"}</strong><p>{search ? "Try another name or subject." : "Start a new chat to send an email."}</p></div>}
          {(list.data || []).map((c) => <button key={c.id} type="button" className={`chat-row inbox-conversation${selected === c.id ? " active" : ""}`} onClick={() => setSelected(c.id)}>
            <span className="chat-avatar sm">{participantLabel(c, own).slice(0, 1).toUpperCase()}</span><span className="chat-row-copy"><span className="chat-row-title"><strong>{participantLabel(c, own)}</strong><time>{c.last_message_at ? new Date(c.last_message_at).toLocaleDateString() : ""}</time></span><strong className="inbox-conversation-subject">{c.subject || "(no subject)"}</strong><span className="chat-row-preview">{c.has_draft ? "Draft · " : ""}{c.snippet || "No message preview"}</span><span className="inbox-conversation-tags">{c.unread_count > 0 && <span className="chat-unread">{c.unread_count}</span>}{c.lead_id && <span className="inbox-tag">Lead</span>}{c.has_attachments && <span className="inbox-tag">Attachment</span>}</span></span>
          </button>)}
        </div>
      </aside>
      <main className="inbox-chat-main">
        {!selected && <div className="chat-welcome"><span className="glyph">✉</span><h2>Your Inbox, in chat form</h2><p>Choose a conversation to read and reply, or start a new chat. Messages still travel through your email accounts.</p><button type="button" className="chat-button primary" onClick={() => setComposer({ title: "New chat" })}>Start a new chat</button></div>}
        {selected && thread.loading && !t && <div className="chat-loading"><span className="chat-spinner" /> Loading conversation…</div>}
        {convo && <>
          <header className="chat-header inbox-thread-header"><span className="chat-avatar">{participantLabel(convo, own).slice(0, 1).toUpperCase()}</span><div className="chat-header-copy"><h2>{participantLabel(convo, own)}</h2><p>{convo.subject || "(no subject)"}</p></div><div className="inbox-thread-tools"><button type="button" className="chat-button quiet" disabled={action.busy} onClick={() => action.run(async () => { await emailApi.archive(supabase, convo.id, convo.status !== "archived"); refresh(); })}>{convo.status === "archived" ? "Move to inbox" : "Archive"}</button><button type="button" className="chat-button quiet" disabled={action.busy} onClick={() => action.run(async () => { await emailApi.markRead(supabase, convo.id, false); refresh(); })}>Mark unread</button></div>
          </header>
          <div className="inbox-thread-context"><label className="chat-field">CRM lead<select value={convo.lead_id || ""} onChange={(e) => action.run(async () => { await emailApi.linkLead(supabase, convo.id, e.target.value || null); refresh(); })}><option value="">Not linked</option>{leads.map((l) => <option key={l.id} value={l.id}>{l.companyName || l.company_name || "Untitled lead"}</option>)}</select></label>{convo.lead_id && onOpenLead && <button className="chat-link-btn" type="button" onClick={() => onOpenLead(convo.lead_id)}>Open lead ↗</button>}</div>
          {(list.error || thread.error || action.error) && <div className="inbox-thread-error"><Banner tone="bad">{list.error || thread.error || action.error}</Banner></div>}
          <div className="chat-scroll inbox-thread-scroll"><div className="chat-scroll-content">{(t.messages || []).map((m) => <EmailMessage key={m.id} m={m} supabase={supabase} onEditDraft={editDraft} onReply={(x) => reply(x, false)} onReplyAll={(x) => reply(x, true)} onForward={forward} />)}</div></div>
          <div className="inbox-reply-bar"><span>Replying keeps this email thread intact.</span><button type="button" className="chat-button primary" onClick={() => { const last = [...(t.messages || [])].reverse().find((m) => m.status !== "draft"); if (last) reply(last, false); }}>Reply</button></div>
        </>}
      </main>
    </div>
    {(list.error || thread.error || action.error) && !convo && <div className="inbox-global-error"><Banner tone="bad">{list.error || thread.error || action.error}</Banner></div>}
    {composer && <Composer supabase={supabase} accounts={accts} initial={composer} onClose={() => setComposer(null)} onSent={() => { setComposer(null); refresh(); }} />}
  </div>;
}
