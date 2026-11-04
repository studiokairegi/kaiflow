// KairFlow Inbox (Resend). Lives in the CRM area next to Pipeline / Contacts / Intelligence and renders only for people the
// database allows (same rule as Intelligence). The database re-checks every read and write; this file never holds provider keys.
import React, { useEffect, useRef, useState } from "react";
import { S, T, Banner, Btn, Field, Modal, Pill, Tabs, useBusy } from "../finance/ui.jsx";
import { canAccessIntelligence } from "../intelligence/access.js";
import { Input, Muted, Section, Select, TextArea, useLoad, confirmAction } from "../intelligence/kit.jsx";
import { emailApi } from "./api.js";
import { FOLDERS, attachmentProblem, buildForward, buildReply, composeProblem, fmtSize, isProblem, parseRecipients, participantLabel, statusLabel, textToHtml } from "./logic.js";

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

function Composer({ supabase, accounts, initial, onClose, onSent }) {
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

function MessageCard({ m, supabase, onEditDraft, onReply, onReplyAll, onForward }) {
  const [label, tone] = statusLabel(m.status);
  const open = async (att) => {
    try { window.open(await emailApi.attachmentUrl(supabase, att.storage_path), "_blank", "noopener"); } catch (e) { window.alert(e.message); }
  };
  return (
    <div style={{ ...S.card, borderLeft: `3px solid ${m.direction === "inbound" ? T.ok : T.border}` }}>
      <div style={{ ...S.row, justifyContent: "space-between" }}>
        <div>
          <strong>{m.from_name ? `${m.from_name} ` : ""}<span style={{ color: T.muted, fontWeight: 400 }}>&lt;{m.from_email}&gt;</span></strong>
          <p style={S.sub}>To: {(m.to_emails || []).join(", ") || "—"}{m.cc_emails?.length ? ` · Cc: ${m.cc_emails.join(", ")}` : ""}{m.direction === "outbound" && m.bcc_emails?.length ? ` · Bcc: ${m.bcc_emails.join(", ")}` : ""}</p>
        </div>
        <div style={S.row}>
          {m.ai_generated && <Pill tone="warn">AI draft: review before sending</Pill>}
          {m.direction === "outbound" && <Pill tone={tone}>{label}</Pill>}
          <span style={S.sub}>{when(m.received_at || m.sent_at || m.created_at)}</span>
        </div>
      </div>
      {isProblem(m.status) && <Banner tone="bad">{m.error || "This email was not delivered."} Nothing was resent automatically.</Banner>}
      <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.55, fontSize: 13.5, overflowWrap: "anywhere" }}>{m.body_text || "(no text content)"}</div>
      {m.attachments?.length > 0 && (
        <div style={S.row}>
          {m.attachments.map((a) => (
            <Btn key={a.id} small disabled={!a.storage_path} onClick={() => open(a)} title={a.storage_path ? "Open" : "Not stored (too large)"}>{a.filename} · {fmtSize(a.size_bytes)}</Btn>
          ))}
        </div>
      )}
      <div style={S.row}>
        {m.status === "draft" ? <Btn small kind="primary" onClick={() => onEditDraft(m)}>Edit draft</Btn> : (
          <>
            <Btn small onClick={() => onReply(m)}>Reply</Btn>
            <Btn small onClick={() => onReplyAll(m)}>Reply all</Btn>
            <Btn small onClick={() => onForward(m)}>Forward</Btn>
          </>
        )}
      </div>
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

  if (!allowed) return <Banner tone="warn">Email is restricted.</Banner>;
  const refresh = () => setTick((t) => t + 1);
  const accts = accounts.data || [];
  const own = accts.map((a) => a.address);
  if (!accounts.loading && accts.length === 0) return <div style={S.page}><SetupAccount supabase={supabase} onDone={refresh} /></div>;

  const t = thread.data;
  const convo = t?.conversation;
  const reply = (m, all) => setComposer({ title: all ? "Reply all" : "Reply", ...buildReply(m, own, { all, when: when(m.received_at || m.sent_at) }), conversationId: convo.id, accountId: convo.account_id });
  const forward = (m) => setComposer({ title: "Forward", ...buildForward(m, when(m.received_at || m.sent_at)), accountId: convo.account_id });
  const editDraft = (m) => setComposer({ title: "Draft", draftId: m.id, conversationId: m.conversation_id, accountId: m.account_id, to: (m.to_emails || []).join(", "), cc: (m.cc_emails || []).join(", "), bcc: (m.bcc_emails || []).join(", "), subject: m.subject, body: m.body_text });

  return (
    <div style={S.page}>
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
      <div style={{ display: "grid", gridTemplateColumns: "minmax(260px, 360px) 1fr", gap: 14, alignItems: "start" }}>
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
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
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
                <MessageCard key={m.id} m={m} supabase={supabase} onEditDraft={editDraft} onReply={(x) => reply(x, false)} onReplyAll={(x) => reply(x, true)} onForward={forward} />
              ))}
            </>
          )}
        </div>
      </div>
      {composer && <Composer supabase={supabase} accounts={accts} initial={composer} onClose={() => setComposer(null)} onSent={() => { setComposer(null); refresh(); }} />}
    </div>
  );
}
