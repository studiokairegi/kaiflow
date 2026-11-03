import React, { useEffect, useState } from "react";
import { S, T, Btn, Pill, Banner, Field, Modal, Table, useBusy } from "../finance/ui.jsx";
import { intelApi } from "./api.js";
import { AUTONOMY, KB_KINDS, fmtWhen, missingKb } from "./logic.js";
import { Input, Muted, Section, Select, TextArea, useLoad, confirmAction } from "./kit.jsx";

const ZOHO_DCS = [["com", "zoho.com (US)"], ["eu", "zoho.eu (Europe)"], ["in", "zoho.in (India)"], ["com.au", "zoho.com.au (Australia)"], ["jp", "zoho.jp (Japan)"], ["ca", "zoho.ca (Canada)"], ["sa", "zoho.sa (Saudi Arabia)"], ["com.cn", "zoho.com.cn (China)"]];

function SafetyCard({ s, supabase, onSaved }) {
  const [f, setF] = useState(null);
  const { busy, error, run } = useBusy();
  useEffect(() => { if (s && !f) setF({ autonomy: s.autonomy, daily_initial_cap: s.daily_initial_cap, daily_followup_cap: s.daily_followup_cap, followup_business_days: s.followup_business_days, max_followups: s.max_followups, warmup_enabled: s.warmup_enabled, allow_cap_shift: s.allow_cap_shift, timezone: s.timezone, max_auto_replies_per_thread: s.max_auto_replies_per_thread }); }, [s, f]);
  if (!f) return null;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const save = () => run(async () => {
    await intelApi.updateSettings(supabase, { ...f, daily_initial_cap: Number(f.daily_initial_cap), daily_followup_cap: Number(f.daily_followup_cap), followup_business_days: Number(f.followup_business_days), max_followups: Number(f.max_followups), max_auto_replies_per_thread: Number(f.max_auto_replies_per_thread) });
    await onSaved();
  });
  return (
    <Section title="Autonomy and limits" hint="Introductions can never exceed 30 a day. Zoho's own sending limits still apply and may be lower.">
      {error && <Banner tone="bad">{error}</Banner>}
      <Field label="How much the agent may do on its own" hint={AUTONOMY[f.autonomy]}><Select value={f.autonomy} onChange={set("autonomy")} options={Object.entries(AUTONOMY).map(([k, v]) => [k, v.split(":")[0]])} /></Field>
      <div style={S.grid(190)}>
        <Field label="Introductions per day (max 30)"><Input type="number" min="0" max="30" value={f.daily_initial_cap} onChange={set("daily_initial_cap")} /></Field>
        <Field label="Follow-ups per day"><Input type="number" min="0" max="100" value={f.daily_followup_cap} onChange={set("daily_followup_cap")} /></Field>
        <Field label="Follow-up after (business days)"><Input type="number" min="1" max="60" value={f.followup_business_days} onChange={set("followup_business_days")} /></Field>
        <Field label="Follow-ups per prospect (0-3)"><Input type="number" min="0" max="3" value={f.max_followups} onChange={set("max_followups")} /></Field>
        <Field label="Automatic replies per conversation"><Input type="number" min="0" max="5" value={f.max_auto_replies_per_thread} onChange={set("max_auto_replies_per_thread")} /></Field>
        <Field label="Studio time zone" hint="Defines the day for limits"><Input value={f.timezone} onChange={set("timezone")} /></Field>
      </div>
      <label style={S.row}><input type="checkbox" checked={f.warmup_enabled} onChange={set("warmup_enabled")} /> Warm up gradually (5 a day, rising by 5 each week, up to your limit). Recommended for a mailbox that has not sent cold email before.</label>
      <label style={S.row}><input type="checkbox" checked={f.allow_cap_shift} onChange={set("allow_cap_shift")} /> Let one campaign use the other's unused share of the daily limit</label>
      <div><Btn kind="primary" disabled={busy} onClick={save}>Save</Btn></div>
    </Section>
  );
}

