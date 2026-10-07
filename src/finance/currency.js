// Currency helpers for Finance. Currencies are identified by ISO CODE everywhere
// in this module - never by symbol ("$" is not a currency: it can be USD, CAD, AUD...).
// The rest of the app stores symbols (legacy); symbolToCode/codeToSymbol bridge that.

export const FINANCE_CURRENCIES = [
  { code: "USD", symbol: "$", decimals: 2, name: "US Dollar" },
  { code: "EUR", symbol: "\u20ac", decimals: 2, name: "Euro" },
  { code: "GBP", symbol: "\u00a3", decimals: 2, name: "British Pound" },
  { code: "JPY", symbol: "\u00a5", decimals: 0, name: "Japanese Yen" },
  { code: "KES", symbol: "KSh", decimals: 2, name: "Kenyan Shilling" },
];

const BY_CODE = Object.fromEntries(FINANCE_CURRENCIES.map((c) => [c.code, c]));
const BY_SYMBOL = Object.fromEntries(FINANCE_CURRENCIES.map((c) => [c.symbol, c.code]));

export function symbolToCode(symbolOrCode) {
  if (!symbolOrCode) return "USD";
  if (BY_SYMBOL[symbolOrCode]) return BY_SYMBOL[symbolOrCode];
  if (/^[A-Za-z]{3}$/.test(symbolOrCode)) return symbolOrCode.toUpperCase();
  return "USD";
}

export function codeToSymbol(code) {
  return BY_CODE[code]?.symbol || code;
}

export function decimalsFor(code) {
  return BY_CODE[code]?.decimals ?? 2;
}

// Round to the currency's minor unit. Avoids float drift when summing.
export function roundMoney(n, code = "USD") {
  const d = decimalsFor(code);
  const f = 10 ** d;
  return Math.round((Number(n) || 0) * f + Number.EPSILON * Math.sign(n || 0)) / f;
}

export const r2 = (n) => Math.round((Number(n) || 0) * 100 + Number.EPSILON * Math.sign(n || 0)) / 100;

// "KSh 1,250.00", "\u20ac1,000.00", "\u00a55,000". Always states the currency: symbol for known
// single-symbol currencies, "KSh " prefix for multi-letter ones.
export function formatMoney(code, amount, { signed = false } = {}) {
  const n = Number(amount) || 0;
  const d = decimalsFor(code);
  const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const sym = codeToSymbol(code);
  const prefix = sym.length > 1 ? `${sym} ` : sym;
  const sign = n < 0 ? "-" : signed && n > 0 ? "+" : "";
  return `${sign}${prefix}${abs}`;
}

// {USD: 1250, EUR: 480} -> "$1,250.00 \u00b7 \u20ac480.00" (never summed across currencies)
export function formatTotalsByCurrency(totals, { hideZero = true } = {}) {
  const parts = Object.entries(totals || {})
    .filter(([, v]) => !hideZero || Math.abs(v) > 0.004)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, v]) => formatMoney(code, v));
  return parts.length ? parts.join(" \u00b7 ") : "-";
}

// Converts a native amount using a rate that was STORED WITH THE TRANSACTION.
// Returns null (not the unconverted amount) when there is no rate.
export function toBase(amount, rate) {
  if (rate === null || rate === undefined || !(Number(rate) > 0)) return null;
  return r2(Number(amount) * Number(rate));
}

export const MASK = "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";

// Privacy mode: when on, the DISPLAYED STRING is replaced - the number never reaches the DOM.
export function displayMoney(code, amount, privacy) {
  return privacy ? MASK : formatMoney(code, amount);
}

// Today's date in the user's own timezone as YYYY-MM-DD (UTC would be a day off for part of every day).
export function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
