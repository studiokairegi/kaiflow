import React, { useState } from "react";
import { Button, Field } from "../shared/kit.jsx";
import { addDaysISO, todayISO } from "../shared/format.js";

export function useRange(days = 30) { const [r, setR] = useState({ from: addDaysISO(todayISO(), -days), to: todayISO() }); return /** @type {[{ from: string, to: string }, (v: { from: string, to: string }) => void]} */ ([r, setR]); }
export function RangeBar({ range = undefined, onChange = undefined, currency = undefined, onCurrency = undefined, single = undefined }) {
  const bad = range.from && range.to && range.from > range.to;
  return (<div className="row" role="group" aria-label="Filters" style={{ alignItems: "flex-end" }}>
    {!single && <Field label="From"><input type="date" value={range.from} onChange={(e) => onChange({ ...range, from: e.target.value })} /></Field>}
    <Field label={single ? "As of" : "To"} error={bad ? "From is after To." : null}><input type="date" value={range.to} onChange={(e) => onChange({ ...range, to: e.target.value })} /></Field>
    {onCurrency && <Field label="Currency" hint="Blank = base currency"><input value={currency || ""} maxLength={3} onChange={(e) => onCurrency(e.target.value.toUpperCase())} style={{ width: 90 }} /></Field>}</div>);
}
export const validRange = (r) => !!r.from && !!r.to && r.from <= r.to;
export const ccyArg = (c) => (c && c.length === 3 ? c : null);
