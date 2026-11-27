// Finance V3 transactional email templates (version 1). Pure functions: the same payload always renders the same message.
// Every value is HTML-escaped; header-injection characters are stripped from subjects; no secret ever appears in a message
// (links carry only an opaque view/pay token). Amounts are decimal strings copied from the database snapshot, never recomputed.

export const TEMPLATE_VERSION = 1;

export type RenderInput = {
  type: string;
  payload: Record<string, any>;
  /** Absolute base of the public link endpoint, for example https://<project>.supabase.co/functions/v1/finance-public */
  linkBase: string;
};
export type Rendered = { subject: string; html: string; text: string };

const escapeHtml = (v: unknown) =>
  String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const oneLine = (v: unknown, max = 200) => String(v ?? "").replace(/[\r\n\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

function group(v: unknown): string {
  const m = /^(-?)(\d+)(\.\d+)?$/.exec(String(v ?? ""));
  return m ? m[1] + m[2].replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (m[3] || "") : String(v ?? "");
}
const amt = (ccy: unknown, v: unknown) => `${oneLine(ccy, 3)} ${group(v)}`;

function url(base: string, token: unknown): string | null {
  return typeof token === "string" && /^[0-9a-f]{64}$/.test(token) ? `${base}?t=${token}` : null;
}

function shell(studio: string, brand: string, title: string, bodyHtml: string): string {
  const color = /^#[0-9A-Fa-f]{6}$/.test(brand) ? brand : "#1F3A5F";
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:6px;overflow:hidden">
<tr><td style="background:${color};color:#ffffff;padding:18px 24px;font-size:18px;font-weight:bold">${escapeHtml(studio)}</td></tr>
<tr><td style="padding:24px"><h1 style="margin:0 0 16px;font-size:20px;color:${color}">${escapeHtml(title)}</h1>${bodyHtml}</td></tr>
<tr><td style="padding:14px 24px;background:#fafafa;color:#777;font-size:12px">Sent by ${escapeHtml(studio)}. If you did not expect this message you can ignore it.</td></tr>
</table></td></tr></table></body></html>`;
}

const button = (href: string, label: string, color: string) =>
  `<p style="margin:20px 0"><a href="${escapeHtml(href)}" style="background:${/^#[0-9A-Fa-f]{6}$/.test(color) ? color : "#1F3A5F"};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:5px;display:inline-block;font-weight:bold">${escapeHtml(label)}</a></p>`;

// The sender's own text for an invoice email (plain text, at most 2000 characters, escaped when rendered).
const customMessage = (v: unknown) => (typeof v === "string" ? v.replace(/\r/g, "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/g, "").trim().slice(0, 2000) : "");

const kv = (rows: [string, string][]) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:12px 0;font-size:14px">${rows
    .filter(([, v]) => v)
    .map(([k, v]) => `<tr><td style="padding:3px 18px 3px 0;color:#666">${escapeHtml(k)}</td><td style="padding:3px 0"><b>${escapeHtml(v)}</b></td></tr>`)
    .join("")}</table>`;

export function renderFinanceEmail(i: RenderInput): Rendered {
  const p = i.payload || {};
  const studio = oneLine(p.studio?.name || p.receipt?.studio?.name || "Your studio", 80);
  const brand = String(p.studio?.brand_color || p.receipt?.studio?.brand_color || "#1F3A5F");
  const client = oneLine(p.client?.name || p.receipt?.client?.name || "", 100);
  const hello = client ? `Hello ${client},` : "Hello,";
  const no = oneLine(p.invoice_no || p.receipt?.invoice_no, 50);
  const viewUrl = url(i.linkBase, p.view_token);
  const payUrl = url(i.linkBase, p.pay_token);
  const links = (extra: string[] = []) => [viewUrl && `View invoice: ${viewUrl}`, payUrl && `Pay online: ${payUrl}`, ...extra].filter(Boolean) as string[];
  const buttons = () => (payUrl ? button(payUrl, "Pay now", brand) : "") + (viewUrl ? `<p style="margin:0 0 12px"><a href="${escapeHtml(viewUrl)}" style="color:${escapeHtml(brand)}">View invoice online</a></p>` : "");

  switch (i.type) {
    case "invoice": {
      const subject = oneLine(p.custom_subject ? String(p.custom_subject) : `Invoice ${no} from ${studio}`, 150);
      const note = customMessage(p.custom_message);
      const rows: [string, string][] = [["Invoice", no], ["Amount due", amt(p.currency, p.outstanding)], ["Issue date", oneLine(p.issue_date)], ["Due date", oneLine(p.due_date)]];
      const html = shell(studio, brand, `Invoice ${no}`, `<p>${escapeHtml(hello)}</p><p>Please find your invoice attached as a PDF.</p>${note ? `<p>${escapeHtml(note).replace(/\n/g, "<br>")}</p>` : ""}${kv(rows)}${buttons()}`);
      const text = [hello, "", `Please find invoice ${no} attached as a PDF.`, ...(note ? ["", note] : []), "", ...rows.map(([k, v]) => `${k}: ${v}`), "", ...links(), "", `-- ${studio}`].join("\n");
      return { subject, html, text };
    }
    case "invoice_reminder": {
      const subject = oneLine(`Reminder: invoice ${no} is due ${p.due_date}`);
      const rows: [string, string][] = [["Invoice", no], ["Outstanding", amt(p.currency, p.outstanding)], ["Due date", oneLine(p.due_date)]];
      const html = shell(studio, brand, `Payment reminder`, `<p>${escapeHtml(hello)}</p><p>This is a friendly reminder that the invoice below has an outstanding balance.</p>${kv(rows)}${buttons()}`);
      const text = [hello, "", `This is a friendly reminder that invoice ${no} has an outstanding balance.`, "", ...rows.map(([k, v]) => `${k}: ${v}`), "", ...links(), "", `-- ${studio}`].join("\n");
      return { subject, html, text };
    }
    case "overdue_notice": {
      const days = Number(p.days_overdue) > 0 ? `${Number(p.days_overdue)} day(s)` : "";
      const subject = oneLine(`Overdue: invoice ${no}`);
      const rows: [string, string][] = [["Invoice", no], ["Outstanding", amt(p.currency, p.outstanding)], ["Was due", oneLine(p.due_date)], ["Overdue by", days]];
      const html = shell(studio, brand, `Invoice overdue`, `<p>${escapeHtml(hello)}</p><p>Our records show that the invoice below is now past its due date.</p>${kv(rows)}${buttons()}<p>If you have already paid, thank you, and please disregard this notice.</p>`);
      const text = [hello, "", `Our records show that invoice ${no} is now past its due date.`, "", ...rows.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`), "", ...links(), "", "If you have already paid, thank you, and please disregard this notice.", `-- ${studio}`].join("\n");
      return { subject, html, text };
    }
    case "payment_receipt": {
      const r = p.receipt || {};
      const rno = oneLine(r.receipt_no || p.receipt_no, 50);
      const subject = oneLine(`Payment receipt ${rno} for invoice ${no}`);
      const rows: [string, string][] = [["Receipt", rno], ["Invoice", no], ["Amount received", amt(r.currency, r.payment_amount)], ["Payment date", oneLine(r.payment_date)],
        ["Remaining balance", amt(r.currency, r.remaining_balance)]];
      const note = r.invoice_fully_paid ? "Your invoice is now paid in full." : "A balance remains on your invoice.";
      const html = shell(studio, brand, `Payment received`, `<p>${escapeHtml(hello)}</p><p>Thank you. We have received your payment. Your receipt is attached as a PDF.</p>${kv(rows)}<p>${escapeHtml(note)}</p>`);
      const text = [hello, "", "Thank you. We have received your payment. Your receipt is attached as a PDF.", "", ...rows.map(([k, v]) => `${k}: ${v}`), "", note, `-- ${studio}`].join("\n");
      return { subject, html, text };
    }
    case "invoice_update": {
      const subject = oneLine(`Update to invoice ${no}`);
      const status = p.invoice_status === "void" ? "This invoice has been cancelled." : "A credit adjustment was applied to this invoice.";
      const rows: [string, string][] = [["Invoice", no], ["Credits applied", amt(p.currency, p.credit_total)], ["Outstanding", amt(p.currency, p.outstanding)]];
      const note = oneLine(p.note, 500);
      const html = shell(studio, brand, `Invoice updated`, `<p>${escapeHtml(hello)}</p><p>${escapeHtml(status)}</p>${note ? `<p>${escapeHtml(note)}</p>` : ""}${kv(rows)}`);
      const text = [hello, "", status, ...(note ? ["", note] : []), "", ...rows.map(([k, v]) => `${k}: ${v}`), `-- ${studio}`].join("\n");
      return { subject, html, text };
    }
    case "refund_notice": {
      const subject = oneLine(`Refund ${oneLine(p.refund_no, 40)} for invoice ${no}`);
      const rows: [string, string][] = [["Refund", oneLine(p.refund_no, 40)], ["Invoice", no], ["Amount refunded", amt(p.currency, p.refund_amount)]];
      const html = shell(studio, brand, `Refund processed`, `<p>${escapeHtml(hello)}</p><p>A refund has been recorded for your payment. It can take a few business days to appear with your bank or card provider.</p>${kv(rows)}`);
      const text = [hello, "", "A refund has been recorded for your payment. It can take a few business days to appear with your bank or card provider.", "", ...rows.map(([k, v]) => `${k}: ${v}`), `-- ${studio}`].join("\n");
      return { subject, html, text };
    }
    default:
      throw new Error(`Unknown Finance email type "${i.type}"`);
  }
}

/** Where a PDF attachment's filename comes from: only characters that are safe in a header and on every file system. */
export function attachmentName(kind: string, number: string): string {
  const safe = String(number || "document").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60);
  return `${kind === "receipt_pdf" ? "Receipt" : "Invoice"}-${safe}.pdf`;
}
