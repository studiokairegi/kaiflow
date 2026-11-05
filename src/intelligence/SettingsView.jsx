import React, { useEffect, useState } from "react";
import { S, T, Btn, Pill, Banner, Field, Modal, Table, useBusy } from "../finance/ui.jsx";
import { intelApi } from "./api.js";
import { AUTONOMY, KB_KINDS, MAIL_PROVIDERS, fmtWhen, mailProviderName, missingJapaneseKb, missingKb, sourceState } from "./logic.js";
import { Input, Muted, Section, Select, TextArea, useLoad, confirmAction } from "./kit.jsx";
import { emailApi } from "../email/api.js";
import { activeMailProviders } from "../email/logic.js";

const ZOHO_DCS = [["com", "zoho.com (US)"], ["eu", "zoho.eu (Europe)"], ["in", "zoho.in (India)"], ["com.au", "zoho.com.au (Australia)"], ["jp", "zoho.jp (Japan)"], ["ca", "zoho.ca (Canada)"], ["sa", "zoho.sa (Saudi Arabia)"], ["com.cn", "zoho.com.cn (China)"]];

function SafetyCard({ s, supabase, onSaved }) {
  const [f, setF] = useState(null);
  const { busy, error, run } = useBusy();
  useEffect(() => { if (s && !f) setF({ autonomy: s.autonomy, daily_initial_cap: s.daily_initial_cap, daily_followup_cap: s.daily_followup_cap, followup_business_days: s.followup_business_days, max_followups: s.max_followups, warmup_enabled: s.warmup_enabled, allow_cap_shift: s.allow_cap_shift, timezone: s.timezone, max_auto_replies_per_thread: s.max_auto_replies_per_thread, send_start_hour: s.send_start_hour, send_end_hour: s.send_end_hour, send_weekdays_only: s.send_weekdays_only }); }, [s, f]);
  if (!f) return null;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const save = () => run(async () => {
    await intelApi.updateSettings(supabase, { ...f, daily_initial_cap: Number(f.daily_initial_cap), daily_followup_cap: Number(f.daily_followup_cap), followup_business_days: Number(f.followup_business_days), max_followups: Number(f.max_followups), max_auto_replies_per_thread: Number(f.max_auto_replies_per_thread), send_start_hour: Number(f.send_start_hour), send_end_hour: Number(f.send_end_hour) });
    await onSaved();
  });
  return (
    <Section title="Autonomy and limits" hint="Introductions can never exceed 30 a day. The mail provider's own sending limits still apply and may be lower.">
      {error && <Banner tone="bad">{error}</Banner>}
      <Field label="How much the agent may do on its own" hint={AUTONOMY[f.autonomy]}><Select value={f.autonomy} onChange={set("autonomy")} options={Object.entries(AUTONOMY).map(([k, v]) => [k, v.split(":")[0]])} /></Field>
      <div style={S.grid(190)}>
        <Field label="Introductions per day (max 30)"><Input type="number" min="0" max="30" value={f.daily_initial_cap} onChange={set("daily_initial_cap")} /></Field>
        <Field label="Follow-ups per day"><Input type="number" min="0" max="100" value={f.daily_followup_cap} onChange={set("daily_followup_cap")} /></Field>
        <Field label="Follow-up after (business days)"><Input type="number" min="1" max="60" value={f.followup_business_days} onChange={set("followup_business_days")} /></Field>
        <Field label="Follow-ups per prospect (0-3)"><Input type="number" min="0" max="3" value={f.max_followups} onChange={set("max_followups")} /></Field>
        <Field label="Automatic replies per conversation"><Input type="number" min="0" max="5" value={f.max_auto_replies_per_thread} onChange={set("max_auto_replies_per_thread")} /></Field>
        <Field label="Studio time zone" hint="Defines the day for limits"><Input value={f.timezone} onChange={set("timezone")} /></Field>
        <Field label="Send from (hour, 0-23)" hint="Local studio time"><Input type="number" min="0" max="23" value={f.send_start_hour} onChange={set("send_start_hour")} /></Field>
        <Field label="Send until (hour, 1-24)" hint="Exclusive"><Input type="number" min="1" max="24" value={f.send_end_hour} onChange={set("send_end_hour")} /></Field>
      </div>
      <label style={S.row}><input type="checkbox" checked={f.send_weekdays_only} onChange={set("send_weekdays_only")} /> Send introductions and follow-ups on weekdays only</label>
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
        <Field label="Sender email (the connected mailbox address)"><Input type="email" value={f.sender_email} onChange={set("sender_email")} /></Field>
      </div>
      <Field label="Postal address"><Input value={f.physical_address} onChange={set("physical_address")} /></Field>
      <Field label="Opt-out sentence" hint="Replies containing words like unsubscribe, remove me or stop are always honored automatically."><TextArea rows={2} value={f.opt_out_text} onChange={set("opt_out_text")} /></Field>
      <div><Btn kind="primary" disabled={busy} onClick={() => run(async () => { await intelApi.updateSettings(supabase, f); await onSaved(); })}>Save</Btn></div>
    </Section>
  );
}

