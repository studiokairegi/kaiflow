import React, { useState } from "react";
import { displayMoney, formatTotalsByCurrency, MASK } from "./currency.js";
import { formatIsoDate } from "../settings/runtime.js";
import { GRADIENTS } from "../DashboardKit.jsx";

// Dates are stored as YYYY-MM-DD; shown in the format chosen in Settings > General.
export const fmtDate = (iso) => (iso ? formatIsoDate(iso) : iso);

// Finance and Payments share the dashboard's look: dark rounded panels, gradient accents,
// pill buttons and Nunito headings (see DashboardKit.jsx).
export const T = {
  text: "#EDEAE3", muted: "#8b9a98", faint: "#5d6c6a", border: "#2a3338", rule: "rgba(255,255,255,0.06)",
  surface: "#1c2327", raised: "rgba(255,255,255,0.03)", accent: "#38B6FF", accentText: "#7CCBFF",
  ok: "#34D8A0", warn: "#F2A65A", bad: "#FF6B6B", info: "#77A1FF",
};
// Gradient + matching icon-tile colour for the dashboard-style KPI cards (same pairs the dashboard uses).
export const CARD_TONES = {
  sky: { gradient: GRADIENTS.sky, icon: "#2B9BE0" },
  mint: { gradient: GRADIENTS.mint, icon: "#1FB886" },
  violet: { gradient: GRADIENTS.violet, icon: "#6A47F2" },
  royal: { gradient: GRADIENTS.royal, icon: "#3B74F4" },
};
const fontHead = "'Nunito', 'Space Grotesk', sans-serif";