function SenderCard({ s, supabase, onSaved }) {
  const [f, setF] = useState(null);
  const { busy, error, run } = useBusy();
  useEffect(() => { if (s && !f) setF({ sender_name: s.sender_name, sender_email: s.sender_email, physical_address: s.physical_address, opt_out_text: s.opt_out_text }); }, [s, f]);
  if (!f) return null;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Section title="Sender identity and opt-out" hint="Added to every introduction and follow-up. Sending is refused if any of this is missing.">
      {error && <Banner tone="bad">{error}</Banner>}
      <div style={S.grid(240)}>
        <Field label="Sender name"><Input value={f.sender_name} onChange={set("sender_name")} /></Field>
        <Field label="Sender email (your Zoho address)"><Input type="email" value={f.sender_email} onChange={set("sender_email")} /></Field>
      </div>
      <Field label="Postal address"><Input value={f.physical_address} onChange={set("physical_address")} /></Field>
      <Field label="Opt-out sentence" hint="Replies containing words like unsubscribe, remove me or stop are always honored automatically."><TextArea rows={2} value={f.opt_out_text} onChange={set("opt_out_text")} /></Field>
      <div><Btn kind="primary" disabled={busy} onClick={() => run(async () => { await intelApi.updateSettings(supabase, f); await onSaved(); })}>Save</Btn></div>
    </Section>
  );
}

function AccessCard({ s, mail, supabase, onSaved }) {
  const [agent, setAgent] = useState("");
  const [dc, setDc] = useState(mail?.data_center || "com");
  const { busy, error, run } = useBusy();
  const connect = () => run(async () => {
    const { data, error: e } = await supabase.functions.invoke("intel-zoho-connect", { body: { data_center: dc } });
    if (e || !data?.url) throw new Error(e?.message || "Could not start the Zoho connection.");
    window.location.href = data.url;
  });
  return (
    <Section title="Connections" hint="The worker signs in as its own limited account and can only run the agent functions. It is never an administrator.">
      {error && <Banner tone="bad">{error}</Banner>}
      <div style={S.row}><b>Agent account</b>{s.agent_user_id ? <Pill tone="ok">registered</Pill> : <Pill tone="warn">not registered</Pill>}</div>
      <div style={S.row}>
        <Input style={{ maxWidth: 380 }} placeholder="Agent user id (UUID from Supabase Auth)" value={agent} onChange={(e) => setAgent(e.target.value.trim())} />
        <Btn disabled={busy || !agent} onClick={() => run(async () => { await intelApi.registerAgent(supabase, agent); setAgent(""); await onSaved(); })}>{s.agent_user_id ? "Replace agent account" : "Register agent account"}</Btn>
      </div>
      <div style={S.row}><b>Zoho Mail</b><Pill tone={mail?.status === "connected" ? "ok" : "warn"}>{mail?.status || "disconnected"}</Pill>{mail?.mailbox && <span style={{ color: T.muted }}>{mail.mailbox}</span>}{mail?.last_sync_at && <span style={{ color: T.faint, fontSize: 12 }}>last sync {fmtWhen(mail.last_sync_at)}</span>}</div>
      {mail?.last_error && <Banner tone="bad">{mail.last_error}</Banner>}
      <div style={S.row}>
        <Select value={dc} onChange={(e) => setDc(e.target.value)} style={{ maxWidth: 240 }} options={ZOHO_DCS} />
        <Btn disabled={busy} onClick={connect}>{mail?.status === "connected" ? "Reconnect Zoho Mail" : "Connect Zoho Mail"}</Btn>
      </div>
      <Muted>Pick the data center your Zoho account lives on (the address you see when signed in to Zoho Mail). Only mail read and send permissions are requested. API access depends on your Zoho plan.</Muted>
    </Section>
  );
}

