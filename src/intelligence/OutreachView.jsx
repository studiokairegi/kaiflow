import React, { useEffect, useMemo, useState } from "react";
import { S, T, Btn, Pill, Banner, Field, Modal, useBusy } from "../finance/ui.jsx";
import { intelApi } from "./api.js";
import { CLASS_LABEL, conversations, findTargetProspect, fmtWhen, stateInfo } from "./logic.js";
import { Input, Muted, Section, TextArea, useLoad, confirmAction } from "./kit.jsx";

const REPLY_OUTCOMES = {
  not_now: ["Not now", "Pause and review whether a later contact is welcome."],
  not_interested: ["Not interested", "Stops this sequence; it is not automatically an unsubscribe or permanent DNC."],
  already_has_trailer: ["Already has a trailer", "Stops this sequence and flags future need for human review."],
  wrong_person: ["Wrong person", "Human review is needed to correct the contact."],
  referral: ["Referral", "Review the suggested contact before any outreach."],
  tell_me_more: ["Tell me more", "A reply may be drafted, but it remains pending your approval."],
  unsubscribe: ["Unsubscribe", "Suppression takes priority and blocks further contact."],
  complaint: ["Complaint", "Suppression takes priority and blocks further contact."],
};

function ReviewModal({ m, supabase, onClose, onDone }) {
  const [subject, setSubject] = useState(m.subject);
  const [body, setBody] = useState(m.body_text);
  const { busy, error, run } = useBusy();
  const edited = subject !== m.subject || body !== m.body_text;
  const approve = () => run(async () => {
    if (edited) await intelApi.reviewMessage(supabase, m.id, "edit", subject, body);
    await intelApi.reviewMessage(supabase, m.id, "approve");
    await onDone(); onClose();
  });
  return (
    <Modal title={`Review ${m.kind === "initial" ? "introduction" : m.kind}`} onClose={onClose} width={720}
      footer={<><Btn kind="danger" disabled={busy} onClick={() => run(async () => { await intelApi.reviewMessage(supabase, m.id, "discard"); await onDone(); onClose(); })}>Discard</Btn>
        <Btn kind="primary" disabled={busy} onClick={approve}>{edited ? "Save changes and approve" : "Approve and queue"}</Btn></>}>
      {error && <Banner tone="bad">{error}</Banner>}
      <Muted>To: {m.to_email}. Approving queues it. It is sent only if sending is on, a daily limit allows it, and the recipient is not suppressed.</Muted>
      <Field label="Subject"><Input value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
      <Field label="Message" hint="Keep the opt-out line and postal address: sending is refused without them."><TextArea rows={14} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
    </Modal>
  );
}

