import React, { useEffect, useState } from "react";
import { S, T, Btn, Pill, Banner, Field, Modal, Table, useBusy } from "../finance/ui.jsx";
import { intelApi } from "./api.js";
import { AUTONOMY, KB_KINDS, fmtWhen, missingJapaneseKb, missingKb, sourceState } from "./logic.js";
import { Input, Muted, Section, Select, TextArea, useLoad, confirmAction } from "./kit.jsx";

const WORKER_CONTROL_URL = "http://127.0.0.1:17843";
const CONTROLLER_TOKEN_STORAGE_KEY = "kairflow.intelligence.controller-token.v1";

function WorkerControlCard() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [checkedAt, setCheckedAt] = useState(null);
  // Pair this browser once. The token remains on this device/browser profile;
  // it is never sent to Supabase or included in application API requests.
  const [controllerToken, setControllerToken] = useState(() => {
    try { return window.localStorage.getItem(CONTROLLER_TOKEN_STORAGE_KEY) || ""; }
    catch { return ""; }
  });

  useEffect(() => {
    try {
      if (controllerToken.trim()) window.localStorage.setItem(CONTROLLER_TOKEN_STORAGE_KEY, controllerToken.trim());
      else window.localStorage.removeItem(CONTROLLER_TOKEN_STORAGE_KEY);
    } catch { /* Browser storage may be disabled; manual pairing remains available. */ }
  }, [controllerToken]);

  const request = async (path, method = "GET") => {
    const token = controllerToken.trim();
    if (!token) throw new Error("Enter the local controller token from %LOCALAPPDATA%\\KairFlowIntelligence\\controller.token.");
    const response = await fetch(`${WORKER_CONTROL_URL}${path}`, {
      method, mode: "cors", credentials: "omit", cache: "no-store",
      headers: { Authorization: `Bearer ${token}`, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
      ...(method === "POST" ? { body: "{}" } : {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || `Local controller returned ${response.status}.`);
    return data;
  };

  const refresh = async (preserveError = false) => {
    try {
      const data = await request("/api/status");
      setStatus(data); if (!preserveError) setError(""); setCheckedAt(new Date());
    } catch (e) {
      setStatus(null); setError(e?.message || "Local controller is not reachable.");
    }
  };

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [controllerToken]);

  const act = async (action) => {
    if (action === "start" && !confirmAction("Start Emma on this computer? The worker will resume its configured queue. If email sending is enabled and the emergency stop is OFF, approved messages may be sent under your existing limits.")) return;
    setBusy(true); setError("");
    try {
      const data = await request(`/api/${action}`, "POST");
      setStatus(data); setCheckedAt(new Date());
    } catch (e) {
      setError(e?.message || `Could not ${action} Emma.`);
    } finally {
      setBusy(false); refresh(true);
    }
  };

  const online = Boolean(status);
  const running = Boolean(status?.worker_running);
  return (
    <Section title="Emma" hint="Emma and the local controller load automatically when you sign in to Windows. Pair this browser once; after that KairFlow reconnects automatically.">
      <div style={{ ...S.row, justifyContent: "space-between", flexWrap: "wrap" }}>
        <div style={S.row}>
          <Pill tone={!online ? "warn" : running ? "ok" : "muted"}>{!online ? "Emma status unavailable" : running ? "Emma is online" : "Emma is offline"}</Pill>
          {running && status?.worker_pid && <span style={{ color: T.muted, fontSize: 12 }}>PID {status.worker_pid}</span>}
          {checkedAt && <span style={{ color: T.faint, fontSize: 12 }}>Checked {checkedAt.toLocaleTimeString()}</span>}
        </div>
        <div style={S.row}>
          {running
            ? <Btn disabled={busy || !online} onClick={() => act("stop")}>{busy ? "Working…" : "Stop Emma"}</Btn>
            : <Btn kind="primary" disabled={busy || !online} onClick={() => act("start")}>{busy ? "Working…" : "Start Emma"}</Btn>}
          <Btn kind="link" disabled={busy} onClick={refresh}>Refresh</Btn>
        </div>
      </div>
      {!online && <Banner tone="warn">{controllerToken ? "The saved local pairing could not reach the controller. Check that the controller is installed and running, then refresh." : "Pair this computer once: enter the contents of %LOCALAPPDATA%\\KairFlowIntelligence\\controller.token below. If the controller is not installed yet, run intelligence-worker\\windows\\install-controller.ps1 once."} If Chrome asks to allow local network access, allow it for KairFlow.</Banner>}
      {!controllerToken && <Field label="Pair this computer (one time)" hint="Paste the local controller token once. KairFlow remembers it in this browser on this computer; it is not uploaded to your account or Supabase."><Input type="password" value={controllerToken} onChange={(e) => setControllerToken(e.target.value)} placeholder="Paste controller.token contents once" /></Field>}
      {controllerToken && <div style={S.row}><Pill tone="ok">This browser is paired</Pill><Btn kind="link" onClick={() => setControllerToken("")}>Forget this computer</Btn></div>}
      {error && <Banner tone="bad">{error}</Banner>}
      {status?.last_error && <Banner tone="bad">Worker restart problem: {status.last_error}</Banner>}
      {online && !running && status?.last_exit_code !== null && status?.last_exit_code !== undefined && <Banner tone="warn">The worker exited with code {status.last_exit_code}. Check `%LOCALAPPDATA%\KairFlowIntelligence\worker.log` for details.</Banner>}
      {online && !running && <p style={S.sub}>Emma is stopped. Starting her resumes queued discovery, research and drafting work. Email sending remains governed by the existing approval, autonomy, daily-limit and emergency-stop settings.</p>}
      {running && <p style={S.sub}>Emma is running locally. Closing this browser tab will not stop the worker.</p>}
    </Section>
  );
}

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

function ProviderAccountsCard({ supabase, tick, onSaved }) {
  const catalog = useLoad(() => intelApi.providerCatalog(supabase), [supabase, tick]);
  const accounts = useLoad(() => intelApi.providerAccounts(supabase), [supabase, tick]);
  const [provider, setProvider] = useState("gmail");
  const [zohoDc, setZohoDc] = useState("com");
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [consentEmail, setConsentEmail] = useState("");
  const [consentEvidence, setConsentEvidence] = useState("");
  const [consentPurpose, setConsentPurpose] = useState("consented_prospecting");
  const [smtp, setSmtp] = useState({ mailbox: "", host: "", port: "587", username: "", password: "", tls_mode: "starttls" });
  const run = async (id, fn) => { setBusyId(id); setError(""); try { await fn(); await accounts.reload(); await onSaved?.(); } catch (e) { setError(e?.message || "Provider account operation failed."); } finally { setBusyId(""); } };
  const connect = async () => {
    setWorking(true); setError("");
    try {
      if (provider === "smtp") {
        const { data, error: invokeError } = await supabase.functions.invoke("intel-provider-smtp-connect", { body: { ...smtp, port: Number(smtp.port) } });
        if (invokeError || !data?.ok) throw new Error(invokeError?.message || data?.error || "Could not save SMTP account.");
        await accounts.reload(); await onSaved?.();
        setSmtp({ mailbox: "", host: "", port: "587", username: "", password: "", tls_mode: "starttls" });
      } else {
        const { data, error: invokeError } = await supabase.functions.invoke("intel-provider-connect", { body: { provider_key: provider, ...(provider === "zoho" ? { data_center: zohoDc } : {}) } });
        if (invokeError || !data?.url) throw new Error(invokeError?.message || data?.error || "Could not start provider authorization.");
        window.location.href = data.url;
      }
    } catch (e) { setError(e?.message || "Could not connect account."); setWorking(false); }
  };
  const rows = accounts.data || [];
  return <Section title="Email provider accounts" hint="Connect multiple mailboxes independently. New connections are disabled for sending until policy, approval and quota controls are configured. Resend is intentionally not available for prospect communication.">
    {error && <Banner tone="bad">{error}</Banner>}
    <div style={S.row}>
      <Select value={provider} onChange={(e) => setProvider(e.target.value)} style={{ maxWidth: 220 }} options={(catalog.data || []).filter((p) => p.enabled && p.manifest?.supports_multiple_accounts === true && ["gmail", "zoho", "smtp"].includes(p.provider_key)).map((p) => [p.provider_key, p.display_name])} />
      {provider === "zoho" && <Select value={zohoDc} onChange={(e) => setZohoDc(e.target.value)} options={[["com","US (.com)"],["eu","Europe (.eu)"],["in","India (.in)"],["com.au","Australia (.com.au)"],["jp","Japan (.jp)"],["ca","Canada (.ca)"],["sa","Saudi Arabia (.sa)"],["com.cn","China (.com.cn)"]]} />}
      {provider !== "smtp" && <Btn kind="primary" disabled={working || !catalog.data?.some((p) => p.provider_key === provider && p.enabled && p.manifest?.supports_multiple_accounts === true)} onClick={connect}>{working ? "Opening…" : "Connect another account"}</Btn>}
      <Btn kind="link" disabled={catalog.loading || accounts.loading} onClick={() => { catalog.reload(); accounts.reload(); }}>Refresh</Btn>
    </div>
    {provider === "smtp" && <div style={{ ...S.card, marginTop: 10 }}>
      <b>Connect SMTP mailbox</b>
      <Muted>Send-only adapter. Use an app-specific password where available. TLS is mandatory; credentials are encrypted before storage. New accounts remain disabled for sending.</Muted>
      <div style={S.row}><Input value={smtp.mailbox} onChange={(e) => setSmtp((v) => ({ ...v, mailbox: e.target.value }))} placeholder="mailbox@example.com" />
        <Input value={smtp.host} onChange={(e) => setSmtp((v) => ({ ...v, host: e.target.value }))} placeholder="smtp.example.com" />
        <Input value={smtp.port} onChange={(e) => setSmtp((v) => ({ ...v, port: e.target.value }))} placeholder="587" /></div>
      <div style={S.row}><Input value={smtp.username} onChange={(e) => setSmtp((v) => ({ ...v, username: e.target.value }))} placeholder="SMTP username" />
        <Input type="password" value={smtp.password} onChange={(e) => setSmtp((v) => ({ ...v, password: e.target.value }))} placeholder="SMTP app password" />
        <Select value={smtp.tls_mode} onChange={(e) => setSmtp((v) => ({ ...v, tls_mode: e.target.value }))} options={[["starttls", "STARTTLS (587)"], ["ssl", "Implicit TLS (465)"]]} />
        <Btn kind="primary" disabled={working || !smtp.mailbox.includes("@") || !smtp.host || !smtp.username || !smtp.password || !["465", "587"].includes(smtp.port)} onClick={connect}>{working ? "Saving…" : "Save SMTP account"}</Btn></div>
    </div>}
    <Banner tone="info">Use “Check health” to verify Gmail or Zoho authorization without enabling sync or sending. Account connection does not authorize sending. The global emergency stop and existing human-approval rules remain authoritative. Each new account starts with sending OFF. Prospecting also requires explicit recorded consent for the exact recipient.</Banner>
    {(catalog.data || []).filter((p) => ["gmail", "zoho", "smtp"].includes(p.provider_key)).map((p) => <div key={p.provider_key} style={{ ...S.row, marginTop: 8 }}>
      <Pill tone={p.sending_enabled ? "warn" : "muted"}>{p.display_name} global provider gate: {p.sending_enabled ? "ON" : "OFF"}</Pill>
      <Muted>Deployment-owner controlled. Organization admins can manage only their own mailbox accounts.</Muted>
    </div>)}
    <div style={{ ...S.card, marginTop: 12 }}>
      <b>Record recipient permission</b>
      <Muted>Use only when you have documented permission or an existing business-correspondence basis. Revocation blocks future dispatch.</Muted>
      <div style={S.row}><Input value={consentEmail} onChange={(e) => setConsentEmail(e.target.value)} placeholder="recipient@example.com" />
        <Select value={consentPurpose} onChange={(e) => setConsentPurpose(e.target.value)} options={[["consented_prospecting","Consented prospecting"],["business_correspondence","Business correspondence"]]} /></div>
      <div style={S.row}><Input value={consentEvidence} onChange={(e) => setConsentEvidence(e.target.value)} placeholder="Evidence type / reference" />
        <Btn small kind="primary" disabled={!!busyId || !consentEmail.includes("@") || !consentEvidence.trim()} onClick={() => run("consent", async () => { await intelApi.setContactPermission(supabase, { email: consentEmail, purpose: consentPurpose, evidenceType: "admin_recorded:" + consentEvidence.trim(), evidenceReference: consentEvidence.trim(), granted: true }); setConsentEmail(""); setConsentEvidence(""); })}>Record permission</Btn>
        <Btn small kind="danger" disabled={!!busyId || !consentEmail.includes("@")} onClick={() => confirmAction(`Revoke ${consentPurpose.replaceAll("_", " ")} for ${consentEmail}?`) && run("consent-revoke", () => intelApi.setContactPermission(supabase, { email: consentEmail, purpose: consentPurpose, evidenceType: "admin_revocation", evidenceReference: "Revoked from provider settings", granted: false }))}>Revoke</Btn></div>
    </div>
    <Table rowKey={(r) => r.id} rows={rows} empty={accounts.loading ? "Loading provider accounts…" : "No provider accounts connected yet."} columns={[
      { key: "mailbox", label: "Mailbox", render: (r) => <><b>{r.mailbox}</b><div style={{ color: T.muted, fontSize: 11 }}>{r.provider_key} · {r.auth_method}</div></> },
      { key: "status", label: "Connection", render: (r) => <Pill tone={r.status === "connected" ? "ok" : "warn"}>{r.status}</Pill> },
      { key: "health", label: "Health", render: (r) => <Pill tone={r.health_status === "healthy" ? "ok" : "muted"}>{r.health_status}</Pill> },
      { key: "sync", label: "Sync", render: (r) => r.is_enabled ? "Enabled" : "Paused" },
      { key: "send", label: "Sending", render: (r) => <span style={S.row}><Pill tone={r.send_enabled ? "warn" : "muted"}>{r.send_enabled ? "Configured on" : "OFF"}</Pill><Btn small disabled={!!busyId || r.status !== "connected" || !r.is_enabled || !(["gmail", "zoho", "smtp"].includes(r.provider_key))} onClick={() => confirmAction(`${r.send_enabled ? "Disable" : "Enable"} sending from ${r.mailbox}? Global provider gate, recipient policy, quotas and emergency stop still apply.`) && run(r.id, () => intelApi.updateProviderAccount(supabase, r.id, { send_enabled: !r.send_enabled }))}>{r.send_enabled ? "Turn off" : "Turn on"}</Btn></span> },
      { key: "purpose", label: "Prospecting", render: (r) => { const purposes = r.allowed_message_purposes || ["business_correspondence"]; const allowed = purposes.includes("consented_prospecting"); return <span><Btn small disabled={!!busyId || !( ["gmail", "zoho", "smtp"].includes(r.provider_key))} onClick={() => confirmAction(`${allowed ? "Remove" : "Allow"} consented prospecting for ${r.mailbox}? Recipient-specific consent is still mandatory.`) && run(r.id, () => intelApi.updateProviderAccount(supabase, r.id, { allowed_message_purposes: allowed ? purposes.filter((x) => x !== "consented_prospecting") : [...purposes, "consented_prospecting"] }))}>{allowed ? "Allowed" : "Not allowed"}</Btn>{r.provider_key === "zoho" && <Muted>Manual approval required per message</Muted>}</span>; } },
      { key: "limits", label: "Caps / day · hour · min", render: (r) => `${r.daily_send_limit ?? "∞"} · ${r.hourly_send_limit ?? "∞"} · ${r.minute_send_limit ?? "∞"}` },
      { key: "actions", label: "Actions", render: (r) => <span style={S.row}>
        {["gmail", "zoho"].includes(r.provider_key) && <Btn small disabled={!!busyId || r.status !== "connected"} onClick={() => run(r.id, async () => {
          try {
            const result = await intelApi.checkProviderHealth(supabase, r.id);
            if (!result?.ok) throw new Error(result?.error || "Provider health check did not pass.");
          } finally {
            await accounts.reload();
          }
        })}>Check health</Btn>}
        <Btn small disabled={!!busyId || r.status !== "connected"} onClick={() => run(r.id, () => intelApi.updateProviderAccount(supabase, r.id, { is_enabled: !r.is_enabled }))}>{r.is_enabled ? "Pause sync" : "Enable sync"}</Btn>
        <Btn small kind="danger" disabled={!!busyId} onClick={() => confirmAction(`Disconnect ${r.mailbox}? This disables this account only; other connected accounts are untouched.`) && run(r.id, () => intelApi.disconnectProviderAccount(supabase, r.id))}>Disconnect</Btn>
      </span> },
    ]} />
    {rows.some((r) => r.last_error) && <div>{rows.filter((r) => r.last_error).map((r) => <Banner key={r.id} tone="warn">{r.mailbox}: {r.last_error}</Banner>)}</div>}
  </Section>;
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
      <WorkerControlCard />
      <SafetyCard s={st.data} supabase={supabase} onSaved={async () => { await st.reload(); await onChanged(); }} />
      <SenderCard s={st.data} supabase={supabase} onSaved={async () => { await st.reload(); await onChanged(); }} />
      <ProviderAccountsCard supabase={supabase} tick={tick} onSaved={onChanged} />
      <ResendAuditCard supabase={supabase} />
      <SourcesCard supabase={supabase} />
      <KbCard supabase={supabase} />
      <SuppressionCard supabase={supabase} />
    </div>
  );
}