function AccessCard({ s, mail, supabase, onSaved }) {
  const [agent, setAgent] = useState("");
  const [provider, setProvider] = useState(mail?.provider || "gmail");
  const [dc, setDc] = useState(mail?.data_center && mail.data_center !== "google" ? mail.data_center : "com");
  const { busy, error, run } = useBusy();
  // Gmail and Zoho are PAUSED by a database flag (public.email_provider_flags); email runs through Resend. Unknown or still loading = paused.
  const flags = useLoad(() => emailApi.providerFlags(supabase).catch(() => ({})), [supabase]);
  const active = activeMailProviders(flags.data, MAIL_PROVIDERS);
  useEffect(() => { if (active.length && !active.some(([k]) => k === provider)) setProvider(active[0][0]); }, [flags.data]);   // eslint-disable-line react-hooks/exhaustive-deps
  const connect = () => run(async () => {
    const fn = provider === "gmail" ? "intel-gmail-connect" : "intel-zoho-connect";
    const { data, error: e } = await supabase.functions.invoke(fn, { body: provider === "gmail" ? {} : { data_center: dc } });
    if (e || !data?.url) throw new Error(e?.message || `Could not start the ${MAIL_PROVIDERS[provider]} connection.`);
    window.location.href = data.url;
  });
  const connected = mail?.status === "connected";
  return (
    <Section title="Connections" hint="The worker signs in as its own limited account and can only run the agent functions. It is never an administrator.">
      {error && <Banner tone="bad">{error}</Banner>}
      <div style={S.row}><b>Agent account</b>{s.agent_user_id ? <Pill tone="ok">registered</Pill> : <Pill tone="warn">not registered</Pill>}</div>
      <div style={S.row}>
        <Input style={{ maxWidth: 380 }} placeholder="Agent user id (UUID from Supabase Auth)" value={agent} onChange={(e) => setAgent(e.target.value.trim())} />
        <Btn disabled={busy || !agent} onClick={() => run(async () => { await intelApi.registerAgent(supabase, agent); setAgent(""); await onSaved(); })}>{s.agent_user_id ? "Replace agent account" : "Register agent account"}</Btn>
      </div>
      <div style={S.row}><b>Mailbox</b><Pill tone={connected ? "ok" : "warn"}>{mail?.status || "disconnected"}</Pill>{connected && <span style={{ color: T.muted }}>{mailProviderName(mail)}: {mail.mailbox}</span>}{mail?.last_sync_at && <span style={{ color: T.faint, fontSize: 12 }}>last sync {fmtWhen(mail.last_sync_at)}</span>}</div>
      {mail?.last_error && <Banner tone="bad">{mail.last_error}</Banner>}
      {active.length === 0 ? (
        <Muted>Gmail and Zoho Mail connections are paused. Email now runs through Resend: use CRM &gt; Inbox. Existing connections and history are kept.</Muted>
      ) : (
      <>
      <div style={S.row}>
        <Select value={provider} onChange={(e) => setProvider(e.target.value)} style={{ maxWidth: 200 }} options={active} />
        {provider === "zoho" && <Select value={dc} onChange={(e) => setDc(e.target.value)} style={{ maxWidth: 240 }} options={ZOHO_DCS} />}
        <Btn disabled={busy} onClick={connect}>{connected && mail.provider === provider ? `Reconnect ${MAIL_PROVIDERS[provider]}` : `Connect ${MAIL_PROVIDERS[provider]}`}</Btn>
        {connected && <Btn kind="danger" disabled={busy} onClick={() => confirmAction(`Disconnect ${mailProviderName(mail)}? Sending is switched off and the stored connection is deleted. Also remove KairFlow under connected apps / third-party access in your mail account.`) && run(async () => { await intelApi.disconnectMail(supabase); await onSaved(); })}>Disconnect</Btn>}
      </div>
      {connected && mail.provider !== provider && <Muted>Connecting {MAIL_PROVIDERS[provider]} replaces the current {mailProviderName(mail)} connection. There is one mailbox per studio.</Muted>}
      {provider === "gmail"
        ? <Muted>Use a dedicated Gmail account, not your personal one. Send and read-replies permissions are requested, nothing else. The sender email above must equal this Gmail address. Set KAIRFLOW_MAIL_PROVIDER=gmail on the worker.</Muted>
        : <Muted>Pick the data center your Zoho account lives on (the address you see when signed in to Zoho Mail). Only mail read and send permissions are requested. API access depends on your Zoho plan. Set KAIRFLOW_MAIL_PROVIDER=zoho on the worker.</Muted>}
      </>
      )}
    </Section>
  );
}

