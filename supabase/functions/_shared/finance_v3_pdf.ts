// Finance V3: invoice and receipt PDFs, generated server-side from the FROZEN snapshot stored in the database.
//
// Dependency-free on purpose (Edge Functions cannot install packages at build time and a PDF library is a supply-chain surface in
// a money path). Output is deterministic: no timestamps, no random ids, so the same snapshot always yields the same bytes. Only the
// 14 standard PDF fonts are used (Helvetica / Helvetica-Bold, WinAnsi). Characters outside Latin-1 cannot be shown with a standard
// font and are replaced with "?" (documented limitation; embedding a Unicode font is a later enhancement).
//
// Amounts are NEVER computed here. Every number shown is a decimal string read from the snapshot (written by the database).

type Snap = Record<string, any>;

const W_REG: number[] = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const W_BOLD: number[] = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 48;

/** Latin-1 only; control characters become spaces; everything else outside Latin-1 becomes "?". */
export function pdfSafeText(input: unknown): string {
  const s = String(input ?? "")
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014]/g, "-").replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ");
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c === 9 || c === 10 || c === 13) out += " ";
    else if (c < 32 || c === 127) out += " ";
    else if (c <= 255) out += ch;
    else out += "?";
  }
  return out;
}

export function textWidth(s: string, size: number, bold = false): number {
  const t = bold ? W_BOLD : W_REG;
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    w += c >= 32 && c <= 126 ? t[c - 32] : 556;
  }
  return (w * size) / 1000;
}

function wrap(s: string, maxW: number, size: number, bold = false, maxLines = 99): string[] {
  const words = pdfSafeText(s).split(" ").filter((x) => x.length);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? cur + " " + w : w;
    if (textWidth(next, size, bold) <= maxW || !cur) {
      if (!cur && textWidth(w, size, bold) > maxW) {
        // A single very long token: hard-break it.
        let chunk = "";
        for (const ch of w) {
          if (textWidth(chunk + ch, size, bold) > maxW) { lines.push(chunk); chunk = ch; } else chunk += ch;
        }
        cur = chunk;
      } else cur = next;
    } else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/.{0,3}$/, "...");
    return kept;
  }
  return lines.length ? lines : [""];
}

/** "1234567.5" -> "1,234,567.50" style grouping on the integer part only; the decimals are kept exactly as given. */
export function groupDecimal(v: unknown): string {
  const s = String(v ?? "");
  const m = /^(-?)(\d+)(\.\d+)?$/.exec(s);
  if (!m) return pdfSafeText(s);
  return m[1] + m[2].replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (m[3] || "");
}
export const money = (ccy: unknown, v: unknown) => `${pdfSafeText(ccy)} ${groupDecimal(v)}`;

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
const n2 = (x: number) => (Math.round(x * 100) / 100).toString();

function hexToRgb(hex: unknown): [number, number, number] {
  const m = /^#([0-9a-fA-F]{6})$/.exec(String(hex ?? ""));
  const h = m ? m[1] : "1F3A5F";
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}

class Page {
  ops: string[] = [];
  text(x: number, y: number, s: string, size = 10, bold = false, color: [number, number, number] = [0.1, 0.1, 0.1], align: "l" | "r" = "l") {
    const t = pdfSafeText(s);
    const px = align === "r" ? x - textWidth(t, size, bold) : x;
    this.ops.push(`BT /${bold ? "F2" : "F1"} ${n2(size)} Tf ${color.map(n2).join(" ")} rg ${n2(px)} ${n2(PAGE_H - y)} Td (${esc(t)}) Tj ET`);
  }
  rect(x: number, y: number, w: number, h: number, color: [number, number, number]) {
    this.ops.push(`${color.map(n2).join(" ")} rg ${n2(x)} ${n2(PAGE_H - y - h)} ${n2(w)} ${n2(h)} re f`);
  }
  line(x1: number, y1: number, x2: number, y2: number, color: [number, number, number] = [0.8, 0.8, 0.8], width = 0.6) {
    this.ops.push(`${color.map(n2).join(" ")} RG ${n2(width)} w ${n2(x1)} ${n2(PAGE_H - y1)} m ${n2(x2)} ${n2(PAGE_H - y2)} l S`);
  }
}