function Thread({ conv, supabase, onChanged }) {
  const { busy, error, run } = useBusy();
  const last = [...conv.messages].reverse().find((m) => m.direction === "inbound");
  const [subject, setSubject] = useState(last ? (/^re:/i.test(last.subject) ? last.subject : `Re: ${last.subject}`) : "");
  const [body, setBody] = useState("");
  const p = conv.prospect;
  const replyBlocked = Boolean(
    p && (['closed', 'suppressed'].includes(p.status) ||
      conv.messages.some((m) => m.direction === 'inbound' && ['unsubscribe', 'complaint'].includes(m.classification)))
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {error && <Banner tone="bad">{error}</Banner>}
      <div style={S.row}><b>{p?.name || "Unmatched sender"}</b>{p?.contact_email && <span style={{ color: T.muted }}>{p.contact_email}</span>}</div>
      {conv.messages.map((m) => (
        <div key={m.id} style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: 12, background: m.direction === "inbound" ? "rgba(52,216,160,0.06)" : T.raised, display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={S.row}>
            <Pill tone={m.direction === "inbound" ? "ok" : "info"}>{m.direction === "inbound" ? "They wrote" : m.kind === "reply" ? "Reply" : m.kind === "followup" ? "Follow-up" : "Introduction"}</Pill>
            <Pill tone={stateInfo(m.state).tone}>{stateInfo(m.state).label}</Pill>
            {m.classification && <Pill tone={m.escalated ? "warn" : "muted"}>{CLASS_LABEL[m.classification] || m.classification}{m.escalated ? ", needs you" : ""}</Pill>}
          {REPLY_OUTCOMES[m.classification] && <Pill tone={["unsubscribe", "complaint"].includes(m.classification) ? "bad" : "warn"}>{REPLY_OUTCOMES[m.classification][0]}</Pill>}
            {m.auto_sent && m.direction === "outbound" && <Pill tone="muted">automatic</Pill>}
            <span style={{ color: T.faint, fontSize: 12 }}>{fmtWhen(m.sent_at || m.received_at || m.created_at)}</span>
          </div>
          <div style={{ fontWeight: 600 }}>{m.subject}</div>
          {REPLY_OUTCOMES[m.classification] && m.direction === "inbound" && <Banner tone={["unsubscribe", "complaint"].includes(m.classification) ? "bad" : "warn"}>{REPLY_OUTCOMES[m.classification][1]}</Banner>}
          <div style={{ whiteSpace: "pre-wrap", fontSize: 13.5, lineHeight: 1.55 }}>{m.body_text}</div>
          {m.error && <span style={{ color: T.bad, fontSize: 12.5 }}>{m.error}</span>}
          {m.state === "unknown" && <div style={S.row}>
            <Btn small disabled={busy} onClick={() => confirmAction("Confirm this email WAS delivered?") && run(async () => { await intelApi.resolveUnknown(supabase, m.id, "sent"); await onChanged(); })}>It was sent</Btn>
            <Btn small kind="danger" disabled={busy} onClick={() => confirmAction("Confirm it was NOT sent? It can then be retried.") && run(async () => { await intelApi.resolveUnknown(supabase, m.id, "not_sent"); await onChanged(); })}>It was not sent</Btn></div>}
          {m.state === "failed" && m.direction === "outbound" && <Btn small disabled={busy} onClick={() => run(async () => { await intelApi.reviewMessage(supabase, m.id, "retry"); await onChanged(); })}>Retry</Btn>}
        </div>
      ))}
      {conv.inbound && p && replyBlocked && (
        <Banner tone="bad">Reply composer unavailable: this prospect or recipient is closed or suppressed. Do not contact them unless an administrator has resolved the contactability record.</Banner>
      )}
      {conv.inbound && p && !replyBlocked && (
        <div style={S.card}>
          <h3 style={S.h3}>Reply yourself</h3>
          <Muted>Creates a draft for your approval. It is not sent automatically. Pricing, scheduling and commitments are always yours to answer.</Muted>
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />
          <TextArea rows={7} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write your reply" />
          <div><Btn kind="primary" disabled={busy || !body.trim()} onClick={() => run(async () => { await intelApi.composeReply(supabase, p.id, subject, body); setBody(""); await onChanged(); })}>Queue reply</Btn></div>
        </div>
      )}
    </div>
  );
}

