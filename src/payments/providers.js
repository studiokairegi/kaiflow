// Provider catalogue for the UI (pure; no network). The database (payment_providers) holds each
// admin's configuration; this file holds the static facts and the fallback when nothing is stored.
// Adding a provider later = one entry here + one PaymentProvider adapter on the server.

// Paystack is the only implemented provider and the default. PayPal and Payoneer stay visible but
// disabled ("Coming soon — not configured"); Wise and M-Pesa are placeholders with no integration code.
export const PROVIDER_CATALOG = [
  { id: "paystack", name: "Paystack", subtitle: "Card, bank transfer and Apple Pay", available: true },
  { id: "paypal", name: "PayPal", subtitle: "", available: false },
  { id: "payoneer", name: "Payoneer", subtitle: "", available: false },
  { id: "wise", name: "Wise", subtitle: "Embedded Solutions", available: false },
  { id: "mpesa", name: "M-Pesa", subtitle: "", available: false },
];

export const COMING_SOON_LABEL = "Coming soon — not configured";

// Merge stored rows onto the catalogue. A missing row falls back to the intended defaults
// (Paystack enabled + primary but not connected until the server key is confirmed; everything
// else Coming Soon), so the screen is meaningful even before the migration or first load.
export function mergeProviders(rows = []) {
  const byId = new Map((rows || []).map((r) => [r.provider, r]));
  return PROVIDER_CATALOG.map((c) => {
    const r = byId.get(c.id);
    if (!c.available) return { ...c, status: "coming_soon", enabled: false, primary: false, connected: false };
    return {
      ...c,
      status: r?.status || "not_connected",
      enabled: r ? !!r.is_enabled && r.environment === "live" : true,
      primary: r ? !!r.is_primary && r.environment === "live" : c.id === "paystack",
      connected: r?.status === "connected" && r.environment === "live",
    };
  });
}

// "Offered to clients" mirrors the server rule: enabled AND connected (and implemented in code).
export const offeredToClients = (p) => p.available && p.enabled && p.connected;

export const checkoutUrl = (token, origin) => `${String(origin || "").replace(/\/+$/, "")}/pay/${token}`;

// The public token is 64 lowercase hex chars (244 random bits). Anything else is rejected before any request.
export const isCheckoutToken = (s) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);

// /pay/{token} -> token, or null. Query strings and trailing slashes are tolerated.
export function tokenFromPath(pathname) {
  const m = /^\/pay\/([^/?#]+)\/?$/.exec(String(pathname || ""));
  return m ? m[1] : null;
}

// /pay/{token} -> checkout page; /pay/{token}/return -> the page Paystack sends the client back to.
// The return page proves nothing by itself: it asks the server to verify with Paystack.
export function parsePayPath(pathname) {
  const m = /^\/pay\/([^/?#]+)(\/return)?\/?$/.exec(String(pathname || ""));
  return m ? { token: m[1], view: m[2] ? "return" : "checkout" } : null;
}
