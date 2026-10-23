import React, { useEffect, useState } from "react";
import { S, T, Btn, Pill, Banner, Modal, useBusy } from "../finance/ui.jsx";
import { mergeProviders, offeredToClients, COMING_SOON_LABEL } from "./providers.js";
import * as api from "./api.js";

// Payment Providers: Paystack is the default; PayPal and Payoneer are shown greyed out as "Coming soon — not configured".
// This screen manages configuration; the only provider call is the server-side connection check.
function ProviderCard({ p, onManage }) {
  const soon = !p.available;
  return (
    <div style={{ ...S.card, opacity: soon ? 0.55 : 1, borderColor: p.primary ? `${T.accentText}88` : undefined, minWidth: 240 }} aria-disabled={soon}>
      <div style={{ ...S.row, justifyContent: "space-between" }}>
        <h3 style={{ ...S.h3, margin: 0 }}>{p.name}</h3>
        {p.primary && <Pill tone="info">★ Primary</Pill>}
      </div>
      {p.subtitle && <span style={S.sub}>{p.subtitle}</span>}
      {soon ? (
        <div style={{ marginTop: 10 }}><Pill tone="muted">{COMING_SOON_LABEL}</Pill></div>
      ) : (
        <>
          <div style={{ ...S.row, marginTop: 10 }}>
            <Pill tone={p.enabled ? "ok" : "muted"}>{p.enabled ? "✓ Enabled" : "Disabled"}</Pill>
            <Pill tone={p.connected ? "ok" : "warn"}>{p.connected ? "Connected" : "Not connected"}</Pill>
          </div>
          <div style={{ marginTop: 12 }}><Btn small onClick={() => onManage(p)}>Manage</Btn></div>
        </>
      )}
    </div>
  );
}

const CHANNEL_LABELS = { card: "Card", bank_transfer: "Bank transfer", apple_pay: "Apple Pay" };
const CURRENCIES = ["KES", "USD", "NGN", "GHS", "ZAR"];

