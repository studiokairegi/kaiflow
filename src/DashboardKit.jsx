import React from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

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
  bell: <><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></>,
  chevron: <polyline points="9 18 15 12 9 6" />,
  wallet: <><path d="M20 12V8H6a2 2 0 0 1 0-4h12v4" /><path d="M4 6v12a2 2 0 0 0 2 2h14v-4" /><path d="M18 12a2 2 0 0 0 0 4h4v-4z" /></>,
};

export function Icon({ name, size = 14, stroke = 1.7, color = TEAL }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      {PATHS[name]}
    </svg>
  );
}


// Template palette (Covid-19 admin dashboard): sky blue, mint, violet, royal blue on a soft dark canvas.
export const GRADIENTS = {
  sky: "linear-gradient(135deg, #38B6FF 0%, #9ADCFF 100%)",
  mint: "linear-gradient(135deg, #34D8A0 0%, #6FE8C2 100%)",
  violet: "linear-gradient(135deg, #6A47F2 0%, #9174FB 100%)",
  royal: "linear-gradient(135deg, #3B74F4 0%, #77A1FF 100%)",
};
const SKY = "#38B6FF";
const MINT = "#34D8A0";
const INK = "#EDEAE3";
const MUTED = "#8b9a98";
const PANEL = "#1c2327";
const LINE = "#2a3338";
const FONT = "'Nunito', 'Space Grotesk', sans-serif";

export function PanelTitle({ children, right }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
      <h3 style={{ margin: 0, fontFamily: FONT, fontSize: 15, fontWeight: 800, color: INK, letterSpacing: "-0.01em" }}>{children}</h3>
      {right}
    </div>
  );
}

export function Panel({ children, style, onClick }) {
  return (
    <div onClick={onClick} style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 20, padding: "12px 14px", minWidth: 0, display: "flex", flexDirection: "column", cursor: onClick ? "pointer" : "default", ...style }}>
      {children}
    </div>
  );
}

