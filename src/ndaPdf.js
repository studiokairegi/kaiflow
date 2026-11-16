// Signed-document PDF builders. Split out of ndaApi.js so the (large) jspdf library is only
// loaded by screens that actually render PDFs, not by everything that imports ndaApi.
import { jsPDF } from "jspdf";
import { isJapanese } from "./i18n/languages.js";
import { contractT, CERT_STATUS_JA } from "./i18n/contractStrings.js";
import { useJapaneseFont, wrapMixed, JP_FONT_NAME } from "./i18n/pdfJapanese.js";

// ---- signed PDF with certificate page -------------------------------------
// Accepts a row from nda_requests (snake_case) or the public RPC json (same keys).
export function buildNdaPdf(r) {
  return buildSignedDocPdf(r, { defaultTitle: "Non-Disclosure Agreement" });
}

// Shared with client contracts (contractsApi.js). `extraRows` are [label, value] pairs
// added to the certificate page right after the document title.
// English / NDA: synchronous, exactly as before. For a Japanese document use buildSignedDocPdfLocalized().
export function buildSignedDocPdf(r, { defaultTitle = "Document", extraRows = [] } = {}) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  return layoutSignedDoc(doc, r, { defaultTitle, extraRows, lang: "en" });
}

// Picks the language from the document itself (`r.language`). Japanese embeds the CJK font subset first and
// REFUSES to produce a PDF full of blank boxes if the font cannot be loaded (the caller shows an error).
export async function buildSignedDocPdfLocalized(r, opts = {}) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const lang = isJapanese(r.language) ? "ja" : "en";
  if (lang === "ja") await useJapaneseFont(doc, opts.fetchImpl);
  return layoutSignedDoc(doc, r, { ...opts, lang });
}

const utcStamp = (iso) => (iso ? `${new Date(iso).toISOString().replace("T", " ").slice(0, 19)} UTC` : "-");

function layoutSignedDoc(doc, r, { defaultTitle = "Document", extraRows = [], lang = "en" } = {}) {
  const ja = lang === "ja";
  const t = contractT(lang);
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 56;
  let y = M;
  const ensure = (h) => { if (y + h > H - M) { doc.addPage(); y = M; } };

  // The embedded Japanese font has a single weight: "bold" is drawn by printing the text twice, a hair apart.
  const setFace = (family, weight) => (ja ? doc.setFont(JP_FONT_NAME, "normal") : doc.setFont(family, weight));
  const wrap = (text, width) => (ja ? wrapMixed(doc, text, width) : doc.splitTextToSize(text, width));
  const put = (text, x, yy, bold) => { doc.text(text, x, yy); if (ja && bold) doc.text(text, x + 0.35, yy); };

  setFace("times", "normal");
  doc.setFontSize(11);
  const bodyLines = String(r.body || "").split("\n");
  const titleIdx = bodyLines.findIndex((l) => l.trim());
  bodyLines.forEach((line, idx) => {
    // English: an ALL-CAPS line is the title and "1. Heading" lines are headings. Japanese has no letter case, so the
    // first line is the title and "第N条（…）" lines are headings.
    const isTitle = ja ? idx === titleIdx : line === line.toUpperCase() && line.trim().length > 3;
    const isHeading = isTitle || (ja ? /^第[0-9０-９]+条/.test(line) : /^\d+\.\s/.test(line) && line.length < 60);
    setFace("times", isHeading ? "bold" : "normal");
    doc.setFontSize(isTitle ? 15 : 11);
    wrap(line || " ", W - M * 2).forEach((l) => { ensure(16); put(l, M, y, isHeading); y += line === "" ? 8 : 15; });
  });

  if (r.status === "signed" && r.signature_png) {
    ensure(120);
    y += 18;
    setFace("times", "normal");
    doc.setFontSize(11);
    doc.text(t("pdf.signedBy"), M, y); y += 8;
    try { doc.addImage(r.signature_png, "PNG", M, y, 200, 70); } catch (e) { /* signature image unreadable */ }
    y += 82;
    setFace("times", "bold");
    put(r.typed_name || r.signer_name, M, y, true);
  }

  // Certificate page
  doc.addPage();
  y = M;
  setFace("helvetica", "bold"); doc.setFontSize(16);
  put(t("pdf.cert.title"), M, y, true); y += 28;
  setFace("helvetica", "normal"); doc.setFontSize(10);
  const when = (iso) => (ja ? utcStamp(iso) : iso ? new Date(iso).toUTCString() : "-");
  const statusText = ja ? (CERT_STATUS_JA[r.status] || (r.status || "").toUpperCase()) : (r.status || "").toUpperCase();
  const rows = [
    [t("pdf.cert.document"), r.title || defaultTitle],
    ...extraRows,
    [t("pdf.cert.requestedBy"), r.studio_name || "-"],
    [t("pdf.cert.signer"), `${r.typed_name || r.signer_name}${r.signer_email ? ` <${r.signer_email}>` : ""}`],
    [t("pdf.cert.status"), statusText],
    [t("pdf.cert.sent"), when(r.created_at)],
    [t("pdf.cert.signed"), when(r.signed_at)],
    [t("pdf.cert.ip"), r.signer_ip || t("pdf.cert.ipNone")],
    [t("pdf.cert.method"), r.signature_method === "type" ? t("pdf.cert.method.type") : t("pdf.cert.method.draw")],
    [t("pdf.cert.hash"), r.body_hash || "-"],
    [t("pdf.cert.consent"), r.consent_text || "-"],
    [t("pdf.cert.requestId"), r.id || "-"],
  ];
  rows.forEach(([k, v]) => {
    setFace("helvetica", "bold"); ensure(14); put(k, M, y, true); y += 13;
    setFace("helvetica", "normal");
    wrap(String(v), W - M * 2).forEach((l) => { ensure(13); doc.text(l, M, y); y += 13; });
    y += 7;
  });
  return doc;
}

export function downloadNdaPdf(r) {
  const safe = (r.typed_name || r.signer_name || "freelancer").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  buildNdaPdf(r).save(`nda-${safe}.pdf`);
}