function ManageDialog({ provider, row, onClose, onChanged }) {
  const { busy, error, run } = useBusy();
  const [status, setStatus] = useState(null);
  const [channels, setChannels] = useState(() => new Set(row?.settings?.channels || ["card"]));
  const [currencies, setCurrencies] = useState(() => new Set(row?.settings?.currencies || ["KES"]));
  const [saved, setSaved] = useState(false);
  useEffect(() => { api.getPaystackStatus().then(setStatus).catch(() => setStatus({ ok: false, message: "Could not read the server configuration." })); }, []);
  const toggle = () => run(async () => { await api.setProviderEnabled(provider.id, !provider.enabled); await onChanged(); });
  const makePrimary = () => run(async () => { await api.setPrimaryProvider(provider.id); await onChanged(); });
  const connect = () => run(async () => { await api.connectPaystack(); setStatus(await api.getPaystackStatus()); await onChanged(); });
  const flip = (set, setter, v) => { const n = new Set(set); n.has(v) ? n.delete(v) : n.add(v); setter(n); setSaved(false); };
  const saveOptions = () => run(async () => { await api.setPaystackOptions([...channels], [...currencies]); setSaved(true); await onChanged(); });
  const env = status?.environment;
  return (
    <Modal title={`${provider.name}${provider.subtitle ? ` · ${provider.subtitle}` : ""}`} onClose={onClose} width={560} footer={<Btn onClick={onClose}>Close</Btn>}>
      {error && <Banner tone="bad">{error}</Banner>}
      {status && (status.ok && env === "live"
        ? <Banner tone="ok">Paystack Live is configured. Client payment links use real Paystack checkout; sandbox transactions remain historical and are excluded from production reporting.</Banner>
        : <Banner tone="bad">{status.ok ? "Production Payments requires Paystack Live mode." : status.message}</Banner>)}
      <div style={S.row}>
        <Pill tone={provider.enabled ? "ok" : "muted"}>{provider.enabled ? "✓ Enabled" : "Disabled"}</Pill>
        <Pill tone={provider.connected ? "ok" : "warn"}>{provider.connected ? `Connected${row?.environment && row.environment !== "none" ? ` (${row.environment === "sandbox" ? "test" : "live"})` : ""}` : "Not connected"}</Pill>
      </div>
      <p style={S.sub}>The live secret key is a server secret and is never entered or stored in the browser. “Connect” verifies the configured Paystack Live key against Paystack.</p>
      <div style={S.row}>
        <Btn small kind="primary" disabled={busy || !status?.ok || status?.environment !== "live"} onClick={connect}>{provider.connected ? "Re-check connection" : "Connect"}</Btn>
        <Btn small disabled={busy} onClick={toggle}>{provider.enabled ? "Disable" : "Enable"}</Btn>
        <Btn small disabled={busy || !provider.enabled || provider.primary} onClick={makePrimary}>{provider.primary ? "Default provider" : "Make default"}</Btn>
      </div>
      {provider.connected && (
        <>
          <h4 style={{ ...S.h3, marginTop: 16 }}>Enabled on your Paystack account</h4>
          <p style={S.sub}>Enable only payment methods and currencies that are actually active on your Paystack merchant account. Apple Pay must first be activated in Paystack Dashboard; it is then shown here as an available checkout channel.</p>
          <div style={S.row}>{Object.entries(CHANNEL_LABELS).map(([k, l]) => <label key={k}><input type="checkbox" checked={channels.has(k)} onChange={() => flip(channels, setChannels, k)} /> {l}</label>)}</div>
          <div style={{ ...S.row, marginTop: 8 }}>{CURRENCIES.map((c) => <label key={c}><input type="checkbox" checked={currencies.has(c)} onChange={() => flip(currencies, setCurrencies, c)} /> {c}</label>)}</div>
          <div style={{ marginTop: 10 }}><Btn small disabled={busy || !channels.size || !currencies.size} onClick={saveOptions}>{saved ? "Saved" : "Save channels and currencies"}</Btn></div>
        </>
      )}
    </Modal>
  );
}

export default function ProvidersTab() {
  const [rows, setRows] = useState(null);
  const [managing, setManaging] = useState(null);
  const { busy, error, run } = useBusy();
  const load = () => run(async () => { setRows(await api.listProviders()); });
  useEffect(() => { load(); }, []);
  const providers = mergeProviders(rows || []);
  const offered = providers.filter(offeredToClients);
  const current = managing && providers.find((p) => p.id === managing.id);
  return (
    <>
      <div><h2 style={S.h2}>Payment providers</h2><p style={S.sub}>Clients pay through a StudioKairegi checkout page. The methods they see come from the providers below; the invoice and finance screens never depend on which provider was used.</p></div>
      {error && <Banner tone="warn" action={<Btn small onClick={load} disabled={busy}>Retry</Btn>}>Couldn't load saved provider settings ({error}). Showing defaults, read-only. If this is the first run, apply the 20261021090000 and 20261025090000 migrations.</Banner>}
      <div style={S.grid(240)}>
        {providers.map((p) => <ProviderCard key={p.id} p={p} onManage={error ? () => {} : setManaging} />)}
      </div>
      <div style={S.card}>
        <h3 style={S.h3}>What clients see</h3>
        {offered.length === 0
          ? <p style={S.sub}>No payment method is live yet, so a payment link would show “online payment isn’t available for this invoice”. Connect Paystack above to turn on card and bank transfer.</p>
          : <p style={S.sub}>Offered at checkout, in order: {offered.map((p) => p.name).join(", ")}.</p>}
        <p style={S.sub}>Payment links look like <code>/pay/&#123;secure-token&#125;</code>. The token is random and unguessable; invoice IDs are never in the link.</p>
      </div>
      {current && <ManageDialog provider={current} row={(rows || []).find((r) => r.provider === current.id)} onClose={() => setManaging(null)} onChanged={load} />}
    </>
  );
}
