import React, { useCallback, useEffect, useRef, useState } from "react";
import { S, T } from "../finance/ui.jsx";

export const Input = ({ style, ...p }) => <input {...p} style={{ ...S.input, ...style }} />;
export const TextArea = ({ style, rows = 4, ...p }) => <textarea rows={rows} {...p} style={{ ...S.input, resize: "vertical", lineHeight: 1.5, ...style }} />;
export const Select = ({ options, style, ...p }) => (
  <select {...p} style={{ ...S.input, ...style }}>
    {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
  </select>
);

/** Loads data once, then quietly refreshes when deps change (no spinner flicker on refresh). */
export function useLoad(fn, deps) {
  const [state, setState] = useState({ data: null, error: "", loading: true });
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const data = await fn();
      if (mine === seq.current) setState({ data, error: "", loading: false });
    } catch (e) {
      if (mine === seq.current) setState((s) => ({ ...s, error: e?.message || "Could not load", loading: false }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { reload(); }, [reload]);
  return { ...state, reload };
}

export const Muted = ({ children, style }) => <p style={{ ...S.sub, ...style }}>{children}</p>;
export const Section = ({ title, hint, action, children }) => (
  <div style={S.card}>
    <div style={{ ...S.row, justifyContent: "space-between" }}>
      <div><h3 style={S.h3}>{title}</h3>{hint && <p style={S.sub}>{hint}</p>}</div>
      {action}
    </div>
    {children}
  </div>
);
export const Kpi = ({ label, value, sub, tone }) => (
  <div style={{ ...S.card, gap: 4, borderLeft: `3px solid ${tone === "bad" ? T.bad : tone === "warn" ? T.warn : T.ok}` }}>
    <span style={S.sub}>{label}</span>
    <span style={{ fontSize: 24, fontWeight: 800 }}>{value}</span>
    {sub && <span style={S.sub}>{sub}</span>}
  </div>
);
export const confirmAction = (msg) => (typeof window === "undefined" ? true : window.confirm(msg));
