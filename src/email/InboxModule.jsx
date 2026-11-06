// KairFlow Inbox (Resend). Lives in the CRM area next to Pipeline / Contacts / Intelligence and renders only for people the
// database allows (same rule as Intelligence). The database re-checks every read and write; this file never holds provider keys.
// The screen is built from the main Chat's own layout and classes. Layout: components/ (screen pieces), lib/ (api, pure logic,
// helpers), styles/ (email-specific CSS on top of chat.css).
import React, { useEffect, useRef, useState } from "react";
import { S, Banner, useBusy } from "../finance/ui.jsx";
import { canAccessIntelligence } from "../intelligence/access.js";
import { useLoad } from "../intelligence/kit.jsx";
import { usePolling } from "../chat/hooks.js";
import { dayLabel } from "../chat/logic.js";
import { IconBack, IconNewChat, IconSearch } from "../chat/icons.jsx";
import "../chat/chat.css";
import "./styles/inbox-chat.css";
import { emailApi } from "./lib/api.js";
import { FOLDERS, buildForward, participantLabel } from "./lib/logic.js";
import { initialsOf, when } from "./lib/helpers.js";
import SetupAccount from "./components/SetupAccount.jsx";
import ComposeDialog from "./components/ComposeDialog.jsx";
import ConversationList from "./components/ConversationList.jsx";
import EmailMessage from "./components/EmailMessage.jsx";
import InlineReply from "./components/InlineReply.jsx";

