import React from "react";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Legend,
} from "recharts";

const PALETTE = [
  "#2FBFA6",
  "#4A90D9",
  "#F2A65A",
  "#7FE0D0",
  "#E07A5F",
  "#9B8AD8",
  "#3DDC84",
  "#FF8FA3",
  "#5C6B70",
  "#D9C24A",
];

const ink = "#14191c";
const inkSoft = "#1c2327";
const paper = "#EDEAE3";
const border = "#2a3338";
const textMuted = "#8b9a98";

function ChartTooltip({ active, payload, label, currencySymbol }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div
      style={{
        background: inkSoft,
        border: `1px solid ${border}`,
        borderRadius: 10,
        padding: "8px 12px",
        fontSize: 12,
        color: paper,
        fontFamily: "'Inter', sans-serif",
      }}
    >
      {label && <div style={{ color: textMuted, marginBottom: 4 }}>{label}</div>}
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color || p.fill }}>
          {p.name}: {currencySymbol || ""}
          {typeof p.value === "number" ? p.value.toLocaleString() : p.value}
        </div>
      ))}
    </div>
  );
}

export function DonutBreakdown({ data, emptyLabel = "Nothing here yet" }) {
  const filtered = data.filter((d) => d.value > 0);
  if (filtered.length === 0) {
    return <p style={{ color: textMuted, fontSize: 13, margin: 0 }}>{emptyLabel}</p>;
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
      <div style={{ width: 160, height: 160, flexShrink: 0 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={filtered}
              dataKey="value"
              nameKey="label"
              innerRadius={45}
              outerRadius={72}
              paddingAngle={2}
              stroke="none"
            >
              {filtered.map((entry, i) => (
                <Cell key={entry.label} fill={PALETTE[i % PALETTE.length]} />
              ))}
            </Pie>
            <Tooltip content={<ChartTooltip />} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 140 }}>
        {filtered.map((entry, i) => (
          <div key={entry.label} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: "50%",
                background: PALETTE[i % PALETTE.length],
                flexShrink: 0,
              }}
            />
            <span style={{ color: paper, textTransform: "capitalize" }}>{entry.label}</span>
            <span style={{ color: textMuted, marginLeft: "auto" }}>{entry.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function RevenueTrendChart({ data, currencySymbol = "$" }) {
  const hasData = data.some((d) => d.value > 0);
  return (
    <div style={{ width: "100%", height: 200 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
          <defs>
            <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#2FBFA6" stopOpacity={0.45} />
              <stop offset="100%" stopColor="#2FBFA6" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={border} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" stroke={textMuted} fontSize={11} tickLine={false} axisLine={{ stroke: border }} />
          <YAxis stroke={textMuted} fontSize={11} tickLine={false} axisLine={false} width={40} />
          <Tooltip content={<ChartTooltip currencySymbol={currencySymbol} />} />
          <Area
            type="monotone"
            dataKey="value"
            name="Revenue"
            stroke="#2FBFA6"
            strokeWidth={2}
            fill="url(#revenueFill)"
          />
        </AreaChart>
      </ResponsiveContainer>
      {!hasData && (
        <p style={{ color: textMuted, fontSize: 12, marginTop: -8 }}>
          No paid invoices yet, this fills in as revenue comes through.
        </p>
      )}
    </div>
  );
}
