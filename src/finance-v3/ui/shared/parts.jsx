// Small shared pieces used by both modes: money display, status pills, the action dialog with protection/override handling.
import React, { useMemo, useRef, useState } from "react";
import { Banner, Button, Dialog, Field, Pill, useBusy, useFinance } from "./kit.jsx";
import { fmtMoney, isNegative, label, newKey, parseMoneyInput, INVOICE_STATUS, EMAIL_STATUS, EMAIL_STATUS_HELP, PAYMENT_VERIFICATION } from "./format.js";
import { friendlyError, isProtectionBlock } from "./errors.js";

export function Money({ value = undefined, currency = undefined }) { return <span style={{ fontVariantNumeric: "tabular-nums", color: isNegative(value) ? "var(--bad)" : undefined }}>{fmtMoney(value, currency)}</span>; }

const INV_TONE = { draft: "", approved: "info", issued: "warn", partially_paid: "warn", paid: "ok", credited: "info", void: "bad" };
export const InvoiceStatusPill = ({ invoice }) => invoice.is_overdue && ["issued", "partially_paid"].includes(invoice.status)
  ? <Pill tone="bad">Overdue {invoice.days_overdue ? `by ${invoice.days_overdue} day${invoice.days_overdue === 1 ? "" : "s"}` : ""}</Pill>
  : <Pill tone={INV_TONE[invoice.status]}>{label(INVOICE_STATUS, invoice.status)}</Pill>;
const EMAIL_TONE = { queued: "info", sending: "info", sent: "info", delivered: "ok", bounced: "bad", failed: "bad" };
export const EmailStatusPill = ({ status }) => <Pill tone={EMAIL_TONE[status]} title={EMAIL_STATUS_HELP[status]}>{label(EMAIL_STATUS, status)}</Pill>;
export const VerificationPill = ({ status }) => <Pill tone={status === "verified" ? "ok" : status === "rejected" ? "bad" : "warn"}>{label(PAYMENT_VERIFICATION, status)}</Pill>;

export function Hint({ children = undefined }) { return <p className="sub">{children}</p>; }

// Generic form dialog. fields: [{name,label,type:'text'|'money'|'date'|'select'|'textarea'|'number',options:[{value,label}],required,hint,default}]
// onSubmit(values, override|null) must call the API. A protection block (V3007) is explained in plain words and, only for people holding
// finance.override, offers a reason box and a second, explicit "go ahead anyway" action. Everyone else just sees the explanation.
export function ActionDialog({ title = undefined, intro = undefined, fields = undefined, confirmText = "Confirm", onSubmit = undefined, onClose = undefined, onDone = undefined, warning = undefined, summary = undefined }) {
  const { can, toast } = useFinance();
  const key = useRef(newKey("ui"));
  const initial = useMemo(() => Object.fromEntries(fields.map((f) => [f.name, f.default ?? ""])), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [v, setV] = useState(initial); const [errs, setErrs] = useState({}); const [fail, setFail] = useState(null);
  const [reason, setReason] = useState(""); const [busy, wrap] = useBusy();
  const set = (n, x) => setV((o) => ({ ...o, [n]: x }));
  function validate() {
    const e = {}; const out = {};
    for (const f of fields) {
      const raw = typeof v[f.name] === "string" ? v[f.name].trim() : v[f.name];
      if (f.type === "money") { const r = parseMoneyInput(raw, { allowZero: !!f.allowZero }); if (!r.ok) e[f.name] = r.error; else out[f.name] = r.value; }
      else if (f.required && (raw === "" || raw == null)) e[f.name] = "This is needed.";
      else out[f.name] = raw === "" ? null : raw;
    }
    setErrs(e); return Object.keys(e).length ? null : out;
  }
  const submit = (override) => wrap(async () => {
    setFail(null); const vals = validate(); if (!vals) return;
    try { const res = await onSubmit(vals, override ? { reason: reason.trim() } : null, key.current); toast?.(`${title}: done.`); onDone?.(res); onClose(); }
    catch (err) { setFail(err); }
  });
  const blocked = fail && isProtectionBlock(fail);
  return (<Dialog title={title} onClose={onClose} footer={<>
      <Button kind="ghost" onClick={onClose}>Cancel</Button>
      {blocked && can("finance.override") && <Button kind="danger" busy={busy} disabled={reason.trim().length < 10} onClick={() => submit(true)}>Go ahead anyway</Button>}
      {!blocked && <Button kind="primary" busy={busy} onClick={() => submit(false)}>{confirmText}</Button>}</>}>
    {intro && <Hint>{intro}</Hint>}
    {warning && <Banner tone="warning">{warning}</Banner>}
    <form className="stack" onSubmit={(e) => { e.preventDefault(); if (!blocked) submit(false); }} noValidate>
      {fields.map((f, i) => (<Field key={f.name} label={f.label + (f.required || f.type === "money" ? "" : " (optional)")} hint={f.hint} error={errs[f.name]}>
        {f.type === "select" ? <select value={v[f.name]} onChange={(e) => set(f.name, e.target.value)} data-autofocus={i === 0 || undefined}><option value="">Choose…</option>{(f.options || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
          : f.type === "textarea" ? <textarea value={v[f.name]} onChange={(e) => set(f.name, e.target.value)} data-autofocus={i === 0 || undefined} />
          : <input type={f.type === "date" ? "date" : "text"} inputMode={f.type === "money" ? "decimal" : undefined} value={v[f.name]} onChange={(e) => set(f.name, e.target.value)} data-autofocus={i === 0 || undefined} autoComplete="off" />}
      </Field>))}
      <button type="submit" className="sr" tabIndex={-1}>Submit</button>
    </form>
    {summary && <Hint>{summary(v)}</Hint>}
    {fail && !blocked && <Banner tone="critical" title="That did not go through.">{friendlyError(fail)}</Banner>}
    {blocked && <Banner tone="warning" title="Safe-to-spend protection stopped this.">{friendlyError(fail)}</Banner>}
    {blocked && can("finance.override") && <Field label="Reason for going ahead anyway" hint="At least 10 characters. This is recorded in the audit history."><textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
    {blocked && !can("finance.override") && <Hint>Only an owner or finance admin can override this. Ask them, or reduce the amount.</Hint>}
  </Dialog>);
}
