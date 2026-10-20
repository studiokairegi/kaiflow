import React, { useEffect, useState } from "react";
import { S, T, Btn, Pill, Banner, Modal, useBusy } from "../finance/ui.jsx";
import { mergeProviders, offeredToClients } from "./providers.js";
import * as api from "./api.js";

// Payment Providers: Wise first and clearly primary; future providers shown as Coming Soon.
// This screen only manages configuration. It never calls a provider.
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
        <div style={{ marginTop: 10 }}><Pill tone="muted">Coming Soon</Pill></div>
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

function ManageDialog({ provider, onClose, onChanged }) {
  const { busy, error, run } = useBusy();
  const toggle = () => run(async () => { await api.setProviderEnabled(provider.id, !provider.enabled); await onChanged(); });
  const makePrimary = () => run(async () => { await api.setPrimaryProvider(provider.id); await onChanged(); });
  return (
    <Modal title={`${provider.name}${provider.subtitle ? ` · ${provider.subtitle}` : ""}`} onClose={onClose} width={520} footer={<Btn onClick={onClose}>Close</Btn>}>
      {error && <Banner tone="bad">{error}</Banner>}
      <Banner tone="info">
        The {provider.name} connection is not available yet. Credentials will be added as server secrets when the integration is built; they are never entered or stored in the browser.
        Until {provider.name} is connected, it is <strong>not shown to clients</strong> at checkout, even though it is enabled.
      </Banner>
      <div style={S.row}>
        <Btn small disabled={busy} onClick={toggle}>{provider.enabled ? "Disable" : "Enable"}</Btn>
        <Btn small disabled={busy || !provider.enabled || provider.primary} onClick={makePrimary}>{provider.primary ? "Primary provider" : "Make primary"}</Btn>
        <Btn small disabled title="Available when the integration is implemented">Connect (soon)</Btn>
      </div>
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
      {error && <Banner tone="warn" action={<Btn small onClick={load} disabled={busy}>Retry</Btn>}>Couldn't load saved provider settings ({error}). Showing defaults, read-only. If this is the first run, apply the 20261021090000 migration.</Banner>}
      <div style={S.grid(240)}>
        {providers.map((p) => <ProviderCard key={p.id} p={p} onManage={error ? () => {} : setManaging} />)}
      </div>
      <div style={S.card}>
        <h3 style={S.h3}>What clients see</h3>
        {offered.length === 0
          ? <p style={S.sub}>No payment method is live yet, so a payment link would show “online payment isn’t available for this invoice”. Wise appears here, as the primary option, once it is connected.</p>
          : <p style={S.sub}>Offered at checkout, in order: {offered.map((p) => p.name).join(", ")}.</p>}
        <p style={S.sub}>Payment links look like <code>/pay/&#123;secure-token&#125;</code>. The token is random and unguessable; invoice IDs are never in the link.</p>
      </div>
      {current && <ManageDialog provider={current} onClose={() => setManaging(null)} onChanged={load} />}
    </>
  );
}
