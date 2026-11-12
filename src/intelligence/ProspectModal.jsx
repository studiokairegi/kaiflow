import React from "react";
import { S, T, Btn, Pill, Banner, Modal, Table, useBusy } from "../finance/ui.jsx";
import { intelApi } from "./api.js";
import { PROSPECT_TYPES, fmtWhen, statusInfo } from "./logic.js";
import { Muted, useLoad } from "./kit.jsx";
import AiGeneratedBadge from "./AiGeneratedBadge.jsx";
import IndieAdminPanel from "./IndieAdminPanel.jsx";

export default function ProspectModal({ prospect: p, supabase, onClose, onChanged, onOpenLead }) {
  const { busy, error, run } = useBusy();
  const ev = useLoad(() => intelApi.evidence(supabase, p.id), [supabase, p.id]);
  const est = p.facts?.estimates || {};
  const dups = Array.isArray(est.duplicate_candidates) ? est.duplicate_candidates : [];
  const qualification = est.qualification_v2 || {};
  const gates = qualification.mandatory_gates || {};
  const gateRows = Object.entries(gates).map(([key, value]) => ({ key, reason: value?.reason || "No explanation recorded", passed: value?.passed === true }));
  const gatesPass = qualification.model === "indie-project-v2" && p.score >= 75 && gateRows.length === 7 && gateRows.every((g) => g.passed) && qualification.contactability?.status === "pass";
  const verified = p.facts?.verified || {};
  const hasSuppressionFlag = ["bounced", "complained", "complaint", "unsubscribed", "do_not_contact", "suppressed"].some((k) => String(verified[k]).toLowerCase() === "true");
  const canApprove = p.type !== "indie_game_developer" || (p.status !== "suppressed" && gatesPass && !hasSuppressionFlag);
  const canLink = p.type !== "indie_game_developer" || (p.status !== "suppressed" && gatesPass && !hasSuppressionFlag);
  const rows = Array.isArray(p.score_breakdown) ? p.score_breakdown : [];
  const act = (fn) => run(async () => { await fn(); await onChanged(); onClose(); });
  const approve = () => act(async () => { await intelApi.reviewProspect(supabase, p.id, "approve"); await intelApi.enqueue(supabase, "resolve", { prospect_id: p.id }); });
  return (
    <Modal title={p.name} onClose={onClose} width={760} footer={<Btn onClick={onClose}>Close</Btn>}>
      {error && <Banner tone="bad">{error}</Banner>}
      <div style={S.row}>
        <Pill tone={statusInfo(p.status).tone}>{statusInfo(p.status).label}</Pill>
        <Pill tone="info">{PROSPECT_TYPES[p.type]}</Pill>
        {p.score !== null && p.score !== undefined && <Pill tone={p.score >= (p.type === "indie_game_developer" ? 75 : 70) ? "ok" : p.score >= (p.type === "indie_game_developer" ? 55 : 50) ? "warn" : "muted"}>Score {p.score}/100</Pill>}
        {p.lead_id && <><AiGeneratedBadge /><Btn small kind="link" onClick={() => onOpenLead && onOpenLead(p.lead_id)}>Open lead</Btn></>}
      </div>
      <div style={S.grid(220)}>
        <div><span style={S.label}>Website</span><div>{p.website ? <a href={p.website.startsWith("http") ? p.website : `https://${p.website}`} target="_blank" rel="noreferrer noopener" style={{ color: T.accentText }}>{p.website}</a> : "-"}</div></div>
        <div><span style={S.label}>Contact</span><div>{p.contact_name || "-"} {p.contact_email && <span style={{ color: T.muted }}>{p.contact_email}</span>}</div></div>
        <div><span style={S.label}>Country / language</span><div>{p.country || "-"} / {p.language}</div></div>
        <div><span style={S.label}>Contact found at</span><div style={{ wordBreak: "break-all" }}>{p.contact_source_url || "-"}</div></div>
      </div>
      {p.review_reason && <Banner tone="warn">{p.review_reason}</Banner>}

      {p.type === "indie_game_developer" && qualification.model === "indie-project-v2" && (
        <div style={S.card}>
          <h3 style={S.h3}>Mandatory project qualification</h3>
          <Muted>Every gate must pass before a project can qualify. A high score cannot override a failed gate.</Muted>
          <Table rowKey={(r) => r.key} columns={[
            { key: "key", label: "Requirement", render: (r) => r.key.replaceAll("_", " ") },
            { key: "passed", label: "Status", render: (r) => <Pill tone={r.passed ? "ok" : "warn"}>{r.passed ? "Passed" : "Not passed"}</Pill> },
            { key: "reason", label: "Evidence / reason" },
          ]} rows={gateRows} empty="No mandatory gate results recorded yet." />
          {p.project_title && <div style={{ marginTop: 8 }}><span style={S.label}>Project</span><div>{p.project_title}</div></div>}
          {p.project_source_url && <div><span style={S.label}>Project source</span><div style={{ wordBreak: "break-all" }}><a href={p.project_source_url} target="_blank" rel="noreferrer noopener" style={{ color: T.accentText }}>{p.project_source_url}</a></div></div>}
          {(p.project_announcement_date || p.project_campaign_date || p.project_expected_release_date || p.project_actual_release_date || p.project_latest_activity_date) && <div style={{ marginTop: 8 }}>
            <span style={S.label}>Project timing</span>
            <div style={S.grid(170)}>
              {[["Announcement", p.project_announcement_date], ["Campaign", p.project_campaign_date], ["Expected release", p.project_expected_release_date], ["Actual release", p.project_actual_release_date], ["Latest activity", p.project_latest_activity_date]].filter(([, value]) => value).map(([label, value]) => <div key={label}><span style={S.sub}>{label}</span><div>{value}</div></div>)}
            </div>
          </div>}
          {Array.isArray(p.project_marketing_milestones) && p.project_marketing_milestones.length > 0 && <div style={{ marginTop: 8 }}>
            <span style={S.label}>Marketing milestones</span>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {p.project_marketing_milestones.map((m, i) => <li key={`${m?.type || m?.title || "milestone"}-${i}`}>
                {m?.title || m?.name || m?.type || "Milestone"}{(m?.date || m?.start_date) ? ` · ${m?.date || m?.start_date}` : ""}
                {(m?.source_url || m?.url) && <> · <a href={m?.source_url || m?.url} target="_blank" rel="noreferrer noopener" style={{ color: T.accentText }}>source</a></>}
              </li>)}
            </ul>
          </div>}
          <Muted>Model {qualification.model} · {qualification.evidence_count ?? 0} verified evidence item(s)</Muted>
        </div>
      )}

      {p.type === "indie_game_developer" && <IndieAdminPanel prospect={p} evidence={ev.data || []} supabase={supabase} onChanged={async () => { await ev.reload(); await onChanged(); }} />}

      {dups.length > 0 && (
        <div style={S.card}>
          <h3 style={S.h3}>Possible existing leads</h3>
          <Muted>Nothing is created or emailed until you decide.</Muted>
          {dups.map((d) => (
            <div key={d.lead_id} style={S.row}>
              <Pill tone={d.confidence === "very_high" ? "bad" : "warn"}>{d.confidence.replace("_", " ")}</Pill>
              <span style={{ color: T.muted }}>matched on {d.reason}</span>
              <Btn small disabled={busy || !canLink} onClick={() => act(() => intelApi.reviewProspect(supabase, p.id, "use_lead", d.lead_id))}>Use this lead</Btn>
              <Btn small kind="link" onClick={() => onOpenLead && onOpenLead(d.lead_id)}>Look at it</Btn>
            </div>
          ))}
          <Btn small disabled={busy || !canApprove} onClick={() => act(() => intelApi.reviewProspect(supabase, p.id, "create_new"))}>It is different: create a new AI lead</Btn>
        </div>
      )}

      <div style={S.card}>
        <h3 style={S.h3}>Evidence</h3>
        <Muted>{p.type === "indie_game_developer" ? "Verified facts retain source provenance. Anime visual classifications require official screenshot, artwork, trailer or explicit official visual-style evidence; uncertain conclusions remain estimates." : "Verified means the text was found verbatim on the page we fetched. Anything else is an estimate."}</Muted>
        {ev.error && <Banner tone="bad">{ev.error}</Banner>}
        <Table rowKey={(r) => r.id} empty={ev.loading ? "Loading…" : "No evidence stored."}
          columns={[
            ...(p.type === "indie_game_developer" ? [{ key: "id", label: "Evidence ID", render: (r) => <span title={r.id}>{r.id ? r.id.slice(0, 8) : "-"}</span> }] : []),
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

      {p.type === "indie_game_developer" && p.status === "needs_review" && !canApprove && <Muted>Outreach approval is locked until the score is at least 75 and every mandatory qualification gate passes.</Muted>}

      <div style={{ ...S.row, justifyContent: "space-between" }}>
        <span style={S.sub}>Last updated {fmtWhen(p.updated_at)}</span>
        <div style={S.row}>
          {["discovered", "researched"].includes(p.status) && <Btn small disabled={busy} onClick={() => act(() => intelApi.markProspectForReview(supabase, p.id))}>Mark for review</Btn>}
          {p.status === "needs_review" && dups.length === 0 && <Btn kind="primary" disabled={busy || !canApprove} onClick={approve}>Approve for outreach</Btn>}
          {!["rejected", "closed", "suppressed"].includes(p.status) && <Btn kind="danger" disabled={busy} onClick={() => act(() => intelApi.reviewProspect(supabase, p.id, "reject"))}>Reject</Btn>}
        </div>
      </div>
    </Modal>
  );
}
