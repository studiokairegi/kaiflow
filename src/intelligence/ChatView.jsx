// Emma (Agent Chat). Messages go to a database function that re-checks authorization and queues a job; the local worker answers
// using a fixed list of tools and PREPARES actions (cards). A card runs in the administrator's own session: when they press Confirm/Send, or by
// itself when they allowed that kind of action without asking (Permissions; the database enforces them and a few kinds can never auto-run).
// Emma cannot change user roles or admin access. Email is sent from the browser through the same sender as the Inbox.
// The conversation UI is the shared KairFlow chat system (src/chat): same stylesheet, theme tokens, message list and composer as the
// staff Chat and the Inbox. Only the data flow below is Emma-specific.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { S, Btn, Pill, useBusy } from "../finance/ui.jsx";
import { intelApi } from "./api.js";
import { emailApi } from "../email/lib/api.js";
import { actionStatus, answerOverdue, awaitingAnswer, chatTurns, groupActions, isActionLive, newClientKey, workerState } from "./logic.js";
import { EMMA_CATEGORIES, EMMA_STARTERS, PROTECTED, authorityOf, autoRunQueue, confirmAllCandidates, emailFields, executorOf, hasInFlight, isRunning, pickSendAccount, resultLine, runEmmaAction, sendableAccounts, stuckRunning } from "./emma.js";
import { Input, TextArea, useLoad } from "./kit.jsx";
import "../chat/chat.css";
import "./emma-chat.css";
import MessageList from "../chat/MessageList.jsx";
import Composer from "../chat/Composer.jsx";
import { IconBack, IconNewChat, IconInbox } from "../chat/icons.jsx";
import { formatChatTime } from "../chat/logic.js";

const TONE_CLASS = { ok: "ok", warn: "warn", bad: "bad" };

function EmailCard({ action, sender, senders, onSender, working, live, onSend, onCancel }) {
  const f = emailFields(action);
  const [edit, setEdit] = useState(false);
  const [subject, setSubject] = useState(f.subject);
  const [body, setBody] = useState(f.body);
  return (
    <div>
      <div className="emma-action-label">Email to</div>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>{f.to}</div>
      {edit && live ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <Input value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" />
          <TextArea rows={9} value={body} maxLength={20000} onChange={(e) => setBody(e.target.value)} aria-label="Message" />
        </div>
      ) : (
        <div style={{ fontSize: 13 }}><div style={{ fontWeight: 600 }}>{f.subject}</div><div style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>{f.body}</div></div>
      )}
      {live && (
        <div className="emma-action-row">
          {senders.length > 1 && (
            <select value={sender?.id || ""} onChange={(e) => onSender(e.target.value)} style={{ ...S.input, width: "auto" }} aria-label="Send from">
              {senders.map((a) => <option key={a.id} value={a.id}>{a.display_name ? `${a.display_name} <${a.address}>` : a.address}</option>)}
            </select>
          )}
          {senders.length === 1 && <span className="emma-action-label">From {sender?.address}</span>}
          <Btn small kind="primary" disabled={working || !sender} onClick={() => onSend(edit ? { subject, body } : null)}>Send</Btn>
          <Btn small disabled={working} onClick={() => setEdit((v) => !v)}>{edit ? "Done editing" : "Edit"}</Btn>
          <Btn small disabled={working} onClick={onCancel}>Don't send</Btn>
          {!sender && <span className="emma-action-err">No connected sending account.</span>}
        </div>
      )}
    </div>
  );
}

function Permissions({ authority, saving, onChange }) {
  return (
    <div className="emma-perms">
      <div style={{ fontWeight: 700, fontSize: 13 }}>What Emma may do without asking</div>
      <p className="emma-action-label" style={{ margin: "2px 0 8px" }}>Choose per kind of action. "Ask me" shows a card you confirm; "Do it" lets Emma go ahead while this chat is open. Everything is logged.</p>
      {EMMA_CATEGORIES.map((c) => (
        <div key={c.key} className="emma-perm-row">
          <div style={{ flex: "1 1 220px" }}><div style={{ fontSize: 13, fontWeight: 600 }}>{c.label}</div><div className="emma-action-label">{c.detail}</div></div>
          <div className="emma-action-row" style={{ marginTop: 0 }}>
            <Btn small kind={authority[c.key] === "ask" ? "primary" : "default"} disabled={saving} onClick={() => authority[c.key] !== "ask" && onChange(c.key, "ask")}>Ask me</Btn>
            <Btn small kind={authority[c.key] === "auto" ? "primary" : "default"} disabled={saving} onClick={() => authority[c.key] !== "auto" && onChange(c.key, "auto")}>Do it</Btn>
          </div>
        </div>
      ))}
      <p className="emma-action-label" style={{ marginTop: 8 }}>Always asks first, whatever you choose: {PROTECTED.join(", ").toLowerCase()}. Emma can never change user roles or admin access.</p>
    </div>
  );
}

