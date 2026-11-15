// Page-flow helpers for the invoice / proforma / receipt PDF (jsPDF, units: mm, A4 = 297 mm tall).
// The PDF used to draw everything at fixed offsets and never started a new page, so long line-item lists and
// long descriptions ran off the bottom of the page.

export const PDF_PAGE_TOP = 22;
export const PDF_PAGE_BOTTOM = 277;

const lineHeightOf = (doc) => {
  const factor = typeof doc.getLineHeightFactor === "function" ? doc.getLineHeightFactor() : 1.15;
  const scale = doc.internal?.scaleFactor || 72 / 25.4;
  return (doc.getFontSize() * factor) / scale;
};

// Draws wrapped `lines` starting at y, continuing on new pages when they would pass the bottom margin.
// Returns the y just below the block, using `pitch` per line (the spacing the fixed layout always assumed), so a
// block that fits on one page ends exactly where it did before.
export function flowLines(doc, lines, x, y, { pitch = 6, top = PDF_PAGE_TOP, bottom = PDF_PAGE_BOTTOM } = {}) {
  const all = Array.isArray(lines) ? lines : [String(lines ?? "")];
  if (!all.length) return y;
  const lineH = lineHeightOf(doc);
  let i = 0;
  let cy = y;
  while (i < all.length) {
    let fit = Math.floor((bottom - cy) / lineH);
    if (fit < 1) { doc.addPage(); cy = top; fit = Math.max(1, Math.floor((bottom - cy) / lineH)); }
    const chunk = all.slice(i, i + fit);
    doc.text(chunk, x, cy);
    i += chunk.length;
    if (i < all.length) { doc.addPage(); cy = top; } else { cy += chunk.length * pitch; }
  }
  return cy;
}

// If `height` mm will not fit below y, starts a new page and returns the top margin; otherwise returns y.
export function ensureSpace(doc, y, height, { top = PDF_PAGE_TOP, bottom = PDF_PAGE_BOTTOM } = {}) {
  if (y + height <= bottom) return y;
  doc.addPage();
  return top;
}

// File name for the downloaded PDF: the document's own reference, so "INV-0007.pdf" rather than a generic
// "invoice.pdf" that every download would share. Characters that are illegal in file names are replaced.
export function invoicePdfFileName(invoice, { paystackRef = "", fallback = "invoice" } = {}) {
  const raw = String(invoice?.invoiceNumber || "").trim() || String(paystackRef || "").trim() || fallback;
  const safe = raw.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/\s+/g, " ").replace(/^[.\s-]+|[.\s-]+$/g, "").slice(0, 100);
  return `${safe || fallback}.pdf`;
}
