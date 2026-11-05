// KairFlow Intelligence. The whole module renders only for a user the DATABASE has authorized (administrator AND
// active Master User); this component re-checks it, so no Intelligence screen can mount without it. Every read is
// also row-level-security protected and every write goes through a function that re-checks authorization.
import React, { useEffect, useState } from "react";
import { S, T, Banner, Btn, Field, Tabs, useBusy } from "../finance/ui.jsx";
import { canAccessIntelligence } from "./access.js";
import { intelApi } from "./api.js";
import { Input, Muted, Section, Select, useLoad } from "./kit.jsx";
import OverviewView from "./OverviewView.jsx";
import CampaignView from "./CampaignView.jsx";
import ProspectsView from "./ProspectsView.jsx";
import OutreachView from "./OutreachView.jsx";
import LogsView from "./LogsView.jsx";
import SettingsView from "./SettingsView.jsx";
import { oauthResult } from "./logic.js";
import ChatView from "./ChatView.jsx";
import CrmFollowupView from "./CrmFollowupView.jsx";

export const INTELLIGENCE_SECTIONS = Object.freeze([
  "Overview", "Agent Chat", "Existing Leads", "Indie Game Developers", "Animation Studio Support", "Discovered Prospects",
  "Qualified Leads", "Outreach and Conversations", "Agent Activity Logs", "Settings",
]);

function Setup({ supabase, onDone }) {
  const [f, setF] = useState({ senderName: "", senderEmail: "", physicalAddress: "", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" });
  const { busy, error, run } = useBusy();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Section title="Set up KairFlow Intelligence" hint="Sending stays OFF and every email needs your approval until you change that. This only stores your sender details and creates the two campaigns.">
      {error && <Banner tone="bad">{error}</Banner>}
      <div style={S.grid(240)}>
        <Field label="Sender name"><Input value={f.senderName} onChange={set("senderName")} /></Field>
        <Field label="Sender email (the connected mailbox address)"><Input type="email" value={f.senderEmail} onChange={set("senderEmail")} /></Field>
      </div>
      <Field label="Postal address (shown in every email)"><Input value={f.physicalAddress} onChange={set("physicalAddress")} /></Field>
      <Field label="Studio time zone"><Input value={f.timezone} onChange={set("timezone")} /></Field>
      <div><Btn kind="primary" disabled={busy} onClick={() => run(async () => { await intelApi.bootstrap(supabase, f); await onDone(); })}>Create</Btn></div>
    </Section>
  );
}

function Shell({ supabase, target, onOpenLead }) {
  const [tab, setTab] = useState("overview");
  const [tick, setTick] = useState(0);
  const [focus, setFocus] = useState(null);
  const [prospectStatusFocus, setProspectStatusFocus] = useState("");
  const [flash, setFlash] = useState(null);   // result of a Gmail/Zoho connection attempt (?intelligence=<flag>)
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      const result = oauthResult(url.searchParams.get("intelligence"));
      if (result) { setFlash(result); setTab("settings"); }
      if (url.searchParams.has("intelligence")) { url.searchParams.delete("intelligence"); window.history.replaceState({}, "", url.toString()); }
    } catch { /* no window (tests/SSR): nothing to read */ }
  }, []);
  useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState === "visible") setTick((t) => t + 1); }, 30000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => { if (target) { setFocus(target); setTab("outreach"); } }, [target?.nonce]);
  const ov = useLoad(() => intelApi.overview(supabase), [supabase, tick]);
  const mail = useLoad(() => intelApi.mailStatus(supabase), [supabase, tick]);
  const refresh = async () => { await ov.reload(); await mail.reload(); setTick((t) => t + 1); };

  if (ov.loading) return <Muted>Loading…</Muted>;
  if (ov.error && !ov.data) return <Banner tone="bad">{ov.error}</Banner>;
  const o = ov.data || {};
  if (!o.configured) return <div style={S.page}><h2 style={S.h2}>KairFlow Intelligence</h2><Setup supabase={supabase} onDone={refresh} /></div>;

  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "chat", label: "Agent Chat" },
    { id: "crm", label: "Existing Leads" },
    { id: "indie", label: "Indie Game Developers" },
    { id: "studio", label: "Animation Studio Support" },
    { id: "prospects", label: "Discovered Prospects" },
    { id: "qualified", label: "Qualified Leads" },
    { id: "outreach", label: "Outreach and Conversations", badge: o.pending_approval || undefined },
    { id: "logs", label: "Agent Activity Logs" },
    { id: "settings", label: "Settings" },
  ];
  const common = { supabase, tick, onChanged: refresh, onOpenLead };
  return (
    <div style={S.page}>
      <div style={{ ...S.row, justifyContent: "space-between" }}>
        <div><h2 style={S.h2}>Intelligence</h2><p style={S.sub}>Finds, researches and contacts prospects for the studio. Private to you.</p></div>
      </div>
      {flash && <Banner tone={flash.tone} action={<Btn small onClick={() => setFlash(null)}>Dismiss</Btn>}>{flash.text}</Banner>}
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === "overview" && <OverviewView o={o} mail={mail.data} supabase={supabase} onChanged={refresh} setTab={setTab} onNeedsDecision={() => { setProspectStatusFocus("needs_review"); setTab("prospects"); }} />}
      {tab === "chat" && <ChatView supabase={supabase} tick={tick} workerSeconds={o.worker_last_seen_seconds} onChanged={refresh} />}
      {tab === "crm" && <CrmFollowupView {...common} />}
      {tab === "indie" && <CampaignView type="indie_game_developer" {...common} />}
      {tab === "studio" && <CampaignView type="animation_studio_support" {...common} />}
      {tab === "prospects" && <ProspectsView mode="all" initialStatus={prospectStatusFocus} {...common} />}
      {tab === "qualified" && <ProspectsView mode="qualified" {...common} />}
      {tab === "outreach" && <OutreachView {...common} focus={focus} />}
      {tab === "logs" && <LogsView supabase={supabase} tick={tick} />}
      {tab === "settings" && <SettingsView supabase={supabase} tick={tick} mail={mail.data} onChanged={refresh} />}
    </div>
  );
}

export default function IntelligenceModule({ access, supabase, target, onOpenLead }) {
  if (!canAccessIntelligence(access) || !supabase) return null;
  return <Shell supabase={supabase} target={target} onOpenLead={onOpenLead} />;
}
