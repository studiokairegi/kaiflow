// Finance V3 public link handler (invoice view page, PDF download, "Pay now" -> Paystack). The link token is the only credential:
// 256 bits, stored only as a sha256 in the database, resolved server-side. Anything wrong with a token (unknown, expired, revoked, void
// invoice) produces the SAME response, so tokens cannot be probed. The amount charged is always read from the database (live
// outstanding balance or the fixed amount an authorised user chose), never from the request.

import { attachmentFor, type Rpc as ServiceRpc } from "./finance_v3_email_service.ts";
import { initializeCheckout } from "./finance_v3_paystack.ts";
import { renderInvoicePage, renderMessagePage, PAGE_HEADERS } from "./finance_v3_public_page.ts";
import { fromBase64 } from "./finance_v3_pdf.ts";

export type PublicDeps = {
  rpc: ServiceRpc;                                   // service-role RPC (data, error style is handled inside the wrapper below)
  rpcRaw: (name: string, args: Record<string, unknown>) => Promise<{ data: any; error: { message: string; code?: string } | null }>;
  paystack: { ok: true; environment: "test" | "live"; initialize: (body: Record<string, unknown>) => Promise<any> } | { ok: false };
  publicUrl: (req: Request) => string;               // absolute URL of this endpoint (no query)
  sha256Hex: (s: string) => Promise<string>;
  rateLimit?: (key: string) => boolean;              // true = allowed
};

const TOKEN = /^[0-9a-f]{64}$/;
const html = (body: string, status = 200) => new Response(body, { status, headers: PAGE_HEADERS });
const notFound = () => html(renderMessagePage("Link not available", "This link is not valid or has expired. Please contact the studio that sent it."), 404);

const BUSINESS_MESSAGES: Record<string, string> = {
  V3017: "This invoice has nothing left to pay.",
  V3011: "Online payment is not available for this invoice. Please use the other payment instructions on the invoice.",
  V3018: "Online payment is not available because the studio has no email address on file for you. Please contact the studio.",
  V3019: "Online payment is not available right now.",
  V3010: "This link is not valid or has expired.",
};

export async function handleFinancePublic(req: Request, d: PublicDeps): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get("t") || "";
  if (!TOKEN.test(token)) return notFound();
  if (req.method !== "GET" && req.method !== "POST") return html(renderMessagePage("Not allowed", "This address does not accept that kind of request."), 405);
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (d.rateLimit && !d.rateLimit(`${ip}:${req.method}`)) return html(renderMessagePage("Too many requests", "Please wait a moment and try again."), 429);

  const hash = await d.sha256Hex(token);
  const link = await d.rpc("fin3svc_resolve_link", { p_token_hash: hash });
  if (!link) return notFound();

  if (req.method === "GET" && url.searchParams.get("pdf") === "1") {
    try {
      const doc = await attachmentFor({ rpc: d.rpc, send: async () => ({ ok: false, unknown: false, retryable: false, status: 0, message: "unused" }), linkBase: "" },
        link.organization_id, { kind: "invoice_pdf", entity_id: link.invoice_id });
      return new Response(fromBase64(doc.content_base64), { status: 200, headers: {
        "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${doc.filename}"`, "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" } });
    } catch {
      return html(renderMessagePage("Could not prepare the PDF", "Please try again in a moment."), 500);
    }
  }

  if (req.method === "GET") {
    const notice = url.searchParams.get("paid") === "1" ? "returned" : undefined;
    return html(renderInvoicePage(link, { token, notice, payEnabled: d.paystack.ok }));
  }

  // POST = "Pay now"
  if (link.kind !== "pay") return notFound();
  if (!d.paystack.ok) return html(renderMessagePage("Online payment is unavailable", "Please use the other payment instructions on the invoice."), 503);
  const prep = await d.rpcRaw("fin3svc_prepare_intent", { p_token_hash: hash, p_environment: d.paystack.environment });
  if (prep.error) {
    const msg = BUSINESS_MESSAGES[String(prep.error.code || "")] || "The payment could not be started. Please try again.";
    return html(renderInvoicePage(link, { token, notice: "error", message: msg, payEnabled: false }), 409);
  }
  const intent = prep.data;
  const callbackUrl = `${d.publicUrl(req)}?t=${token}&paid=1`;
  const out = await initializeCheckout({
    rpc: async (name, args) => d.rpcRaw(name, args), initialize: d.paystack.initialize,
    intent: { intent_id: intent.intent_id, reference: intent.reference, charge_amount_minor: intent.charge_amount_minor, currency: intent.currency, customer_email: intent.customer_email, authorization_url: intent.authorization_url },
    callbackUrl,
  });
  if (!out.ok) return html(renderInvoicePage(link, { token, notice: "error", message: out.message, payEnabled: true }), 502);
  return new Response(null, { status: 303, headers: { Location: out.url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