function ResendAuditCard({ supabase }) {
  const [audit, setAudit] = useState(null);
  const { busy, error, run } = useBusy();
  const verify = () => run(async () => {
    const { data, error: invokeError } = await supabase.functions.invoke("intel-resend-send", {
      body: { action: "audit_recent" },
    });
    if (invokeError) throw new Error(invokeError.message || "Could not verify Resend sends.");
    if (!data?.ok || !Array.isArray(data.results)) throw new Error(data?.error || "Resend audit returned an invalid response.");
    setAudit(data);
  });
  const rows = audit?.results || [];
  const verified = rows.filter((r) => r.verification === "verified_in_configured_resend_account").length;
  return (
    <Section title="Resend delivery verification" hint="Checks recent KairFlow sent records against the exact Resend API key configured in Supabase. Read-only: this never sends email."
      action={<Btn disabled={busy} onClick={verify}>{busy ? "Checking…" : "Verify recent sends"}</Btn>}>
      {error && <Banner tone="bad">{error}</Banner>}
      {audit && (
        <>
          <Banner tone={verified === rows.length && rows.length > 0 ? "ok" : "warn"}>
            Verified {verified} of {rows.length} recent KairFlow sent records in the configured Resend account.
            {rows.length === 0 ? " No sent records were returned." : ""}
          </Banner>
          <Table rowKey={(r) => r.message_id} rows={rows} empty="No sent records."
            columns={[
              { key: "message_id", label: "KairFlow message", render: (r) => <code>{String(r.message_id || "").slice(0, 8)}…</code> },
              { key: "provider_message_id", label: "Resend ID", render: (r) => <code>{r.provider_message_id || "—"}</code> },
              { key: "verification", label: "Result", render: (r) => {
                const ok = r.verification === "verified_in_configured_resend_account";
                const bad = r.verification === "provider_id_mismatch";
                return <Pill tone={ok ? "ok" : bad ? "bad" : "warn"}>{r.verification}</Pill>;
              } },
              { key: "resend_last_event", label: "Resend event", render: (r) => r.resend_last_event || "—" },
            ]} />
        </>
      )}
    </Section>
  );
}