/** Assembles pages into a valid PDF 1.4 byte stream (classic xref table, fixed Info, no dates). */
function assemble(pages: Page[], title: string): Uint8Array {
  const enc = new TextEncoder();
  const objs: string[] = [];
  const kids: number[] = [];
  // 1 Catalog, 2 Pages, 3 F1, 4 F2, 5 Info, then (page, content) pairs
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objs[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  objs[5] = `<< /Title (${esc(pdfSafeText(title))}) /Producer (KairFlow Finance) >>`;
  let next = 6;
  const streams: { id: number; body: string }[] = [];
  for (const p of pages) {
    const pageId = next++;
    const contentId = next++;
    kids.push(pageId);
    objs[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n2(PAGE_W)} ${n2(PAGE_H)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`;
    streams.push({ id: contentId, body: p.ops.join("\n") });
  }
  objs[2] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;

  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let pos = 0;
  const push = (s: string) => { const b = enc.encode(s); chunks.push(b); pos += b.length; };
  // Latin-1 text must be written byte-for-byte: encode each char code as one byte.
  const pushLatin1 = (s: string) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; chunks.push(b); pos += b.length; };
  push("%PDF-1.4\n");
  pushLatin1("%\xE2\xE3\xCF\xD3\n");
  const total = next - 1;
  for (let id = 1; id <= total; id++) {
    offsets[id] = pos;
    const st = streams.find((s) => s.id === id);
    if (st) {
      pushLatin1(`${id} 0 obj\n<< /Length ${st.body.length} >>\nstream\n${st.body}\nendstream\nendobj\n`);
    } else {
      pushLatin1(`${id} 0 obj\n${objs[id]}\nendobj\n`);
    }
  }
  const xref = pos;
  push(`xref\n0 ${total + 1}\n0000000000 65535 f \n`);
  for (let id = 1; id <= total; id++) push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${total + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(pos);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

const GREY: [number, number, number] = [0.42, 0.42, 0.42];
const DARK: [number, number, number] = [0.1, 0.1, 0.1];

function header(p: Page, snap: Snap, label: string, rightLines: string[]) {
  const brand = hexToRgb(snap?.studio?.brand_color);
  p.rect(0, 0, PAGE_W, 10, brand);
  const studio = snap?.studio || {};
  p.text(MARGIN, 52, studio.name || "Studio", 18, true, brand);
  let y = 68;
  for (const l of [studio.address, studio.email, studio.phone, studio.tax_id ? `Tax ID: ${studio.tax_id}` : ""].filter(Boolean)) {
    for (const w of wrap(String(l), 250, 8.5, false, 2)) { p.text(MARGIN, y, w, 8.5, false, GREY); y += 11; }
  }
  p.text(PAGE_W - MARGIN, 54, label, 22, true, DARK, "r");
  let ry = 72;
  for (const l of rightLines) { p.text(PAGE_W - MARGIN, ry, l, 9.5, false, DARK, "r"); ry += 13; }
  return Math.max(y, ry) + 10;
}

export type PdfResult = { bytes: Uint8Array; pages: number };

/** Invoice PDF from receivables.snapshot. */
export function renderInvoicePdf(snap: Snap): PdfResult {
  const ccy = snap.currency;
  const brand = hexToRgb(snap?.studio?.brand_color);
  const pages: Page[] = [];
  let p = new Page(); pages.push(p);
  let y = header(p, snap, "INVOICE", [
    `Invoice no: ${snap.invoice_no}`, `Issue date: ${snap.issue_date}`, `Due date: ${snap.due_date}`,
    ...(snap.po_reference ? [`PO: ${snap.po_reference}`] : []),
  ]);
  // Bill to
  p.text(MARGIN, y + 10, "BILL TO", 8, true, GREY);
  y += 24;
  const client = snap.client || {};
  p.text(MARGIN, y, client.name || "", 11, true);
  y += 14;
  for (const l of [client.address, client.email, client.tax_id ? `Tax ID: ${client.tax_id}` : ""].filter(Boolean)) {
    for (const w of wrap(String(l), 280, 9, false, 3)) { p.text(MARGIN, y, w, 9, false, GREY); y += 11.5; }
  }
  y += 14;

  // Columns (right edges)
  const cDesc = MARGIN, cQty = 352, cPrice = 420, cTax = 462, cAmt = PAGE_W - MARGIN;
  const tableHead = (pg: Page, yy: number) => {
    pg.rect(MARGIN, yy - 11, PAGE_W - 2 * MARGIN, 18, brand);
    const white: [number, number, number] = [1, 1, 1];
    pg.text(cDesc + 6, yy + 1, "Description", 8.5, true, white);
    pg.text(cQty, yy + 1, "Qty", 8.5, true, white, "r");
    pg.text(cPrice, yy + 1, "Unit price", 8.5, true, white, "r");
    pg.text(cTax, yy + 1, "Tax %", 8.5, true, white, "r");
    pg.text(cAmt - 6, yy + 1, "Amount", 8.5, true, white, "r");
    return yy + 20;
  };
  y = tableHead(p, y);
  const lines: Snap[] = Array.isArray(snap.lines) ? snap.lines : [];
  for (const l of lines) {
    const descLines = wrap(String(l.description ?? ""), cQty - 70 - cDesc - 6, 9, false, 6);
    const need = descLines.length * 11.5 + 8;
    if (y + need > PAGE_H - 150) { p = new Page(); pages.push(p); y = header(p, snap, "INVOICE", [`Invoice no: ${snap.invoice_no}`, "(continued)"]) + 6; y = tableHead(p, y); }
    descLines.forEach((d, i) => p.text(cDesc + 6, y + i * 11.5, d, 9));
    p.text(cQty, y, groupDecimal(l.quantity), 9, false, DARK, "r");
    p.text(cPrice, y, groupDecimal(l.unit_price), 9, false, DARK, "r");
    p.text(cTax, y, Number(l.tax_rate) > 0 ? groupDecimal(l.tax_rate) : "-", 9, false, DARK, "r");
    p.text(cAmt - 6, y, groupDecimal(l.net_amount), 9, false, DARK, "r");
    if (Number(l.discount_pct) > 0) { p.text(cDesc + 6, y + descLines.length * 11.5, `Discount ${groupDecimal(l.discount_pct)}%`, 7.5, false, GREY); }
    const extra = Number(l.discount_pct) > 0 ? 9 : 0;
    y += need + extra;
    p.line(MARGIN, y - 4, PAGE_W - MARGIN, y - 4);
  }

  // Totals
  if (y + 120 > PAGE_H - 90) { p = new Page(); pages.push(p); y = header(p, snap, "INVOICE", [`Invoice no: ${snap.invoice_no}`, "(continued)"]) + 10; }
  y += 10;
  const lx = 360, rx = PAGE_W - MARGIN - 6;
  const row = (label: string, val: string, bold = false, big = false) => {
    p.text(lx, y, label, big ? 11 : 9.5, bold, DARK);
    p.text(rx, y, val, big ? 11 : 9.5, bold, DARK, "r");
    y += big ? 18 : 14;
  };
  row("Subtotal", money(ccy, snap.subtotal));
  if (Number(snap.discount_total) > 0) row("Discount", "-" + money(ccy, snap.discount_total));
  if (Number(snap.tax_total) > 0) row("Tax", money(ccy, snap.tax_total));
  p.line(lx, y - 8, PAGE_W - MARGIN, y - 8, brand, 1);
  y += 2;
  row("Total due", money(ccy, snap.total), true, true);

  // Notes and payment instructions
  y += 8;
  for (const [title, body] of [["Notes", snap.notes], ["Payment instructions", snap.payment_instructions]] as [string, unknown][]) {
    if (!body) continue;
    const ws = wrap(String(body), PAGE_W - 2 * MARGIN, 9, false, 12);
    if (y + 16 + ws.length * 11.5 > PAGE_H - 50) { p = new Page(); pages.push(p); y = header(p, snap, "INVOICE", [`Invoice no: ${snap.invoice_no}`, "(continued)"]) + 10; }
    p.text(MARGIN, y, title.toUpperCase(), 8, true, GREY); y += 13;
    for (const w of ws) { p.text(MARGIN, y, w, 9); y += 11.5; }
    y += 8;
  }
  pages.forEach((pg, i) => pg.text(PAGE_W / 2, PAGE_H - 26, `${snap.invoice_no}  -  Page ${i + 1} of ${pages.length}`, 8, false, GREY, "l"));
  return { bytes: assemble(pages, `Invoice ${snap.invoice_no}`), pages: pages.length };
}

/** Receipt PDF from receipts.snapshot. */
export function renderReceiptPdf(snap: Snap): PdfResult {
  const brand = hexToRgb(snap?.studio?.brand_color);
  const p = new Page();
  let y = header(p, snap, "RECEIPT", [`Receipt no: ${snap.receipt_no}`, `Payment date: ${snap.payment_date}`, `Invoice: ${snap.invoice_no}`]);
  p.text(MARGIN, y + 10, "RECEIVED FROM", 8, true, GREY);
  y += 24;
  const client = snap.client || {};
  p.text(MARGIN, y, client.name || "", 11, true); y += 14;
  if (client.email) { p.text(MARGIN, y, client.email, 9, false, GREY); y += 12; }
  y += 18;
  p.rect(MARGIN, y - 12, PAGE_W - 2 * MARGIN, 52, [0.95, 0.97, 0.99]);
  p.text(MARGIN + 14, y + 6, "Amount received", 9, false, GREY);
  p.text(MARGIN + 14, y + 28, money(snap.currency, snap.payment_amount), 20, true, brand);
  y += 64;
  const kv = (k: string, v: unknown) => { if (v === undefined || v === null || v === "") return; p.text(MARGIN, y, k, 9, false, GREY); p.text(MARGIN + 150, y, String(v), 9.5); y += 16; };
  kv("Payment method", String(snap.payment_method || "").replace(/_/g, " "));
  kv("Payment reference", snap.payment_reference);
  kv("Invoice total", money(snap.currency, snap.invoice_total));
  kv("Previously paid", money(snap.currency, snap.previously_paid));
  kv("Remaining balance", money(snap.currency, snap.remaining_balance));
  y += 8;
  p.text(MARGIN, y, snap.invoice_fully_paid ? "This invoice is now paid in full. Thank you." : "Thank you for your payment.", 10, true, brand);
  p.text(PAGE_W / 2, PAGE_H - 26, `${snap.receipt_no}`, 8, false, GREY, "l");
  return { bytes: assemble([p], `Receipt ${snap.receipt_no}`), pages: 1 };
}

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(bin);
}
export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
