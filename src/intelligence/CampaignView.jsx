import React, { useEffect, useState } from "react";
import { S, Btn, Pill, Banner, Field, Table, useBusy } from "../finance/ui.jsx";
import { intelApi } from "./api.js";
import { PROSPECT_TYPES, criteriaPatch, joinLines, statusInfo } from "./logic.js";
import { Input, Section, TextArea, useLoad, Muted } from "./kit.jsx";
import ProspectModal from "./ProspectModal.jsx";
import { DiscoveryProfile, DiscoveryStats, ManualPost, ManualKickstarterProject } from "./DiscoveryPanels.jsx";
import ReevaluationPanel from "./ReevaluationPanel.jsx";

const HELP = {
  indie_game_developer: "Evaluates identifiable game projects, verified anime-compatible visual assets or explicit official style descriptions, dated development or marketing opportunities, and eligible developer contact details. Small and first-time teams are welcome; publishers do not disqualify a project.",
  animation_studio_support: "Looks at studio sites you list below for recruitment or outsourcing of layout, key animation, in-betweens or coloring. There is no free web-search source, so you give the agent the studio pages to watch.",
};

export default function CampaignView({ type, supabase, tick, onChanged, onOpenLead }) {
  const camps = useLoad(() => intelApi.campaigns(supabase), [supabase, tick]);
  const pros = useLoad(() => intelApi.prospects(supabase), [supabase, tick]);
  const { busy, error, run } = useBusy();
  const c = (camps.data || []).find((x) => x.type === type);
  const [f, setF] = useState(null);
  const [open, setOpen] = useState(null);
  useEffect(() => {
    if (c && !f) setF({ keywords: joinLines(c.criteria?.keywords), seedUrls: joinLines(c.criteria?.seed_urls), qualifyMin: type === "animation_studio_support" ? 70 : type === "indie_game_developer" ? 75 : c.criteria?.qualify_min ?? 70, reviewMin: type === "animation_studio_support" ? 50 : type === "indie_game_developer" ? 55 : c.criteria?.review_min ?? 50, dailyCap: c.daily_cap });
  }, [c, f]);
  if (camps.loading || !c || !f) return <Muted>{camps.error || "Loading…"}</Muted>;
  const mine = (pros.data || []).filter((p) => p.type === type);
  const save = () => run(async () => {
    await intelApi.updateCampaign(supabase, type, { daily_cap: Number(f.dailyCap), criteria: criteriaPatch({ ...f, prospectType: type }) });
    await camps.reload();
  });
  const setStatus = (status) => run(async () => { await intelApi.updateCampaign(supabase, type, { status }); await camps.reload(); await onChanged(); });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {error && <Banner tone="bad">{error}</Banner>}
      <Section title={PROSPECT_TYPES[type]} hint={HELP[type]}
        action={<div style={S.row}><Pill tone={c.status === "active" ? "ok" : "muted"}>{c.status === "active" ? "Active" : "Paused"}</Pill>
          <Btn small disabled={busy} onClick={() => setStatus(c.status === "active" ? "paused" : "active")}>{c.status === "active" ? "Pause" : "Activate"}</Btn>
          <Btn small disabled={busy} onClick={() => run(async () => { await intelApi.enqueue(supabase, "discover", { type }); await onChanged(); })}>Run discovery now</Btn></div>}>
        <div style={S.grid(200)}>
          <Field label="Daily introductions (this campaign)"><Input type="number" min="0" max="30" value={f.dailyCap} onChange={(e) => setF({ ...f, dailyCap: e.target.value })} /></Field>
          {type === "indie_game_developer" ? <Field label="Project qualification thresholds" hint="Fixed V2 policy; mandatory evidence and contact gates override the score.">
            <div style={{ fontSize: 13, lineHeight: 1.6 }}>75–100: Qualified only when every mandatory gate passes<br />55–74: Needs Review<br />Below 55: Low priority / Rejected<br />Anime-compatible visual evidence, a genuine active project/opportunity, a verified eligible email and clear suppression status are mandatory.</div>
          </Field> : <Field label="Studio qualification thresholds" hint="Fixed Phase 1 studio-v2 policy; campaign settings cannot override these bands.">
            <div style={{ fontSize: 13, lineHeight: 1.6 }}>70–100: Qualified when evidence criteria are confirmed<br />50–69: Needs Review<br />Below 50: Rejected<br />Any uncertainty in pipeline fit, 2D relevance or external collaboration requires review.</div>
          </Field>}
        </div>
        <Field label="Keywords (one per line)" hint="Search terms and store tags the agent prioritizes."><TextArea value={f.keywords} onChange={(e) => setF({ ...f, keywords: e.target.value })} /></Field>
        {type === "animation_studio_support" && <Field label="Studio pages to watch (one URL per line)" hint="Recruitment, careers or outsourcing pages of studios you want to approach. Robots rules are respected."><TextArea value={f.seedUrls} onChange={(e) => setF({ ...f, seedUrls: e.target.value })} placeholder="https://example-studio.jp/recruit" /></Field>}
        <div><Btn kind="primary" disabled={busy} onClick={save}>Save campaign</Btn></div>
      </Section>
      {type === "animation_studio_support" && <DiscoveryStats supabase={supabase} tick={tick} />}
      {type === "animation_studio_support" && <ReevaluationPanel supabase={supabase} tick={tick} />}
      {type === "animation_studio_support" && <DiscoveryProfile campaign={c} supabase={supabase} onChanged={async () => { await camps.reload(); await onChanged(); }} />}
      {type === "animation_studio_support" && <ManualPost type={type} supabase={supabase} onChanged={onChanged} />}
      {type === "indie_game_developer" && <ManualKickstarterProject supabase={supabase} onChanged={onChanged} />}
      <Section title="Prospects" hint="Click a row for evidence and the score breakdown.">
        <Table rowKey={(r) => r.id} onRow={setOpen} empty={pros.loading ? "Loading…" : "Nothing discovered yet. Run discovery."} rows={mine}
          columns={[
            { key: "name", label: "Name", render: (r) => <b>{r.name}</b> },
            { key: "status", label: "Status", render: (r) => <Pill tone={statusInfo(r.status).tone}>{statusInfo(r.status).label}</Pill> },
            { key: "score", label: "Score", num: true, render: (r) => r.score ?? "-" },
            { key: "contact_email", label: "Contact", render: (r) => r.contact_email || <span style={{ opacity: 0.6 }}>none verified</span> },
          ]} />
      </Section>
      {open && <ProspectModal prospect={open} supabase={supabase} onClose={() => setOpen(null)} onChanged={async () => { await pros.reload(); await onChanged(); }} onOpenLead={onOpenLead} />}
    </div>
  );
}
