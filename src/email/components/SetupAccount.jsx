import React, { useMemo, useState } from "react";
import { S, Banner, Btn, Field, useBusy } from "../../finance/ui.jsx";
import { Input, Section } from "../../intelligence/kit.jsx";
import { emailApi } from "../lib/api.js";
import { availableMailProviders } from "../lib/logic.js";

export default function SetupAccount({ supabase, providers = [], providersLoading = false, providersError = "", onRetry, onCancel, onDone }) {
  const choices = useMemo(() => providersError ? [] : availableMailProviders(providers), [providers, providersError]);
  const [providerKey, setProviderKey] = useState(choices[0]?.provider_key || "");
  const selected = choices.find((p) => p.provider_key === providerKey) || choices[0] || null;
  const [address, setAddress] = useState("");
  const [name, setName] = useState("Studio Kairegi");
  const { busy, error, run } = useBusy();
  const needsOAuth = selected?.capabilities?.oauth === true;
  const canConfigureAddress = Boolean(selected && !needsOAuth);

  return (
    <Section title="Add an email account" hint="Choose from the providers currently enabled for KairFlow Email. Only capabilities implemented by the selected provider are offered.">
      {(providersError || error) && <Banner tone="bad" action={providersError && onRetry ? <Btn small onClick={onRetry}>Retry</Btn> : null}>{providersError || error}</Banner>}
      {providersLoading && <p style={S.sub}>Loading available email providers…</p>}
      {!providersLoading && !providersError && !choices.length && <Banner tone="warn">No mailbox providers are currently enabled. Ask an administrator to enable a provider after its adapter and connection flow are ready.</Banner>}
      {choices.length > 0 && <>
        {choices.length > 1 && <Field label="Provider">
          <select value={selected?.provider_key || ""} onChange={(e) => setProviderKey(e.target.value)}>
            {choices.map((p) => <option key={p.provider_key} value={p.provider_key}>{p.display_name}</option>)}
          </select>
        </Field>}
        <p style={S.sub}>{selected?.display_name}: {needsOAuth ? "This provider requires an OAuth connection flow that is not available in this frontend release." : "Add a verified sending address. Sending and inbound delivery are available only where configured for this provider."}</p>
        {canConfigureAddress && <>
          <div style={S.grid(240)}>
            <Field label="Email address"><Input type="email" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="name@yourdomain.com" autoComplete="email" /></Field>
            <Field label="Display name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
          </div>
          <div><Btn kind="primary" disabled={busy || Boolean(providersError) || !address.trim() || !selected} onClick={() => run(async () => { await emailApi.addAccount(supabase, address, name, selected.provider_key); await onDone?.(); })}>{busy ? "Saving…" : "Add account"}</Btn>{onCancel && <Btn style={{ marginLeft: 8 }} disabled={busy} onClick={onCancel}>Cancel</Btn>}</div>
        </>}
      </>}
    </Section>
  );
}