export default function ChatView({ supabase, tick, workerSeconds, onChanged, theme = "dark" }) {
  const threads = useLoad(() => intelApi.chatThreads(supabase), [supabase]);
  const [threadId, setThreadId] = useState(null);
  const [text, setText] = useState("");
  const [fast, setFast] = useState(0);
  const [showList, setShowList] = useState(false);                       // phone layout: false = conversation, true = chat history
  const { busy, error, run } = useBusy();
  const settings = useLoad(() => intelApi.settings(supabase), [supabase]);
  const mailbox = useLoad(async () => ({ accounts: await emailApi.accounts(supabase), providers: await emailApi.providers(supabase) }), [supabase]);
  const [showPerms, setShowPerms] = useState(false);
  const [savingPerms, setSavingPerms] = useState(false);
  const [senderId, setSenderId] = useState("");
  const [working, setWorking] = useState({});
  const [errs, setErrs] = useState({});
  const [permError, setPermError] = useState("");
  // useLoad keeps the previous result while a new one loads, so each result is tagged with the thread it belongs to and ignored for any other.
  const tagged = async (load) => { const id = threadId; const rows = id ? await load(id) : []; return Object.assign(rows, { threadId: id }); };
  const msgs = useLoad(() => tagged((id) => intelApi.chatMessages(supabase, id)), [supabase, threadId, tick, fast]);
  const acts = useLoad(() => tagged((id) => intelApi.chatActions(supabase, id)), [supabase, threadId, tick, fast]);
  const own = (d) => (d && d.threadId === threadId ? d : null);
  const actRows = own(acts.data);
  const byRequest = groupActions(actRows);
  const list = own(msgs.data) || [];
  const overdue = answerOverdue(list);
  const waiting = (awaitingAnswer(list) && !overdue) || false;      // stop polling and spinning when the worker never answers
  const authority = useMemo(() => authorityOf(settings.data), [settings.data]);
  const accounts = mailbox.data?.accounts || [];
  const providers = mailbox.data?.providers || [];
  const senders = sendableAccounts(accounts, providers);
  const sender = senders.find((a) => a.id === senderId) || pickSendAccount(accounts, providers);
  const chain = useRef(Promise.resolve());
  const baseline = useRef({ thread: null, ids: new Set() });
  const tried = useRef(new Set());
  const recovering = useRef(new Set());

  const exec = (action, { auto = false, edits = null } = {}) => {
    const task = async () => {
      setWorking((w) => ({ ...w, [action.id]: true }));
      setErrs((e) => { const n = { ...e }; delete n[action.id]; return n; });
      try {
        const r = await runEmmaAction({ supabase, action, auto, edits, sender, api: intelApi, mail: emailApi });
        if (r && r.unrecorded) setErrs((x) => ({ ...x, [action.id]: "Email sent, but the app could not update this card. Check the Sent folder; the card will resolve itself shortly." }));
      } catch (e) {
        setErrs((x) => ({ ...x, [action.id]: e?.message || "It could not be completed." }));
      } finally {
        setWorking((w) => { const n = { ...w }; delete n[action.id]; return n; });
        setFast((n) => n + 1);
        try { await acts.reload(); await onChanged?.(); } catch { /* the next poll refreshes */ }
      }
    };
    chain.current = chain.current.then(task, task);                 // one card at a time, in order
    return chain.current;
  };
  const cancel = (action) => (async () => {
    try { await intelApi.chatCancel(supabase, action.id); } catch (e) { setErrs((x) => ({ ...x, [action.id]: e?.message || "Could not cancel." })); }
    setFast((n) => n + 1); await acts.reload();
  })();
  const setAuthority = async (key, value) => {
    setSavingPerms(true); setPermError("");
    try { await intelApi.setEmmaAuthority(supabase, { [key]: value }); await settings.reload(); } catch (e) { setPermError(e?.message || "Could not save that."); } finally { setSavingPerms(false); }
  };
  const confirmAll = () => { for (const a of confirmAllCandidates(actRows)) exec(a); };
  const pendingCount = confirmAllCandidates(actRows).length;
  useEffect(() => { if (!threadId && threads.data?.length) setThreadId(threads.data[0].id); }, [threads.data, threadId]);
  useEffect(() => {
    if (!waiting && !hasInFlight(actRows)) return undefined;
    const id = setInterval(() => setFast((n) => n + 1), 3000);       // answer is usually a few seconds; poll quickly only while waiting
    return () => clearInterval(id);
  }, [waiting, actRows]);
  // An email card that was claimed but never reported back (tab closed, network lost) is resolved by the database so it cannot spin forever.
  useEffect(() => {
    const stuck = stuckRunning(actRows).filter((a) => !recovering.current.has(a.id));
    if (!stuck.length) return;
    stuck.forEach((a) => recovering.current.add(a.id));
    intelApi.chatRecoverStuck(supabase).then(() => setFast((n) => n + 1)).catch(() => stuck.forEach((a) => recovering.current.delete(a.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acts.data]);
  // Automatic runs: only cards that appeared AFTER this thread was opened, of a kind the administrator allowed, one at a time.
  useEffect(() => {
    if (!threadId || acts.loading || !actRows) return;
    if (baseline.current.thread !== threadId) baseline.current = { thread: threadId, ids: new Set(actRows.map((a) => a.id)) };
    if (!settings.data) return;
    for (const a of autoRunQueue(actRows, authority, baseline.current.ids, tried.current)) {
      if (executorOf(a.tool) === "browser" && (mailbox.loading || !sender)) continue;   // wait for the mailbox; a card that cannot send stays for a tap
      tried.current.add(a.id);
      exec(a, { auto: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acts.data, acts.loading, threadId, authority, settings.data, mailbox.loading, sender?.id]);
  const w = workerState(workerSeconds);
  const loadError = msgs.error || acts.error || threads.error || "";

  const [sending, setSending] = useState(false);                     // only a message being sent spins the Send button, not Confirm/Cancel
  const pendingKey = useRef(null);                                   // a retry of the same text reuses its key, so the server drops a duplicate instead of queueing it twice
  const send = (value) => run(async () => {
    const body = (value ?? text).trim();
    if (!body) return;
    setSending(true);
    try {
    let id = threadId;
    if (!id) { id = await intelApi.chatNewThread(supabase, body.slice(0, 60)); setThreadId(id); }
    if (!pendingKey.current || pendingKey.current.body !== body || pendingKey.current.thread !== id) pendingKey.current = { body, thread: id, key: newClientKey() };
    await intelApi.chatSend(supabase, id, body, pendingKey.current.key);
    pendingKey.current = null;
    if (value == null) setText("");                                  // a suggestion chip must not wipe what the person is still typing
    await threads.reload();
    setFast((n) => n + 1);
    } finally { setSending(false); }
  });
  const fresh = () => run(async () => { const current = own(msgs.data); if (threadId && current && current.length === 0) return; const id = await intelApi.chatNewThread(supabase, "New chat"); setThreadId(id); await threads.reload(); setShowList(false); });

  // Emma's turns, in the shape the shared MessageList expects. Tool names, provenance and confirm/cancel cards ride along as `extra`.
  const createdAt = useMemo(() => new Map(list.map((m) => [m.id, m.created_at])), [list]);
  const turns = chatTurns(list);
  // Cards normally sit under Emma's answer. If she never answered (worker crashed after proposing), they sit under the request instead,
  // so nothing can wait for a tap, or run by itself, without being visible.
  const answered = new Set(turns.filter((t) => t.role === "assistant").map((t) => t.replyTo));
  const messages = turns.map((t) => {
    const mine = t.role === "user";
    const cards = !mine ? (byRequest.get(t.replyTo) || []) : (answered.has(t.id) ? [] : (byRequest.get(t.id) || []));
    const hasExtra = cards.length > 0 || (!mine && (t.tools?.length > 0 || t.ai));
    return {
      id: String(t.id), mine, senderKey: mine ? "me" : "emma", senderName: "Emma", avatar: "E", badge: mine ? null : "AI",
      body: t.text || "", createdAt: createdAt.get(t.id) || null, isError: Boolean(t.error),
      extra: hasExtra ? (
        <>
          {!mine && t.tools?.length > 0 && <div className="emma-meta">{t.tools.join(" · ")}</div>}
          {!mine && t.ai && <div className="emma-meta">{t.ai}</div>}
          {cards.map((a) => {
            const st = actionStatus(a);
            const live = isActionLive(a);
            const working_ = !!working[a.id] || isRunning(a);
            const line = resultLine(a);
            return (
              <div key={a.id} className="emma-action">
                {a.tool === "send_email" && (live || working_)
                  ? <EmailCard action={a} sender={sender} senders={senders} onSender={setSenderId} working={working_} live={live} onSend={(edits) => exec(a, { edits })} onCancel={() => cancel(a)} />
                  : <div className="emma-action-summary">{a.summary}</div>}
                <div className="emma-action-row">
                  <Pill tone={working_ ? "info" : st.tone}>{working_ ? "Working" : st.label}</Pill>
                  {live && a.tool !== "send_email" && <>
                    <Btn small kind="primary" disabled={working_} onClick={() => exec(a)}>Confirm</Btn>
                    <Btn small disabled={working_} onClick={() => cancel(a)}>Cancel</Btn>
                  </>}
                  {line && !working_ && <span className="emma-action-note">{line}</span>}
                  {errs[a.id] && <span className="emma-action-err">{errs[a.id]}</span>}
                </div>
              </div>
            );
          })}
        </>
      ) : null,
    };
  });

  const chips = (
    <div className="emma-chips" role="group" aria-label="Suggestions">
      {EMMA_STARTERS.map((s) => <button key={s.label} type="button" className="chat-pill-btn" disabled={busy} onClick={() => (s.send ? send(s.text) : setText(s.text))}>{s.label}</button>)}
    </div>
  );
  const notices = (
    <>
      {showPerms && <Permissions authority={authority} saving={savingPerms || !settings.data} onChange={setAuthority} />}
      {permError && <div className="chat-alert error" role="alert"><span>{permError}</span></div>}
      {pendingCount > 1 && <div className="chat-alert info" role="status"><span>{pendingCount} actions are waiting.</span><Btn small kind="primary" onClick={confirmAll}>Confirm all {pendingCount}</Btn><span className="emma-action-label">Skips emails and anything that always needs its own tap (turning sending on, autonomy, do-not-contact, sender identity, send window, warm-up and limits).</span></div>}
      {error && <div className="chat-alert error" role="alert"><span>{error}</span></div>}
      {loadError && <div className="chat-alert error" role="alert"><span>Could not load the chat: {loadError}. It will retry automatically.</span></div>}
      {w.tone !== "ok" && <div className="chat-alert info" role="status"><span>{w.label}. Your message is saved and answered as soon as the worker is running.</span></div>}
      {overdue && <div className="chat-alert error" role="alert"><span>There is still no answer to your last message. The worker may be offline or the request failed. Check the worker status above, then send it again.</span></div>}
    </>
  );
  const empty = (
    <div className="chat-empty">
      <span className="glyph" aria-hidden="true"><IconInbox size={24} /></span>
      <strong>Ask Emma anything</strong>
      <p>Emma gets things done: look things up, add to the knowledge base, change a setting, rewrite a draft, email someone. She prepares it and, where you allow it, does it. Anything you have not allowed waits for your Confirm. She cannot change user roles or admin access.</p>
    </div>
  );
  const rows = threads.data || [];

  return (
    <div className="emma-wrap">
      <section className={`chat-root chat-theme-${theme} chat-page emma-page${showList ? "" : " has-active-conversation"}`} aria-label="Emma">
        <aside className="chat-sidebar">
          <div className="chat-sidebar-top">
            <div className="chat-topbar">
              <h2>Emma</h2>
              <button type="button" className="chat-icon-btn solid" onClick={() => { setShowList(false); fresh(); }} disabled={busy} aria-label="New chat" title="New chat"><IconNewChat /></button>
            </div>
          </div>
          <div className="chat-sidebar-list" aria-label="Chat history">
            {threads.loading && !rows.length && <p className="chat-muted" style={{ padding: 12 }}>Loading…</p>}
            {!threads.loading && !rows.length && <div className="chat-empty"><strong>No chats yet</strong><p>Send a message to start one.</p></div>}
            {rows.map((t) => (
              <button type="button" key={t.id} className={`chat-row${threadId === t.id ? " active" : ""}`} onClick={() => { setThreadId(t.id); setShowList(false); }}>
                <span className="chat-avatar" aria-hidden="true">E</span>
                <span className="chat-row-copy">
                  <span className="chat-row-title"><strong>{t.title}</strong><time>{formatChatTime(t.updated_at)}</time></span>
                </span>
              </button>
            ))}
          </div>
        </aside>
        <main className="chat-main">
          <header className="chat-header">
            <button type="button" className="chat-icon-btn chat-back" aria-label="Back to chats" onClick={() => setShowList(true)}><IconBack /></button>
            <span className="chat-avatar" aria-hidden="true">E</span>
            <div className="chat-header-copy"><h2>Emma</h2><p>Your Intelligence assistant. Cannot change roles or admin access.</p></div>
            <button type="button" className="chat-pill-btn" onClick={() => setShowPerms((v) => !v)} aria-expanded={showPerms}>{showPerms ? "Hide permissions" : "Permissions"}</button>
            <span className={`emma-status ${TONE_CLASS[w.tone] || ""}`}><i aria-hidden="true" />{w.label}</span>
          </header>
          <MessageList conversationKey={threadId || "new"} messages={messages} loading={Boolean(threadId) && !own(msgs.data) && !msgs.error}
            typing={waiting ? ["Emma"] : []} typingStyle="bubble" typingAvatar="E" notices={notices} empty={empty} />
          {chips}
          <Composer value={text} onChange={setText} onSend={() => send()} sending={sending} canAttach={false} maxLength={2000}
            placeholder="Ask Emma…" label="Message to Emma" footerNote="Enter to send · Shift+Enter for a new line" />
        </main>
      </section>
    </div>
  );
}
