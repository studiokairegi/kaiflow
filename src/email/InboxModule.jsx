// KairFlow Inbox (Resend). Lives in the CRM area next to Pipeline / Contacts / Intelligence and renders only for people the
// database allows (same rule as Intelligence). The database re-checks every read and write; this file never holds provider keys.
import React, { useEffect, useRef, useState } from "react";
import { S, T, Banner, Btn, Field, Modal, Pill, Tabs, useBusy } from "../finance/ui.jsx";
import { canAccessIntelligence } from "../intelligence/access.js";
import { Input, Muted, Section, Select, TextArea, useLoad, confirmAction } from "../intelligence/kit.jsx";
import { emailApi } from "./api.js";
import { usePolling } from "../chat/hooks.js";
import ChatComposer from "../chat/Composer.jsx";
import "../chat/chat.css";
import "./inbox-chat.css";
import { FOLDERS, attachmentProblem, buildForward, composeProblem, fmtSize, isProblem, parseRecipients, participantLabel, replySubject, statusLabel, textToHtml } from "./logic.js";

const newKey = () => `kf-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");

function SetupAccount({ supabase, onDone }) {
  const [address, setAddress] = useState("");
  const [name, setName] = useState("Studio Kairegi");
  const { busy, error, run } = useBusy();
  return (
    <Section title="Add your sending address" hint="This must be an address on a domain you verified in Resend. Replies to it arrive in this inbox once the Resend receiving records are set up.">
      {error && <Banner tone="bad">{error}</Banner>}
      <div style={S.grid(240)}>
        <Field label="Address"><Input type="email" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="name@yourdomain.com" /></Field>
        <Field label="Display name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      </div>
      <div><Btn kind="primary" disabled={busy || !address.trim()} onClick={() => run(async () => { await emailApi.addAccount(supabase, address, name); await onDone(); })}>Save address</Btn></div>
    </Section>
  );
}

function ComposeModal({ supabase, accounts, initial, onClose, onSent }) {
  const [f, setF] = useState({ accountId: initial.accountId || accounts[0]?.id || "", to: initial.to || "", cc: initial.cc || "", bcc: initial.bcc || "", subject: initial.subject || "", body: initial.body || "" });
  const [files, setFiles] = useState([]);
  const [showCc, setShowCc] = useState(Boolean(initial.cc || initial.bcc));
  const [draftId, setDraftId] = useState(initial.draftId || null);
  const [conversationId, setConversationId] = useState(initial.conversationId || null);
  const key = useRef(newKey());
  const sendState = useBusy();
  const draftState = useBusy();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const problem = composeProblem(f) || attachmentProblem(files);
  const lists = () => ({ to: parseRecipients(f.to).valid, cc: parseRecipients(f.cc).valid, bcc: parseRecipients(f.bcc).valid });

  const saveDraft = () => draftState.run(async () => {
    const r = await emailApi.saveDraft(supabase, { draftId, conversationId, accountId: f.accountId, ...lists(), subject: f.subject, text: f.body, html: "" });
    setDraftId(r.draft_id); setConversationId(r.conversation_id);
  });
  const send = () => sendState.run(async () => {
    if (problem) throw new Error(problem);
    try {
      await emailApi.send(supabase, { accountId: f.accountId, ...lists(), subject: f.subject.trim(), text: f.body, html: textToHtml(f.body), conversationId, draftId, key: key.current, files });
    } catch (e) {
      key.current = newKey();           // the server keeps the old key's row; a corrected message needs a fresh key
      throw e;
    }
    await onSent();
  });
  const discard = async () => {
    if (draftId && confirmAction("Delete this draft?")) { try { await emailApi.deleteDraft(supabase, draftId); } catch { /* already gone */ } onSent(); return; }
    onClose();
  };

  return (
    <Modal title={initial.title || "New message"} onClose={onClose} width={720}
      footer={<>
        <Btn onClick={discard}>{draftId ? "Delete draft" : "Discard"}</Btn>
        <Btn disabled={draftState.busy || sendState.busy || !f.accountId} onClick={saveDraft}>Save draft</Btn>
        <Btn kind="primary" disabled={sendState.busy || Boolean(problem)} onClick={send}>{sendState.busy ? "Sending…" : "Send"}</Btn>
      </>}>
      {sendState.error && <Banner tone="bad">{sendState.error}</Banner>}
      {draftState.error && <Banner tone="bad">{draftState.error}</Banner>}
      <Field label="From"><Select value={f.accountId} onChange={set("accountId")} options={accounts.map((a) => [a.id, a.display_name ? `${a.display_name} <${a.address}>` : a.address])} /></Field>
      <Field label="To (separate with commas)"><Input value={f.to} onChange={set("to")} /></Field>
      {showCc ? (
        <div style={S.grid(240)}>
          <Field label="Cc"><Input value={f.cc} onChange={set("cc")} /></Field>
          <Field label="Bcc"><Input value={f.bcc} onChange={set("bcc")} /></Field>
        </div>
      ) : <div><Btn small onClick={() => setShowCc(true)}>Add Cc / Bcc</Btn></div>}
      <Field label="Subject"><Input value={f.subject} onChange={set("subject")} /></Field>
      <Field label="Message"><TextArea rows={10} value={f.body} onChange={set("body")} /></Field>
      <Field label="Attachments" hint="Up to 10 files, 10 MB in total.">
        <input type="file" multiple onChange={(e) => setFiles(Array.from(e.target.files || []))} />
      </Field>
      {problem && <Muted>{problem}</Muted>}
    </Modal>
  );
}

function InlineEmailComposer({ supabase, accountId, conversationId, initial, onSent }) {
  const [to, setTo] = useState(initial?.to || "");
  const [cc, setCc] = useState(initial?.cc || "");
  const [subject, setSubject] = useState(initial?.subject || "");
  const [body, setBody] = useState("");
  const [files, setFiles] = useState([]);
  const [showCc, setShowCc] = useState(Boolean(initial?.cc));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const key = useRef(newKey());

  useEffect(() => {
    setTo(initial?.to || "");
    setCc(initial?.cc || "");
    setSubject(initial?.subject || "");
    setBody("");
    setFiles([]);
    setShowCc(Boolean(initial?.cc));
    setError("");
    key.current = newKey();
  }, [initial?.messageId, initial?.to, initial?.cc, initial?.subject]);

  const send = async () => {
    const fields = { accountId, to, cc, bcc: "", subject, body };
    const problem = composeProblem(fields) || attachmentProblem(files);
    if (problem) { setError(problem); return; }
    setSending(true);
    setError("");
    try {
      await emailApi.send(supabase, {
        accountId,
        to: parseRecipients(to).valid,
        cc: parseRecipients(cc).valid,
        bcc: [],
        subject: subject.trim(),
        text: body,
        html: textToHtml(body),
        conversationId,
        draftId: null,
        key: key.current,
        files,
      });
      setBody("");
      setFiles([]);
      key.current = newKey();
      onSent();
    } catch (e) {
      setError(e?.message || "Message could not be sent.");
      key.current = newKey();
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="inbox-inline-composer" aria-label="Write a message">
      <div className="inbox-inline-fields">
        <label><span>To</span><Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="Recipient email address" /></label>
        <label><span>Subject</span><Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Email subject" /></label>
        {showCc && <label><span>Cc</span><Input value={cc} onChange={(e) => setCc(e.target.value)} placeholder="Optional CC recipients" /></label>}
        {!showCc && <button type="button" className="inbox-add-cc" onClick={() => setShowCc(true)}>Add Cc</button>}
      </div>
      <ChatComposer
        value={body}
        onChange={setBody}
        onSend={send}
        sending={sending}
        files={files}
        onFilesChange={setFiles}
        accept="*/*"
        placeholder="Write a message…"
        label="Write a message"
        footerNote="Enter to send · Shift+Enter for a new line"
        error={error}
      />
    </section>
  );
}

function MessageCard({ m, supabase, onEditDraft, onForward }) {
  const [label, tone] = statusLabel(m.status);
  const inbound = m.direction === "inbound";
  const open = async (att) => {
    try { window.open(await emailApi.attachmentUrl(supabase, att.storage_path), "_blank", "noopener"); } catch (e) { window.alert(e.message); }
  };
  return (
    <div className={`inbox-message-row ${inbound ? "incoming" : "outgoing"}`}>
      <article className={`inbox-message-bubble ${inbound ? "inbound" : "outbound"}`}>
        <header className="inbox-message-meta">
          <strong>{m.subject || "(no subject)"}</strong>
          <span>{inbound ? (m.from_name ? `${m.from_name} · ${m.from_email}` : m.from_email) : "You"}</span>
          {m.cc_emails?.length > 0 && <small>Cc: {m.cc_emails.join(", ")}</small>}
          {m.direction === "outbound" && m.bcc_emails?.length > 0 && <small>Bcc: {m.bcc_emails.join(", ")}</small>}
        </header>
        <div className="inbox-message-body">{m.body_text || "(no text content)"}</div>
        {m.attachments?.length > 0 && <div className="inbox-message-attachments">{m.attachments.map((a) => (
          <Btn key={a.id} small disabled={!a.storage_path} onClick={() => open(a)} title={a.storage_path ? "Open" : "Not stored (too large)"}>{a.filename} · {fmtSize(a.size_bytes)}</Btn>
        ))}</div>}
        {isProblem(m.status) && <div className="inbox-message-error">{m.error || "This email was not delivered."} Nothing was resent automatically.</div>}
        <footer className="inbox-message-footer">
          <span>{when(m.received_at || m.sent_at || m.created_at)}</span>
          {m.ai_generated && <Pill tone="warn">AI draft: review before sending</Pill>}
          {m.direction === "outbound" && <Pill tone={tone}>{label}</Pill>}
          {m.status === "draft" ? <Btn small kind="primary" onClick={() => onEditDraft(m)}>Edit draft</Btn> : <Btn small onClick={() => onForward(m)}>Forward</Btn>}
        </footer>
      </article>
    </div>
  );
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

  // Opening a conversation marks it read (the database keeps the counts).
  useEffect(() => {
    const c = thread.data?.conversation;
    if (c && c.unread_count > 0) emailApi.markRead(supabase, c.id, true).then(() => setTick((t) => t + 1)).catch(() => {});
  }, [thread.data?.conversation?.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => setTick((t) => t + 1);
  // Match the main Chat module: refresh mounted conversations in the background and on tab visibility.
  usePolling(refresh, 20000, allowed, { hidden: true });
  if (!allowed) return <Banner tone="warn">Email is restricted.</Banner>;
  const accts = accounts.data || [];
  const own = accts.map((a) => a.address);
  if (!accounts.loading && accts.length === 0) return <div style={S.page}><SetupAccount supabase={supabase} onDone={refresh} /></div>;

  const t = thread.data;
  const convo = t?.conversation;
  const forward = (m) => setComposer({ title: "Forward", ...buildForward(m, when(m.received_at || m.sent_at)), accountId: convo.account_id });
  const editDraft = (m) => setComposer({ title: "Draft", draftId: m.id, conversationId: m.conversation_id, accountId: m.account_id, to: (m.to_emails || []).join(", "), cc: (m.cc_emails || []).join(", "), bcc: (m.bcc_emails || []).join(", "), subject: m.subject, body: m.body_text });

  return (
    <div className="chat-root inbox-chat-shell" style={S.page}>
      <div style={{ ...S.row, justifyContent: "space-between" }}>
        <div><h2 style={S.h2}>Inbox</h2><p style={S.sub}>Email for {own.join(", ") || "your studio"} · sent and received through Resend</p></div>
        <Btn kind="primary" onClick={() => setComposer({ title: "New message" })}>Compose</Btn>
      </div>
      <Tabs tabs={FOLDERS.map(([id, label]) => ({ id, label }))} value={folder} onChange={(id) => { setFolder(id); setSelected(null); }} />
      <form style={S.row} onSubmit={(e) => { e.preventDefault(); setSearch(searchText.trim()); }}>
        <Input style={{ maxWidth: 360 }} placeholder="Search people, subjects and messages" value={searchText} onChange={(e) => setSearchText(e.target.value)} />
        <Btn type="submit" small>Search</Btn>
        {search && <Btn small onClick={() => { setSearch(""); setSearchText(""); }}>Clear</Btn>}
      </form>
      {(list.error || thread.error || action.error) && <Banner tone="bad">{list.error || thread.error || action.error}</Banner>}
      <div className="inbox-chat-layout" style={{ display: "grid", gridTemplateColumns: "minmax(260px, 360px) 1fr", gap: 14, alignItems: "start" }}>
        <div style={{ ...S.card, padding: 0, gap: 0, overflow: "hidden" }}>
          {list.loading && <p style={{ ...S.sub, padding: 14 }}>Loading…</p>}
          {!list.loading && (list.data || []).length === 0 && <p style={{ ...S.sub, padding: 14 }}>{search ? "No conversations match." : "Nothing here yet."}</p>}
          {(list.data || []).map((c) => (
            <button key={c.id} type="button" onClick={() => setSelected(c.id)}
              style={{ textAlign: "left", background: selected === c.id ? "rgba(47,191,166,0.10)" : "none", border: "none", borderBottom: `1px solid ${T.rule}`, color: T.text, padding: "10px 14px", cursor: "pointer", display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={{ ...S.row, justifyContent: "space-between", flexWrap: "nowrap" }}>
                <strong style={{ fontWeight: c.unread_count > 0 ? 800 : 500, fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{participantLabel(c, own)}</strong>
                <span style={S.sub}>{c.last_message_at ? new Date(c.last_message_at).toLocaleDateString() : ""}</span>
              </span>
              <span style={{ fontSize: 13, fontWeight: c.unread_count > 0 ? 700 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.subject || "(no subject)"}</span>
              <span style={{ ...S.sub, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.has_draft ? "Draft · " : ""}{c.snippet}</span>
              <span style={S.row}>
                {c.unread_count > 0 && <Pill tone="ok">{c.unread_count} new</Pill>}
                {c.lead_id && <Pill>Lead</Pill>}
                {c.has_attachments && <Pill>Attachment</Pill>}
              </span>
            </button>
          ))}
        </div>
        <div className="inbox-chat-thread" style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          {!selected && <Muted>Select a conversation to read it.</Muted>}
          {selected && thread.loading && !t && <Muted>Loading…</Muted>}
          {convo && (
            <>
              <div style={{ ...S.card }}>
                <div style={{ ...S.row, justifyContent: "space-between" }}>
                  <h3 style={S.h3}>{convo.subject || "(no subject)"}</h3>
                  <div style={S.row}>
                    <Btn small disabled={action.busy} onClick={() => action.run(async () => { await emailApi.archive(supabase, convo.id, convo.status !== "archived"); refresh(); })}>{convo.status === "archived" ? "Move to inbox" : "Archive"}</Btn>
                    <Btn small disabled={action.busy} onClick={() => action.run(async () => { await emailApi.markRead(supabase, convo.id, false); refresh(); })}>Mark unread</Btn>
                  </div>
                </div>
                <Field label="CRM lead">
                  <Select value={convo.lead_id || ""} onChange={(e) => action.run(async () => { await emailApi.linkLead(supabase, convo.id, e.target.value || null); refresh(); })}
                    options={[["", "Not linked"], ...leads.map((l) => [l.id, l.companyName || l.company_name || "Untitled lead"])]} />
                </Field>
                {convo.lead_id && onOpenLead && <div><Btn small onClick={() => onOpenLead(convo.lead_id)}>Open lead</Btn></div>}
              </div>
              {(t.messages || []).map((m) => (
                <MessageCard key={m.id} m={m} supabase={supabase} onEditDraft={editDraft} onForward={forward} />
              ))}
              <InlineEmailComposer
                key={selected}
                supabase={supabase}
                accountId={convo.account_id}
                conversationId={convo.id}
                initial={{ to: (convo.participants || []).map((p) => p.email).filter((email) => email && !own.some((address) => address.toLowerCase() === email.toLowerCase())).join(", "), subject: replySubject(convo.subject || "") }}
                onSent={refresh}
              />
            </>
          )}
        </div>
      </div>
      {composer && <ComposeModal supabase={supabase} accounts={accts} initial={composer} onClose={() => setComposer(null)} onSent={() => { setComposer(null); refresh(); }} />}
    </div>
  );
}
