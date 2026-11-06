// Existing CRM leads: a review of the leads already in KairFlow, then explicit, limited steps to bring them into Intelligence:
//   - paste an earlier conversation so Intelligence can take over (follow-up or reply DRAFT);
//   - bring in leads that were contacted but have no pasted history (follow-up timing only);
//   - draft an introduction for leads never contacted.
// Only leads with an email address in the CRM can be followed up or contacted. Nothing is sent from here; every draft waits for approval.
import React, { useMemo, useState } from "react";
import { S, Btn, Pill, Banner, Table, useBusy } from "../finance/ui.jsx";
import { intelApi } from "./api.js";
import { CRM_ORDER, MAX_ADOPT, PROSPECT_TYPES, bucketInfo, canAdopt, fmtWhen, toggleSelection } from "./logic.js";
import { canImport, canIntroduce, takeoverInfo } from "./conversation.js";
import { Muted, Section, Select, useLoad, confirmAction } from "./kit.jsx";
import TakeoverDialog from "./TakeoverDialog.jsx";

export default function CrmFollowupView({ supabase, tick, onChanged, onOpenLead }) {
  const review = useLoad(() => intelApi.crmReview(supabase, 500), [supabase, tick]);
  const states = useLoad(() => intelApi.takeoverStates(supabase), [supabase, tick]);
  const [filter, setFilter] = useState("follow_up_due");
  const [selected, setSelected] = useState(new Set());
  const [intro, setIntro] = useState(new Set());
  const [type, setType] = useState("indie_game_developer");
  const [result, setResult] = useState(null);
  const [dialog, setDialog] = useState(null);
  const { busy, error, run } = useBusy();
  const data = review.data || { counts: {}, leads: [] };
  const rows = useMemo(() => (data.leads || []).filter((r) => filter === "all" || r.bucket === filter), [data, filter]);
  const takeoverByLead = useMemo(() => new Map((states.data || []).map((p) => [p.lead_id, p.takeover])), [states.data]);
  const refreshAll = async () => { await review.reload(); await states.reload(); await onChanged(); };

  const toggleIntro = (row) => {
    const next = new Set(intro);
    if (next.has(row.lead_id)) next.delete(row.lead_id);
    else if (canIntroduce(row) && next.size < MAX_ADOPT) next.add(row.lead_id);
    setIntro(next);
  };

  const adopt = () => {
    if (!selected.size) return;
    if (!confirmAction(`Bring ${selected.size} lead(s) into Intelligence as ${PROSPECT_TYPES[type]}? Nothing is sent. Follow-up drafts will wait for your approval.`)) return;
    run(async () => {
      setResult({ kind: "adopt", ...(await intelApi.crmAdopt(supabase, [...selected], type)) });
      setSelected(new Set());
      await refreshAll();
    });
  };
  const introduce = () => {
    if (!intro.size) return;
    if (!confirmAction(`Draft an introduction for ${intro.size} lead(s) that were never contacted, as ${PROSPECT_TYPES[type]}? Nothing is sent. Each draft waits for your approval and goes only to the email address on the lead.`)) return;
    run(async () => {
      setResult({ kind: "introduce", ...(await intelApi.crmIntroduce(supabase, [...intro], type)) });
      setIntro(new Set());
      await refreshAll();
    });
  };
  const prepare = () => run(async () => { await intelApi.enqueue(supabase, "followup_scan", {}); await onChanged(); setResult({ kind: "queued" }); });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {(error || review.error || states.error) && <Banner tone="bad">{error || review.error || states.error}</Banner>}
      <Banner tone="info">
        Intelligence only follows up or contacts leads that have an <strong>email address in the CRM</strong>, and writes only to that address. Nothing is emailed from this screen.
        If an earlier conversation happened by hand or from another mailbox, use <strong>Paste conversation</strong> on that lead so Intelligence can read it and take over.
        Leads that were lost or closed, are clients, or opted out are never offered.
      </Banner>
      <Section title="Existing leads" hint="Counts by what each lead's history says. Click a count to filter.">
        <div style={S.row}>
          {CRM_ORDER.map((b) => (
            <Btn key={b} small kind={filter === b ? "primary" : "default"} onClick={() => setFilter(b)} title={bucketInfo(b).help}>{bucketInfo(b).label}: {data.counts?.[b] || 0}</Btn>
          ))}
          <Btn small kind={filter === "all" ? "primary" : "default"} onClick={() => setFilter("all")}>All</Btn>
        </div>
        <Table rowKey={(r) => r.lead_id} empty={review.loading ? "Loading…" : "No leads in this group."} rows={rows}
          columns={[
            { key: "sel", label: "", render: (r) => {
              if (canAdopt(r)) return <input type="checkbox" aria-label={`Select ${r.company_name} for follow-up`} checked={selected.has(r.lead_id)} onChange={() => setSelected(toggleSelection(selected, r))} />;
              if (canIntroduce(r)) return <input type="checkbox" aria-label={`Select ${r.company_name} for an introduction`} checked={intro.has(r.lead_id)} onChange={() => toggleIntro(r)} />;
              return null;
            } },
            { key: "company_name", label: "Lead", render: (r) => <Btn small kind="link" onClick={() => onOpenLead?.(r.lead_id)}>{r.company_name}</Btn> },
            { key: "email", label: "Email", render: (r) => (r.email ? <span style={{ opacity: 0.85 }}>{r.email}</span> : <Pill tone="muted">none in CRM</Pill>) },
            { key: "bucket", label: "Group", render: (r) => <Pill tone={bucketInfo(r.bucket).tone}>{bucketInfo(r.bucket).label}</Pill> },
            { key: "stage", label: "Stage" },
            { key: "last_contact", label: "Last contact", render: (r) => (r.last_contact ? fmtWhen(r.last_contact).split(",")[0] : "-") },
            { key: "emails_sent", label: "Emails sent", num: true },
            { key: "takeover", label: "Take-over", render: (r) => {
              const info = takeoverInfo(takeoverByLead.get(r.lead_id));
              if (!canImport(r)) return <span style={{ opacity: 0.6 }}>-</span>;
              return (
                <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
                  {info && <Pill tone={info.tone}>{info.label}</Pill>}
                  <Btn small onClick={() => setDialog(r)}>{info ? "Open conversation" : "Paste conversation"}</Btn>
                </div>
              );
            } },
            { key: "reason", label: "Why", render: (r) => <span style={{ opacity: 0.8 }}>{r.reason}{r.tracked ? " (already in Intelligence)" : ""}</span> },
          ]} />
      </Section>
      <Section title="Prepare follow-ups and introductions" hint={`Tick up to ${MAX_ADOPT} leads, pick which campaign they belong to, then use the button that matches. Drafts appear under Outreach and Conversations and wait for your approval.`}>
        <div style={S.row}>
          <Select value={type} onChange={(e) => setType(e.target.value)} options={Object.entries(PROSPECT_TYPES)} style={{ maxWidth: 260 }} />
          <Btn kind="primary" disabled={busy || !selected.size} onClick={adopt}>Bring {selected.size || ""} contacted lead(s) in for follow-up</Btn>
          <Btn disabled={busy || !intro.size} onClick={introduce}>Draft introductions for {intro.size || ""} never-contacted lead(s)</Btn>
          <Btn disabled={busy} onClick={prepare}>Prepare follow-up drafts now</Btn>
        </div>
        <Muted>Have the earlier emails? Use Paste conversation on the lead instead of Bring in: Intelligence then continues from what was actually said.</Muted>
        {result?.kind === "adopt" && (
          <Muted>
            Brought in: {result.adopted}. {result.skipped?.length ? `Skipped ${result.skipped.length}: ${result.skipped.map((s) => s.reason).join(", ")}.` : ""}
          </Muted>
        )}
        {result?.kind === "introduce" && (
          <Muted>
            Introduction drafts requested: {result.introduced}. {result.skipped?.length ? `Skipped ${result.skipped.length}: ${result.skipped.map((s) => s.reason).join(", ")}.` : ""}
          </Muted>
        )}
        {result?.kind === "queued" && <Muted>Queued. The worker prepares drafts for follow-ups that are due; they wait for your approval.</Muted>}
      </Section>
      {dialog && <TakeoverDialog supabase={supabase} row={dialog} takeover={takeoverByLead.get(dialog.lead_id)} onClose={() => setDialog(null)} onChanged={refreshAll} />}
    </div>
  );
}
