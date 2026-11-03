import React, { useEffect, useState } from "react";
import { S, Btn, Pill, Banner, Field, Table, useBusy } from "../finance/ui.jsx";
import { intelApi } from "./api.js";
import { PROSPECT_TYPES, criteriaPatch, joinLines, statusInfo } from "./logic.js";
import { Input, Section, TextArea, useLoad, Muted } from "./kit.jsx";
import ProspectModal from "./ProspectModal.jsx";

const HELP = {
  indie_game_developer: "Looks at Steam and itch.io pages and the developer's own site for 2D, anime-inspired, stylized or narrative games with an upcoming release, a campaign, or a stated need for animation.",
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
    if (c && !f) setF({ keywords: joinLines(c.criteria?.keywords), seedUrls: joinLines(c.criteria?.seed_urls), qualifyMin: c.criteria?.qualify_min ?? 70, reviewMin: c.criteria?.review_min ?? 50, dailyCap: c.daily_cap });
  }, [c, f]);
  if (camps.loading || !c || !f) return <Muted>{camps.error || "Loading…"}</Muted>;
  const mine = (pros.data || []).filter((p) => p.type === type);
  const save = () => run(async () => {
    await intelApi.updateCampaign(supabase, type, { daily_cap: Number(f.dailyCap), criteria: criteriaPatch(f) });
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
          <Field label="Score to qualify" hint="0-100"><Input type="number" min="0" max="100" value={f.qualifyMin} onChange={(e) => setF({ ...f, qualifyMin: e.target.value })} /></Field>
          <Field label="Score to flag for review"><Input type="number" min="0" max="100" value={f.reviewMin} onChange={(e) => setF({ ...f, reviewMin: e.target.value })} /></Field>
        </div>
        <Field label="Keywords (one per line)" hint="Search terms and store tags the agent prioritizes."><TextArea value={f.keywords} onChange={(e) => setF({ ...f, keywords: e.target.value })} /></Field>
        {type === "animation_studio_support" && <Field label="Studio pages to watch (one URL per line)" hint="Recruitment, careers or outsourcing pages of studios you want to approach. Robots rules are respected."><TextArea value={f.seedUrls} onChange={(e) => setF({ ...f, seedUrls: e.target.value })} placeholder="https://example-studio.jp/recruit" /></Field>}
        <div><Btn kind="primary" disabled={busy} onClick={save}>Save campaign</Btn></div>
      </Section>
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
