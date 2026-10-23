// Pure helpers for the checkout quote. The AUTHORITATIVE quote is made by the database
// (payments_quote_create); nothing here decides what is charged. These helpers (a) format what the
// server returned, unambiguously, and (b) mirror the server's decimal maths so tests can pin it down.
// Money is handled as integer minor units / BigInt, never floating point.

const ZERO_DECIMAL = new Set(["JPY", "KRW", "UGX", "RWF"]);
export const ccyDecimals = (code) => (ZERO_DECIMAL.has(String(code || "").toUpperCase()) ? 0 : 2);

// "1234.5" -> { n: 12345n, scale: 1 }. Rejects anything that is not a plain non-negative decimal.
export function parseDecimal(value) {
  const s = String(value ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("Invalid decimal amount.");
  const [i, f = ""] = s.split(".");
  return { n: BigInt(i + f), scale: f.length };
}

// round(amount * rate, decimals(chargeCurrency)), half away from zero, exactly like Postgres numeric.
// `rate` = units of charge currency per 1 unit of invoice currency.
export function convertAmount(amount, rate, chargeCurrency) {
  const a = parseDecimal(amount);
  const r = parseDecimal(rate);
  if (a.n === 0n || r.n === 0n) throw new Error("Amount and rate must be greater than zero.");
  const scale = a.scale + r.scale;
  const target = ccyDecimals(chargeCurrency);
  let p = a.n * r.n;                              // value = p / 10^scale
  if (scale > target) {
    const div = 10n ** BigInt(scale - target);
    p = (p + div / 2n) / div;                     // positive values only, so +half then truncate = half-up
  } else if (scale < target) {
    p = p * 10n ** BigInt(target - scale);
  }
  return minorToString(p, target);
}

export function minorToString(minor, decimals) {
  const s = BigInt(minor).toString().padStart(decimals + 1, "0");
  return decimals ? `${s.slice(0, -decimals)}.${s.slice(-decimals)}` : s;
}

export const toMinorUnits = (amount, code) => {
  const d = ccyDecimals(code);
  const a = parseDecimal(amount);
  if (a.scale > d) throw new Error(`Too many decimal places for ${code}.`);
  return a.n * 10n ** BigInt(d - a.scale);
};

// "1 JPY = 0.8512 KES" - the direction is spelled out, never implied.
export function describeRate(base, quote, rate) {
  const r = parseDecimal(rate);
  const raw = minorToString(r.n, r.scale);
  const [i, f = ""] = raw.split(".");
  const keep = Number(i) >= 1 ? 4 : Math.max(4, (f.match(/^0*/)?.[0].length || 0) + 4);
  const shown = f ? `${i}.${f.slice(0, keep).replace(/0+$/, "").padEnd(Math.min(4, keep), "0")}` : i;
  return `1 ${base} = ${shown} ${quote}`;
}

export const quoteSecondsLeft = (q, now = Date.now()) => (q?.expires_at ? Math.max(0, Math.floor((new Date(q.expires_at).getTime() - now) / 1000)) : 0);
export const quoteIsLive = (q, now = Date.now()) => !!q && quoteSecondsLeft(q, now) > 0;

// Codes the Edge Function returns when the client must be shown a fresh price and confirm again.
export const REQUOTE_CODES = new Set(["quote_expired", "quote_superseded", "quote_invalid", "quote_used", "quote_required"]);
export const needsRequote = (code) => REQUOTE_CODES.has(code);
