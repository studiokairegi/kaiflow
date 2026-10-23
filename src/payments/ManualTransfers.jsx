import React, { useEffect, useState } from "react";
import { S, T, Btn, Pill, Banner, Field, Table, useBusy, fmtDate } from "../finance/ui.jsx";
import { formatMoney } from "../finance/currency.js";
import { validateWiseSettings } from "./wise.js";
import * as api from "./api.js";

// Admin: Wise / M-PESA recipient settings. Shown inside Payments > Providers. Non-secret values only.
// Wise is offered to clients only when enabled AND complete; the server decides, this form gives early feedback.
export function WiseManualSettings({ row, onChanged }) {
  const saved = row?.settings?.manual || {};
  const [f, setF] = useState({ enabled: !!saved.enabled, recipient_name: saved.recipient_name || "", country: saved.country || "Kenya", mobile_provider: saved.mobile_provider || "M-PESA", calling_code: saved.calling_code || "+254", phone: saved.phone || "", instructions: saved.instructions || "", support_contact: saved.support_contact || "" });
  const { busy, error, run } = useBusy();
  const [done, setDone] = useState(false);
  const v = validateWiseSettings(f);
  const set = (k) => (e) => { setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }); setDone(false); };
  const save = () => run(async () => { await api.setWiseManual(f); setDone(true); await onChanged?.(); });
  const incomplete = !v.complete;
  return (
    <div style={S.card}>
      <div style={{ ...S.row, justifyContent: "space-between" }}>
        <h3 style={{ ...S.h3, margin: 0 }}>Wise · International transfer to M-PESA</h3>
        <Pill tone={saved.enabled && saved.complete ? "ok" : "muted"}>{saved.enabled && saved.complete ? "Offered to clients" : "Not offered"}</Pill>
      </div>
      <p style={S.sub}>Manual option shown last at checkout. Clients send money with Wise to the recipient below and submit their transfer reference; nothing is marked paid until you verify the funds under “Wise transfers”.</p>
      {saved.enabled && !saved.complete && <Banner tone="warn">Wise is enabled but the recipient details are incomplete, so clients do not see it.</Banner>}
      {error && <Banner tone="bad">{error}</Banner>}
      <label style={{ display: "block", marginBottom: 10 }}><input type="checkbox" checked={f.enabled} onChange={set("enabled")} /> Offer Wise at checkout</label>
      <Field label="Recipient full name" hint={v.errors.recipient_name || "As registered on the M-PESA account."}><input style={S.input} value={f.recipient_name} onChange={set("recipient_name")} /></Field>
      <Field label="Recipient country" hint={v.errors.country || ""}><input style={S.input} value={f.country} onChange={set("country")} /></Field>
      <Field label="Mobile provider" hint={v.errors.mobile_provider || ""}><input style={S.input} value={f.mobile_provider} onChange={set("mobile_provider")} /></Field>
      <div style={S.row}>
        <Field label="Country code" hint={v.errors.calling_code || ""}><input style={{ ...S.input, width: 90 }} value={f.calling_code} onChange={set("calling_code")} /></Field>
        <Field label="M-PESA number" hint={v.errors.phone || (v.normalizedPhone ? `Will be saved as ${v.normalizedPhone}` : "")}><input style={S.input} inputMode="tel" value={f.phone} onChange={set("phone")} /></Field>
      </div>
      <Field label="Additional instructions (optional)"><textarea style={{ ...S.input, minHeight: 60 }} maxLength={1000} value={f.instructions} onChange={set("instructions")} /></Field>
      <Field label="Support contact (optional)"><input style={S.input} maxLength={200} value={f.support_contact} onChange={set("support_contact")} placeholder="Email or phone clients can reach" /></Field>
      <Btn kind="primary" disabled={busy || (f.enabled && incomplete)} onClick={save}>{busy ? "Saving…" : done ? "Saved" : "Save Wise settings"}</Btn>
      {f.enabled && incomplete && <span style={{ ...S.sub, marginLeft: 10 }}>Complete every required field to enable.</span>}
    </div>
  );
}

const STATUS_TONE = { pending: "muted", submitted: "warn", verified: "ok", rejected: "bad", cancelled: "muted" };

// Admin: queue of Wise transfers. "Verify" is only for money that has actually arrived; it records the invoice payment
// through the same settlement path as Paystack (and books any FX difference). The client cannot reach this RPC.
export function ManualTransfersTab({ onChanged }) {
  const [rows, setRows] = useState(null);
  const [active, setActive] = useState(null);
  const [form, setForm] = useState({ credited: "", received: "", receivedCurrency: "KES", note: "" });
  const { busy, error, run } = useBusy();
  const load = () => run(async () => setRows(await api.loadManualPayments()));
  useEffect(() => { load(); }, []);
  const decide = (decision) => run(async () => {
    await api.reviewManualPayment(active.id, decision, { credited: form.credited ? Number(form.credited) : null, received: form.received ? Number(form.received) : null, receivedCurrency: form.receivedCurrency, note: form.note });
    setActive(null); await load(); await onChanged?.();
  });
  return (
    <>
      <div><h2 style={S.h2}>Wise transfers</h2><p style={S.sub}>Verify a transfer only after the money is in the M-PESA wallet. A client’s reference or note is evidence, not proof.</p></div>
      {error && <Banner tone="bad">{error}</Banner>}
      <Table rowKey={(r) => r.id} empty="No Wise transfers yet." rows={rows || []} columns={[
        { key: "d", label: "Started", render: (r) => fmtDate(r.created_at) },
        { key: "r", label: "Our reference", render: (r) => r.reference },
        { key: "a", label: "Expected", num: true, render: (r) => formatMoney(r.currency, r.amount) },
        { key: "t", label: "Client’s Wise reference", render: (r) => r.transfer_reference || "-" },
        { key: "s", label: "Status", render: (r) => <Pill tone={STATUS_TONE[r.status] || "muted"}>{r.status}</Pill> },
        { key: "x", label: "", render: (r) => (r.status === "submitted" ? <Btn small onClick={() => { setActive(r); setForm({ credited: String(r.amount), received: "", receivedCurrency: "KES", note: "" }); }}>Review</Btn> : null) },
      ]} />
      {active && (
        <div style={S.card}>
          <h3 style={S.h3}>Review {active.reference}</h3>
          <p style={S.sub}>Client says Wise reference <strong>{active.transfer_reference}</strong>{active.payer_name ? ` from ${active.payer_name}` : ""}. Expected {formatMoney(active.currency, active.amount)}.</p>
          <div style={S.row}>
            <Field label={`Credit to invoice (${active.currency})`}><input style={S.input} inputMode="decimal" value={form.credited} onChange={(e) => setForm({ ...form, credited: e.target.value })} /></Field>
            <Field label="Amount that arrived"><input style={S.input} inputMode="decimal" value={form.received} onChange={(e) => setForm({ ...form, received: e.target.value })} placeholder="e.g. KES received" /></Field>
            <Field label="Currency that arrived"><input style={{ ...S.input, width: 90 }} value={form.receivedCurrency} onChange={(e) => setForm({ ...form, receivedCurrency: e.target.value.toUpperCase() })} /></Field>
          </div>
          <Field label="Note (optional)"><input style={S.input} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
          <div style={S.row}>
            <Btn kind="primary" disabled={busy || !form.received} onClick={() => decide("verify")}>Funds arrived · Verify</Btn>
            <Btn disabled={busy} onClick={() => decide("reject")}>Reject</Btn>
            <Btn kind="link" onClick={() => setActive(null)}>Cancel</Btn>
          </div>
        </div>
      )}
    </>
  );
}
