// Small shared helpers for the Inbox screen.
export const newKey = () => `kf-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
export const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");
export const initialsOf = (text) => {
  const t = String(text || "").trim();
  if (!t || t.startsWith("(")) return "?";
  return t.replace(/<.*>/, "").split(/[\s@._,-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
};
