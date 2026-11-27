// CSV writer for Finance exports (RFC 4180) with spreadsheet-formula protection.
// A cell that a spreadsheet would run as a formula (starts with = + - @ tab or CR, after any leading spaces) is written with a leading
// apostrophe so it displays as text. Plain numbers, including negative amounts such as -12.50, are left alone so they stay numbers.
const NUMBER = /^-?\d+(\.\d+)?$/;
const FORMULA = /^[\s]*[=+\-@\t\r]/;

export function neutraliseCell(value) {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
  if (NUMBER.test(s)) return s;
  return FORMULA.test(s) ? `'${s}` : s;
}

export function csvEscape(value) {
  const s = neutraliseCell(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// columns: string[]; rows: unknown[][]. Returns text ending in CRLF. A byte-order mark is added so Excel reads UTF-8 correctly.
export function toCsv(columns, rows, { bom = true } = {}) {
  if (!Array.isArray(columns) || !Array.isArray(rows)) throw new TypeError("toCsv needs columns and rows");
  const lines = [columns.map(csvEscape).join(",")];
  for (const r of rows) lines.push((Array.isArray(r) ? r : []).map(csvEscape).join(","));
  return (bom ? "﻿" : "") + lines.join("\r\n") + "\r\n";
}

export function exportFileName(kind, orgLabel, from, to, today = new Date()) {
  const safe = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  const parts = ["finance", safe(kind), safe(orgLabel), from && to ? `${from}_${to}` : today.toISOString().slice(0, 10)].filter(Boolean);
  return parts.join("-") + ".csv";
}