function NewConversationModal({ supabase, prospects, onClose, onCreated }) {
  const { busy, error, run } = useBusy();
  const [leads, setLeads] = useState([]);
  const [leadId, setLeadId] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    (async () => {
      const { data, error: e } = await supabase.from("leads")
        .select("id,company_name,email,intel_prospect_id,stage")
        .not("intel_prospect_id", "is", null)
        .order("company_name", { ascending: true });
      if (!alive) return;
      if (e) { setLoading(false); return; }
      const linked = (data || []).filter((l) => prospects.some((p) => p.id === l.intel_prospect_id && p.lead_id === l.id) && l.email);
      setLeads(linked);
      if (linked.length) setLeadId(linked[0].id);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [supabase, prospects]);
  const selected = leads.find((l) => l.id === leadId);
  return (
    <Modal title="New conversation" onClose={onClose} width={720}
      footer={<><Btn onClick={onClose} disabled={busy}>Cancel</Btn><Btn kind="primary" disabled={busy || loading || !selected || !subject.trim() || !body.trim()} onClick={() => run(async () => { await intelApi.composeLeadMessage(supabase, leadId, subject, body); await onCreated(); onClose(); })}>Create for review</Btn></>}>
      {error && <Banner tone="bad">{error}</Banner>}
      <Muted>This creates an outbound draft for your approval. It does not send immediately.</Muted>
      {loading ? <Muted>Loading linked leads…</Muted> : leads.length === 0 ? <Banner tone="warn">No CRM leads linked to an Intelligence prospect with an email address were found.</Banner> : <>
        <Field label="CRM lead"><select value={leadId} onChange={(e) => setLeadId(e.target.value)} style={{ width: "100%", padding: 10, borderRadius: 8, border: `1px solid ${T.border}`, background: T.raised, color: T.text }}>{leads.map((l) => <option key={l.id} value={l.id}>{l.company_name} — {l.email}</option>)}</select></Field>
        {selected && <Muted>Recipient: {selected.email}</Muted>}
        <Field label="Subject"><Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" /></Field>
        <Field label="Message"><TextArea rows={12} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write your message" /></Field>
      </>}
    </Modal>
  );
}

export default function OutreachView({ supabase, tick, onChanged, focus }) {
  const msgs = useLoad(() => intelApi.messages(supabase), [supabase, tick]);
  const pros = useLoad(() => intelApi.prospects(supabase), [supabase, tick]);
  const [sel, setSel] = useState(null);
  const [review, setReview] = useState(null);
  const [newConversation, setNewConversation] = useState(false);
  const convs = useMemo(() => conversations(msgs.data, pros.data), [msgs.data, pros.data]);
  useEffect(() => {
    if (!focus || !msgs.data || !pros.data) return;
    const id = findTargetProspect(focus, pros.data, msgs.data);
    if (id) setSel(id);
  }, [focus?.nonce, msgs.data, pros.data]);
  const pending = (msgs.data || []).filter((m) => m.state === "pending_approval" && m.direction === "outbound");
  const active = convs.find((c) => c.prospectId === sel) || null;
  const reload = async () => { await msgs.reload(); await pros.reload(); await onChanged(); };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {(msgs.error || pros.error) && <Banner tone="bad">{msgs.error || pros.error}</Banner>}
      <div style={S.row}><Btn kind="primary" onClick={() => setNewConversation(true)}>New conversation</Btn></div>
      {pending.length > 0 && (
        <Section title={`Waiting for your approval (${pending.length})`} hint="Nothing here is sent until you approve it.">
          {pending.map((m) => (
            <div key={m.id} style={S.row}>
              <Pill tone="info">{m.kind === "initial" ? "Introduction" : m.kind}</Pill>
              <span style={{ flex: 1, minWidth: 180 }}><b>{pros.data?.find((p) => p.id === m.prospect_id)?.name || m.to_email}</b> <span style={{ color: T.muted }}>{m.subject}</span></span>
              <Btn small onClick={() => setReview(m)}>Review</Btn>
            </div>
          ))}
        </Section>
      )}
      <div style={S.grid(300)}>
        <Section title="Conversations" hint="Newest activity first.">
          {convs.length === 0 && <Muted>{msgs.loading ? "Loading…" : "No messages yet."}</Muted>}
          {convs.map((c) => (
            <button key={c.prospectId} type="button" onClick={() => setSel(c.prospectId)}
              style={{ textAlign: "left", background: sel === c.prospectId ? "rgba(47,191,166,0.12)" : "transparent", border: `1px solid ${T.border}`, borderRadius: 8, padding: "8px 10px", color: T.text, cursor: "pointer" }}>
              <div style={S.row}><b>{c.prospect?.name || "Unknown"}</b>{c.inbound && <Pill tone="ok">replied</Pill>}{c.needsAttention && <Pill tone="warn">needs you</Pill>}</div>
              <span style={{ fontSize: 12, color: T.muted }}>{fmtWhen(c.lastAt)}</span>
            </button>
          ))}
        </Section>
        <div style={{ gridColumn: "span 2", minWidth: 0 }}>
          {active ? <Thread conv={active} supabase={supabase} onChanged={reload} key={active.prospectId} /> : <Section title="Select a conversation"><Muted>Pick one on the left to read it and reply.</Muted></Section>}
        </div>
      </div>
      {review && <ReviewModal m={review} supabase={supabase} onClose={() => setReview(null)} onDone={reload} />}
      {newConversation && <NewConversationModal supabase={supabase} prospects={pros.data || []} onClose={() => setNewConversation(false)} onCreated={reload} />}
    </div>
  );
}
