// Pay Now link for invoice PDFs. The PDF is generated in the browser (jsPDF, downloadInvoicePDF in App.jsx),
// so the link is created through the existing admin RPC (payments_create_checkout_session) at generation time.
// Only a hash of the token is stored, so an earlier link cannot be fetched back: each generated PDF gets its own
// link, valid for the usual 14 days, for the invoice's outstanding balance. If a link cannot be created the PDF is
// produced WITHOUT a button. A URL is never invented.
import { checkoutUrl, isCheckoutToken } from "./providers.js";

export const PAYABLE_DOC_TYPES = new Set(["invoice", "proforma"]);

export function payLinkEligible(invoice, balance) {
  const type = invoice?.docType || "invoice";
  return PAYABLE_DOC_TYPES.has(type) && !!invoice?.id && Number(balance) > 0.005;
}

// A link is accepted only if it has exactly the /pay/{64-hex token} shape on an https origin (http for localhost dev).
export function isValidPayUrl(url) {
  try {
    const u = new URL(url);
    const okProto = u.protocol === "https:" || (u.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(u.hostname));
    const m = /^\/pay\/([0-9a-f]{64})$/.exec(u.pathname);
    return okProto && !!m && isCheckoutToken(m[1]) && !u.search && !u.hash;
  } catch { return false; }
}

// create = (invoiceId, amountOrNull, days) => Promise<{token}>, i.e. api.createCheckoutSession.
export async function requestPayLink(invoice, balance, { create, origin, days = 14 }) {
  if (!payLinkEligible(invoice, balance)) return { ok: false, reason: "not_payable" };
  try {
    const r = await create(invoice.id, null, days);
    if (!r?.token || !isCheckoutToken(r.token)) return { ok: false, reason: "no_token" };
    const url = checkoutUrl(r.token, origin);
    if (!isValidPayUrl(url)) return { ok: false, reason: "bad_url" };
    return { ok: true, url, expiresAt: r.expires_at || null };
  } catch (e) {
    return { ok: false, reason: "create_failed", message: e?.message || "" };
  }
}

// Draws a real, clickable button: a filled rounded rectangle + label + a PDF link annotation over the same rectangle.
// `doc` is a jsPDF instance (units: mm). Returns the y just below the button.
export function drawPayNowButton(doc, url, { x, y, w = 46, h = 11, brand = { ink: [17, 22, 27], accent: [47, 191, 166] }, label = "Pay Now" } = {}) {
  if (!isValidPayUrl(url)) return y;
  doc.setFillColor(...brand.ink);
  doc.roundedRect(x, y, w, h, 2.5, 2.5, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(11);
  doc.text(label, x + w / 2, y + h / 2 + 1.4, { align: "center" });
  doc.setFillColor(...brand.accent);
  doc.rect(x + 3, y + h - 1.6, w - 6, 0.7, "F");
  doc.link(x, y, w, h, { url });
  return y + h;
}
