import React, { useEffect, useMemo, useState } from "react";
import { S, T, Btn, Pill, Banner, Field, Modal, Tabs } from "../finance/ui.jsx";
import { supabase } from "../supabaseClient";
import { rpc, savePrivacy } from "../finance/api.js";
import { playNotificationSound } from "./runtime.js";
import {
  validateSettings, errorTabs, dirtyTabs, followupScheduleFor, MAX_FOLLOWUPS, NOTIFICATION_CATEGORIES, SOUNDS,
  DATE_FORMATS, LANDING_TABS, SUPPORTED_CURRENCY_SYMBOLS, DEFAULT_LEAD_CHANNELS, DEFAULT_ARCHIVE_DAYS,
} from "./schema.js";

const TABS = [
  ["general", "General"], ["crm", "CRM"], ["production", "Production"], ["teams", "Teams"],
  ["finance", "Finance"], ["alerts", "Alerts & display"], ["account", "Integrations & account"],
];
const TAB_LABEL = Object.fromEntries(TABS);
const DAYS = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"]];
const STAGE_LABELS = { won: "Won", lost: "Lost", no_response: "No response", disqualified: "Disqualified", closed: "Closed" };
const CURRENCY_LABELS = { "$": "USD ($)", "\u00a5": "JPY (\u00a5)", "\u20ac": "EUR (\u20ac)", "\u00a3": "GBP (\u00a3)", KSh: "KES (KSh)" };

const Err = ({ msg }) => (msg ? <span role="alert" style={{ fontSize: 12.5, color: T.bad }}>{msg}</span> : null);
const Section = ({ title, hint, children }) => (
  <div style={S.card}>
    <div><h3 style={S.h3}>{title}</h3>{hint && <p style={{ ...S.sub, marginTop: 4 }}>{hint}</p>}</div>
    {children}
  </div>
);
const Num = ({ value, onChange, min, max, width = 90, ...p }) => (
  <input style={{ ...S.input, width }} type="number" inputMode="numeric" min={min} max={max} value={value} onChange={(e) => onChange(e.target.value)} {...p} />
);
const Switch = ({ checked, onChange, label, hint, disabled }) => (
  <label style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1 }}>
    <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 3 }} />
    <span><span style={{ fontSize: 13.5 }}>{label}</span>{hint && <span style={{ display: "block", fontSize: 12.5, color: T.muted }}>{hint}</span>}</span>
  </label>
);
function ChipList({ items, onRemove, extra }) {
  return (
    <div style={S.row}>
      {items.map((c) => (
        <span key={c} style={{ display: "inline-flex", gap: 6, alignItems: "center", border: `1px solid ${T.border}`, borderRadius: 999, padding: "4px 6px 4px 12px", fontSize: 13 }}>
          {c}{extra && extra(c)}
          {onRemove && <button type="button" aria-label={`Remove ${c}`} onClick={() => onRemove(c)} style={{ background: "none", border: "none", color: T.muted, cursor: "pointer", fontSize: 15, lineHeight: 1 }}>{"\u00d7"}</button>}
        </span>
      ))}
    </div>
  );
}
function AddRow({ placeholder, onAdd, label = "Add" }) {
  const [v, setV] = useState("");
  const go = () => { const t = v.trim(); if (t) { onAdd(t); setV(""); } };
  return (
    <div style={S.row}>
      <input style={{ ...S.input, maxWidth: 260 }} value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); go(); } }} />
      <Btn small onClick={go}>{label}</Btn>
    </div>
  );
}

