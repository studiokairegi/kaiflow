// Client-facing document languages. The language belongs to the INVOICE (what the client receives)
// and is copied onto each payment link when it is created, so a link keeps the language it was sent in.
// The studio's own admin UI is not translated.
export const DOC_LANGUAGES = [
  { code: "en", label: "English", native: "English", locale: "en-US" },
  { code: "ja", label: "Japanese", native: "日本語", locale: "ja-JP" },
];

export const DEFAULT_DOC_LANGUAGE = "en";

const CODES = new Set(DOC_LANGUAGES.map((l) => l.code));

// Anything unknown (null, "JA", "ja-JP", a typo) falls back safely instead of breaking a page.
export function normalizeLang(value) {
  const m = /^([a-z]{2})(?:[-_][a-z0-9]+)*$/i.exec(String(value ?? "").trim());   // "ja", "JA", "ja-JP", "ja_JP"
  const v = m ? m[1].toLowerCase() : "";
  return CODES.has(v) ? v : DEFAULT_DOC_LANGUAGE;
}

export const isJapanese = (value) => normalizeLang(value) === "ja";
export const localeFor = (value) => DOC_LANGUAGES.find((l) => l.code === normalizeLang(value)).locale;
export const languageLabel = (value) => {
  const l = DOC_LANGUAGES.find((x) => x.code === normalizeLang(value));
  return l.code === "en" ? l.label : `${l.label} (${l.native})`;
};

// "Keep the client on the language they were last sent": the newest invoice of a project decides the default
// for the next one. `invoices` is the project's invoice list in creation order.
export function defaultLanguageFor(invoices = []) {
  for (let i = invoices.length - 1; i >= 0; i--) {
    if (invoices[i]?.language) return normalizeLang(invoices[i].language);
  }
  return DEFAULT_DOC_LANGUAGE;
}

// Replaces {name} placeholders. Missing values stay visible as {name} so a bad call is obvious in review, never silent.
export function interpolate(template, vars = {}) {
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
}

export function makeTranslator(dictionaries, lang) {
  const l = normalizeLang(lang);
  const raw = (key) => dictionaries[l]?.[key] ?? dictionaries.en[key];
  const t = (key, vars) => {
    const r = raw(key);
    return r === undefined ? key : interpolate(r, vars);
  };
  t.raw = (key) => raw(key) ?? key;     // un-interpolated template, for strings that embed React nodes (<strong>, links)
  t.lang = l;
  return t;
}

// ISO "2026-11-15" -> "2026年11月15日" for Japanese; English keeps the stored ISO text exactly as before.
export function formatDocDate(iso, lang) {
  const s = String(iso ?? "").trim();
  if (!s) return "-";
  if (normalizeLang(lang) !== "ja") return s;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日` : s;
}
