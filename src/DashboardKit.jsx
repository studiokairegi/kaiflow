import React from "react";

// Dashboard building blocks. Icons follow studiokairegi.com: thin (1.6-1.8) rounded strokes in the
// brand teal, 24x24 grid, no fills. Everything here is presentational.
const TEAL = "#4DC4D8";
const PATHS = {
  folder: <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />,
  target: <><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" /></>,
  film: <><rect x="2" y="2" width="20" height="20" rx="3" /><line x1="7" y1="2" x2="7" y2="22" /><line x1="17" y1="2" x2="17" y2="22" /><line x1="2" y1="12" x2="22" y2="12" /></>,
  check: <><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></>,
  x: <><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></>,
  trend: <><polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /><polyline points="17 6 23 6 23 12" /></>,
  invoice: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></>,
  users: <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>,
  calendar: <><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></>,
  percent: <><line x1="19" y1="5" x2="5" y2="19" /><circle cx="6.5" cy="6.5" r="2.5" /><circle cx="17.5" cy="17.5" r="2.5" /></>,
  card: <><rect x="1" y="4" width="22" height="16" rx="2" /><line x1="1" y1="10" x2="23" y2="10" /></>,
  clock: <><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></>,
  undo: <><polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></>,
  send: <><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></>,
  zap: <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />,
  alert: <><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></>,
  inbox: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></>,
  layers: <><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" /></>,
  wallet: <><path d="M20 12V8H6a2 2 0 0 1 0-4h12v4" /><path d="M4 6v12a2 2 0 0 0 2 2h14v-4" /><path d="M18 12a2 2 0 0 0 0 4h4v-4z" /></>,
};

export function Icon({ name, size = 14, stroke = 1.7, color = TEAL }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      {PATHS[name]}
    </svg>
  );
}

const S = {
  card: { display: "flex", flexDirection: "column", gap: 10, padding: "12px 14px", borderRadius: 14, border: "1px solid #2a3338", background: "linear-gradient(180deg, #1e272b 0%, #1a2125 100%)", minWidth: 0 },
  head: { display: "flex", alignItems: "center", gap: 8 },
  badgeIcon: { width: 24, height: 24, borderRadius: 8, border: "1px solid rgba(77,196,216,0.28)", background: "rgba(77,196,216,0.08)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  title: { fontFamily: "'Nunito', 'Space Grotesk', sans-serif", fontSize: 12.5, fontWeight: 700, color: "#EDEAE3", letterSpacing: "0.01em" },
  pill: { marginLeft: "auto", fontSize: 9.5, fontWeight: 700, letterSpacing: "0.06em", color: "#F2A65A", border: "1px solid rgba(242,166,90,0.4)", background: "rgba(242,166,90,0.1)", borderRadius: 999, padding: "1px 7px" },
  value: { fontFamily: "'Nunito', 'Space Grotesk', sans-serif", fontSize: 24, fontWeight: 800, color: "#EDEAE3", lineHeight: 1.1 },
  label: { fontSize: 11, color: "#8b9a98" },
  chips: { display: "flex", flexWrap: "wrap", gap: 6 },
  chip: { display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 8px 3px 6px", borderRadius: 999, border: "1px solid rgba(77,196,216,0.16)", background: "rgba(255,255,255,0.02)", fontFamily: "inherit", color: "#EDEAE3", fontSize: 11.5, lineHeight: 1.3, maxWidth: "100%" },
};

export function Chip({ icon, value, label, tone, dim, onClick }) {
  const color = tone === "good" ? "#3DDC84" : tone === "bad" ? "#FF6B6B" : tone === "warn" ? "#F2A65A" : "#EDEAE3";
  const inner = (
    <>
      <Icon name={icon} size={13} color={tone === "bad" ? "#FF6B6B" : tone === "warn" ? "#F2A65A" : TEAL} />
      <strong style={{ fontWeight: 700, color, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</strong>
      <span style={{ color: "#8b9a98", fontSize: 10.5, whiteSpace: "nowrap" }}>{label}</span>
    </>
  );
  const common = { ...S.chip, opacity: dim ? 0.5 : 1, cursor: onClick ? "pointer" : "default" };
  const title = `${label}: ${value}`;
  return onClick
    ? <button type="button" title={title} onClick={onClick} style={{ ...common, background: "rgba(255,255,255,0.02)" }}>{inner}</button>
    : <span title={title} style={common}>{inner}</span>;
}

// One compact card: a headline figure plus small icon chips for the related numbers.
export function StatGroup({ title, icon, badge, value, label, delta, chips = [], onClick }) {
  return (
    <div className="kf-card" style={{ ...S.card, cursor: onClick ? "pointer" : "default" }} onClick={onClick}>
      <div style={S.head}>
        <span style={S.badgeIcon}><Icon name={icon} size={14} /></span>
        <span style={S.title}>{title}</span>
        {badge && <span style={S.pill}>{badge}</span>}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={S.value}>{value}</span>
        <span style={S.label}>{label}</span>
        {delta !== undefined && delta !== null && (
          <span style={{ fontSize: 11, fontWeight: 700, color: delta >= 0 ? "#3DDC84" : "#FF6B6B" }}>{delta >= 0 ? "▲" : "▼"} {Math.abs(delta)}%</span>
        )}
      </div>
      <div style={S.chips} onClick={(e) => e.stopPropagation()}>
        {chips.map((c) => <Chip key={c.label} {...c} />)}
      </div>
    </div>
  );
}
