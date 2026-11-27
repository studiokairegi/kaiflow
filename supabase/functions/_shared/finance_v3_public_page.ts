// Finance V3: the hosted invoice page behind a secure view/pay link. Server-rendered, no scripts, no third-party resources.
// Shows only what the frozen snapshot contains plus the live outstanding balance; never an internal id.

const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const group = (v: unknown) => { const m = /^(-?)(\d+)(\.\d+)?$/.exec(String(v ?? "")); return m ? m[1] + m[2].replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (m[3] || "") : String(v ?? ""); };

export const PAGE_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

type Link = { kind: "view" | "pay"; invoice_no: string; status: string; currency: string; total: string; outstanding: string; due_date: string; payable: boolean; snapshot: any };

export function renderInvoicePage(l: Link, o: { token: string; notice?: "returned" | "error"; message?: string; payEnabled: boolean }): string {
  const s = l.snapshot || {};
  const studio = s.studio || {};
  const brand = /^#[0-9A-Fa-f]{6}$/.test(String(studio.brand_color)) ? studio.brand_color : "#1F3A5F";
  const lines = Array.isArray(s.lines) ? s.lines : [];
  const paid = ["paid", "credited"].includes(l.status);
  const banner = o.notice === "returned"
    ? `<p class="note">Thank you. We are confirming your payment with the payment provider. This page will show it as paid once it is confirmed, which usually takes a moment.</p>`
    : o.notice === "error" ? `<p class="err">${esc(o.message || "Something went wrong.")}</p>` : "";
  const rows = lines.map((x: any) => `<tr><td>${esc(x.description)}</td><td class="r">${esc(group(x.quantity))}</td><td class="r">${esc(group(x.unit_price))}</td><td class="r">${esc(group(x.net_amount))}</td></tr>`).join("");
  const status = paid ? "Paid" : l.status === "partially_paid" ? "Partially paid" : "Awaiting payment";
  const pay = l.kind === "pay" && l.payable && o.payEnabled
    ? `<form method="post" action="?t=${esc(o.token)}"><button type="submit">Pay ${esc(l.currency)} ${esc(group(l.outstanding))} now</button></form>`
    : paid ? `<p class="note">This invoice is paid. Thank you.</p>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Invoice ${esc(l.invoice_no)}</title>
<style>body{margin:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a}.w{max-width:680px;margin:0 auto;padding:16px}.c{background:#fff;border-radius:8px;overflow:hidden}
.h{background:${brand};color:#fff;padding:18px 22px;font-size:18px;font-weight:bold}.b{padding:22px}table{width:100%;border-collapse:collapse;margin:14px 0;font-size:14px}th,td{padding:8px 6px;border-bottom:1px solid #eee;text-align:left}th{color:#666;font-size:12px}.r{text-align:right}
.t{font-size:18px;font-weight:bold;text-align:right;margin:8px 0}.pill{display:inline-block;padding:3px 10px;border-radius:99px;background:#eef2f7;font-size:12px}button,a.btn{background:${brand};color:#fff;border:0;border-radius:6px;padding:13px 22px;font-size:16px;font-weight:bold;cursor:pointer;text-decoration:none;display:inline-block}
.note{background:#eef7ee;padding:10px 12px;border-radius:6px}.err{background:#fdeeee;padding:10px 12px;border-radius:6px;color:#8a1f1f}.m{color:#666;font-size:13px}</style></head>
<body><div class="w"><div class="c"><div class="h">${esc(studio.name || "Invoice")}</div><div class="b">
${banner}<p><span class="pill">${esc(status)}</span></p>
<h2 style="margin:6px 0">Invoice ${esc(l.invoice_no)}</h2>
<p class="m">Billed to ${esc(s.client?.name || "")}<br>Issued ${esc(s.issue_date || "")} · Due ${esc(l.due_date || s.due_date || "")}</p>
<table><thead><tr><th>Description</th><th class="r">Qty</th><th class="r">Unit price</th><th class="r">Amount</th></tr></thead><tbody>${rows}</tbody></table>
<p class="t">Total ${esc(l.currency)} ${esc(group(l.total))}</p>
<p class="t" style="font-size:15px">Outstanding ${esc(l.currency)} ${esc(group(l.outstanding))}</p>
${pay}
<p style="margin-top:18px"><a href="?t=${esc(o.token)}&amp;pdf=1">Download PDF</a></p>
${s.payment_instructions ? `<p class="m"><b>Other ways to pay</b><br>${esc(s.payment_instructions)}</p>` : ""}
</div></div><p class="m" style="text-align:center">Secure invoice page. Never share this link.</p></div></body></html>`;
}

export function renderMessagePage(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>
<style>body{margin:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;display:flex;min-height:100vh;align-items:center;justify-content:center}.c{background:#fff;border-radius:8px;padding:28px;max-width:440px;margin:16px}</style></head>
<body><div class="c"><h2 style="margin-top:0">${esc(title)}</h2><p>${esc(message)}</p></div></body></html>`;
}
