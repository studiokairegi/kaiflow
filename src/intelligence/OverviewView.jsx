import React from "react";
import { S, T, Btn, Pill, Banner, useBusy } from "../finance/ui.jsx";
import { intelApi } from "./api.js";
import { AUTONOMY, attentionItems, workerState, mailStatusLabel } from "./logic.js";
import { Kpi, Section, Muted, confirmAction } from "./kit.jsx";

export default function OverviewView({ o, mail, supabase, onChanged, setTab, onNeedsDecision }) {
  const { busy, error, run } = useBusy();
  const w = workerState(o.worker_last_seen_seconds);
  const items = attentionItems(o);
  const toggle = () => {
    const turningOn = !o.kill_switch;
    const msg = turningOn ? "Stop ALL outgoing email now? Research and CRM records are kept." : "Enable outgoing email? Messages that you approved (or the autonomy policy allows) will start sending.";
    if (!confirmAction(msg)) return;
    run(async () => { await intelApi.setKillSwitch(supabase, turningOn); await onChanged(); });
  };
  const discover = () => run(async () => {
    await intelApi.enqueue(supabase, "discover", { type: "indie_game_developer" });
    await intelApi.enqueue(supabase, "discover", { type: "animation_studio_support" });
    await onChanged();
  });
  const st = o.prospects_by_status || {};
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {error && <Banner tone="bad">{error}</Banner>}
      <Banner tone={o.kill_switch ? "warn" : "ok"} action={<Btn kind={o.kill_switch ? "primary" : "danger"} disabled={busy} onClick={toggle}>{o.kill_switch ? "Enable sending" : "Emergency stop"}</Btn>}>
        {o.kill_switch ? "Outgoing email is OFF. The agent can research and draft, but nothing is sent." : "Outgoing email is ON."}
      </Banner>
      <div style={S.row}>
        <Pill tone={w.tone}>{w.label}</Pill>
        <Pill tone={mail?.status === "connected" ? "ok" : "warn"}>{mailStatusLabel(mail)}</Pill>
        <Pill tone="info">{AUTONOMY[o.autonomy]?.split(":")[0] || o.autonomy} mode</Pill>
        {!o.agent_registered && <Pill tone="warn">Agent identity not registered</Pill>}
      </div>
      {items.map((i, n) => <Banner key={n} tone={i.tone}>{i.text}</Banner>)}
      <div style={S.grid(190)}>
        <Kpi label="Introductions today" value={`${o.initial_sent_today} / ${o.initial_cap}`} sub={o.initial_cap < o.initial_cap_configured ? `warm-up limit (setting: ${o.initial_cap_configured})` : "daily limit"} />
        <Kpi label="Follow-ups today" value={`${o.followup_sent_today} / ${o.followup_cap}`} />
        <Kpi label="Waiting for approval" value={o.pending_approval} tone={o.pending_approval ? "warn" : "ok"} onClick={() => setTab("outreach")} />
        <Kpi label="Qualified, not yet leads" value={st.qualified || 0} onClick={() => setTab("qualified")} />
        <Kpi label="Need a decision" value={st.needs_review || 0} tone={st.needs_review ? "warn" : "ok"} onClick={onNeedsDecision} />
        <Kpi label="Replies" value={st.replied || 0} onClick={() => setTab("outreach")} />
      </div>
      <div style={S.grid(300)}>
        <Section title="By campaign" hint="Prospects discovered so far.">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={S.row}><b>Indie Game Developers</b><span style={{ color: T.muted }}>{o.prospects_by_type?.indie_game_developer || 0}</span><Btn small kind="link" onClick={() => setTab("indie")}>Open</Btn></div>
            <div style={S.row}><b>Animation Studio Support</b><span style={{ color: T.muted }}>{o.prospects_by_type?.animation_studio_support || 0}</span><Btn small kind="link" onClick={() => setTab("studio")}>Open</Btn></div>
          </div>
        </Section>
        <Section title="Run now" hint="Queues a discovery run for each active campaign. The worker picks it up.">
          <Btn disabled={busy} onClick={discover}>Run discovery</Btn>
          <Muted>Queued and running jobs: {o.queued_jobs}</Muted>
        </Section>
      </div>
    </div>
  );
}