function KbCard({ supabase }) {
  const kb = useLoad(() => intelApi.kb(supabase), [supabase]);
  const [edit, setEdit] = useState(null);
  const { busy, error, run } = useBusy();
  const missing = missingKb(kb.data);
  const missingJa = missingJapaneseKb(kb.data);
  const save = () => run(async () => { await intelApi.upsertKb(supabase, edit); setEdit(null); await kb.reload(); });
  return (
    <Section title="Knowledge base" hint="The only studio facts the agent may use. It never invents services, prices, availability or portfolio. Editing an entry un-approves it."
      action={<Btn small onClick={() => setEdit({ key: "", kind: "studio", title: "", body: "" })}>Add entry</Btn>}>
      {error && <Banner tone="bad">{error}</Banner>}
      {missing.length > 0 && <Banner tone="warn">The agent will not draft any email until these are written and approved: {missing.map((m) => m.label).join("; ")}.</Banner>}
      <Banner tone={missingJa.length === 0 ? "ok" : "info"}>Japanese animation-studio outreach uses separate approved Japanese entries. {missingJa.length ? `Still needed: ${missingJa.map((m) => `${m.key} (${m.label})`).join("; ")}. Add each entry below and approve it. Japanese prospects will not receive an English fallback.` : "All three Japanese entries are approved."}</Banner>
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
            <Field label="Key" hint="e.g. studio.about, services.indie_game_developer, portfolio.main, studio.about.ja"><Input value={edit.key} onChange={(e) => setEdit({ ...edit, key: e.target.value.toLowerCase() })} /></Field>
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

function SourcesCard({ supabase }) {
  const src = useLoad(() => intelApi.sources(supabase), [supabase]);
  const { busy, error, run } = useBusy();
  const upd = (key, patch) => run(async () => { await intelApi.updateSource(supabase, key, patch); await src.reload(); });
  return (
    <Section title="Discovery sources" hint="Where the agent looks. A source runs only when it is on AND you have confirmed its terms of use. A source that keeps failing pauses itself.">
      {error && <Banner tone="bad">{error}</Banner>}
      <Table rowKey={(r) => r.key} empty={src.loading ? "Loading…" : "No sources yet. Finish setup first."} rows={src.data || []}
        columns={[
          { key: "label", label: "Source", render: (r) => <span><b>{r.label}</b><div style={{ color: T.faint, fontSize: 12 }}>{r.tos_note}</div></span> },
          { key: "state", label: "State", render: (r) => { const st = sourceState(r); return <Pill tone={st.tone}>{st.label}</Pill>; } },
          { key: "budget", label: "Today", num: true, render: (r) => `${r.used_today}/${r.daily_budget}` },
          { key: "last_error", label: "Last problem", render: (r) => <span style={{ color: T.muted, fontSize: 12 }}>{r.last_error || "-"}</span> },
          { key: "act", label: "", render: (r) => (
            <span style={S.row}>
              {r.tos_status !== "confirmed" && r.tos_status !== "excluded" && <Btn small disabled={busy} onClick={() => confirmAction(`I have read the terms of use for "${r.label}" and automated, commercial use is permitted.\n\n${r.tos_note}`) && upd(r.key, { tosStatus: "confirmed", enabled: true })}>Terms confirmed, turn on</Btn>}
              {r.tos_status === "confirmed" && <Btn small kind="link" disabled={busy} onClick={() => upd(r.key, { enabled: !r.enabled })}>{r.enabled ? "Turn off" : "Turn on"}</Btn>}
              {r.tos_status !== "excluded" && <Btn small kind="link" disabled={busy} onClick={() => confirmAction("Exclude this source permanently?") && run(async () => { await intelApi.updateSource(supabase, r.key, { enabled: false }); await intelApi.updateSource(supabase, r.key, { tosStatus: "excluded" }); await src.reload(); })}>Exclude</Btn>}
            </span>) },
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
      <ResendAuditCard supabase={supabase} />
      <SourcesCard supabase={supabase} />
      <KbCard supabase={supabase} />
      <SuppressionCard supabase={supabase} />
    </div>
  );
}
