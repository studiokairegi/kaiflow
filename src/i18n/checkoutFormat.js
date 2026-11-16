// Pure, display-only helpers for the Japanese checkout page. Nothing here touches amounts, rates or quote
// timing: they only change how values the server already returned are written out.

// Remaining validity, written the way a Japanese reader expects: 14分41秒 (never 14:41).
// The caller passes the same whole-second figure the existing countdown already uses.
export function formatCountdownJa(totalSeconds) {
  const n = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  if (h > 0) return `${h}時間${m}分${s}秒`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

// "2026年11月15日 12:02（JST）". The instant is never shifted: it is shown in the viewer's own timezone
// (or an explicit IANA zone when one is passed), and the zone is named so the time is unambiguous.
export function formatDateTimeJa(iso, timeZone) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const opts = { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" };
  if (timeZone) opts.timeZone = timeZone;
  const p = Object.fromEntries(new Intl.DateTimeFormat("ja-JP", opts).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}年${Number(p.month)}月${Number(p.day)}日 ${p.hour}:${p.minute}${p.timeZoneName ? `（${p.timeZoneName}）` : ""}`;
}

const CURRENCY_JA = {
  JPY: "日本円（JPY）",
  KES: "ケニア・シリング（KES）",
  USD: "米ドル（USD）",
  EUR: "ユーロ（EUR）",
  GBP: "英ポンド（GBP）",
  NGN: "ナイジェリア・ナイラ（NGN）",
  GHS: "ガーナ・セディ（GHS）",
  ZAR: "南アフリカ・ランド（ZAR）",
};

// Japanese pages name the currency; English pages (and unknown codes) keep the plain ISO code.
export function currencyLabel(code, lang = "en") {
  const c = String(code ?? "").toUpperCase();
  return lang === "ja" && CURRENCY_JA[c] ? CURRENCY_JA[c] : String(code ?? "");
}