export default function InboxModule({ supabase, access, leads = [], onOpenLead, theme = "dark" }) {
  const [folder, setFolder] = useState("inbox");
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(null);
  const [composer, setComposer] = useState(null);
  const [activeMsg, setActiveMsg] = useState(null);
  const [tick, setTick] = useState(0);
  const scrollRef = useRef(null);
  const action = useBusy();
  const allowed = canAccessIntelligence(access);

  const accounts = useLoad(() => (allowed ? emailApi.accounts(supabase) : Promise.resolve([])), [supabase, allowed, tick]);
  const list = useLoad(() => (allowed ? emailApi.list(supabase, folder, search) : Promise.resolve([])), [supabase, allowed, folder, search, tick]);
  const thread = useLoad(() => (allowed && selected ? emailApi.get(supabase, selected) : Promise.resolve(null)), [supabase, allowed, selected, tick]);

  // Opening a conversation marks it read (the database keeps the counts).
  useEffect(() => {
    const c = thread.data?.conversation;
    if (c && c.unread_count > 0) emailApi.markRead(supabase, c.id, true).then(() => setTick((t) => t + 1)).catch(() => {});
  }, [thread.data?.conversation?.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Like the main chat: land on the newest message when a conversation opens or a new message arrives.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread.data?.conversation?.id, thread.data?.messages?.length]);

  const refresh = () => setTick((t) => t + 1);
  // Match the main Chat module: refresh mounted conversations in the background and on tab visibility.
  usePolling(refresh, 20000, allowed, { hidden: true });
  if (!allowed) return <Banner tone="warn">Email is restricted.</Banner>;
  const accts = accounts.data || [];
  const own = accts.map((a) => a.address);
  if (!accounts.loading && accts.length === 0) return <div style={S.page}><SetupAccount supabase={supabase} onDone={refresh} /></div>;

  const t = thread.data;
  const convo = t?.conversation;
  const messages = t?.messages || [];
  const errorText = list.error || thread.error || action.error;
  const forward = (m) => setComposer({ title: "Forward", ...buildForward(m, when(m.received_at || m.sent_at)), accountId: convo.account_id });
  const editDraft = (m) => setComposer({ title: "Draft", draftId: m.id, conversationId: m.conversation_id, accountId: m.account_id, to: (m.to_emails || []).join(", "), cc: (m.cc_emails || []).join(", "), bcc: (m.bcc_emails || []).join(", "), subject: m.subject, body: m.body_text });
  const rows = list.data || [];

  return (
    <div className="inbox-page-wrap">
      <section className={`chat-root chat-theme-${theme} chat-page inbox-page${selected ? " has-active-conversation" : ""}`} aria-label="Inbox">
        <aside className="chat-sidebar">
          <div className="chat-sidebar-top">
            <div className="chat-topbar">
              <h2>Inbox</h2>
              <button type="button" className="chat-icon-btn solid" onClick={() => setComposer({ title: "New message" })} aria-label="Compose" title="Compose"><IconNewChat /></button>
            </div>
            {own.length > 0 && <p className="chat-hint inbox-accounts" title={own.join(", ")}>{own.join(", ")}</p>}
            <form className="chat-search" onSubmit={(e) => { e.preventDefault(); setSearch(searchText.trim()); }}>
              <IconSearch size={17} />
              <input value={searchText} onChange={(e) => { setSearchText(e.target.value); if (!e.target.value.trim()) setSearch(""); }} placeholder="Search people, subjects and messages" aria-label="Search email" />
            </form>
            <div className="chat-tabs inbox-tabs" role="tablist" aria-label="Mail folders">
              {FOLDERS.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={folder === id} className={folder === id ? "active" : ""} onClick={() => { setFolder(id); setSelected(null); }}>{label}</button>)}
            </div>
          </div>
          <ConversationList rows={rows} loading={list.loading} search={search} selected={selected} own={own} error={!selected ? errorText : ""} onSelect={(id) => { setSelected(id); setActiveMsg(null); }} />
        </aside>

        <main className="chat-main">
          {selected && thread.loading && !t && <div className="chat-welcome"><div className="chat-spinner" aria-hidden="true" /><p>Opening conversation…</p></div>}
          {convo && <>
            <header className="chat-header">
              <button type="button" className="chat-icon-btn chat-back" aria-label="Back to conversations" onClick={() => setSelected(null)}><IconBack /></button>
              <span className="chat-avatar" aria-hidden="true">{initialsOf(participantLabel(convo, own))}</span>
              <div className="chat-header-copy">
                <h2>{participantLabel({ ...convo, participants: t.participants || convo.participants }, own)}</h2>
                <p>{convo.subject || "(no subject)"}</p>
              </div>
              <div className="inbox-thread-tools">
                <button type="button" className="chat-button quiet" disabled={action.busy} onClick={() => action.run(async () => { await emailApi.archive(supabase, convo.id, convo.status !== "archived"); refresh(); })}>{convo.status === "archived" ? "Move to inbox" : "Archive"}</button>
                <button type="button" className="chat-button quiet" disabled={action.busy} onClick={() => action.run(async () => { await emailApi.markRead(supabase, convo.id, false); refresh(); })}>Mark unread</button>
              </div>
            </header>
            <div className="inbox-thread-context">
              <label className="chat-field inbox-lead-field">CRM lead
                <select className="chat-org-select" value={convo.lead_id || ""} onChange={(e) => action.run(async () => { await emailApi.linkLead(supabase, convo.id, e.target.value || null); refresh(); })}>
                  <option value="">Not linked</option>
                  {leads.map((l) => <option key={l.id} value={l.id}>{l.companyName || l.company_name || "Untitled lead"}</option>)}
                </select>
              </label>
              {convo.lead_id && onOpenLead && <button type="button" className="chat-link-btn" onClick={() => onOpenLead(convo.lead_id)}>Open lead</button>}
            </div>
            <div className="chat-body">
              <div className="chat-scroll" ref={scrollRef}>
                <div className="chat-scroll-content">
                  {errorText && <div className="chat-alert error" role="alert"><span>{errorText}</span></div>}
                  {messages.map((m, i) => {
                    const ts = m.received_at || m.sent_at || m.created_at;
                    const prev = messages[i - 1];
                    const prevTs = prev && (prev.received_at || prev.sent_at || prev.created_at);
                    const newDay = ts && (!prevTs || new Date(ts).toDateString() !== new Date(prevTs).toDateString());
                    return (
                      <React.Fragment key={m.id}>
                        {newDay && <div className="chat-day" role="separator"><span>{dayLabel(ts)}</span></div>}
                        <EmailMessage m={m} convoSubject={convo.subject} supabase={supabase} active={activeMsg === m.id} onActivate={() => setActiveMsg((cur) => (cur === m.id ? null : m.id))} onEditDraft={editDraft} onForward={forward} />
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>
            </div>
            <InlineReply key={convo.id} supabase={supabase} convo={convo} messages={messages} participants={t.participants || convo.participants || []} own={own} onSent={refresh} />
          </>}
          {!selected && (
            <div className="chat-welcome">
              <span className="glyph" aria-hidden="true"><IconNewChat size={30} /></span>
              <h2>Your studio inbox</h2>
              <p>Pick a conversation to read it and reply, or start a new email.</p>
              <button type="button" className="chat-button primary" onClick={() => setComposer({ title: "New message" })}><IconNewChat size={18} /> Compose</button>
            </div>
          )}
        </main>

        {composer && <ComposeDialog supabase={supabase} accounts={accts} initial={composer} onClose={() => setComposer(null)} onSent={() => { setComposer(null); refresh(); }} />}
      </section>
    </div>
  );
}