// Gradient activity card: white icon tile, big number, label, delta pill and small translucent chips.
export function ActivityCard({ gradient, icon, iconColor, title, badge, value, label, delta, chips = [], onClick, spark }) {
  const W = "rgba(255,255,255,0.97)";
  let wave = null;
  if (spark && spark.length > 1 && spark.some((v) => v > 0)) {
    const max = Math.max(...spark, 1);
    const pts = spark.map((v, i) => [(i / (spark.length - 1)) * 120, 30 - (v / max) * 24]);
    const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
    wave = <svg viewBox="0 0 120 34" width="90" height="26" style={{ position: "absolute", right: 14, top: 10, opacity: 0.5 }} aria-hidden="true"><path d={d} fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  }
  return (
    <div onClick={onClick} className="kf-card" style={{ position: "relative", overflow: "hidden", borderRadius: 20, padding: "11px 14px 10px", background: gradient, color: "#fff", cursor: onClick ? "pointer" : "default", display: "flex", flexDirection: "column", gap: 7, minWidth: 0, boxShadow: "0 8px 20px rgba(0,0,0,0.26)" }}>
      <div aria-hidden="true" style={{ position: "absolute", right: -40, top: -50, width: 150, height: 150, borderRadius: "50%", background: "rgba(255,255,255,0.12)" }} />
      <div style={{ display: "flex", alignItems: "center", gap: 10, position: "relative" }}>
        <span style={{ width: 30, height: 30, borderRadius: 10, background: W, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Icon name={icon} size={16} color={iconColor} stroke={1.8} />
        </span>
        <span style={{ fontFamily: FONT, fontWeight: 700, fontSize: 12.5, opacity: 0.95 }}>{title}</span>
        {badge && <span style={{ marginLeft: "auto", fontSize: 9.5, fontWeight: 800, letterSpacing: "0.08em", background: "rgba(255,255,255,0.22)", borderRadius: 999, padding: "2px 8px" }}>{badge}</span>}
      </div>
      {wave}
      <div style={{ position: "relative", display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 23, lineHeight: 1.05, letterSpacing: "-0.02em", overflowWrap: "anywhere" }}>{value}</div>
          <div style={{ fontSize: 11, opacity: 0.9, marginTop: 1 }}>{label}</div>
        </div>
        {delta !== undefined && delta !== null && (
          <span style={{ fontSize: 10.5, fontWeight: 700, background: "rgba(255,255,255,0.22)", borderRadius: 999, padding: "2px 8px" }}>
            {delta >= 0 ? "+" : "-"}{Math.abs(delta)}% {delta >= 0 ? "\u25B2" : "\u25BC"}
          </span>
        )}
      </div>
      {chips.length > 0 && (
        <div style={{ position: "relative", display: "flex", flexWrap: "wrap", gap: 4 }} onClick={(e) => e.stopPropagation()}>
          {chips.map((c) => {
            const inner = (
              <>
                <Icon name={c.icon} size={11} color="#fff" stroke={1.9} />
                <strong style={{ fontWeight: 800 }}>{c.value}</strong>
                <span style={{ opacity: 0.85, fontSize: 9.5 }}>{c.label}</span>
              </>
            );
            const st = { display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 7px", borderRadius: 999, border: "none", background: c.tone === "bad" ? "rgba(120,10,30,0.35)" : "rgba(255,255,255,0.2)", color: "#fff", fontFamily: "inherit", fontSize: 10.5, opacity: c.dim ? 0.6 : 1, cursor: c.onClick ? "pointer" : "default", whiteSpace: "nowrap" };
            const t = `${c.label}: ${c.value}`;
            return c.onClick
              ? <button key={c.label} type="button" title={t} onClick={c.onClick} style={st}>{inner}</button>
              : <span key={c.label} title={t} style={st}>{inner}</span>;
          })}
        </div>
      )}
    </div>
  );
}

export function ProgressRow({ label, value, pct, color = SKY, icon, sub }) {
  const w = Math.max(0, Math.min(100, pct || 0));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: INK, marginBottom: 6 }}>
          <span>{label}{sub && <span style={{ color: MUTED, marginLeft: 6, fontSize: 11 }}>{sub}</span>}</span>
          <strong style={{ fontFamily: FONT }}>{value}</strong>
        </div>
        <div style={{ height: 6, borderRadius: 999, background: "rgba(255,255,255,0.07)", overflow: "hidden" }}>
          <div style={{ width: `${w}%`, height: "100%", borderRadius: 999, background: `linear-gradient(90deg, ${color}, ${color}aa)` }} />
        </div>
      </div>
      {icon && (
        <span style={{ width: 30, height: 30, borderRadius: 10, background: `${color}22`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Icon name={icon} size={15} color={color} />
        </span>
      )}
    </div>
  );
}

// Seven days starting today. `marks` maps YYYY-MM-DD to a count of deadlines.
export function WeekStrip({ days, marks = {}, onPick }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6 }}>
      {days.map((d, i) => {
        const n = marks[d.key] || 0;
        const today = i === 0;
        return (
          <button key={d.key} type="button" onClick={() => onPick?.(d, n)} title={n ? `${n} deadline${n === 1 ? "" : "s"}` : d.key}
            style={{ border: "none", cursor: onPick && n ? "pointer" : "default", fontFamily: "inherit", padding: "7px 0 6px", borderRadius: 14, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, background: today ? GRADIENTS.sky : "rgba(255,255,255,0.03)", color: today ? "#fff" : INK }}>
            <span style={{ fontSize: 10.5, opacity: today ? 0.95 : 0.55 }}>{d.dow}</span>
            <span style={{ fontFamily: FONT, fontWeight: 800, fontSize: 15 }}>{d.day}</span>
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: n ? (today ? "#fff" : SKY) : "transparent" }} />
          </button>
        );
      })}
    </div>
  );
}

function AreaTip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: GRADIENTS.sky, color: "#fff", borderRadius: 12, padding: "6px 10px", fontSize: 12, boxShadow: "0 6px 18px rgba(0,0,0,0.35)" }}>
      <div style={{ fontWeight: 800 }}>{label}</div>
      {payload.map((p) => <div key={p.dataKey}>{p.name}: {p.value}</div>)}
    </div>
  );
}

// Smooth two-series area chart in the template's sky + mint.
export function OutreachArea({ data, a = "Cold Emails", b = "Responded", height = "100%" }) {
  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: -24, bottom: 0 }}>
          <defs>
            <linearGradient id="kdA" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={SKY} stopOpacity={0.5} /><stop offset="100%" stopColor={SKY} stopOpacity={0.02} /></linearGradient>
            <linearGradient id="kdB" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={MINT} stopOpacity={0.4} /><stop offset="100%" stopColor={MINT} stopOpacity={0.02} /></linearGradient>
          </defs>
          <CartesianGrid stroke="rgba(255,255,255,0.06)" strokeDasharray="4 4" vertical={false} />
          <XAxis dataKey="label" stroke={MUTED} fontSize={11} tickLine={false} axisLine={false} />
          <YAxis stroke={MUTED} fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} width={40} />
          <Tooltip content={<AreaTip />} cursor={{ stroke: "rgba(255,255,255,0.15)" }} />
          <Area type="monotone" dataKey={a} stroke={SKY} strokeWidth={2.2} fill="url(#kdA)" />
          <Area type="monotone" dataKey={b} stroke={MINT} strokeWidth={2.2} fill="url(#kdB)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ActionButton({ children, onClick }) {
  return (
    <button type="button" onClick={onClick} style={{ border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 700, color: "#fff", background: GRADIENTS.sky, borderRadius: 12, padding: "6px 14px", whiteSpace: "nowrap" }}>{children}</button>
  );
}
