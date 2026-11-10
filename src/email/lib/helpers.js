// Small shared helpers for the Inbox screen.
export const newKey = () => `kf-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
export const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");
export const initialsOf = (text) => {
  const t = String(text || "").trim();
  if (!t || t.startsWith("(")) return "?";
  return t.replace(/<.*>/, "").split(/[\s@._,-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
};

/** Rotate only after the server has confirmed a terminal provider rejection/failure.
 * Network errors, pre-send refusals and ambiguous outcomes retain the logical send key. */
export const shouldRotateSendKey = (error) =>
  Boolean(error && ["rejected", "failed"].includes(error.outcome) && error.retry_with_same_key === false);
