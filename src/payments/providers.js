// Provider catalogue for the UI (pure; no network). The database (payment_providers) holds each
// admin's configuration; this file holds the static facts and the fallback when nothing is stored.
// Adding a provider later = one entry here + one PaymentProvider adapter on the server.

export const PROVIDER_CATALOG = [
  { id: "wise", name: "Wise", subtitle: "Embedded Solutions", available: true },
  { id: "paystack", name: "Paystack", subtitle: "", available: false },
  { id: "paypal", name: "PayPal", subtitle: "", available: false },
  { id: "payoneer", name: "Payoneer", subtitle: "", available: false },
  { id: "mpesa", name: "M-Pesa", subtitle: "", available: false },
];

// Merge stored rows onto the catalogue. A missing row falls back to the intended defaults
// (Wise enabled + primary but not connected; everything else Coming Soon), so the screen is
// meaningful even before the migration or first load.
export function mergeProviders(rows = []) {
  const byId = new Map((rows || []).map((r) => [r.provider, r]));
  return PROVIDER_CATALOG.map((c) => {
    const r = byId.get(c.id);
    if (!c.available) return { ...c, status: "coming_soon", enabled: false, primary: false, connected: false };
    return {
      ...c,
      status: r?.status || "not_connected",
      enabled: r ? !!r.is_enabled : true,
      primary: r ? !!r.is_primary : c.id === "wise",
      connected: r?.status === "connected",
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
