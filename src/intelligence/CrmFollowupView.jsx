// Existing CRM leads: a read-only review of the leads already in KairFlow, then an explicit, limited step to bring chosen
// ones into Intelligence so follow-up DRAFTS can be prepared. Nothing is sent from here; every draft waits for approval.
import React, { useMemo, useState } from "react";
import { S, Btn, Pill, Banner, Table, useBusy } from "../finance/ui.jsx";
import { intelApi } from "./api.js";
import { CRM_ORDER, MAX_ADOPT, PROSPECT_TYPES, bucketInfo, canAdopt, fmtWhen, toggleSelection } from "./logic.js";
import { Muted, Section, Select, useLoad, confirmAction } from "./kit.jsx";

export default function CrmFollowupView({ supabase, tick, onChanged, onOpenLead }) {
  const review = useLoad(() => intelApi.crmReview(supabase, 500), [supabase, tick]);
  const [filter, setFilter] = useState("follow_up_due");
  const [selected, setSelected] = useState(new Set());
  const [type, setType] = useState("indie_game_developer");
  const [result, setResult] = useState(null);
  const { busy, error, run } = useBusy();
  const data = review.data || { counts: {}, leads: [] };
  const rows = useMemo(() => (data.leads || []).filter((r) => filter === "all" || r.bucket === filter), [data, filter]);

  const adopt = () => {
    if (!selected.size) return;
    if (!confirmAction(`Bring ${selected.size} lead(s) into Intelligence as ${PROSPECT_TYPES[type]}? Nothing is sent. Follow-up drafts will wait for your approval.`)) return;
    run(async () => {
      setResult(await intelApi.crmAdopt(supabase, [...selected], type));
      setSelected(new Set());
      await review.reload();
      await onChanged();
    });
  };
  const prepare = () => run(async () => { await intelApi.enqueue(supabase, "followup_scan", {}); await onChanged(); setResult({ queued: true }); });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {(error || review.error) && <Banner tone="bad">{error || review.error}</Banner>}
      <Banner tone="info">This is a review of the leads you already have. Nothing is emailed from this screen. Leads that replied, were lost or closed, opted out, or have no email are never offered for follow-up.</Banner>
      <Section title="Existing leads" hint="Counts by what each lead's history says. Click a count to filter.">
        <div style={S.row}>
          {CRM_ORDER.map((b) => (
            <Btn key={b} small kind={filter === b ? "primary" : "default"} onClick={() => setFilter(b)} title={bucketInfo(b).help}>{bucketInfo(b).label}: {data.counts?.[b] || 0}</Btn>
          ))}
          <Btn small kind={filter === "all" ? "primary" : "default"} onClick={() => setFilter("all")}>All</Btn>
        </div>
        <Table rowKey={(r) => r.lead_id} empty={review.loading ? "Loading…" : "No leads in this group."} rows={rows}
          columns={[
            { key: "sel", label: "", render: (r) => (canAdopt(r) ? <input type="checkbox" aria-label={`Select ${r.company_name}`} checked={selected.has(r.lead_id)} onChange={() => setSelected(toggleSelection(selected, r))} /> : null) },
            { key: "company_name", label: "Lead", render: (r) => <Btn small kind="link" onClick={() => onOpenLead?.(r.lead_id)}>{r.company_name}</Btn> },
            { key: "bucket", label: "Group", render: (r) => <Pill tone={bucketInfo(r.bucket).tone}>{bucketInfo(r.bucket).label}</Pill> },
            { key: "stage", label: "Stage" },
            { key: "last_contact", label: "Last contact", render: (r) => (r.last_contact ? fmtWhen(r.last_contact).split(",")[0] : "-") },
            { key: "emails_sent", label: "Emails sent", num: true },
            { key: "reason", label: "Why", render: (r) => <span style={{ opacity: 0.8 }}>{r.reason}{r.tracked ? " (already in Intelligence)" : ""}</span> },
          ]} />
      </Section>
      <Section title="Prepare follow-ups" hint={`Choose up to ${MAX_ADOPT} leads with a checkbox, pick which campaign they belong to, then bring them in. Drafts appear under Outreach and Conversations.`}>
        <div style={S.row}>
          <Select value={type} onChange={(e) => setType(e.target.value)} options={Object.entries(PROSPECT_TYPES)} style={{ maxWidth: 260 }} />
          <Btn kind="primary" disabled={busy || !selected.size} onClick={adopt}>Bring {selected.size || ""} selected into Intelligence</Btn>
          <Btn disabled={busy} onClick={prepare}>Prepare follow-up drafts now</Btn>
        </div>
        {result && !result.queued && (
          <Muted>
            Brought in: {result.adopted}. {result.skipped?.length ? `Skipped ${result.skipped.length}: ${result.skipped.map((s) => s.reason).join(", ")}.` : ""}
          </Muted>
        )}
        {result?.queued && <Muted>Queued. The worker prepares drafts for follow-ups that are due; they wait for your approval.</Muted>}
      </Section>
    </div>
  );
}