function KbCard({ supabase }) {
  const kb = useLoad(() => intelApi.kb(supabase), [supabase]);
  const [edit, setEdit] = useState(null);
  const { busy, error, run } = useBusy();
  const missing = missingKb(kb.data);
  const save = () => run(async () => { await intelApi.upsertKb(supabase, edit); setEdit(null); await kb.reload(); });
  return (
    <Section title="Knowledge base" hint="The only studio facts the agent may use. It never invents services, prices, availability or portfolio. Editing an entry un-approves it."
      action={<Btn small onClick={() => setEdit({ key: "", kind: "studio", title: "", body: "" })}>Add entry</Btn>}>
      {error && <Banner tone="bad">{error}</Banner>}
      {missing.length > 0 && <Banner tone="warn">The agent will not draft any email until these are written and approved: {missing.map((m) => m.label).join("; ")}.</Banner>}
      <Table rowKey={(r) => r.key} empty={kb.loading ? "Loading…" : "No entries yet."} rows={kb.data || []}
        columns={[
          { key: "key", label: "Key", render: (r) => <code>{r.key}</code> },
          { key: "kind", label: "Kind" },
          { key: "approved", label: "", render: (r) => <Pill tone={r.approved ? "ok" : "warn"}>{r.approved ? "approved" : "not approved"}</Pill> },
          { key: "body", label: "Text", render: (r) => <span style={{ color: T.muted }}>{(r.body || "").slice(0, 90)}</span> },
          { key: "act", label: "", render: (r) => <span style={S.row}>
              <Btn small kind="link" onClick={() => setEdit({ key: r.key, kind: r.kind, title: r.title, body: r.body })}>Edit</Btn>
              <Btn small kind="link" disabled={busy} onClick={() => run(async () => { await intelApi.approveKb(supabase, r.key, !r.approved); await kb.reload(); })}>{r.approved ? "Unapprove" : "Approve"}</Btn></span> },
        ]} />
      {edit && (
        <Modal title="Knowledge base entry" onClose={() => setEdit(null)} width={640} footer={<Btn kind="primary" disabled={busy || !edit.key || !edit.body.trim()} onClick={save}>Save (needs re-approval)</Btn>}>
          <div style={S.grid(220)}>
            <Field label="Key" hint="e.g. studio.about, services.indie_game_developer, portfolio.main"><Input value={edit.key} onChange={(e) => setEdit({ ...edit, key: e.target.value.toLowerCase() })} /></Field>
            <Field label="Kind"><Select value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })} options={KB_KINDS.map((k) => [k, k])} /></Field>
          </div>
          <Field label="Title"><Input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></Field>
          <Field label="Text the agent may use word for word"><TextArea rows={8} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></Field>
        </Modal>
      )}
    </Section>
  );
}

function SuppressionCard({ supabase }) {
  const sup = useLoad(() => intelApi.suppressions(supabase), [supabase]);
  const [v, setV] = useState("");
  const { busy, error, run } = useBusy();
  return (
    <Section title="Do-not-contact list" hint="Email addresses or whole domains the agent must never write to. Unsubscribes, declines and permanent bounces are added automatically.">
      {error && <Banner tone="bad">{error}</Banner>}
      <div style={S.row}>
        <Input style={{ maxWidth: 340 }} placeholder="name@example.com or example.com" value={v} onChange={(e) => setV(e.target.value)} />
        <Btn disabled={busy || !v.trim()} onClick={() => run(async () => { await intelApi.addSuppression(supabase, v, "added by admin"); setV(""); await sup.reload(); })}>Add</Btn>
      </div>
      <Table rowKey={(r) => r.id} empty={sup.loading ? "Loading…" : "Nobody is suppressed yet."} rows={sup.data || []}
        columns={[
          { key: "value", label: "Address / domain" }, { key: "kind", label: "Type" }, { key: "reason", label: "Reason" },
          { key: "created_at", label: "Added", render: (r) => fmtWhen(r.created_at) },
          { key: "x", label: "", render: (r) => r.source === "admin" ? <Btn small kind="link" onClick={() => confirmAction("Allow contacting this again?") && run(async () => { await intelApi.removeSuppression(supabase, r.id); await sup.reload(); })}>Remove</Btn> : <span style={{ color: T.faint, fontSize: 12 }}>automatic</span> },
        ]} />
    </Section>
  );
}

export default function SettingsView({ supabase, tick, mail, onChanged }) {
  const st = useLoad(() => intelApi.settings(supabase), [supabase, tick]);
  if (st.loading) return <Muted>Loading…</Muted>;
  if (!st.data) return <Banner tone="warn">Run setup first.</Banner>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {st.error && <Banner tone="bad">{st.error}</Banner>}
      <SafetyCard s={st.data} supabase={supabase} onSaved={async () => { await st.reload(); await onChanged(); }} />
      <SenderCard s={st.data} supabase={supabase} onSaved={async () => { await st.reload(); await onChanged(); }} />
      <AccessCard s={st.data} mail={mail} supabase={supabase} onSaved={async () => { await st.reload(); await onChanged(); }} />
      <KbCard supabase={supabase} />
      <SuppressionCard supabase={supabase} />
    </div>
  );
}