export const S = {
  page: { display: "flex", flexDirection: "column", gap: 18, padding: "0 28px 48px", maxWidth: 1180, width: "100%", margin: "0 auto", boxSizing: "border-box", color: T.text },
  card: { border: `1px solid ${T.border}`, background: T.surface, borderRadius: 22, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12, minWidth: 0 },
  h2: { fontFamily: fontHead, fontSize: 20, fontWeight: 800, margin: 0, letterSpacing: "-0.01em" },
  h3: { fontFamily: fontHead, fontSize: 15, fontWeight: 800, margin: 0, textTransform: "none", letterSpacing: "-0.01em" },
  sub: { fontSize: 12.5, color: T.muted, margin: 0, lineHeight: 1.5 },
  label: { fontSize: 11, letterSpacing: "0.04em", textTransform: "uppercase", color: T.muted },
  input: { background: "rgba(0,0,0,0.25)", border: `1px solid ${T.border}`, borderRadius: 12, color: T.text, padding: "8px 12px", fontSize: 13.5, width: "100%", boxSizing: "border-box", fontFamily: "inherit" },
  row: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" },
  grid: (min) => ({ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`, gap: 12 }),
  th: { textAlign: "left", fontSize: 11, letterSpacing: "0.04em", textTransform: "uppercase", color: T.muted, fontWeight: 600, padding: "8px 10px", borderBottom: `1px solid ${T.border}`, whiteSpace: "nowrap" },
  td: { padding: "9px 10px", fontSize: 13.5, borderBottom: `1px solid ${T.rule}`, verticalAlign: "top" },
  num: { textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" },
};

export function Btn({ kind = "default", small, children, style, ...p }) {
  const base = { cursor: p.disabled ? "not-allowed" : "pointer", opacity: p.disabled ? 0.5 : 1, borderRadius: 999, fontSize: small ? 12 : 13.5, fontWeight: 600, padding: small ? "5px 12px" : "8px 18px", fontFamily: "inherit", border: `1px solid ${T.border}`, background: "transparent", color: T.text };
  const kinds = {
    primary: { background: GRADIENTS.sky, border: "none", color: "#fff", fontWeight: 700, boxShadow: "0 4px 12px rgba(56,182,255,0.28)" },
    danger: { color: T.bad, borderColor: "rgba(255,107,107,0.4)" },
    link: { border: "none", background: "none", color: T.accentText, padding: small ? "2px 4px" : "4px 6px" },
  };
  return <button type="button" {...p} style={{ ...base, ...(kinds[kind] || {}), ...style }}>{children}</button>;
}

const PILL = { ok: T.ok, warn: T.warn, bad: T.bad, info: T.info, muted: T.muted };
export function Pill({ tone = "muted", children }) {
  const c = PILL[tone] || T.muted;
  return <span style={{ fontSize: 11.5, fontWeight: 500, color: c, border: `1px solid ${c}55`, background: `${c}14`, borderRadius: 999, padding: "2px 9px", whiteSpace: "nowrap" }}>{children}</span>;
}

export function Banner({ tone = "warn", children, action }) {
  const c = PILL[tone] || T.warn;
  return (
    <div role={tone === "bad" ? "alert" : "status"} style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", border: `1px solid ${c}55`, background: `${c}12`, borderRadius: 14, padding: "10px 16px", fontSize: 13.5, lineHeight: 1.5 }}>
      <span>{children}</span>{action}
    </div>
  );
}

export function Field({ label, hint, children }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <label style={S.label}>{label}</label>{children}
      {hint && <span style={{ fontSize: 12, color: T.muted }}>{hint}</span>}
    </div>
  );
}

export function Modal({ title, onClose, children, width = 520, footer }) {
  return (
    <div role="dialog" aria-modal="true" aria-label={title} onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "6vh 16px", overflowY: "auto" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 22, width: "100%", maxWidth: width, padding: 22, boxShadow: "0 18px 48px rgba(0,0,0,0.45)", display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ ...S.row, justifyContent: "space-between" }}><h2 style={S.h2}>{title}</h2><Btn kind="link" onClick={onClose} aria-label="Close">Close</Btn></div>
        {children}
        {footer && <div style={{ ...S.row, justifyContent: "flex-end" }}>{footer}</div>}
      </div>
    </div>
  );
}

// columns: [{key, label, num?, render?(row)}]
export function Table({ columns, rows, empty = "Nothing here yet.", rowKey, onRow }) {
  if (!rows.length) return <div style={{ color: T.muted, fontSize: 13.5, padding: "14px 4px" }}>{empty}</div>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr>{columns.map((c) => <th key={c.key} style={{ ...S.th, ...(c.num ? S.num : {}) }}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={rowKey ? rowKey(r) : i} onClick={onRow ? () => onRow(r) : undefined} style={{ cursor: onRow ? "pointer" : "default" }}>
              {columns.map((c) => <td key={c.key} style={{ ...S.td, ...(c.num ? S.num : {}) }}>{c.render ? c.render(r) : r[c.key]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Privacy-aware amounts. When privacy is on the number is never rendered.
export function Money({ code, amount, privacy, signed, tone }) {
  const color = tone === "auto" ? (amount < 0 ? T.bad : T.text) : undefined;
  return <span style={{ fontVariantNumeric: "tabular-nums", color }} data-private={privacy ? "1" : undefined}>{privacy ? MASK : displayMoney(code, signed ? amount : amount, false)}</span>;
}
export function Totals({ totals, privacy }) {
  return <span style={{ fontVariantNumeric: "tabular-nums" }}>{privacy ? MASK : formatTotalsByCurrency(totals)}</span>;
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div role="tablist" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {tabs.map((t) => {
        const on = value === t.id;
        return (
          <button key={t.id} role="tab" aria-selected={on} onClick={() => onChange(t.id)} type="button"
            style={{ border: "none", borderRadius: 999, background: on ? GRADIENTS.sky : "rgba(255,255,255,0.04)", color: on ? "#fff" : T.muted, boxShadow: on ? "0 4px 12px rgba(56,182,255,0.28)" : "none", padding: "7px 15px", fontSize: 13, fontWeight: on ? 700 : 500, cursor: "pointer", fontFamily: "inherit" }}>
            {t.label}{t.badge ? <span style={{ marginLeft: 6, color: on ? "#fff" : T.warn }}>{t.badge}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function useBusy() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (fn) => {
    setBusy(true); setError("");
    try { await fn(); return true; } catch (e) { setError(e?.message || "Something went wrong."); return false; } finally { setBusy(false); }
  };
  return { busy, error, run, setError };
}
