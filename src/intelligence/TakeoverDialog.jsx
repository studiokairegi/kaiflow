// Paste an earlier conversation with a CRM lead so Intelligence can take over. The paste is split into messages here and
// the person confirms who wrote each one. Saving stores the conversation and queues the worker to read it and prepare a DRAFT.
// Nothing is emailed from this dialog: every draft waits for approval in Outreach, and goes only to the lead's CRM email.
import React, { useState } from "react";
import { S, T, Btn, Pill, Banner, Field, Modal, useBusy } from "../finance/ui.jsx";
import { intelApi } from "./api.js";
import { PROSPECT_TYPES, fmtWhen } from "./logic.js";
import { Input, Muted, Select, TextArea, useLoad, confirmAction } from "./kit.jsx";
import {
  MAX_PASTE, cleanEntries, entryProblems, lastSpeaker, parseConversation, reverseEntries, suggestedLastContact, takeoverInfo, toIsoDate,
} from "./conversation.js";

const SIDES = [["", "Choose…"], ["outbound", "We sent"], ["inbound", "They replied"]];

export default function TakeoverDialog({ supabase, row, takeover, onClose, onChanged }) {
  const { busy, error, run } = useBusy();
  const history = useLoad(() => intelApi.crmHistory(supabase, row.lead_id), [supabase, row.lead_id]);
  const [raw, setRaw] = useState("");
  const [entries, setEntries] = useState(null);       // null = nothing read yet
  const [warnings, setWarnings] = useState([]);
  const [lastContact, setLastContact] = useState("");
  const [sourceEmail, setSourceEmail] = useState("");
  const [type, setType] = useState("indie_game_developer");
  const [done, setDone] = useState(null);
  const info = takeoverInfo(takeover);
  const lead = { email: row.email, name: row.contact_person || "" };
  const problems = entries ? entryProblems(entries) : [];
  const dateOk = !!toIsoDate(lastContact);

  const read = () => {
    const r = parseConversation(raw, lead);
    setEntries(r.entries.map((e) => ({ ...e, direction: e.direction === "unknown" ? "" : e.direction, subject: e.subject || r.subject })));
    setWarnings(r.warnings);
    setLastContact(suggestedLastContact(r.entries, row.last_contact) || "");
  };
  const patch = (i, p) => setEntries((list) => list.map((e, k) => (k === i ? { ...e, ...p } : e)));
  const drop = (i) => setEntries((list) => list.filter((_, k) => k !== i));
  const add = () => setEntries((list) => [...(list || []), { direction: "", at: null, subject: "", body: "" }]);
  const flip = () => setEntries((list) => reverseEntries(list));

  const save = () => {
    if (problems.length || !dateOk) return;
    const n = entries.length;
    const side = lastSpeaker(entries) === "inbound" ? "They wrote last, so Intelligence will prepare a reply." : "You wrote last, so Intelligence will plan a follow-up for when it is due.";
    if (!confirmAction(`Save ${n} message(s) for ${row.company_name}? ${side} Nothing is sent: every draft waits for your approval and goes only to ${row.email}.`)) return;
    run(async () => {
      const res = await intelApi.crmImportHistory(supabase, { leadId: row.lead_id, type, entries: cleanEntries(entries), raw: raw.slice(0, MAX_PASTE), lastContact: toIsoDate(lastContact), sourceEmail });
      setDone(res);
      setEntries(null); setRaw("");
      await history.reload();
      await onChanged();
    });
  };
  const reanalyse = () => run(async () => { await intelApi.crmTakeoverRefresh(supabase, row.lead_id); await onChanged(); });
  const remove = (h) => {
    if (!confirmAction("Remove this pasted conversation? Intelligence will stop using it.")) return;
    run(async () => { await intelApi.crmRemoveHistory(supabase, h.id); await history.reload(); await onChanged(); });
  };

  return (
    <Modal title={`Take over: ${row.company_name}`} onClose={onClose} width={860} footer={<Btn onClick={onClose}>Close</Btn>}>
      {(error || history.error) && <Banner tone="bad">{error || history.error}</Banner>}
      <Banner tone="info">
        Messages are only ever sent to <strong>{row.email}</strong>, the address on this lead in the CRM, and only after you approve them in Outreach.
        If you change or remove that address, nothing more is sent to this lead.
      </Banner>

      {info && (
        <div style={S.card}>
          <div style={{ ...S.row, justifyContent: "space-between" }}>
            <div style={S.row}><h3 style={S.h3}>What Intelligence made of it</h3><Pill tone={info.tone}>{info.label}</Pill></div>
            <Btn small disabled={busy || takeover?.state === "pending"} onClick={reanalyse}>Re-analyse</Btn>
          </div>
          {takeover?.summary && <p style={{ margin: 0, lineHeight: 1.55 }}>{takeover.summary}</p>}
          {(info.detail || takeover?.state !== "failed") && <Muted>{info.detail || info.help}</Muted>}
          {Array.isArray(takeover?.open_questions) && takeover.open_questions.length > 0 && (
            <Muted>They are waiting on: {takeover.open_questions.join(" · ")}</Muted>
          )}
        </div>
      )}

      {done && <Banner tone="ok">Saved. Intelligence is reading the conversation now. The result appears above and the draft, if one is needed, appears under Outreach.</Banner>}

      {(history.data || []).length > 0 && (
        <div style={S.card}>
          <h3 style={S.h3}>Conversations already given to Intelligence</h3>
          {(history.data || []).map((h) => (
            <div key={h.id} style={{ ...S.row, justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <strong>{(h.entries || []).length} message(s)</strong>
                <span style={{ color: T.muted }}> · last contact {h.last_contact} · added {fmtWhen(h.created_at)}</span>
                <div style={{ ...S.sub, whiteSpace: "pre-wrap" }}>{String(h.entries?.[h.entries.length - 1]?.body || "").slice(0, 160)}</div>
              </div>
              <Btn small kind="danger" disabled={busy} onClick={() => remove(h)}>Remove</Btn>
            </div>
          ))}
        </div>
      )}

      <div style={S.card}>
        <h3 style={S.h3}>{(history.data || []).length ? "Add more of the conversation" : "Paste the conversation"}</h3>
        <Muted>
          Copy the whole email thread from the mailbox you used before and paste it here. Replies quoted underneath each other, Outlook and Gmail
          headers and Japanese headers are recognised. You can fix anything before saving.
        </Muted>
        <TextArea rows={8} value={raw} onChange={(e) => setRaw(e.target.value)} maxLength={MAX_PASTE} placeholder="Paste the earlier emails here (oldest or newest first)…" aria-label="Pasted conversation" />
        <div style={S.row}>
          <Btn kind="primary" disabled={busy || !raw.trim()} onClick={read}>Read it</Btn>
          {entries && <Btn disabled={busy} onClick={flip}>Reverse order</Btn>}
        </div>
      </div>

      {entries && (
        <div style={S.card}>
          <h3 style={S.h3}>Check who said what (oldest first)</h3>
          {warnings.map((w) => <Banner key={w} tone="warn">{w}</Banner>)}
          {entries.map((e, i) => (
            <div key={i} style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={S.row}>
                <Select value={e.direction} onChange={(ev) => patch(i, { direction: ev.target.value })} options={SIDES} style={{ maxWidth: 170 }} aria-label={`Message ${i + 1}: who wrote it`} />
                <Input type="date" value={e.at || ""} onChange={(ev) => patch(i, { at: ev.target.value || null })} style={{ maxWidth: 170 }} aria-label={`Message ${i + 1}: date`} />
                <Input value={e.subject || ""} onChange={(ev) => patch(i, { subject: ev.target.value })} placeholder="Subject (optional)" style={{ flex: 1, minWidth: 160 }} aria-label={`Message ${i + 1}: subject`} />
                <Btn small kind="link" disabled={busy} onClick={() => drop(i)}>Remove</Btn>
              </div>
              <TextArea rows={4} value={e.body} onChange={(ev) => patch(i, { body: ev.target.value })} aria-label={`Message ${i + 1}: text`} />
            </div>
          ))}
          <div><Btn small onClick={add}>Add a message</Btn></div>

          <div style={S.grid(220)}>
            <Field label="Date of the newest message" hint="Follow-up timing counts from this day.">
              <Input type="date" value={lastContact} onChange={(ev) => setLastContact(ev.target.value)} />
            </Field>
            {!takeover && (
              <Field label="Which campaign is this lead for?"><Select value={type} onChange={(ev) => setType(ev.target.value)} options={Object.entries(PROSPECT_TYPES)} /></Field>
            )}
            <Field label="Other address you used before (optional)" hint="For your own reference.">
              <Input type="email" value={sourceEmail} onChange={(ev) => setSourceEmail(ev.target.value)} placeholder="you@old-mailbox.com" />
            </Field>
          </div>
          {problems.length > 0 && <Banner tone="warn">{problems.slice(0, 4).join(" ")}</Banner>}
          {!dateOk && <Banner tone="warn">Enter the date of the newest message.</Banner>}
          <div style={S.row}>
            <Btn kind="primary" disabled={busy || problems.length > 0 || !dateOk} onClick={save}>Save and let Intelligence take over</Btn>
            <Muted>Nothing is sent. You approve every message in Outreach.</Muted>
          </div>
        </div>
      )}
    </Modal>
  );
}