// ---------------------------------------------------------------- General
function GeneralTab({ form, set, errors }) {
  const zones = useMemo(() => {
    try { return Intl.supportedValuesOf("timeZone"); } catch { return ["UTC", "Africa/Nairobi", "Europe/London", "America/New_York", "Asia/Tokyo"]; }
  }, []);
  const ww = form.workweek;
  const toggleDay = (d) => set({ workweek: { ...ww, days: ww.days.includes(d) ? ww.days.filter((x) => x !== d) : [...ww.days, d] } });
  return (
    <>
      <Section title="Studio" hint="Shown across the app and on generated documents.">
        <div style={S.grid(240)}>
          <Field label="Studio name"><input style={S.input} value={form.studioName} onChange={(e) => set({ studioName: e.target.value })} /><Err msg={errors.studioName} /></Field>
          <Field label="Tagline" hint="Shown on generated invoice PDFs."><input style={S.input} value={form.studioTagline} onChange={(e) => set({ studioTagline: e.target.value })} /></Field>
          <Field label="Legal name (optional)" hint="Used on invoices instead of the studio name when set."><input style={S.input} value={form.studioLegalName} onChange={(e) => set({ studioLegalName: e.target.value })} /></Field>
          <Field label="Address (optional)"><input style={S.input} value={form.studioAddress} onChange={(e) => set({ studioAddress: e.target.value })} /></Field>
        </div>
        <Field label="Logo URL" hint="A link to your logo image. Used on invoices and shared pages.">
          <div style={S.row}>
            <input style={{ ...S.input, maxWidth: 420 }} value={form.logoUrl} onChange={(e) => set({ logoUrl: e.target.value })} placeholder="https://..." />
            {form.logoUrl && <img src={form.logoUrl} alt="Logo preview" style={{ height: 36, borderRadius: 4, border: `1px solid ${T.border}` }} onError={(e) => { e.currentTarget.style.display = "none"; }} />}
          </div>
        </Field>
      </Section>
      <Section title="Region & time">
        <div style={S.grid(240)}>
          <Field label="Timezone" hint="Decides what 'today' means for due dates and Finance."><select style={S.input} value={form.timezone} onChange={(e) => set({ timezone: e.target.value })}><option value="">Follow my browser</option>{zones.map((z) => <option key={z}>{z}</option>)}</select><Err msg={errors.timezone} /></Field>
          <Field label="Date format"><select style={S.input} value={form.dateFormat} onChange={(e) => set({ dateFormat: e.target.value })}>{DATE_FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</select></Field>
          <Field label="Opens to"><select style={S.input} value={form.defaultLandingTab} onChange={(e) => set({ defaultLandingTab: e.target.value })}>{LANDING_TABS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select></Field>
        </div>
      </Section>
      <Section title="Working week" hint="Used by the time tracker: time outside these days and hours counts as overtime.">
        <div style={S.row}>{DAYS.map(([d, l]) => <label key={d} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13.5 }}><input type="checkbox" checked={ww.days.includes(d)} onChange={() => toggleDay(d)} />{l}</label>)}</div>
        <Field label="Hours per working day"><Num value={ww.hoursPerDay} min={0} max={24} width={90} onChange={(v) => set({ workweek: { ...ww, hoursPerDay: v } })} /></Field>
        <Err msg={errors.workweek} />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- CRM
function ReasonEditor({ kind, title, defaults, form, set }) {
  const g = form.outcomeReasons[kind];
  const upd = (patch) => set({ outcomeReasons: { ...form.outcomeReasons, [kind]: { ...g, ...patch } } });
  return (
    <Field label={title}>
      <div style={S.row}>
        {defaults.map((r) => {
          const hidden = g.hidden.includes(r);
          return (
            <span key={r} style={{ display: "inline-flex", gap: 6, alignItems: "center", border: `1px solid ${T.border}`, borderRadius: 999, padding: "4px 10px", fontSize: 13, opacity: hidden ? 0.45 : 1 }}>
              <span style={{ textDecoration: hidden ? "line-through" : "none" }}>{r}</span>
              {r !== "Other" && <button type="button" onClick={() => upd({ hidden: hidden ? g.hidden.filter((x) => x !== r) : [...g.hidden, r] })} style={{ background: "none", border: "none", color: T.accentText, cursor: "pointer", fontSize: 12 }}>{hidden ? "Show" : "Hide"}</button>}
            </span>
          );
        })}
      </div>
      <ChipList items={g.custom} onRemove={(c) => upd({ custom: g.custom.filter((x) => x !== c) })} />
      <AddRow placeholder="Add your own reason" onAdd={(t) => { if (![...defaults, ...g.custom].some((x) => x.toLowerCase() === t.toLowerCase())) upd({ custom: [...g.custom, t] }); }} />
    </Field>
  );
}

function CrmTab({ form, set, errors, reasonDefaults }) {
  const sched = form.followupSchedule;
  const count = sched.length - 1;
  const setCount = (n) => {
    const next = Math.min(MAX_FOLLOWUPS, Math.max(1, n));
    if (next === count) return;
    if (next < count) return set({ followupSchedule: sched.slice(0, next + 1) });
    const out = [...sched];
    while (out.length < next + 1) out.push({ label: `Follow-up #${out.length}`, dayOffset: out[out.length - 1].dayOffset + 7 });
    set({ followupSchedule: out });
  };
  const setDay = (i, v) => set({ followupSchedule: sched.map((s, j) => (j === i ? { ...s, dayOffset: v === "" ? "" : Number(v) } : s)) });
  const channels = form.leadChannels;
  const hidden = form.dashboardHiddenChannels;
  return (
    <>
      <Section title="Lead channels" hint="Where leads come from. 'Hidden' removes a channel from the dashboard breakdown only; it stays selectable everywhere else.">
        <ChipList items={channels} onRemove={(c) => set({ leadChannels: channels.filter((x) => x !== c) })}
          extra={(c) => <button type="button" onClick={() => set({ dashboardHiddenChannels: hidden.includes(c) ? hidden.filter((x) => x !== c) : [...hidden, c] })} style={{ background: "none", border: "none", color: hidden.includes(c) ? T.warn : T.accentText, cursor: "pointer", fontSize: 12 }}>{hidden.includes(c) ? "Hidden" : "Shown"}</button>} />
        <AddRow placeholder="New channel" label="Add channel" onAdd={(t) => { if (!channels.some((c) => c.toLowerCase() === t.toLowerCase())) set({ leadChannels: [...channels, t] }); }} />
      </Section>
      <Section title="Follow-up cadence" hint="After the first email, how many follow-ups to schedule and when. Existing leads keep their own email slots; only the first N follow-ups count as scheduled.">
        <div style={S.row}>
          <span style={{ fontSize: 13.5 }}>Follow-ups after the initial email</span>
          <Btn small onClick={() => setCount(count - 1)} disabled={count <= 1} aria-label="Fewer follow-ups">{"\u2212"}</Btn>
          <strong style={{ minWidth: 20, textAlign: "center" }}>{count}</strong>
          <Btn small onClick={() => setCount(count + 1)} disabled={count >= MAX_FOLLOWUPS} aria-label="More follow-ups">+</Btn>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {sched.map((s, i) => (
            <div key={i} style={{ ...S.row, gap: 12 }}>
              <span style={{ width: 120, fontSize: 13.5 }}>{i === 0 ? "Initial email" : `Follow-up #${i}`}</span>
              {i === 0 ? <span style={{ color: T.muted, fontSize: 13 }}>Day 0 (the start)</span> : <><span style={{ color: T.muted, fontSize: 13 }}>Day</span><Num value={s.dayOffset} min={1} max={365} width={80} onChange={(v) => setDay(i, v)} /></>}
            </div>
          ))}
        </div>
        <Err msg={errors.followupSchedule} />
        <Switch checked={form.autoNoResponse} onChange={(v) => set({ autoNoResponse: v })} label="Move to No Response automatically" hint="When the last scheduled follow-up is sent to a Cold Email lead. You can always move a lead back by hand." />
      </Section>
      <Section title="Auto-archive" hint="How long a finished lead stays on the board before it is archived. Archiving hides a lead; it never deletes it.">
        <div style={S.grid(150)}>
          {Object.keys(DEFAULT_ARCHIVE_DAYS).map((k) => (
            <Field key={k} label={`${STAGE_LABELS[k]} (days)`}><Num value={form.archiveDays[k]} min={1} max={3650} width="100%" onChange={(v) => set({ archiveDays: { ...form.archiveDays, [k]: v === "" ? "" : Number(v) } })} /></Field>
          ))}
        </div>
        <Err msg={errors.archiveDays} />
      </Section>
      <Section title="Outcome reasons" hint="The reasons offered when a lead is lost or disqualified. Hiding a default only removes it from the list; leads that already use it keep it.">
        <ReasonEditor kind="lost" title="Why a pitched lead didn't convert" defaults={reasonDefaults.lost} form={form} set={set} />
        <ReasonEditor kind="disqualified" title="Why a lead was disqualified" defaults={reasonDefaults.disqualified} form={form} set={set} />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- Production
function ProductionTab({ form, set, errors, pipelineLibrary }) {
  const stages = (pipelineLibrary || []).filter((s) => s.family === "canonical" && s.is_selectable).sort((a, b) => a.default_order - b.default_order);
  const keys = form.defaultPipelineStageKeys;
  const toggle = (id) => set({ defaultPipelineStageKeys: keys.includes(id) ? keys.filter((k) => k !== id) : [...keys, id] });
  const pd = form.plannerDefaults;
  const ft = form.userPrefs.focusTimer;
  const setFt = (k, v) => set({ userPrefs: { ...form.userPrefs, focusTimer: { ...ft, [k]: v === "" ? "" : Number(v) } } });
  return (
    <>
      <Section title="New projects">
        <div style={S.grid(240)}>
          <Field label="Default shot priority"><select style={S.input} value={form.defaultShotPriority} onChange={(e) => set({ defaultShotPriority: e.target.value })}><option value="low">Low</option><option value="normal">Normal</option><option value="rush">Rush</option></select></Field>
          <Field label="Default pipeline"><select style={S.input} value={form.defaultPipelinePreset} onChange={(e) => set({ defaultPipelinePreset: e.target.value })}><option value="full">Full pipeline (all stages)</option><option value="custom">Custom (choose stages)</option></select></Field>
        </div>
        {form.defaultPipelinePreset === "custom" && (
          <Field label="Stages to include">
            {stages.length === 0 ? <span style={S.sub}>The stage list hasn't loaded yet.</span> : (
              <div style={S.grid(200)}>{stages.map((s) => <label key={s.id} style={{ display: "flex", gap: 8, fontSize: 13.5 }}><input type="checkbox" checked={keys.includes(s.id)} onChange={() => toggle(s.id)} />{s.name}</label>)}</div>
            )}
            <Err msg={errors.defaultPipelineStageKeys} />
          </Field>
        )}
        <p style={S.sub}>Applies to projects you create from now on. Existing projects keep their own pipeline.</p>
      </Section>
      <Section title="Budget planner defaults" hint="Starting values for new plans. A plan created from a template uses the template's own numbers.">
        <div style={S.grid(160)}>
          <Field label="Target profit (%)"><Num value={pd.profitPercent} min={0} max={99} width="100%" onChange={(v) => set({ plannerDefaults: { ...pd, profitPercent: v === "" ? "" : Number(v) } })} /></Field>
          <Field label="Safety reserve (%)"><Num value={pd.contingencyPercent} min={0} max={100} width="100%" onChange={(v) => set({ plannerDefaults: { ...pd, contingencyPercent: v === "" ? "" : Number(v) } })} /></Field>
          <Field label="Frame rate (fps)"><Num value={pd.fps} min={1} max={240} width="100%" onChange={(v) => set({ plannerDefaults: { ...pd, fps: v === "" ? "" : Number(v) } })} /></Field>
        </div>
        <Err msg={errors.plannerDefaults} />
      </Section>
      <Section title="Focus timer" hint="Saved to your account, so it follows you to any device.">
        <div style={S.grid(150)}>
          <Field label="Focus (min)"><Num value={ft.workMinutes} min={1} max={180} width="100%" onChange={(v) => setFt("workMinutes", v)} /></Field>
          <Field label="Break (min)"><Num value={ft.breakMinutes} min={1} max={60} width="100%" onChange={(v) => setFt("breakMinutes", v)} /></Field>
          <Field label="Long break (min)"><Num value={ft.longBreakMinutes} min={1} max={120} width="100%" onChange={(v) => setFt("longBreakMinutes", v)} /></Field>
          <Field label="Sessions before long break"><Num value={ft.cyclesBeforeLongBreak} min={1} max={12} width="100%" onChange={(v) => setFt("cyclesBeforeLongBreak", v)} /></Field>
        </div>
        <Err msg={errors.focusTimer} />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- Teams
function TeamsTab({ form, set, errors }) {
  const methods = form.paymentMethodOptions;
  return (
    <Section title="Payment methods" hint="The options offered when you record a freelancer payment.">
      <ChipList items={methods} onRemove={methods.length > 1 ? (m) => set({ paymentMethodOptions: methods.filter((x) => x !== m) }) : undefined} />
      <AddRow placeholder="New payment method" onAdd={(t) => { if (!methods.some((m) => m.toLowerCase() === t.toLowerCase())) set({ paymentMethodOptions: [...methods, t] }); }} />
      <Err msg={errors.paymentMethodOptions} />
    </Section>
  );
}

// ---------------------------------------------------------------- Finance
function FinanceTab({ form, set, errors, userId, onPrivacy }) {
  const [fin, setFin] = useState(undefined);
  useEffect(() => {
    let alive = true;
    supabase.from("finance_settings").select("*").eq("user_id", userId).maybeSingle().then(({ data }) => alive && setFin(data || null));
    return () => { alive = false; };
  }, [userId]);
  const [privBusy, setPrivBusy] = useState(false);
  const togglePrivacy = async (on) => {
    setPrivBusy(true);
    try { if (!fin) await rpc("finance_init"); await savePrivacy(userId, on); setFin({ ...(fin || {}), privacy_mode: on }); onPrivacy && onPrivacy(on); } catch (e) { window.alert(e.message || "Couldn't save."); }
    setPrivBusy(false);
  };
  const m = form.milestoneDefaults;
  const sum = Math.round(m.reduce((a, b) => a + (Number(b) || 0), 0) * 100) / 100;
  const pf = form.invoicePrefixes;
  return (
    <>
      <Section title="Currency" hint="Your books are kept in a base currency. Each transaction also keeps its own currency and the exchange rate for its date.">
        <div style={S.grid(240)}>
          <Field label="Accounting base currency" hint="Set in Finance > Settings. It locks once real transactions are posted.">
            <div style={{ ...S.input, display: "flex", alignItems: "center", gap: 8, background: "transparent" }}>{fin === undefined ? "Loading..." : fin ? <><strong>{fin.base_currency}</strong><Pill tone="muted">managed in Finance</Pill></> : <span style={{ color: T.muted }}>Chosen when you first open Finance</span>}</div>
          </Field>
          <Field label="Default currency for new projects"><select style={S.input} value={form.currencySymbol} onChange={(e) => set({ currencySymbol: e.target.value })}>{SUPPORTED_CURRENCY_SYMBOLS.map((c) => <option key={c} value={c}>{CURRENCY_LABELS[c]}</option>)}</select><Err msg={errors.currencySymbol} /></Field>
        </div>
      </Section>
      <Section title="Invoicing defaults">
        <Field label="Milestone split (%)" hint={`Deposit / midpoint / final. Currently adds up to ${sum}%.`}>
          <div style={S.row}>{m.map((v, i) => <Num key={i} value={v} min={0} max={100} width={90} onChange={(x) => set({ milestoneDefaults: m.map((y, j) => (j === i ? (x === "" ? "" : Number(x)) : y)) })} />)}<span style={{ color: sum === 100 ? T.ok : T.warn, fontSize: 13 }}>= {sum}%</span></div>
          <Err msg={errors.milestoneDefaults} />
        </Field>
        <Field label="Document number prefixes" hint="Used for the next number only. Numbers already issued never change.">
          <div style={S.row}>{[["proforma", "Pro-forma"], ["invoice", "Invoice"], ["receipt", "Receipt"]].map(([k, l]) => (
            <label key={k} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>{l}<input style={{ ...S.input, width: 90, textTransform: "uppercase" }} maxLength={6} value={pf[k]} onChange={(e) => set({ invoicePrefixes: { ...pf, [k]: e.target.value.toUpperCase() } })} /></label>
          ))}</div>
          <Err msg={errors.invoicePrefixes} />
        </Field>
        <Field label="Default payment terms (days)" hint="Pre-fills the due date on new invoices. 0 leaves it blank."><Num value={form.defaultPaymentTermsDays} min={0} max={365} width={100} onChange={(v) => set({ defaultPaymentTermsDays: v === "" ? "" : Number(v) })} /><Err msg={errors.defaultPaymentTermsDays} /></Field>
      </Section>
      <Section title="Tax details" hint="Printed on invoices. The app records these; it doesn't decide tax treatment.">
        <div style={S.grid(240)}>
          <Field label="Tax / PIN number"><input style={S.input} value={form.studioTaxId} onChange={(e) => set({ studioTaxId: e.target.value })} /></Field>
          <Field label="VAT status"><input style={S.input} value={form.studioVatStatus} onChange={(e) => set({ studioVatStatus: e.target.value })} placeholder="e.g. Registered / Not registered" /></Field>
          <Field label="eTIMS number"><input style={S.input} value={form.studioEtimsNumber} onChange={(e) => set({ studioEtimsNumber: e.target.value })} /></Field>
        </div>
      </Section>
      <Section title="Privacy" hint="Hides every financial amount across Finance and the dashboard. Applies immediately and is saved to your account.">
        <Switch checked={!!fin?.privacy_mode} disabled={privBusy || fin === undefined} onChange={togglePrivacy} label="Hide financial figures" />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- Alerts & display
function AlertsTab({ form, set, periodOptions, onEnableNotifications, hiddenCount }) {
  const supported = typeof window !== "undefined" && "Notification" in window;
  const [perm, setPerm] = useState(supported ? Notification.permission : "unsupported");
  const prefs = form.userPrefs;
  const setPrefs = (patch) => set({ userPrefs: { ...prefs, ...patch } });
  const snd = prefs.sound;
  return (
    <>
      <Section title="Desktop notifications">
        <Switch checked={form.notificationsEnabled} onChange={(v) => set({ notificationsEnabled: v })} label="Notifications on" hint="Master switch. Your browser's own permission must also be granted." />
        {perm === "unsupported" ? <span style={S.sub}>This browser doesn't support desktop notifications.</span>
          : perm === "granted" ? <Pill tone="ok">Browser permission granted</Pill>
          : perm === "denied" ? <span style={S.sub}>Blocked in your browser. Re-enable notifications for this site in the browser's site settings.</span>
          : <div><Btn onClick={async () => setPerm(await onEnableNotifications())}>Allow notifications in this browser</Btn></div>}
      </Section>
      <Section title="What to be notified about">
        {NOTIFICATION_CATEGORIES.map((c) => (
          <Switch key={c.id} disabled={!form.notificationsEnabled} checked={prefs.notifyCategories[c.id] !== false} label={c.label} hint={c.hint}
            onChange={(v) => setPrefs({ notifyCategories: { ...prefs.notifyCategories, [c.id]: v } })} />
        ))}
        <Switch disabled checked={false} label="Finance alerts (coming soon)" hint="Overdue invoices and bills due." onChange={() => {}} />
      </Section>
      <Section title="Sound" hint="A short chime with each notification. A web page can't change the system's own notification sound, so this plays only while a Kairil tab is open.">
        <Switch checked={snd.enabled} onChange={(v) => setPrefs({ sound: { ...snd, enabled: v } })} label="Play a sound" />
        <div style={{ ...S.row, opacity: snd.enabled ? 1 : 0.5 }}>
          {SOUNDS.map((s) => (
            <label key={s.id} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13.5, border: `1px solid ${snd.id === s.id ? T.accent : T.border}`, borderRadius: 8, padding: "6px 12px" }}>
              <input type="radio" name="snd" disabled={!snd.enabled} checked={snd.id === s.id} onChange={() => setPrefs({ sound: { ...snd, id: s.id } })} />{s.label}
              <Btn small kind="link" disabled={!snd.enabled} onClick={() => playNotificationSound({ ...snd, enabled: true, id: s.id })}>Preview</Btn>
            </label>
          ))}
        </div>
        <Field label="Volume"><input type="range" min="0.1" max="1" step="0.1" value={snd.volume} disabled={!snd.enabled} onChange={(e) => setPrefs({ sound: { ...snd, volume: Number(e.target.value) } })} style={{ maxWidth: 240 }} /></Field>
      </Section>
      <Section title="Dashboard">
        <Field label="Default period" hint="The period the dashboard's outreach card opens with."><select style={{ ...S.input, maxWidth: 240 }} value={prefs.dashboardPeriod} onChange={(e) => setPrefs({ dashboardPeriod: e.target.value })}>{periodOptions.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></Field>
        <span style={S.sub}>{hiddenCount} lead channel(s) hidden from the dashboard. Manage that under CRM &gt; Lead channels.</span>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- Integrations & account
function AccountTab({ settings, email, drive, patreon, onReplayTutorial, onOpenSupport, onExport, onSignOut, onAccountAction, links }) {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState("");
  const [inbox, setInbox] = useState(null);
  const [del, setDel] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState("");
  const act = async (action, payload, okMsg) => {
    setBusy(action); setMsg("");
    const r = await onAccountAction(action, payload);
    setBusy("");
    setMsg(r.ok ? okMsg : r.error || "That didn't work.");
    return r;
  };
  const loadInbox = async () => {
    const { data } = await supabase.from("support_messages").select("*").order("created_at", { ascending: false }).limit(30);
    setInbox(data || []);
  };
  return (
    <>
      {msg && <Banner tone={/didn't|match|error|fail/i.test(msg) ? "bad" : "ok"}>{msg}</Banner>}
      <Section title="Google Drive" hint="Project folders and uploads are stored in your Drive.">
        {drive.email ? <div style={S.row}><Pill tone="ok">Connected</Pill><span style={{ fontSize: 13.5 }}>{drive.email}</span></div> : <span style={S.sub}>Not connected. Connect it to create project folders and upload files.</span>}
        <div style={S.row}>
          <Btn onClick={drive.onConnect}>{drive.email ? "Reconnect" : "Connect Google Drive"}</Btn>
          {drive.email && <Btn kind="danger" disabled={busy === "disconnect_drive"} onClick={() => { if (window.confirm("Disconnect Google Drive? Kairil stops creating folders and uploads. Files already in your Drive are not touched.")) act("disconnect_drive", {}, "Google Drive disconnected."); }}>Disconnect</Btn>}
        </div>
      </Section>
      <Section title="Patreon" hint="Connect to unlock Pro automatically while you're subscribed.">
        {settings.isAdmin ? <span style={S.sub}>{patreon.connected ? `Connected${patreon.email ? ` as ${patreon.email}` : ""}` : "Not connected"}. Admin override is on, so this doesn't change your access.</span>
          : !patreon.connected ? <Btn onClick={patreon.onConnect}>Connect Patreon</Btn>
          : <>
              <div style={S.row}><Pill tone={patreon.isPro ? "ok" : "muted"}>{patreon.isPro ? "Pro member" : "Not subscribed to Pro"}</Pill>{patreon.email && <span style={{ fontSize: 13.5 }}>{patreon.email}</span>}</div>
              <div style={S.row}>
                {patreon.isPro ? <a href={links.manage} target="_blank" rel="noreferrer" style={{ color: T.accentText, fontSize: 13.5 }}>Manage membership on Patreon</a> : <a href={links.checkout} target="_blank" rel="noreferrer" style={{ color: T.accentText, fontSize: 13.5 }}>Become a Patron</a>}
                <Btn onClick={patreon.onConnect}>Refresh status</Btn>
                <Btn kind="danger" disabled={busy === "disconnect_patreon"} onClick={() => { if (window.confirm(patreon.isPro ? "Disconnect Patreon? Your account returns to the Free plan, because Pro comes from this connection." : "Disconnect Patreon?")) act("disconnect_patreon", {}, "Patreon disconnected."); }}>Disconnect</Btn>
              </div>
            </>}
      </Section>
      <Section title="Account">
        <div style={S.grid(240)}>
          <Field label="Email"><span style={{ fontSize: 14 }}>{email}</span></Field>
          <Field label="Plan"><span style={{ fontSize: 14 }}>{settings.isAdmin ? "Admin (full access)" : settings.plan === "pro" ? "Pro" : "Free"}</span>{!settings.isAdmin && settings.plan !== "pro" && <span style={{ fontSize: 12.5, color: T.muted }}>Teams, Client Portal, freelancer links, milestones and multiple currencies are Pro. Free accounts are limited to {links.freeLimit} active projects.</span>}</Field>
        </div>
        <div style={S.row}>
          <Btn onClick={onExport}>Export backup</Btn>
          <Btn onClick={onSignOut}>Sign out</Btn>
        </div>
        <span style={S.sub}>Export backup downloads all your data as a JSON file.</span>
      </Section>
      <Section title="Help">
        <div style={S.row}><Btn onClick={onReplayTutorial}>Replay the tutorial</Btn><Btn onClick={onOpenSupport}>Report a problem or ask a question</Btn></div>
        {settings.isAdmin && (
          <Field label="Support inbox">
            {inbox === null ? <div><Btn small onClick={loadInbox}>Load recent messages</Btn></div> : inbox.length === 0 ? <span style={S.sub}>Nothing's come in yet.</span> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 240, overflowY: "auto" }}>{inbox.map((m) => (
                <div key={m.id} style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: "8px 10px" }}>
                  <div style={{ ...S.row, justifyContent: "space-between", fontSize: 12.5, color: T.muted }}><span>{m.email}</span><span>{new Date(m.created_at).toLocaleDateString()}</span></div>
                  <p style={{ margin: "4px 0 0", fontSize: 13.5 }}>{m.message}</p>{m.page_context && <span style={{ fontSize: 12, color: T.muted }}>from: {m.page_context}</span>}
                </div>))}</div>
            )}
          </Field>
        )}
      </Section>
      <div style={{ ...S.card, borderColor: "rgba(255,107,107,0.35)" }}>
        <h3 style={{ ...S.h3, color: T.bad }}>Danger zone</h3>
        <p style={S.sub}>Deleting your account permanently removes your projects, leads, invoices, finance records, team and settings. This cannot be undone. Export a backup first.</p>
        <div><Btn kind="danger" onClick={() => setDel(true)}>Delete my account...</Btn></div>
      </div>
      {del && (
        <Modal title="Delete your account?" onClose={() => setDel(false)} width={460}
          footer={<><Btn onClick={() => setDel(false)}>Cancel</Btn><Btn kind="danger" disabled={busy === "delete_account" || confirmEmail.trim().toLowerCase() !== String(email).toLowerCase()} onClick={async () => { const r = await act("delete_account", { confirmEmail }, ""); if (r.ok) setDel(false); }}>{busy === "delete_account" ? "Deleting..." : "Delete everything"}</Btn></>}>
          <p style={S.sub}>This permanently deletes all data for <strong>{email}</strong>, disconnects Google Drive, and signs you out. Type your email to confirm.</p>
          <input style={S.input} value={confirmEmail} onChange={(e) => setConfirmEmail(e.target.value)} placeholder={email} aria-label="Confirm your email" />
          {msg && <Banner tone="bad">{msg}</Banner>}
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Page
export default function SettingsPage(props) {
  const { settings, onSave, onClose, userId } = props;
  const [form, setForm] = useState(settings);
  const [tab, setTab] = useState("general");
  const [status, setStatus] = useState("idle"); // idle | saving | saved | failed
  const errors = useMemo(() => validateSettings(form), [form]);
  const dirty = useMemo(() => dirtyTabs(settings, form), [settings, form]);
  const bad = useMemo(() => errorTabs(errors), [errors]);
  const errCount = Object.keys(errors).length;
  const isDirty = dirty.size > 0;
  const set = (patch) => { setStatus("idle"); setForm((f) => ({ ...f, ...patch })); };

  useEffect(() => {
    if (!isDirty) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [isDirty]);

  const save = async () => {
    if (errCount) return;
    setStatus("saving");
    const ok = await onSave(form);
    setStatus(ok ? "saved" : "failed");
  };
  const close = () => { if (isDirty && !window.confirm("You have unsaved changes. Leave without saving?")) return; onClose(); };
  const common = { form, set, errors };

  return (
    <div style={{ ...S.page, paddingBottom: 110 }}>
      <div style={{ ...S.row, justifyContent: "space-between" }}>
        <div><h2 style={S.h2}>Settings</h2><p style={S.sub}>Studio and account preferences.</p></div>
        <Btn onClick={close}>Close</Btn>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={TABS.map(([id, label]) => ({ id, label, badge: bad.has(id) ? "!" : dirty.has(id) ? "\u2022" : "" }))} />
      {tab === "general" && <GeneralTab {...common} />}
      {tab === "crm" && <CrmTab {...common} reasonDefaults={props.reasonDefaults} />}
      {tab === "production" && <ProductionTab {...common} pipelineLibrary={props.pipelineLibrary} />}
      {tab === "teams" && <TeamsTab {...common} />}
      {tab === "finance" && <FinanceTab {...common} userId={userId} onPrivacy={props.onPrivacy} />}
      {tab === "alerts" && <AlertsTab {...common} periodOptions={props.periodOptions} onEnableNotifications={props.onEnableNotifications} hiddenCount={form.dashboardHiddenChannels.length} />}
      {tab === "account" && <AccountTab settings={settings} email={props.email} drive={props.drive} patreon={props.patreon} links={props.links}
        onReplayTutorial={props.onReplayTutorial} onOpenSupport={props.onOpenSupport} onExport={props.onExport} onSignOut={props.onSignOut} onAccountAction={props.onAccountAction} />}

      <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 20, background: "rgba(14,20,22,0.96)", borderTop: `1px solid ${T.border}`, backdropFilter: "blur(8px)" }}>
        <div style={{ maxWidth: 1180, margin: "0 auto", padding: "12px 28px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13.5, color: errCount ? T.bad : status === "failed" ? T.bad : isDirty ? T.warn : T.muted }}>
            {errCount ? `Fix ${errCount} issue${errCount === 1 ? "" : "s"} (${[...bad].map((t) => TAB_LABEL[t]).join(", ")}) before saving.`
              : status === "failed" ? "Couldn't save. Your changes are still here; try again."
              : status === "saving" ? "Saving..."
              : status === "saved" && !isDirty ? "Saved."
              : isDirty ? `Unsaved changes in ${[...dirty].map((t) => TAB_LABEL[t]).join(", ")}.` : "All changes saved."}
          </span>
          <span style={S.row}>
            <Btn disabled={!isDirty || status === "saving"} onClick={() => { setForm(settings); setStatus("idle"); }}>Discard</Btn>
            <Btn kind="primary" disabled={!isDirty || !!errCount || status === "saving"} onClick={save}>{status === "saving" ? "Saving..." : "Save changes"}</Btn>
          </span>
        </div>
      </div>
    </div>
  );
}
