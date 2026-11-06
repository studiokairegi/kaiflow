import React, { useState } from "react";
import { S, Banner, Btn, Field, useBusy } from "../../finance/ui.jsx";
import { Input, Section } from "../../intelligence/kit.jsx";
import { emailApi } from "../lib/api.js";

export default function SetupAccount({ supabase, onDone }) {
  const [address, setAddress] = useState("");
  const [name, setName] = useState("Studio Kairegi");
  const { busy, error, run } = useBusy();
  return (
    <Section title="Add your sending address" hint="This must be an address on a domain you verified in Resend. Replies to it arrive in this inbox once the Resend receiving records are set up.">
      {error && <Banner tone="bad">{error}</Banner>}
      <div style={S.grid(240)}>
        <Field label="Address"><Input type="email" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="name@yourdomain.com" /></Field>
        <Field label="Display name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      </div>
      <div><Btn kind="primary" disabled={busy || !address.trim()} onClick={() => run(async () => { await emailApi.addAccount(supabase, address, name); await onDone(); })}>Save address</Btn></div>
    </Section>
  );
}
