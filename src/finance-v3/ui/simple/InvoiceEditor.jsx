// Create or edit a DRAFT invoice. Totals shown here are only a preview of the lines typed; the saved invoice's totals come from the database.
import React, { useRef, useState } from "react";
import { Banner, Button, Dialog, Field, Async, useBusy, useFinance, useResource } from "../shared/kit.jsx";
import { friendlyError } from "../shared/errors.js";
import { addDaysISO, newKey, parseMoneyInput, todayISO } from "../shared/format.js";

const blank = () => ({ description: "", quantity: "1", unit_price: "", tax_rate: "" });
export default function InvoiceEditor({ invoice = undefined, onClose = undefined, onSaved = undefined }) {
  const { api, org } = useFinance();
  const res = useResource(async () => ({ clients: await api.listContacts(org, "client"), settings: await api.getOrgSettings(org).catch(() => null) }), []);
  return (<Dialog title={invoice ? `Edit ${invoice.invoice_no || "draft"}` : "Create an invoice"} wide onClose={onClose}>
    <Async res={res}>{({ clients, settings }) => <Form {...{ invoice, clients, settings, onClose, onSaved, api, org }} />}</Async></Dialog>);
}
function Form({ invoice = undefined, clients = undefined, settings = undefined, onClose = undefined, onSaved = undefined, api = undefined, org = undefined }) {
  const key = useRef(newKey("inv"));
  const [clientId, setClientId] = useState(invoice?.client?.id || "");
  const [currency, setCurrency] = useState(invoice?.currency || settings?.base_currency || "KES");
  const [issue, setIssue] = useState(invoice?.issue_date || todayISO()); const [terms, setTerms] = useState(String(invoice?.payment_terms_days ?? 14));
  const [notes, setNotes] = useState(invoice?.notes || "");
  const [lines, setLines] = useState(invoice?.lines?.length ? invoice.lines.map((l) => ({ description: l.description, quantity: l.quantity, unit_price: l.unit_price, tax_rate: l.tax_rate === "0" ? "" : l.tax_rate })) : [blank()]);
  const [errs, setErrs] = useState([]); const [fail, setFail] = useState(null); const [busy, wrap] = useBusy();
  const setLine = (i, k, v) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  async function save() {
    setFail(null); const e = [];
    if (!clientId) e.push("Choose a client.");
    const out = lines.map((l, i) => {
      const q = parseMoneyInput(l.quantity, { maxDecimals: 4 }), p = parseMoneyInput(l.unit_price, { allowZero: true });
      const t = l.tax_rate.trim() === "" ? { ok: true, value: "0" } : parseMoneyInput(l.tax_rate, { allowZero: true });
      if (!l.description.trim()) e.push(`Line ${i + 1}: say what it is for.`);
      if (!q.ok) e.push(`Line ${i + 1} quantity: ${q.error}`); if (!p.ok) e.push(`Line ${i + 1} price: ${p.error}`); if (!t.ok) e.push(`Line ${i + 1} tax: ${t.error}`);
      return { description: l.description.trim(), quantity: q.value, unit_price: p.value, tax_rate: t.value };
    });
    const tn = Number(terms); if (!Number.isInteger(tn) || tn < 0 || tn > 365) e.push("Payment terms must be a whole number of days (0 to 365).");
    setErrs(e); if (e.length) return;
    await wrap(async () => { try {
      const inv = await api.saveInvoiceDraft(org, key.current, { invoiceId: invoice?.id, clientId, currency, issueDate: issue, dueDate: addDaysISO(issue, tn), termsDays: tn, notes: notes || null, lines: out });
      onSaved?.(inv); } catch (x) { setFail(x); } });
  }
  return (<div className="stack">
    <p className="sub">This saves a draft. Nothing is sent and the client sees nothing until you approve, issue and send it.</p>
    <div className="grid">
      <Field label="Client"><select value={clientId} onChange={(e) => setClientId(e.target.value)} data-autofocus><option value="">Choose…</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
      <Field label="Currency"><input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))} disabled={!!invoice} /></Field>
      <Field label="Invoice date"><input type="date" value={issue} onChange={(e) => setIssue(e.target.value)} /></Field>
      <Field label="Days to pay"><input inputMode="numeric" value={terms} onChange={(e) => setTerms(e.target.value)} /></Field></div>
    <h3>What you are charging for</h3>
    {lines.map((l, i) => (<div key={i} className="grid" role="group" aria-label={`Line ${i + 1}`}>
      <Field label="Description"><input value={l.description} onChange={(e) => setLine(i, "description", e.target.value)} /></Field>
      <Field label="Quantity"><input inputMode="decimal" value={l.quantity} onChange={(e) => setLine(i, "quantity", e.target.value)} /></Field>
      <Field label="Price each"><input inputMode="decimal" value={l.unit_price} onChange={(e) => setLine(i, "unit_price", e.target.value)} /></Field>
      <Field label="Tax % (optional)"><input inputMode="decimal" value={l.tax_rate} onChange={(e) => setLine(i, "tax_rate", e.target.value)} /></Field>
      {lines.length > 1 && <Button small kind="ghost" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label={`Remove line ${i + 1}`}>Remove line</Button>}</div>))}
    <div><Button small onClick={() => setLines((ls) => [...ls, blank()])}>Add a line</Button></div>
    <Field label="Note for the client (optional)"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
    {errs.length > 0 && <Banner tone="critical" title="Please fix these first:">{errs.join(" ")}</Banner>}
    {fail && <Banner tone="critical" title="The draft could not be saved.">{friendlyError(fail)}</Banner>}
    <div className="row" style={{ justifyContent: "flex-end" }}><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind="primary" busy={busy} onClick={save}>Save draft</Button></div></div>);
}
