import React from "react";
import { S, T, Btn, Pill, Banner, Modal, Table, useBusy } from "../finance/ui.jsx";
import { intelApi } from "./api.js";
import { PROSPECT_TYPES, fmtWhen, statusInfo } from "./logic.js";
import { Muted, useLoad } from "./kit.jsx";
import AiGeneratedBadge from "./AiGeneratedBadge.jsx";

export default function ProspectModal({ prospect: p, supabase, onClose, onChanged, onOpenLead }) {
  const { busy, error, run } = useBusy();
  const ev = useLoad(() => intelApi.evidence(supabase, p.id), [supabase, p.id]);
  const est = p.facts?.estimates || {};
  const dups = Array.isArray(est.duplicate_candidates) ? est.duplicate_candidates : [];
  const rows = Array.isArray(p.score_breakdown) ? p.score_breakdown : [];
  const act = (fn) => run(async () => { await fn(); await onChanged(); onClose(); });
  const approve = () => act(async () => { await intelApi.reviewProspect(supabase, p.id, "approve"); await intelApi.enqueue(supabase, "resolve", { prospect_id: p.id }); });
  return (
    <Modal title={p.name} onClose={onClose} width={760} footer={<Btn onClick={onClose}>Close</Btn>}>
      {error && <Banner tone="bad">{error}</Banner>}
      <div style={S.row}>
        <Pill tone={statusInfo(p.status).tone}>{statusInfo(p.status).label}</Pill>
        <Pill tone="info">{PROSPECT_TYPES[p.type]}</Pill>
        {p.score !== null && p.score !== undefined && <Pill tone={p.score >= 70 ? "ok" : p.score >= 50 ? "warn" : "muted"}>Score {p.score}/100</Pill>}
        {p.lead_id && <><AiGeneratedBadge /><Btn small kind="link" onClick={() => onOpenLead && onOpenLead(p.lead_id)}>Open lead</Btn></>}
      </div>
      <div style={S.grid(220)}>
        <div><span style={S.label}>Website</span><div>{p.website ? <a href={p.website.startsWith("http") ? p.website : `https://${p.website}`} target="_blank" rel="noreferrer noopener" style={{ color: T.accentText }}>{p.website}</a> : "-"}</div></div>
        <div><span style={S.label}>Contact</span><div>{p.contact_name || "-"} {p.contact_email && <span style={{ color: T.muted }}>{p.contact_email}</span>}</div></div>
        <div><span style={S.label}>Country / language</span><div>{p.country || "-"} / {p.language}</div></div>
        <div><span style={S.label}>Contact found at</span><div style={{ wordBreak: "break-all" }}>{p.contact_source_url || "-"}</div></div>
      </div>
      {p.review_reason && <Banner tone="warn">{p.review_reason}</Banner>}

      {dups.length > 0 && (
        <div style={S.card}>
          <h3 style={S.h3}>Possible existing leads</h3>
          <Muted>Nothing is created or emailed until you decide.</Muted>
          {dups.map((d) => (
            <div key={d.lead_id} style={S.row}>
              <Pill tone={d.confidence === "very_high" ? "bad" : "warn"}>{d.confidence.replace("_", " ")}</Pill>
              <span style={{ color: T.muted }}>matched on {d.reason}</span>
              <Btn small disabled={busy} onClick={() => act(() => intelApi.reviewProspect(supabase, p.id, "use_lead", d.lead_id))}>Use this lead</Btn>
              <Btn small kind="link" onClick={() => onOpenLead && onOpenLead(d.lead_id)}>Look at it</Btn>
            </div>
          ))}
          <Btn small disabled={busy} onClick={() => act(() => intelApi.reviewProspect(supabase, p.id, "create_new"))}>It is different: create a new AI lead</Btn>
        </div>
      )}

      <div style={S.card}>
        <h3 style={S.h3}>Evidence</h3>
        <Muted>"Verified" means the text was found verbatim on the page we fetched. Anything else is an estimate.</Muted>
        {ev.error && <Banner tone="bad">{ev.error}</Banner>}
        <Table rowKey={(r) => r.id} empty={ev.loading ? "Loading…" : "No evidence stored."}
          columns={[
            { key: "fact_type", label: "Signal", render: (r) => r.fact_type },
            { key: "snippet", label: "Found", render: (r) => <span style={{ whiteSpace: "pre-wrap" }}>{r.snippet || "-"}</span> },
            { key: "verified", label: "", render: (r) => <Pill tone={r.verified ? "ok" : "muted"}>{r.verified ? "verified" : "estimate"}</Pill> },
            { key: "url", label: "Source", render: (r) => r.url ? <a href={r.url} target="_blank" rel="noreferrer noopener" style={{ color: T.accentText }}>link</a> : "-" },
          ]}
          rows={ev.data || []} />
      </div>

      {rows.length > 0 && (
        <div style={S.card}>
          <h3 style={S.h3}>How the score was calculated</h3>
          <Table rowKey={(r) => r.criterion} columns={[
            { key: "criterion", label: "Criterion" },
            { key: "points", label: "Points", num: true, render: (r) => `${r.points} / ${r.max}` },
            { key: "why", label: "Why" },
          ]} rows={rows} />
        </div>
      )}

      <div style={{ ...S.row, justifyContent: "space-between" }}>
        <span style={S.sub}>Last updated {fmtWhen(p.updated_at)}</span>
        <div style={S.row}>
          {p.status === "needs_review" && dups.length === 0 && <Btn kind="primary" disabled={busy} onClick={approve}>Approve for outreach</Btn>}
          {!["rejected", "closed", "suppressed"].includes(p.status) && <Btn kind="danger" disabled={busy} onClick={() => act(() => intelApi.reviewProspect(supabase, p.id, "reject"))}>Reject</Btn>}
        </div>
      </div>
    </Modal>
  );
}
